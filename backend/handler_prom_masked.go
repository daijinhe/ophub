package main

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// 被屏蔽目标明细（v1.7.43）
//
// 背景：屏蔽规则 / 等级口径 / 清单上限 都是让大屏「更干净」的手段，但它们都会让真实存在的
// 风险从屏幕上消失。运维必须有一块**审计视图**回答两个问题：
//
//	① 现在到底屏蔽了谁 —— 哪台主机、哪个维度、因为哪条规则（而不是只看到一个大屏上空荡荡的清单）；
//	② 这些目标当前指标是多少 —— 屏蔽不等于不存在，水位该看还得看。
//
// 口径：**被屏蔽 = 用同一套阈值算出的「全集」− 大屏当前实际展示的**。
// 两侧都用 promBuildIssues / promTopN 的同一套闸门函数（promIssueGate / promRankGate）
// 现场从快照 hosts 重算，所以不可能出现「大屏说屏蔽了、明细说没屏蔽」的两套口径。
//
// ⚠️ 本页是**只读**视图：不落库、不改配置、不触发采集。它只是把「大屏为什么长这样」摊开。
// ============================================================================

const (
	// promHiddenIssueCap 被隐藏风险项的输出上限（榜位天然 ≤ 4×TOP N，不需要上限）
	promHiddenIssueCap = 500
	// promHiddenHostCap 被屏蔽主机的输出上限。白名单模式下「非白名单主机」可能几百台，
	// 全量下发会让页面卡住 —— 按「离线 → 严重 → 关注 → 正常」+ 水位降序截断，最该看的必然在前。
	promHiddenHostCap = 300
)

// promHiddenThresholds 本次快照生效的判级阈值（前端据此给主机水位标色，避免前端硬编码）
type promHiddenThresholds struct {
	CPUWarn  float64 `json:"cpuWarn"`
	CPUCrit  float64 `json:"cpuCrit"`
	MemWarn  float64 `json:"memWarn"`
	MemCrit  float64 `json:"memCrit"`
	DiskWarn float64 `json:"diskWarn"`
	DiskCrit float64 `json:"diskCrit"`
}

// promHiddenHost 被屏蔽的主机（**目标维度**）—— 回答「哪些目标被屏蔽了、它现在什么水位」。
//
// 注意它和「被隐藏风险项」不是一回事：一台机器可能因为噪音被屏蔽，但当前根本没超任何阈值
// （所以不会出现在风险项里），这种「被屏蔽的目标」只有这张表能看到。
type promHiddenHost struct {
	Instance   string   `json:"instance"`
	Hostname   string   `json:"hostname"`
	Name       string   `json:"name"`
	Department string   `json:"department"`
	System     string   `json:"system"`
	Env        string   `json:"env"`
	DeploySvr  string   `json:"deployserver"`
	Up         bool     `json:"up"`
	CPU        float64  `json:"cpu"`
	Mem        float64  `json:"mem"`
	Disk       float64  `json:"disk"`
	Net        float64  `json:"net"`
	Dims       []string `json:"dims"`   // 被屏蔽的维度：cpu | mem | disk | net | offline
	DimsCN     []string `json:"dimsCN"` // CPU | 内存 | 磁盘 | 网络 | 连通性
	Risk       string   `json:"risk"`   // none | warn | crit（按当前阈值对 CPU/内存/磁盘 取最严重档；离线恒为 crit）
	RiskCN     string   `json:"riskCN"`
	Reason     string   `json:"reason"` // mask | notwhite
	ReasonCN   string   `json:"reasonCN"`
	Rules      []string `json:"rules"` // 命中的规则描述（黑名单模式才有；一段话，前端直接展示）
}

// promHiddenIssue 被隐藏的一条风险项（内嵌 promIssue，字段与大屏清单完全一致，前端可复用渲染）
type promHiddenIssue struct {
	promIssue
	Reason     string  `json:"reason"`
	ReasonCN   string  `json:"reasonCN"`
	RuleTarget string  `json:"ruleTarget,omitempty"`
	RuleMetric string  `json:"ruleMetric,omitempty"`
	Note       string  `json:"note,omitempty"`
	HostUp     bool    `json:"hostUp"`
	HostCPU    float64 `json:"hostCpu"` // 该主机当前四项水位（屏蔽了 CPU 告警，但它的内存/磁盘水位一样要看）
	HostMem    float64 `json:"hostMem"`
	HostDisk   float64 `json:"hostDisk"`
	HostNet    float64 `json:"hostNet"`
}

