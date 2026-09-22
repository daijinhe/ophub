package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// Prometheus 大屏 / 报表聚合（v1.8.0）
//
// 大屏（/api/prom/overview）：一次拉齐大屏所需全部数据（KPI、均值、24h 趋势、
// 主机实时资源、告警、TOP5），前端 30s 轮询这一个接口，避免大屏并发打爆数据源。
//
// 报表（/api/prom/report）：月度 / 季度 / 年度三档，把「每台主机的 CPU / 内存 /
// 磁盘」在时间窗内聚合出均值 / 峰值，全量返回，由前端生成 Excel（与巡检季度
// 报告同一套产出口径）。
// ============================================================================

// promHostStat 单台主机实时资源
type promHostStat struct {
	Instance   string  `json:"instance"`
	Hostname   string  `json:"hostname"`
	Department string  `json:"department"` // target label: department → 所属部门
	System     string  `json:"system"`     // target label: system → 项目名
	Env        string  `json:"env"`        // target label: env → 环境
	DeploySvr  string  `json:"deployserver"` // target label: deployserver → 业务环境
	Up         bool    `json:"up"`
	CPU        float64 `json:"cpu"`
	Mem        float64 `json:"mem"`
	Disk       float64 `json:"disk"`
}

// promUsageDist 资源健康分布（按主机 max(CPU,内存,磁盘) 分档；离线/无数据归 none）
type promUsageDist struct {
	Low  int `json:"low"`  // < 80 正常
	Mid  int `json:"mid"`  // 80 ~ 90 关注
	High int `json:"high"` // 90 ~ 95 预警
	Crit int `json:"crit"` // >= 95 严重
	None int `json:"none"` // 离线 / 无数据
}

// promInstLabels 实例业务标签（来自 Prometheus target labels）
type promInstLabels struct {
	Department string
	System     string
	Env        string
	DeploySvr  string
}

// promCollectLabels 从若干组样本的 metric 标签里抽取业务标签，按 instance 归并。
// node_exporter 的所有序列都带 target 注入的 department/system/env/deployserver 标签，
// up 与 node_uname_info 是最便宜的两路来源。
func promCollectLabels(sampleSets ...[]promSample) map[string]*promInstLabels {
	out := map[string]*promInstLabels{}
	for _, ss := range sampleSets {
		for _, s := range ss {
			inst := s.Metric["instance"]
			if inst == "" {
				continue
			}
			l := out[inst]
			if l == nil {
				l = &promInstLabels{}
				out[inst] = l
			}
			if l.Department == "" {
				l.Department = s.Metric["department"]
			}
			if l.System == "" {
				l.System = s.Metric["system"]
			}
			if l.Env == "" {
				l.Env = s.Metric["env"]
			}
			if l.DeploySvr == "" {
				l.DeploySvr = s.Metric["deployserver"]
			}
		}
	}
	return out
}

// promAlertItem 告警条目
type promAlertItem struct {
	Alertname   string `json:"alertname"`
	Instance    string `json:"instance"`
	Severity    string `json:"severity"`
	Description string `json:"description"`
}

// promTrendPoint 趋势点
type promTrendPoint struct {
	TS  int64    `json:"ts"` // unix 秒
	CPU *float64 `json:"cpu"`
	Mem *float64 `json:"mem"`
}

// promAvg 三个资源均值（大屏仪表盘）
type promAvg struct {
	CPU  float64 `json:"cpu"`
	Mem  float64 `json:"mem"`
	Disk float64 `json:"disk"`
}

// promTopEntry TOP5 条目
type promTopEntry struct {
	Instance   string  `json:"instance"`
	Hostname   string  `json:"hostname"`
	Department string  `json:"department"`
	System     string  `json:"system"`
	Env        string  `json:"env"`
	DeploySvr  string  `json:"deployserver"`
	Value      float64 `json:"value"`
}

