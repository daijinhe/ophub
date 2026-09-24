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
	Stime      int64
	Etime      int64
	GroupIDs   []int
	Severity   int // 0 = 全部
	Recovered  int // -1 = 全部；0 = 未恢复；1 = 已恢复
	Keyword    string
	Department string
}

// n9eParseQuery 解析并夹紧查询条件。
// ⚠️ 列表、统计、导出必须走这同一个解析函数：三处各写一份必然漂移，
//
//	会出现「页面上说 100 条、导出来 80 条」这类最难查的问题。
func n9eParseQuery(c *gin.Context) n9eQuery {
	q := n9eQuery{Recovered: -1}
	now := time.Now().Unix()
	days, _ := strconv.Atoi(c.Query("days"))
	if days <= 0 {
		days = n9eMaxDays
	}
	if days > n9eMaxDays {
		days = n9eMaxDays
	}
	q.Etime, _ = strconv.ParseInt(c.Query("etime"), 10, 64)
	q.Stime, _ = strconv.ParseInt(c.Query("stime"), 10, 64)
	if q.Etime <= 0 {
		q.Etime = now
	}
	if q.Stime <= 0 {
		q.Stime = q.Etime - int64(days)*86400
	}
	// 夹紧到 90 天，防止有人手改 URL 拉一年数据
	if q.Etime-q.Stime > int64(n9eMaxDays)*86400 {
		q.Stime = q.Etime - int64(n9eMaxDays)*86400
	}
	q.Severity, _ = strconv.Atoi(c.Query("severity"))
	if v := c.Query("recovered"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			q.Recovered = n
		}
	}
	q.Keyword = strings.TrimSpace(c.Query("keyword"))
	q.Department = strings.TrimSpace(c.Query("department"))
	for _, s := range strings.Split(c.Query("groupIds"), ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if n, err := strconv.Atoi(s); err == nil {
			q.GroupIDs = append(q.GroupIDs, n)
		}
	}
	return q
}

// apply 把条件套到 GORM 查询上
func (q n9eQuery) apply(tx *gorm.DB) *gorm.DB {
	tx.Where("trigger_time >= ? AND trigger_time <= ?", q.Stime, q.Etime)
	if len(q.GroupIDs) == 1 {
		tx.Where("group_id = ?", q.GroupIDs[0])
	} else if len(q.GroupIDs) > 1 {
		tx.Where("group_id IN ?", q.GroupIDs)
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
func PromN9eGroups(c *gin.Context) {
	type grp struct {
		GroupID   int    `json:"groupId"`
		GroupName string `json:"groupName"`
		N         int64  `json:"n"`
	}
	var rows []grp
	if DB != nil {
		DB.Model(&N9eAlertEvent{}).
			Select("group_id, group_name, count(*) as n").
			Group("group_id, group_name").
			Order("n DESC").
			Limit(200).Scan(&rows)
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
		DB.Model(&N9eAlertEvent{}).
			Select("department as v, count(*) as n").
			Where("department <> ''").
			Group("department").Order("n DESC").Limit(200).Scan(&deps)
		DB.Model(&N9eAlertEvent{}).
			Select("system_name as v, count(*) as n").
			Where("system_name <> ''").
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

// n9eExportHeaders 导出列（顺序即表头顺序）
var n9eExportHeaders = []string{
	"序号", "事件ID", "触发时间", "恢复时间", "持续时长", "状态", "等级",
	"规则名称", "业务组", "集群", "目标主机", "目标对象", "部门", "系统",
	"触发值", "首次触发时间", "通知次数", "通知渠道",
}

// PromN9eExport 导出当前筛选条件下的全部告警记录为 xlsx。
//
// 这里**不再访问夜莺**，直接导本地库：同步已经把 90 天数据拉到本地，
// 导出再拉一遍夜莺既慢（94 秒）又可能因数据变动导致「页面数与导出数不一致」。
func PromN9eExport(c *gin.Context) {
	q := n9eParseQuery(c)

	var total int64
	if err := q.apply(DB.Model(&N9eAlertEvent{})).Count(&total).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "统计失败："+err.Error())
		return
	}
	if total == 0 {
		Fail(c, http.StatusBadRequest, 400, "当前筛选条件下没有数据可导出（可先点「同步数据」）")
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
	widths := []float64{6, 10, 20, 20, 12, 8, 6, 30, 20, 18, 18, 22, 16, 18, 12, 20, 10, 16}
	for i, w := range widths {
		_ = sw.SetColWidth(i+1, i+1, w)
	}
	header := make([]interface{}, len(n9eExportHeaders))
	for i, h := range n9eExportHeaders {
		header[i] = h
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
		for _, r := range rows {
			written++
			dur := ""
			if r.RecoverTime > 0 && r.RecoverTime > r.TriggerTime {
				dur = n9eFormatDuration(r.RecoverTime - r.TriggerTime)
			} else {
				dur = "未恢复（已 " + n9eFormatDuration(now-r.TriggerTime) + "）"
			}
			status := "已恢复"
			if r.IsRecovered == 0 {
				status = "未恢复"
			}
			cell, _ := excelize.CoordinatesToCellName(1, written+1)
			_ = sw.SetRow(cell, []interface{}{
				written,
				r.ID,
				n9eFormatTime(r.TriggerTime),
				n9eFormatTime(r.RecoverTime),
				dur,
				status,
				n9eSeverityLabel(r.Severity),
				r.RuleName,
				r.GroupName,
				r.Cluster,
				r.TargetHost,
				r.TargetIdent,
				r.Department,
				r.SystemName,
				r.TriggerValue,
				n9eFormatTime(r.FirstTriggerTime),
				r.NotifyCurNumber,
				r.NotifyChannels,
			})
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

	name := fmt.Sprintf("夜莺告警记录_%s_%s_%s.xlsx",
		time.Unix(q.Stime, 0).Format("20060102"),
		time.Unix(q.Etime, 0).Format("20060102"),
		time.Now().Format("20060102"))
	// 中文文件名走 RFC 5987，否则各浏览器表现不一致
	c.Header("Content-Disposition",
		`attachment; filename="n9e-alert-events.xlsx"; filename*=UTF-8''`+url.PathEscape(name))
	c.Header("X-Total-Rows", strconv.Itoa(written))
	c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buf.Bytes())
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
