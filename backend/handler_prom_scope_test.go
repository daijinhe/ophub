package main

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// 项目范围过滤（v1.7.38）回归护栏。
//
// 这里守两条底线，两条都是「静默出错」型的坑，靠肉眼看代码发现不了：
//
//  1. **不限项目时必须与老查询逐字节一致**。报表按项目过滤是新增能力，
//     没选项目的老路径不能有任何行为漂移 —— 否则历史口径变了没人知道。
//     这就是为什么 scoped 版本要独立实现、并用本测试钉死等价性
//     （大屏走的是老常量，两边一旦有人只改一边，这里立刻红）。
//
//  2. **项目名必须完整转义**。项目名是用户可控文本，
//     带正则元字符（. * + ( ) |）时，不转义会变成「匹配到别的项目」——
//     比报错更危险：报告会**安静地多统计**一批不该算进来的主机。
func TestPromScopeQueryEquivalence(t *testing.T) {
	cases := []struct {
		name   string
		scoped string
		legacy string
	}{
		{
			name:   "cpu-不限项目",
			scoped: promQLCPUScoped("2h", promNormalizeScope(nil)),
			legacy: promQLCPU("2h"),
		},
		{
			name:   "mem-不限项目",
			scoped: promQLMemScoped(promNormalizeScope([]string{})),
			legacy: promQLMem,
		},
		{
			name:   "disk-不限项目",
			scoped: promQLDiskScoped(promNormalizeScope(nil)),
			legacy: promQLDisk,
		},
		{
			name:   "up-不限项目",
			scoped: promQLUpScoped(promNormalizeScope(nil)),
			legacy: "up",
		},
		{
			name:   "uname-不限项目",
			scoped: promQLUnameScoped(promNormalizeScope(nil)),
			legacy: promQLUname,
		},
	}
	for _, c := range cases {
		if c.scoped != c.legacy {
			t.Errorf("[%s] 不限项目时应与原查询完全一致\n scoped=%s\n legacy=%s", c.name, c.scoped, c.legacy)
		}
	}
}

// 范围值规范化：空白 / 空串 / 重复 / 换行 都不能变成有效的过滤条件
func TestPromNormalizeScope(t *testing.T) {
	got := promNormalizeScope([]string{" ESB ", "", "  ", "ESB", "ONES", "带\n换行"})
	want := []string{"ESB", "ONES"}
	if len(got) != len(want) {
		t.Fatalf("规范化结果不符：got=%#v want=%#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 项不符：got=%#v want=%#v", i, got, want)
		}
	}
	// 全空 → 视为不限项目（返回 nil，而不是空切片，避免调用方判空写法不一致）
	for _, in := range [][]string{nil, {}, {""}, {"  ", "\t"}, {"\n"}} {
		if promNormalizeScope(in) != nil {
			t.Errorf("输入 %#v 应规范化为 nil", in)
		}
	}
}

// 转义正确性。
//
// ⚠️ 这里**不比对字符串字面量的字节**，而是比对「语义」：
// 把生成的 PromQL 字面量按 Prometheus 的规则还原成真正的正则，再断言它等价于
// regexp.QuoteMeta(原文)。理由：转义要过两道（正则 + PromQL 字符串字面量），
// 数反斜杠个数极易数错 —— 写死字节期望值只会把「我数错了」固化成测试用例，
// 而字面量多一个/少一个反斜杠，在 Prometheus 侧就是「解析失败」或「匹配到别的项目」。
//
// PromQL 的双引号字符串与 Go 字符串字面量转义规则一致，所以直接用 strconv.Unquote。
func promScopeLabelRegex(t *testing.T, label string) string {
	t.Helper()
	const prefix = `system=~"`
	if !strings.HasPrefix(label, prefix) || !strings.HasSuffix(label, `"`) {
		t.Fatalf("匹配器形态不符（应为 system=~\"...\"）：%s", label)
	}
	q := label[len(prefix)-1:] // 含首尾引号，交给 strconv.Unquote 还原转义
	s, err := strconv.Unquote(q)
	if err != nil {
		t.Fatalf("不是合法的 PromQL 字符串字面量（Prometheus 会直接解析失败）：%s err=%v", q, err)
	}
	return s
}

