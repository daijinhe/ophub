// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// 目标机 sudo 提权密码自动解析
//
// 真实故障背景：资源清单里的「超级管理员用户密码」在多数环境填的是 root 账号
// 自己的密码，而 Linux 默认 sudo 策略校验的是**调用者（SSH 登录用户）的密码**。
// 平台若直接把它当作 ansible_become_pass 下发，ansible 会在第一个任务（Gathering
// Facts）就失败，且报错含义隐晦：
//
//	fatal: [platform.internal.example]: FAILED! => {"msg": "Incorrect sudo password"}
//
// 已在真实控制节点上用真实 ansible 复现并验证：把 become_pass 换成 SSH 用户密码后
// `ansible -m command -a 'id -u' -b` 立即返回 rc=0（root）。
//
// crontab 模块早已用「依次试两个密码源」解决同类问题；而部署链路只能把密码写进
// inventory 给一个值，所以这里在执行前**先在目标机上实测**出可用的那个密码，
// 再决定 ansible_become_pass 的取值。
//
// 代价控制：
//   - 结果按「主机 + 端口 + 账号 + 两个密码」指纹缓存，同一台机器后续直接命中，不再 SSH；
//   - 每次探测最多产生一次失败认证（先试的候选若命中则零失败），避免触发 pam_faillock；
//   - 探测失败**不阻断**部署，沿用资源清单原值并在执行日志里明确说明。
// ---------------------------------------------------------------------------

// sudoPassResult 一次提权密码解析的结果
type sudoPassResult struct {
	Pass   string // 应写入 ansible_become_pass 的值（免密时为空字符串）
	Source string // 可读的来源说明（写进执行日志）
	NoPass bool   // 目标机配置了免密 sudo
}

var (
	sudoPassCacheMu sync.RWMutex
	sudoPassCache   = map[string]sudoPassResult{}
)

const sudoPassCacheMax = 4096

// sudoPassKey 提权密码缓存指纹：凭据一改指纹即变，缓存自动失效
func sudoPassKey(host string, port int, user, pass, runUser, adminPass string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		host, strconv.Itoa(port), user, pass, runUser, adminPass,
	}, "\x00")))
	return hex.EncodeToString(sum[:16])
}