// promOverviewResp 大屏聚合响应
type promOverviewResp struct {
	GeneratedAt string           `json:"generatedAt"`
	Up          promUpStat       `json:"up"`
	Avg         promAvg          `json:"avg"`
	UsageDist   promUsageDist    `json:"usageDist"`
	Trend       []promTrendPoint `json:"trend"`
	Hosts       []promHostStat   `json:"hosts"`
	Alerts      []promAlertItem  `json:"alerts"`
	AlertsTotal int              `json:"alertsTotal"`
	Top         promTopSets      `json:"top"`
}

type promUpStat struct {
	Total   int `json:"total"`
	Online  int `json:"online"`
	Offline int `json:"offline"`
}

type promTopSets struct {
	CPU  []promTopEntry `json:"cpu"`
	Mem  []promTopEntry `json:"mem"`
	Disk []promTopEntry `json:"disk"`
}

// promOverview GET /api/prom/overview?ds=
func PromOverview(c *gin.Context) {
	_, cli, err := resolvePromDS(c)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), promHTTPTimeout)
	defer cancel()

	out := promOverviewResp{GeneratedAt: time.Now().Format("2006-01-02 15:04:05")}

	// ---- 1. up（目标总数 / 在线 / 离线） ----
	upSamples, err := cli.query(ctx, "up", "")
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, "查询 up 失败："+err.Error())
		return
	}
	upMap := map[string]bool{}
	for _, s := range upSamples {
		inst := s.Metric["instance"]
		v, _ := sampleValue(s.Value)
		isUp := v > 0
		upMap[inst] = isUp
		if isUp {
			out.Up.Online++
		} else {
			out.Up.Offline++
		}
	}
	out.Up.Total = len(upSamples)

	// ---- 2. 主机名（node_uname_info：instance -> nodename） ----
	hostnames := map[string]string{}
	unameSamples, _ := cli.query(ctx, promQLUname, "")
	for _, s := range unameSamples {
		inst := s.Metric["instance"]
		if hn := s.Metric["nodename"]; hn != "" && hostnames[inst] == "" {
			hostnames[inst] = hn
		}
	}

	// ---- 2.5 业务标签（department/system/env/deployserver，target labels） ----
	instLabels := promCollectLabels(upSamples, unameSamples)

	// ---- 3. 实时资源（CPU / 内存 / 磁盘 per instance） ----
	cpuMap := promCurrentMap(ctx, cli, promQLCPU("5m"))
	memMap := promCurrentMap(ctx, cli, promQLMem)
	diskMap := promCurrentMap(ctx, cli, promQLDisk)

	// 汇总主机列表（以 up 的 instance 为全集，资源缺失记 0）
	hosts := make([]promHostStat, 0, len(upMap))
	seen := map[string]bool{}
	addHost := func(inst string) {
		if seen[inst] {
			return
		}
		seen[inst] = true
		lb := instLabels[inst]
		h := promHostStat{
			Instance: inst,
			Hostname: hostnames[inst],
			Up:       upMap[inst],
			CPU:      cpuMap[inst],
			Mem:      memMap[inst],
			Disk:     diskMap[inst],
		}
		if lb != nil {
			h.Department = lb.Department
			h.System = lb.System
			h.Env = lb.Env
			h.DeploySvr = lb.DeploySvr
		}
		hosts = append(hosts, h)
	}
	for inst := range upMap {
		addHost(inst)
	}
	for inst := range cpuMap {
		addHost(inst)
	}
	for inst := range memMap {
		addHost(inst)
	}
	for inst := range diskMap {
		addHost(inst)
	}
	sort.Slice(hosts, func(i, j int) bool { return hosts[i].Instance < hosts[j].Instance })
	out.Hosts = hosts

	// 资源均值（只统计在线且有值的）
	out.Avg = promAvgOf(hosts)

	// 资源健康分布（正常/关注/预警/严重/离线）
	out.UsageDist = promUsageDistOf(hosts)

	// ---- 4. 告警（firing） ----
	alertSamples, _ := cli.query(ctx, `ALERTS{alertstate="firing"}`, "")
	for _, s := range alertSamples {
		out.Alerts = append(out.Alerts, promAlertItem{
			Alertname:   s.Metric["alertname"],
			Instance:    s.Metric["instance"],
			Severity:    s.Metric["severity"],
			Description: s.Metric["description"],
		})
	}
	out.AlertsTotal = len(out.Alerts)

	// ---- 5. TOP5（CPU / 内存 / 磁盘） ----
	out.Top = promTopSets{
		CPU:  promTopN(hosts, instLabels, func(h promHostStat) float64 { return h.CPU }),
		Mem:  promTopN(hosts, instLabels, func(h promHostStat) float64 { return h.Mem }),
		Disk: promTopN(hosts, instLabels, func(h promHostStat) float64 { return h.Disk }),
	}

	// ---- 6. 24h 趋势（15m 步长，全集群均值） ----
	out.Trend = promFleetTrend(ctx, cli, 24*3600, 15*60)

	OK(c, out)
}

