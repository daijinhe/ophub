package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ============================================================================
// AnsibleRunner：平台「获取虚拟机信息」的唯一执行通道。
//
// 历史背景：2026-09 之前，crontab 读取、calibrate、mwCapture、nginx 扫描等
// 所有采集类都是平台 SSHClient 直连目标机，对纳管资产 SSH 用户/密码零碎依赖；
// 9KB 中间件捕捉脚本还要走 SSHClient.RunBigScript 的「分段 base64 + bash」
// 分桶路径（Huawei Cloud EulerOS aarch64 + OpenSSH 8.8p1 实测 sshd argv 限制
// 约 1.2KB，超出直接 reset TCP）。
//
// 2026-09 切换口径，**所有采集类**统一走 ansible ad-hoc：平台 SSH 到一个
// ansible 控制节点，由控制节点上的 ansible 命令（-m shell / -m script）执行
// 目标机上的采集动作。这样做的好处：
//   1. ansible -m script 自带 SCP 通道（控制节点 → 目标机），取代 RunBigScript
//      的手写分桶逻辑
//   2. 提权、SSH 公参（StrictHostKeyChecking 等）由 ansible inventory vars
//      统一管理，避免每处业务各自拼 sudo / ssh 参数
//   3. 任何业务的 SSH 调用都被收敛到一个 client.RunWithTimeout，运维侧
//      出问题只看一处
//
// 设计原则：
//   - **不引入 Go SDK**（go-ansible / ansible-runner）：体量吃不下、且与
//     现有的「平台 SSH 到控制节点执行 ansible CLI」套路冲突
//   - **保留直 SSH 兜底**：AnsibleRunner.AdHoc 失败时，业务层可选择重试直
//     SSH；但默认走 ansible，符合用户「所有采集都走 ansible」的口径
//   - **超阈脚本走 -m script**：> 2KB base64 整串直接灌 -m shell -a 会
//     撞 sshd argv 限制，统一走 Script() 路径：先 SCP 到控制节点，再 -m script
//
// 2026-09-20 v1.7.10 扩展：新增 `Mode = "local"` 走本机 ansible。
// 背景：内网部署的服务器本身装了 ansible（/usr/bin/ansible + /etc/ansible/hosts），
// 没必要再 SSH 到远端控制节点 —— 反而多一跳 SSH 鉴权。Local 模式：
// Adhoc/Script/Reachable 直接 exec 容器内的 ansible 二进制（要求镜像装 ansible，
// 见 backend/Dockerfile），不走 SSHClient。Mode 是策略，调用方拿到 *AnsibleRunner 后
// 无感。ResolveAnsibleRunner 优先尝试 Local（如果本机 ansible 可用），否则按 zone 匹配 Remote。
//
// 与现有 SSHClient 的关系：SSHClient 仍负责「到控制节点」的连接；
// SSHClient 不能再被业务层直接用于「采集」目的——所有采集入口
// （crontab / calibrate / mwCapture / nginx / mwOps）都通过 AnsibleRunner
// 间接使用 SSHClient 跑 ansible 命令。
// ============================================================================

// ansibleRunnerMode runner 执行模式
const (
	runnerModeLocal  = "local"  // 本机模式：直接在 backend 容器内 exec ansible
	runnerModeRemote = "remote" // 远端模式：SSH 到 ansible_remotes 控制节点上跑 ansible
)

// AnsibleRunner 单一职责：在 ansible 控制节点（或本机）上为指定目标机跑命令/脚本。
//
// Mode=remote 时 Node 非 nil；Mode=local 时 Node 为 nil。Adhoc/Script/Reachable
// 根据 Mode 分发。调用方拿到 runner 后照旧调三个方法，无需关心模式。
type AnsibleRunner struct {
	Mode string         // "local" / "remote"
	Node *AnsibleRemote // 仅 remote 模式使用
}

// ErrNoAnsibleNode 没有匹配 ansible 控制节点且本机 ansible 也不可用时返回
var ErrNoAnsibleNode = errors.New("未匹配到 ansible 控制节点（本机 ansible 也不可用）")

// localRunnerProbe 本机 ansible 可用性探测缓存：30s 内复用同一结果，避免每次采集都 exec。
var (
	localRunnerProbeMu  sync.Mutex
	localRunnerProbeOK  bool
	localRunnerProbeErr error
	localRunnerProbeAt  time.Time
)

