// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import "testing"

// TestNormalizeEnvFilter 大屏 env 过滤的归一化：去 BOM + 去前后空白。
// 这是 v1.7.21 修「详情/报告正常、大屏全 0」的核心：资产 fields 里 "环境" key
// 因 Excel 导入或手工粘贴可能带前导/尾随空白或 UTF-8 BOM（U+FEFF），
// 严格比较会把全部资产漏匹配。
func TestNormalizeEnvFilter(t *testing.T) {
	cases := []struct {
		name string
		in     string
		want string
	}{
		{"干净值", "生产环境", "生产环境"},
		{"前导空格", " 生产环境", "生产环境"},
		{"尾随空格", "生产环境 ", "生产环境"},
		{"两端空格", " 生产环境 ", "生产环境"},
		{"中间空格不受影响", "生产  环境", "生产  环境"},
		{"前导BOM", "\ufeff生产环境", "生产环境"},
		{"尾随BOM", "生产环境\ufeff", "生产环境"},
		{"两端BOM", "\ufeff生产环境\ufeff", "生产环境"},
		{"BOM加空格", " \ufeff生产环境\ufeff ", "生产环境"},
		{"空字符串", "", ""},
		{"只有BOM", "\ufeff", ""},
		{"只有空格", "   ", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := normalizeEnvFilter(c.in)
			if got != c.want {
				t.Errorf("normalizeEnvFilter(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}