// promHiddenRank 被屏蔽掉的名次（**榜位维度**）—— 「CPU 榜第 1 名被屏蔽了」比「这台机器被屏蔽了」更直观
type promHiddenRank struct {
	Metric     string  `json:"metric"`
	MetricCN   string  `json:"metricCN"`
	WouldRank  int     `json:"wouldRank"` // 不屏蔽时的名次（1 起）
	Instance   string  `json:"instance"`
	Hostname   string  `json:"hostname"`
	Name       string  `json:"name"`
	Department string  `json:"department"`
	System     string  `json:"system"`
	Env        string  `json:"env"`
	DeploySvr  string  `json:"deployserver"`
	Value      float64 `json:"value"`
	Reason     string  `json:"reason"`
	ReasonCN   string  `json:"reasonCN"`
	RuleTarget string  `json:"ruleTarget,omitempty"`
	Note       string  `json:"note,omitempty"`
}

// promHiddenCounts 概览计数（页面顶部卡片直接用，免得前端从数组里数、口径又飘）
type promHiddenCounts struct {
	FleetHosts   int  `json:"fleetHosts"`  // 快照内主机总数
	HiddenHosts  int  `json:"hiddenHosts"` // 被规则屏蔽的主机数（去重）
	IssueTotal   int  `json:"issueTotal"`  // 超阈值全集（不管屏蔽与上限）
	IssueShown   int  `json:"issueShown"`  // 大屏实际展示的条数
	IssueHidden  int  `json:"issueHidden"` // 被隐藏合计（= total − shown）
	MaskedIssues int  `json:"maskedIssues"`
	RiskIssues   int  `json:"riskIssues"`
	TruncIssues  int  `json:"truncIssues"`
	RankSlots    int  `json:"rankSlots"`  // 被屏蔽掉的榜位（原本名次 ≤ TOP N）
	RankBeyond   int  `json:"rankBeyond"` // 另有这么多台被屏蔽但名次本来就在 TOP N 之外
	HostsCapped  bool `json:"hostsCapped"`
	IssuesCapped bool `json:"issuesCapped"`
}

// promHiddenNotice 提示条（带级别 —— 「白名单空规则导致全隐藏」和「另有 3 台在榜外」的
// 严重程度完全不同，全用一个颜色会让真正危险的那条被淹没）。
type promHiddenNotice struct {
	Level string `json:"level"` // error | warning | info
	Text  string `json:"text"`
}

// promHiddenResp GET /api/prom/hidden 的响应
type promHiddenResp struct {
	DSID        uint                 `json:"dsId"`
	DSName      string               `json:"dsName"`
	Ready       bool                 `json:"ready"`
	Collecting  bool                 `json:"collecting"`
	Msg         string               `json:"msg"`
	GeneratedAt string               `json:"generatedAt"`
	CollectMs   int64                `json:"collectMs"`
	MaskMode    string               `json:"maskMode"`
	RiskLevel   string               `json:"riskLevel"`
	TopN        int                  `json:"topN"`
	Masks       []promMaskRule       `json:"masks"`
	Thresholds  promHiddenThresholds `json:"thresholds"`
	Hosts       []promHiddenHost     `json:"hosts"`
	Issues      []promHiddenIssue    `json:"issues"`
	Ranks       []promHiddenRank     `json:"ranks"`
	Counts      promHiddenCounts     `json:"counts"`
	Notices     []promHiddenNotice   `json:"notices"`
}

// promMetricCN 指标 key → 中文（大屏清单里是手写的，这里给「没有 promIssue 可挂」的地方用）
func promMetricCN(metric string) string {
	switch metric {
	case "cpu":
		return "CPU"
	case "mem":
		return "内存"
	case "disk":
		return "磁盘"
	case "net":
		return "网络"
	case "offline":
		return "连通性"
	}
	return metric
}