// probeLocalAnsible 检查容器内 ansible 是否可用：
//   1) sshpass 在 PATH（密码认证硬依赖）
//   2) `ansible --version` 能跑（说明二进制装了）
//   3) ANSIBLE_HOSTS 路径下文件可读（不必非空，用户可以自己填）
func probeLocalAnsible() (bool, error) {
	localRunnerProbeMu.Lock()
	defer localRunnerProbeMu.Unlock()
	if !localRunnerProbeAt.IsZero() && time.Since(localRunnerProbeAt) < 30*time.Second {
		return localRunnerProbeOK, localRunnerProbeErr
	}
	localRunnerProbeAt = time.Now()
	localRunnerProbeErr = nil
	// sshpass 是 ansible 密码认证的硬依赖（采集通道 Adhoc 全部带 ansible_ssh_pass），
	// 缺了它本机模式每条命令都会失败 —— 直接判本机不可用，回退远端控制节点。
	// 实测踩坑：v1.7.11/12 镜像装了 ansible 却没装 sshpass，资源校准全量 500。
	if _, lookErr := exec.LookPath("sshpass"); lookErr != nil {
		localRunnerProbeErr = fmt.Errorf("容器内缺 sshpass（ansible 密码认证依赖）：%v", lookErr)
		localRunnerProbeOK = false
		return false, localRunnerProbeErr
	}
	cmd := exec.Command("ansible", "--version")
	out, err := cmd.CombinedOutput()
	if err != nil {
		localRunnerProbeErr = fmt.Errorf("ansible --version 失败：%v（输出：%s）", err, trimTail(string(out), 200))
		localRunnerProbeOK = false
		return false, localRunnerProbeErr
	}
	hostsPath := Cfg.AnsibleHosts
	if _, statErr := os.Stat(hostsPath); statErr != nil && !os.IsNotExist(statErr) {
		localRunnerProbeErr = fmt.Errorf("ansible hosts 路径不可访问：%v", statErr)
		localRunnerProbeOK = false
		return false, localRunnerProbeErr
	}
	localRunnerProbeOK = true
	return localRunnerProbeOK, nil
}

// ResolveAnsibleRunner 按以下顺序解析：
//   1. 本机 ansible 可用 → 返回 Local 模式（不要求任何 zone 匹配，零 SSH 跳数）
//   2. zone 非空时优先按 zone 匹配 ansible_remotes；没有则 fallback 到 id asc 第一条
//   3. 全无 → ErrNoAnsibleNode
//
// 与之前行为兼容：zone=="" 时优先 local，没 local 才退到 id asc 第一条；
// zone 非空时优先 local，没 local 才按 zone 匹配；保持「最低惊讶」。
//
// 调用方拿到 runner 后照旧调 Adhoc/Script/Reachable，无需关心 Mode。
func ResolveAnsibleRunner(zone string) (*AnsibleRunner, error) {
	if ok, _ := probeLocalAnsible(); ok {
		return &AnsibleRunner{Mode: runnerModeLocal}, nil
	}
	var list []AnsibleRemote
	q := DB.Order("id asc")
	if zone = strings.TrimSpace(zone); zone != "" {
		// 先找同 zone，没有则 fallback 到任意一台（最低惊讶原则）
		var same []AnsibleRemote
		if err := q.Where("network_zone = ?", zone).Find(&same).Error; err == nil && len(same) > 0 {
			return &AnsibleRunner{Mode: runnerModeRemote, Node: &same[0]}, nil
		}
	}
	if err := q.Find(&list).Error; err != nil {
		return nil, fmt.Errorf("查询 ansible 控制节点失败：%v", err)
	}
	if len(list) == 0 {
		return nil, ErrNoAnsibleNode
	}
	return &AnsibleRunner{Mode: runnerModeRemote, Node: &list[0]}, nil
}

// adHocCmdBytes ad-hoc 命令总长度阈值（控制节点 → 目标机的 ansible 命令本身走
// 控制节点的 ssh 通道，整条命令长度不能撞 sshd argv 限制）。阈值保守取 2KB：
// 阈值以上必须走 Script()，不要试图拼超长 -a。
const adHocCmdBytes = 2000

