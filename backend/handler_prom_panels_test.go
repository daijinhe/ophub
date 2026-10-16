// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"reflect"
	"strconv"
	"testing"
)

// ============================================================================
// v1.7.39 大屏补齐口径的单测
//
// 这些断言防的都是「静默出错」类问题 —— 不报错、界面也正常渲染，
// 但数字是错的：网络使用率整屏 0、OS 分布把一半主机丢进「未知」、
// 告警趋势与 KPI 长期对不上。这类问题在人工点几下页面时基本看不出来。
// ============================================================================

// tsPoint 区间序列里的一个点
type tsPoint struct {
	ts int64
	v  float64
}

// mkTrendSeries 构造一条区间序列（值按 Prometheus 的原始格式写成字符串）
func mkTrendSeries(ps ...tsPoint) promSeries {
	vals := make([][]interface{}, 0, len(ps))
	for _, p := range ps {
		vals = append(vals, []interface{}{float64(p.ts), strconv.FormatFloat(p.v, 'f', -1, 64)})
	}
	return promSeries{Metric: map[string]string{}, Values: vals}
}

// ---------------------------------------------------------------------------
// 网络使用率
// ---------------------------------------------------------------------------

func TestPromNetPercent(t *testing.T) {
	cases := []struct {
		name        string
		rate, speed float64
		baseMbps    int
		want        float64
	}{
		// node_exporter 没有「网络使用率」，全靠「速率 ÷ 带宽」算，分母取错就全盘皆错
		{"无流量记 0", 0, 0, 1000, 0},
		{"网卡未上报速率时按参考带宽算", 12500000, 0, 1000, 10},
		{"网卡上报了速率时优先用它（10G 网卡）", 12500000, 1250000000, 1000, 1},
		{"多网卡聚合超单卡标称值要截到 100", 500000000, 125000000, 1000, 100},
		{"参考带宽为 0 且网卡未上报时返回 0 而不是 NaN", 12500000, 0, 0, 0},
		{"负速率记 0", -1, 0, 1000, 0},
	}
	for _, c := range cases {
		if got := promNetPercent(c.rate, c.speed, c.baseMbps); got != c.want {
			t.Errorf("%s：promNetPercent(%v, %v, %d) = %v，期望 %v", c.name, c.rate, c.speed, c.baseMbps, got, c.want)
		}
	}
}

// ---------------------------------------------------------------------------
// 操作系统家族归一
// ---------------------------------------------------------------------------

func TestPromOSFamilyOfKernelFallback(t *testing.T) {
	cases := []struct {
		name             string
		release, version string
		want             string
	}{
		{"HCE 内核标记", "5.10.0-182.0.0.95.r3450_281.hce2.aarch64", "#1 SMP Thu May 21 03:56:27 UTC 2026", "华为 HCE"},
		{"麒麟 V10 的 ky10 标记", "4.19.90-89.11.v2401.ky10.aarch64", "#1 SMP Thu Apr 25 18:20:10 CST 2024", "银河麒麟 V10"},
		// 顺序敏感：oe2203 必须排在泛化的 oe2 之前，否则会退化成不带版本的「openEuler」
		{"openEuler 22.03 不能被 oe2 抢走", "5.10.0-182.0.0.95.oe2203sp3.aarch64", "#1 SMP Sat Dec 30 13:16:24 CST 2023", "openEuler 22.03"},
		{"openEuler 20.03 的 oe1 标记", "4.19.90-2112.8.0.0131.oe1.x86_64", "#1 SMP Fri Dec 31 19:54:32 UTC 2021", "openEuler 20.03"},
		{"EulerOS 不能被 oe 规则抢走", "3.10.0-862.14.1.1.h224.eulerosv2r7.x86_64", "#1 SMP Tue Feb 12 00:00:00 UTC 2019", "EulerOS"},
		{"Ubuntu 只出现在 version 里也要认出来", "4.15.0-112-generic", "#113-Ubuntu SMP Thu Jul 9 23:41:39 UTC 2020", "Ubuntu"},
		// el8 内核同时被 RHEL / CentOS / AlmaLinux / Rocky 使用，所以只敢标「RHEL/CentOS 8」
		{"el8 只能保守标成 RHEL/CentOS 8", "4.18.0-513.5.1.el8_9.x86_64", "#1 SMP Mon Nov 20 08:56:15 EST 2023", "RHEL/CentOS 8"},
		{"el7 只能保守标成 RHEL/CentOS 7", "3.10.0-693.el7.x86_64", "#1 SMP Tue Aug 22 21:09:27 UTC 2017", "RHEL/CentOS 7"},
		{"el6 老系统", "2.6.32-504.el6.x86_64", "#1 SMP Wed Oct 15 04:27:16 UTC 2014", "RHEL/CentOS 6"},
		{"两条路都走不通才是未知", "", "", "未知"},
	}
	for _, c := range cases {
		if got := promOSFamilyOf(nil, c.release, c.version); got != c.want {
			t.Errorf("%s：promOSFamilyOf(release=%q, version=%q) = %q，期望 %q", c.name, c.release, c.version, got, c.want)
		}
	}
}

