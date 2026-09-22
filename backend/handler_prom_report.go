package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/datatypes"
)

// ============================================================================
// Prometheus 监控报表「报告记录」（v1.7.36）
//
// 需求：监控报表每次「生成报告」都要留档，能在「报告记录」里回看、重新导出。
//
// 设计取舍：
//   - **存的是报告数据（rows/trend/fleet/config），不是 xlsx 二进制**。
//     数据是冻结快照，回看时用同一套 Excel 产出口径重新生成即可，
//     既保证「≤5MB 降级策略」继续生效，又不会把 DB 塞满大字段。
//   - 明细行数有上限（promRecordMaxRows）：超宽集群只留水位最高的一批，
//     并以 rowsTruncated 标记告知前端，避免单条记录几 MB 拖慢列表。
//   - 归档动作放在「生成报告」里一次完成（构建一次聚合 → 落库 → 返回），
//     不额外再查一遍 Prometheus。
// ============================================================================

// 单条记录里最多存多少台主机明细 / 多少个趋势点
const (
	promRecordMaxRows  = 5000
	promRecordMaxTrend = 4000
)

// PromReportRecord 报表归档记录
type PromReportRecord struct {
	ID          uint           `gorm:"primaryKey" json:"id"`
	Title       string         `gorm:"size:128" json:"title"`
	DSID        uint           `gorm:"index" json:"dsId"`
	DSName      string         `gorm:"size:64" json:"dsName"`
	Period      string         `gorm:"size:16;index" json:"period"` // month | quarter | year
	PeriodCN    string         `gorm:"size:32" json:"periodCN"`     // 2026 年 09 月
	RefDate     string         `gorm:"size:16" json:"refDate"`      // 生成时选的基准日期
	Start       string         `gorm:"size:32" json:"start"`
	End         string         `gorm:"size:32" json:"end"`
	HostCount   int            `json:"hostCount"`
	Points      int            `json:"points"`
	Score       int            `json:"score"`
	Level       string         `gorm:"size:16" json:"level"`
	RiskHosts   int            `json:"riskHosts"`
	CritHosts   int            `json:"critHosts"`
	CPUAvg      float64        `json:"cpuAvg"`
	CPUMax      float64        `json:"cpuMax"`
	MemAvg      float64        `json:"memAvg"`
	MemMax      float64        `json:"memMax"`
	DiskAvg     float64        `json:"diskAvg"`
	DiskMax     float64        `json:"diskMax"`
	AlertHit    int            `json:"alertHit"`
	RowsTrunc   int            `json:"rowsTruncated"` // 1=明细被裁剪（超 promRecordMaxRows）
	Payload     datatypes.JSON `gorm:"type:text" json:"-"`
	Remark      string         `gorm:"size:255" json:"remark"`
	CreatedBy   uint           `json:"createdBy"`
	CreatedName string         `gorm:"size:64" json:"createdByName"`
	CreatedAt   time.Time      `json:"createdAt"`
}

// promReportPayload 归档的报告数据（冻结快照）
type promReportPayload struct {
	Rows   []promReportRow  `json:"rows"`
	Trend  []promTrendPoint `json:"trend"`
	Fleet  promReportFleet  `json:"fleet"`
	Config promCfgView      `json:"config"`
	Period string           `json:"period"`
	Points int              `json:"points"`
}

// promRecordDetail 记录详情（列表字段 + 归档数据）
type promRecordDetail struct {
	PromReportRecord
	Rows   []promReportRow  `json:"rows"`
	Trend  []promTrendPoint `json:"trend"`
	Fleet  promReportFleet  `json:"fleet"`
	Config promCfgView      `json:"config"`
}

// ---------------------------------------------------------------------------
// 风险判定 / 健康评分（与前端 utils/promReportExcel.ts 同一口径，改一处要改两边）
// ---------------------------------------------------------------------------

