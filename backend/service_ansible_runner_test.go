// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"strings"
	"testing"
)

// TestItoa 验证极简整型→字符串转换
func TestItoa(t *testing.T) {
	cases := []struct {
		in  int
		exp string
	}{
		{0, "0"},
		{1, "1"},
		{22, "22"},
		{65181, "65181"},
		{-1, "-1"},
		{-65181, "-65181"},
		{2147483647, "2147483647"},
	}
	for _, c := range cases {
		if got := itoa(c.in); got != c.exp {
			t.Errorf("itoa(%d)=%q, want %q", c.in, got, c.exp)
		}
	}
}

// TestAnsiblePrefix_基本结构 校验生成的 ansible 前缀顺序与参数。
// 不连真实控制节点，只看拼接出来的命令字串是否符合预期。
func TestAnsiblePrefix_基本结构(t *testing.T) {
	r := &AnsibleRunner{Node: &AnsibleRemote{User: "yyds"}}
	pre := r.ansiblePrefix("192.0.2.5", "", "p@ss", 65181, false, "", false)
	// 关键不变量（顺序由 ansible 解析决定）：
	//   1) mkdir + ANSIBLE_LOCAL_TEMP + ansible <ip> 开头
	//   2) -i <ip>,
	//   3) -u <user> 默认取节点 user
	//   4) -m shell -a （caller 在此之后接 shq(wrapped)）
	//   5) --ssh-extra-args='-o StrictHostKeyChecking=no ...'（单引号整体包裹）
	//   6) 默认不提权
	if !strings.Contains(pre, `ANSIBLE_LOCAL_TEMP="/tmp/.ophub_ansible_${UID:-$(id -u)}/tmp" ansible '192.0.2.5'`) {
		t.Errorf("未用 ANSIBLE_LOCAL_TEMP 局部覆盖：%q", pre)
	}
	if !strings.Contains(pre, "-i '192.0.2.5',") {
		t.Errorf("inventory 行缺失: %q", pre)
	}
	if !strings.HasSuffix(pre, "-m shell -a ") {
		t.Errorf("prefix 必须以 '-m shell -a ' 结尾供 caller 拼接 shellCmd: %q", pre)
	}
	if !strings.Contains(pre, "-u 'yyds'") {
		t.Errorf("未默认取节点 user: %q", pre)
	}
	if !strings.Contains(pre, `--ssh-extra-args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'`) {
		t.Errorf("ssh-extra-args 未整体引号包裹: %q", pre)
	}
	if strings.Contains(pre, "--become") {
		t.Errorf("未要求提权但带了 --become: %q", pre)
	}
}

// TestAnsiblePrefix_提权与脚本模式 校验 become / script 参数进入前缀。
func TestAnsiblePrefix_提权与脚本模式(t *testing.T) {
	r := &AnsibleRunner{Node: &AnsibleRemote{User: "yyds"}}
	// 提权
	pre := r.ansiblePrefix("192.0.2.5", "centos", "p", 22, true, "rp", false)
	if !strings.Contains(pre, "--become --become-method=sudo") {
		t.Errorf("提权参数缺失: %q", pre)
	}
	// shq 转义后单引号呈现为 '\''（shell 风格）
	if !strings.Contains(pre, "ansible_become_pass='rp'") {
		t.Errorf("become 密码未透传: %q", pre)
	}
	if !strings.Contains(pre, "-u 'centos'") {
		t.Errorf("指定 sshUser 未生效: %q", pre)
	}
	if !strings.Contains(pre, "ansible_ssh_port=22") {
		t.Errorf("ssh port 未透传: %q", pre)
	}
	if !strings.Contains(pre, "ansible_ssh_pass='p'") {
		t.Errorf("ssh 密码未透传: %q", pre)
	}
	// 脚本模式（-m script 而不是 -m shell）
	pre2 := r.ansiblePrefix("192.0.2.5", "", "p", 22, false, "", true)
	if !strings.Contains(pre2, "-m script -a ") {
		t.Errorf("脚本模式未生效: %q", pre2)
	}
	if strings.Contains(pre2, "-m shell") {
		t.Errorf("脚本模式与 shell 模式混了: %q", pre2)
	}
}

