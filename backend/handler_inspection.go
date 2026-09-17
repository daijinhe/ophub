package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ---- 辅助 ----

func mustJSON(v interface{}) []byte {
	b, _ := json.Marshal(v)
	return b
}

// taskCategories 返回任务采集的分类（默认全部六类）
func taskCategories(task *InspectionTask) []string {
	var cats []string
	if len(task.Metrics) > 0 {
	}
	if len(cats) == 0 {
		cats = DefaultCategories()
	}
	return cats
}

// computeNextRun 依据任务的调度配置推算下一次执行时间。
// 返回 nil 表示「没有定时」（手动执行 / 未知频率）。
//
// 各频率语义（前端 api/inspection.ts 的 scheduleText 必须与之一一对应）：
//
//	minute → 从 from 起每隔 IntervalMin 分钟
//	hour   → 每隔 IntervalHour 小时，在该小时的第 RunMinute 分钟
//	day    → 每天 RunHour:RunMinute
//	week   → 每周 Weekday（1=周一 … 7=周日）的 RunHour:RunMinute
//	month  → 每月 MonthDay 的 RunHour:RunMinute（当月无该日则取月末）
//	quarter / year → 沿用旧行为（上次执行时刻 + 3 个月 / 1 年）
func computeNextRun(t *InspectionTask, from time.Time) *time.Time {
	loc := from.Location()
	switch t.Freq {
	case FreqMinute:
		next := from.Add(time.Duration(clampScheduleInt(t.IntervalMin, 1, 1440)) * time.Minute)
		return &next
	case FreqHour:
		n := clampScheduleInt(t.IntervalHour, 1, 72)
		next := time.Date(from.Year(), from.Month(), from.Day(), from.Hour(),
			clampScheduleInt(t.RunMinute, 0, 59), 0, 0, loc)
		for !next.After(from) {
			next = next.Add(time.Duration(n) * time.Hour)
		}
		return &next
	case FreqDay:
		next := time.Date(from.Year(), from.Month(), from.Day(),
			clampScheduleInt(t.RunHour, 0, 23), clampScheduleInt(t.RunMinute, 0, 59), 0, 0, loc)
		if !next.After(from) {
			next = next.AddDate(0, 0, 1)
		}
		return &next
	case FreqWeek:
		// Go 的 Weekday()：0=周日 … 6=周六；界面用 1=周一 … 7=周日，这里做换算
		today := int(from.Weekday())
		if today == 0 {
			today = 7
		}
		base := from.AddDate(0, 0, (clampScheduleInt(t.Weekday, 1, 7)-today+7)%7)
		next := time.Date(base.Year(), base.Month(), base.Day(),
			clampScheduleInt(t.RunHour, 0, 23), clampScheduleInt(t.RunMinute, 0, 59), 0, 0, loc)
		if !next.After(from) {
			next = next.AddDate(0, 0, 7)
		}
		return &next
	case FreqMonth:
		return nextMonthRun(from, clampScheduleInt(t.MonthDay, 1, 31),
			clampScheduleInt(t.RunHour, 0, 23), clampScheduleInt(t.RunMinute, 0, 59))
	case FreqQuarter:
		next := from.AddDate(0, 3, 0)
		return &next
	case FreqYear:
		next := from.AddDate(1, 0, 0)
		return &next
	default:
		return nil
	}
}

// nextMonthRun 返回 from 之后最近一次「monthDay 日 hh:mm」。
// 当月天数不足时取月末（如 31 号在 2 月落到 28/29 号），与主流 cron 行为一致。
func nextMonthRun(from time.Time, monthDay, hh, mm int) *time.Time {
	loc := from.Location()
	y, m, _ := from.Date()
	for i := 0; i < 240; i++ { // 最多往前找 20 年，防御性上限
		d := monthDay
		if last := lastDayOfMonth(y, m); d > last {
			d = last
		}
		cand := time.Date(y, m, d, hh, mm, 0, 0, loc)
		if cand.After(from) {
			return &cand
		}
		m++
		if m > time.December {
			m = time.January
			y++
		}
	}
	return nil
}

func resolveTaskAssets(task *InspectionTask) ([]Asset, error) {
	q := DB.Model(&Asset{})
	switch task.ScopeType {
	case "category":
		if task.CategoryID != nil {
			ids := collectSubtreeIDs(*task.CategoryID)
			q = q.Where("category_id IN ?", ids)
		}
	case "selected":
		var ids []uint
		if len(task.AssetIDs) > 0 {
		}
		if len(ids) > 0 {
			q = q.Where("id IN ?", ids)
		}
	}
	var assets []Asset
	err := q.Order("id asc").Find(&assets).Error
	return assets, err
}

