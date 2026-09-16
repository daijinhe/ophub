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