// promCurrentMap 即时查询 → instance -> 使用率
func promCurrentMap(ctx context.Context, cli *promClient, expr string) map[string]float64 {
	out := map[string]float64{}
	samples, err := cli.query(ctx, expr, "")
	if err != nil {
		return out
	}
	for _, s := range samples {
		if v, ok := sampleValue(s.Value); ok {
			out[s.Metric["instance"]] = v
		}
	}
	return out
}

// promAvgOf 在线主机资源均值
func promAvgOf(hosts []promHostStat) promAvg {
	var sc, sm, sd float64
	var nc, nm, nd int
	for _, h := range hosts {
		if !h.Up {
			continue
		}
		if h.CPU > 0 {
			sc += h.CPU
			nc++
		}
		if h.Mem > 0 {
			sm += h.Mem
			nm++
		}
		if h.Disk > 0 {
			sd += h.Disk
			nd++
		}
	}
	avg := promAvg{}
	if nc > 0 {
		avg.CPU = round1(sc / float64(nc))
	}
	if nm > 0 {
		avg.Mem = round1(sm / float64(nm))
	}
	if nd > 0 {
		avg.Disk = round1(sd / float64(nd))
	}
	return avg
}

// promUsageDistOf 资源健康分布：按主机 max(CPU,内存,磁盘) 分档
func promUsageDistOf(hosts []promHostStat) promUsageDist {
	d := promUsageDist{}
	for _, h := range hosts {
		m := h.CPU
		if h.Mem > m {
			m = h.Mem
		}
		if h.Disk > m {
			m = h.Disk
		}
		switch {
		case !h.Up || m <= 0:
			d.None++
		case m >= 95:
			d.Crit++
		case m >= 90:
			d.High++
		case m >= 80:
			d.Mid++
		default:
			d.Low++
		}
	}
	return d
}

// promTopN 按指定字段取前 5（过滤 0 值与离线）
func promTopN(hosts []promHostStat, labels map[string]*promInstLabels, pick func(promHostStat) float64) []promTopEntry {
	ups := make([]promHostStat, 0, len(hosts))
	for _, h := range hosts {
		if h.Up && pick(h) > 0 {
			ups = append(ups, h)
		}
	}
	sort.Slice(ups, func(i, j int) bool { return pick(ups[i]) > pick(ups[j]) })
	if len(ups) > 5 {
		ups = ups[:5]
	}
	out := make([]promTopEntry, 0, len(ups))
	for _, h := range ups {
		e := promTopEntry{
			Instance: h.Instance,
			Hostname: h.Hostname,
			Value:    round1(pick(h)),
		}
		if lb := labels[h.Instance]; lb != nil {
			e.Department = lb.Department
			e.System = lb.System
			e.Env = lb.Env
			e.DeploySvr = lb.DeploySvr
		}
		out = append(out, e)
	}
	return out
}