// Adhoc 通过控制节点执行 `ansible <ip> -i <ip>, -m shell -a '<shellCmd>'`。
//
// shellCmd 太长时（base64 编码后总长度超过 adHocCmdBytes）会自动切换为
// Script() 路径：先 base64 推到控制节点 /tmp/.ophub_collect_<rand>.sh，
// 再 -m script 跑它。透明切换，业务层不用关心。
//
// 参数：
//   - ip          目标机 IP（同时作 inventory 主机名）
//   - sshUser/Pass/Port   目标机的 SSH 凭据（IP 由 ip 字段直传；通过
//     -e ansible_ssh_pass / ansible_ssh_port 注入）
//   - shellCmd    在目标机上跑的 shell 命令
//   - become/becomePass   是否提权及 sudo 密码（走 --become + ansible_become_pass）
//   - timeout     控制 SSH 到控制节点 + ansible 调用的总超时
//
// 返回 stdout 与 err。ansible 自身调用失败（控制节点不可达 / 目标机不通 /
// shellCmd 非零退出）都会带 stderr 一起返回。
func (r *AnsibleRunner) Adhoc(ip, sshUser, sshPass string, sshPort int, shellCmd string,
	become bool, becomePass string, timeout time.Duration) (string, error) {
	if r == nil {
		return "", ErrNoAnsibleNode
	}
	// 本机模式：容器内直接 exec ansible（localAdhoc 内部同样走三段式协议）。
	// ⚠️ 实测 v1.7.10~13 这里漏了本机分支，Node==nil 直接返回 ErrNoAnsibleNode，
	// 导致本机模式下所有 Adhoc 采集（校准/巡检/定时任务）全量失败。
	if r.Mode == runnerModeLocal {
		ip = strings.TrimSpace(ip)
		if ip == "" {
			return "", fmt.Errorf("目标机 IP 为空")
		}
		if sshPort == 0 {
			sshPort = 22
		}
		return r.localAdhoc(ip, sshUser, sshPass, sshPort, shellCmd, become, becomePass, timeout)
	}
	if r.Node == nil {
		return "", ErrNoAnsibleNode
	}
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return "", fmt.Errorf("目标机 IP 为空")
	}
	if sshPort == 0 {
		sshPort = 22
	}
	// 命令体走 base64 传输（可能含任意字符，包括单引号），并套一层
	// 「rc + stdout + stderr」三段式回传协议 —— 见 buildAdhocWrapper 的说明。
	wrapped := buildAdhocWrapper(shellCmd)
	// 计算预估总长度：
	//   ansible <ip> -i <ip>, -m shell -a '<wrapped>' -u <user>
	//   -e ansible_ssh_pass=<x> -e ansible_ssh_port=<n>
	//   [--become --become-method=sudo -e ansible_become_pass=<y>]
	//   -o
	pre := r.ansiblePrefix(ip, sshUser, sshPass, sshPort, become, becomePass, false)
	total := len(pre) + len(shq(wrapped)) + 4 // +4 for ' -o'
	if total <= adHocCmdBytes {
		cmd := pre + shq(wrapped) + " -o"
		raw, err := r.Node.ToSSHClient().RunWithTimeout(cmd, timeout)
		return r.finishAdhoc(raw, err)
	}
	// 太长：退化为 Script 路径
	return r.pushAndScript(ip, sshUser, sshPass, sshPort, []byte(shellCmd),
		become, becomePass, timeout)
}

// Script 直接走 Script 路径：业务层知道 shellCmd 是大脚本时显式调用，
// 不用 Adhoc 内部的「太长自动切」路径（避免 base64 浪费两次）。
//
// 与 Adhoc 的差异：直接把本地脚本 bytes 推到控制节点 /tmp/.ophub_collect_<rand>.sh，
// 再 ansible -m script 跑。ansi script module 内部走 SCP 把该路径的文件再传到
// 目标机执行。
//
// Mode=local 时：直接把脚本写到容器内 /tmp/.ophub_collect_<rand>.sh，ansible -m script
// 把它 SCP 到目标机（远端），不需要走 SSH 到控制节点。
func (r *AnsibleRunner) Script(ip, sshUser, sshPass string, sshPort int, script []byte,
	become bool, becomePass string, timeout time.Duration) (string, error) {
	if r == nil {
		return "", ErrNoAnsibleNode
	}
	if r.Mode == runnerModeLocal {
		return r.localScript(ip, sshUser, sshPass, sshPort, script, become, becomePass, timeout)
	}
	if r.Node == nil {
		return "", ErrNoAnsibleNode
	}
	return r.pushAndScript(ip, sshUser, sshPass, sshPort, script, become, becomePass, timeout)
}

// pushAndScript 把 script bytes base64 推到控制节点 → ansible -m script 调用它
func (r *AnsibleRunner) pushAndScript(ip, sshUser, sshPass string, sshPort int, script []byte,
	become bool, becomePass string, timeout time.Duration) (string, error) {

	client := r.Node.ToSSHClient()
	tmpName := fmt.Sprintf("/tmp/.ophub_collect_%d_%d.sh", time.Now().UnixNano(), rand.Intn(99999))
	// 分段 base64 推送到控制节点（沿用 SSHClient.WriteFile 的同款方式，避免撞 sshd 限制）
	if err := writeRemoteScript(client, tmpName, ensureShebang(script), timeout); err != nil {
		return "", fmt.Errorf("推送脚本到控制节点失败：%v", err)
	}
	pre := r.ansibleGlobals(ip, sshUser, sshPass, sshPort, become, becomePass)
	cmd := pre + " -m script -a " + shq(tmpName) + " -o"
	raw, err := client.RunWithTimeout(cmd, timeout)
	// 不论成败都尝试清理临时文件（残留不影响功能，只是 /tmp 占用）
	_, _ = client.RunWithTimeout("rm -f "+shq(tmpName), 5*time.Second)
	return finishAnsiScript(raw, err)
}