// promRowRisk 返回 高 / 中 / 正常
func promRowRisk(r promReportRow, cfg promCfgView) string {
	if r.CPUMax >= cfg.CPUCrit || r.MemMax >= cfg.MemCrit || r.DiskMax >= cfg.DiskCrit {
		return "高"
	}
	warn := cfg.CPUWarn
	if cfg.MemWarn < warn {
		warn = cfg.MemWarn
	}
	if cfg.DiskWarn < warn {
		warn = cfg.DiskWarn
	}
	m := r.CPUMax
	if r.MemMax > m {
		m = r.MemMax
	}
	if r.DiskMax > m {
		m = r.DiskMax
	}
	if m >= warn {
		return "中"
	}
	return "正常"
}

func promScoreLevel(score int) string {
	switch {
	case score >= 90:
		return "优秀"
	case score >= 80:
		return "良好"
	case score >= 70:
		return "一般"
	case score >= 60:
		return "需关注"
	default:
		return "需整改"
	}
}

// promHealthScore 比率口径（不用「告警条数直接扣分」，否则大集群必得 0 分）
func promHealthScore(rows []promReportRow, fleet promReportFleet, cfg promCfgView) (score int, level string, risk, crit int) {
	total := len(rows)
	if total == 0 {
		total = 1
	}
	for _, r := range rows {
		switch promRowRisk(r, cfg) {
		case "高":
			crit++
			risk++
		case "中":
			risk++
		}
	}
	water := (fleet.CPUAvg + fleet.MemAvg + fleet.DiskAvg) / 3
	riskRatio := float64(risk) / float64(total)
	critRatio := float64(crit) / float64(total)
	s := 100 - water*0.55 - riskRatio*100*0.3 - critRatio*100*0.15
	if s < 0 {
		s = 0
	}
	if s > 100 {
		s = 100
	}
	score = int(s + 0.5)
	return score, promScoreLevel(score), risk, crit
}

// ---------------------------------------------------------------------------
// 报表构建（GET /prom/report 与「生成并归档」共用，避免重复打 Prometheus）
// ---------------------------------------------------------------------------

// promBuildReport 对指定数据源跑一次报表聚合
func promBuildReport(ds *PromDataSource, period, ref string) (*promReportResp, error) {
	cli, err := newPromClient(ds)
	if err != nil {
		return nil, err
	}
	start, end, periodCN, step, rateWin, err := promReportWindow(period, ref)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), promHTTPTimeout*3)
	defer cancel()

	cpuSeries, errC := cli.queryRange(ctx, promQLCPU(rateWin), start.Unix(), end.Unix(), step)
	memSeries, errM := cli.queryRange(ctx, promQLMem, start.Unix(), end.Unix(), step)
	diskSeries, errD := cli.queryRange(ctx, promQLDisk, start.Unix(), end.Unix(), step)
	if errC != nil && errM != nil && errD != nil {
		return nil, fmt.Errorf("查询报表数据失败：%s", errC.Error())
	}

	hostnames := map[string]string{}
	unameSamples, _ := cli.query(ctx, promQLUname, "")
	for _, s := range unameSamples {
		inst := s.Metric["instance"]
		if hn := s.Metric["nodename"]; hn != "" && hostnames[inst] == "" {
			hostnames[inst] = hn
		}
	}
	upSamples, _ := cli.query(ctx, "up", "")
	instLabels := promCollectLabels(upSamples, unameSamples)

	rows := promAggregateRows(cpuSeries, memSeries, diskSeries, hostnames, instLabels)
	resp := &promReportResp{
		Period:    period,
		PeriodCN:  periodCN,
		Start:     start.Format("2006-01-02 15:04"),
		End:       end.Format("2006-01-02 15:04"),
		HostCount: len(rows),
		Rows:      rows,
		Config:    promLoadConfig().view(),
	}
	if len(cpuSeries) > 0 {
		resp.Points = len(cpuSeries[0].Values)
	}
	resp.Fleet = promFleetSummary(rows)
	resp.Trend = promTrendFromSeries(cpuSeries, memSeries, diskSeries)
	return resp, nil
}

// promResolveDSByID 按 id 取数据源（不存在/停用都报错）
func promResolveDSByID(id uint) (*PromDataSource, error) {
	if id == 0 {
		var first PromDataSource
		if err := DB.Where("enabled = 1").Order("id asc").First(&first).Error; err != nil {
			return nil, fmt.Errorf("没有可用的 Prometheus 数据源，请先在「数据源管理」添加")
		}
		return &first, nil
	}
	var ds PromDataSource
	if err := DB.Where("id = ?", id).First(&ds).Error; err != nil {
		return nil, fmt.Errorf("数据源不存在：%d", id)
	}
	if ds.Enabled != 1 {
		return nil, fmt.Errorf("数据源已停用：%s", ds.Name)
	}
	return &ds, nil
}

