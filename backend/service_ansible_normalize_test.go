// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/base64"
	"os/exec"
	"strings"
	"testing"
)

// TestAdhocWrapper_生成与解析闭环 用本机 sh 真跑一遍 wrapper，再喂给解析函数。
//
// 这条测试是「生成器 ↔ 解析器」的契约测试：手工拼 payload 的单测曾经掩盖了
// 「rc 与 stdout 之间漏了分隔符」的缺陷（线上表现为 stdout 永远为空且不报错）。
func TestAdhocWrapper_生成与解析闭环(t *testing.T) {
	// 注意用 %s 而非把内容当格式串：要保证输出的字节就是字面 `\d`、`C:\temp`
	cmd := `printf '%s\n' 'RC=0' 'RE1=\d+' 'RE2=C:\temp\new'; printf 'err\ttab\n' >&2; exit 3`
	wrapper := buildAdhocWrapper(cmd)
	// 结构固定：<SEP><rc><SEP><out><SEP><err><SEP>
	if n := strings.Count(wrapper, adhocProtocolSep); n != 4 {
		t.Fatalf("wrapper 分隔符数=%d，want 4（rc 后必须补分隔符）：%q", n, wrapper)
	}
	out, err := exec.Command("sh", "-c", wrapper).Output()
	if err != nil {
		t.Fatalf("本地执行 wrapper 失败：%v（wrapper 应以 0 退出）", err)
	}
	stdout, stderr, rc, ok := decodeAdhocPayload(string(out))
	if !ok {
		t.Fatalf("协议解析失败：%q", string(out))
	}
	if rc != 3 {
		t.Errorf("rc=%d，want 3", rc)
	}
	wantOut := "RC=0\nRE1=\\d+\nRE2=C:\\temp\\new\n"
	if stdout != wantOut {
		t.Errorf("stdout 未无损还原：\n got=%q\nwant=%q", stdout, wantOut)
	}
	if stderr != "err\ttab\n" {
		t.Errorf("stderr 未无损还原：%q", stderr)
	}
}

// TestAdhocWrapper_空输出 空 stdout / 空 stderr 时字段仍要对齐
func TestAdhocWrapper_空输出(t *testing.T) {
	wrapper := buildAdhocWrapper("true")
	out, err := exec.Command("sh", "-c", wrapper).Output()
	if err != nil {
		t.Fatalf("执行 wrapper 失败：%v", err)
	}
	stdout, stderr, rc, ok := decodeAdhocPayload(string(out))
	if !ok {
		t.Fatalf("解析失败：%q", string(out))
	}
	if rc != 0 || stdout != "" || stderr != "" {
		t.Errorf("rc=%d stdout=%q stderr=%q，want 0/\"\"/\"\"", rc, stdout, stderr)
	}
}

// TestAdhoc三段式协议_无损 验证 stdout / stderr 里出现换行、制表符、反斜杠、
// 单引号等「转义敏感」字符时，经 ansible 压行后仍能逐字节还原。
//
// 这是本模块最要紧的一条：ansible 把真实换行压成字面 `\n`，且**不会**同时把
// 数据里本就存在的 `\t` / `\n` 转义 —— 也就是说「直接还原换行」有歧义
// （`C:\temp` 会被误还原成制表符）。三段式协议通过 base64 化彻底规避。
func TestAdhoc三段式协议_无损(t *testing.T) {
	cmd := "echo hi"
	wrapper := buildAdhocWrapper(cmd)
	if !strings.Contains(wrapper, "base64 -d | bash") {
		t.Fatalf("wrapper 未包含命令执行段：%q", wrapper)
	}
	if !strings.Contains(wrapper, adhocProtocolSep) {
		t.Fatalf("wrapper 未包含协议分隔符：%q", wrapper)
	}
	// 命令体必须被 base64（避免命令里的单引号 / 换行破坏 wrapper）
	if strings.Contains(wrapper, cmd) {
		t.Errorf("命令体未编码：%q", wrapper)
	}

	// 模拟目标机回传：stdout 含换行 / 反斜杠序列，stderr 非空
	stdout := "RC=0\n__OPHUB_SEP__\nRE1=\\d+\nRE2=C:\\temp\\new\n"
	stderr := "Warning: something\ttabbed\n"
	payload := adhocProtocolSep + "0" + adhocProtocolSep +
		base64.StdEncoding.EncodeToString([]byte(stdout)) + adhocProtocolSep +
		base64.StdEncoding.EncodeToString([]byte(stderr)) + adhocProtocolSep

	gotOut, gotErr, rc, ok := decodeAdhocPayload(payload)
	if !ok {
		t.Fatal("协议解析失败")
	}
	if rc != 0 {
		t.Errorf("rc=%d，want 0", rc)
	}
	if gotOut != stdout {
		t.Errorf("stdout 未被逐字节还原：\n got=%q\nwant=%q", gotOut, stdout)
	}
	if gotErr != stderr {
		t.Errorf("stderr 未被逐字节还原：\n got=%q\nwant=%q", gotErr, stderr)
	}
	if !strings.Contains(gotOut, `C:\temp\new`) {
		t.Errorf("反斜杠序列被破坏：%q", gotOut)
	}
}