func TestPromOSFamilyOfPrefersOSInfo(t *testing.T) {
	// node_os_info 有值时必须以它为准：同一台麒麟主机，内核串只能推断出「银河麒麟 V10」，
	// 而 node_os_info 说的是 "Kylin Linux Advanced Server V10" —— 两者家族相同、但走的是不同的路。
	// 这里刻意断言「走的是 node_os_info 那条路」，避免哪天顺序被改反了还以为是正常的。
	// 注意 osInfo 传的是 node_os_info 的**整张标签表**（不是单个字符串）：
	// 统信 UOS 的 pretty_name 是 "UnionTech OS Server 20"，字面上没有 "uos"，
	// 只有 id 字段才是 "uos" —— 这正是当初被这条用例抓出来的真实缺陷。
	cases := []struct {
		name    string
		osInfo  map[string]string
		release string
		version string
		want    string
	}{
		{"真实发行版名优先于内核推断",
			map[string]string{"pretty_name": "Kylin Linux Advanced Server V10 (Halberd)", "id": "kylin"},
			"4.19.90-89.11.v2401.ky10.aarch64", "#1 SMP", "银河麒麟"},
		{"AlmaLinux 主机不能用 el8 内核推断成 RHEL 系",
			map[string]string{"pretty_name": "AlmaLinux 8.9 (Midnight Oncilla)", "id": "almalinux"},
			"4.18.0-513.5.1.el8_9.x86_64", "#1 SMP", "AlmaLinux"},
		{"HCE 原文归一后与内核推断一致",
			map[string]string{"pretty_name": "Huawei Cloud EulerOS 2.0 (aarch64)", "id": "hce"},
			"5.10.0-182.0.0.95.r3450_281.hce2.aarch64", "#1 SMP", "华为 HCE"},
		{"Ubuntu 原文",
			map[string]string{"pretty_name": "Ubuntu 20.04.6 LTS", "id": "ubuntu"},
			"5.4.0-144-generic", "#161-Ubuntu SMP", "Ubuntu"},
		{"统信 UOS：uos 只出现在 id 字段，必须靠整张标签表才认得出来",
			map[string]string{"pretty_name": "UnionTech OS Server 20 (1050e)", "name": "UnionTech OS", "id": "uos"},
			"4.19.90-2201.4.0.0135.up1.uel20.x86_64", "#1 SMP", "统信 UOS"},
		{"中标麒麟不能被 uos 之外的 kylin 关键字抢走",
			map[string]string{"pretty_name": "NeoKylin Linux Advanced Server release 7Server", "id": "neokylin"},
			"3.10.0-693.el7.x86_64", "#1 SMP", "中标麒麟"},
	}
	for _, c := range cases {
		if got := promOSFamilyOf(c.osInfo, c.release, c.version); got != c.want {
			t.Errorf("%s：promOSFamilyOf(%v, …) = %q，期望 %q", c.name, c.osInfo, got, c.want)
		}
	}
}

func TestPromOSInfoName(t *testing.T) {
	cases := []struct {
		name string
		m    map[string]string
		want string
	}{
		{"pretty_name 最完整，优先", map[string]string{"pretty_name": "Huawei Cloud EulerOS 2.0 (aarch64)", "name": "Huawei Cloud EulerOS"}, "Huawei Cloud EulerOS 2.0 (aarch64)"},
		{"没有 pretty_name 时拼 name + version_id", map[string]string{"name": "Ubuntu", "version_id": "20.04"}, "Ubuntu 20.04"},
		{"name 里已经含版本号就不要重复拼", map[string]string{"name": "Ubuntu 20.04", "version_id": "20.04"}, "Ubuntu 20.04"},
		{"什么都没有返回空串", map[string]string{}, ""},
	}
	for _, c := range cases {
		if got := promOSInfoName(c.m); got != c.want {
			t.Errorf("%s：promOSInfoName(%v) = %q，期望 %q", c.name, c.m, got, c.want)
		}
	}
}