// extractMiddlewareTypes 从资产字段中提取中间件类型（联动资源清单中间件信息）
func extractMiddlewareTypes(fields map[string]interface{}) []string {
	out := []string{}
	raw, ok := fields["中间件信息"]
	if !ok {
		return out
	}
	arr, ok := raw.([]interface{})
	if !ok {
		return out
	}
	for _, it := range arr {
		m, ok := it.(map[string]interface{})
		if !ok {
			continue
		}
		t := ""
		if v, ok := m["类型"]; ok {
			t, _ = v.(string)
		}
		if t == "" {
			if v, ok := m["type"]; ok {
				t, _ = v.(string)
			}
		}
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}

// diskMaxUsage 取资产所有磁盘（系统/数据/NAS）中的最高使用率
func diskMaxUsage(flat map[string]interface{}) float64 {
	max := 0.0
	for _, k := range []string{"disk_system_usage", "disk_data_max_usage", "disk_nas_max_usage"} {
		if v, ok := flat[k].(float64); ok && v > max {
			max = v
		}
	}
	return max
}

// hostDisplayName 生成巡检大屏的主机展示名：项目简称_环境_业务环境
// 三个字段均取自资产管理（Asset.Fields）。任一段为空则跳过该段（避免出现 "A__B" 这种空洞）；
// 三段全为空时回退到资产名称，保证大屏不至于显示空白。
func hostDisplayName(fa map[string]string, fallback string) string {
	parts := make([]string, 0, 3)
	for _, k := range []string{"proj", "env", "bizEnv"} {
		if v := strings.TrimSpace(fa[k]); v != "" {
			parts = append(parts, v)
		}
	}
	if len(parts) == 0 {
		return fallback
	}
	return strings.Join(parts, "_")
}

// executeInspection 执行一次巡检（手动与定时共用）
func executeInspection(task *InspectionTask) (*InspectionRecord, error) {
	assets, _ := resolveTaskAssets(task)

	var node *AnsibleRemote
	if task.RemoteNodeID != nil {
		var n AnsibleRemote
		if err := DB.First(&n, *task.RemoteNodeID).Error; err == nil {
			node = &n
		}
	}

	rec := InspectionRecord{
		TaskID:      task.ID,
		TaskName:    task.Name,
		RunAt:       time.Now(),
		Status:      "running",
		TotalAssets: len(assets),
		Source:      SrcSimulated,
	}
	if err := DB.Create(&rec).Error; err != nil {
		return nil, err
	}

	start := time.Now()
	success, fail := 0, 0
	var sumCpu, sumMem, sumDisk float64
	var cnt int
	categoryAlerts := map[string]int{}
	// 告警规则（阈值覆盖 / 屏蔽）在采集时即按当前配置评估，落库快照与页面展示口径一致
	alertRules := loadAlertRules()
	for _, a := range assets {
		var fields map[string]interface{}
		_ = json.Unmarshal(a.Fields, &fields)
		_ = decryptAssetFields(fields)
		ip := extractIP(fields)
		mwTypes := extractMiddlewareTypes(fields)
		res := InspectionResult{
			RecordID:    rec.ID,
			TaskID:      task.ID,
			AssetID:     a.ID,
			AssetName:   AssetDisplayName(&a),
			IP:          ip,
			CollectedAt: time.Now(),
		}
		if ip == "" {
			res.Status = "fail"
			res.Error = "资产缺少 IP（虚拟机IPv4）"
			fail++
		} else {
			data, src, _ := CollectAsset(ip, node, task.SshUser, task.SshPass, task.SshPort, mwTypes)
			res.Data = mustJSON(data)
			res.Source = src
			res.Status = "ok"
			alerts := evalAlertsWithProfile(data, resolveAlertProfile(alertRules, assetAlertScopeOf(&a)))
			res.Alerts = mustJSON(alerts)
			success++
			if src == SrcAnsible {
				rec.Source = SrcAnsible
			}
			flat := resolveFlat(data)
			if v, ok := flat["cpu_usage"].(float64); ok {
				sumCpu += v
			}
			if v, ok := flat["mem_usage"].(float64); ok {
				sumMem += v
			}
			sumDisk += diskMaxUsage(flat)
			cnt++
			for _, al := range alerts {
				categoryAlerts[categoryOfAlert(al)]++
			}
		}
		if err := DB.Create(&res).Error; err != nil {
			return nil, err
		}
	}

	dur := time.Since(start).Milliseconds()
	status := "done"
	if fail > 0 && success == 0 {
		status = "failed"
	} else if fail > 0 {
		status = "partial"
	}
	avgCpu, avgMem, avgDisk := 0.0, 0.0, 0.0
	if cnt > 0 {
		avgCpu = round1(sumCpu / float64(cnt))
		avgMem = round1(sumMem / float64(cnt))
		avgDisk = round1(sumDisk / float64(cnt))
	}
	summary := map[string]interface{}{
		"avgCpu":         avgCpu,
		"avgMem":         avgMem,
		"avgDisk":        avgDisk,
		"online":         success,
		"offline":        fail,
		"categoryAlerts": categoryAlerts,
	}
	rec.Status = status
	rec.SuccessCount = success
	rec.FailCount = fail
	rec.DurationMs = dur
	rec.Summary = mustJSON(summary)
	if err := DB.Save(&rec).Error; err != nil {
		return nil, err
	}

	now := time.Now()
	task.LastRunAt = &now
	task.Status = "idle"
	DB.Save(task)
	return &rec, nil
}

// ---- HTTP 接口 ----

// InspectionMetricCatalog 返回可采集指标目录（按六类分组）
func InspectionMetricCatalog(c *gin.Context) {
	OK(c, gin.H{
		"groups":     MetricGroups,
		"metrics":    FlatMetricDefs(),
		"categories": DefaultCategories(),
	})
}

// ListInspectionTasks 列表
func ListInspectionTasks(c *gin.Context) {
	var list []InspectionTask
	DB.Order("id desc").Find(&list)
	nodes := map[uint]string{}
	var remotes []AnsibleRemote
	DB.Select("id,name").Find(&remotes)
	for _, r := range remotes {
		nodes[r.ID] = r.Name
	}
	out := make([]gin.H, 0, len(list))
	for _, t := range list {
		nodeName := ""
		if t.RemoteNodeID != nil {
			nodeName = nodes[*t.RemoteNodeID]
		}
		var cats []string
		out = append(out, gin.H{
			"id":              t.ID,
			"name":            t.Name,
			"scopeType":       t.ScopeType,
			"categoryId":      t.CategoryID,
			"assetIds":        json.RawMessage(t.AssetIDs),
			"metrics":         json.RawMessage(t.Metrics),
			"categories":      cats,
			"freq":            t.Freq,
			"remoteNodeId":    t.RemoteNodeID,
			"remoteNodeName":  nodeName,
			"scheduleEnabled": t.ScheduleEnabled,
			"lastRunAt":       t.LastRunAt,
			"nextRunAt":       t.NextRunAt,
			"status":          t.Status,
			"createdAt":       t.CreatedAt,
		})
	}
	OK(c, gin.H{"list": out, "total": len(out)})
}

// CreateInspectionTask 新建
func CreateInspectionTask(c *gin.Context) {
	var body InspectionTask
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	if body.Name == "" {
		Fail(c, http.StatusBadRequest, 400, "任务名称不能为空")
		return
	}
	if body.Freq == "" {
		body.Freq = FreqManual
	}
	if body.ScopeType == "" {
		body.ScopeType = "all"
	}
	if len(body.Metrics) == 0 {
		body.Metrics = mustJSON(DefaultCategories())
	}
	if body.SshPort == 0 {
		body.SshPort = 65181
	}
	NormalizeSchedule(&body)
	if body.ScheduleEnabled && body.Freq != FreqManual {
		body.NextRunAt = computeNextRun(&body, time.Now())
	}
	uid := currentUserID(c)
	body.CreatedBy = uid
	body.Status = "idle"
	if err := DB.Create(&body).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "创建失败: "+err.Error())
		return
	}
	OK(c, body)
}

// UpdateInspectionTask 更新
func UpdateInspectionTask(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var task InspectionTask
	if err := DB.First(&task, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "任务不存在")
		return
	}
	var body InspectionTask
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	if body.Name != "" {
		task.Name = body.Name
	}
	task.ScopeType = body.ScopeType
	task.CategoryID = body.CategoryID
	task.AssetIDs = body.AssetIDs
	if len(body.Metrics) > 0 {
		task.Metrics = body.Metrics
	}
	// 先记录改动前的调度配置：只有它真的变了才重算下次执行时间，
	// 否则改个任务名也会把「还有 5 分钟就该跑」的下次时间推到下一个周期。
	oldFreq, oldEnabled := task.Freq, task.ScheduleEnabled
	oldCfg := [6]int{task.IntervalMin, task.IntervalHour, task.Weekday, task.MonthDay, task.RunHour, task.RunMinute}

	task.Freq = body.Freq
	task.IntervalMin = body.IntervalMin
	task.IntervalHour = body.IntervalHour
	task.Weekday = body.Weekday
	task.MonthDay = body.MonthDay
	task.RunHour = body.RunHour
	task.RunMinute = body.RunMinute
	NormalizeSchedule(&task)
	newCfg := [6]int{task.IntervalMin, task.IntervalHour, task.Weekday, task.MonthDay, task.RunHour, task.RunMinute}
	scheduleChanged := oldFreq != task.Freq || oldEnabled != body.ScheduleEnabled || oldCfg != newCfg

	task.RemoteNodeID = body.RemoteNodeID
	task.SshUser = body.SshUser
	if body.SshPass != "" {
		task.SshPass = body.SshPass
	}
	if body.SshPort != 0 {
		task.SshPort = body.SshPort
	}
	task.ScheduleEnabled = body.ScheduleEnabled
	if task.ScheduleEnabled && task.Freq != FreqManual {
		if task.NextRunAt == nil || scheduleChanged {
			task.NextRunAt = computeNextRun(&task, time.Now())
		}
	} else {
		task.NextRunAt = nil
	}
	DB.Save(&task)
	OK(c, task)
}