// TestDecodeAdhocPayload_非零退出码 退出码要能带出来（业务层据此判断提权失败重试）
func TestDecodeAdhocPayload_非零退出码(t *testing.T) {
	payload := adhocProtocolSep + "1" + adhocProtocolSep +
		base64.StdEncoding.EncodeToString([]byte("")) + adhocProtocolSep +
		base64.StdEncoding.EncodeToString([]byte("sudo: no password was provided")) + adhocProtocolSep
	_, stderr, rc, ok := decodeAdhocPayload(payload)
	if !ok || rc != 1 {
		t.Fatalf("ok=%v rc=%d，want ok=true rc=1", ok, rc)
	}
	if !strings.Contains(stderr, "no password") {
		t.Errorf("stderr 丢失：%q", stderr)
	}
	// 协议内容缺失时要能识别（命令根本没跑起来）
	if _, _, _, ok := decodeAdhocPayload("192.0.2.9 | UNREACHABLE! => {}"); ok {
		t.Error("无协议内容时不应判定为 ok")
	}
}

// TestAnsiPayload_单行形态 校验 ansible-core 2.16+ 的
// `host | CHANGED | rc=0 | (stdout) <转义后的内容>` 能被剥壳并标记为需还原。
func TestAnsiPayload_单行形态(t *testing.T) {
	raw := `platform.internal.example | CHANGED | rc=0 | (stdout) RC=0\n__OPHUB_SEP__\nWyB4IF0=\n` + "\n"
	p, detail, escaped := ansiPayload(raw)
	if !escaped {
		t.Error("单行形态应标记为 escaped")
	}
	if detail != "" {
		t.Errorf("正常输出不应带 detail：%q", detail)
	}
	want := "RC=0\n__OPHUB_SEP__\nWyB4IF0="
	// 脚本自身的收尾换行也会被压成字面 \n（这里正是它的用途：还原成真实换行）
	if got := strings.TrimRight(unescapeAnsiEscapes(p), "\n"); got != want {
		t.Errorf("还原后错误：\n got=%q\nwant=%q", got, want)
	}
	var lines []string
	for _, ln := range strings.Split(unescapeAnsiEscapes(p), "\n") {
		if strings.TrimSpace(ln) != "" {
			lines = append(lines, ln)
		}
	}
	if len(lines) != 3 {
		t.Errorf("有效行数=%d，want 3（%q）", len(lines), lines)
	}
}

// TestAnsiPayload_结果dict 校验 `-m script` / 失败结果的 JSON dict 形态（无损）
func TestAnsiPayload_结果dict(t *testing.T) {
	raw := `platform.internal.example | CHANGED => {"changed": true,"rc": 0,` +
		`"stderr": "Warning: Permanently added '[platform.internal.example]:65181' (ECDSA) to the list of known hosts.\r\n",` +
		`"stdout": "RE1=\\d+\r\nRE2=C:\\temp\\new\r\n","stdout_lines": []}`
	p, _, escaped := ansiPayload(raw)
	if escaped {
		t.Error("dict 形态是 JSON 反转义，不应再走压行还原")
	}
	want := "RE1=\\d+\r\nRE2=C:\\temp\\new\r\n"
	if p != want {
		t.Errorf("stdout 还原错误：\n got=%q\nwant=%q", p, want)
	}
	if !strings.Contains(p, `C:\temp\new`) || !strings.Contains(p, `\d+`) {
		t.Errorf("反斜杠被破坏：%q", p)
	}
}

