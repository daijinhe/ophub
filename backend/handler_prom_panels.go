package main

import (
	"context"
	"sort"
	"strings"
)

// ============================================================================
// 监控大屏补齐面板的数据口径（v1.7.39）
//
// 背景：大屏改成与「巡检大屏」完全同版面后，多出来四类巡检大屏有、而 Prometheus
// 原本没有对应取数的面板 —— 容量总量、操作系统分布、网络使用率、告警趋势。
// 本文件集中放这四块的换算规则，handler_prom_dashboard.go 只负责接线。
//
// 一条贯穿的原则：**取不到就降级成 0 / 未知，绝不让整块快照失败**。
// 大屏上少一个数字运维还能干活，整屏空白就只能报障了。
// ============================================================================

// ---------------------------------------------------------------------------
// 操作系统分布
// ---------------------------------------------------------------------------

// promOSKernelRule 内核 release / version 里的发行版标记 → 展示用家族名。
//
// 只在 node_exporter 太老、没有 node_os_info 时才用（实测 925 台里只有 228 台有），
// 属于「从内核串推断」——所以标签刻意写得保守：
// `el7` 只敢写「RHEL/CentOS 7」而不是「CentOS 7」，因为 AlmaLinux 也用 el8 内核
// （实测确有 4.18.0-513.5.1.el8_9.x86_64 的 AlmaLinux 主机），写死成 CentOS 会误标。
//
// 顺序敏感：特化 / 长关键词必须排在泛化 / 短关键词之前
// （oe2203 必须在 oe2 之前、ky10 在 kylin 之前）。
var promOSKernelRules = []struct{ key, label string }{
	// —— 国产 ——
	{"hce", "华为 HCE"}, // 5.10.0-182.0.0.95.r3450_281.hce2.aarch64
	{"euleros", "EulerOS"},
	{"ky10", "银河麒麟 V10"},
	{"neokylin", "中标麒麟"},
	{"kylin", "银河麒麟"},
	{"opencloudos", "OpenCloudOS"},
	{"anolis", "Anolis OS"},
	{"alinux", "Aliyun Linux"},
	{"tlinux", "TencentOS"},
	{"openeuler", "openEuler"},
	{"oe2203", "openEuler 22.03"},
	{"oe2003", "openEuler 20.03"},
	{"oe1", "openEuler 20.03"},
	{"oe2", "openEuler"},
	// —— 国际 ——
	{"ubuntu", "Ubuntu"},
	{"debian", "Debian"},
	{"almalinux", "AlmaLinux"},
	{"rocky", "Rocky Linux"},
	{"el9", "RHEL/CentOS 9"},
	{"el8", "RHEL/CentOS 8"},
	{"el7", "RHEL/CentOS 7"},
	{"el6", "RHEL/CentOS 6"},
	{"suse", "SUSE"},
}

// promOSFamilyOf 一台主机的 OS 家族名。
//
// osInfo 传 node_os_info 的标签 map（老 node_exporter 没有这个指标时传 nil）。
// 有它就交给资产管理那套 simplifyOS 归并 —— 保证「巡检大屏 / 监控大屏 / 资产列表」
// 三处的 OS 归类口径一致，不各写一套规则表。
//
// 没有 node_os_info 时用内核 release/version 里的发行版标记兜底；
// 两条路都走不通才记「未知」。
func promOSFamilyOf(osInfo map[string]string, release, version string) string {
	if len(osInfo) > 0 {
		if fam := simplifyOS(promOSInfoHaystack(osInfo)); fam != "" {
			return fam
		}
	}
	hay := strings.ToLower(release + " " + version)
	for _, r := range promOSKernelRules {
		if strings.Contains(hay, r.key) {
			return r.label
		}
	}
	return "未知"
}

// promOSInfoHaystack 交给 simplifyOS 的归一化输入：pretty_name / name / id 全带上。
//
// 只喂 pretty_name 会漏掉「原文写法不在规则表里、但 id 是标准短名」的发行版：
// 统信 UOS 的 pretty_name 是 "UnionTech OS Server 20"，而规则表认的关键词是 "uos"
// （node_os_info 的 id 恰好就是 uos）。只喂原文会退化成通用兜底的 "UnionTech OS"，
// 与资产列表那边的归类对不上 —— 同一个平台两处显示不同 OS 名是很糟的体验。
func promOSInfoHaystack(m map[string]string) string {
	parts := make([]string, 0, 4)
	for _, k := range []string{"pretty_name", "name", "id", "version_id"} {
		if s := strings.TrimSpace(m[k]); s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, " ")
}

// promOSInfoName 从 node_os_info 的标签取「原始发行版全名」，用于主机卡片的副行。
// pretty_name 最完整（"Kylin Linux Advanced Server V10 (Halberd)"），
// 退而求其次用 name + version_id。
func promOSInfoName(m map[string]string) string {
	if v := strings.TrimSpace(m["pretty_name"]); v != "" {
		return v
	}
	name := strings.TrimSpace(m["name"])
	if name == "" {
		return ""
	}
	ver := strings.TrimSpace(m["version_id"])
	if ver == "" || strings.Contains(strings.ToLower(name), strings.ToLower(ver)) {
		return name
	}
	return name + " " + ver
}

// promNameVal 名称 / 数量对（操作系统分布、告警等级分布用）
type promNameVal struct {
	Name  string `json:"name"`
	Value int    `json:"value"`
}

// promSortNameVal 按数量降序、同数量按名称升序（图例顺序稳定，刷新时不跳）
func promSortNameVal(list []promNameVal) []promNameVal {
	sort.Slice(list, func(i, j int) bool {
		if list[i].Value != list[j].Value {
			return list[i].Value > list[j].Value
		}
		return list[i].Name < list[j].Name
	})
	return list
}

