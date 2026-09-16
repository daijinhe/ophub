package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/datatypes"
)

// ============================================================================
// 巡检告警规则 HTTP 接口
//   列表 / 新建 / 更新 / 删除 / 阈值目录与选项 / 作用范围试算
// 规则改动后无需任何额外刷新动作：告警在读路径按当前规则重算（rerouteAlerts）。
// ============================================================================

// jsonList 空值兜底成 []，避免前端拿到 null 要额外判空
func jsonList(b datatypes.JSON) interface{} {
	if len(b) == 0 {
		return []interface{}{}
	}
	return json.RawMessage(b)
}

// jsonObj 空值兜底成 {}
func jsonObj(b datatypes.JSON) interface{} {
	if len(b) == 0 {
		return map[string]interface{}{}
	}
	return json.RawMessage(b)
}

// ruleView 组装规则输出（附阈值项数/屏蔽项数，便于列表直接展示）
func ruleView(r *InspectionAlertRule) gin.H {
	return gin.H{
		"id":             r.ID,
		"name":           r.Name,
		"enabled":        r.Enabled,
		"matchType":      r.MatchType,
		"matchValues":    jsonList(r.MatchValues),
		"thresholds":     jsonObj(r.Thresholds),
		"thresholdCount": len(parseThresholds(r.Thresholds)),
		"muteAll":        r.MuteAll,
		"muteMetrics":    jsonList(r.MuteMetrics),
		"mutedCount":     len(parseStringList(r.MuteMetrics)),
		"priority":       r.Priority,
		"remark":         r.Remark,
		"createdAt":      r.CreatedAt,
		"updatedAt":      r.UpdatedAt,
	}
}

// ListInspectionAlertRules 规则列表
func ListInspectionAlertRules(c *gin.Context) {
	var list []InspectionAlertRule
	DB.Order("priority desc, id asc").Find(&list)
	out := make([]gin.H, 0, len(list))
	for i := range list {
		out = append(out, ruleView(&list[i]))
	}
	OK(c, gin.H{"list": out, "total": len(out)})
}

// CreateInspectionAlertRule 新建规则
func CreateInspectionAlertRule(c *gin.Context) {
	var body InspectionAlertRule
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if msg := validateAlertRule(&body); msg != "" {
		Fail(c, http.StatusBadRequest, 400, msg)
		return
	}
	body.ID = 0
	if err := DB.Create(&body).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "创建失败: "+err.Error())
		return
	}
	OK(c, ruleView(&body))
}

// UpdateInspectionAlertRule 更新规则。
// 逐字段显式赋值（而不是 Save(body)）：Enabled/MuteAll 为 false 时也要能落库。
func UpdateInspectionAlertRule(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var rule InspectionAlertRule
	if err := DB.First(&rule, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "规则不存在")
		return
	}
	var body InspectionAlertRule
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if msg := validateAlertRule(&body); msg != "" {
		Fail(c, http.StatusBadRequest, 400, msg)
		return
	}
	rule.Name = body.Name
	rule.Enabled = body.Enabled
	rule.MatchType = body.MatchType
	rule.MatchValues = body.MatchValues
	rule.Thresholds = body.Thresholds
	rule.MuteAll = body.MuteAll
	rule.MuteMetrics = body.MuteMetrics
	rule.Priority = body.Priority
	rule.Remark = strings.TrimSpace(body.Remark)
	if err := DB.Save(&rule).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败: "+err.Error())
		return
	}
	OK(c, ruleView(&rule))
}

// DeleteInspectionAlertRule 删除规则
func DeleteInspectionAlertRule(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	if err := DB.Delete(&InspectionAlertRule{}, id).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "删除失败: "+err.Error())
		return
	}
	OK(c, gin.H{"id": id})
}

// InspectionAlertRuleCatalog 规则配置页所需的全部选项：
// 可配置阈值项（含默认值）+ 项目简称 / 应用系统名称 / 资产 列表
func InspectionAlertRuleCatalog(c *gin.Context) {
	projSet := map[string]bool{}
	sysSet := map[string]bool{}
	assets := make([]gin.H, 0, 64)
	var as []Asset
	DB.Select("id", "name", "ip", "fields").Order("id asc").Find(&as)
	for i := range as {
		sc := assetAlertScopeOf(&as[i])
		if sc.Project != "" {
			projSet[sc.Project] = true
		}
		if sc.System != "" {
			sysSet[sc.System] = true
		}
		assets = append(assets, gin.H{
			"id": as[i].ID, "name": AssetDisplayName(&as[i]), "ip": as[i].IP,
			"project": sc.Project, "system": sc.System,
		})
	}
	OK(c, gin.H{
		"thresholds": AlertThresholdDefs(),
		"projects":   sortedKeys(projSet),
		"systems":    sortedKeys(sysSet),
		"assets":     assets,
	})
}

// PreviewInspectionAlertRule 作用范围试算：
// 用未落库的规则内容统计会命中多少资产、并给少量样例，避免「配了规则却不知道命中了谁」。
func PreviewInspectionAlertRule(c *gin.Context) {
	var body InspectionAlertRule
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	switch body.MatchType {
	case "project", "system", "asset":
	default:
		Fail(c, http.StatusBadRequest, 400, "请先选择匹配维度")
		return
	}
	if len(parseStringList(body.MatchValues)) == 0 {
		Fail(c, http.StatusBadRequest, 400, "请先选择匹配值")
		return
	}
	body.Enabled = true // 试算时忽略启用开关，只看匹配结果

	var as []Asset
	DB.Select("id", "name", "ip", "fields").Order("id asc").Find(&as)
	samples := make([]gin.H, 0, 20)
	matched := 0
	for i := range as {
		sc := assetAlertScopeOf(&as[i])
		if !alertRuleMatched(&body, sc) {
			continue
		}
		matched++
		if len(samples) < 20 {
			samples = append(samples, gin.H{
				"id": as[i].ID, "name": AssetDisplayName(&as[i]), "ip": as[i].IP,
				"project": sc.Project, "system": sc.System,
			})
		}
	}
	OK(c, gin.H{
		"matched": matched,
		"total":   len(as),
		"samples": samples,
	})
}
