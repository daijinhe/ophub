package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/datatypes"
)

// ============================================================================
// Prometheus 监控大屏「配置管理 + 定期采集」（v1.7.33）
//
// 背景：真实 Prometheus 动辄上千 target，一次全量聚合要十几秒 —— 大屏不可能
// 每次刷新都现查。所以改成「服务端定时采集 → 快照缓存 → 大屏读快照」：
//   - 后台单 goroutine 按配置间隔（10s ~ 30min）串行采集所有启用数据源；
//   - 采集结果同时进内存快照（大屏秒开）与 PromScreenSnapshot 表（重启不丢最近一次）；
//   - 支持手动触发（POST /api/prom/collect），采集完立即同步到大屏；
//   - 采集失败保留上一次成功快照，并在快照里带上失败原因，大屏顶栏可见。
//
// 阈值（CPU/内存/磁盘 关注/严重）由「大屏管理」页面配置，落 PromScreenConfig，
// 采集时按阈值生成「超阈值主机」清单（替代没有数据的 ALERTS 面板）。
// ============================================================================

// ---------------------------------------------------------------------------
// 配置模型
// ---------------------------------------------------------------------------

// promMaskRule 屏蔽规则（v1.7.35）：命中规则的主机+指标不再进入大屏「超阈值主机」面板。
// 用于屏蔽「已知但暂不处理」的超阈值项（如磁盘长期偏高的备份机），让面板只留真正要关注的主机。
type promMaskRule struct {
	Target string `json:"target"` // 匹配串：对 instance（IP:端口）与展示名做「包含」匹配，不区分大小写
	Metric string `json:"metric"` // all | cpu | mem | disk | offline
	Note   string `json:"note,omitempty"`
}