// ---------------------------------------------------------------------------
// 容量总量
// ---------------------------------------------------------------------------

// promCapacity 全集群容量总量（左栏顶部三列卡：CPU 核数 / 内存 / 存储）
type promCapacity struct {
	Cores  float64 `json:"cores"`
	MemGb  float64 `json:"memGb"`
	DiskGb float64 `json:"diskGb"`
}

// promScalar 即时查询取单个数值；结果为空或查询失败都返回 0。
// 容量类指标缺失（例如数据源里根本没有 node_filesystem_*）不能让整块快照失败。
func promScalar(ctx context.Context, cli *promClient, expr string) float64 {
	samples, err := cli.query(ctx, expr, "")
	if err != nil || len(samples) == 0 {
		return 0
	}
	v, _ := sampleValue(samples[0].Value)
	if v < 0 {
		return 0
	}
	return v
}

// ---------------------------------------------------------------------------
// 网络使用率
// ---------------------------------------------------------------------------

// promNetPercent 网络使用率（%）= 出+入速率 ÷ 参考带宽。
//
// speedBytes 是该主机在 node_network_speed_bytes 上报的网卡标称速率（bytes/s），
// 实测覆盖率极低，缺失时回落到「大屏管理」里配置的参考带宽（baseMbps）。
// 结果截到 100：多网卡聚合速率可能超过单卡标称值，不截会在屏上爆出 300% 这种数字，
// 而且水位配色（≥90 红）会把它误判成严重。
func promNetPercent(rateBytes, speedBytes float64, baseMbps int) float64 {
	if rateBytes <= 0 {
		return 0
	}
	den := speedBytes
	if den <= 0 {
		den = float64(baseMbps) * 125000 // Mbps → bytes/s
	}
	if den <= 0 {
		return 0 // 参考带宽被配成 0 且网卡未上报 → 宁可显示 0，也不要 NaN/+Inf
	}
	v := rateBytes / den * 100
	if v > 100 {
		v = 100
	}
	return round1(v)
}

// ---------------------------------------------------------------------------
// 告警趋势
// ---------------------------------------------------------------------------

// promAlertTrendPoint 告警趋势的单个时间点
type promAlertTrendPoint struct {
	TS   int64 `json:"ts"`
	Crit int   `json:"crit"`
	Warn int   `json:"warn"`
}

// promThresholdSeries 一组「按阈值判级」的区间序列（cpu / mem / disk 各一组）
type promThresholdSeries struct {
	Series []promSeries
	Warn   float64
	Crit   float64
}

// promAlertTrendFromSeries 从趋势用的那批区间查询结果里数出每个时间点的超阈值项数。
//
// 刻意复用趋势查询的返回、不额外发查询，好处有两个：
//  1. 口径必然一致 —— 趋势图和告警趋势来自同一批数据，不会出现「趋势显示 CPU 90%
//     但告警趋势说 0 项」这种自相矛盾；
//  2. 采集耗时不变 —— 多出来的只是 Go 里的计数，不是又一次全量区间查询。
//
// 计数单位与 promBuildIssues 一致：按 (instance, 指标) 计项，
// 所以同一台主机 CPU 与内存同时越线会算 2 项。
func promAlertTrendFromSeries(sets []promThresholdSeries) []promAlertTrendPoint {
	crit := map[int64]int{}
	warn := map[int64]int{}
	for _, set := range sets {
		for _, s := range set.Series {
			for _, v := range s.Values {
				f, ok := sampleValue(v)
				// 0 值无意义（PromQL 取不到数据的序列本就是 0），
				// 不计入否则会把「没有采集到」当成「水位 0%」从而虚增正常台数。
				if !ok || f <= 0 {
					continue
				}
				ts := sampleTS(v)
				if f >= set.Crit {
					crit[ts]++
				} else if f >= set.Warn {
					warn[ts]++
				}
			}
		}
	}
	out := make([]promAlertTrendPoint, 0, len(crit)+len(warn))
	tsSet := map[int64]bool{}
	for ts := range crit {
		tsSet[ts] = true
	}
	for ts := range warn {
		tsSet[ts] = true
	}
	for ts := range tsSet {
		out = append(out, promAlertTrendPoint{TS: ts, Crit: crit[ts], Warn: warn[ts]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TS < out[j].TS })
	return out
}

// promAlertTrendAddOffline 把「离线目标数」的区间序列并按时间点累进严重项。
//
// 必须并进来：offline 在 promBuildIssues 里就是严重级别，如果趋势不算离线，
// 左栏 KPI「严重 N」与下方「告警趋势」会长期对不上（离线主机越多差得越远）。
// 离线序列是服务端聚合的 count(up == 0)，只回 1 条序列，代价可忽略。
func promAlertTrendAddOffline(points []promAlertTrendPoint, series []promSeries) []promAlertTrendPoint {
	if len(series) == 0 {
		return points
	}
	offline := map[int64]int{}
	for _, s := range series {
		for _, v := range s.Values {
			f, ok := sampleValue(v)
			if !ok || f <= 0 {
				continue
			}
			offline[sampleTS(v)] = int(f)
		}
	}
	if len(offline) == 0 {
		return points
	}
	// 以已有点为骨架，补上只在离线序列里出现的时间点（两边步长一致，正常不会差）
	idx := map[int64]int{}
	for i, p := range points {
		idx[p.TS] = i
	}
	for ts, n := range offline {
		if i, ok := idx[ts]; ok {
			points[i].Crit += n
			continue
		}
		points = append(points, promAlertTrendPoint{TS: ts, Crit: n})
	}
	sort.Slice(points, func(i, j int) bool { return points[i].TS < points[j].TS })
	return points
}
