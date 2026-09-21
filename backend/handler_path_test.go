package main

import "testing"

// TestReSafePath_Unicode 覆盖 v1.7.23 起放开的 Unicode 字母/数字：
// 之前是纯 ASCII 白名单（^/[-A-Za-z0-9_./]+$），中文等服务目录一律打不开。
// 关键不变量必须仍然成立：路径必须以 / 开头；不允许 NUL/控制字符/常见 shell 元字符；
// 「..」防越界由 normalizeScriptPath 单独把关（regex 不防 ../etc/passwd）。
func TestReSafePath_Unicode(t *testing.T) {
	cases := []struct {
		path string
		want bool
		why  string
	}{
		// 必须通过：典型场景
		{"/data/jenkins_home/scripts/Java_Start_Stop_SH", true, "纯英文默认根"},
		{"/data/jenkins_home/scripts/Java_Start_Stop_SH/601-测试环境-后端", true, "中英混合服务目录（截图报错场景）"},
		{"/data/ddddd交通厅督办系统-互联网-测试-督办系统后端-后端-key-p", true, "中文+key 等英文单词"},
		{"/data/restart-测试环境-后端-java", true, "中英混合"},
		{"/a/b/c/d", true, "纯英文短路径"},

		// 必须拒绝：以 / 开头之外的相对路径、含控制字符、含 shell 元字符
		{"data/foo", false, "不以 / 开头（相对路径）"},
		{"/data/../etc/passwd", true, "regex 不防 ..（strings.Contains 兜底；这是预期）"},
		{"/data/foo$bar", false, "含 $（shell 变量插值）"},
		{"/data/foo;rm", false, "含 ;（命令分隔符）"},
		{"/data/foo|bar", false, "含 |（管道）"},
		{"/data/foo&bar", false, "含 &（后台 / 截断）"},
		{"/data/foo<bar", false, "含 <（重定向）"},
		{"/data/foo>bar", false, "含 >（重定向）"},
		{"/data/foo bar", false, "含空格（保持原有安全姿态，不放开）"},
		{"/data/foo`bar`", false, "含反引号（命令替换）"},
		{"/data/foo\nbar", false, "含换行符"},
		{"", false, "空字符串"},

		// 边界：unicode 数字 / 其它字母也要通过（不锁死中文）
		{"/data/abc-123-α-β-①", true, "希腊字母 + Unicode 数字（带 Unicode）"},
	}
	for _, c := range cases {
		got := reSafePath.MatchString(c.path)
		if got != c.want {
			t.Errorf("reSafePath(%q) = %v, want %v  (%s)", c.path, got, c.want, c.why)
		}
	}
}

// TestReSafeName_Unicode 跟 reSafePath 同步放开（创建服务目录时也允许中文）。
// 同样保留安全约束：禁斜杠（防 path 穿越）、禁控制字符、禁 shell 元字符。
func TestReSafeName_Unicode(t *testing.T) {
	cases := []struct {
		name string
		want bool
		why  string
	}{
		{"order-service", true, "纯英文服务名"},
		{"601-测试环境-后端", true, "中文服务名"},
		{"αβ-①", true, "希腊字母 + Unicode 数字"},
		{"", false, "空字符串"},
		{"../etc", false, "含路径分隔符 / 和 .."},
		{"foo/bar", false, "含 /（防 path 穿越）"},
		{"foo bar", false, "含空格"},
		{"foo$bar", false, "含 $"},
		{"foo;bar", false, "含 ;"},
		{"foo\nbar", false, "含换行符"},
		{"foo`bar`", false, "含反引号"},
	}
	for _, c := range cases {
		got := reSafeName.MatchString(c.name)
		if got != c.want {
			t.Errorf("reSafeName(%q) = %v, want %v  (%s)", c.name, got, c.want, c.why)
		}
	}
}