// sudoProbeScript 单次 SSH 会话内判定提权密码来源。
// 顺序与 crontab 模块的 privCandidates 保持一致：先「超级管理员用户密码」，
// 失败再回退「SSH 用户密码」（sudo 默认校验调用者密码），最后兜底免密 sudo。
//
// 输出协议：
//   - 成功：__OPHUB_SUDO__=nopass|admin|ssh 一行（与原版一致，调用方可向后兼容）
//   - 失败分支：__OPHUB_SUDO_ERR__=<kind>:<rc>:<stderr>
//     <stderr> 是该分支 sudo 命令捕获到的全部 stderr 文本（去 ANSI 着色、去控制符、限长 400 字节）
//   - 全部失败：__OPHUB_SUDO__=fail（最后兜底）
//
// 多行输出由 platform 解析：第一个 __OPHUB_SUDO__= 行定结果；其后的
// __OPHUB_SUDO_ERR__ 行提供每个失败分支的具体原因用于排错。
//
// 设计要点（v1.6.7 修订）：
//   - 每个分支的退出码通过 `out=$(...); rc=$?` 取得；awk 用 `-v rc=$rc` 显式接收
//     shell 的真实退出码，而不是依赖 awk 内部未定义变量当 0（曾因此让「实际失败」
//     分支误传 rc=0 给平台侧分类逻辑，留下诊断隐患）。
//   - 失败分支的 `__OPHUB_SUDO_ERR__=` 行**始终**输出（不受 if/elif 短路影响），
//     保证 UI 的「详细原因」不会因为某个分支提前 exit 而缺失。
func sudoProbeScript(runUser, adminPass, sshPass string) string {
	q := shq(runUser)
	// sanitize：去 ANSI 着色、控制字符，把多行压成一行再限长
	// （用 tr 而不是 sed -E，避免不同发行版 sed 差异；目标是给前端展示，不需要正则）
	sanitize := "tr -d '\\000-\\010\\013-\\037\\177' | sed 's/\\x1b\\[[0-9;?]*[a-zA-Z]//g; s/[[:space:]]\\+/ /g' | head -c 400"
	parts := []string{
		// Phase 1: 免密 sudo
		`out=$(sudo -n -u ` + q + ` true 2>&1); rc=$?`,
		`if [ "$rc" = 0 ]; then echo __OPHUB_SUDO__=nopass; exit 0; fi`,
		`printf "%s" "$out" | ` + sanitize + ` | awk -v rc=$rc '{printf "__OPHUB_SUDO_ERR__=nopass:%d:%s\\n", rc, $0}'`,
	}
	if strings.TrimSpace(adminPass) != "" {
		parts = append(parts,
			`out=$(echo `+shq(adminPass)+` | sudo -S -p '' -u `+q+` true 2>&1); rc=$?`,
			`if [ "$rc" = 0 ]; then echo __OPHUB_SUDO__=admin; exit 0; fi`,
			`printf "%s" "$out" | `+sanitize+` | awk -v rc=$rc '{printf "__OPHUB_SUDO_ERR__=admin:%d:%s\\n", rc, $0}'`,
		)
	}
	if strings.TrimSpace(sshPass) != "" && strings.TrimSpace(sshPass) != strings.TrimSpace(adminPass) {
		parts = append(parts,
			`out=$(echo `+shq(sshPass)+` | sudo -S -p '' -u `+q+` true 2>&1); rc=$?`,
			`if [ "$rc" = 0 ]; then echo __OPHUB_SUDO__=ssh; exit 0; fi`,
			`printf "%s" "$out" | `+sanitize+` | awk -v rc=$rc '{printf "__OPHUB_SUDO_ERR__=ssh:%d:%s\\n", rc, $0}'`,
		)
	}
	parts = append(parts, `echo __OPHUB_SUDO__=fail`)
	return strings.Join(parts, "; ")
}

// sudoProbeFailureHints 解析探测脚本的输出，从失败分支里抽出「人类可读」的失败原因。
// 每个失败分支按 sudo 实际报错归一到 5 类之一，未识别时回退到原始 stderr。
//
// 5 类（按用户最常踩的概率排序）：
//   - not_in_sudoers：用户在 sudoers 但仍被拒（最常见于配置 Defaults requiretty / secure_path 缺失）
//   - needs_tty     ：sudo 配置了 requiretty（ansible 走非交互通道会失败）
//   - wrong_password：密码错
//   - auth_fail     ：其他认证失败（PAM 失败 / 账户锁定 / 双因素）
//   - unknown       ：其他
func sudoProbeFailureHints(out string) []string {
	var hints []string
	seen := map[string]bool{}
	add := func(s string) {
		if !seen[s] {
			seen[s] = true
			hints = append(hints, s)
		}
	}
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimRight(raw, "\r")
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "__OPHUB_SUDO_ERR__=") {
			continue
		}
		// 格式：__OPHUB_SUDO_ERR__=<kind>:<rc>:<reason>
		rest := strings.TrimPrefix(line, "__OPHUB_SUDO_ERR__=")
		c1 := strings.Index(rest, ":")
		if c1 < 0 {
			continue
		}
		c2 := strings.Index(rest[c1+1:], ":")
		if c2 < 0 {
			continue
		}
		// kind := rest[:c1]
		reason := rest[c1+1+c2+1:]
		// reason 已经被 sanitize 处理过（去 ANSI + 去控制符 + 限长 400 字节），
		// 但还是再 trim 一次，避免尾部空格
		reason = strings.TrimSpace(reason)
		if reason == "" {
			reason = "（sudo 未返回具体错误）"
		}
		// 分类判定（大小写不敏感；含子串即命中，兼容多发行版文案）
		lc := strings.ToLower(reason)
		switch {
		case strings.Contains(lc, "is not in the sudoers file") ||
			strings.Contains(lc, "may not run sudo") ||
			strings.Contains(lc, "not allowed to execute") ||
			strings.Contains(lc, "not in the sudoers") ||
			strings.Contains(lc, "not allowed to use this program"):
			add(fmt.Sprintf("不在 sudoers：%s（请在目标机把 %s 加入 wheel / sudoers）", truncate(reason, 200), userFromOutKind(rest)))
		case strings.Contains(lc, "must have a tty") ||
			strings.Contains(lc, "a terminal is required") ||
			strings.Contains(lc, "terminal is required"):
			add("sudo 要求 tty（ansible 走非交互通道会失败）：在 /etc/sudoers 加 `Defaults:SSH用户 !requiretty`")
		case strings.Contains(lc, "sorry, try again") ||
			strings.Contains(lc, "incorrect password") ||
			strings.Contains(lc, "密码错误") ||
			strings.Contains(lc, "sudo: 1 incorrect password attempt"):
			add(fmt.Sprintf("sudo 密码错误：%s", truncate(reason, 200)))
		case strings.Contains(lc, "authentication failure") ||
			strings.Contains(lc, "auth fail") ||
			strings.Contains(lc, "permission denied") ||
			strings.Contains(lc, "no supported authentication"):
			add(fmt.Sprintf("认证失败：%s", truncate(reason, 200)))
		default:
			add(fmt.Sprintf("目标机拒绝：%s", truncate(reason, 200)))
		}
	}
	return hints
}