// promFleetTrend 全集群资源趋势：区间查询 → 每个时间点对所有 instance 取均值
func promFleetTrend(ctx context.Context, cli *promClient, window, step int64) []promTrendPoint {
	end := time.Now().Unix()
	start := end - window
	cpuSeries, err1 := cli.queryRange(ctx, promQLCPU("10m"), start, end, step)
	memSeries, err2 := cli.queryRange(ctx, promQLMem, start, end, step)
	if err1 != nil && err2 != nil {
		return []promTrendPoint{}
	}
	cpuByTs := promAvgByTs(cpuSeries)
	memByTs := promAvgByTs(memSeries)
	// 以 CPU 时间轴为基准对齐（内存可能缺点）
	out := make([]promTrendPoint, 0, len(cpuByTs))
	for ts, c := range cpuByTs {
		p := promTrendPoint{TS: ts, CPU: c}
		if m, ok := memByTs[ts]; ok {
			p.Mem = m
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TS < out[j].TS })
	return out
}

// promAvgByTs 矩阵序列 → 每个时间戳上所有 instance 的均值
func promAvgByTs(series []promSeries) map[int64]*float64 {
	sum := map[int64]float64{}
	cnt := map[int64]int{}
	for _, s := range series {
		for _, v := range s.Values {
			f, ok := sampleValue(v)
			if !ok || f <= 0 {
				continue
			}
			ts := sampleTS(v)
			sum[ts] += f
			cnt[ts]++
		}
	}
	out := make(map[int64]*float64, len(sum))
	for ts, s := range sum {
		if cnt[ts] > 0 {
			v := round1(s / float64(cnt[ts]))
			out[ts] = &v
		}
	}
	return out
}

// round1 复用 inspect.go 的同名函数（保留 1 位小数），此处不再重复定义。// ---------------------------------------------------------------------------
// 报表（月度 / 季度 / 年度）
// ---------------------------------------------------------------------------

// promReportRow 报表中的一台主机
type promReportRow struct {
	Instance   string  `json:"instance"`
	Hostname   string  `json:"hostname"`
	Department string  `json:"department"` // 所属部门
	System     string  `json:"system"`     // 项目名
	Env        string  `json:"env"`        // 环境
	DeploySvr  string  `json:"deployserver"` // 业务环境
	CPUAvg     float64 `json:"cpuAvg"`
	CPUMax     float64 `json:"cpuMax"`
	MemAvg     float64 `json:"memAvg"`
	MemMax     float64 `json:"memMax"`
	DiskAvg    float64 `json:"diskAvg"`
	DiskMax    float64 `json:"diskMax"`
}

// promReportResp 报表响应
type promReportResp struct {
	Period    string          `json:"period"` // month | quarter | year
	PeriodCN  string          `json:"periodCN"`
	Start     string          `json:"start"` // 展示用时间
	End       string          `json:"end"`
	Points    int             `json:"points"` // 聚合采样点数（每主机）
	HostCount int             `json:"hostCount"`
	Fleet     promReportFleet `json:"fleet"`
	Trend     []promTrendPoint `json:"trend"`
	Rows      []promReportRow `json:"rows"`
}

// promReportFleet 全集群峰值 / 均值
type promReportFleet struct {
	CPUAvg   float64 `json:"cpuAvg"`
	CPUMax   float64 `json:"cpuMax"`
	MemAvg   float64 `json:"memAvg"`
	MemMax   float64 `json:"memMax"`
	DiskAvg  float64 `json:"diskAvg"`
	DiskMax  float64 `json:"diskMax"`
	AlertHit int     `json:"alertHit"` // 窗口内出现过 CPU/内存/磁盘 峰值 ≥ 90 的主机数
}