// DeleteInspectionTask 删除（级联删除其记录与结果）
func DeleteInspectionTask(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	if err := DB.Transaction(func(tx *gorm.DB) error {
		tx.Where("record_id IN (?)", tx.Model(&InspectionRecord{}).Select("id").Where("task_id = ?", id)).Delete(&InspectionResult{})
		tx.Where("task_id = ?", id).Delete(&InspectionRecord{})
		tx.Delete(&InspectionTask{}, id)
		return nil
	}); err != nil {
		Fail(c, http.StatusInternalServerError, 500, "删除失败: "+err.Error())
		return
	}
	OK(c, gin.H{"id": id})
}

// BatchDeleteInspectionRecords 批量删除巡检记录（含其采集结果）
func BatchDeleteInspectionRecords(c *gin.Context) {
	var body struct {
		IDs []uint `json:"ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.IDs) == 0 {
		Fail(c, http.StatusBadRequest, 400, "请提供要删除的记录 ID 列表")
		return
	}
	if err := DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("record_id IN ?", body.IDs).Delete(&InspectionResult{}).Error; err != nil {
			return err
		}
		return tx.Where("id IN ?", body.IDs).Delete(&InspectionRecord{}).Error
	}); err != nil {
		Fail(c, http.StatusInternalServerError, 500, "删除失败: "+err.Error())
		return
	}
	OK(c, gin.H{"deleted": len(body.IDs)})
}

// BatchDeleteInspectionTasks 批量删除巡检任务（含其记录与采集结果）
func BatchDeleteInspectionTasks(c *gin.Context) {
	var body struct {
		IDs []uint `json:"ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.IDs) == 0 {
		Fail(c, http.StatusBadRequest, 400, "请提供要删除的任务 ID 列表")
		return
	}
	if err := DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("record_id IN (?)", tx.Model(&InspectionRecord{}).Select("id").Where("task_id IN ?", body.IDs)).Delete(&InspectionResult{}).Error; err != nil {
			return err
		}
		if err := tx.Where("task_id IN ?", body.IDs).Delete(&InspectionRecord{}).Error; err != nil {
			return err
		}
		return tx.Where("id IN ?", body.IDs).Delete(&InspectionTask{}).Error
	}); err != nil {
		Fail(c, http.StatusInternalServerError, 500, "删除失败: "+err.Error())
		return
	}
	OK(c, gin.H{"deleted": len(body.IDs)})
}

// RunInspectionTask 立即执行（异步）
func RunInspectionTask(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var task InspectionTask
	if err := DB.First(&task, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "任务不存在")
		return
	}
	if task.Status == "running" {
		Fail(c, http.StatusConflict, 409, "该任务正在执行中，请稍后再试")
		return
	}
	task.Status = "running"
	DB.Save(&task)
	go func() {
		_, _ = executeInspection(&task)
	}()
	OK(c, gin.H{"msg": "巡检已启动", "taskId": task.ID})
}

// ============================================================================
// 巡检结果联动资产管理：资产名称→ERP系统名称、IP→虚拟机IPv4、归属部门、开发人员
// ============================================================================

// assetDisplay 读取资产在 CMDB 中的展示信息（ERP系统名称 / 归属部门 / 虚拟机IPv4 / 开发人员），缺省回落资产快照
func assetDisplay(assetID uint) map[string]string {
	var a Asset
	if err := DB.First(&a, assetID).Error; err != nil {
		return nil
	}
	f := map[string]interface{}{}
	_ = json.Unmarshal(a.Fields, &f)
	_ = decryptAssetFields(f)
	get := func(k, def string) string {
		if s, ok := f[k].(string); ok && s != "" {
			return s
		}
		return def
	}
	return map[string]string{
		"erpName":    get("ERP系统名称", a.Name),
		"department": get("归属部门", ""),
		"ipv4":       get("虚拟机IPv4", a.IP),
		"developer":  get("开发人员", ""),
	}
}

// enrichResults 批量联动：用资产管理信息覆盖巡检结果的名称/IP 并补充归属部门、开发人员
func enrichResults(results []InspectionResult) []InspectionResult {
	if len(results) == 0 {
		return results
	}
	dispMap := map[uint]map[string]string{}
	for i := range results {
		disp := dispMap[results[i].AssetID]
		if disp == nil {
			disp = assetDisplay(results[i].AssetID)
			dispMap[results[i].AssetID] = disp
		}
		if disp == nil {
			continue
		}
		if disp["erpName"] != "" {
			results[i].AssetName = disp["erpName"]
		}
		if disp["ipv4"] != "" {
			results[i].IP = disp["ipv4"]
		}
		results[i].Department = disp["department"]
		results[i].Developer = disp["developer"]
	}
	return results
}

// ListInspectionRecords 记录列表
func ListInspectionRecords(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}
	taskID, _ := strconv.Atoi(c.Query("taskId"))
	q := DB.Model(&InspectionRecord{})
	if taskID > 0 {
		q = q.Where("task_id = ?", taskID)
	}
	var total int64
	q.Count(&total)
	var list []InspectionRecord
	q.Order("run_at desc").Offset((page - 1) * size).Limit(size).Find(&list)
	OK(c, gin.H{"list": list, "total": total, "page": page, "size": size})
}

// GetInspectionRecord 记录详情（含结果）
func GetInspectionRecord(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var rec InspectionRecord
	if err := DB.First(&rec, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "记录不存在")
		return
	}
	var results []InspectionResult
	DB.Where("record_id = ?", id).Order("id asc").Find(&results)
	results = enrichResults(results)
	results = rerouteAlerts(results, defaultAlertScopeResolver())
	OK(c, gin.H{"record": rec, "results": results})
}

// ListInspectionResults 结果列表
func ListInspectionResults(c *gin.Context) {
	recordID, _ := strconv.Atoi(c.Query("recordId"))
	if recordID == 0 {
		Fail(c, http.StatusBadRequest, 400, "缺少 recordId")
		return
	}
	var results []InspectionResult
	DB.Where("record_id = ?", recordID).Order("id asc").Find(&results)
	results = enrichResults(results)
	results = rerouteAlerts(results, defaultAlertScopeResolver())
	OK(c, gin.H{"list": results, "total": len(results)})
}

