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
func sudoProbeScript(runUser, adminPass, sshPass string) string {
	q := shq(runUser)
	parts := []string{
		"if sudo -n -u " + q + " true >/dev/null 2>&1; then echo __OPHUB_SUDO__=nopass",
	}
	if strings.TrimSpace(adminPass) != "" {
		parts = append(parts, "elif echo "+shq(adminPass)+" | sudo -S -p '' -u "+q+
			" true >/dev/null 2>&1; then echo __OPHUB_SUDO__=admin")
	}
	if strings.TrimSpace(sshPass) != "" {
		parts = append(parts, "elif echo "+shq(sshPass)+" | sudo -S -p '' -u "+q+
			" true >/dev/null 2>&1; then echo __OPHUB_SUDO__=ssh")
	}
	parts = append(parts, "else echo __OPHUB_SUDO__=fail", "fi")
	return strings.Join(parts, "; ")
}

// resolveSudoPass 实测出可用的 sudo 提权密码（带进程内缓存）。
//
// 2026-09 起探测统一走 ansible 控制节点（runner 非 nil）：平台不再直连目标机，
// 只 SSH 到控制节点执行 `ansible <ip> -m shell -a '<探测脚本>'`。
// runner 为 nil（未配置控制节点）时才回退直连 SSH，仅供历史链路兜底。
func resolveSudoPass(runner *AnsibleRunner, host string, port int, user, pass, runUser, adminPass string) (sudoPassResult, error) {
	if runUser = strings.TrimSpace(runUser); runUser == "" {
		runUser = "root"
	}
	key := sudoPassKey(host, port, user, pass, runUser, adminPass)
	sudoPassCacheMu.RLock()
	if v, ok := sudoPassCache[key]; ok {
		sudoPassCacheMu.RUnlock()
		return v, nil
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
		return sudoPassResult{}, fmt.Errorf("连接或探测失败：%v", err)
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
		return sudoPassResult{}, fmt.Errorf("两个密码源均无法提权，请确认资源清单的「普通用户密码 / 超级管理员用户密码」或为 %s 配置 NOPASSWD 免密 sudo", user)
	}

	sudoPassCacheMu.Lock()
	if len(sudoPassCache) >= sudoPassCacheMax {
		sudoPassCache = map[string]sudoPassResult{}
	}
	sudoPassCache[key] = res
	sudoPassCacheMu.Unlock()
	return res, nil
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
			res, err := resolveSudoPass(runner, t.IP, port, t.User, t.Pass, runUser, t.BecomePass)
			if err != nil {
				notes = append(notes, fmt.Sprintf("%s → 提权密码实测失败，沿用资源清单「超级管理员用户密码」：%v", t.IP, err))
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