// promReportWindow 计算报表时间窗：period + ref（YYYY-MM-DD，取该月/季/年）
func promReportWindow(period, ref string) (start, end time.Time, periodCN string, step int64, rateWin string, err error) {
	var base time.Time
	if ref == "" {
		base = time.Now()
	} else {
		var e error
		base, e = time.ParseInLocation("2006-01-02", ref[:10], time.Local)
		if e != nil {
			err = fmt.Errorf("日期不合法：%s（期望 YYYY-MM-DD）", ref)
			return
		}
	}
	y, m := base.Year(), int(base.Month())
	switch period {
	case "month":
		start = time.Date(y, time.Month(m), 1, 0, 0, 0, 0, time.Local)
		end = start.AddDate(0, 1, 0)
		periodCN = fmt.Sprintf("%d 年 %02d 月", y, m)
		step, rateWin = 3600, "2h"
	case "quarter":
		qm := (m-1)/3*3 + 1
		start = time.Date(y, time.Month(qm), 1, 0, 0, 0, 0, time.Local)
		end = start.AddDate(0, 3, 0)
		periodCN = fmt.Sprintf("%d 年 Q%d", y, (m-1)/3+1)
		step, rateWin = 3*3600, "6h"
	case "year":
		start = time.Date(y, 1, 1, 0, 0, 0, 0, time.Local)
		end = start.AddDate(1, 0, 0)
		periodCN = fmt.Sprintf("%d 年", y)
		step, rateWin = 12*3600, "24h"
	default:
		err = fmt.Errorf("period 不支持：%s（可选 month / quarter / year）", period)
	}
	// end 不能超过当前时间（本月/本季/今年还没过完就取到现在）
	if end.After(time.Now()) {
		end = time.Now()
	}
	return
}

// PromReport GET /api/prom/report?ds=&period=month|quarter|year&ref=2026-09-15
func PromReport(c *gin.Context) {
	_, cli, err := resolvePromDS(c)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	period := strings.TrimSpace(c.DefaultQuery("period", "month"))
	start, end, periodCN, step, rateWin, err := promReportWindow(period, c.Query("ref"))
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), promHTTPTimeout*2)
	defer cancel()

	// 三组区间查询（CPU / 内存 / 磁盘）
	cpuSeries, errC := cli.queryRange(ctx, promQLCPU(rateWin), start.Unix(), end.Unix(), step)
	memSeries, errM := cli.queryRange(ctx, promQLMem, start.Unix(), end.Unix(), step)
	diskSeries, errD := cli.queryRange(ctx, promQLDisk, start.Unix(), end.Unix(), step)
	if errC != nil && errM != nil && errD != nil {
		Fail(c, http.StatusBadRequest, 1, "查询报表数据失败："+errC.Error())
		return
	}

	// 主机名
	hostnames := map[string]string{}
	unameSamples, _ := cli.query(ctx, promQLUname, "")
	for _, s := range unameSamples {
		inst := s.Metric["instance"]
		if hn := s.Metric["nodename"]; hn != "" && hostnames[inst] == "" {
			hostnames[inst] = hn
		}
	}

	// 业务标签（department/system/env/deployserver）：up 最便宜且覆盖全部 target
	upSamples, _ := cli.query(ctx, "up", "")
	instLabels := promCollectLabels(upSamples, unameSamples)

	rows := promAggregateRows(cpuSeries, memSeries, diskSeries, hostnames, instLabels)
	resp := promReportResp{
		Period:   period,
		PeriodCN: periodCN,
		Start:    start.Format("2006-01-02 15:04"),
		End:      end.Format("2006-01-02 15:04"),
		HostCount: len(rows),
		Rows:     rows,
	}
	if len(cpuSeries) > 0 {
		resp.Points = len(cpuSeries[0].Values)
	}

	// 全集群汇总 + 趋势（窗口内全集群均值线）
	resp.Fleet = promFleetSummary(rows)
	resp.Trend = promTrendFromSeries(cpuSeries, memSeries)

	OK(c, resp)
}