// TestAnsiPayload_失败原因 不可达 / 失败时 msg、stderr 要进 detail
func TestAnsiPayload_失败原因(t *testing.T) {
	raw := `192.0.2.9 | UNREACHABLE! => {"changed": false,"msg": "Failed to connect to the host via ssh: Permission denied","unreachable": true}`
	p, detail, _ := ansiPayload(raw)
	if p != "" {
		t.Errorf("不可达时不应有 payload：%q", p)
	}
	if !strings.Contains(detail, "Permission denied") {
		t.Errorf("detail 未带出原因：%q", detail)
	}
}

// TestAnsiPayload_无输出状态行 只有状态行时不能把状态行当输出
func TestAnsiPayload_无输出状态行(t *testing.T) {
	for _, raw := range []string{
		"platform.internal.example | CHANGED | rc=0",
		"platform.internal.example | SUCCESS",
		"",
		"   ",
	} {
		p, _, _ := ansiPayload(raw)
		if p != "" {
			t.Errorf("raw=%q 应无输出，实际=%q", raw, p)
		}
	}
}

// TestAnsiPayload_老版本形态 兼容 `host | CHANGED | rc=0 >>` + 真实换行
func TestAnsiPayload_老版本形态(t *testing.T) {
	raw := "platform.internal.example | CHANGED | rc=0 >>\nARCH=x86_64\nNPROC=4\n"
	p, _, escaped := ansiPayload(raw)
	if escaped {
		t.Error("老版本形态是真实换行，不应标记为 escaped")
	}
	if p != "ARCH=x86_64\nNPROC=4" {
		t.Errorf("还原错误：%q", p)
	}
}

// TestUnescapeAnsiEscapes_只还原三个转义 确认不会吃掉数据本身的反斜杠
func TestUnescapeAnsiEscapes_只还原三个转义(t *testing.T) {
	cases := []struct{ in, want string }{
		{`a\nb`, "a\nb"},
		{`a\rb`, "a\rb"},
		{`a\db`, `a\db`}, // sed 风格的 \d 必须原样保留
		{`a\wb`, `a\wb`},
		{`no-escape`, "no-escape"},
	}
	for _, c := range cases {
		if got := unescapeAnsiEscapes(c.in); got != c.want {
			t.Errorf("unescapeAnsiEscapes(%q)=%q，want %q", c.in, got, c.want)
		}
	}
}

// TestEnsureShebang 补 shebang（ansible `-m script` 直接执行文件，缺 shebang 有风险）
func TestEnsureShebang(t *testing.T) {
	if got := string(ensureShebang([]byte("echo hi\n"))); got != "#!/bin/sh\necho hi\n" {
		t.Errorf("未补 shebang：%q", got)
	}
	if got := string(ensureShebang([]byte("#!/bin/bash\necho hi\n"))); got != "#!/bin/bash\necho hi\n" {
		t.Errorf("已有 shebang 不应重复补：%q", got)
	}
}

// TestComposeTargetScript 校验 ansible `-m script` 场景下的自我提权包装
func TestComposeTargetScript(t *testing.T) {
	// 无前缀：原样返回
	if got := composeTargetScript("", "root", "echo hi\n"); got != "echo hi\n" {
		t.Errorf("无提权前缀时不应包装：%q", got)
	}
	// 有前缀：插入自我再执行守卫，并用 $0 指回自身
	pre := "echo 'pw' | sudo -S -p '' -u root "
	got := composeTargetScript(pre, "root", "echo hi\n")
	if !strings.Contains(got, `if [ "$(id -un 2>/dev/null)" != 'root' ]; then`) {
		t.Errorf("缺少用户判定守卫：%q", got)
	}
	if !strings.Contains(got, `sudo -S`) || !strings.Contains(got, `sh "$0"`) {
		t.Errorf("未用提权前缀重新执行自身：%q", got)
	}
	if !strings.Contains(got, "exit $?") {
		t.Errorf("缺少退出码透传：%q", got)
	}
	if !strings.HasSuffix(got, "echo hi\n") {
		t.Errorf("正文被破坏：%q", got)
	}
	// runUser 为空时按默认 root 兜底
	got2 := composeTargetScript(pre, "", "echo hi\n")
	if !strings.Contains(got2, `!= 'root'`) {
		t.Errorf("runUser 为空未兜底 root：%q", got2)
	}
}