// InspectionDashboard 大屏聚合数据
func InspectionDashboard(c *gin.Context) {
	// ===== 过滤参数（区域/环境/架构）=====
	zoneQ := strings.TrimSpace(c.Query("zone"))
	envQ := strings.TrimSpace(c.Query("env"))
	archQ := strings.TrimSpace(strings.ToLower(c.Query("arch"))) // arm / x86 / all

	// 资源/任务/记录总数
	var totalAssets int64
	DB.Model(&Asset{}).Count(&totalAssets)
	var taskCount int64
	DB.Model(&InspectionTask{}).Count(&taskCount)
	var recordCount int64
	DB.Model(&InspectionRecord{}).Count(&recordCount)

	// —— 调度概览（供大屏展示「下次巡检」）
	// 只取启用定时的任务；前端用同一套参数渲染频率文案（见 api/inspection.ts 的 scheduleText）。
	var scheduledTasks []InspectionTask
	DB.Where("schedule_enabled = ? AND freq <> ?", true, FreqManual).
		Order("next_run_at asc").Find(&scheduledTasks)
	schedules := make([]gin.H, 0, len(scheduledTasks))
	var nextRunAt *time.Time
	for i := range scheduledTasks {
		st := scheduledTasks[i]
		if st.NextRunAt != nil && (nextRunAt == nil || st.NextRunAt.Before(*nextRunAt)) {
			nr := *st.NextRunAt
			nextRunAt = &nr
		}
		schedules = append(schedules, gin.H{
			"id":           st.ID,
			"name":         st.Name,
			"freq":         st.Freq,
			"intervalMin":  st.IntervalMin,
			"intervalHour": st.IntervalHour,
			"weekday":      st.Weekday,
			"monthDay":     st.MonthDay,
			"runHour":      st.RunHour,
			"runMinute":    st.RunMinute,
			"nextRunAt":    st.NextRunAt,
		})
	}

	var latest InspectionRecord
	DB.Order("run_at desc").First(&latest)

	// 结果聚合
	var allResults []InspectionResult
	if latest.ID > 0 {
		DB.Where("record_id = ?", latest.ID).Find(&allResults)
		allResults = enrichResults(allResults)
	}

	// ===== 架构（arm / x86）判定 =====
	// 巡检结果里实测到的 CPU 架构，按 IP 建索引，作为「CMDB 未写明架构」时的兜底。
	inspectionArchByIP := map[string]string{}
	for _, r := range allResults {
		if r.IP == "" {
			continue
		}
		var d map[string]interface{}
		if om, ok := d["os"].(map[string]interface{}); ok {
			if a, _ := om["arch"].(string); a != "" {
				inspectionArchByIP[r.IP] = a
			}
		}
	}
	// archClass 把各种写法归一到 arm / x86；识别不出返回 ""
	archClass := func(raw string) string {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "aarch64", "arm64", "arm":
			return "arm"
		case "x86_64", "amd64", "i386", "i686", "x86":
			return "x86"
		}
		return ""
	}
	// osArchClass 从 CMDB「操作系统版本」文本里识别架构，
	// 例：「Huawei Cloud EulerOS 2.0 (aarch64)」→ arm。
	// 注意先判 arm 再判 x86：字符串里可能同时出现关键字。
	osArchClass := func(raw string) string {
		l := strings.ToLower(raw)
		if strings.Contains(l, "aarch64") || strings.Contains(l, "arm64") {
			return "arm"
		}
		if strings.Contains(l, "x86") || strings.Contains(l, "amd64") || strings.Contains(l, "i386") || strings.Contains(l, "i686") {
			return "x86"
		}
		return ""
	}

	// 预取资产 fields 用于过滤（区域/环境/架构）与展示名（项目简称_环境_业务环境）。
	//
	// 关键：巡检结果里的 asset_id 是「录入巡检那一刻」的资产主键。资产被重新导入后
	// 主键会变（旧记录被删、新记录拿到新 ID），导致按 ID 查不到资产、字段全空、
	// 展示名退化成原始资产名。因此这里同时建「ID → 字段」和「IP → 字段」两份索引，
	// 按 ID 查不到时用 IP 兜底（IP 是稳定的业务主键）。
	assetFieldsByID := map[uint]map[string]string{}
	assetFieldsByIP := map[string]map[string]string{}
	// 同一份 IP → 真实资产 ID 的反向索引，用于把巡检结果的旧 asset_id
	// （重新导入资产后已变成悬挂外键）映射回当前资产表的真实主键，
	// 否则大屏告警点击会跳到 /webterm/{旧ID} 报「加载资产信息失败」。
	assetIDByIP := map[string]uint{}
	// cmdbAssets = CMDB 全量资产（= 资产管理列表口径）。
	// 大屏凡是「有多少台」的统计都以它为分母，见下方 cmdbFiltered 的说明。
	cmdbAssets := make([]Asset, 0, 128)
	{
		// 把一条资产解析成大屏所需的展示字段
		buildFA := func(a Asset) map[string]string {
			var m map[string]interface{}
			_ = json.Unmarshal(a.Fields, &m)
			_ = decryptAssetFields(m)
			get := func(k string) string {
				if s, ok := m[k].(string); ok {
					return s
				}
				return ""
			}
			// 架构：CMDB「操作系统版本」文本优先（如 "(aarch64)"），
			// 但资源校准写入的是「ID+版本号」写法（hce2.0 / almalinux8.9），不含架构字样，
			// 因此补一级 CMDB「CPU类型」（x86_64 / aarch64，同为登记值），最后才用巡检实测兜底。
			arch := osArchClass(get("操作系统版本"))
			if arch == "" {
				arch = archClass(get("CPU类型"))
			}
			if arch == "" {
				arch = archClass(inspectionArchByIP[a.IP])
			}
			if arch == "" {
				arch = archClass(inspectionArchByIP[get("虚拟机IPv4")])
			}
			return map[string]string{
				"zone":     get("所属网络区域"),
				"env":      get("环境"),
				"system":   get("应用系统名称"),
				"dept":     get("归属部门"),
				"category": get("资源分类"), // 兜底字段
				"arch":     arch,
				// 大屏展示名「项目简称_环境_业务环境」（2026-09-09）
				"proj":   get("项目简称"),
				"bizEnv": get("业务环境"),
				"ipv4":   get("虚拟机IPv4"),
				// OS 分布以资产管理（CMDB）的「操作系统版本」字段为权威来源，
				// 并且**按原值展示**：资源列表里登记的是什么，大屏就显示什么，逐字一致。
				// 不做 simplifyOS 家族归并（否则 "Huawei Cloud EulerOS 2.0 (aarch64)"
				// 与 "华为欧拉 HCE2.0" 会被并成「华为 HCE」，与资源列表对不上）。
				// 仅去掉首尾空白：同一版本因前后空格差异裂成两类毫无意义。
				// 巡检采集的 data.os.name 不用——它来自真实测试主机，与登记值可能不一致。
				"os": strings.TrimSpace(get("操作系统版本")),
			}
		}
		// 索引一份资产，同时挂到 ID 与 IP（assets.ip 列 + fields.虚拟机IPv4）
		index := func(a Asset) {
			fa := buildFA(a)
			assetFieldsByID[a.ID] = fa
			if a.IP != "" {
				assetFieldsByIP[a.IP] = fa
				// 同 IP 多条资产时保留最小 ID，与按 IP 兜底查到的那条保持一致
				if cur, ok := assetIDByIP[a.IP]; !ok || a.ID < cur {
					assetIDByIP[a.IP] = a.ID
				}
			}
			if v := fa["ipv4"]; v != "" && v != a.IP {
				assetFieldsByIP[v] = fa
				if cur, ok := assetIDByIP[v]; !ok || a.ID < cur {
					assetIDByIP[v] = a.ID
				}
			}
		}

		// 一次取「全量资产」：既服务下文「按 ID / 按 IP 兜底查字段」，
		// 也作为大屏所有台数统计的分母（见 cmdbFiltered）。
		// 之前只按巡检结果里的 asset_id 反查，导致没进最近一次巡检的资产
		// （新增 / 未排入任务 / 采集失败）在这里根本不存在，于是整台从饼图和 KPI 里消失。
		DB.Find(&cmdbAssets)
		for _, a := range cmdbAssets {
			index(a)
		}
	}
	// 统一查询入口：先按资产 ID，再按 IP 兜底；都查不到返回空 map（此前行为兼容）
	lookupAssetFields := func(assetID uint, ip string) map[string]string {
		if fa, ok := assetFieldsByID[assetID]; ok {
			return fa
		}
		if ip != "" {
			if fa, ok := assetFieldsByIP[ip]; ok {
				return fa
			}
		}
		return map[string]string{}
	}
	// 把巡检结果的旧 asset_id 反查到当前资产表的真实 ID。
	// 找不到时返回原值（保留 r.AssetID，便于排查）。
	resolveRealAssetID := func(assetID uint, ip string, idx map[string]uint) uint {
		if ip != "" {
			if v, ok := idx[ip]; ok && v > 0 {
				return v
			}
		}
		return assetID
	}

	// 过滤后的 results（用于大屏聚合）
	filtered := make([]InspectionResult, 0, len(allResults))
	for _, r := range allResults {
		// 按 ID 查资产字段，查不到再用 IP 兜底（资产重新导入后主键会变）
		fa := lookupAssetFields(r.AssetID, r.IP)
		if zoneQ != "" && zoneQ != "全部" && fa["zone"] != zoneQ {
			continue
		}
		if envQ != "" && envQ != "全部" && fa["env"] != envQ {
			continue
		}
		// 架构过滤：走 fa["arch"]（CMDB「操作系统版本」优先、巡检实测架构兜底，见 buildFA）
		if archQ != "" && archQ != "all" && fa["arch"] != archQ {
			continue
		}
		filtered = append(filtered, r)
	}

	// ===== CMDB 资产口径（大屏所有「台数类」统计的分母）=====
	// 巡检只覆盖「最近一次巡检有结果的资产」：新增资产、未排入巡检任务的资产、
	// 采集失败的资产会整台从分布图与 KPI 里消失（实测 CMDB 10 台、大屏只统计到 9 台），
	// 于是用户改了那台资产的操作系统，饼图毫无反应。
	// 所以：凡是「有多少台」的统计一律以 CMDB 资产列表为准（同样受区域/环境/架构筛选），
	// 只有「用了多少」的指标（CPU/内存/磁盘使用率、TOP5、告警）才继续用巡检数据。
	cmdbFiltered := make([]Asset, 0, len(cmdbAssets))
	for _, a := range cmdbAssets {
		fa := assetFieldsByID[a.ID]
		if zoneQ != "" && zoneQ != "全部" && fa["zone"] != zoneQ {
			continue
		}
		if envQ != "" && envQ != "全部" && fa["env"] != envQ {
			continue
		}
		if archQ != "" && archQ != "all" && fa["arch"] != archQ {
			continue
		}
		cmdbFiltered = append(cmdbFiltered, a)
	}
	// 巡检数据覆盖率：按「资产 ID + IP 双口径」判定（资产重导入后旧 asset_id 会悬挂）
	coveredID := map[uint]bool{}
	coveredIP := map[string]bool{}
	for _, r := range filtered {
		if id := resolveRealAssetID(r.AssetID, r.IP, assetIDByIP); id > 0 {
			coveredID[id] = true
		}
		if r.IP != "" {
			coveredIP[r.IP] = true
		}
	}
	hasInspection := func(a Asset) bool {
		if coveredID[a.ID] {
			return true
		}
		if a.IP != "" && coveredIP[a.IP] {
			return true
		}
		if v := assetFieldsByID[a.ID]["ipv4"]; v != "" && coveredIP[v] {
			return true
		}
		return false
	}
	notCollected := 0
	for _, a := range cmdbFiltered {
		if !hasInspection(a) {
			notCollected++
		}
	}

	// ===== 过滤选项（供前端下拉）=====
	// 计数同样以 CMDB 资产列表为准，保证「下拉里显示的台数」== 资产列表按该条件筛选后的条数。
	zoneCounts := map[string]int{}
	envCounts := map[string]int{}
	archCounts := map[string]int{}
	for _, a := range cmdbAssets {
		fa := assetFieldsByID[a.ID]
		if fa["zone"] != "" {
			zoneCounts[fa["zone"]]++
		}
		if fa["env"] != "" {
			envCounts[fa["env"]]++
		}
		switch fa["arch"] {
		case "arm":
			archCounts["arm"]++
		case "x86":
			archCounts["x86"]++
		}
	}
	zoneList := make([]gin.H, 0, len(zoneCounts))
	for k, v := range zoneCounts {
		zoneList = append(zoneList, gin.H{"name": k, "count": v})
	}
	sort.Slice(zoneList, func(i, j int) bool { return zoneList[i]["name"].(string) < zoneList[j]["name"].(string) })
	envList := make([]gin.H, 0, len(envCounts))
	for k, v := range envCounts {
		envList = append(envList, gin.H{"name": k, "count": v})
	}
	sort.Slice(envList, func(i, j int) bool { return envList[i]["name"].(string) < envList[j]["name"].(string) })

	// ===== 主机级聚合 =====
	// 告警规则在渲染时按当前配置重算（阈值覆盖 + 屏蔽），因此改完规则刷新即生效，
	// 历史巡检数据也遵循最新配置，无需重跑巡检。
	alertRules := loadAlertRules()
	type host struct {
		id         uint
		name       string
		assetName  string // 原始资产名（组合名缺失字段时的兜底来源）
		ip         string
		zone       string
		env        string
		system     string
		cores      float64
		memTotal   float64
		diskTotal  float64
		cpuUsage   float64
		memUsage   float64
		diskMax    float64
		netUsage   float64
		iowait     float64
		loadRatio  float64
		procDown   int
		procTotal  int
		zombie     int
		fwStatus   string
		sshFail    int
		osName     string
		osArch     string
		disks      []gin.H
		alertCount int
		alertCrit  int
		alertWarn  int
		status     string
	}

	hosts := make([]host, 0, len(filtered))
	// OS 分布：以 CMDB 资产列表（筛选后）为分母，而不是「有巡检结果的资产」。
	// 数据来源是资产管理（CMDB）的「操作系统版本」字段**原值**（buildFA 不做家族归并），
	// 不是巡检采集的 data.os.name —— 后者来自真实测试主机，与登记值不一致时会污染分布。
	// 空值 = 该资产未登记 OS，归入「未登记」，便于运维发现漏填。
	osDist := map[string]int{}
	for _, a := range cmdbFiltered {
		if osLabel := assetFieldsByID[a.ID]["os"]; osLabel != "" {
			osDist[osLabel]++
		} else {
			osDist["未登记"]++
		}
	}
	categoryAlerts := map[string]int{}
	levelCount := gin.H{"critical": 0, "warning": 0, "info": 0}
	expandedAlerts := make([]gin.H, 0, 32)

	var sumCpu, sumMem, sumDisk, sumNet float64
	var totalCores, totalMem, totalDisk float64
	var onCount, offCount int
	disksWarn, disksDanger := 0, 0

	// 展示名以资产当前值为准：inspection_results.asset_name 是采集那一刻的快照，
	// 资产改名后会一直显示旧名（这正是「改了资产信息但名字不变」的来源）。
	refreshAssetNameSnapshots(len(filtered),
		func(i int) uint { return filtered[i].AssetID },
		func(i int, name string) { filtered[i].AssetName = name },
	)

	for _, r := range filtered {
		var data map[string]interface{}
		flat := resolveFlat(data)
		// 按 ID 查资产字段，查不到再用 IP 兜底（资产重新导入后主键会变）
		fa := lookupAssetFields(r.AssetID, r.IP)
		// 该主机命中的告警规则（按项目简称/应用系统名称/资产匹配），供告警重算与磁盘 KPI 复用
		prof := resolveAlertProfile(alertRules, alertScope{
			ID:      resolveRealAssetID(r.AssetID, r.IP, assetIDByIP),
			Project: fa["proj"],
			System:  fa["system"],
		})

		h := host{
			id: r.AssetID,
			// 大屏展示名优先用资产字段组合「项目简称_环境_业务环境」
			name:      hostDisplayName(fa, r.AssetName),
			assetName: r.AssetName,
			ip:        r.IP,
			zone:      fa["zone"],
			env:       fa["env"],
			system:    fa["system"],
			status:    r.Status,
		}
		if v, ok := flat["cpu_cores"].(float64); ok {
			h.cores = v
		}
		if v, ok := flat["mem_total_gb"].(float64); ok {
			h.memTotal = v
		}
		if v, ok := flat["cpu_usage"].(float64); ok {
			h.cpuUsage = v
		}
		if v, ok := flat["mem_usage"].(float64); ok {
			h.memUsage = v
		}
		h.diskMax = diskMaxUsage(flat)
		if v, ok := flat["net_bandwidth_max_pct"].(float64); ok {
			h.netUsage = v
		}
		if v, ok := flat["cpu_iowait"].(float64); ok {
			h.iowait = v
		}
		if v, ok := flat["cpu_load_ratio"].(float64); ok {
			h.loadRatio = v
		}
		if v, ok := flat["proc_total"].(float64); ok {
			h.procTotal = int(v)
		}
		if v, ok := flat["proc_zombie"].(float64); ok {
			h.zombie = int(v)
		}
		if v, ok := flat["ssh_fail_24h"].(float64); ok {
			h.sshFail = int(v)
		}
		// 资产安全
		if sm, ok := data["security"].(map[string]interface{}); ok {
			if v, ok := sm["firewall"].(string); ok {
				h.fwStatus = v
			}
		}
		// OS
		if om, ok := data["os"].(map[string]interface{}); ok {
			if v, ok := om["name"].(string); ok {
				h.osName = v
			}
			if v, ok := om["arch"].(string); ok {
				h.osArch = v
			}
		}
		// 磁盘明细
		if dm, ok := data["disk"].(map[string]interface{}); ok {
			if arr, ok := dm["disks"].([]interface{}); ok {
				for _, di := range arr {
					m, ok := di.(map[string]interface{})
					if !ok {
						continue
					}
					usage := 0.0
					switch t := m["usage"].(type) {
					case float64:
						usage = t
					case int:
						usage = float64(t)
					}
					total := 0.0
					if v, ok := m["total_gb"].(float64); ok {
						total = v
					}
					used := 0.0
					if v, ok := m["used_gb"].(float64); ok {
						used = v
					}
					role, _ := m["role"].(string)
					mount, _ := m["mount"].(string)
					dev, _ := m["device"].(string)
					fstype, _ := m["fstype"].(string)
					h.disks = append(h.disks, gin.H{
						"mount": mount, "device": dev, "fstype": fstype, "role": role,
						"usage": usage, "total_gb": total, "used_gb": used,
					})
					if total > 0 {
						h.diskTotal += total
					}
					// 磁盘 KPI 与告警列表共用同一套阈值（含规则覆盖），避免两处口径不一致
					dw, dc := prof.thr("disk_usage", 75, 80)
					if role == "data" {
						dw, dc = prof.thr("disk_data_usage", 70, 80)
					}
					if dc > 0 && usage >= dc {
						disksDanger++
					} else if dw > 0 && usage >= dw {
						disksWarn++
					}
				}
			}
		}
		// 进程核心存活
		if pm, ok := data["proc"].(map[string]interface{}); ok {
			if arr, ok := pm["core"].([]interface{}); ok {
				for _, ci := range arr {
					m, ok := ci.(map[string]interface{})
					if !ok {
						continue
					}
					if alive, ok := m["alive"].(bool); ok && !alive {
						h.procDown++
					}
				}
			}
		}
		// 告警：按当前规则重算（阈值覆盖 + 屏蔽），而非直接读采集快照
		alerts := evalAlertsWithProfile(data, prof)
		h.alertCount = len(alerts)
		for _, a := range alerts {
			cat := categoryOfAlert(a)
			categoryAlerts[cat]++
			lv, _ := a["level"].(string)
			if lv == "critical" {
				levelCount["critical"] = levelCount["critical"].(int) + 1
				h.alertCrit++
			} else if lv == "warning" {
				levelCount["warning"] = levelCount["warning"].(int) + 1
				h.alertWarn++
			} else {
				levelCount["info"] = levelCount["info"].(int) + 1
			}
			metric, _ := a["metric"].(string)
			valStr := fmt.Sprintf("%v", a["value"])
			note, _ := a["note"].(string)
			expandedAlerts = append(expandedAlerts, gin.H{
				// 把巡检结果里的旧 asset_id 用 IP 反查回当前资产表的真实 ID；
				// 找不到时回退到 r.AssetID（即便 404 也比现在的「假成功」更可调试）。
				"assetId": resolveRealAssetID(r.AssetID, r.IP, assetIDByIP),
				// 同步给出 webtermUrl，前端优先用，避免前端硬拼 /webterm/{assetId}
				"webtermUrl": "/webterm/" + strconv.FormatUint(uint64(resolveRealAssetID(r.AssetID, r.IP, assetIDByIP)), 10),
				// 与主机列表一致，用「项目简称_环境_业务环境」组合名；原资产名保留在 assetName
				"name":        h.name,
				"assetName":   r.AssetName,
				"ip":          r.IP,
				"zone":        h.zone,
				"env":         h.env,
				"system":      h.system,
				"level":       lv,
				"category":    cat,
				"metric":      metric,
				"value":       valStr,
				"note":        note,
				"collectedAt": r.CollectedAt,
			})
		}
		// 计数
		if r.Status == "ok" {
			onCount++
		} else {
			offCount++
		}
		sumCpu += h.cpuUsage
		sumMem += h.memUsage
		sumDisk += h.diskMax
		sumNet += h.netUsage
		totalCores += h.cores
		totalMem += h.memTotal
		totalDisk += h.diskTotal
		hosts = append(hosts, h)
	}

	// 排序展开告警：critical 优先，再按时间倒序
	sort.SliceStable(expandedAlerts, func(i, j int) bool {
		ai, aj := expandedAlerts[i]["level"].(string), expandedAlerts[j]["level"].(string)
		if ai != aj {
			return ai == "critical"
		}
		return false
	})
	if len(expandedAlerts) > 60 {
		expandedAlerts = expandedAlerts[:60]
	}

	// ===== Top5（CPU / 内存 / 磁盘）=====
	top5 := func(metric string) []gin.H {
		arr := make([]gin.H, 0, len(hosts))
		for _, h := range hosts {
			var v float64
			switch metric {
			case "cpu":
				v = h.cpuUsage
			case "mem":
				v = h.memUsage
			case "disk":
				v = h.diskMax
			case "net":
				v = h.netUsage
			}
			arr = append(arr, gin.H{
				"id":       h.id,
				"name":     h.name,
				"ip":       h.ip,
				"zone":     h.zone,
				"env":      h.env,
				"value":    round1(v),
				"cores":    h.cores,
				"memTotal": h.memTotal,
			})
		}
		sort.SliceStable(arr, func(i, j int) bool {
			return arr[i]["value"].(float64) > arr[j]["value"].(float64)
		})
		if len(arr) > 5 {
			arr = arr[:5]
		}
		return arr
	}

	// ===== 健康分布 =====
	// none = 「未采集」：在 CMDB 资产列表里、但最近一次巡检没有结果的资产。
	// 单列一类而不是直接丢掉 —— 饼图总台数因此与资产列表一致，也能顺手暴露采集覆盖缺口。
	dist := map[string]int{"low": 0, "mid": 0, "high": 0, "crit": 0, "none": notCollected}
	for _, h := range hosts {
		worst := 0.0
		if h.cpuUsage > worst {
			worst = h.cpuUsage
		}
		if h.memUsage > worst {
			worst = h.memUsage
		}
		if h.diskMax > worst {
			worst = h.diskMax
		}
		if h.netUsage > worst {
			worst = h.netUsage
		}
		switch {
		case worst >= 90:
			dist["crit"]++
		case worst >= 80:
			dist["high"]++
		case worst >= 60:
			dist["mid"]++
		default:
			dist["low"]++
		}
	}

	// ===== 平均值 =====
	var avgCpu, avgMem, avgDisk, avgNet float64
	if len(hosts) > 0 {
		avgCpu = round1(sumCpu / float64(len(hosts)))
		avgMem = round1(sumMem / float64(len(hosts)))
		avgDisk = round1(sumDisk / float64(len(hosts)))
		avgNet = round1(sumNet / float64(len(hosts)))
	}

	// ===== 趋势：最近 14 次记录的均值 =====
	var recs []InspectionRecord
	DB.Order("run_at desc").Limit(14).Find(&recs)
	trend := make([]gin.H, 0, len(recs))
	for i := len(recs) - 1; i >= 0; i-- {
		r := recs[i]
		var s map[string]interface{}
		trend = append(trend, gin.H{
			"runAt":      r.RunAt.Format("01-02 15:04"),
			"avgCpu":     s["avgCpu"],
			"avgMem":     s["avgMem"],
			"avgDisk":    s["avgDisk"],
			"alertTotal": s["categoryAlerts"],
			"status":     r.Status,
		})
	}

	// 告警总数（供 "alertCount" 等旧字段使用）
	totalAlerts := levelCount["critical"].(int) + levelCount["warning"].(int)

	// ===== 转换主机明细 =====
	hostsOut := make([]gin.H, 0, len(hosts))
	for _, h := range hosts {
		hostsOut = append(hostsOut, gin.H{
			"id":         h.id,
			"name":       h.name,
			"assetName":  h.assetName, // 原资产名兜底保留
			"ip":         h.ip,
			"zone":       h.zone,
			"env":        h.env,
			"system":     h.system,
			"status":     h.status,
			"osName":     h.osName,
			"osArch":     h.osArch,
			"cores":      h.cores,
			"memTotal":   h.memTotal,
			"diskTotal":  h.diskTotal,
			"cpuUsage":   round1(h.cpuUsage),
			"memUsage":   round1(h.memUsage),
			"diskMax":    round1(h.diskMax),
			"netUsage":   round1(h.netUsage),
			"iowait":     round1(h.iowait),
			"loadRatio":  round1(h.loadRatio),
			"procDown":   h.procDown,
			"procTotal":  h.procTotal,
			"zombie":     h.zombie,
			"fwStatus":   h.fwStatus,
			"sshFail":    h.sshFail,
			"alertCount": h.alertCount,
			"alertCrit":  h.alertCrit,
			"alertWarn":  h.alertWarn,
			"disks":      h.disks,
		})
	}

	// OS 分布输出（已聚合）
	osDistOut := make([]gin.H, 0, len(osDist))
	for k, v := range osDist {
		osDistOut = append(osDistOut, gin.H{"name": k, "value": v})
	}
	// 数量降序；数量相同按名称升序。
	// 必须给 tie-break：map 遍历顺序随机，只按 value 排会让同数量的类别每次刷新
	// 互换位置，饼图配色与图例跟着跳（大屏每 30s 刷新一次，肉眼可见）。
	sort.Slice(osDistOut, func(i, j int) bool {
		vi, vj := osDistOut[i]["value"].(int), osDistOut[j]["value"].(int)
		if vi != vj {
			return vi > vj
		}
		return osDistOut[i]["name"].(string) < osDistOut[j]["name"].(string)
	})

	// 容量
	OK(c, gin.H{
		"generatedAt": time.Now(),
		// scope 的各个口径务必分清（这是「大屏台数」能与「资产列表」对上的关键）：
		//   assetTotal   = 按当前筛选命中的 CMDB 资产数 = 所有台数统计的分母（对齐资产列表）
		//   covered      = 其中最近一次巡检真的采到的台数
		//   notCollected = assetTotal - covered（未采集，饼图里单列一类）
		//   totalAssets  = 全库资产数，不受筛选影响
		//   afterFilter  = 旧字段，等价 covered，仅为兼容旧前端保留
		"scope": gin.H{
			"zone":         zoneQ,
			"env":          envQ,
			"arch":         archQ,
			"totalAssets":  totalAssets,
			"assetTotal":   len(cmdbFiltered),
			"covered":      len(hosts),
			"notCollected": notCollected,
			"afterFilter":  len(hosts),
		},
		"filters": gin.H{
			"zones": zoneList,
			"envs":  envList,
			"archs": []gin.H{
				{"name": "all", "label": "全部架构", "count": archCounts["arm"] + archCounts["x86"]},
				{"name": "arm", "label": "ARM（信创）", "count": archCounts["arm"]},
				{"name": "x86", "label": "X86（传统）", "count": archCounts["x86"]},
			},
		},
		// —— L1 总览
		"kpi": gin.H{
			"assetTotal":  len(cmdbFiltered),
			"hostTotal":   len(hosts),
			"vmOn":        onCount,
			"vmOff":       offCount,
			"taskCount":   taskCount,
			"recordCount": recordCount,
			"alertCrit":   levelCount["critical"],
			"alertWarn":   levelCount["warning"],
			"alertInfo":   levelCount["info"],
			"alertAssets": func() int {
				c := 0
				for _, h := range hosts {
					if h.alertCount > 0 {
						c++
					}
				}
				return c
			}(),
			"diskWarn": disksWarn,
			"diskCrit": disksDanger,
		},
		// —— L2 资源摘要
		"resource": gin.H{
			"avgCpu":      avgCpu,
			"avgMem":      avgMem,
			"avgDisk":     avgDisk,
			"avgNet":      avgNet,
			"totalCores":  totalCores,
			"totalMemGb":  round1(totalMem),
			"totalDiskGb": round1(totalDisk),
		},
		"usageDist": dist,
		// —— L2 告警区
		"alerts":          expandedAlerts,
		"alertByCategory": categoryAlerts,
		"alertByLevel":    levelCount,
		"alertByLevelDist": []gin.H{
			{"name": "严重", "value": levelCount["critical"], "color": "#ef4444"},
			{"name": "预警", "value": levelCount["warning"], "color": "#f59e0b"},
			{"name": "提示", "value": levelCount["info"], "color": "#38bdf8"},
		},
		// —— L3 资源详情
		"hosts": hostsOut,
		"topLoad": gin.H{
			"cpu":  top5("cpu"),
			"mem":  top5("mem"),
			"disk": top5("disk"),
			"net":  top5("net"),
		},
		// —— L4 趋势/容量
		"trend":  trend,
		"osDist": osDistOut,
		"latestRecord": gin.H{
			"id":           latest.ID,
			"runAt":        latest.RunAt,
			"taskName":     latest.TaskName,
			"status":       latest.Status,
			"durationMs":   latest.DurationMs,
			"successCount": latest.SuccessCount,
			"failCount":    latest.FailCount,
		},
		// —— 调度（大屏「下次巡检」展示用）
		"schedules": schedules,
		"nextRunAt": nextRunAt,
		// —— 兼容旧字段
		"totalAssets":    totalAssets,
		"taskCount":      taskCount,
		"recordCount":    recordCount,
		"online":         onCount,
		"offline":        offCount,
		"avgCpu":         avgCpu,
		"avgMem":         avgMem,
		"avgDisk":        avgDisk,
		"alertCount":     totalAlerts,
		"alertAssets":    len(hosts),
		"categoryAlerts": categoryAlerts,
		"latestRunAt":    latest.RunAt,
		"topAlerts":      expandedAlerts, // 旧 key 兼容（结构同 alerts 简化）
		"dist":           dist,
		"latestResults":  allResults, // 兼容旧渲染
	})
}