// promRuleText 规则的一句话描述（明细页「触发规则」列用它，比裸 JSON 好读）
func promRuleText(r *promMaskRule) string {
	if r == nil {
		return ""
	}
	s := fmt.Sprintf("包含「%s」× %s", r.Target, promMetricCN(r.Metric))
	if n := strings.TrimSpace(r.Note); n != "" {
		s += "（" + n + "）"
	}
	return s
}

// promVisibilityOff 返回一份「保留阈值、关掉全部可见性闸门」的配置副本。
//
// 拿它跑 promBuildIssues 得到的就是「超阈值全集」—— 与真实配置跑出的「展示集」相减即被隐藏项。
// （level 判级仍用真实阈值，所以「全集」包含 warn 与 crit 两档，属于预期。）
func promVisibilityOff(cfg *PromScreenConfig) *PromScreenConfig {
	cp := *cfg
	cp.RiskLevel = "all"
	cp.MaskMode = "blacklist"
	cp.Masks = nil
	return &cp
}

// promHostRisk 主机资源风险档（与大屏「资源健康分布」同一口径：对 CPU/内存/磁盘 取最严重档）
func promHostRisk(h promHostStat, cfg *PromScreenConfig) string {
	if !h.Up {
		return "crit"
	}
	if (h.CPU > 0 && h.CPU >= cfg.CPUCrit) || (h.Mem > 0 && h.Mem >= cfg.MemCrit) || (h.Disk > 0 && h.Disk >= cfg.DiskCrit) {
		return "crit"
	}
	if (h.CPU > 0 && h.CPU >= cfg.CPUWarn) || (h.Mem > 0 && h.Mem >= cfg.MemWarn) || (h.Disk > 0 && h.Disk >= cfg.DiskWarn) {
		return "warn"
	}
	return "none"
}

func promRiskCN(risk string) string {
	switch risk {
	case "crit":
		return "严重"
	case "warn":
		return "关注"
	}
	return "正常"
}

