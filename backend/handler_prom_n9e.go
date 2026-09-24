package main

// ============================================================================
// 「监控告警报表」HTTP 层（Prometheus 监控 → 夜莺历史告警）
//
// 路由挂载见 main.go 的 prom 段；页面见 frontend/src/pages/PromAlertReport.tsx。
//
// 读写分工：
//   - 查询 / 统计 / 导出 → 只读**本地库** n9e_alert_events（毫秒级）
//   - 同步（POST /prom/n9e/sync）→ 才真正访问夜莺，后台跑、前端轮询进度
// 这样做的原因见 service_n9e.go 顶部注释（90 天现拉一次 94 秒）。
// ============================================================================

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xuri/excelize/v2"
	"gorm.io/gorm"
)

// n9eExportRowLimit 单次导出的行数上限（防止一次导出把内存打满）
const n9eExportRowLimit = 600000

// ---------------------------------------------------------------------------
// 连接配置
// ---------------------------------------------------------------------------

// PromN9eGetConfig 读取连接配置。Token 只回传「是否已配置 + 掩码」，不回显明文。
func PromN9eGetConfig(c *gin.Context) {
	base := getSetting(n9eBaseKey, "")
	token := getSetting(n9eTokenKey, "")
	OK(c, gin.H{
		"baseUrl":    base,
		"hasToken":   token != "",
		"tokenMask":  n9eMaskToken(token),
		"maxDays":    n9eMaxDays,
		"chunkDays":  n9eChunkDays,
		"pageSize":   n9ePageSize,
		"lastSyncAt": n9eLastSyncAt(),
		"syncedRows": n9eLocalCount(),
	})
}

// n9eMaskToken 只露头尾，够确认「是不是那把」即可
func n9eMaskToken(t string) string {
	if t == "" {
		return ""
	}
	if len(t) <= 10 {
		return strings.Repeat("*", len(t))
	}
	return t[:6] + strings.Repeat("*", 8) + t[len(t)-4:]
}

// n9eLastSyncAt 本地库最后同步时间（用于页面提示数据新鲜度）
func n9eLastSyncAt() string {
	var last N9eAlertEvent
	if DB == nil {
		return ""
	}
	if err := DB.Order("synced_at DESC").Limit(1).Find(&last).Error; err != nil {
		return ""
	}
	if last.SyncedAt.IsZero() {
		return ""
	}
	return last.SyncedAt.Format("2006-01-02 15:04:05")
}

// n9eLocalCount 本地库已有条数
func n9eLocalCount() int64 {
	if DB == nil {
		return 0
	}
	var n int64
	DB.Model(&N9eAlertEvent{}).Count(&n)
	return n
}