// InspectionExport 按周期导出明细（可选 recordId 单独导出某条记录）
func InspectionExport(c *gin.Context) {
	period := c.DefaultQuery("period", "week")
	ref := c.DefaultQuery("ref", time.Now().Format("2006-01-02"))
	t0, err := time.Parse("2006-01-02", ref)
	if err != nil {
		t0 = time.Now()
	}
	start, end := periodRange(period, t0)

	taskID, _ := strconv.Atoi(c.Query("taskId"))
	cats := DefaultCategories()
	if taskID > 0 {
		var t InspectionTask
		if err := DB.First(&t, taskID).Error; err == nil {
			cats = taskCategories(&t)
		}
	}

	// 指定 recordId 时单独导出该记录（忽略周期过滤），否则按周期范围导出
	recordID, _ := strconv.Atoi(c.Query("recordId"))
	var results []InspectionResult
	if recordID > 0 {
		DB.Where("record_id = ?", recordID).Order("collected_at desc").Find(&results)
	} else {
		DB.Where("collected_at >= ? AND collected_at < ?", start, end).Order("collected_at desc").Find(&results)
	}
	results = enrichResults(results)
	// 导出同样按当前告警规则重算，保证与页面/大屏口径一致
	results = rerouteAlerts(results, defaultAlertScopeResolver())

	recMap := map[uint]InspectionRecord{}
	var recIDs []uint
	for _, r := range results {
		recIDs = append(recIDs, r.RecordID)
	}
	if len(recIDs) > 0 {
		var recs []InspectionRecord
		DB.Where("id IN ?", recIDs).Find(&recs)
		for _, r := range recs {
			recMap[r.ID] = r
		}
	}

	// 列：基础列 + 按分类过滤的指标列
	metricCols := []MetricDef{}
	for _, g := range MetricGroups {
		if !containsStr(cats, g.Key) {
			continue
		}
		metricCols = append(metricCols, g.Metrics...)
	}

	rows := make([]gin.H, 0, len(results))
	alertRows := make([]gin.H, 0, len(results)*2)
	for _, r := range results {
		var data map[string]interface{}
		flat := resolveFlat(data)
		var alerts []map[string]interface{}
		rec := recMap[r.RecordID]
		row := gin.H{
			"巡检时间":    rec.RunAt.Format("2006-01-02 15:04"),
			"任务名称":    rec.TaskName,
			"ERP系统名称": r.AssetName,
			"归属部门":    r.Department,
			"虚拟机IPv4": r.IP,
			"状态":      map[string]string{"ok": "正常", "fail": "失败"}[r.Status],
			"采集来源":    map[string]string{SrcAnsible: "ansible", SrcSSH: "ssh", SrcSimulated: "模拟"}[r.Source],
			"告警项":     strings.Join(alertLabels(alerts), "、"),
		}
		for _, m := range metricCols {
			if v, ok := flat[m.Key]; ok {
				row[m.Label] = fmtVal(v, m.Unit)
			} else {
				row[m.Label] = ""
			}
		}
		rows = append(rows, row)

		for _, a := range alerts {
			alertRows = append(alertRows, gin.H{
				"ERP系统名称": r.AssetName,
				"归属部门":    r.Department,
				"虚拟机IPv4": r.IP,
				"分类":      CategoryLabel(categoryOfAlert(a)),
				"指标":      a["metric"],
				"级别":      map[string]string{"critical": "严重", "warning": "预警"}[a["level"].(string)],
				"数值":      fmt.Sprintf("%v", a["value"]),
				"说明":      a["note"],
				"开发人员":    r.Developer,
			})
		}
	}

	sumCpu, sumMem, sumDisk := 0.0, 0.0, 0.0
	var cnt int
	for _, r := range results {
		if r.Status != "ok" {
			continue
		}
		var data map[string]interface{}
		flat := resolveFlat(data)
		if v, ok := flat["cpu_usage"].(float64); ok {
			sumCpu += v
		}
		if v, ok := flat["mem_usage"].(float64); ok {
			sumMem += v
		}
		sumDisk += diskMaxUsage(flat)
		cnt++
	}
	avgCpu, avgMem, avgDisk := 0.0, 0.0, 0.0
	if cnt > 0 {
		avgCpu = round1(sumCpu / float64(cnt))
		avgMem = round1(sumMem / float64(cnt))
		avgDisk = round1(sumDisk / float64(cnt))
	}

	OK(c, gin.H{
		"period": period,
		"range":  gin.H{"start": start.Format("2006-01-02"), "end": end.Format("2006-01-02")},
		"rows":   rows,
		"alerts": alertRows,
		"summary": gin.H{
			"total":   len(results),
			"success": cnt,
			"avgCpu":  avgCpu,
			"avgMem":  avgMem,
			"avgDisk": avgDisk,
		},
	})
}