// promParseMasks 落库 JSON → 规则数组（坏数据一律静默降级成空数组，不让大屏挂掉）
func promParseMasks(raw datatypes.JSON) []promMaskRule {
	out := []promMaskRule{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

// promMasksToJSON 规则数组 → 落库 JSON（nil 也归一成 "[]"，避免库里出现 null）
func promMasksToJSON(rules []promMaskRule) datatypes.JSON {
	if rules == nil {
		rules = []promMaskRule{}
	}
	b, err := json.Marshal(rules)
	if err != nil {
		return datatypes.JSON("[]")
	}
	return datatypes.JSON(b)
}

// PromScreenConfig 监控大屏配置（全局单例，id=1）
type PromScreenConfig struct {
	ID          uint           `gorm:"primaryKey" json:"id"`
	Title       string         `gorm:"size:64" json:"title"`   // 大屏标题
	AutoCollect int            `json:"autoCollect"`            // 1=开启定期采集
	IntervalSec int            `json:"intervalSec"`            // 采集间隔（秒）
	CPUWarn     float64        `json:"cpuWarn"`                // CPU 关注阈值
	CPUCrit     float64        `json:"cpuCrit"`                // CPU 严重阈值
	MemWarn     float64        `json:"memWarn"`                // 内存 关注阈值
	MemCrit     float64        `json:"memCrit"`                // 内存 严重阈值
	DiskWarn    float64        `json:"diskWarn"`               // 磁盘 关注阈值
	DiskCrit    float64        `json:"diskCrit"`               // 磁盘 严重阈值
	TopN        int            `json:"topN"`                   // TOP N
	HostLimit   int            `json:"hostLimit"`              // 大屏主机列表最多展示多少台
	ShowOffline int            `json:"showOffline"`            // 1=展示离线主机
	TrendHours  int            `json:"trendHours"`             // 趋势窗口（小时）
	GroupBy     string         `gorm:"size:16" json:"groupBy"` // 分组维度：system|department|env|deployserver
	Masks       datatypes.JSON `gorm:"type:text" json:"masks"` // 屏蔽规则（超阈值面板过滤，v1.7.35）
	Remark      string         `gorm:"size:255" json:"remark"`
	UpdatedAt   time.Time      `json:"updatedAt"`
}

// PromScreenSnapshot 最近一次采集快照落库（重启后可立即恢复大屏，不必等下一轮）
type PromScreenSnapshot struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	DSID      uint      `gorm:"index" json:"dsId"`
	DSName    string    `gorm:"size:64" json:"dsName"`
	Payload   string    `gorm:"type:text" json:"-"` // promOverviewResp 的 JSON
	Generated string    `gorm:"size:32" json:"generated"`
	CreatedAt time.Time `json:"createdAt"`
}

// promCfgView 下发给大屏的配置（只读视图，不含落库字段）
type promCfgView struct {
	Title       string         `json:"title"`
	AutoCollect int            `json:"autoCollect"`
	IntervalSec int            `json:"intervalSec"`
	CPUWarn     float64        `json:"cpuWarn"`
	CPUCrit     float64        `json:"cpuCrit"`
	MemWarn     float64        `json:"memWarn"`
	MemCrit     float64        `json:"memCrit"`
	DiskWarn    float64        `json:"diskWarn"`
	DiskCrit    float64        `json:"diskCrit"`
	TopN        int            `json:"topN"`
	HostLimit   int            `json:"hostLimit"`
	ShowOffline int            `json:"showOffline"`
	TrendHours  int            `json:"trendHours"`
	GroupBy     string         `json:"groupBy"`
	Masks       []promMaskRule `json:"masks"`
}

// promIssue 超阈值条目（平台自算，不依赖 Prometheus 的 ALERTS）
type promIssue struct {
	Instance   string  `json:"instance"`
	Name       string  `json:"name"`
	Department string  `json:"department"`
	System     string  `json:"system"`
	Env        string  `json:"env"`
	DeploySvr  string  `json:"deployserver"`
	Metric     string  `json:"metric"`   // cpu | mem | disk | offline
	MetricCN   string  `json:"metricCN"` // CPU | 内存 | 磁盘 | 连通性
	Value      float64 `json:"value"`
	Level      string  `json:"level"`   // crit | warn
	LevelCN    string  `json:"levelCN"` // 严重 | 关注
}

// promIssueStat 超阈值统计
type promIssueStat struct {
	Crit  int `json:"crit"`
	Warn  int `json:"warn"`
	Hosts int `json:"hosts"` // 涉及主机数
}

// promGroupStat 按业务维度分组的资源水位（大屏「项目水位 TOP」面板）
type promGroupStat struct {
	Key       string  `json:"key"`
	Hosts     int     `json:"hosts"`
	Online    int     `json:"online"`
	CPUAvg    float64 `json:"cpuAvg"`
	MemAvg    float64 `json:"memAvg"`
	DiskAvg   float64 `json:"diskAvg"`
	MaxVal    float64 `json:"maxVal"`
	RiskHosts int     `json:"riskHosts"`
}

// promDefaultConfig 出厂默认值
func promDefaultConfig() *PromScreenConfig {
	return &PromScreenConfig{
		ID:          1,
		Title:       "Prometheus 监控大屏",
		AutoCollect: 1,
		IntervalSec: 60,
		CPUWarn:     80,
		CPUCrit:     90,
		MemWarn:     85,
		MemCrit:     95,
		DiskWarn:    85,
		DiskCrit:    95,
		TopN:        5,
		HostLimit:   200,
		ShowOffline: 1,
		TrendHours:  24,
		GroupBy:     "system",
	}
}

func (c *PromScreenConfig) view() promCfgView {
	return promCfgView{
		Title:       c.Title,
		AutoCollect: c.AutoCollect,
		IntervalSec: c.IntervalSec,
		CPUWarn:     c.CPUWarn,
		CPUCrit:     c.CPUCrit,
		MemWarn:     c.MemWarn,
		MemCrit:     c.MemCrit,
		DiskWarn:    c.DiskWarn,
		DiskCrit:    c.DiskCrit,
		TopN:        c.TopN,
		HostLimit:   c.HostLimit,
		ShowOffline: c.ShowOffline,
		TrendHours:  c.TrendHours,
		GroupBy:     c.GroupBy,
		Masks:       promParseMasks(c.Masks),
	}
}

// promNormalizeConfig 兜底修正非法值（手动改库 / 老数据升级都可能产生）
func promNormalizeConfig(c *PromScreenConfig) {
	d := promDefaultConfig()
	if strings.TrimSpace(c.Title) == "" {
		c.Title = d.Title
	}
	if len([]rune(c.Title)) > 32 {
		c.Title = string([]rune(c.Title)[:32])
	}
	if c.IntervalSec < 10 {
		c.IntervalSec = 10
	}
	if c.IntervalSec > 3600 {
		c.IntervalSec = 3600
	}
	if c.CPUWarn <= 0 {
		c.CPUWarn = d.CPUWarn
	}
	if c.MemWarn <= 0 {
		c.MemWarn = d.MemWarn
	}
	if c.DiskWarn <= 0 {
		c.DiskWarn = d.DiskWarn
	}
	// 严重阈值必须高于关注阈值，否则面板自相矛盾
	if c.CPUCrit <= c.CPUWarn {
		c.CPUCrit = c.CPUWarn + 10
	}
	if c.MemCrit <= c.MemWarn {
		c.MemCrit = c.MemWarn + 10
	}
	if c.DiskCrit <= c.DiskWarn {
		c.DiskCrit = c.DiskWarn + 10
	}
	for _, f := range []*float64{&c.CPUWarn, &c.CPUCrit, &c.MemWarn, &c.MemCrit, &c.DiskWarn, &c.DiskCrit} {
		if *f > 100 {
			*f = 100
		}
	}
	if c.TopN < 3 {
		c.TopN = 3
	}
	if c.TopN > 20 {
		c.TopN = 20
	}
	if c.HostLimit < 20 {
		c.HostLimit = 20
	}
	if c.HostLimit > 5000 {
		c.HostLimit = 5000
	}
	if c.TrendHours < 1 {
		c.TrendHours = 1
	}
	if c.TrendHours > 720 {
		c.TrendHours = 720
	}
	switch c.GroupBy {
	case "system", "department", "env", "deployserver":
	default:
		c.GroupBy = "system"
	}
	if c.AutoCollect != 0 {
		c.AutoCollect = 1
	}
	if c.ShowOffline != 0 {
		c.ShowOffline = 1
	}
	// 屏蔽规则清洗：去空 target、metric 归一到白名单、条数上限 200
	if rules := promParseMasks(c.Masks); len(rules) > 0 {
		clean := make([]promMaskRule, 0, len(rules))
		for _, r := range rules {
			r.Target = strings.TrimSpace(r.Target)
			r.Note = strings.TrimSpace(r.Note)
			switch r.Metric {
			case "cpu", "mem", "disk", "offline":
			default:
				r.Metric = "all"
			}
			if r.Target == "" {
				continue
			}
			clean = append(clean, r)
			if len(clean) >= 200 {
				break
			}
		}
		c.Masks = promMasksToJSON(clean)
	} else {
		c.Masks = datatypes.JSON("[]")
	}
}

// promMasked 判断 (主机, 指标) 是否被屏蔽规则命中：
// target 对 instance（IP:端口）与展示名做「包含」匹配，不区分大小写。
// metric = all 表示该主机的所有指标（含离线连通性）都屏蔽。
func promMasked(cfg *PromScreenConfig, metric, instance, name string) bool {
	rules := promParseMasks(cfg.Masks)
	if len(rules) == 0 {
		return false
	}
	inst := strings.ToLower(instance)
	nm := strings.ToLower(name)
	for _, r := range rules {
		if r.Metric != "all" && r.Metric != metric {
			continue
		}
		t := strings.ToLower(strings.TrimSpace(r.Target))
		if t == "" {
			continue
		}
		if strings.Contains(inst, t) || strings.Contains(nm, t) {
			return true
		}
	}
	return false
}

var (
	promCfgMu    sync.RWMutex
	promCfgCache *PromScreenConfig
)

// promLoadConfig 读配置（保证 id=1 存在；非法值就地修正后回写）
func promLoadConfig() *PromScreenConfig {
	promCfgMu.Lock()
	defer promCfgMu.Unlock()
	if promCfgCache != nil {
		cp := *promCfgCache
		return &cp
	}
	var c PromScreenConfig
	if err := DB.Where("id = 1").First(&c).Error; err != nil {
		c = *promDefaultConfig()
		_ = DB.Create(&c)
	} else {
		promNormalizeConfig(&c)
	}
	promCfgCache = &c
	cp := c
	return &cp
}

// promSaveConfig 保存配置并刷新内存缓存（采集循环下一轮自动生效）
func promSaveConfig(c *PromScreenConfig) error {
	promNormalizeConfig(c)
	c.ID = 1
	c.UpdatedAt = time.Now()
	if err := DB.Save(c).Error; err != nil {
		return err
	}
	promCfgMu.Lock()
	cp := *c
	promCfgCache = &cp
	promCfgMu.Unlock()
	return nil
}

// promInvalidateCfgCache 外部改库后调用（如导入恢复）
func promInvalidateCfgCache() {
	promCfgMu.Lock()
	promCfgCache = nil
	promCfgMu.Unlock()
}

// ---------------------------------------------------------------------------
// 阈值派生：超阈值清单 + 分组水位
// ---------------------------------------------------------------------------

// promHostName 主机展示名：项目名_环境_业务环境（v1.7.33 起不再拼接 IP，IP 在副行展示）
func promHostName(system, env, deploySvr, instance, hostname string) string {
	parts := make([]string, 0, 3)
	for _, x := range []string{system, env, deploySvr} {
		if strings.TrimSpace(x) != "" {
			parts = append(parts, strings.TrimSpace(x))
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, "_")
	}
	if strings.TrimSpace(hostname) != "" {
		return hostname
	}
	return instance
}

// promBuildIssues 按阈值生成超阈值清单（离线单列为「连通性」严重项）。
// v1.7.35：先过屏蔽规则 —— 命中的 (主机, 指标) 不进清单也不计入统计。
func promBuildIssues(hosts []promHostStat, cfg *PromScreenConfig, limit int) ([]promIssue, promIssueStat) {
	type item struct {
		iss  promIssue
		rank float64 // 排序权重：严重优先，其次数值大优先
	}
	items := make([]item, 0, len(hosts))
	hostSet := map[string]bool{}
	for _, h := range hosts {
		name := promHostName(h.System, h.Env, h.DeploySvr, h.Instance, h.Hostname)
		base := promIssue{
			Instance:   h.Instance,
			Name:       name,
			Department: h.Department,
			System:     h.System,
			Env:        h.Env,
			DeploySvr:  h.DeploySvr,
		}
		if !h.Up {
			if promMasked(cfg, "offline", h.Instance, name) {
				continue
			}
			iss := base
			iss.Metric, iss.MetricCN = "offline", "连通性"
			iss.Level, iss.LevelCN = "crit", "严重"
			iss.Value = 100
			items = append(items, item{iss: iss, rank: 1000})
			hostSet[h.Instance] = true
			continue
		}
		push := func(metric, cn string, v, warn, crit float64) {
			if v < warn {
				return
			}
			if promMasked(cfg, metric, h.Instance, name) {
				return
			}
			iss := base
			iss.Metric, iss.MetricCN = metric, cn
			iss.Value = round1(v)
			if v >= crit {
				iss.Level, iss.LevelCN = "crit", "严重"
			} else {
				iss.Level, iss.LevelCN = "warn", "关注"
			}
			rank := v
			if iss.Level == "crit" {
				rank += 100
			}
			items = append(items, item{iss: iss, rank: rank})
			hostSet[h.Instance] = true
		}
		push("cpu", "CPU", h.CPU, cfg.CPUWarn, cfg.CPUCrit)
		push("mem", "内存", h.Mem, cfg.MemWarn, cfg.MemCrit)
		push("disk", "磁盘", h.Disk, cfg.DiskWarn, cfg.DiskCrit)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].rank > items[j].rank })
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	out := make([]promIssue, 0, len(items))
	st := promIssueStat{Hosts: len(hostSet)}
	for _, it := range items {
		out = append(out, it.iss)
		if it.iss.Level == "crit" {
			st.Crit++
		} else {
			st.Warn++
		}
	}
	return out, st
}

