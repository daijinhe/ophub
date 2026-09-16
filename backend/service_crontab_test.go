package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// 用户 crontab（`crontab -l` 的输出）任务行判定口径：
//  1. 表达式能通过 validateCron（5 段合法 cron 或受支持的 @ 宏）
//  2. 以 # 开头时 `#` 必须紧贴表达式
//
// 与 /etc/crontab 的关键差异：任务行**没有「运行用户」段**，
// `0 1 * * * /bin/bash a.sh` 里的 `/bin/bash a.sh` 整体就是命令。
func TestSplitUserCronLine(t *testing.T) {
	cases := []struct {
		name    string
		line    string
		wantOK  bool
		enabled bool
		expr    string
		cmd     string
	}{
		{name: "普通任务", line: "0 1 * * * /bin/bash /data/backup.sh",
			wantOK: true, enabled: true, expr: "0 1 * * *", cmd: "/bin/bash /data/backup.sh"},
		{name: "命令不带路径", line: "*/5 * * * * echo hello",
			wantOK: true, enabled: true, expr: "*/5 * * * *", cmd: "echo hello"},
		{name: "带制表符分隔", line: "0\t2\t*\t*\t*\t/bin/bash a.sh",
			wantOK: true, enabled: true, expr: "0 2 * * *", cmd: "/bin/bash a.sh"},
		{name: "禁用行：# 紧贴表达式", line: "#0 1 * * * /bin/bash a.sh",
			wantOK: true, enabled: false, expr: "0 1 * * *", cmd: "/bin/bash a.sh"},
		{name: "@ 宏任务", line: "@reboot /bin/bash boot.sh",
			wantOK: true, enabled: true, expr: "@reboot", cmd: "/bin/bash boot.sh"},
		{name: "@ 宏：@daily", line: "@daily /bin/bash d.sh",
			wantOK: true, enabled: true, expr: "@daily", cmd: "/bin/bash d.sh"},
		{name: "命令保留内部空格", line: "0 3 * * * sh -c 'echo a  b' >> /tmp/x.log",
			wantOK: true, enabled: true, expr: "0 3 * * *", cmd: "sh -c 'echo a  b' >> /tmp/x.log"},
		{name: "命令带重定向", line: "0 1 * * * /data/backup/b.sh > /var/log/backup.log 2>&1",
			wantOK: true, enabled: true, expr: "0 1 * * *", cmd: "/data/backup/b.sh > /var/log/backup.log 2>&1"},
		{name: "周字段用英文缩写", line: "30 6 * * mon /usr/bin/x.sh",
			wantOK: true, enabled: true, expr: "30 6 * * mon", cmd: "/usr/bin/x.sh"},

		// ---- 以下都应**不**判成任务 ----
		{name: "说明性注释（# 后有空格）", line: "# 备份脚本"},
		{name: "注释掉的计划（# 后有空格）", line: "# 0 1 * * * /bin/bash a.sh"},
		{name: "图例：day of month", line: "# |  |  .---------- day of month (1 - 31)"},
		{name: "图例：month", line: "# |  |  |  .------- month (1 - 12) OR jan,feb,mar,apr ..."},
		{name: "图例：user-name 示例行", line: "# *  *  *  *  * user-name  command to be executed"},
		{name: "环境变量 SHELL", line: "SHELL=/bin/bash"},
		{name: "环境变量 PATH", line: "PATH=/sbin:/bin:/usr/sbin:/usr/bin"},
		{name: "环境变量 MAILTO", line: "MAILTO=root"},
		{name: "表达式非法（取值越界）", line: "99 1 * * * /bin/bash a.sh"},
		{name: "表达式非法（段数不足）", line: "0 1 * * /bin/bash a.sh"},
		{name: "不支持的 @ 宏", line: "@every 5m /bin/bash a.sh"},
		{name: "@ 宏后无命令", line: "@reboot"},
		{name: "空行", line: ""},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			expr, cmd, enabled, ok := splitUserCronLine(c.line)
			if ok != c.wantOK {
				t.Fatalf("ok = %v, want %v（line=%q）", ok, c.wantOK, c.line)
			}
			if !ok {
				return
			}
			if enabled != c.enabled {
				t.Errorf("enabled = %v, want %v", enabled, c.enabled)
			}
			if expr != c.expr {
				t.Errorf("expr = %q, want %q", expr, c.expr)
			}
			if cmd != c.cmd {
				t.Errorf("cmd = %q, want %q", cmd, c.cmd)
			}
		})
	}
}