func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func alertLabels(alerts []map[string]interface{}) []string {
	out := []string{}
	for _, a := range alerts {
		out = append(out, formatAlertLabel(a))
	}
	return out
}

func fmtVal(v interface{}, unit string) string {
	switch t := v.(type) {
	case float64:
		s := strconv.FormatFloat(t, 'f', 1, 64)
		if unit != "" {
			return s + unit
		}
		return s
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case string:
		return t
	default:
		return ""
	}
}

// periodRange 计算周期起止时间
func periodRange(period string, ref time.Time) (time.Time, time.Time) {
	y, m, d := ref.Date()
	loc := ref.Location()
	switch period {
	case "day":
		start := time.Date(y, m, d, 0, 0, 0, 0, loc)
		return start, start.AddDate(0, 0, 1)
	case "week":
		wd := int(ref.Weekday())
		if wd == 0 {
			wd = 7
		}
		start := time.Date(y, m, d, 0, 0, 0, 0, loc).AddDate(0, 0, -(wd - 1))
		return start, start.AddDate(0, 0, 7)
	case "month":
		start := time.Date(y, m, 1, 0, 0, 0, 0, loc)
		return start, start.AddDate(0, 1, 0)
	case "quarter":
		q := (int(m)-1)/3*3 + 1
		start := time.Date(y, time.Month(q), 1, 0, 0, 0, 0, loc)
		return start, start.AddDate(0, 3, 0)
	case "year":
		start := time.Date(y, 1, 1, 0, 0, 0, 0, loc)
		return start, start.AddDate(1, 0, 0)
	default:
		start := time.Date(y, m, d, 0, 0, 0, 0, loc)
		return start, start.AddDate(0, 0, 1)
	}
}

// currentUserID 从上下文取当前用户 ID
func currentUserID(c *gin.Context) uint {
	if v, ok := c.Get("uid"); ok {
		if id, ok := v.(uint); ok {
			return id
		}
		if id, ok := v.(float64); ok {
			return uint(id)
		}
	}
	return 0
}