// promBuildGroups 按配置维度聚合分组水位（大屏「项目水位 TOP」）
func promBuildGroups(hosts []promHostStat, cfg *PromScreenConfig, limit int) []promGroupStat {
	m := map[string]*promGroupStatAcc{}
	order := []string{}
	keyOf := func(h promHostStat) string {
		switch cfg.GroupBy {
		case "department":
			return h.Department
		case "env":
			return h.Env
		case "deployserver":
			return h.DeploySvr
		default:
			return h.System
		}
	}
	for _, h := range hosts {
		k := strings.TrimSpace(keyOf(h))
		if k == "" {
			k = "未分组"
		}
		a := m[k]
		if a == nil {
			a = &promGroupStatAcc{}
			m[k] = a
			order = append(order, k)
		}
		a.hosts++
		if h.Up {
			a.online++
			if h.CPU > 0 {
				a.sc += h.CPU
				a.nc++
			}
			if h.Mem > 0 {
				a.sm += h.Mem
				a.nm++
			}
			if h.Disk > 0 {
				a.sd += h.Disk
				a.nd++
			}
			mx := h.CPU
			if h.Mem > mx {
				mx = h.Mem
			}
			if h.Disk > mx {
				mx = h.Disk
			}
			if mx > a.maxVal {
				a.maxVal = mx
			}
			if (h.CPU > 0 && h.CPU >= cfg.CPUCrit) || (h.Mem > 0 && h.Mem >= cfg.MemCrit) || (h.Disk > 0 && h.Disk >= cfg.DiskCrit) {
				a.risk++
			}
		}
	}
	out := make([]promGroupStat, 0, len(order))
	for _, k := range order {
		a := m[k]
		g := promGroupStat{Key: k, Hosts: a.hosts, Online: a.online, MaxVal: round1(a.maxVal), RiskHosts: a.risk}
		if a.nc > 0 {
			g.CPUAvg = round1(a.sc / float64(a.nc))
		}
		if a.nm > 0 {
			g.MemAvg = round1(a.sm / float64(a.nm))
		}
		if a.nd > 0 {
			g.DiskAvg = round1(a.sd / float64(a.nd))
		}
		out = append(out, g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].MaxVal != out[j].MaxVal {
			return out[i].MaxVal > out[j].MaxVal
		}
		return out[i].Hosts > out[j].Hosts
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// promGroupStatAcc 分组累计（内部结构）
type promGroupStatAcc struct {
	hosts, online, risk int
	sc, sm, sd          float64
	nc, nm, nd          int
	maxVal              float64
}

// ---------------------------------------------------------------------------
// 采集（同步 / 异步 + 快照缓存）
// ---------------------------------------------------------------------------

var (
	promSnapMu      sync.RWMutex
	promSnaps       = map[uint]*promOverviewResp{}
	promSnapErrs    = map[uint]string{}
	promCollectBusy = map[uint]bool{}
	promNextAt      = map[uint]int64{}
	promLastSource  = map[uint]string{}
	promCollectMu   sync.Mutex
)

// promCollectTimeout 单次采集总超时（大屏手动触发时也不能无限等）
const promCollectTimeout = 120 * time.Second

// promCollectSync 同步采集一次：拿到快照写缓存 + 落库。并发安全（同数据源防重入）。
func promCollectSync(dsID uint, source string) (*promOverviewResp, error) {
	promCollectMu.Lock()
	if promCollectBusy[dsID] {
		promCollectMu.Unlock()
		return nil, fmt.Errorf("该数据源正在采集中，请稍候再试")
	}
	promCollectBusy[dsID] = true
	promCollectMu.Unlock()
	defer func() {
		promCollectMu.Lock()
		promCollectBusy[dsID] = false
		promCollectMu.Unlock()
	}()

	var ds PromDataSource
	if err := DB.Where("id = ?", dsID).First(&ds).Error; err != nil {
		return nil, fmt.Errorf("数据源不存在：%d", dsID)
	}
	if ds.Enabled != 1 {
		return nil, fmt.Errorf("数据源已停用：%s", ds.Name)
	}
	cli, err := newPromClient(&ds)
	if err != nil {
		return nil, err
	}
	cfg := promLoadConfig()
	ctx, cancel := context.WithTimeout(context.Background(), promCollectTimeout)
	defer cancel()

	started := time.Now()
	out, err := buildPromSnapshot(ctx, cli, ds.Name, cfg, source)
	if err != nil {
		// 失败保留上一次成功快照，只更新错误原因
		promSnapMu.Lock()
		promSnapErrs[dsID] = err.Error()
		promSnapMu.Unlock()
		return nil, err
	}
	out.CollectMs = time.Since(started).Milliseconds()

	promSnapMu.Lock()
	promSnaps[dsID] = out
	promSnapErrs[dsID] = ""
	promLastSource[dsID] = source
	promSnapMu.Unlock()

	// 落库（失败不影响内存快照）
	go promPersistSnapshot(dsID, ds.Name, out)
	return out, nil
}

// promPersistSnapshot 每个数据源只保留最近一条快照
func promPersistSnapshot(dsID uint, dsName string, s *promOverviewResp) {
	b, err := jsonMarshalSnapshot(s)
	if err != nil {
		return
	}
	var old PromScreenSnapshot
	if err := DB.Where("ds_id = ?", dsID).Order("id desc").First(&old).Error; err == nil {
		old.Payload = b
		old.Generated = s.GeneratedAt
		old.CreatedAt = time.Now()
		_ = DB.Save(&old)
		return
	}
	_ = DB.Create(&PromScreenSnapshot{DSID: dsID, DSName: dsName, Payload: b, Generated: s.GeneratedAt, CreatedAt: time.Now()})
}

// promRestoreSnapshots 启动时把落库快照读回内存（避免刚重启大屏空白）
func promRestoreSnapshots() {
	var list []PromScreenSnapshot
	if err := DB.Find(&list).Error; err != nil {
		return
	}
	for _, it := range list {
		if it.Payload == "" {
			continue
		}
		s, err := jsonUnmarshalSnapshot(it.Payload)
		if err != nil || s == nil {
			continue
		}
		promSnapMu.Lock()
		promSnaps[it.DSID] = s
		promLastSource[it.DSID] = "restore"
		promSnapMu.Unlock()
	}
}

func promSnapshotOf(dsID uint) (*promOverviewResp, string, bool) {
	promSnapMu.RLock()
	defer promSnapMu.RUnlock()
	return promSnaps[dsID], promSnapErrs[dsID], promCollectBusy[dsID]
}

// promCollectAsync 后台异步采集（自动循环用，失败只记原因不返回）
func promCollectAsync(dsID uint, source string) {
	go func() {
		_, _ = promCollectSync(dsID, source)
	}()
}

// promStartCollector 启动定期采集循环（main 里调用一次）
//
// 循环按 1 秒粒度推进而不是「睡满整个间隔」：改了采集间隔后最多 1 秒就生效
// （睡满整轮的话，把 30 分钟改成 10 秒要等半小时才生效）。
func promStartCollector() {
	promRestoreSnapshots()
	go func() {
		var next time.Time // 零值 → 启动即采一轮
		for {
			cfg := promLoadConfig()
			iv := cfg.IntervalSec
			if iv < 10 {
				iv = 10
			}
			now := time.Now()
			// 间隔被调小 → 把下一轮提前，避免继续按旧的大间隔等待
			if next.After(now.Add(time.Duration(iv) * time.Second)) {
				next = now.Add(time.Duration(iv) * time.Second)
			}
			if cfg.AutoCollect == 1 && !now.Before(next) {
				nextUnix := now.Add(time.Duration(iv) * time.Second).Unix()
				var list []PromDataSource
				if err := DB.Where("enabled = 1").Order("id asc").Find(&list).Error; err == nil {
					for i := range list {
						promCollectMu.Lock()
						promNextAt[list[i].ID] = nextUnix
						promCollectMu.Unlock()
						promCollectAsync(list[i].ID, "auto")
					}
				}
				next = now.Add(time.Duration(iv) * time.Second)
			}
			time.Sleep(time.Second)
		}
	}()
}

// ---------------------------------------------------------------------------
// 快照序列化（落库用）
// ---------------------------------------------------------------------------

func jsonMarshalSnapshot(s *promOverviewResp) (string, error) {
	b, err := json.Marshal(s)
	if err != nil {
		return "", err
	}
	// 超长快照不落库（text 列能放下，但没必要拖慢启动）
	if len(b) > 8*1024*1024 {
		return "", fmt.Errorf("snapshot too large")
	}
	return string(b), nil
}

func jsonUnmarshalSnapshot(s string) (*promOverviewResp, error) {
	var out promOverviewResp
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---------------------------------------------------------------------------
// 采集状态（管理页展示）
// ---------------------------------------------------------------------------

// promScreenCfgBody 保存大屏配置的请求体（开关类字段用指针区分「未传」与「显式 0」）
type promScreenCfgBody struct {
	Title       string          `json:"title"`
	AutoCollect *int            `json:"autoCollect"`
	IntervalSec int             `json:"intervalSec"`
	CPUWarn     float64         `json:"cpuWarn"`
	CPUCrit     float64         `json:"cpuCrit"`
	MemWarn     float64         `json:"memWarn"`
	MemCrit     float64         `json:"memCrit"`
	DiskWarn    float64         `json:"diskWarn"`
	DiskCrit    float64         `json:"diskCrit"`
	TopN        int             `json:"topN"`
	HostLimit   int             `json:"hostLimit"`
	ShowOffline *int            `json:"showOffline"`
	TrendHours  int             `json:"trendHours"`
	GroupBy     string          `json:"groupBy"`
	Masks       *[]promMaskRule `json:"masks"` // 指针：nil=未传（保持原值），传了=整体覆盖
	Remark      string          `json:"remark"`
}

type promCollectStatus struct {
	ID          uint   `json:"id"`
	Name        string `json:"name"`
	Ready       bool   `json:"ready"`
	Busy        bool   `json:"busy"`
	GeneratedAt string `json:"generatedAt"`
	CollectMs   int64  `json:"collectMs"`
	Hosts       int    `json:"hosts"`
	Source      string `json:"source"`
	Msg         string `json:"msg"`
}

func promCollectStatusList() []promCollectStatus {
	var list []PromDataSource
	if err := DB.Where("enabled = 1").Order("id asc").Find(&list).Error; err != nil {
		return []promCollectStatus{}
	}
	out := make([]promCollectStatus, 0, len(list))
	promSnapMu.RLock()
	defer promSnapMu.RUnlock()
	for _, ds := range list {
		st := promCollectStatus{ID: ds.ID, Name: ds.Name}
		if s, ok := promSnaps[ds.ID]; ok && s != nil {
			st.Ready = true
			st.GeneratedAt = s.GeneratedAt
			st.CollectMs = s.CollectMs
			st.Hosts = len(s.Hosts)
			st.Source = promLastSource[ds.ID]
		}
		st.Busy = promCollectBusy[ds.ID]
		st.Msg = promSnapErrs[ds.ID]
		out = append(out, st)
	}
	return out
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// promSnapshotResp 大屏轮询的响应（永不直查 Prometheus）
type promSnapshotResp struct {
	Ready       bool              `json:"ready"`
	Collecting  bool              `json:"collecting"`
	AutoCollect int               `json:"autoCollect"`
	IntervalSec int               `json:"intervalSec"`
	NextAt      int64             `json:"nextAt"` // unix 秒；0=未知
	Msg         string            `json:"msg"`
	Config      promCfgView       `json:"config"`
	Data        *promOverviewResp `json:"data"`
}

// PromGetSnapshot GET /api/prom/snapshot?ds=
//
// 只读缓存：无快照时异步拉一次，前端拿到 ready=false 继续轮询即可。
func PromGetSnapshot(c *gin.Context) {
	cfg := promLoadConfig()
	resp := promSnapshotResp{AutoCollect: cfg.AutoCollect, IntervalSec: cfg.IntervalSec, Config: cfg.view()}

	idStr := strings.TrimSpace(c.Query("ds"))
	var dsID uint
	if idStr != "" {
		id, err := strconv.ParseUint(idStr, 10, 64)
		if err != nil || id == 0 {
			Fail(c, http.StatusBadRequest, 1, "数据源 id 不合法："+idStr)
			return
		}
		dsID = uint(id)
	} else {
		var first PromDataSource
		if err := DB.Where("enabled = 1").Order("id asc").First(&first).Error; err != nil {
			Fail(c, http.StatusBadRequest, 1, "没有可用的 Prometheus 数据源，请先在「数据源管理」添加")
			return
		}
		dsID = first.ID
	}
	promCollectMu.Lock()
	resp.NextAt = promNextAt[dsID]
	promCollectMu.Unlock()

	snap, msg, busy := promSnapshotOf(dsID)
	resp.Collecting = busy
	resp.Msg = msg
	if snap != nil {
		resp.Ready = true
		resp.Data = snap
	} else if !busy {
		// 首次打开：顺手触发一次，前端下一轮就能拿到
		promCollectAsync(dsID, "auto")
		resp.Collecting = true
	}
	OK(c, resp)
}

// PromCollectNow POST /api/prom/collect?ds= —— 手动触发一次采集（同步等待）
func PromCollectNow(c *gin.Context) {
	var ds PromDataSource
	idStr := strings.TrimSpace(c.Query("ds"))
	if idStr != "" {
		id, err := strconv.ParseUint(idStr, 10, 64)
		if err != nil || id == 0 {
			Fail(c, http.StatusBadRequest, 1, "数据源 id 不合法："+idStr)
			return
		}
		if err := DB.Where("id = ?", id).First(&ds).Error; err != nil {
			Fail(c, http.StatusBadRequest, 1, fmt.Sprintf("数据源不存在：%d", id))
			return
		}
	} else {
		if err := DB.Where("enabled = 1").Order("id asc").First(&ds).Error; err != nil {
			Fail(c, http.StatusBadRequest, 1, "没有可用的 Prometheus 数据源")
			return
		}
	}
	snap, err := promCollectSync(ds.ID, "manual")
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	OK(c, gin.H{"msg": "采集完成", "generatedAt": snap.GeneratedAt, "hosts": len(snap.Hosts), "collectMs": snap.CollectMs})
}

// PromGetScreenConfig GET /api/prom/screen-config
func PromGetScreenConfig(c *gin.Context) {
	cfg := promLoadConfig()
	promCollectMu.Lock()
	var next int64
	for _, v := range promNextAt {
		if next == 0 || (v > 0 && v < next) {
			next = v
		}
	}
	promCollectMu.Unlock()
	OK(c, gin.H{
		"config": cfg,
		"status": promCollectStatusList(),
		"nextAt": next,
	})
}

// PromSaveScreenConfig PUT /api/prom/screen-config
//
// ⚠️ autoCollect / showOffline 是指针：JSON 里没传就是 nil（保持原值）。
// 若用普通 int，调用方只改「采集间隔」时这两个开关会被静默写成 0（自动采集被关掉）。
func PromSaveScreenConfig(c *gin.Context) {
	var body promScreenCfgBody
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 1, "请求体不合法："+err.Error())
		return
	}
	old := promLoadConfig()
	// 只覆盖前端可调字段，避免前端漏传导致结构字段被清空。
	//
	// ⚠️ 数值/文本字段一律「非零才覆盖」：屏蔽规则页（独立菜单）只会提交 masks，
	// 若在这里无条件赋值，保存一次屏蔽规则会把标题、采集间隔、阈值全部打回默认值。
	if t := strings.TrimSpace(body.Title); t != "" {
		old.Title = t
	}
	if body.AutoCollect != nil {
		v := 0
		if *body.AutoCollect != 0 {
			v = 1
		}
		old.AutoCollect = v
	}
	if body.ShowOffline != nil {
		v := 0
		if *body.ShowOffline != 0 {
			v = 1
		}
		old.ShowOffline = v
	}
	if body.IntervalSec > 0 {
		old.IntervalSec = body.IntervalSec
	}
	if body.CPUWarn > 0 {
		old.CPUWarn = body.CPUWarn
	}
	if body.CPUCrit > 0 {
		old.CPUCrit = body.CPUCrit
	}
	if body.MemWarn > 0 {
		old.MemWarn = body.MemWarn
	}
	if body.MemCrit > 0 {
		old.MemCrit = body.MemCrit
	}
	if body.DiskWarn > 0 {
		old.DiskWarn = body.DiskWarn
	}
	if body.DiskCrit > 0 {
		old.DiskCrit = body.DiskCrit
	}
	if body.TopN > 0 {
		old.TopN = body.TopN
	}
	if body.HostLimit > 0 {
		old.HostLimit = body.HostLimit
	}
	if body.TrendHours > 0 {
		old.TrendHours = body.TrendHours
	}
	if body.GroupBy != "" {
		old.GroupBy = body.GroupBy
	}
	if body.Masks != nil {
		old.Masks = promMasksToJSON(*body.Masks)
	}
	if body.Remark != "" {
		old.Remark = body.Remark
	}
	if err := promSaveConfig(old); err != nil {
		Fail(c, http.StatusInternalServerError, 1, "保存失败："+err.Error())
		return
	}
	// 屏蔽规则不必等下一轮采集：立即对内存快照重算超阈值清单（阈值类字段照旧等下一轮）
	promReapplyMasks(old)
	OK(c, gin.H{"msg": "已保存，屏蔽规则立即生效；其它配置下一轮采集生效", "config": old})
}

// promReapplyMasks 按最新配置重算所有内存快照的超阈值清单（保存屏蔽规则后立刻可见）
func promReapplyMasks(cfg *PromScreenConfig) {
	promSnapMu.Lock()
	defer promSnapMu.Unlock()
	for _, s := range promSnaps {
		if s == nil {
			continue
		}
		s.Issues, s.IssueStat = promBuildIssues(s.Hosts, cfg, 100)
		s.Config = cfg.view()
	}
}