// promArchiveReport 把一次报表结果落库归档
func promArchiveReport(ds *PromDataSource, period, ref, title, remark string, uid uint, uname string, r *promReportResp) (*PromReportRecord, error) {
	cfg := r.Config
	score, level, risk, crit := promHealthScore(r.Rows, r.Fleet, cfg)

	rows := r.Rows
	trunc := 0
	if len(rows) > promRecordMaxRows {
		// rows 已按 CPU 峰值降序；超宽集群只留最需要关注的一批
		rows = rows[:promRecordMaxRows]
		trunc = 1
	}
	trend := r.Trend
	if len(trend) > promRecordMaxTrend {
		trend = trend[:promRecordMaxTrend]
	}
	payload := promReportPayload{Rows: rows, Trend: trend, Fleet: r.Fleet, Config: cfg, Period: r.Period, Points: r.Points}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("序列化报告数据失败：%v", err)
	}
	if title == "" {
		title = fmt.Sprintf("Prometheus监控报表_%s_%s", r.PeriodCN, time.Now().Format("20060102-1504"))
	}
	if len([]rune(title)) > 64 {
		title = string([]rune(title)[:64])
	}
	rec := &PromReportRecord{
		Title:       title,
		DSID:        ds.ID,
		DSName:      ds.Name,
		Period:      r.Period,
		PeriodCN:    r.PeriodCN,
		RefDate:     ref,
		Start:       r.Start,
		End:         r.End,
		HostCount:   r.HostCount,
		Points:      r.Points,
		Score:       score,
		Level:       level,
		RiskHosts:   risk,
		CritHosts:   crit,
		CPUAvg:      r.Fleet.CPUAvg,
		CPUMax:      r.Fleet.CPUMax,
		MemAvg:      r.Fleet.MemAvg,
		MemMax:      r.Fleet.MemMax,
		DiskAvg:     r.Fleet.DiskAvg,
		DiskMax:     r.Fleet.DiskMax,
		AlertHit:    r.Fleet.AlertHit,
		RowsTrunc:   trunc,
		Payload:     datatypes.JSON(raw),
		Remark:      remark,
		CreatedBy:   uid,
		CreatedName: uname,
		CreatedAt:   time.Now(),
	}
	if err := DB.Create(rec).Error; err != nil {
		return nil, fmt.Errorf("归档失败：%v", err)
	}
	return rec, nil
}