// promAggregateRows 三组矩阵序列 → 每主机均值/峰值（按 CPU 峰值降序）
func promAggregateRows(cpu, mem, disk []promSeries, hostnames map[string]string, labels map[string]*promInstLabels) []promReportRow {
	cpuAgg := promPerInstanceAgg(cpu)
	memAgg := promPerInstanceAgg(mem)
	diskAgg := promPerInstanceAgg(disk)
	instSet := map[string]bool{}
	for inst := range cpuAgg {
		instSet[inst] = true
	}
	for inst := range memAgg {
		instSet[inst] = true
	}
	for inst := range diskAgg {
		instSet[inst] = true
	}
	rows := make([]promReportRow, 0, len(instSet))
	for inst := range instSet {
		r := promReportRow{Instance: inst, Hostname: hostnames[inst]}
		if lb := labels[inst]; lb != nil {
			r.Department = lb.Department
			r.System = lb.System
			r.Env = lb.Env
			r.DeploySvr = lb.DeploySvr
		}
		if a := cpuAgg[inst]; a != nil {
			r.CPUAvg, r.CPUMax = round1(a.avg), round1(a.max)
		}
		if a := memAgg[inst]; a != nil {
			r.MemAvg, r.MemMax = round1(a.avg), round1(a.max)
		}
		if a := diskAgg[inst]; a != nil {
			r.DiskAvg, r.DiskMax = round1(a.avg), round1(a.max)
		}
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].CPUMax > rows[j].CPUMax })
	return rows
}

// promAgg 单指标聚合值
type promAgg struct {
	avg, max float64
}

// promPerInstanceAgg 单组矩阵序列 → per instance {avg,max}
func promPerInstanceAgg(series []promSeries) map[string]*promAgg {
	sum := map[string]float64{}
	cnt := map[string]int{}
	max := map[string]float64{}
	for _, s := range series {
		inst := s.Metric["instance"]
		for _, v := range s.Values {
			f, ok := sampleValue(v)
			if !ok || f < 0 {
				continue
			}
			sum[inst] += f
			cnt[inst]++
			if f > max[inst] {
				max[inst] = f
			}
		}
	}
	out := map[string]*promAgg{}
	for inst := range sum {
		if cnt[inst] > 0 {
			out[inst] = &promAgg{avg: sum[inst] / float64(cnt[inst]), max: max[inst]}
		}
	}
	return out
}

// promFleetSummary 全集群汇总
func promFleetSummary(rows []promReportRow) promReportFleet {
	f := promReportFleet{}
	var nc, nm, nd int
	var sc, sm, sd float64
	for _, r := range rows {
		if r.CPUMax > 0 {
			sc += r.CPUAvg
			nc++
			if r.CPUMax > f.CPUMax {
				f.CPUMax = r.CPUMax
			}
		}
		if r.MemMax > 0 {
			sm += r.MemAvg
			nm++
			if r.MemMax > f.MemMax {
				f.MemMax = r.MemMax
			}
		}
		if r.DiskMax > 0 {
			sd += r.DiskAvg
			nd++
			if r.DiskMax > f.DiskMax {
				f.DiskMax = r.DiskMax
			}
		}
		if r.CPUMax >= 90 || r.MemMax >= 90 || r.DiskMax >= 90 {
			f.AlertHit++
		}
	}
	if nc > 0 {
		f.CPUAvg = round1(sc / float64(nc))
	}
	if nm > 0 {
		f.MemAvg = round1(sm / float64(nm))
	}
	if nd > 0 {
		f.DiskAvg = round1(sd / float64(nd))
	}
	return f
}

// promTrendFromSeries 报表趋势：CPU / 内存两组序列按时间戳取全集群均值
func promTrendFromSeries(cpu, mem []promSeries) []promTrendPoint {
	cpuByTs := promAvgByTs(cpu)
	memByTs := promAvgByTs(mem)
	out := make([]promTrendPoint, 0, len(cpuByTs))
	for ts, c := range cpuByTs {
		p := promTrendPoint{TS: ts, CPU: c}
		if m, ok := memByTs[ts]; ok {
			p.Mem = m
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TS < out[j].TS })
	return out
}