// ============================================================================
// ansible 输出还原
//
// 背景（2026-09-16 在互联网 / 政务外网两台真实控制节点上实测，ansible-core 2.16.3）：
// ansible 的 ad-hoc 输出 **不是** 目标机的原始 stdout：
//
//	-m shell ：platform.internal.example | CHANGED | rc=0 | (stdout) RC=0\n__OPHUB_SEP__\n…
//	          真实换行被压成字面 `\n`，整段挤成一行
//	-m script：platform.internal.example | CHANGED => {"changed": true,"rc": 0,…,"stdout": "…\r\n…"}
//	          直接打印整个结果 dict（stdout 是 JSON 字符串）
//
// 而平台所有解析器（KEY=VALUE、@@SEC 段标记、base64 段、__OPHUB_* 标记）都按
// **真实换行**工作：不还原就整体错位。实测踩过 —— 资源校准把
// `4\nMEMKB=…\nOSB64=…` 整串当成 CPU 核数，操作系统版本直接采不到。
//
// 更麻烦的是「还原换行」本身有歧义：实测 ansible 只把真实换行转成 `\n`，
// **不会**同时把数据里本就存在的 `\t` / `\n` 两个字面序列转义 —— 于是
// `C:\temp`、`grep '\d'` 这类文本会被误还原成制表符 / 换行。因此：
//
//	Adhoc  → 目标机侧就把 stdout/stderr 先 base64 化（三段式协议），回传内容只剩
//	         [A-Za-z0-9+/=] 与自定分隔符，任何转义都是恒等变换 → **逐字节无损**
//	Script → 走结果 dict 的 JSON 反转义，本身无损
//
// 两条路都无损后，业务层只需要面对「目标机原始 stdout」。
// 同时兼容老版本 `host | CHANGED | rc=0 >>` + 真实换行的形态。
// ============================================================================

// adhocProtocolSep 三段式回传协议的分隔符。
// 只含下划线，base64 与 shell 都不会产出它，可安全地单行拼接。
const adhocProtocolSep = "__OPHUB_DI__"

// buildAdhocWrapper 生成「rc + stdout(base64) + stderr(base64)」三段式回传命令。
//
// 输出形如：`<SEP><rc><SEP><stdout b64><SEP><stderr b64><SEP>`
// —— 注意 rc 后面**必须**再补一个分隔符，否则 rc 会与 stdout 的 base64 粘成一段
// （实测踩过：解析出来 stdout 永远是空，校准结果全空且不报错）。
//
// 全部内容压在一行、且除分隔符外只有 base64 字符，因此 ansible 对换行的
// 「压行转义」对它完全是恒等变换，平台侧 split 即可精确还原。
// 代价是目标机 /tmp 下会有两个瞬时临时文件（同一命令内 rm 掉）。
func buildAdhocWrapper(shellCmd string) string {
	b64 := base64.StdEncoding.EncodeToString([]byte(shellCmd))
	return `T="${TMPDIR:-/tmp}/.ophub_a_$$.out"; E="${TMPDIR:-/tmp}/.ophub_a_$$.err"; ` +
		`{ echo ` + b64 + ` | base64 -d | bash ; } >"$T" 2>"$E"; RC=$?; ` +
		`printf '` + adhocProtocolSep + `%s' "$RC"; printf '` + adhocProtocolSep + `'; ` +
		`base64 -w0 "$T" 2>/dev/null; printf '` + adhocProtocolSep + `'; ` +
		`base64 -w0 "$E" 2>/dev/null; printf '` + adhocProtocolSep + `\n'; ` +
		`rm -f "$T" "$E"`
}

// decodeAdhocPayload 解析三段式回传内容。
// ok=false 表示协议内容缺失（命令根本没跑起来：连不上目标机 / ansible 自身报错）。
func decodeAdhocPayload(payload string) (stdout, stderr string, rc int, ok bool) {
	i := strings.Index(payload, adhocProtocolSep)
	if i < 0 {
		return "", "", 0, false
	}
	parts := strings.Split(payload[i+len(adhocProtocolSep):], adhocProtocolSep)
	if len(parts) < 3 {
		return "", "", 0, false
	}
	rc, _ = strconv.Atoi(strings.TrimSpace(parts[0]))
	stdout = decodeB64Loose(parts[1])
	stderr = decodeB64Loose(parts[2])
	return stdout, stderr, rc, true
}