// PromN9eSaveConfig 保存连接配置。Token 传空字符串表示「不改动」，
// 避免前端在只改地址时把掩码串写回去覆盖真 Token。
func PromN9eSaveConfig(c *gin.Context) {
	var body struct {
		BaseURL string `json:"baseUrl"`
		Token   string `json:"token"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数格式错误："+err.Error())
		return
	}
	base := strings.TrimSpace(body.BaseURL)
	if base == "" {
		Fail(c, http.StatusBadRequest, 400, "夜莺地址不能为空")
		return
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		Fail(c, http.StatusBadRequest, 400, "夜莺地址需以 http:// 或 https:// 开头")
		return
	}
	if err := setSetting(n9eBaseKey, strings.TrimRight(base, "/")); err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存地址失败："+err.Error())
		return
	}
	if tk := strings.TrimSpace(body.Token); tk != "" {
		if err := setSetting(n9eTokenKey, tk); err != nil {
			Fail(c, http.StatusInternalServerError, 500, "保存 Token 失败："+err.Error())
			return
		}
	}
	OK(c, gin.H{"msg": "已保存"})
}

// PromN9eTestConfig 连通性测试。extra 支持「未保存先测试」：把表单当前值直接带进来。
func PromN9eTestConfig(c *gin.Context) {
	var body struct {
		BaseURL string `json:"baseUrl"`
		Token   string `json:"token"`
	}
	_ = c.ShouldBindJSON(&body)

	base := strings.TrimSpace(body.BaseURL)
	token := strings.TrimSpace(body.Token)
	if base == "" {
		base = getSetting(n9eBaseKey, "")
	}
	if token == "" {
		// 表单没填 token 时用已保存的（掩码串不回填到表单，所以这里只会是「没填」）
		token = getSetting(n9eTokenKey, "")
	}
	cli := &n9eClient{
		base:  strings.TrimRight(base, "/"),
		token: token,
		http:  &http.Client{Timeout: n9eHTTPTimeout},
	}
	if cli.base == "" || cli.token == "" {
		Fail(c, http.StatusBadRequest, 400, "请先填写夜莺地址与 Token")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), n9eHTTPTimeout)
	defer cancel()
	t0 := time.Now()
	total, err := cli.Ping(ctx)
	if err != nil {
		Fail(c, http.StatusBadGateway, 502, err.Error())
		return
	}
	OK(c, gin.H{
		"ok":      true,
		"msg":     fmt.Sprintf("连接正常（近 1 小时告警 %d 条，耗时 %dms）", total, time.Since(t0).Milliseconds()),
		"elapsed": time.Since(t0).Milliseconds(),
	})
}

// ---------------------------------------------------------------------------
// 同步
// ---------------------------------------------------------------------------

// PromN9eSync 触发一次同步（后台执行，立即返回）
func PromN9eSync(c *gin.Context) {
	var body struct {
		Days int `json:"days"`
	}
	_ = c.ShouldBindJSON(&body)
	days := body.Days
	if days <= 0 {
		days = n9eMaxDays
	}
	if days > n9eMaxDays {
		Fail(c, http.StatusBadRequest, 400, fmt.Sprintf("最多只支持回溯 %d 天", n9eMaxDays))
		return
	}
	if !StartN9eSync(days) {
		OK(c, gin.H{"started": false, "msg": "已有一个同步任务在执行中"})
		return
	}
	OK(c, gin.H{"started": true, "msg": fmt.Sprintf("已开始同步最近 %d 天告警", days)})
}

// PromN9eSyncStatus 查询同步进度（前端轮询）
func PromN9eSyncStatus(c *gin.Context) {
	st := n9eSyncSnapshot()
	OK(c, gin.H{
		"state":     st,
		"localRows": n9eLocalCount(),
	})
}

// ---------------------------------------------------------------------------
// 查询条件解析（列表 / 统计 / 导出共用，保证三处口径一致）
// ---------------------------------------------------------------------------

type n9eQuery struct {
	Stime         int64
	Etime         int64
	GroupIDs      []int
	DatasourceIDs []int
	Severity      int // 0 = 全部
	Recovered     int // -1 = 全部；0 = 未恢复；1 = 已恢复
	Keyword       string
	Department    string
}

// n9eParseTimeWindow 解析并夹紧时间窗口（days / stime / etime → 秒级区间）。
//
// ⚠️ 查询、统计、导出、以及三个「选项 + 条数」的下拉接口全部走这一个函数：
// 时间窗口一旦各写一份，下拉里显示的条数就会与页面统计对不上 ——
// 实测下拉写「95674 条」、点进去显示 95669，差值还会随「上次同步距今多久」越来越大。
func n9eParseTimeWindow(c *gin.Context) (int64, int64) {
	days, _ := strconv.Atoi(c.Query("days"))
	if days <= 0 || days > n9eMaxDays {
		days = n9eMaxDays
	}
	etime, _ := strconv.ParseInt(c.Query("etime"), 10, 64)
	stime, _ := strconv.ParseInt(c.Query("stime"), 10, 64)
	if etime <= 0 {
		etime = time.Now().Unix()
	}
	if stime <= 0 {
		stime = etime - int64(days)*86400
	}
	// 夹紧到 90 天，防止有人手改 URL 拉一年数据
	if etime-stime > int64(n9eMaxDays)*86400 {
		stime = etime - int64(n9eMaxDays)*86400
	}
	return stime, etime
}

// n9eParseQuery 解析并夹紧查询条件。
// ⚠️ 列表、统计、导出必须走这同一个解析函数：三处各写一份必然漂移，
//
//	会出现「页面上说 100 条、导出来 80 条」这类最难查的问题。
func n9eParseQuery(c *gin.Context) n9eQuery {
	stime, etime := n9eParseTimeWindow(c)
	q := n9eQuery{Recovered: -1, Stime: stime, Etime: etime}
	q.Severity, _ = strconv.Atoi(c.Query("severity"))
	if v := c.Query("recovered"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			q.Recovered = n
		}
	}
	q.Keyword = strings.TrimSpace(c.Query("keyword"))
	q.Department = strings.TrimSpace(c.Query("department"))
	q.GroupIDs = n9eParseIntList(c.Query("groupIds"))
	q.DatasourceIDs = n9eParseIntList(c.Query("datasourceIds"))
	return q
}

// n9eParseIntList 解析「逗号分隔的整数列表」查询参数（业务组 / 数据源共用）。
// 非法片段直接跳过而不是报错：筛选条件写歪了应当退化成「不过滤」，不该让整个查询失败。
func n9eParseIntList(raw string) []int {
	var out []int
	for _, s := range strings.Split(raw, ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if n, err := strconv.Atoi(s); err == nil {
			out = append(out, n)
		}
	}
	return out
}

// apply 把条件套到 GORM 查询上
func (q n9eQuery) apply(tx *gorm.DB) *gorm.DB {
	tx.Where("trigger_time >= ? AND trigger_time <= ?", q.Stime, q.Etime)
	if len(q.GroupIDs) == 1 {
		tx.Where("group_id = ?", q.GroupIDs[0])
	} else if len(q.GroupIDs) > 1 {
		tx.Where("group_id IN ?", q.GroupIDs)
	}
	if len(q.DatasourceIDs) == 1 {
		tx.Where("datasource_id = ?", q.DatasourceIDs[0])
	} else if len(q.DatasourceIDs) > 1 {
		tx.Where("datasource_id IN ?", q.DatasourceIDs)
	}
	if q.Severity > 0 {
		tx.Where("severity = ?", q.Severity)
	}
	if q.Recovered >= 0 {
		tx.Where("is_recovered = ?", q.Recovered)
	}
	if q.Department != "" {
		tx.Where("department = ?", q.Department)
	}
	if q.Keyword != "" {
		like := "%" + q.Keyword + "%"
		tx.Where("(rule_name ILIKE ? OR target_ident ILIKE ? OR target_host ILIKE ? OR group_name ILIKE ? OR cluster ILIKE ?)",
			like, like, like, like, like)
	}
	return tx
}

// ---------------------------------------------------------------------------
// 列表（本地库）
// ---------------------------------------------------------------------------

// PromN9eEvents 分页查询本地已同步的告警记录
func PromN9eEvents(c *gin.Context) {
	q := n9eParseQuery(c)
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", "20"))
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 || pageSize > 500 {
		pageSize = 20
	}
	var total int64
	tx := q.apply(DB.Model(&N9eAlertEvent{}))
	if err := tx.Count(&total).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "统计条数失败："+err.Error())
		return
	}
	var rows []N9eAlertEvent
	if err := q.apply(DB.Model(&N9eAlertEvent{})).
		Order("trigger_time DESC, id DESC").
		Offset((page - 1) * pageSize).Limit(pageSize).
		Find(&rows).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "查询失败："+err.Error())
		return
	}
	PageOK(c, rows, total, page, pageSize)
}

// PromN9eGroups 业务组列表（从本地库取，供筛选下拉；库里没有时返回空数组）
//
// ⚠️ 条数必须按**同一时间窗口**统计（前端会把当前的时间范围带过来）：
// 下拉里写「集团 (1024)」，点进去总数却是 980，用户只会认为报表算错了。
func PromN9eGroups(c *gin.Context) {
	type grp struct {
		GroupID   int    `json:"groupId"`
		GroupName string `json:"groupName"`
		N         int64  `json:"n"`
	}
	var rows []grp
	if DB != nil {
		stime, etime := n9eParseTimeWindow(c)
		DB.Model(&N9eAlertEvent{}).
			Select("group_id, group_name, count(*) as n").
			Where("trigger_time >= ? AND trigger_time <= ?", stime, etime).
			Group("group_id, group_name").
			Order("n DESC").
			Limit(200).Scan(&rows)
	}
	OK(c, gin.H{"list": rows})
}

// PromN9eDatasources 数据源选项（从本地库取，供筛选下拉）。
//
// 刻意**不从夜莺实时拉清单**：本页数据全部来自本地库，把「本地没有数据的数据源」
// 也列出来，只会让用户选到一个空结果，还以为功能坏了。这里直接 distinct 本地已有的数据源并带条数。
// ⚠️ 本次新增「数据源」字段之前同步的历史数据里 datasource_id = 0，不会出现在选项里 ——
//
//	老环境升级后需要重新同步一次才会看到数据源选项。
func PromN9eDatasources(c *gin.Context) {
	type dsRow struct {
		DatasourceID   int    `json:"datasourceId"`
		DatasourceName string `json:"datasourceName"`
		N              int64  `json:"n"`
	}
	var rows []dsRow
	if DB != nil {
		stime, etime := n9eParseTimeWindow(c)
		DB.Model(&N9eAlertEvent{}).
			Select("datasource_id, datasource_name, count(*) as n").
			Where("datasource_id > 0").
			Where("trigger_time >= ? AND trigger_time <= ?", stime, etime).
			Group("datasource_id, datasource_name").
			Order("n DESC").
			Limit(500).Scan(&rows)
	}
	OK(c, gin.H{"list": rows})
}

// PromN9eDepartments 部门 / 系统维度取值（从本地库取，供筛选下拉）
func PromN9eDepartments(c *gin.Context) {
	type kvRow struct {
		V string `json:"value"`
		N int64  `json:"n"`
	}
	var deps, syss []kvRow
	if DB != nil {
		stime, etime := n9eParseTimeWindow(c)
		DB.Model(&N9eAlertEvent{}).
			Select("department as v, count(*) as n").
			Where("department <> ''").
			Where("trigger_time >= ? AND trigger_time <= ?", stime, etime).
			Group("department").Order("n DESC").Limit(200).Scan(&deps)
		DB.Model(&N9eAlertEvent{}).
			Select("system_name as v, count(*) as n").
			Where("system_name <> ''").
			Where("trigger_time >= ? AND trigger_time <= ?", stime, etime).
			Group("system_name").Order("n DESC").Limit(200).Scan(&syss)
	}
	OK(c, gin.H{"departments": deps, "systems": syss})
}

// ---------------------------------------------------------------------------
// 统计概览
// ---------------------------------------------------------------------------

// PromN9eStats 统计概览：总量 / 恢复情况 / 等级分布 / TOP 榜 / 逐日趋势
func PromN9eStats(c *gin.Context) {
	q := n9eParseQuery(c)

	type kvRow struct {
		Key   string `json:"key"`
		Value int64  `json:"value"`
	}
	var total, recovered, hostCount, ruleCount int64
	if err := q.apply(DB.Model(&N9eAlertEvent{})).Count(&total).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "统计失败："+err.Error())
		return
	}
	q.apply(DB.Model(&N9eAlertEvent{})).Where("is_recovered = 1").Count(&recovered)
	q.apply(DB.Model(&N9eAlertEvent{})).Where("target_host <> ''").Distinct("target_host").Count(&hostCount)
	q.apply(DB.Model(&N9eAlertEvent{})).Distinct("rule_id").Count(&ruleCount)

	var bySeverity, byGroup, byRule, byDept, bySystem, byDay []kvRow
	q.apply(DB.Model(&N9eAlertEvent{})).
		Select("severity::text as key, count(*) as value").
		Group("severity").Order("value DESC").Scan(&bySeverity)
	q.apply(DB.Model(&N9eAlertEvent{})).
		Select("group_name as key, count(*) as value").
		Where("group_name <> ''").
		Group("group_name").Order("value DESC").Limit(10).Scan(&byGroup)
	q.apply(DB.Model(&N9eAlertEvent{})).
		Select("rule_name as key, count(*) as value").
		Where("rule_name <> ''").
		Group("rule_name").Order("value DESC").Limit(10).Scan(&byRule)
	q.apply(DB.Model(&N9eAlertEvent{})).
		Select("department as key, count(*) as value").
		Where("department <> ''").
		Group("department").Order("value DESC").Limit(10).Scan(&byDept)
	q.apply(DB.Model(&N9eAlertEvent{})).
		Select("system_name as key, count(*) as value").
		Where("system_name <> ''").
		Group("system_name").Order("value DESC").Limit(10).Scan(&bySystem)
	// 逐日趋势：trigger_time 是 unix 秒，按天分组（用本地时区）
	q.apply(DB.Model(&N9eAlertEvent{})).
		Select("to_char(to_timestamp(trigger_time)::date, 'YYYY-MM-DD') as key, count(*) as value").
		Group("key").Order("key ASC").Scan(&byDay)

	OK(c, gin.H{
		"total":      total,
		"recovered":  recovered,
		"unresolved": total - recovered,
		"hostCount":  hostCount,
		"ruleCount":  ruleCount,
		"bySeverity": bySeverity,
		"byGroup":    byGroup,
		"byRule":     byRule,
		"byDept":     byDept,
		"bySystem":   bySystem,
		"byDay":      byDay,
		"stime":      q.Stime,
		"etime":      q.Etime,
		"localRows":  n9eLocalCount(),
		"lastSyncAt": n9eLastSyncAt(),
	})
}

// ---------------------------------------------------------------------------
// 导出 Excel
// ---------------------------------------------------------------------------

// n9eExportCol 一个导出列的定义。
//
// ⚠️ Key 是**稳定标识**：导出模板（n9e_export_templates.columns）里存的就是这些 Key，
// 一旦发布就不要改名 —— 改了不会报错，只是老模板按 Key 匹配不上、那一列静默消失。
// Label 只是表头，可随时改；Width 是列宽；Get 负责算单元格值。
type n9eExportCol struct {
	Key   string
	Label string
	Width float64
	Get   func(r *N9eAlertEvent, idx int, now int64) interface{}
}

// n9eExportCols 全部可选导出列，顺序即「默认导出」的表头顺序。
//
// ⚠️ 默认导出 = 这里全部列（即 v1.7.50 之前写死的 19 列），行为保持不变。
// 往后**追加**列只影响「全列导出」，模板导出按模板自己存的 Key 列表取。
var n9eExportCols = []n9eExportCol{
	{"index", "序号", 6, func(_ *N9eAlertEvent, idx int, _ int64) interface{} { return idx }},
	{"id", "事件ID", 10, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return r.ID }},
	{"triggerTime", "触发时间", 20, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return n9eFormatTime(r.TriggerTime) }},
	{"recoverTime", "恢复时间", 20, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return n9eFormatTime(r.RecoverTime) }},
	{"duration", "持续时长", 12, func(r *N9eAlertEvent, _ int, now int64) interface{} {
		if r.RecoverTime > 0 && r.RecoverTime > r.TriggerTime {
			return n9eFormatDuration(r.RecoverTime - r.TriggerTime)
		}
		return "未恢复（已 " + n9eFormatDuration(now-r.TriggerTime) + "）"
	}},
	{"status", "状态", 8, func(r *N9eAlertEvent, _ int, _ int64) interface{} {
		if r.IsRecovered == 0 {
			return "未恢复"
		}
		return "已恢复"
	}},
	{"severity", "等级", 6, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return n9eSeverityLabel(r.Severity) }},
	{"datasource", "数据源", 22, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return r.DatasourceName }},
	{"ruleName", "规则名称", 30, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return r.RuleName }},
	{"groupName", "业务组", 20, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return r.GroupName }},
	{"cluster", "集群", 18, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return r.Cluster }},
	{"targetHost", "目标主机", 18, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return r.TargetHost }},
	{"targetIdent", "目标对象", 22, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return r.TargetIdent }},
	{"department", "部门", 16, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return r.Department }},
	{"systemName", "系统", 18, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return r.SystemName }},
	{"triggerValue", "触发值", 12, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return r.TriggerValue }},
	{"firstTriggerTime", "首次触发时间", 20, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return n9eFormatTime(r.FirstTriggerTime) }},
	{"notifyCurNumber", "通知次数", 10, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return r.NotifyCurNumber }},
	{"notifyChannels", "通知渠道", 16, func(r *N9eAlertEvent, _ int, _ int64) interface{} { return r.NotifyChannels }},
}

// n9eColsByKeys 把「列 Key 列表」解析成有序的列定义。
//
// 未知 Key 与重复 Key 直接丢弃；一个都不剩时**回退全列** ——
// 宁可多导几列，也不能吐出一个只有表头、没有内容的空文件（那看起来像"导出成功"）。
func n9eColsByKeys(keys []string) []n9eExportCol {
	if len(keys) == 0 {
		return n9eExportCols
	}
	seen := make(map[string]bool, len(keys))
	out := make([]n9eExportCol, 0, len(keys))
	for _, k := range keys {
		k = strings.TrimSpace(k)
		if k == "" || seen[k] {
			continue
		}
		for _, c := range n9eExportCols {
			if c.Key == k {
				seen[k] = true
				out = append(out, c)
				break
			}
		}
	}
	if len(out) == 0 {
		return n9eExportCols
	}
	return out
}

// PromN9eExport 导出当前筛选条件下的全部告警记录为 xlsx。两种调用方式：
//
//   - `?tplId=N`：**模板为准** —— 列、筛选条件、时间范围全部取自模板，URL 上其余
//     筛选参数忽略。这样「按模板导出」在任何时候点都是同一份报表，不会因为页面上
//     还留着上次的筛选条件而导出别的东西。
//   - 不带 tplId：用 URL 上的筛选条件；`?cols=a,b,c` 指定列（缺省或 Key 全无效则导出全列）。
//
// 这里**不再访问夜莺**，直接导本地库：同步已经把 90 天数据拉到本地，
// 导出再拉一遍夜莺既慢（94 秒）又可能因数据变动导致「页面数与导出数不一致」。
func PromN9eExport(c *gin.Context) {
	q, cols, tplName, ok := n9eResolveExport(c)
	if !ok {
		return // 已写过错误响应
	}

	var total int64
	if err := q.apply(DB.Model(&N9eAlertEvent{})).Count(&total).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "统计失败："+err.Error())
		return
	}
	if total == 0 {
		msg := "当前筛选条件下没有数据可导出（可先点「同步数据」）"
		if tplName != "" {
			// 模板导出为 0 条时，八成是模板用了「自定义区间」而那个区间已经滑出
			// 本地保留的 90 天窗口 —— 直接把区间写出来，省得用户猜。
			msg = fmt.Sprintf("模板「%s」的条件（%s ~ %s）内没有数据；"+
				"若该模板用的是自定义时间范围，可能已超出本地保留的 90 天窗口，建议编辑模板改为「近 N 天」",
				tplName,
				time.Unix(q.Stime, 0).Format("2006-01-02"),
				time.Unix(q.Etime, 0).Format("2006-01-02"))
		}
		Fail(c, http.StatusBadRequest, 400, msg)
		return
	}
	if total > n9eExportRowLimit {
		Fail(c, http.StatusBadRequest, 400,
			fmt.Sprintf("本次筛出 %d 条，超过单次导出上限 %d 条，请缩小时间范围", total, n9eExportRowLimit))
		return
	}

	f := excelize.NewFile()
	defer func() { _ = f.Close() }()
	sheet := "告警明细"
	if _, err := f.NewSheet(sheet); err != nil {
		Fail(c, http.StatusInternalServerError, 500, "创建工作表失败："+err.Error())
		return
	}
	_ = f.DeleteSheet("Sheet1")
	sw, err := f.NewStreamWriter(sheet)
	if err != nil {
		Fail(c, http.StatusInternalServerError, 500, "初始化写入器失败："+err.Error())
		return
	}
	for i, col := range cols {
		_ = sw.SetColWidth(i+1, i+1, col.Width)
	}
	header := make([]interface{}, len(cols))
	for i, col := range cols {
		header[i] = col.Label
	}
	if err := sw.SetRow("A1", header); err != nil {
		Fail(c, http.StatusInternalServerError, 500, "写表头失败："+err.Error())
		return
	}

	// 分批读、边读边写：一次 Find 25 万条到内存再写会白白多占一份内存
	const readBatch = 5000
	written := 0
	now := time.Now().Unix()
	for offset := 0; offset < int(total); offset += readBatch {
		var rows []N9eAlertEvent
		if err := q.apply(DB.Model(&N9eAlertEvent{})).
			Order("trigger_time DESC, id DESC").
			Offset(offset).Limit(readBatch).Find(&rows).Error; err != nil {
			Fail(c, http.StatusInternalServerError, 500, "读取数据失败："+err.Error())
			return
		}
		if len(rows) == 0 {
			break
		}
		for i := range rows {
			written++
			vals := make([]interface{}, len(cols))
			for j := range cols {
				vals[j] = cols[j].Get(&rows[i], written, now)
			}
			cell, _ := excelize.CoordinatesToCellName(1, written+1)
			_ = sw.SetRow(cell, vals)
		}
	}
	if err := sw.Flush(); err != nil {
		Fail(c, http.StatusInternalServerError, 500, "写入完成失败："+err.Error())
		return
	}

	buf, err := f.WriteToBuffer()
	if err != nil {
		Fail(c, http.StatusInternalServerError, 500, "生成 Excel 失败："+err.Error())
		return
	}

	// 文件名带模板名：多人用不同模板导出时，落到同一目录里能一眼分清是哪一份
	base := "夜莺告警记录"
	if tplName != "" {
		base += "_" + n9eSafeFileName(tplName)
	}
	name := fmt.Sprintf("%s_%s_%s_%s.xlsx", base,
		time.Unix(q.Stime, 0).Format("20060102"),
		time.Unix(q.Etime, 0).Format("20060102"),
		time.Now().Format("20060102"))
	// 中文文件名走 RFC 5987，否则各浏览器表现不一致
	c.Header("Content-Disposition",
		`attachment; filename="n9e-alert-events.xlsx"; filename*=UTF-8''`+url.PathEscape(name))
	c.Header("X-Total-Rows", strconv.Itoa(written))
	c.Header("X-Total-Cols", strconv.Itoa(len(cols)))
	c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buf.Bytes())
}

// n9eResolveExport 解析导出请求 → (查询条件, 列定义, 模板名)。
// ok=false 表示已在函数内写过错误响应，调用方直接 return。
func n9eResolveExport(c *gin.Context) (n9eQuery, []n9eExportCol, string, bool) {
	if tplID, _ := strconv.Atoi(c.Query("tplId")); tplID > 0 {
		if DB == nil {
			Fail(c, http.StatusInternalServerError, 500, "数据库未就绪")
			return n9eQuery{}, nil, "", false
		}
		var tpl N9eExportTemplate
		if err := DB.First(&tpl, tplID).Error; err != nil {
			Fail(c, http.StatusNotFound, 404, "导出模板不存在或已被删除，请刷新后重试")
			return n9eQuery{}, nil, "", false
		}
		return tpl.FilterStruct().toQuery(), n9eColsByKeys(tpl.ColList()), tpl.Name, true
	}
	// 不带 cols 时 strings.Split("", ",") 会得到 [""]，
	// n9eColsByKeys 会把空串丢掉并回退全列 —— 正是想要的行为。
	return n9eParseQuery(c), n9eColsByKeys(strings.Split(c.Query("cols"), ",")), "", true
}

// n9eFormatTime unix 秒 → 本地时间字符串；0 返回空
func n9eFormatTime(ts int64) string {
	if ts <= 0 {
		return ""
	}
	return time.Unix(ts, 0).Format("2006-01-02 15:04:05")
}

// n9eFormatDuration 秒 → 「1天2小时3分」这种可读形式
func n9eFormatDuration(sec int64) string {
	if sec < 0 {
		sec = 0
	}
	d := sec / 86400
	h := (sec % 86400) / 3600
	m := (sec % 3600) / 60
	if d > 0 {
		return fmt.Sprintf("%d天%d小时", d, h)
	}
	if h > 0 {
		return fmt.Sprintf("%d小时%d分", h, m)
	}
	return fmt.Sprintf("%d分%d秒", m, sec%60)
}