func TestPromOSDistAggregatesAndSorts(t *testing.T) {
	hosts := []promHostStat{
		{OSFamily: "Ubuntu"}, {OSFamily: "Ubuntu"}, {OSFamily: "CentOS"},
		{OSFamily: ""}, // 家族空 →「未知」，不能整台丢掉（丢了图例总数就对不上监控目标数）
	}
	got := promOSDist(hosts)
	want := []promNameVal{
		{Name: "Ubuntu", Value: 2},
		{Name: "CentOS", Value: 1}, // 同数量按名称升序（"CentOS" 的字节序在汉字之前）
		{Name: "未知", Value: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("promOSDist = %+v，期望 %+v", got, want)
	}
	if total := func() int {
		n := 0
		for _, x := range got {
			n += x.Value
		}
		return n
	}(); total != len(hosts) {
		t.Errorf("分布总数 %d 与主机数 %d 不一致 —— 有主机被漏掉了", total, len(hosts))
	}
}

// ---------------------------------------------------------------------------
// 告警趋势
// ---------------------------------------------------------------------------

func TestPromAlertTrendFromSeries(t *testing.T) {
	sets := []promThresholdSeries{
		// CPU：t=100 严重(95)，t=200 正常(10)
		{Series: []promSeries{mkTrendSeries(tsPoint{100, 95}, tsPoint{200, 10})}, Warn: 80, Crit: 90},
		// 内存：t=100 关注(85)，t=200 严重(92)
		{Series: []promSeries{mkTrendSeries(tsPoint{100, 85}, tsPoint{200, 92})}, Warn: 85, Crit: 90},
	}
	got := promAlertTrendFromSeries(sets)
	want := []promAlertTrendPoint{
		{TS: 100, Crit: 1, Warn: 1},
		{TS: 200, Crit: 1, Warn: 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("promAlertTrendFromSeries = %+v，期望 %+v", got, want)
	}
}

func TestPromAlertTrendSkipsZeroValues(t *testing.T) {
	// 阈值配成 0 时，0 值不能被当成「越线」—— PromQL 取不到数据的序列就是 0，
	// 那会把「没采到」统计成海量告警项。
	sets := []promThresholdSeries{
		{Series: []promSeries{mkTrendSeries(tsPoint{100, 0}, tsPoint{100, 0})}, Warn: 0, Crit: 0},
	}
	if got := promAlertTrendFromSeries(sets); len(got) != 0 {
		t.Fatalf("0 值不应产生告警趋势点，实际得到 %+v", got)
	}
}

func TestPromAlertTrendAddOffline(t *testing.T) {
	base := []promAlertTrendPoint{{TS: 100, Crit: 1, Warn: 2}}
	off := []promSeries{mkTrendSeries(tsPoint{100, 3}, tsPoint{200, 1})}
	got := promAlertTrendAddOffline(base, off)
	want := []promAlertTrendPoint{
		{TS: 100, Crit: 4, Warn: 2}, // 离线 3 台并进严重项
		{TS: 200, Crit: 1, Warn: 0}, // 只在离线序列里出现的时间点要补上
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("promAlertTrendAddOffline = %+v，期望 %+v", got, want)
	}

	// 离线序列为空（查询失败）不能改动原值 —— 宁可少算离线，也不能把已有趋势清空
	same := promAlertTrendAddOffline([]promAlertTrendPoint{{TS: 100, Crit: 1, Warn: 2}}, nil)
	if !reflect.DeepEqual(same, []promAlertTrendPoint{{TS: 100, Crit: 1, Warn: 2}}) {
		t.Fatalf("空离线序列不应改动结果，实际 %+v", same)
	}
}

// ---------------------------------------------------------------------------
// 超阈值统计（口径修正）
// ---------------------------------------------------------------------------

func TestPromBuildIssuesStatCountsBeforeTruncation(t *testing.T) {
	cfg := promDefaultConfig() // CPU 关注 80 / 严重 90
	hosts := make([]promHostStat, 0, 5)
	for i := 0; i < 5; i++ {
		hosts = append(hosts, promHostStat{
			Instance: fmt.Sprintf("10.0.0.%d:9100", i),
			System:   "测试项目",
			Up:       true,
			CPU:      99,
		})
	}
	list, st := promBuildIssues(hosts, cfg, 2)
	if len(list) != 2 {
		t.Fatalf("清单应按 limit 截成 2 条，实际 %d 条", len(list))
	}
	// 关键：KPI 用的是统计值，必须是全量 5，不能是截断后的 2
	if st.Crit != 5 || st.Warn != 0 {
		t.Fatalf("严重/关注应为 5/0（截断前全量），实际 %d/%d", st.Crit, st.Warn)
	}
	if st.Hosts != 5 {
		t.Fatalf("涉及主机应为 5，实际 %d", st.Hosts)
	}
	if got := st.ByMetric["cpu"]; got.Crit != 5 || got.Warn != 0 {
		t.Fatalf("byMetric[cpu] 应为 {Warn:0 Crit:5}，实际 %+v", got)
	}
}

func TestPromBuildIssuesDiskBreakdown(t *testing.T) {
	cfg := promDefaultConfig() // 磁盘 关注 85 / 严重 95
	hosts := []promHostStat{
		{Instance: "a:9100", Up: true, Disk: 96}, // 严重
		{Instance: "b:9100", Up: true, Disk: 88}, // 关注
		{Instance: "c:9100", Up: true, Disk: 10}, // 正常，不进统计
	}
	_, st := promBuildIssues(hosts, cfg, 100)
	if got := st.ByMetric["disk"]; got.Crit != 1 || got.Warn != 1 {
		t.Fatalf("byMetric[disk] 应为 {Warn:1 Crit:1}，实际 %+v", got)
	}
	// 左栏「磁盘超阈值」那一格就是读这两个数，不能被其它指标串味
	if st.Crit != 1 || st.Warn != 1 {
		t.Fatalf("总严重/关注应为 1/1，实际 %d/%d", st.Crit, st.Warn)
	}
}

// ---------------------------------------------------------------------------
// 主机计数 / 分组计数 / 配置归一
// ---------------------------------------------------------------------------

func TestPromResourceHostCountAndGroupCounts(t *testing.T) {
	hosts := []promHostStat{
		{System: "A", Department: "D1", CPU: 10},
		{System: "B", Department: "D1", Mem: 20},
		{System: "A", Department: "D2", Disk: 30},
		{System: "C", Department: "", Net: 5}, // 只有网络、没有 CPU/内存/磁盘 → 不算「采到资源」
		{System: "", Department: "D3", CPU: 1},
	}
	if n := promResourceHostCount(hosts); n != 4 {
		t.Fatalf("采到资源的主机数应为 4（第 4 台只有网络不算），实际 %d", n)
	}
	p, d := promGroupCounts(hosts)
	if p != 3 {
		t.Errorf("项目数应为 3（A/B/C），实际 %d", p)
	}
	if d != 3 {
		t.Errorf("部门数应为 3（D1/D2/D3，空部门不计），实际 %d", d)
	}
}

func TestPromNormalizeConfigNetBaseMbps(t *testing.T) {
	// 老数据升级上来没有这个字段 → 0，必须回落默认值。
	// 留着 0 会让 promNetPercent 的分母为 0，整屏网络使用率恒为 0.0%（看着像没数据）。
	c := promDefaultConfig()
	c.NetBaseMbps = 0
	promNormalizeConfig(c)
	if c.NetBaseMbps != 1000 {
		t.Fatalf("0 应回落成默认 1000 Mbps，实际 %d", c.NetBaseMbps)
	}

	c = promDefaultConfig()
	c.NetBaseMbps = 999999
	promNormalizeConfig(c)
	if c.NetBaseMbps != 100000 {
		t.Fatalf("超上限应截到 100000 Mbps，实际 %d", c.NetBaseMbps)
	}

	c = promDefaultConfig()
	c.NetBaseMbps = 10000 // 正常值不能被改动
	promNormalizeConfig(c)
	if c.NetBaseMbps != 10000 {
		t.Fatalf("合法值不应被改写，实际 %d", c.NetBaseMbps)
	}
}