// decodeB64Loose base64 解码（失败返回空串，不报错 —— 内容为空时属正常）
func decodeB64Loose(s string) string {
	dec, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil {
		return ""
	}
	return string(dec)
}

// finishAdhoc 处理 Adhoc 的原始回传：剥 ansible 包装 → 解三段式协议。
//
// 语义与直连 SSH 的 RunWithTimeout 对齐：远端命令非零退出即返回 error
// （调用方依赖这一点判断「直连失败 → 换密码重试提权」）。
func (r *AnsibleRunner) finishAdhoc(raw string, err error) (string, error) {
	payload, detail, _ := ansiPayload(raw)
	stdout, stderr, rc, ok := decodeAdhocPayload(payload)
	if !ok {
		msg := firstNonEmptyStr(detail, trimTail(strings.TrimSpace(payload), 240),
			trimTail(strings.TrimSpace(raw), 240), "无输出")
		if err == nil {
			err = fmt.Errorf("ansible 未返回可识别的结果")
		}
		return "", fmt.Errorf("%v（ansible：%s）", err, msg)
	}
	if rc != 0 {
		return stdout, fmt.Errorf("远端命令退出码 %d：%s", rc,
			trimTail(firstNonEmptyStr(strings.TrimSpace(stderr), "无输出"), 240))
	}
	return stdout, nil
}

// ansiResult ansible 包装层剥离结果
type ansiResult struct {
	Payload string // 目标机回传内容（ansible-core 2.16 下换行可能仍是字面 \n）
	Detail  string // 失败 / 不可达原因（供错误信息拼接）
	Escaped bool   // Payload 是否处于「压行转义」态（需要还原）
}

// finishAnsiScript 处理 Script 路径的原始回传：剥包装 + 还原转义。
// Script 走的是 `-m script`，回传是结果 dict 的 JSON 反转义，本身无损。
func finishAnsiScript(raw string, err error) (string, error) {
	p, detail, escaped := ansiPayload(raw)
	out := p
	if escaped {
		out = unescapeAnsiEscapes(p)
	}
	if err != nil {
		if d := firstNonEmptyStr(detail, trimTail(strings.TrimSpace(out), 240)); d != "" {
			err = fmt.Errorf("%v（ansible：%s）", err, trimTail(d, 240))
		}
	}
	return out, err
}

// ansiPayload 剥掉 ansible 的包装层，取出目标机回传的原始内容
func ansiPayload(raw string) (payload, detail string, escaped bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", "", false
	}
	// 形态 A：结果 dict（-m script 的成功/失败结果、不可达结果）
	if i := strings.Index(s, "=> {"); i >= 0 {
		var m map[string]interface{}
		if derr := json.NewDecoder(strings.NewReader(s[i+3:])).Decode(&m); derr == nil {
			stdout, _ := m["stdout"].(string)
			d := firstNonEmptyStr(toStr(m["msg"]), toStr(m["stderr"]))
			return stdout, strings.TrimSpace(d), false
		}
		return "", s, false
	}
	// 形态 B：ansible-core 2.16+ 的 ad-hoc 单行形态（换行被压成字面 \n）
	if i := strings.Index(s, "| (stdout) "); i >= 0 {
		body := s[i+len("| (stdout) "):]
		if j := strings.IndexByte(body, '\n'); j >= 0 {
			body = body[:j]
		}
		return body, "", true
	}
	// 形态 C：老版本 `host | CHANGED | rc=0 >>` + 真实换行；也兜住「命令无输出」
	// （此时只有状态行，不能把状态行当成输出）
	var out, det []string
	for _, ln := range strings.Split(s, "\n") {
		if isAnsiStatusLine(ln) {
			if d := strings.TrimSpace(ln); strings.Contains(d, "FAILED") || strings.Contains(d, "UNREACHABLE") {
				det = append(det, d)
			}
			continue
		}
		out = append(out, ln)
	}
	return strings.TrimSpace(strings.Join(out, "\n")), strings.Join(det, "；"), false
}

// isAnsiStatusLine 判断某行是否为 ansible 的每主机状态行
// （`host | CHANGED | rc=0 >>` / `host | FAILED! => {...}` 等）
func isAnsiStatusLine(ln string) bool {
	l := strings.TrimSpace(ln)
	if l == "" || !strings.Contains(l, " | ") {
		return false
	}
	for _, st := range []string{"| CHANGED", "| SUCCESS", "| FAILED", "| UNREACHABLE", "| SKIPPED", "| OK"} {
		if strings.Contains(l, st) {
			return true
		}
	}
	return false
}