// promBuildHidden 算出「大屏看不到的东西」。
//
// 三个来源分开算，因为被挡掉的方式不同：
//   - 主机：按规则被排除（任一维度）→ 目标维度视图，附当前四项水位；
//   - 风险项：全集 vs 展示集 → 逐条判原因（等级口径 / 规则 / 超出上限）；
//   - 榜位：按指标降序排全量水位，被挡掉且原本名次 ≤ TOP N 的才列出
//     （名次更靠后的本来也上不了屏，只报数量 —— 否则白名单模式下会刷出几百条噪音）。
func promBuildHidden(
	hosts []promHostStat, cfg *PromScreenConfig,
) ([]promHiddenHost, []promHiddenIssue, []promHiddenRank, promHiddenCounts, []promHiddenNotice) {
	topN := cfg.TopN
	if topN <= 0 {
		topN = 5
	}
	cnt := promHiddenCounts{FleetHosts: len(hosts)}
	notices := []promHiddenNotice{}

	hostIdx := make(map[string]*promHostStat, len(hosts))
	for i := range hosts {
		hostIdx[hosts[i].Instance] = &hosts[i]
	}

	// ---------------- ① 被屏蔽的主机（目标维度） ----------------
	rankOfRisk := func(r string) int {
		switch r {
		case "crit":
			return 2
		case "warn":
			return 1
		}
		return 0
	}
	waterOf := func(h promHostStat) float64 {
		m := h.CPU
		if h.Mem > m {
			m = h.Mem
		}
		if h.Disk > m {
			m = h.Disk
		}
		return m
	}
	sortedHosts := append([]promHostStat(nil), hosts...)
	// 离线最该被看到（它就是「消失的机器」），其次按风险档、再按综合水位
	sort.SliceStable(sortedHosts, func(i, j int) bool {
		a, b := sortedHosts[i], sortedHosts[j]
		if a.Up != b.Up {
			return !a.Up
		}
		ra, rb := rankOfRisk(promHostRisk(a, cfg)), rankOfRisk(promHostRisk(b, cfg))
		if ra != rb {
			return ra > rb
		}
		return waterOf(a) > waterOf(b)
	})

	hostsOut := make([]promHiddenHost, 0, 32)
	hiddenHostSet := map[string]bool{}
	for _, h := range sortedHosts {
		name := promHostName(h.System, h.Env, h.DeploySvr, h.Instance, h.Hostname)
		dims := []string{}
		ruleSeen := map[string]bool{}
		rules := []string{}
		for _, m := range []string{"cpu", "mem", "disk", "net"} {
			if promRankGate(cfg, m, h.Instance, name) == "" {
				continue
			}
			dims = append(dims, m)
			r := promMatchRule(cfg, m, h.Instance, name)
			if r == nil {
				continue
			}
			k := r.Target + "|" + r.Metric + "|" + r.Note
			if ruleSeen[k] {
				continue
			}
			ruleSeen[k] = true
			rules = append(rules, promRuleText(r))
		}
		// 连通性维度只在「离线 且 被挡掉」时才有意义（在线主机的 offline 项本来就不存在）
		if !h.Up && promIssueGate(cfg, "crit", "offline", h.Instance, name) != "" {
			dims = append(dims, "offline")
		}
		if len(dims) == 0 {
			continue
		}
		dimsCN := make([]string, 0, len(dims))
		for _, d := range dims {
			dimsCN = append(dimsCN, promMetricCN(d))
		}
		reason := promHideMask
		if cfg.MaskMode == "whitelist" {
			reason = promHideNotWhite
		}
		risk := promHostRisk(h, cfg)
		hostsOut = append(hostsOut, promHiddenHost{
			Instance: h.Instance, Hostname: h.Hostname, Name: name,
			Department: h.Department, System: h.System, Env: h.Env, DeploySvr: h.DeploySvr,
			Up:  h.Up,
			CPU: round1(h.CPU), Mem: round1(h.Mem), Disk: round1(h.Disk), Net: round1(h.Net),
			Dims: dims, DimsCN: dimsCN,
			Risk: risk, RiskCN: promRiskCN(risk),
			Reason: reason, ReasonCN: promHideReasonCN(reason),
			Rules: rules,
		})
		hiddenHostSet[h.Instance] = true
	}
	cnt.HiddenHosts = len(hostsOut)
	if len(hostsOut) > promHiddenHostCap {
		hostsOut = hostsOut[:promHiddenHostCap]
		cnt.HostsCapped = true
	}

	// ---------------- ② 被隐藏的风险项 ----------------
	// 全集：关掉全部闸门（不带 limit）；展示集：与快照里 s.Issues 同一参数（limit 100）。
	full, _ := promBuildIssues(hosts, promVisibilityOff(cfg), 0)
	shown, _ := promBuildIssues(hosts, cfg, 100)
	shownSet := make(map[string]bool, len(shown))
	for _, it := range shown {
		shownSet[it.Instance+"|"+it.Metric] = true
	}
	cnt.IssueTotal, cnt.IssueShown = len(full), len(shown)

	issuesOut := make([]promHiddenIssue, 0, 32)
	for _, it := range full {
		if shownSet[it.Instance+"|"+it.Metric] {
			continue
		}
		reason := promIssueGate(cfg, it.Level, it.Metric, it.Instance, it.Name)
		if reason == "" {
			// 闸门全过却还是没在展示集里 → 只可能是被清单上限截掉的
			reason = promHideTruncate
		}
		h := promHiddenIssue{promIssue: it, Reason: reason, ReasonCN: promHideReasonCN(reason)}
		if r := promMatchRule(cfg, it.Metric, it.Instance, it.Name); r != nil {
			h.RuleTarget, h.RuleMetric, h.Note = r.Target, r.Metric, r.Note
		}
		if hs := hostIdx[it.Instance]; hs != nil {
			h.HostUp = hs.Up
			h.HostCPU, h.HostMem, h.HostDisk, h.HostNet = round1(hs.CPU), round1(hs.Mem), round1(hs.Disk), round1(hs.Net)
		}
		switch reason {
		case promHideMask, promHideNotWhite:
			cnt.MaskedIssues++
		case promHideRisk:
			cnt.RiskIssues++
		case promHideTruncate:
			cnt.TruncIssues++
		}
		issuesOut = append(issuesOut, h)
	}
	// 严重优先、同档按数值降序：页面上第一眼看到的就是最该处理的那条
	sort.SliceStable(issuesOut, func(i, j int) bool {
		if (issuesOut[i].Level == "crit") != (issuesOut[j].Level == "crit") {
			return issuesOut[i].Level == "crit"
		}
		return issuesOut[i].Value > issuesOut[j].Value
	})
	cnt.IssueHidden = len(issuesOut)
	if len(issuesOut) > promHiddenIssueCap {
		issuesOut = issuesOut[:promHiddenIssueCap]
		cnt.IssuesCapped = true
	}

	// ---------------- ③ 被屏蔽的榜位 ----------------
	rankMetrics := []struct {
		key, cn string
		pick    func(promHostStat) float64
	}{
		{"cpu", "CPU", func(h promHostStat) float64 { return h.CPU }},
		{"mem", "内存", func(h promHostStat) float64 { return h.Mem }},
		{"disk", "磁盘", func(h promHostStat) float64 { return h.Disk }},
		{"net", "网络", func(h promHostStat) float64 { return h.Net }},
	}
	ranksOut := make([]promHiddenRank, 0, 16)
	for _, m := range rankMetrics {
		// 与 promTopN 完全一致的候选集：在线 + 该指标有数据
		cands := make([]promHostStat, 0, len(hosts))
		for _, h := range hosts {
			if h.Up && m.pick(h) > 0 {
				cands = append(cands, h)
			}
		}
		sort.Slice(cands, func(i, j int) bool { return m.pick(cands[i]) > m.pick(cands[j]) })
		for i, h := range cands {
			name := promHostName(h.System, h.Env, h.DeploySvr, h.Instance, h.Hostname)
			reason := promRankGate(cfg, m.key, h.Instance, name)
			if reason == "" {
				continue
			}
			hiddenHostSet[h.Instance] = true
			if i+1 > topN {
				// 原本就上不了屏，只计数不逐条列（白名单模式下这类会很多）
				cnt.RankBeyond++
				continue
			}
			r := promHiddenRank{
				Metric: m.key, MetricCN: m.cn, WouldRank: i + 1,
				Instance: h.Instance, Hostname: h.Hostname, Name: name,
				Department: h.Department, System: h.System, Env: h.Env, DeploySvr: h.DeploySvr,
				Value:  round1(m.pick(h)),
				Reason: reason, ReasonCN: promHideReasonCN(reason),
			}
			if rule := promMatchRule(cfg, m.key, h.Instance, name); rule != nil {
				r.RuleTarget, r.Note = rule.Target, rule.Note
			}
			ranksOut = append(ranksOut, r)
			cnt.RankSlots++
		}
	}
	// 榜位数可能超过前面统计的「被屏蔽主机数」（同一台机器占多个榜）—— 以并集为准
	if len(hiddenHostSet) > cnt.HiddenHosts {
		cnt.HiddenHosts = len(hiddenHostSet)
	}

	// ---------------- ④ 提示（把「大屏为什么长这样」讲清楚） ----------------
	maskCnt := len(promParseMasks(cfg.Masks))
	switch {
	case cfg.MaskMode == "whitelist" && maskCnt == 0:
		notices = append(notices, promHiddenNotice{"error",
			"白名单模式下没有任何规则：大屏的风险项与四个负载榜被全部隐藏。请到大屏管理补规则，或切回黑名单模式。"})
	case cfg.MaskMode == "whitelist":
		notices = append(notices, promHiddenNotice{"info",
			fmt.Sprintf("当前是白名单模式（%d 条规则）：不在白名单里的目标与风险项一律不上屏，下面列出的就是它们。", maskCnt)})
	}
	switch cfg.RiskLevel {
	case "crit":
		notices = append(notices, promHiddenNotice{"warning",
			"等级口径为「仅严重」：「关注」级风险项整体不上屏（见风险项表的「原因」列）。"})
	case "warn":
		notices = append(notices, promHiddenNotice{"warning",
			"等级口径为「仅关注」：「严重」级风险项整体不上屏 —— 投屏上看不到红项，别误判成没有严重问题。"})
	}
	if cnt.TruncIssues > 0 {
		notices = append(notices, promHiddenNotice{"warning",
			fmt.Sprintf("另有 %d 条超阈值项因大屏清单上限（100 条）未上屏；它们同样在真实报警，只是列表放不下。", cnt.TruncIssues)})
	}
	if cnt.RankBeyond > 0 {
		notices = append(notices, promHiddenNotice{"info",
			fmt.Sprintf("四个负载榜合计另有 %d 台主机被屏蔽，但它们原本的名次就在 TOP %d 之外，不影响大屏显示。", cnt.RankBeyond, topN)})
	}
	if cnt.HostsCapped || cnt.IssuesCapped {
		notices = append(notices, promHiddenNotice{"info",
			fmt.Sprintf("列表已截断展示（主机最多 %d 条、风险项最多 %d 条），顶部计数为完整口径。",
				promHiddenHostCap, promHiddenIssueCap)})
	}
	return hostsOut, issuesOut, ranksOut, cnt, notices
}