// 说明性注释与发行版模板里的图例都不能被误判成任务 —— 否则每台机器都会
// 凭空多出几条噪声任务。
func TestParseUserCrontabEntries_注释与图例不算任务(t *testing.T) {
	const tmpl = `SHELL=/bin/bash
PATH=/sbin:/bin:/usr/sbin:/usr/bin
MAILTO=root

# For details see man 4 crontabs

# Example of job definition:
# .---------------- minute (0 - 59)
# |  .------------- hour (0 - 23)
# |  |  .---------- day of month (1 - 31)
# |  |  |  .------- month (1 - 12) OR jan,feb,mar,apr ...
# |  |  |  |  .---- day of week (0 - 6) (Sunday=0 or 7) OR sun,mon,tue,wed,thu,fri,sat
# |  |  |  |  |
# *  *  *  *  * user-name  command to be executed
`
	entries := parseUserCrontabEntries(tmpl)
	tasks, others := 0, 0
	for _, e := range entries {
		switch e.Kind {
		case crontabLineTask, crontabLineDisabled:
			tasks++
			t.Errorf("被误判出任务：第 %d 行 %q", e.LineNo, e.Raw)
		default:
			others++
		}
	}
	if tasks != 0 {
		t.Fatalf("应解析出 0 条任务，实际 %d 条", tasks)
	}
	if others == 0 {
		t.Fatal("others 不应为空（环境变量与注释都要保留）")
	}
	if got := len(entries); got != 14 {
		t.Fatalf("行数 = %d, want 14", got)
	}
}

// 真实任务行的分流 + 行号保持（行号是后续增删改的定位依据）
func TestParseUserCrontabEntries_任务行(t *testing.T) {
	const text = `SHELL=/bin/bash
# 备份
0 2 * * * /bin/bash /data/backup.sh

#0 3 * * * /bin/bash disabled.sh
@reboot /bin/bash boot.sh
`
	entries := parseUserCrontabEntries(text)
	type want struct {
		lineNo  int
		kind    string
		enabled bool
	}
	wants := []want{
		{1, crontabLineEnv, false},
		{2, crontabLineComment, false},
		{3, crontabLineTask, true},
		{4, crontabLineBlank, false},
		{5, crontabLineDisabled, false},
		{6, crontabLineTask, true},
	}
	if len(entries) != len(wants) {
		t.Fatalf("条数 = %d, want %d", len(entries), len(wants))
	}
	for i, w := range wants {
		e := entries[i]
		if e.LineNo != w.lineNo || e.Kind != w.kind || e.Enabled != w.enabled {
			t.Errorf("第 %d 条 = {lineNo:%d kind:%s enabled:%v}, want {lineNo:%d kind:%s enabled:%v}",
				i, e.LineNo, e.Kind, e.Enabled, w.lineNo, w.kind, w.enabled)
		}
	}
}

// 渲染 → 解析 必须无损往返（写回 crontab 依赖这个性质）
func TestRenderUserCronLine_往返(t *testing.T) {
	cases := []struct {
		expr, cmd string
		enabled   bool
	}{
		{"0 1 * * *", "/bin/bash /data/backup.sh", true},
		{"0 1 * * *", "/bin/bash /data/backup.sh", false},
		{"*/10 * * * *", "/usr/bin/php /data/a.php --flag=1", true},
		{"@reboot", "/bin/bash boot.sh", true},
		{"@daily", "/bin/bash d.sh", false},
		{"0 3 * * *", "sh -c 'echo a  b' >> /tmp/x.log", true},
	}
	for _, c := range cases {
		line := renderUserCronLine(c.expr, c.cmd, c.enabled)
		expr, cmd, enabled, ok := splitUserCronLine(line)
		if !ok {
			t.Fatalf("渲染出的行无法解析：%q", line)
		}
		if expr != c.expr || cmd != c.cmd || enabled != c.enabled {
			t.Errorf("往返失真：line=%q → {%q %q %v}, want {%q %q %v}",
				line, expr, cmd, enabled, c.expr, c.cmd, c.enabled)
		}
	}
}

// 命令里的 % 要按 crontab 语义转义（下发 \%，回显 %），且不影响其他字符
func TestCronPercentRoundTrip(t *testing.T) {
	line := renderUserCronLine("0 1 * * *", "date +%F >> /tmp/d.log", true)
	if !strings.Contains(line, `\%F`) {
		t.Fatalf("下发时应转义 %%：%q", line)
	}
	_, cmd, _, ok := splitUserCronLine(line)
	if !ok {
		t.Fatalf("转义后的行应仍可解析：%q", line)
	}
	// 组装 crontabEntry 时才会把 \% 还原（见 parseUserCrontabLine）
	if got := unescapeCronPercent(cmd); got != "date +%F >> /tmp/d.log" {
		t.Fatalf("回显应还原为原文，得到 %q", got)
	}
}