// unescapeAnsiEscapes 还原 ansible 压行时所做的转义（只用于非无损路径的兜底）。
//
// 实测（ansible-core 2.16.3）：只把真实换行 / 回车 / 制表符转成字面 `\n` `\r` `\t`，
// **数据里的反斜杠原样透传**（录入 `RE1=\d+`，出来仍是 `RE1=\d+`）。
// 因此这里只还原这三个，绝不碰 `\\` —— 否则会把合法的正则 / 路径改坏。
func unescapeAnsiEscapes(s string) string {
	if !strings.ContainsRune(s, '\\') {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			switch s[i+1] {
			case 'n':
				b.WriteByte('\n')
				i++
				continue
			case 'r':
				b.WriteByte('\r')
				i++
				continue
			case 't':
				b.WriteByte('\t')
				i++
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// firstNonEmptyStr 取第一个非空（去空白后）的字符串
func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// ensureShebang 保证脚本首行是 shebang。
//
// 为什么必须补：ansible `-m script` 把文件推到目标机后是**直接执行文件**（不像直连
// SSH 那样由调用方套 `sh -c`），没有 shebang 的纯 shell 片段在部分环境会以
// 「Exec format error」失败。补 `#!/bin/sh` 对 `sh <file>` 这类执行方式也无害
// （首行只是注释），因此统一在推送前补一次。
func ensureShebang(b []byte) []byte {
	if bytes.HasPrefix(b, []byte("#!")) {
		return b
	}
	out := make([]byte, 0, len(b)+len("#!/bin/sh\n"))
	out = append(out, []byte("#!/bin/sh\n")...)
	return append(out, b...)
}

// Reachable 从**控制节点侧**探测目标机端口是否可达（秒级，用于批量扫描快速跳过离线机器）。
//
// 为什么不在平台侧探：平台到目标机的网络路由未必存在（典型场景：只有政务外网
// 控制节点能到该网段资产），平台直探会误报「不可达」。既然采集统一走 ansible，
// 可达性判断也必须以控制节点的视角为准。
//
// Mode=local 时直接从容器内探测（不再绕一道 SSH 到控制节点再探）。
func (r *AnsibleRunner) Reachable(ip string, port int, d time.Duration) bool {
	if r == nil {
		return false
	}
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return false
	}
	if port <= 0 {
		port = 22
	}
	secs := int(d.Seconds())
	if secs < 1 {
		secs = 1
	}
	// /dev/tcp 是 bash 内建；本机/控制节点都用 bash 探测
	cmd := fmt.Sprintf(`timeout %d bash -c "cat < /dev/null > /dev/tcp/%s/%d" >/dev/null 2>&1 && echo __OPHUB_REACHABLE__`,
		secs, ip, port)
	if r.Mode == runnerModeLocal {
		ctx, cancel := newDeadlineContext(d + 5*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "bash", "-c", cmd).CombinedOutput()
		return err == nil && strings.Contains(string(out), "__OPHUB_REACHABLE__")
	}
	if r.Node == nil {
		return false
	}
	out, err := r.Node.ToSSHClient().RunWithTimeout(cmd, d+5*time.Second)
	return err == nil && strings.Contains(out, "__OPHUB_REACHABLE__")
}

// ansibleGlobals 生成 ansible 全局选项（不含 `-m`/`-a`），以「空格」结尾。
// 调用方在末尾追加 `-m shell -a '<cmd>'` 或 `-m script -a '<path>'`，
// 然后是 `-o`（一行格式）。这样 `-a` 始终紧跟 caller 给的命令，不被前缀吞掉。
//
// 关键设计：
//   - 用 `--ssh-extra-args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'`
//     取代 `-e ansible_ssh_common_args="..."`：前者是 ansible 原生参数，
//     双引号 + 空格的组合在 shlex 解析下会被切碎（实测政务外网控制节点
//     ansible 报 status 2 usage error 就是这个原因）
//   - 强制覆盖 ANSIBLE_LOCAL_TEMP：默认 /tmp/.ansible/tmp 在某些控制节点上
//     普通用户没权限创建（实测互联网-ansible 控制节点踩过「Permission denied」）。
//     前置 `mkdir -p` 保证临时目录存在；通过 `VAR=val` bash 语法局部注入
//     ansible 子进程（只影响这一次调用，不污染控制节点的 shell 环境）
func (r *AnsibleRunner) ansibleGlobals(ip, sshUser, sshPass string, sshPort int,
	become bool, becomePass string) string {

	targetUser := sshUser
	if targetUser == "" {
		targetUser = r.Node.User
	}
	sshArgs := `--ssh-extra-args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'`
	// 在控制节点 shell 上：先建本地 ansible tmp 目录（普通用户没 /tmp/.ansible/tmp 权限时自救），
	// 再用 VAR=val bash 内置语法把 ANSIBLE_LOCAL_TEMP 注入到 ansible 子进程
	localTmpPrefix := `mkdir -p "/tmp/.ophub_ansible_${UID:-$(id -u)}/tmp" 2>/dev/null; ANSIBLE_LOCAL_TEMP="/tmp/.ophub_ansible_${UID:-$(id -u)}/tmp" ` +
		`ansible ` + shq(ip) + ` -i ` + shq(ip) + `, `
	// 强制覆盖默认提权：实测互联网-ansible / 政务外ansible 控制节点
	// /etc/ansible/ansible.cfg 都有 become=True + become_method=su，
	// 不覆盖的话 calibrate / mwCapture 这类不需要 sudo 的命令也会卡在 su 密码提示。
	// 这里默认 ansible_become=false；真正要提权时再传 --become + ansible_become。
	args := []string{
		"-u", shq(targetUser),
		"-e", "ansible_ssh_pass=" + shq(sshPass),
		"-e", "ansible_ssh_port=" + itoa(sshPort),
		"-e", "ansible_become=false", // 强制不走提权（控制节点 ansible.cfg 默认 True）
		sshArgs,
	}
	if become {
		args = append(args, "--become", "--become-method=sudo")
		if becomePass != "" {
			args = append(args, "-e", "ansible_become_pass="+shq(becomePass))
		} else {
			// 提权但无密码：NOPASSWD sudo；不传 ansible_become_pass 避免交互卡住
		}
	}
	return localTmpPrefix + strings.Join(args, " ") + " "
}

// ansiblePrefix 旧版（含 -a 后无 caller 占位的 bug）；保留以防外部调用，
// 但 Adhoc/Script 已经改为基于 ansibleGlobals 直接拼 -m -a '...' -o。
func (r *AnsibleRunner) ansiblePrefix(ip, sshUser, sshPass string, sshPort int,
	become bool, becomePass string, scriptModule bool) string {

	args := []string{}
	if scriptModule {
		args = append(args, "-m", "script", "-a")
	} else {
		args = append(args, "-m", "shell", "-a")
	}
	return r.ansibleGlobals(ip, sshUser, sshPass, sshPort, become, becomePass) + strings.Join(args, " ") + " "
}

// itoa 极简 int→string 转换，避免 strconv 引入大量额外字符串路径
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	buf := [12]byte{}
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// writeRemoteScript 把本地 script 内容写到控制节点 tmpName 处。
// 与 SSHClient.WriteFile 区别：本函数接收 []byte 而非 string，分段逻辑独立。
//
// 之所以不直接复用 SSHClient.WriteFile：那个函数体内用了「整段 base64 + 单条
// sh -c」，对小段内容更省代码，但对大脚本（>1KB）会撞 sshd argv 限制。这里
// 走和 SSHClient.runBigScript 同款「分段 base64 + echo 追加」路径。
func writeRemoteScript(c SSHClient, tmpName string, content []byte, timeout time.Duration) error {
	client, err := c.dial()
	if err != nil {
		return err
	}
	defer client.Close()
	// 清空目标文件
	if _, _, err := runSSH(client, "rm -f "+shq(tmpName)+" && : > "+shq(tmpName)); err != nil {
		// 清空失败不致命：后续 echo overwrite 会覆盖
	}
	// 每段压缩后 ~330 字节（raw=240），连 echo + base64 + 重定向整段命令 < 1KB。
	const chunkRaw = 240
	enc := base64.StdEncoding
	for i := 0; i < len(content); i += chunkRaw {
		end := i + chunkRaw
		if end > len(content) {
			end = len(content)
		}
		b64 := enc.EncodeToString(content[i:end])
		op := ">"
		if i > 0 {
			op = ">>"
		}
		writeCmd := fmt.Sprintf("(echo '%s' | base64 -d %s %s) && :", b64, op, shq(tmpName))
		if _, stderr, err := runSSH(client, writeCmd); err != nil {
			return fmt.Errorf("脚本上传失败（offset=%d）：%v: %s", i, err, strings.TrimSpace(stderr))
		}
	}
	if _, stderr, err := runSSH(client, "chmod 0755 "+shq(tmpName)); err != nil {
		return fmt.Errorf("chmod 失败：%v: %s", err, strings.TrimSpace(stderr))
	}
	return nil
}

// adHocCmdBytesExport 让测试能看到阈值（不要改值！）
func adHocCmdBytesExport() int { return adHocCmdBytes }

// ============================================================================
// 本机模式（Mode=local）专用实现：直接 exec backend 容器内的 ansible 命令。
//
// 与远端模式的差异：
//   - 不走 SSHClient（没有控制节点那一跳）
//   - 凭证通过 -e ansible_ssh_* 注入到单次 ansible 调用
//   - 提权密码走 ansible_become_pass（与远端一致）
//
// 协议兼容：远端模式的 buildAdhocWrapper 三段式（rc + stdout b64 + stderr b64）
// 也照样能用，因为「目标机侧」与「本地 shell」只是执行位置不同，shell 语法一致。
// 这意味着 finishAdhoc 完全复用——Local 模式下业务层拿到的 stdout 也是
// 「目标机原始 stdout」，没有任何包装污染。
// ============================================================================

// localAdhoc 在容器内直接 exec `ansible <ip> -i <ip>, -m shell -a '<wrapped>' -o`，
// 复用远端模式的 buildAdhocWrapper + finishAdhoc，输出协议 100% 一致。
//
// 实现：把命令拼成 []string 用 exec.CommandContext 跑，bash -c 包一层以解析
// shell 语法（单引号 / 环境变量）。输出截断 64KB 同远端 runRemote 风格。
func (r *AnsibleRunner) localAdhoc(ip, sshUser, sshPass string, sshPort int, shellCmd string,
	become bool, becomePass string, timeout time.Duration) (string, error) {

	wrapped := buildAdhocWrapper(shellCmd)
	args := []string{
		"ansible", ip,
		"-i", ip + ",",
		"-m", "shell",
		"-a", wrapped,
		"-u", sshUser,
		"-e", "ansible_ssh_pass=" + sshPass,
		"-e", "ansible_ssh_port=" + strconv.Itoa(sshPort),
		"-e", "ansible_become=false",
		"--ssh-extra-args=-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null",
		"-o",
	}
	if become {
		args = append(args, "--become", "--become-method=sudo")
		if becomePass != "" {
			args = append(args, "-e", "ansible_become_pass="+becomePass)
		}
	}
	// local 模式下用容器内 bash 跑（alpine 默认 bash）；这等价于远端控制节点的 bash 通道
	cmdLine := joinArgsForShell(args)
	ctx, cancel := newDeadlineContext(timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "bash", "-c", cmdLine).CombinedOutput()
	if len(out) > 64*1024 {
		out = append(out[:64*1024], []byte("\n...(已截断)")...)
	}
	return r.finishAdhoc(string(out), err)
}

// localScript 在容器内写脚本到 /tmp/.ophub_collect_*.sh，再 ansible -m script 跑。
//
// 与远端 pushAndScript 的差异：远端先 SSH 到控制节点写文件再 ansible，本机直接写
// 容器本地文件（容器内 ansible 是同一个进程，能直接读到）。ansible -m script
// 内部仍然会走 SCP 把该文件推到目标机执行，所以「目标机」那侧逻辑不变。
func (r *AnsibleRunner) localScript(ip, sshUser, sshPass string, sshPort int, script []byte,
	become bool, becomePass string, timeout time.Duration) (string, error) {

	tmpName := fmt.Sprintf("/tmp/.ophub_collect_%d_%d.sh", time.Now().UnixNano(), rand.Intn(99999))
	if err := os.WriteFile(tmpName, ensureShebang(script), 0o755); err != nil {
		return "", fmt.Errorf("写入本地脚本失败：%w", err)
	}
	defer os.Remove(tmpName)

	args := []string{
		"ansible", ip,
		"-i", ip + ",",
		"-m", "script",
		"-a", tmpName,
		"-u", sshUser,
		"-e", "ansible_ssh_pass=" + sshPass,
		"-e", "ansible_ssh_port=" + strconv.Itoa(sshPort),
		"-e", "ansible_become=false",
		"--ssh-extra-args=-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null",
		"-o",
	}
	if become {
		args = append(args, "--become", "--become-method=sudo")
		if becomePass != "" {
			args = append(args, "-e", "ansible_become_pass="+becomePass)
		}
	}
	cmdLine := joinArgsForShell(args)
	ctx, cancel := newDeadlineContext(timeout)
	defer cancel()
	raw, err := exec.CommandContext(ctx, "bash", "-c", cmdLine).CombinedOutput()
	if len(raw) > 64*1024 {
		raw = append(raw[:64*1024], []byte("\n...(已截断)")...)
	}
	return finishAnsiScript(string(raw), err)
}

// joinArgsForShell 把 []string 用空格拼接，每个元素单独 shq 转义（包单引号 + 转义内部单引号）。
// 给 bash -c 用，与远端模式 shq() 行为一致。
func joinArgsForShell(args []string) string {
	parts := make([]string, len(args))
	for i, a := range args {
		parts[i] = shq(a)
	}
	return strings.Join(parts, " ")
}

// newDeadlineContext 返回一个到 d 后自动取消的 context.Context。
// exec.CommandContext 需要真正的 context.Context，这里直接走 context.WithDeadline。
func newDeadlineContext(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithDeadline(context.Background(), time.Now().Add(d))
}