// userFromOutKind 从 "<kind>:<rc>:<reason>" 头里把 kind 段拿出来。
// 失败分支中 "admin" 与 "ssh" 区分了密码来源，提示里要带上原始 kind 让用户能识别。
func userFromOutKind(rest string) string {
	c1 := strings.Index(rest, ":")
	if c1 < 0 {
		return "该 SSH 用户"
	}
	kind := rest[:c1]
	switch kind {
	case "admin":
		return "「超级管理员用户密码」对应的 root 账号"
	case "ssh":
		return "SSH 登录账号"
	default:
		return "该 SSH 用户"
	}
}

// truncate 截长字符串，超长补 … 便于日志/UI 单行展示。
func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// resolveSudoPass 实测出可用的 sudo 提权密码（带进程内缓存）。
//
// 2026-09 起探测统一走 ansible 控制节点（runner 非 nil）：平台不再直连目标机，
// 只 SSH 到控制节点执行 `ansible <ip> -m shell -a '<探测脚本>'`。
// runner 为 nil（未配置控制节点）时才回退直连 SSH，仅供历史链路兜底。
//
// 第三个返回值 hint：失败时给出具体的诊断分类（不在 sudoers / 要 tty / 密码错…），
// 调用方把它存到 crontabTarget.PrivHint，再让 mwCaptureAsset / privError 拼进错误消息。
func resolveSudoPass(runner *AnsibleRunner, host string, port int, user, pass, runUser, adminPass string) (sudoPassResult, string, error) {
	if runUser = strings.TrimSpace(runUser); runUser == "" {
		runUser = "root"
	}
	key := sudoPassKey(host, port, user, pass, runUser, adminPass)
	sudoPassCacheMu.RLock()
	if v, ok := sudoPassCache[key]; ok {
		sudoPassCacheMu.RUnlock()
		return v, "", nil
	}
	sudoPassCacheMu.RUnlock()

	probe := sudoProbeScript(runUser, adminPass, pass)
	var (
		out string
		err error
	)
	if runner != nil {
		out, err = runner.Adhoc(host, user, pass, port, probe, false, "", 30*time.Second)
	} else {
		cli := SSHClient{Host: host, Port: port, User: user, Password: pass}
		out, err = cli.RunWithTimeout(probe, 30*time.Second)
	}
	if err != nil && strings.TrimSpace(out) == "" {
		return sudoPassResult{}, "", fmt.Errorf("连接或探测失败：%v", err)
	}

	var res sudoPassResult
	switch {
	case strings.Contains(out, "__OPHUB_SUDO__=nopass"):
		res = sudoPassResult{Pass: "", Source: "免密 sudo（无需密码）", NoPass: true}
	case strings.Contains(out, "__OPHUB_SUDO__=admin"):
		res = sudoPassResult{Pass: adminPass, Source: "「超级管理员用户密码」"}
	case strings.Contains(out, "__OPHUB_SUDO__=ssh"):
		res = sudoPassResult{Pass: pass, Source: "「普通用户密码」（sudo 校验调用者密码）"}
	default:
		// 失败：把每个失败分支的具体 stderr 抽出来分类，给上层写进 PrivHint / 日志。
		// 这样后面 mwCaptureAsset 才能在 UI 上告诉用户「不在 sudoers / 要 tty / 密码错」三选一。
		hints := sudoProbeFailureHints(out)
		var reason string
		if len(hints) > 0 {
			reason = strings.Join(hints, "；")
		} else {
			reason = fmt.Sprintf("目标机未安装 sudo / 未配置 sudoers，或 sshd 拒绝所有凭据（输出前 200 字节：%s）",
				truncate(out, 200))
		}
		return sudoPassResult{}, reason, fmt.Errorf(
			"两个密码源均无法提权：%s。请确认资源清单的「普通用户密码 / 超级管理员用户密码」或为 %s 配置 NOPASSWD 免密 sudo",
			reason, user)
	}

	sudoPassCacheMu.Lock()
	if len(sudoPassCache) >= sudoPassCacheMax {
		sudoPassCache = map[string]sudoPassResult{}
	}
	sudoPassCache[key] = res
	sudoPassCacheMu.Unlock()
	return res, "", nil
}