// promDecodePayload 归档数据 → 结构体（坏数据返回空，不让详情页 500）
func promDecodePayload(raw datatypes.JSON) promReportPayload {
	var p promReportPayload
	if len(raw) == 0 {
		return p
	}
	_ = json.Unmarshal([]byte(raw), &p)
	if p.Rows == nil {
		p.Rows = []promReportRow{}
	}
	if p.Trend == nil {
		p.Trend = []promTrendPoint{}
	}
	return p
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// PromGenerateReport POST /api/prom/reports/generate
//
// 生成报表的同时归档一条「报告记录」：一次聚合，两个用途（页面展示 + 留档）。
func PromGenerateReport(c *gin.Context) {
	var body struct {
		DS     uint   `json:"ds"`
		Period string `json:"period"`
		Ref    string `json:"ref"`
		Title  string `json:"title"`
		Remark string `json:"remark"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 1, "请求体不合法："+err.Error())
		return
	}
	period := strings.TrimSpace(body.Period)
	if period == "" {
		period = "month"
	}
	ds, err := promResolveDSByID(body.DS)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	rep, err := promBuildReport(ds, period, strings.TrimSpace(body.Ref))
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	rec, err := promArchiveReport(ds, period, strings.TrimSpace(body.Ref), strings.TrimSpace(body.Title),
		strings.TrimSpace(body.Remark), currentUserID(c), currentUserName(c), rep)
	if err != nil {
		// 归档失败不丢报告：页面照常展示，只是没留档
		OK(c, gin.H{"report": rep, "archived": false, "msg": "报告已生成，但归档失败：" + err.Error()})
		return
	}
	OK(c, gin.H{"report": rep, "archived": true, "id": rec.ID, "title": rec.Title, "msg": "已生成并归档到报告记录"})
}

// PromListReports GET /api/prom/reports?ds=&period=&kw=&page=&pageSize=
func PromListReports(c *gin.Context) {
	q := DB.Model(&PromReportRecord{})
	if v := strings.TrimSpace(c.Query("ds")); v != "" {
		if id, err := strconv.ParseUint(v, 10, 64); err == nil && id > 0 {
			q = q.Where("ds_id = ?", id)
		}
	}
	if v := strings.TrimSpace(c.Query("period")); v != "" {
		q = q.Where("period = ?", v)
	}
	if v := strings.TrimSpace(c.Query("kw")); v != "" {
		like := "%" + strings.ToLower(v) + "%"
		q = q.Where("LOWER(title) LIKE ? OR LOWER(ds_name) LIKE ? OR LOWER(COALESCE(remark,'')) LIKE ?", like, like, like)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 1, "统计报告记录失败："+err.Error())
		return
	}
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 200 {
		pageSize = 20
	}
	var list []PromReportRecord
	if err := q.Order("id desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&list).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 1, "查询报告记录失败："+err.Error())
		return
	}
	if list == nil {
		list = []PromReportRecord{}
	}
	OK(c, gin.H{"list": list, "total": total, "page": page, "pageSize": pageSize})
}

// PromGetReport GET /api/prom/reports/:id
func PromGetReport(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		Fail(c, http.StatusBadRequest, 1, "记录 id 不合法")
		return
	}
	var rec PromReportRecord
	if err := DB.Where("id = ?", id).First(&rec).Error; err != nil {
		Fail(c, http.StatusNotFound, 1, "报告记录不存在或已删除")
		return
	}
	p := promDecodePayload(rec.Payload)
	OK(c, promRecordDetail{PromReportRecord: rec, Rows: p.Rows, Trend: p.Trend, Fleet: p.Fleet, Config: p.Config})
}

// promReportUpdateBody 改标题 / 备注（两个字段都用指针：只传一个时另一个保持不变）
type promReportUpdateBody struct {
	Title  *string `json:"title"`
	Remark *string `json:"remark"`
}

// PromUpdateReport PUT /api/prom/reports/:id
func PromUpdateReport(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		Fail(c, http.StatusBadRequest, 1, "记录 id 不合法")
		return
	}
	var body promReportUpdateBody
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 1, "请求体不合法："+err.Error())
		return
	}
	var rec PromReportRecord
	if err := DB.Where("id = ?", id).First(&rec).Error; err != nil {
		Fail(c, http.StatusNotFound, 1, "报告记录不存在或已删除")
		return
	}
	if body.Title != nil {
		t := strings.TrimSpace(*body.Title)
		if t == "" {
			Fail(c, http.StatusBadRequest, 1, "标题不能为空")
			return
		}
		if len([]rune(t)) > 64 {
			t = string([]rune(t)[:64])
		}
		rec.Title = t
	}
	if body.Remark != nil {
		if len([]rune(*body.Remark)) > 255 {
			rec.Remark = string([]rune(*body.Remark)[:255])
		} else {
			rec.Remark = strings.TrimSpace(*body.Remark)
		}
	}
	if err := DB.Save(&rec).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 1, "保存失败："+err.Error())
		return
	}
	OK(c, gin.H{"msg": "已保存", "record": rec})
}

// PromDeleteReport DELETE /api/prom/reports/:id
func PromDeleteReport(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		Fail(c, http.StatusBadRequest, 1, "记录 id 不合法")
		return
	}
	if err := DB.Where("id = ?", id).Delete(&PromReportRecord{}).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 1, "删除失败："+err.Error())
		return
	}
	OK(c, gin.H{"msg": "已删除该报告记录"})
}

// currentUserName 从上下文取当前用户名（与 currentUserID 同源，记归档人用）
func currentUserName(c *gin.Context) string {
	if v, ok := c.Get("username"); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}