// TestAnsiblePrefix_免密提权 当 become=true 但 becomePass 为空时，不下发 ansible_become_pass
// （假设 sudo 已 NOPASSWD）。
func TestAnsiblePrefix_免密提权(t *testing.T) {
	r := &AnsibleRunner{Node: &AnsibleRemote{User: "yyds"}}
	pre := r.ansiblePrefix("192.0.2.5", "", "p", 22, true, "", false)
	if !strings.Contains(pre, "--become") {
		t.Errorf("要求提权但未带 --become: %q", pre)
	}
	if strings.Contains(pre, "ansible_become_pass") {
		t.Errorf("免密 sudo 时不应下发 become_pass: %q", pre)
	}
}

// TestResolveAnsibleRunner_空DB 返回 ErrNoAnsibleNode
func TestResolveAnsibleRunner_空DB(t *testing.T) {
	if DB == nil {
		t.Skip("DB 未初始化（CI 单测时跳过）")
	}
	// 清空 ansible_remotes 表是不可能的（其他测试也用），所以仅校验「无匹配 zone」行为
	r, err := ResolveAnsibleRunner("一个不存在的 zone")
	if err != nil {
		t.Fatalf("fallback 到任意节点不应失败：%v", err)
	}
	if r == nil || r.Node == nil {
		t.Error("应返回 fallback 节点")
	}
}

// v1.7.18：目标机没有 python 时 `-m shell` 会失败，且 ansible 只给一句笼统的
// "MODULE FAILURE / See stdout…"。真因在 module_stderr 里，必须一起取出来，
// 否则用户拿到的是无法自查的错误信息（实测 198.51.100.2 就卡在这里）。
func TestAnsiPayload_带出moduleStderr(t *testing.T) {
	raw := `198.51.100.2 | FAILED! => {"changed": false,` +
		`"module_stderr": "/bin/sh: /usr/bin/python: not found\n",` +
		`"module_stdout": "","msg": "MODULE FAILURE\nSee stdout/stderr for the exact error","rc": 127}`
	_, detail, _ := ansiPayload(raw)
	if !strings.Contains(detail, "/usr/bin/python: not found") {
		t.Errorf("detail 里应带上 module_stderr 的真因，实际：%q", detail)
	}
	if !strings.Contains(detail, "MODULE FAILURE") {
		t.Errorf("detail 里应保留 msg，实际：%q", detail)
	}
	if !isAnsiModuleFailure(raw) {
		t.Error("该输出应被识别为「模块没跑起来」（需换 raw 重试）")
	}
}

// UNREACHABLE（网络不通）不能误判成「模块失败」，否则会白白多跑一次 raw 并等超时。
func TestIsAnsiModuleFailure_不可达不算(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"不可达", `192.0.2.9 | UNREACHABLE! => {"msg": "Failed to connect to the host via ssh: timed out"}`, false},
		{"正常输出", `192.0.2.9 | CHANGED | rc=0 | (stdout) __OPHUB_DI__0__OPHUB_DI__`, false},
		{"空", "", false},
		{"老版本 MODULE FAILURE", `192.0.2.9 | FAILED! => {"msg": "MODULE FAILURE"}`, true},
		{"新版文案", `192.0.2.9 | FAILED! => {"msg": "The module failed to execute correctly"}`, true},
	}
	for _, c := range cases {
		if got := isAnsiModuleFailure(c.raw); got != c.want {
			t.Errorf("%s: isAnsiModuleFailure=%v, want %v", c.name, got, c.want)
		}
	}
}

// raw 模块的输出形态（| CHANGED | rc=0 | (stdout) …）必须与 shell 模块一样能解出协议内容，
// 否则「缺 python 自动换 raw」的兜底就是空的。
func TestFinishAdhoc_Raw形态可解析(t *testing.T) {
	// stdout 的 base64 = "ARCH=x86_64\n"
	raw := "192.0.2.9 | CHANGED | rc=0 | (stdout) __OPHUB_DI__0__OPHUB_DI__QVJDSD14ODZfNjQK__OPHUB_DI____OPHUB_DI__\\n"
	out, err := (&AnsibleRunner{}).finishAdhoc(raw, nil)
	if err != nil {
		t.Fatalf("raw 形态应能正常解析：%v", err)
	}
	if strings.TrimSpace(out) != "ARCH=x86_64" {
		t.Errorf("解析出的 stdout=%q", out)
	}
}