// resolveZoneSudoPass 为一个网络区域内的全部目标解析 sudo 提权密码，就地写回
// targets[i].BecomePass。返回可直接拼进执行日志的说明行（已排序）。
//
// 该函数必须在写 inventory / 调 ansible_host_manager.py **之前**调用，
// 因为下游（hostConnVars、setupGroupInventory、detectOSCPU）都读 BecomePass。
func resolveZoneSudoPass(targets []deployTargetRow) []string {
	if len(targets) == 0 {
		return nil
	}
	var (
		mu    sync.Mutex
		notes []string
		wg    sync.WaitGroup
	)
	sem := make(chan struct{}, 8) // 有限并发，避免一次性打开过多 SSH 连接
	for i := range targets {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			t := &targets[i]
			runUser := strings.TrimSpace(t.Become)
			if runUser == "" {
				runUser = "root"
			}
			mu.Lock()
			defer mu.Unlock()
			// SSH 登录用户即目标用户 → 本身就是那个账号，无需提权
			if runUser == strings.TrimSpace(t.User) {
				t.BecomePass = ""
				notes = append(notes, fmt.Sprintf("%s → 无需提权（SSH 用户即 %s）", t.IP, runUser))
				return
			}
			port, _ := strconv.Atoi(strings.TrimSpace(t.Port))
			if port <= 0 {
				port = 22
			}
			// 探测通道：与该目标所属网络区域匹配的 ansible 控制节点（平台不直连目标机）
			runner, _ := ResolveAnsibleRunner(strings.TrimSpace(t.Zone))
			res, hint, err := resolveSudoPass(runner, t.IP, port, t.User, t.Pass, runUser, t.BecomePass)
			if err != nil {
				notes = append(notes, fmt.Sprintf("%s → 提权密码实测失败：%s（沿用资源清单原值）", t.IP,
					orDefault(hint, err.Error())))
				return
			}
			if res.NoPass {
				t.BecomePass = ""
			} else {
				t.BecomePass = res.Pass
			}
			notes = append(notes, fmt.Sprintf("%s → %s", t.IP, res.Source))
		}(i)
	}
	wg.Wait()
	sort.Strings(notes)
	return notes
}

// sudoPassNotesBlock 把解析结果拼成一段可读的执行日志
func sudoPassNotesBlock(notes []string) string {
	if len(notes) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("\n🔑 提权密码实测（sudo 校验的是调用者密码，与资源清单字段未必一致）：\n")
	for _, n := range notes {
		sb.WriteString("   " + n + "\n")
	}
	return sb.String()
}
