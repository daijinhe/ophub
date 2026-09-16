package main

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"gorm.io/datatypes"
)

// ============================================================================
// 巡检告警规则：匹配与生效
//
// 设计要点：
//   1) 规则按 CMDB 维度命中资产（项目简称 / 应用系统名称 / 指定资产）；
//   2) 多条规则命中同一资产时按「Priority 升序 + id 升序」依次叠加，后者覆盖前者；
//   3) **告警在读路径重算**（rerouteAlerts）而不是只依赖采集时落库的快照——
//      这样改完阈值/屏蔽后，刷新页面即可看到历史巡检也按新规则展示，无需重跑巡检。
// ============================================================================

// alertScope 一条巡检结果在规则匹配时用到的资产身份
type alertScope struct {
	ID      uint
	Project string // 资产「项目简称」
	System  string // 资产「应用系统名称」
}

// parseStringList 解析 JSON 数组为字符串列表。
// 必须容错两种真实输入：
//  1. 数字元素——「按指定资产」的匹配值是资产 ID，前端下发的是 number（[86]），
//     若只按 []string 反序列化会整体失败，进而把合法规则误判成「请至少选择一个匹配值」；
//  2. 整串存成一个字符串的历史脏数据。
func parseStringList(raw datatypes.JSON) []string {
	if len(raw) == 0 {
		return nil
	}
	var arr []interface{}
	if err := json.Unmarshal(raw, &arr); err == nil {
		out := make([]string, 0, len(arr))
		for _, v := range arr {
			var s string
			switch t := v.(type) {
			case string:
				s = t
			case float64:
				s = strconv.FormatFloat(t, 'f', -1, 64)
			case json.Number:
				s = t.String()
			}
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	var one string
	if err := json.Unmarshal(raw, &one); err == nil && strings.TrimSpace(one) != "" {
		return []string{strings.TrimSpace(one)}
	}
	return nil
}

// parseAssetIDList 解析 JSON 资产 ID 数组（兼容数字与字符串两种写法）
func parseAssetIDList(raw datatypes.JSON) []uint {
	if len(raw) == 0 {
		return nil
	}
	var arr []interface{}
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil
	}
	out := make([]uint, 0, len(arr))
	for _, v := range arr {
		switch t := v.(type) {
		case float64:
			if t > 0 {
				out = append(out, uint(t))
			}
		case string:
			if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil && n > 0 {
				out = append(out, uint(n))
			}
		}
	}
	return out
}

// parseThresholds 解析阈值覆盖表，丢掉空项
func parseThresholds(raw datatypes.JSON) map[string]ThOverride {
	out := map[string]ThOverride{}
	if len(raw) == 0 {
		return out
	}
	var m map[string]ThOverride
	if err := json.Unmarshal(raw, &m); err != nil {
		return out
	}
	for k, v := range m {
		k = strings.TrimSpace(k)
		if k == "" || (v.Warn == nil && v.Crit == nil) {
			continue
		}
		out[k] = v
	}
	return out
}

// alertRuleMatched 判断规则是否命中该资产
func alertRuleMatched(r *InspectionAlertRule, sc alertScope) bool {
	if r == nil || !r.Enabled {
		return false
	}
	switch r.MatchType {
	case "asset":
		for _, id := range parseAssetIDList(r.MatchValues) {
			if id == sc.ID && sc.ID > 0 {
				return true
			}
		}
		return false
	case "system":
		if sc.System == "" {
			return false
		}
		for _, v := range parseStringList(r.MatchValues) {
			if v == "*" || v == sc.System {
				return true
			}
		}
		return false
	default: // project（项目简称）
		if sc.Project == "" {
			return false
		}
		for _, v := range parseStringList(r.MatchValues) {
			if v == "*" || v == sc.Project {
				return true
			}
		}
		return false
	}
}

// loadAlertRules 读取启用中的规则，按「Priority 升序 + id 升序」（后者覆盖前者）
func loadAlertRules() []InspectionAlertRule {
	var rules []InspectionAlertRule
	DB.Where("enabled = ?", true).Order("priority asc, id asc").Find(&rules)
	return rules
}

// resolveAlertProfile 合并命中该资产的全部规则为一个评估配置；无命中返回 nil（=全默认）
func resolveAlertProfile(rules []InspectionAlertRule, sc alertScope) *AlertProfile {
	var prof *AlertProfile
	for i := range rules {
		r := &rules[i]
		if !alertRuleMatched(r, sc) {
			continue
		}
		if prof == nil {
			prof = &AlertProfile{Overrides: map[string]ThOverride{}, Muted: map[string]bool{}}
		}
		prof.HitRules = append(prof.HitRules, r.Name)
		// 屏蔽是「一旦命中即生效」，后续规则无法反向取消（避免优先级叠加时语义含糊）
		if r.MuteAll {
			prof.MuteAll = true
		}
		for _, k := range parseStringList(r.MuteMetrics) {
			prof.Muted[k] = true
		}
		// 高优先级（数组靠后）覆盖低优先级的阈值设置
		for k, v := range parseThresholds(r.Thresholds) {
			prof.Overrides[k] = v
		}
	}
	return prof
}

// assetAlertScopeOf 读取资产的规则匹配身份（项目简称 / 应用系统名称）
func assetAlertScopeOf(a *Asset) alertScope {
	sc := alertScope{ID: a.ID}
	var f map[string]interface{}
	if err := json.Unmarshal(a.Fields, &f); err != nil {
		return sc
	}
	get := func(k string) string {
		if s, ok := f[k].(string); ok {
			return strings.TrimSpace(s)
		}
		return ""
	}
	sc.Project = get("项目简称")
	sc.System = get("应用系统名称")
	return sc
}

// rerouteAlerts 按「当前」告警规则重算一批巡检结果的告警。
//
// 之所以必须在读路径做这件事：inspection_results.alerts 是采集那一刻的快照，
// 阈值/屏蔽调整后若仍读快照，历史记录就会一直按旧规则展示（用户诉求是「改完立即生效」）。
// resolve 负责把一条结果映射到当前资产身份（资产重新导入后主键会变，需要 ID/IP 兜底）。
func rerouteAlerts(results []InspectionResult, resolve func(InspectionResult) alertScope) []InspectionResult {
	if len(results) == 0 {
		return results
	}
	rules := loadAlertRules()
	for i := range results {
		var data map[string]interface{}
		if err := json.Unmarshal(results[i].Data, &data); err != nil || len(data) == 0 {
			continue
		}
		sc := alertScope{ID: results[i].AssetID}
		if resolve != nil {
			sc = resolve(results[i])
		}
		results[i].Alerts = mustJSON(evalAlertsWithProfile(data, resolveAlertProfile(rules, sc)))
	}
	return results
}

// defaultAlertScopeResolver 默认身份解析：按资产 ID 查，查不到再用 IP 兜底（内有缓存）
func defaultAlertScopeResolver() func(InspectionResult) alertScope {
	byID := map[uint]alertScope{}
	byIP := map[string]alertScope{}
	return func(r InspectionResult) alertScope {
		if sc, ok := byID[r.AssetID]; ok {
			return sc
		}
		if r.IP != "" {
			if sc, ok := byIP[r.IP]; ok {
				return sc
			}
		}
		var a Asset
		if r.AssetID > 0 && DB.First(&a, r.AssetID).Error == nil {
			sc := assetAlertScopeOf(&a)
			byID[a.ID] = sc
			if a.IP != "" {
				byIP[a.IP] = sc
			}
			return sc
		}
		if r.IP != "" {
			var a Asset
			if DB.Where("ip = ? OR fields->>'虚拟机IPv4' = ?", r.IP, r.IP).First(&a).Error == nil {
				sc := assetAlertScopeOf(&a)
				byID[a.ID] = sc
				byIP[r.IP] = sc
				return sc
			}
		}
		return alertScope{ID: r.AssetID}
	}
}

// validateAlertRule 校验规则内容；返回空串表示通过
func validateAlertRule(b *InspectionAlertRule) string {
	if strings.TrimSpace(b.Name) == "" {
		return "规则名称不能为空"
	}
	switch b.MatchType {
	case "project", "system", "asset":
	default:
		return "匹配维度无效（仅支持 项目简称 / 应用系统名称 / 指定资产）"
	}
	vals := parseStringList(b.MatchValues)
	if len(vals) == 0 {
		return "请至少选择一个匹配值"
	}
	if b.MatchType == "asset" && len(parseAssetIDList(b.MatchValues)) != len(vals) {
		return "「指定资产」的匹配值必须都是资产"
	}

	defs := map[string]ThresholdDef{}
	for _, d := range AlertThresholdDefs() {
		defs[d.Key] = d
	}
	for _, k := range parseStringList(b.MuteMetrics) {
		if _, ok := defs[k]; !ok {
			return "包含未知阈值项：" + k
		}
	}
	for k, o := range parseThresholds(b.Thresholds) {
		d, ok := defs[k]
		if !ok {
			return "包含未知阈值项：" + k
		}
		check := func(v *float64, which string) string {
			if v == nil {
				return ""
			}
			if *v < 0 {
				return d.Label + " 的" + which + "阈值不能为负数"
			}
			if (d.Kind == "percent" || d.Kind == "ratio") && *v > 100 {
				return d.Label + " 的" + which + "阈值需在 0-100 之间"
			}
			return ""
		}
		if m := check(o.Warn, "预警"); m != "" {
			return m
		}
		if m := check(o.Crit, "严重"); m != "" {
			return m
		}
		if o.Warn != nil && o.Crit != nil && *o.Warn > *o.Crit {
			return d.Label + " 的严重阈值应不小于预警阈值"
		}
	}
	return ""
}

// sortedKeys 取 map 的键并排序（供下拉选项稳定输出）
func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