func TestPromScopeLabelEscaping(t *testing.T) {
	// 覆盖真实项目名里出现过的形态 + 正则元字符 + 需要 PromQL 字面量转义的字符
	names := []string{
		"ESB",
		"601监测预警平台",
		"pm2.5空气质量查询", // '.' 不转义会变成「任意字符」
		"a|b",         // '|' 不转义会把一个项目名拆成两个
		"c++",
		"(国办)中考成绩查询接口",
		"系统[1]{2}",
		`say"hi`, // 双引号：必须按 PromQL 字面量转义
		`a\b`,    // 反斜杠：两道转义叠加
		"带 空格 的项目",
	}
	for _, raw := range names {
		lbl := promScopeLabel([]string{raw})
		got := promScopeLabelRegex(t, lbl)
		want := regexp.QuoteMeta(raw)
		if got != want {
			t.Errorf("项目名 %q 还原后的正则不符\n got=%q\nwant=%q\n(字面量=%s)", raw, got, want, lbl)
		}
		// Prometheus 的 =~ 是整体锚定的，这里也锚定，保证与线上行为一致
		re, err := regexp.Compile("^(?:" + got + ")$")
		if err != nil {
			t.Fatalf("项目名 %q 生成的正则无法编译：%v", raw, err)
		}
		if !re.MatchString(raw) {
			t.Errorf("项目名 %q 生成的正则匹配不到自己：%s", raw, got)
		}
	}

	// 「差不多但不同」的名字绝不能被匹配到 —— 这是本功能最危险的失效模式：
	// 报告会安静地把不属于该项目的主机算进来，没人会发现。
	nearMiss := []struct{ scope, other string }{
		{"pm2.5空气质量查询", "pm2X5空气质量查询"}, // '.' 被正确转义的关键证据
		{"a|b", "a"},
		{"a|b", "b"},
		{"ESB", "ESB2"},
		{"ESB", "ES"},
		{"系统[1]{2}", "系统1{2}"},
	}
	for _, c := range nearMiss {
		got := promScopeLabelRegex(t, promScopeLabel([]string{c.scope}))
		re := regexp.MustCompile("^(?:" + got + ")$")
		if re.MatchString(c.other) {
			t.Errorf("范围 %q 的正则 %s 误匹配了 %q", c.scope, got, c.other)
		}
	}

	// 多项目：'|' 用于**连接**，项目名内部的 '|' 必须保持字面量
	got := promScopeLabelRegex(t, promScopeLabel([]string{"a|b", "ESB"}))
	re := regexp.MustCompile("^(?:" + got + ")$")
	if !re.MatchString("a|b") || !re.MatchString("ESB") {
		t.Errorf("多项目正则应同时匹配两个项目名：%s", got)
	}
	if re.MatchString("a") || re.MatchString("b") {
		t.Errorf("多项目正则不应匹配被拆开的半个项目名：%s", got)
	}
	if re.MatchString("a|b|ESB") {
		t.Errorf("多项目正则不应匹配拼接后的整串：%s", got)
	}

	// 选择器后缀形态
	if promScopeSel(nil) != "" {
		t.Error("不限项目时选择器后缀应为空（保证与原查询逐字节一致）")
	}
	if !strings.HasPrefix(promScopeSel([]string{"ESB"}), "{system=~") {
		t.Error("选择器后缀应形如 {system=~\"...\"}")
	}
}

// 过滤条件必须落在**所有**指标选择器上：漏一个就会出现
// 「按项目出的报告里，磁盘是全集群的口径」这类口径混乱。
func TestPromScopedQueriesCarryFilter(t *testing.T) {
	scope := []string{"ESB"}
	for _, c := range []struct{ name, q string }{
		{"cpu", promQLCPUScoped("2h", scope)},
		{"mem", promQLMemScoped(scope)},
		{"disk", promQLDiskScoped(scope)},
		{"up", promQLUpScoped(scope)},
		{"uname", promQLUnameScoped(scope)},
	} {
		if !strings.Contains(c.q, `system=~"ESB"`) {
			t.Errorf("[%s] 未携带项目过滤：%s", c.name, c.q)
		}
	}
	// 磁盘查询有两个选择器（avail / size），两个都要带上
	if n := strings.Count(promQLDiskScoped(scope), `system=~"ESB"`); n != 2 {
		t.Errorf("磁盘查询应有两个选择器都带过滤，实际 %d 个：%s", n, promQLDiskScoped(scope))
	}
	// cpu 的选择器里必须同时保留 mode="idle"
	if !strings.Contains(promQLCPUScoped("2h", scope), `mode="idle",system=~"ESB"`) {
		t.Errorf("cpu 查询应保留 mode 条件：%s", promQLCPUScoped("2h", scope))
	}
	// 磁盘必须保留伪文件系统排除规则
	if !strings.Contains(promQLDiskScoped(scope), `fstype!~"tmpfs`) {
		t.Errorf("磁盘查询应保留 fstype 排除规则：%s", promQLDiskScoped(scope))
	}
}