// promSnapshotCopy 取快照的**副本**（只带本页要用的字段）。
//
// ⚠️ 不能直接拿着 promSnaps[id] 指针去算：保存配置时 promReapplyMasks 会在写锁里原地改
// s.Issues / s.Top / s.Config，和这里的读并发；复制出 hosts 既避开竞态，也保证
// 「明细」与「大屏当前展示」取的是同一时刻的数据。
func promSnapshotCopy(dsID uint) (*promOverviewResp, string, bool) {
	promSnapMu.RLock()
	defer promSnapMu.RUnlock()
	s := promSnaps[dsID]
	if s == nil {
		return nil, promSnapErrs[dsID], promCollectBusy[dsID]
	}
	cp := *s
	cp.Hosts = append([]promHostStat(nil), s.Hosts...)
	cp.Issues = nil
	cp.Top = promTopSets{}
	cp.Groups = nil
	cp.Trend = nil
	cp.AlertTrend = nil
	cp.OSDist = nil
	return &cp, promSnapErrs[dsID], promCollectBusy[dsID]
}

// PromGetHidden GET /api/prom/hidden?ds=
//
// 被屏蔽目标明细：读最新快照现算（毫秒级），**不查 Prometheus**。
// 数据源口径与 /api/prom/snapshot 一致：显式 ?ds= 优先，否则取第一个已启用的。
func PromGetHidden(c *gin.Context) {
	var ds PromDataSource
	if idStr := strings.TrimSpace(c.Query("ds")); idStr != "" {
		id, err := strconv.ParseUint(idStr, 10, 64)
		if err != nil || id == 0 {
			Fail(c, http.StatusBadRequest, 1, "数据源 id 不合法："+idStr)
			return
		}
		if err := DB.Where("id = ?", uint(id)).First(&ds).Error; err != nil {
			Fail(c, http.StatusBadRequest, 1, fmt.Sprintf("数据源不存在：%d", id))
			return
		}
	} else if err := DB.Where("enabled = 1").Order("id asc").First(&ds).Error; err != nil {
		Fail(c, http.StatusBadRequest, 1, "没有可用的 Prometheus 数据源，请先在「数据源管理」添加")
		return
	}

	cfg := promLoadConfig()
	resp := promHiddenResp{
		DSID: ds.ID, DSName: ds.Name,
		MaskMode: cfg.MaskMode, RiskLevel: cfg.RiskLevel, TopN: cfg.TopN,
		Masks: promParseMasks(cfg.Masks),
		Thresholds: promHiddenThresholds{
			CPUWarn: cfg.CPUWarn, CPUCrit: cfg.CPUCrit,
			MemWarn: cfg.MemWarn, MemCrit: cfg.MemCrit,
			DiskWarn: cfg.DiskWarn, DiskCrit: cfg.DiskCrit,
		},
		Hosts: []promHiddenHost{}, Issues: []promHiddenIssue{}, Ranks: []promHiddenRank{},
		Notices: []promHiddenNotice{},
	}

	snap, msg, busy := promSnapshotCopy(ds.ID)
	resp.Collecting, resp.Msg = busy, msg
	if snap == nil {
		resp.Notices = append(resp.Notices, promHiddenNotice{"warning",
			"该数据源还没有采集到快照，暂时算不出被屏蔽项。等一轮采集（或点「立即采集」）后再看。"})
		OK(c, resp)
		return
	}
	resp.Ready = true
	resp.GeneratedAt, resp.CollectMs = snap.GeneratedAt, snap.CollectMs
	hosts, issues, ranks, cnt, notices := promBuildHidden(snap.Hosts, cfg)
	resp.Hosts, resp.Issues, resp.Ranks, resp.Counts = hosts, issues, ranks, cnt
	resp.Notices = append(resp.Notices, notices...)
	OK(c, resp)
}