// 读取脚本输出的解析：覆盖正常、无 crontab、提权失败、未装 crontab、
// 输出损坏，以及内容里包含平台标记串的极端情况。
func TestParseCrontabRead(t *testing.T) {
	tgt := &crontabTarget{SSHUser: "ituser", RunUser: "root"}

	// 模拟远端脚本输出（与 crontabReadScript 的结构逐字节一致）
	wire := func(rc int, content, stderr string) string {
		b64 := ""
		if content != "" {
			b64 = base64.StdEncoding.EncodeToString([]byte(content))
		}
		var sb strings.Builder
		fmt.Fprintf(&sb, "RC=%d\n%s\n", rc, crontabSep)
		sb.WriteString(b64 + "\n")
		sb.WriteString(crontabErrSep + "\n")
		sb.WriteString(stderr + "\n")
		sb.WriteString(crontabEOF + "\n")
		return sb.String()
	}

	t.Run("正常读取（内容逐字节保留）", func(t *testing.T) {
		const content = "0 0 * * * /data/backup/cleanup_jenkins_hosts.sh\n0 1 * * * /data/backup/jenkins_ansible_backup.sh > /var/log/backup.log 2>&1\n"
		got, exists, err := parseCrontabRead(tgt, wire(0, content, ""))
		if err != nil {
			t.Fatalf("不应报错：%v", err)
		}
		if !exists {
			t.Error("exists 应为 true")
		}
		if got != content {
			t.Fatalf("内容被改动：\n got=%q\nwant=%q", got, content)
		}
	})

	t.Run("rc=0 但内容为空（空 crontab）", func(t *testing.T) {
		got, exists, err := parseCrontabRead(tgt, wire(0, "", ""))
		if err != nil || !exists || got != "" {
			t.Fatalf("got=%q exists=%v err=%v", got, exists, err)
		}
	})

	t.Run("no crontab for root 视为尚无 crontab（非错误）", func(t *testing.T) {
		got, exists, err := parseCrontabRead(tgt, wire(1, "", "no crontab for root"))
		if err != nil {
			t.Fatalf("不应报错：%v", err)
		}
		if exists {
			t.Error("exists 应为 false")
		}
		if got != "" {
			t.Errorf("内容应为空，得到 %q", got)
		}
	})

	// 跨发行版：busybox（Alpine 系）的提示文案与 cronie 完全不同，必须同样识别为
	// 「还没有 crontab」而不是读取失败（实测 Alpine 3.20 的 busybox 1.36.1 输出）
	t.Run("busybox 的 can't open 也视为尚无 crontab（非错误）", func(t *testing.T) {
		got, exists, err := parseCrontabRead(tgt, wire(1, "", "crontab: can't open 'root': No such file or directory"))
		if err != nil {
			t.Fatalf("不应报错：%v", err)
		}
		if exists || got != "" {
			t.Fatalf("exists=%v content=%q，应视作尚无 crontab", exists, got)
		}
	})

	t.Run("用户不存在（crontab: user 'x' unknown）不算尚无 crontab，照实报错", func(t *testing.T) {
		_, _, err := parseCrontabRead(tgt, wire(1, "", "crontab: user 'nosuchuser' unknown"))
		if err == nil {
			t.Fatal("应报错（这是真的配置问题，不是「还没建 crontab」）")
		}
	})

	t.Run("提权失败（两种密码都错）", func(t *testing.T) {
		stderr := "Sorry, try again.\n\nsudo: no password was provided\nsudo: 1 incorrect password attempt"
		_, _, err := parseCrontabRead(tgt, wire(1, "", stderr))
		if err == nil {
			t.Fatal("应返回提权失败错误")
		}
		var pe *crontabPrivError
		if !errors.As(err, &pe) {
			t.Fatalf("应为 crontabPrivError（供密码回退识别），实际 %T：%v", err, err)
		}
	})

	t.Run("目标机未安装 crontab", func(t *testing.T) {
		_, _, err := parseCrontabRead(tgt, wire(127, "", "sh: crontab: command not found"))
		if err == nil || !strings.Contains(err.Error(), "未安装") {
			t.Fatalf("应提示未安装 crontab，实际 %v", err)
		}
	})

	t.Run("其他非零退出码带 stderr", func(t *testing.T) {
		_, _, err := parseCrontabRead(tgt, wire(1, "", "must be privileged to use -u"))
		if err == nil || !strings.Contains(err.Error(), "must be privileged") {
			t.Fatalf("应把 stderr 带出来，实际 %v", err)
		}
	})

	t.Run("输出不完整（缺结束标记）", func(t *testing.T) {
		_, _, err := parseCrontabRead(tgt, "RC=0\n"+crontabSep+"\n")
		if err == nil || !strings.Contains(err.Error(), "不完整") {
			t.Fatalf("应报输出不完整，实际 %v", err)
		}
	})

	t.Run("内容含平台标记串也不串味（base64 传输）", func(t *testing.T) {
		content := "0 1 * * * echo " + crontabErrSep + " > /tmp/x\n"
		got, _, err := parseCrontabRead(tgt, wire(0, content, ""))
		if err != nil {
			t.Fatalf("不应报错：%v", err)
		}
		if got != content {
			t.Fatalf("标记串把内容切坏了：%q", got)
		}
	})
}

// 备份文件名片段必须只含安全字符（资产字段是人工填的，不能直接拼进远端命令）
func TestCrontabBackupToken(t *testing.T) {
	cases := map[string]string{
		"root":        "root",
		"www-data":    "www-data",
		"a;rm -rf /":  "a_rm_-rf__",
		"":            "user",
		"zhang.san_1": "zhang.san_1",
	}
	for in, want := range cases {
		if got := crontabBackupToken(in); got != want {
			t.Errorf("crontabBackupToken(%q) = %q, want %q", in, got, want)
		}
	}
}
