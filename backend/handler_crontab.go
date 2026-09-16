package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// 定时任务（CRONTAB）管理 —— 数据源就是目标机上 `crontab -l` 的输出
//
// 选中一台资产 → 以「维护用户」（默认 root）身份执行 `crontab -l` 读出该用户
// crontab 的真实内容 → 增删改通过 crontab 自身安装回去。平台不建任务库存表，
// 也不写标记行，因此「平台看到的」与「机器上跑的」永远一致。
//
// 为什么以 `crontab -l` 为唯一数据源（2026-09-16）：
//   人工维护的定时任务绝大多数是用 `crontab -e` 写进**用户 crontab**的，
//   而 /etc/crontab 往往只是发行版自带的模板。实测某台 Jenkins 机器：
//   /etc/crontab 里一条任务都没有，但 `crontab -l`（root）里有 3 条真实任务 ——
//   只读 /etc/crontab 会整体漏报。故改为只认 `crontab -l`。
//
// 提权口径：
//   - crontab 是**按用户**存在的（root 的与别人的互不相干），因此读写统一
//     以「维护用户」身份进行（默认 root，可由资产「超级管理员用户」覆盖）
//   - SSH 登录用户就是维护用户 → 直接执行 `crontab -l`
//   - 否则通过 sudo 提权：填了「超级管理员用户密码」→ sudo -S 传密码；
//     没填 → sudo -n（要求目标机已为 SSH 用户配置 NOPASSWD）
//   - 目标用户还没有 crontab 时 `crontab -l` 返回 rc=1 + "no crontab for X"，
//     这**不是错误**：按 0 条任务处理，新增任务时由 crontab 自动创建
//
// 每个写操作走「读—改—写」：
//   1) 执行 `crontab -l` 导出当前内容（Go 侧逐行解析）
//   2) Go 侧只改目标那几行，其余行（注释 / 环境变量 / 空行）原样保留
//   3) 写入前把「读到的那份」与「此刻远端的那份」逐字节比对（冲突检测），
//      再把新内容落临时文件 → `crontab <临时文件>` 安装
//
// 安全措施：
//   - 写前用「旧内容逐字节比对」（cmp）做乐观锁，不一致则拒绝写入，
//     避免覆盖别人刚做的改动
//   - 目标行必须「行号 + 原始内容」双重匹配才算定位成功
//   - 写入前备份当前内容到 ~/.ophub_crontab/backup/crontab.<时间戳>.<PID>
//     （带 PID 是为了让同一秒内的连续写入各自独立，不互相覆盖）
//   - mkdir 原子锁，避免并发写入互相覆盖
//   - 内容用 base64 传输，避免命令拼接导致注入 / 特殊字符破坏结构
// ============================================================================

const crontabEOF = "__OPHUB_CRONTAB_EOF__"
const crontabSep = "__OPHUB_SEP__"
const crontabErrSep = "__OPHUB_ERRSEP__"
const crontabNoPriv = "__OPHUB_NOPRIV__"

const crontabProbeTimeout = 40 * time.Second

// crontabCmdName 目标机上用于读写 crontab 的命令（数据源）
const crontabCmdName = "crontab"

// 批量扫描参数
const (
	crontabScanTimeout     = 25 * time.Second // 单机读取上限
	crontabDialProbe       = 3 * time.Second  // TCP 预探测（快速跳过不可达机器）
	crontabScanConcurrency = 8                // 并发扫描度
	crontabDefaultRunUser  = "root"           // crontab 默认维护者（root 的 crontab）
)

// crontabViewCacheTTL 单机视图去重窗口：同一台机器在该时间内重复打开不再重连 SSH。
// 写操作会立即失效；远端被别人改动时也有 hash 乐观锁兜底，不会误覆盖。
const crontabViewCacheTTL = 15 * time.Second

// ---------------------------------------------------------------------------
// 连接目标
// ---------------------------------------------------------------------------

// crontabPrivError 提权 / 身份通道不可用错误。用独立类型承载，既能被
// errors.As 识别（用于在多个通道之间自动回退重试），又不会像 %w 包装那样
// 把内部标识泄漏到给用户看的提示里。
//
// 两个短路标记（2026-09-16 实测补充，都是「换密码也没用」的情形，用来避免
// 白等目标机 PAM 的重试延迟 —— 实测一次错的 sudo 密码要 4.5s）：
//   - denied 目标机明确拒绝 sudo（`is not in the sudoers file` / `may not run sudo`
//     / 无 tty）→ 跳过剩余 **sudo** 候选；
//   - auth   SSH 登录用户自身的凭据不被接受 → 所有「以该用户登录」的 sudo 候选
//     都不可用，同样跳过。
type crontabPrivError struct {
	message string
	denied  bool
	auth    bool
}

func (e *crontabPrivError) Error() string { return e.message }

// crontab 采集身份 / 提权通道类型
const (
	crontabChanDirect = "direct" // 以 SSH 登录用户直接执行（该用户就是维护用户）
	crontabChanSudo   = "sudo"   // 以 SSH 登录用户 sudo 提权到维护用户
)

// crontabPrivPlan 一条可尝试的通道：Kind 决定「以谁登录、要不要提权前缀」。
type crontabPrivPlan struct {
	Kind   string `json:"kind"`
	Prefix string `json:"prefix,omitempty"` // Kind=sudo：shell 提权前缀
}

// ID 通道的稳定标识（记忆 / 去重用；不含密码，避免日志泄漏）
func (p crontabPrivPlan) ID() string {
	return p.Kind + ":" + p.Prefix
}

// crontabTarget 一台目标机的 crontab 管理目标（含提权信息）
type crontabTarget struct {
	Client  SSHClient
	IP      string // 实际连接地址
	SSHUser string // SSH 登录用户
	RunUser string // crontab 的归属用户（默认 root，即读写的就是这个人的 crontab）

	// Runner 采集通道：2026-09 起平台不再直连目标机做任何采集，
	// 统一由 ansible 控制节点执行（见 service_ansible_runner.go）。
	// **非 nil 时 exec/runScript 一律走 ansible**；nil 仅作为历史直连兜底保留。
	Runner *AnsibleRunner
	Zone   string // 资产「所属网络区域」，用于匹配控制节点

	// resolvedPrefix 读取成功后确定下来的提权前缀（写回时复用同一个密码源，
	// 避免「读用密码 A、写用密码 B」的不一致），与 plan.Prefix 同步保留
	resolvedPrefix string

	// plan 当前生效的通道（由 privPlans 逐条尝试后写入，写回也复用它）
	plan crontabPrivPlan
}

// applyPlan 把一条通道设为当前生效通道（影响本目标后续所有 exec / runScript）
func (t *crontabTarget) applyPlan(p crontabPrivPlan) {
	t.plan = p
	t.resolvedPrefix = p.Prefix
}

// resetPlan 清掉当前通道（回到「未解析」状态，exec/runScript 按 SSH 用户直连）
func (t *crontabTarget) resetPlan() {
	t.plan = crontabPrivPlan{}
	t.resolvedPrefix = ""
}

// effLogin 本次执行实际用于登录目标机的账号 / 密码（资产登记的 SSH 用户）。
func (t *crontabTarget) effLogin() (string, string) {
	return t.SSHUser, t.Client.Password
}

// effRunUser 本次执行的「运行身份」（crontab 的归属用户，默认 root）
func (t *crontabTarget) effRunUser() string {
	return t.RunUser
}

// Mode 当前通道：direct（本身就是维护用户）/ sudo（sudo 提权）
func (t *crontabTarget) Mode() string {
	switch t.plan.Kind {
	case crontabChanSudo, crontabChanDirect:
		return t.plan.Kind
	}
	if t.privPrefix() == "" {
		return crontabChanDirect
	}
	return crontabChanSudo
}

// ---------------------------------------------------------------------------
// 远端执行通道（ansible 控制节点）
// ---------------------------------------------------------------------------

// exec 在目标机上执行一条 shell 命令（适合长度可控的命令）。
//
// 走 ansible：平台 SSH 到控制节点 → `ansible <ip> -m shell -a '<base64 命令>'`，
// 命令过长时 AnsibleRunner.Adhoc 会自动退化为 `-m script`，业务层无感。
//
// Runner 为 nil（未配置 ansible 控制节点且业务层未强制拦截）时才回退直连 SSH，
// 仅作为容错保留，正常链路上不会走到。
//
// 登录身份取 effLogin()：以资产登记的 SSH 用户连接目标机。
func (t *crontabTarget) exec(cmd string, timeout time.Duration) (string, error) {
	user, pass := t.effLogin()
	if t.Runner != nil {
		return t.Runner.Adhoc(t.IP, user, pass, t.Client.Port, cmd,
			false, "", timeout)
	}
	cli := t.Client
	if user != cli.User || pass != cli.Password {
		cli.User, cli.Password = user, pass
	}
	return cli.RunWithTimeout(cmd, timeout)
}

// runScript 在目标机上执行一段 shell 脚本（可长，如中间件捕捉的 9KB 脚本）。
//
// sudoPrefix 非空时表示需要提权；直连模式下套在 `sh <file>` 外层，
// ansible 模式下编进脚本文件自身（见 composeTargetScript），两条路语义一致。
func (t *crontabTarget) runScript(sudoPrefix, script string, timeout time.Duration) (string, error) {
	user, pass := t.effLogin()
	if t.Runner != nil {
		body := composeTargetScript(sudoPrefix, t.effRunUser(), script)
		return t.Runner.Script(t.IP, user, pass, t.Client.Port,
			[]byte(body), false, "", timeout)
	}
	cli := t.Client
	if user != cli.User || pass != cli.Password {
		cli.User, cli.Password = user, pass
	}
	return cli.RunBigScript(sudoPrefix, script, timeout)
}

// probeReachable 目标机可达性快速预检（批量扫描时用来秒级跳过离线机器）。
//
// ansible 模式下由控制节点侧探测：平台自身到目标机的路由可能不存在，
// 用平台直探会把「控制节点能到」的机器误判成不可达。
func (t *crontabTarget) probeReachable(d time.Duration) bool {
	if t.Runner != nil {
		return t.Runner.Reachable(t.IP, t.Client.Port, d)
	}
	return probeTCP(t.IP, t.Client.Port, d)
}

// sudoPrefix 提权前缀。
//
// 已解析出通道时用该通道的前缀；未解析时沿用历史口径（填了「超级管理员用户密码」
// 才带），供 nginx 扫描这类「直接拼前缀、不做通道解析」的调用方使用。
func (t *crontabTarget) sudoPrefix() string {
	if t.plan.Kind != "" {
		return t.plan.Prefix
	}
	return t.Client.sudoPrefix()
}

// runnerName 当前采集通道的可读名称（报错文案里告诉用户「经哪条通道」失败）
func (t *crontabTarget) runnerName() string {
	if t.Runner != nil && t.Runner.Node != nil {
		name := strings.TrimSpace(t.Runner.Node.Name)
		if name == "" {
			name = t.Runner.Node.Host
		}
		return name
	}
	return "平台直连"
}

// ReadFile 读取目标机文件原文（必要时用提权前缀重试），语义与 SSHClient.ReadFile 一致。
func (t *crontabTarget) ReadFile(path string) (string, error) {
	pre := t.sudoPrefix()
	checkCmd := fmt.Sprintf(`if [ -r %q ]; then echo OK; elif %stest -r %q; then echo OK; else echo NO; fi`,
		path, pre, path)
	checkOut, err := t.exec(checkCmd, 30*time.Second)
	if err != nil || !strings.Contains(checkOut, "OK") {
		return "", fmt.Errorf("文件不可读：%s（请检查 SSH 用户权限，或补齐资产的「超级管理员用户密码」）", path)
	}
	cmd := fmt.Sprintf(`if [ -r %q ]; then cat %q; else %scat %q; fi | base64 -w 0`,
		path, path, pre, path)
	out, err := t.exec(cmd, 30*time.Second)
	if err != nil {
		return "", fmt.Errorf("读取失败：%v", err)
	}
	decoded, derr := base64.StdEncoding.DecodeString(strings.TrimSpace(out))
	if derr != nil {
		return "", fmt.Errorf("base64 解码失败：%v（远端输出可能被截断或非文本）", derr)
	}
	return string(decoded), nil
}

// WriteFile 写入目标机文件（写入前备份为 *.ophub.bak），语义与 SSHClient.WriteFile 一致。
func (t *crontabTarget) WriteFile(path, content string) error {
	pre := t.sudoPrefix()
	dir := path
	if idx := strings.LastIndex(path, "/"); idx > 0 {
		dir = path[:idx]
	}
	preOut, err := t.exec(fmt.Sprintf(`%stest -w %q && echo OK || echo NO`, pre, dir), 30*time.Second)
	if err != nil || !strings.Contains(preOut, "OK") {
		return fmt.Errorf("目录不可写：%s（请补齐资产的「超级管理员用户密码」或配置 NOPASSWD sudo）", dir)
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(content))
	cmd := fmt.Sprintf(`%ssh -c "echo %s | base64 -d > %s.ophub.tmp && cp %s %s.ophub.bak 2>/dev/null; mv -f %s.ophub.tmp %s && chmod 644 %s"`,
		pre, encoded, path, path, path, path, path, path)
	if _, werr := t.exec(cmd, 40*time.Second); werr != nil {
		return fmt.Errorf("写入失败：%v", werr)
	}
	return nil
}

// composeTargetScript 把「提权前缀」编进脚本文件本身（ansible `-m script` 模式专用）。
//
// 为什么要自包装：Script 路径把脚本 SCP 到目标机后**直接执行文件**，无法像直连
// SSH（`echo pw | sudo -S ... sh <file>`）那样在文件外层套提权前缀。
// 这里在脚本开头插一段自检：当前用户不是目标用户时，用提权前缀重新执行「自己」
// （$0 即脚本自身路径），否则继续跑正文。以 `id -un` 判定可天然避免递归 ——
// 提权后的进程已是目标用户，不会再进这个分支。
//
// 前缀为空（无需提权）时原样返回，不做任何包装。
func composeTargetScript(sudoPrefix, runUser, script string) string {
	pre := strings.TrimSpace(sudoPrefix)
	if pre == "" {
		return script
	}
	ru := strings.TrimSpace(runUser)
	if ru == "" {
		ru = crontabDefaultRunUser
	}
	return `if [ "$(id -un 2>/dev/null)" != ` + shq(ru) + ` ]; then
  ` + pre + ` sh "$0"
  exit $?
fi
` + script
}

// sourceCmd 展示用的读取命令（与实际执行的一致，便于用户自行在机器上核对）
func (t *crontabTarget) sourceCmd() string {
	if t.RunUser == "" || t.RunUser == t.SSHUser {
		return crontabCmdName + " -l"
	}
	return fmt.Sprintf("sudo -u %s %s -l", t.RunUser, crontabCmdName)
}

// sudoPlans 返回「以 SSH 用户 sudo 提权」的候选通道，按优先级排列。
//
// 注意：sudo 校验的是**调用者（SSH 登录用户）**的密码，而不是目标用户的密码。
// 因此这里先试资产里的「超级管理员用户密码」（很多环境填的就是 sudo 密码），
// 失败再回退到 SSH 用户自己的密码，两头都覆盖。
func (t *crontabTarget) sudoPlans() []crontabPrivPlan {
	run := strings.TrimSpace(t.RunUser)
	if run == "" || run == t.SSHUser {
		return []crontabPrivPlan{{Kind: crontabChanDirect}} // SSH 用户即目标用户，无需提权
	}
	seen := map[string]bool{}
	out := make([]crontabPrivPlan, 0, 2)
	add := func(pass string) {
		if strings.TrimSpace(pass) == "" {
			return
		}
		p := strings.ReplaceAll(pass, "'", "'\\''") // 防注入
		pf := fmt.Sprintf("echo '%s' | sudo -S -p '' -u %s ", p, run)
		if !seen[pf] {
			seen[pf] = true
			out = append(out, crontabPrivPlan{Kind: crontabChanSudo, Prefix: pf})
		}
	}
	add(t.Client.BecomePass) // 优先：超级管理员用户密码
	add(t.Client.Password)   // 回退：SSH 用户密码
	if len(out) == 0 {
		out = append(out, crontabPrivPlan{Kind: crontabChanSudo,
			Prefix: fmt.Sprintf("sudo -n -u %s ", run)})
	}
	return out
}

// privPlans 本目标可尝试的通道：sudo 候选（含 direct）。
//
// 顺序由 sudoPlans 决定（SSH 用户即维护用户时为 direct，否则按
// 「超级管理员用户密码 → SSH 用户密码」拼 sudo 前缀）。
func (t *crontabTarget) privPlans() []crontabPrivPlan {
	return t.sudoPlans()
}

// privPrefix 生效的提权前缀（已解析过则用解析结果，否则取首选候选）
func (t *crontabTarget) privPrefix() string {
	if t.plan.Kind != "" {
		return t.plan.Prefix
	}
	if t.resolvedPrefix != "" {
		return t.resolvedPrefix
	}
	if ps := t.sudoPlans(); len(ps) > 0 {
		return ps[0].Prefix
	}
	return ""
}

// crontabSSHInfo 从资产字段解析 SSH 连接信息 + crontab 归属用户
// （字段口径与资源校准 / 中间件部署保持一致）
func crontabSSHInfo(a *Asset) (*crontabTarget, error) {
	fields := map[string]interface{}{}
	if len(a.Fields) > 0 {
		_ = json.Unmarshal(a.Fields, &fields)
	}
	ip := extractIP(fields)
	if ip == "" {
		return nil, fmt.Errorf("该资产未填写「虚拟机IPv4 / 虚拟机EIP-IPv4」，无法连接目标机")
	}
	portStr := strings.TrimSpace(toStr(fields["SSH端口"]))
	if portStr == "" {
		portStr = "22"
	}
	port, perr := strconv.Atoi(portStr)
	if perr != nil || port <= 0 || port > 65535 {
		return nil, fmt.Errorf("该资产填写的「SSH端口」不合法：%s", portStr)
	}
	user := toStr(fields["用户名"])
	if user == "" {
		user = toStr(fields["普通用户"])
	}
	pass := toStr(fields["密码"])
	if pass == "" {
		pass = toStr(fields["普通用户密码"])
	}
	become := toStr(fields["超级管理员用户密码"])
	runUser := strings.TrimSpace(toStr(fields["超级管理员用户"]))
	if runUser == "" {
		runUser = crontabDefaultRunUser
	}
	zone := strings.TrimSpace(toStr(fields["所属网络区域"]))
	if user == "" {
		return nil, fmt.Errorf("该资产未填写 SSH「用户名 / 普通用户」，无法连接目标机")
	}
	if pass == "" {
		return nil, fmt.Errorf("该资产未填写 SSH「密码 / 普通用户密码」，无法连接目标机")
	}
	// 采集通道：统一走 ansible 控制节点（按资产「所属网络区域」匹配）。
	// 与资源校准一致：没有可用控制节点时明确报错，不静默退回直连 SSH ——
	// 否则「绕开 ansible」会在用户不知情的情况下发生。
	runner, rerr := ResolveAnsibleRunner(zone)
	if rerr != nil {
		return nil, fmt.Errorf("未匹配到 ansible 控制节点（资产「所属网络区域」=%s），"+
			"无法采集该虚拟机。请在「Ansible 节点管理」添加该区域（或任意一台）的控制节点。原因：%v",
			orDefault(zone, "空"), rerr)
	}
	return &crontabTarget{
		Client:  SSHClient{Host: ip, Port: port, User: user, Password: pass, BecomePass: become},
		IP:      ip,
		SSHUser: user,
		RunUser: runUser,
		Runner:  runner,
		Zone:    zone,
	}, nil
}

// privError 提权 / 身份通道全部不可用时的中文提示（尽量给出可执行的修复建议）
func privError(t *crontabTarget, denied bool) *crontabPrivError {
	tried := fmt.Sprintf("以 SSH 用户 %s 身份 sudo 提权（依次试过「超级管理员用户密码」与 SSH 用户密码）", t.SSHUser)
	msg := fmt.Sprintf(
		"无法以 %s 身份读取 %s（已尝试：%s）。常见原因是 SSH 用户 %s 没有 sudo 权限"+
			"（实测报错 `%s is not in the sudoers file`）。请在资产「用户密码管理」中把"+
			"「超级管理员用户密码」填成 %s 执行 sudo 时的密码，或为 %s 配置 NOPASSWD 免密 sudo",
		t.RunUser, crontabCmdName, tried, t.SSHUser, t.SSHUser, t.SSHUser, t.SSHUser)
	if denied {
		msg += "。目标机已明确拒绝该用户的 sudo 请求（不在 sudoers / 无 tty）"
	}
	return &crontabPrivError{message: msg, denied: denied}
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 提权 / 身份通道记忆（进程内缓存）
//
// 为什么需要它：目标机的 sudo 在密码错误时会「Sorry, try again」再重试一次，
// 实测一次失败要 4.5s 才返回，而密码正确时只要 0.15s。资产里填的
// 「超级管理员用户密码」在实际环境里经常并不是 sudo 密码（sudo 校验的是
// **调用者**的密码），于是每次读取都要先白等一轮再回退到 SSH 用户密码。
//
// 这里把「哪台机器走哪条通道」记在内存里，下次直接命中，读 / 写从 8s+ 降到
// 亚秒级，同时大幅减少对目标机的失败认证次数。
// 指纹覆盖主机 + 账号 + 三个密码 + 维护用户，资产凭据一改指纹即变，缓存自动失效。
// ---------------------------------------------------------------------------

var (
	crontabPrivCacheMu sync.RWMutex
	crontabPrivCache   = map[string]crontabPrivPlan{}
)

const crontabPrivCacheMax = 4096

// crontabTargetKey 目标机 + 凭据指纹（凭据变更即失效）
func crontabTargetKey(t *crontabTarget) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		t.Client.Host, strconv.Itoa(t.Client.Port), t.Client.User,
		t.Client.Password, t.Client.BecomePass, t.RunUser,
	}, "\x00")))
	return hex.EncodeToString(sum[:16])
}

func crontabPrivRemember(t *crontabTarget, p crontabPrivPlan) {
	key := crontabTargetKey(t)
	crontabPrivCacheMu.Lock()
	if len(crontabPrivCache) >= crontabPrivCacheMax {
		crontabPrivCache = map[string]crontabPrivPlan{}
	}
	crontabPrivCache[key] = p
	crontabPrivCacheMu.Unlock()
	t.applyPlan(p)
}

func crontabPrivForget(t *crontabTarget) {
	key := crontabTargetKey(t)
	crontabPrivCacheMu.Lock()
	delete(crontabPrivCache, key)
	crontabPrivCacheMu.Unlock()
}

func crontabPrivLookup(t *crontabTarget) (crontabPrivPlan, bool) {
	crontabPrivCacheMu.RLock()
	v, ok := crontabPrivCache[crontabTargetKey(t)]
	crontabPrivCacheMu.RUnlock()
	return v, ok
}

// ---------------------------------------------------------------------------
// 单机视图去重缓存（短 TTL）
//
// 同一台机器在 crontabViewCacheTTL 内被反复打开（连续点几台再点回来、
// 多标签页、页面重挂载）时直接返回上次结果，不再重复 SSH。
// ---------------------------------------------------------------------------

type crontabViewCacheEntry struct {
	view crontabView
	at   time.Time
}

var (
	crontabViewMu    sync.RWMutex
	crontabViewCache = map[uint]crontabViewCacheEntry{}
)

func crontabViewStore(v crontabView) {
	crontabViewMu.Lock()
	if len(crontabViewCache) > 4096 {
		crontabViewCache = map[uint]crontabViewCacheEntry{}
	}
	crontabViewCache[v.AssetID] = crontabViewCacheEntry{view: v, at: time.Now()}
	crontabViewMu.Unlock()
}

func crontabViewLoad(assetID uint) (crontabView, bool) {
	crontabViewMu.RLock()
	e, ok := crontabViewCache[assetID]
	crontabViewMu.RUnlock()
	if !ok || time.Since(e.at) > crontabViewCacheTTL {
		return crontabView{}, false
	}
	return e.view, true
}

func crontabViewInvalidate(assetID uint) {
	crontabViewMu.Lock()
	delete(crontabViewCache, assetID)
	crontabViewMu.Unlock()
}

// crontabViewInvalidateAll 清空全部单机视图缓存（批量导入等场景，影响面未知时兜底）
func crontabViewInvalidateAll() {
	crontabViewMu.Lock()
	crontabViewCache = map[uint]crontabViewCacheEntry{}
	crontabViewMu.Unlock()
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

// crontabReadScript 生成读取用户 crontab（`crontab -l`）的脚本。
//
// 输出结构：
//
//	RC=<退出码>
//	__OPHUB_SEP__
//	<base64(crontab -l 的 stdout)，单行无换行；stdout 为空时为空行>
//	__OPHUB_ERRSEP__
//	<stderr of crontab -l>
//	<EOF>
//
// 关键点：
//   - **整个脚本只调用一次 sudo**。早期实现先用 `<prefix>true` 探测提权、
//     再跑实际命令，等于对目标机做两次 sudo 认证；在 PAM 较慢的环境里每次
//     认证失败要 4~5 秒，两次就是 8 秒以上（实测单机读取 8.6s）。
//     现在把「提权是否失败」交给 stderr 判定，成功率与原来一致但只认证一次。
//   - stdout / stderr 分开收集，避免 sudo 的 lecture / 报错混进内容
//     被解析成幽灵任务（实测踩过）。
//   - 内容走 base64：crontab 原文里可能有空行、任意文本（甚至平台的标记串），
//     按行分隔再还原会丢换行，base64 一行到底最稳。
//   - 退出码单独回传：`crontab -l` 在「该用户还没有 crontab」时是 rc=1
//   - stderr "no crontab for X"，这属于正常状态而非错误。
func crontabReadScript(prefix string) string {
	return `D="${HOME:-/tmp}/.ophub_crontab"
mkdir -p "$D" 2>/dev/null || D=/tmp
T="$D/.read.$$.out"
E="$D/.read.$$.err"
` + prefix + crontabCmdName + ` -l >"$T" 2>"$E"
RC=$?
echo "RC=$RC"
echo '` + crontabSep + `'
if [ -s "$T" ]; then base64 "$T" 2>/dev/null | tr -d '\n'; fi
echo ''
echo '` + crontabErrSep + `'
cat "$E" 2>/dev/null
rm -f "$T" "$E"
printf '\n` + crontabEOF + `\n'`
}

// isCrontabNotice 判断某行是否为 crontab / sudo 的提示或报错（而非任务内容）
func isCrontabNotice(s string) bool {
	l := strings.ToLower(strings.TrimSpace(s))
	switch {
	case strings.HasPrefix(l, "sudo:"),
		strings.Contains(l, "is not in the sudoers file"),
		strings.Contains(l, "not allowed to execute"),
		strings.Contains(l, "a password is required"),
		strings.Contains(l, "incorrect password attempt"),
		strings.Contains(l, "must have a tty"),
		strings.Contains(l, "command not found") && strings.Contains(l, "sudo"):
		return true
	}
	return false
}

// crontabPrivFailMarks 判「提权失败」的 stderr 特征（精确匹配，避免误伤
// 诸如 `sudo: unable to resolve host` 这类无害告警）
var crontabPrivFailMarks = []string{
	"sorry, try again",
	"no password was provided",
	"a password is required",
	"incorrect password attempt",
	"is not in the sudoers file",
	"not allowed to execute",
	"not allowed to use this program",
	"must have a tty",
	"a terminal is required",
	"terminal is required",
	"authentication failure",
}

func looksLikePrivFailure(s string) bool {
	l := strings.ToLower(s)
	for _, m := range crontabPrivFailMarks {
		if strings.Contains(l, m) {
			return true
		}
	}
	return false
}

// crontabSudoDeniedMarks 目标机**明确拒绝 sudo** 的特征。
//
// 与「密码错了」有本质区别：这些错误换密码重试也不可能成功，应立刻跳过
// 剩余的 sudo 候选 —— 实测每次错的 sudo 密码要白等 4.5s（目标机 PAM 重试）。
var crontabSudoDeniedMarks = []string{
	"is not in the sudoers file",
	"may not run sudo",
	"not allowed to execute",
	"not allowed to use this program",
	"must have a tty",
	"a terminal is required",
	"terminal is required",
}

func looksLikeSudoDenied(s string) bool {
	l := strings.ToLower(s)
	for _, m := range crontabSudoDeniedMarks {
		if strings.Contains(l, m) {
			return true
		}
	}
	return false
}

// crontabAuthFailMarks 目标机「登录凭据不被接受」的输出特征。
//
// ansible 侧是 UNREACHABLE 摘要（`Invalid/incorrect password`），
// 平台直连 SSH 侧是 `Permission denied` 系列。命中即说明该账号登不上去，
// 所有以该账号为基础的 sudo 候选同样不可用 → 跳过剩余候选。
var crontabAuthFailMarks = []string{
	"invalid/incorrect password",
	"permission denied",
	"authentication fail",
	"too many authentication failures",
	"no supported authentication",
}

func looksLikeAuthFailure(s string) bool {
	l := strings.ToLower(s)
	for _, m := range crontabAuthFailMarks {
		if strings.Contains(l, m) {
			return true
		}
	}
	return false
}

// parseCrontabRead 解析读取脚本的输出。
//
// 返回 Content 为该用户 crontab 的**逐字节原文**（含末尾换行，写回时的
// 冲突检测直接按字节比对，因此不做任何裁剪/归一化）。
func parseCrontabRead(t *crontabTarget, out string) (string, bool, error) {
	idx := strings.LastIndex(out, "\n"+crontabEOF)
	if idx < 0 {
		return "", false, fmt.Errorf("读取目标机 crontab 失败：输出不完整（未取到结束标记）")
	}
	body := out[:idx]
	si := strings.Index(body, "\n"+crontabSep)
	if si < 0 {
		return "", false, fmt.Errorf("读取目标机 crontab 失败：输出格式异常")
	}
	head := body[:si]
	rest := body[si+1+len(crontabSep):]

	rc := -1
	if v, ok := strings.CutPrefix(strings.TrimSpace(head), "RC="); ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			rc = n
		}
	}

	// stdout / stderr 分流。
	// 注意：必须在 TrimPrefix("\n") **之前**找分隔符 —— SEP 之后紧跟 ERRSEP
	// 时（stdout 为空，例如提权失败）ERRSEP 前面没有换行，先 trim 就永远匹配
	// 不上，错误文本会被当成 crontab 内容（实测踩过）。
	stdoutB64, stderr := rest, ""
	if ei := strings.LastIndex(rest, "\n"+crontabErrSep); ei >= 0 {
		stdoutB64 = rest[:ei]
		stderr = rest[ei+1+len(crontabErrSep):]
	}
	stdoutB64 = strings.TrimSpace(stdoutB64)
	stderr = strings.TrimSpace(stderr)
	stderrLine := firstNonEmptyLine(stderr)

	// 提权失败优先判定：sudo 首次的 lecture（多行提示）、`unable to resolve host`
	// 之类的噪声都不会被误当成读取失败。
	if looksLikePrivFailure(stderr) {
		return "", false, privError(t, looksLikeSudoDenied(stderr))
	}
	if isCrontabMissingNotice(stderr) {
		return "", false, fmt.Errorf("目标机未安装 %s 命令，无法管理定时任务", crontabCmdName)
	}

	// 「该用户还没有 crontab」：rc=1 + stderr "no crontab for X"，不是错误。
	if isNoCrontabNotice(stderr) {
		return "", false, nil
	}
	if rc == 1 && strings.TrimSpace(stdoutB64) == "" && stderrLine == "" {
		return "", false, nil
	}

	content := ""
	if stdoutB64 != "" {
		raw, derr := base64.StdEncoding.DecodeString(stdoutB64)
		if derr != nil {
			return "", false, fmt.Errorf("读取目标机 crontab 失败：内容解码失败（%v）", derr)
		}
		content = string(raw)
	}

	if rc != 0 && stderrLine != "" {
		if isCrontabNotice(stderrLine) {
			return "", false, fmt.Errorf("读取目标机 crontab 失败：%s", stderrLine)
		}
	}
	if rc != 0 && content == "" {
		return "", false, fmt.Errorf("读取目标机 crontab 失败（以 %s 身份执行 %s -l 返回 %d）：%s",
			t.RunUser, crontabCmdName, rc, orDefault(stderrLine, "无输出"))
	}
	// rc=0：该用户的 crontab 存在（内容可能为空文件，也算存在）
	return content, true, nil
}

// firstNonEmptyLine 取首行非空文本（sudo / crontab 的报错通常是单行）
func firstNonEmptyLine(s string) string {
	for _, ln := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(ln); t != "" {
			return t
		}
	}
	return ""
}

func orDefault(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// readRemoteCrontab 以维护用户身份读取其 crontab 原文（`crontab -l`）。
//
// 会优先使用上次成功的通道，其余通道依次回退；exists=false 表示该用户当前
// 还没有 crontab（不是错误）。
//
// 通道顺序见 privPlans：sudo 候选（含 direct）。两处短路（都有实测依据）：
//   - 目标机明确拒绝 sudo（not in the sudoers file）→ 跳过剩余 sudo 候选；
//   - SSH 用户凭据不被接受（ansible 报 Invalid/incorrect password）→ 同样跳过。
//
// 成功时**保留** plan（写回路径 applyRemoteCrontab 要用同一个通道）；失败时清掉，
// 避免把失效通道留给后续操作。
func readRemoteCrontab(t *crontabTarget) (content string, exists bool, err error) {
	cached, hasCache := crontabPrivLookup(t)
	plans := t.privPlans()
	if hasCache {
		// 记忆命中优先；其余通道依次兜底（凭据 / sudoers 可能在平台外被改过）
		head := []crontabPrivPlan{cached}
		for _, p := range plans {
			if p.ID() != cached.ID() {
				head = append(head, p)
			}
		}
		plans = head
	}

	sudoOK := true // 一旦判定「该用户的 sudo 走不通」，就不再白等后续 sudo 候选
	var lastErr error
	for _, p := range plans {
		if p.Kind == crontabChanSudo && !sudoOK {
			continue
		}
		t.applyPlan(p)
		content, exists, err = t.readWithPrefix(p.Prefix)
		if err == nil {
			crontabPrivRemember(t, p) // 记住可用通道，写回也用它
			return content, exists, nil
		}
		lastErr = err
		var pe *crontabPrivError
		if !errors.As(err, &pe) {
			t.resetPlan()
			return "", false, err // 非通道类错误（网络 / 未装 crontab 等），无需换通道重试
		}
		if pe.denied || pe.auth {
			sudoOK = false
		}
		if hasCache && p.ID() == cached.ID() {
			// 记忆已失效（密码被改 / sudoers 变更 / 目标机重建）
			crontabPrivForget(t)
			hasCache = false
		}
	}
	t.resetPlan()
	if lastErr == nil {
		lastErr = privError(t, false)
	}
	return "", false, lastErr
}

// readWithPrefix 用指定的提权前缀执行一次读取。
//
// 脚本最后一步是 printf，正常路径退出码恒为 0；若仍拿到非零退出码，
// 只要输出里带结束标记，就说明内容已完整读回（例如末尾的 rm 失败），
// 照样按内容解析，避免把「读到了但收尾命令报错」误判成读取失败。
func (t *crontabTarget) readWithPrefix(pf string) (string, bool, error) {
	out, err := t.exec(crontabReadScript(pf), crontabProbeTimeout)
	if err != nil && !strings.Contains(out, crontabEOF) {
		detail := trimTail(strings.TrimSpace(firstNonEmptyLine(err.Error()+"\n"+out)), 200)
		// SSH 用户自身登录失败（密码被改 / 账号锁定）：属于「换通道可救」，
		// 标记 auth 让上层跳过其余 sudo 候选。
		if looksLikeAuthFailure(err.Error() + "\n" + out) {
			return "", false, &crontabPrivError{
				message: fmt.Sprintf("以 SSH 用户 %s 登录目标机失败（凭据不被接受）：%s", t.SSHUser, detail),
				auth:    true,
			}
		}
		return "", false, fmt.Errorf("读取目标机 crontab 失败（以 %s 身份执行 %s -l）：%v",
			t.effRunUser(), crontabCmdName, err)
	}
	return parseCrontabRead(t, out)
}

// ---------------------------------------------------------------------------
// 写回
// ---------------------------------------------------------------------------

// crontabFingerprint 内容指纹（sha256 of `crontab -l` 的逐字节原文）。
// 只用于平台内部判断「远端是否变了」，冲突检测本身走 shell 侧 cmp。
func crontabFingerprint(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// crontabBackupToken 把维护用户变成可安全拼进远端命令的备份文件名片段
// （只留字母/数字/._-，其余一律下划线，避免资产字段里的怪字符注入 shell）
func crontabBackupToken(runUser string) string {
	s := strings.TrimSpace(runUser)
	if s == "" {
		return "user"
	}
	out := make([]rune, 0, len(s))
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '_', r == '-':
			out = append(out, r)
		default:
			out = append(out, '_')
		}
	}
	return string(out)
}

// buildCrontabApplyCmd 生成写回用户 crontab 的命令（含提权检查、备份、加锁、冲突检测）
//
// 为什么不用 `crontab -`（从 stdin 读内容）：
//
//	提权前缀是 `echo '密码' | sudo -S ...`，stdin 已经被 sudo 用来读密码，
//	再让 crontab 从 stdin 读内容会互相打架。因此统一「先落临时文件，再
//	`crontab <临时文件>` 安装」，direct 与 sudo 两条路行为一致。
//
// 冲突检测：
//
//	把平台读到的那份内容（$OLD）与**此刻**的 `crontab -l`（$CUR）逐字节
//	比对（cmp），不一致说明期间被别人改过 → 拒绝写入。两边都是 crontab -l
//	的原始输出，口径天然一致，不需要任何 normalize。
//
// 空内容：
//
//	用户把任务全删光 → 新内容为空 → 走 `crontab -r` 删掉该 crontab
//	（部分发行版的 crontab 拒绝安装空文件；这也是「没有任何定时任务」的
//	正确表达，与 crontab -l 报 no crontab 一致）。
func buildCrontabApplyCmd(b64Old, b64New, prefix, backupToken string) string {
	return fmt.Sprintf(`set -u
umask 022
# 退出码恒为 0：所有结果都通过 __OPHUB_* 标记回传（平台侧一直是「先认标记、
# 再看 rc」）。走 ansible 后非零 rc 会让 ansible 报 FAILED 并把 stdout 折进
# 失败摘要里，解析会变脆，所以统一以 0 退出。
if ! %strue 2>/dev/null; then echo "%s"; exit 0; fi
D="${HOME:-/tmp}/.ophub_crontab"
mkdir -p "$D" 2>/dev/null || true
LOCK="$D/lock"
i=0
while ! mkdir "$LOCK" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -ge 100 ]; then echo "__OPHUB_LOCK_TIMEOUT__"; exit 0; fi
  sleep 0.2 2>/dev/null || sleep 1
done
trap 'rmdir "$LOCK" 2>/dev/null' 0 1 2 15
OLD="$D/.old.$$"
NEW="$D/.new.$$"
CUR="$D/.cur.$$"
base64 -d > "$OLD" <<'__OPHUB_OLD__'
%s
__OPHUB_OLD__
base64 -d > "$NEW" <<'__OPHUB_NEW__'
%s
__OPHUB_NEW__
%s%s -l > "$CUR" 2>/dev/null || : > "$CUR"
if ! cmp -s "$OLD" "$CUR"; then
  rm -f "$OLD" "$NEW" "$CUR"
  echo "__OPHUB_CONFLICT__"; exit 0
fi
TS=$(date +%%Y%%m%%d%%H%%M%%S 2>/dev/null || date +%%s)
BK="$D/backup"
mkdir -p "$BK" 2>/dev/null || true
# 备份名带 $$（当前执行脚本的 shell PID）：TS 只到秒，同一秒内的连续写入
# 会互相覆盖，实测 7 次写入只留下 5 份备份。加 PID 后每次都独立。
BKF="$BK/crontab_%s.$TS.$$"
cp -p "$CUR" "$BKF" 2>/dev/null || cp "$CUR" "$BKF" 2>/dev/null || true
if [ -s "$NEW" ]; then
  if %s%s "$NEW" 2>&1; then OK=1; else OK=0; fi
else
  %s%s -r 2>/dev/null || true
  OK=1
fi
rm -f "$OLD" "$NEW" "$CUR"
if [ "$OK" = "1" ]; then
  find "$BK" -type f -mtime +30 -delete 2>/dev/null || true
  echo "__OPHUB_APPLY_OK__ $BKF"
else
  echo "__OPHUB_APPLY_FAIL__"
  exit 0
fi`,
		prefix, crontabNoPriv, b64Old, b64New,
		prefix, crontabCmdName, backupToken,
		prefix, crontabCmdName, prefix, crontabCmdName)
}

// applyRemoteCrontab 把新内容安装到目标机的用户 crontab，返回备份路径。
// oldContent 是平台读到的那份原文（用于 shell 侧冲突检测）。
func applyRemoteCrontab(t *crontabTarget, oldContent, newContent string) (string, error) {
	b64Old := base64.StdEncoding.EncodeToString([]byte(oldContent))
	b64New := base64.StdEncoding.EncodeToString([]byte(newContent))
	cmd := buildCrontabApplyCmd(b64Old, b64New, t.privPrefix(), crontabBackupToken(t.RunUser))
	out, err := t.exec(cmd, crontabProbeTimeout)
	// 写法注意：脚本是用**非零退出码**表达「提权失败 / 锁超时 / 冲突 / 写失败」的，
	// 而非零退出会让 RunWithTimeout 同时给出 err。因此必须先解析 out 里的标记，
	// 不能因为 err != nil 就直接返回 —— 否则「已被改动」这类可操作提示会被
	// 覆盖成一句「Process exited with status 9」（实测踩过）。
	switch {
	case strings.Contains(out, "__OPHUB_APPLY_OK__"):
		f := strings.Fields(out)
		if len(f) >= 2 {
			return f[1], nil
		}
		return "", nil
	case strings.Contains(out, "__OPHUB_NOPRIV__"):
		return "", privError(t, looksLikeSudoDenied(out))
	case strings.Contains(out, "__OPHUB_CONFLICT__"):
		return "", fmt.Errorf("目标机 crontab 已被改动，为避免覆盖他人修改已中止写入，请刷新后重试")
	case strings.Contains(out, "__OPHUB_LOCK_TIMEOUT__"):
		return "", fmt.Errorf("获取目标机 crontab 写锁超时（可能有其他写入正在进行），请稍后重试")
	case strings.Contains(out, "__OPHUB_APPLY_FAIL__"):
		return "", fmt.Errorf("写入目标机 crontab 失败（请确认以 %s 身份执行 %s 的权限）：%s",
			t.RunUser, crontabCmdName, trimTail(strings.TrimSpace(trimMarkers(out)), 200))
	default:
		if err != nil {
			return "", fmt.Errorf("写入目标机 crontab 失败（以 %s 身份）：%v", t.RunUser, err)
		}
		return "", fmt.Errorf("写入目标机 crontab 失败，输出：%s", trimTail(strings.TrimSpace(out), 200))
	}
}

// trimMarkers 去掉输出里的平台标记行，只留真实报错文本
func trimMarkers(s string) string {
	var keep []string
	for _, ln := range strings.Split(s, "\n") {
		if strings.HasPrefix(strings.TrimSpace(ln), "__OPHUB_") {
			continue
		}
		keep = append(keep, ln)
	}
	return strings.Join(keep, "\n")
}

// crontabWriteResult 写操作结果
type crontabWriteResult struct {
	Backup  string `json:"backup"`  // 远端备份路径（无变化时为空）
	Hash    string `json:"hash"`    // 写入后的内容指纹
	Changed bool   `json:"changed"` // 远端是否真的发生了变化
}

// mutateAssetCrontab 读目标机 crontab → 校验指纹 → 本地修改 → 安装回去
//
// 注意：写路径**永远重新读取远端**（不用缓存），配合指纹乐观锁保证不误覆盖；
// 写成功后立即失效该机的视图缓存，避免前端读到自己刚写之前的旧内容。
func mutateAssetCrontab(assetID uint, expectedHash string, mutate func(lines []string) ([]string, error)) (*crontabWriteResult, error) {
	var a Asset
	if err := DB.First(&a, assetID).Error; err != nil {
		return nil, fmt.Errorf("目标机资产不存在")
	}
	t, err := crontabSSHInfo(&a)
	if err != nil {
		return nil, err
	}
	content, exists, err := readRemoteCrontab(t)
	if err != nil {
		crontabViewInvalidate(assetID)
		return nil, err
	}
	curHash := crontabFingerprint(content)
	if expectedHash != "" && curHash != expectedHash {
		// 远端已变（别人改过 / 平台缓存过期）：把最新内容写进缓存，
		// 前端刷新时能立刻看到差异，不用再跑一次 SSH
		crontabViewStore(buildCrontabView(&a, t, content, exists))
		return nil, fmt.Errorf("目标机 crontab 已被改动，为避免覆盖他人修改已中止本次操作，请刷新后重试")
	}
	next, err := mutate(splitCrontabLines(content))
	if err != nil {
		return nil, err
	}
	newContent := joinCrontabLines(next)
	if newContent == content {
		return &crontabWriteResult{Hash: curHash, Changed: false}, nil
	}
	backup, err := applyRemoteCrontab(t, content, newContent)
	if err != nil {
		return nil, err
	}
	crontabViewInvalidate(assetID)
	return &crontabWriteResult{Backup: backup, Hash: crontabFingerprint(newContent), Changed: true}, nil
}

// removeLineAt 删除指定行；若因此产生连续空行则吃掉一个，避免留下空档
func removeLineAt(lines []string, idx int) []string {
	out := append([]string{}, lines[:idx]...)
	rest := lines[idx+1:]
	if len(out) > 0 && len(rest) > 0 &&
		strings.TrimSpace(out[len(out)-1]) == "" && strings.TrimSpace(rest[0]) == "" {
		rest = rest[1:]
	}
	return append(out, rest...)
}

// ---------------------------------------------------------------------------
// 入参
// ---------------------------------------------------------------------------

// crontabTaskReq 任务写操作入参（hash 乐观锁 + 行定位）
//
// 注意：用户 crontab 的任务行**没有「运行用户」段**（整份 crontab 都属于
// 同一个用户，见 crontabTarget.RunUser），因此入参里也没有 user 字段。
type crontabTaskReq struct {
	Hash    string `json:"hash"`    // 读取时返回的内容指纹
	LineNo  int    `json:"lineNo"`  // 目标行号（1-based），新增时忽略
	OldRaw  string `json:"oldRaw"`  // 目标行原始内容（定位校验），新增时忽略
	Expr    string `json:"expr"`    // cron 表达式
	Command string `json:"command"` // 命令 / 脚本
	Enabled *bool  `json:"enabled"` // 是否启用，缺省视为启用
}

// crontabRawReq 整份原文保存入参
type crontabRawReq struct {
	Hash    string `json:"hash"`
	Content string `json:"content"`
}

// crontabScanReq 批量扫描入参
type crontabScanReq struct {
	AssetIds      []uint `json:"assetIds"`      // 指定资产（为空 = 全部）
	CategoryID    uint   `json:"categoryId"`    // 按分类过滤
	Keyword       string `json:"keyword"`       // 按名称 / IP 过滤
	OnlyWithTasks bool   `json:"onlyWithTasks"` // 只返回有任务的机器
}

// crontabAssetID 解析路径上的资产 ID
func crontabAssetID(c *gin.Context) (uint, bool) {
	n, err := strconv.Atoi(c.Param("id"))
	if err != nil || n <= 0 {
		Fail(c, http.StatusBadRequest, 400, "资产 ID 不合法")
		return 0, false
	}
	return uint(n), true
}

// assetFields 解析资产的 CMDB 字段（JSONB）为 map
func assetFields(a *Asset) map[string]interface{} {
	fields := map[string]interface{}{}
	if a != nil && len(a.Fields) > 0 {
		_ = json.Unmarshal(a.Fields, &fields)
	}
	return fields
}

// assetDisplayName 资产展示名。
//
// 统一走 asset_name.go 的 AssetDisplayName（全系统唯一口径：
// 项目简称_环境_业务环境_虚拟机IPv4），与 Web 终端会话名、CMDB 列表名同源。
// 这样在资产管理里改任意一段，定时任务列表会立刻跟着变。
func assetDisplayName(a *Asset) string {
	return AssetDisplayName(a)
}

// assetVMName CMDB「虚拟机名称」原文（展示名里的副标题 / 兜底用）
func assetVMName(a *Asset) string {
	return AssetVMName(a)
}

// ---------------------------------------------------------------------------
// 单机视图
// ---------------------------------------------------------------------------

// crontabView 一台资产上某用户的 crontab 全貌（数据源 = `crontab -l`）。
//
// Tasks 是 crontab 里的任务行（平台可增删改），Others 是非任务行
// （注释 / 环境变量 / 空行，平台原样保留、不解释也不改动）。
// 写回只认 Tasks 的 hash 与行号。
type crontabView struct {
	AssetID      uint           `json:"assetId"`
	AssetName    string         `json:"assetName"`
	VMName       string         `json:"vmName"` // CMDB「虚拟机名称」原文（列表副标题）
	IP           string         `json:"ip"`
	Host         string         `json:"host"`
	SSHUser      string         `json:"sshUser"`
	RunUser      string         `json:"user"`             // crontab 的归属用户（默认 root）
	RunMode      string         `json:"runMode"`          // direct / sudo
	CrontabOK    bool           `json:"crontabAvailable"` // 读取成功即可管理
	NoCrontab    bool           `json:"noCrontab"`        // 该用户当前还没有 crontab（0 条任务）
	Source       string         `json:"source"`           // 实际执行的读取命令（crontab -l）
	Hash         string         `json:"hash"`
	Content      string         `json:"content"`
	Tasks        []crontabEntry `json:"tasks"`
	Others       []crontabEntry `json:"others"`
	TaskCount    int            `json:"taskCount"`
	EnabledCount int            `json:"enabledCount"`
	DisabledCnt  int            `json:"disabledCount"`
	ReadAt       string         `json:"readAt"`
	ReadAtMs     int64          `json:"readAtMs"` // 读取时刻（毫秒时间戳），前端据此判断缓存新鲜度
	Cached       bool           `json:"cached"`   // 本次是否命中平台短时缓存（未重新连目标机）
}

// buildCrontabView 把 crontab 原文整理成前端视图
func buildCrontabView(a *Asset, t *crontabTarget, content string, exists bool) crontabView {
	entries := parseUserCrontabEntries(content)
	tasks := make([]crontabEntry, 0, len(entries))
	others := make([]crontabEntry, 0, len(entries))
	enabledCnt := 0
	for _, e := range entries {
		switch e.Kind {
		case crontabLineTask:
			tasks = append(tasks, e)
			enabledCnt++
		case crontabLineDisabled:
			tasks = append(tasks, e)
		default:
			others = append(others, e)
		}
	}
	return crontabView{
		AssetID:      a.ID,
		AssetName:    assetDisplayName(a),
		VMName:       assetVMName(a),
		IP:           a.IP,
		Host:         t.IP,
		SSHUser:      t.SSHUser,
		RunUser:      t.RunUser,
		RunMode:      t.Mode(),
		CrontabOK:    true,
		NoCrontab:    !exists,
		Source:       t.sourceCmd(),
		Hash:         crontabFingerprint(content),
		Content:      content,
		Tasks:        tasks,
		Others:       others,
		TaskCount:    len(tasks),
		EnabledCount: enabledCnt,
		DisabledCnt:  len(tasks) - enabledCnt,
		ReadAt:       time.Now().Format("2006-01-02 15:04:05"),
		ReadAtMs:     time.Now().UnixMilli(),
	}
}

// ---------------------------------------------------------------------------
// 「用途」备注 —— 平台侧人工标注
//
// 定时任务本身永远读目标机，这里只补一层「这条任务是干什么的」人工说明。
// 备注存在平台库里（CrontabTaskNote），不写回目标机 crontab。
// ---------------------------------------------------------------------------

const (
	// crontabNoteKeyLen 任务指纹长度（sha256 前 16 位十六进制）
	crontabNoteKeyLen = 16
	// crontabNoteMaxLen 单条用途最多多少字
	crontabNoteMaxLen = 200
)

// crontabNoteKey 「用途」备注的存储键。
// 只取命令本身、不含执行时间：调执行时间不该丢用途，命令改了则视为另一个任务。
// 先把连续空白归一化，避免同一条任务因多余空格生成两个键。
func crontabNoteKey(command string) string {
	c := strings.Join(strings.Fields(command), " ")
	if c == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(c))
	return hex.EncodeToString(sum[:])[:crontabNoteKeyLen]
}

// isCrontabNoteKey 校验任务指纹格式（16 位小写十六进制）
func isCrontabNoteKey(s string) bool {
	if len(s) != crontabNoteKeyLen {
		return false
	}
	for _, ch := range s {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return true
}

// attachCrontabNotes 给单机视图的每条任务补上「用途」备注。
// 刻意放在读过缓存之后：改备注无需重连目标机就能立刻看到。
// 这里重建 tasks 切片，避免改到共享缓存里的元素。
func attachCrontabNotes(v *crontabView) {
	if v == nil {
		return
	}
	var notes []CrontabTaskNote
	DB.Where("asset_id = ?", v.AssetID).Find(&notes)
	saved := make(map[string]string, len(notes))
	for _, n := range notes {
		saved[n.TaskKey] = n.Purpose
	}
	// 备注按命令指纹存平台库；重建切片，避免改到共享缓存里的元素。
	fill := func(src []crontabEntry) []crontabEntry {
		if len(src) == 0 {
			return src
		}
		out := make([]crontabEntry, len(src))
		copy(out, src)
		for i := range out {
			out[i].NoteKey = crontabNoteKey(out[i].Command)
			if out[i].NoteKey != "" {
				out[i].Purpose = saved[out[i].NoteKey]
			}
		}
		return out
	}
	v.Tasks = fill(v.Tasks)
}

// crontabNoteReq 保存用途的请求体
type crontabNoteReq struct {
	TaskKey string `json:"taskKey"`
	Purpose string `json:"purpose"`
}

// crontabNoteResult 保存用途的返回
type crontabNoteResult struct {
	TaskKey string `json:"taskKey"`
	Purpose string `json:"purpose"`
}

// ---------------------------------------------------------------------------
// HTTP 处理器
// ---------------------------------------------------------------------------

// CrontabAssetList 可管理定时的资产列表（选择器用）
// GET /api/crontab/assets
func CrontabAssetList(c *gin.Context) {
	var assets []Asset
	DB.Order("id desc").Find(&assets)
	list := make([]gin.H, 0, len(assets))
	for i := range assets {
		a := assets[i]
		item := gin.H{
			"assetId":   a.ID,
			"assetName": assetDisplayName(&a),
			"vmName":    assetVMName(&a),
			"ip":        a.IP,
			"runUser":   crontabDefaultRunUser,
			"ready":     true,
		}
		if t, err := crontabSSHInfo(&a); err == nil {
			item["sshHost"] = t.IP
			item["sshUser"] = t.SSHUser
			item["runUser"] = t.RunUser
			item["runMode"] = t.Mode()
			item["sudoReady"] = t.Mode() == "direct" || t.Client.BecomePass != ""
		} else {
			item["ready"] = false
			item["reason"] = err.Error()
		}
		list = append(list, item)
	}
	OK(c, gin.H{"list": list})
}

// GetAssetCrontab 读取某台资产上维护用户的 crontab（`crontab -l`）
// GET /api/crontab/asset/:id[?refresh=1]
//
// 性能设计：
//   - 默认命中 15 秒内的同名机器读取结果（去重窗口），连续点开几台再点回来
//     不会重复 SSH；`?refresh=1` 强制重连目标机拿最新内容（前端「刷新」按钮用）
//   - 连之前先做 3 秒 TCP 预探测，离线机器立刻返回，不再等 SSH 握手超时
func GetAssetCrontab(c *gin.Context) {
	assetID, ok := crontabAssetID(c)
	if !ok {
		return
	}
	var a Asset
	if err := DB.First(&a, assetID).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "目标机资产不存在")
		return
	}

	force := c.Query("refresh") == "1"
	if !force {
		if v, hit := crontabViewLoad(assetID); hit {
			v.Cached = true
			attachCrontabNotes(&v)
			OK(c, v)
			return
		}
	}

	t, err := crontabSSHInfo(&a)
	if err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	if !t.probeReachable(crontabDialProbe) {
		Fail(c, http.StatusBadGateway, 502,
			fmt.Sprintf("无法从 ansible 控制节点 %s 连接 %s:%d（网络不通或端口未开放），请确认目标机可达后重试",
				t.runnerName(), t.IP, t.Client.Port))
		return
	}

	content, exists, err := readRemoteCrontab(t)
	if err != nil {
		Fail(c, http.StatusBadGateway, 502, err.Error())
		return
	}
	v := buildCrontabView(&a, t, content, exists)
	crontabViewStore(v)
	attachCrontabNotes(&v)
	OK(c, v)
}

// ScanCrontabAssets 批量扫描资产上维护用户的 crontab（`crontab -l`）
// POST /api/crontab/scan
func ScanCrontabAssets(c *gin.Context) {
	var req crontabScanReq
	_ = c.ShouldBindJSON(&req)

	q := DB.Order("id desc")
	if len(req.AssetIds) > 0 {
		q = q.Where("id IN ?", req.AssetIds)
	}
	if req.CategoryID > 0 {
		q = q.Where("category_id = ?", req.CategoryID)
	}
	var assets []Asset
	q.Find(&assets)

	kw := strings.ToLower(strings.TrimSpace(req.Keyword))
	if kw != "" {
		filtered := assets[:0]
		for i := range assets {
			a := assets[i]
			if strings.Contains(strings.ToLower(assetDisplayName(&a)), kw) ||
				strings.Contains(strings.ToLower(a.IP), kw) ||
				strings.Contains(strings.ToLower(a.Name), kw) {
				filtered = append(filtered, a)
			}
		}
		assets = filtered
	}

	results := make([]crontabScanItem, len(assets))
	sem := make(chan struct{}, crontabScanConcurrency)
	var wg sync.WaitGroup
	for i := range assets {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			results[i] = scanAssetCrontab(&assets[i])
		}(i)
	}
	wg.Wait()

	// 统计
	okCnt, taskHostCnt, errCnt, taskTotal := 0, 0, 0, 0
	list := make([]crontabScanItem, 0, len(results))
	for _, it := range results {
		switch it.Status {
		case "ok":
			okCnt++
			if it.TaskCount > 0 {
				taskHostCnt++
			}
			taskTotal += it.TaskCount
		default:
			errCnt++
		}
		if req.OnlyWithTasks && it.TaskCount == 0 {
			continue
		}
		list = append(list, it)
	}

	OK(c, gin.H{
		"list":          list,
		"total":         len(list),
		"scanned":       len(results),
		"okCount":       okCnt,
		"taskHostCount": taskHostCnt,
		"errorCount":    errCnt,
		"taskTotal":     taskTotal,
		"scannedAt":     time.Now().Format("2006-01-02 15:04:05"),
	})
}

// crontabScanItem 批量扫描的单台结果。
// 字段是 AssetCrontabView 的超集 —— 前端会把扫描结果直接当缓存用来秒开抽屉，
// 缺字段就会渲染出 undefined（实测踩过：漏了 host，抽屉标题变成「· undefined · root」）。
type crontabScanItem struct {
	AssetID       uint           `json:"assetId"`
	AssetName     string         `json:"assetName"`
	VMName        string         `json:"vmName"` // CMDB「虚拟机名称」原文
	IP            string         `json:"ip"`
	Host          string         `json:"host"` // 实际连接地址（IP 或域名）
	SSHUser       string         `json:"sshUser"`
	RunUser       string         `json:"user"`
	RunMode       string         `json:"runMode"`
	CrontabOK     bool           `json:"crontabAvailable"` // 读取成功即可管理
	NoCrontab     bool           `json:"noCrontab"`        // 该用户当前还没有 crontab
	Source        string         `json:"source"`           // 实际执行的读取命令
	Status        string         `json:"status"`           // ok / offline / denied / invalid / error
	Message       string         `json:"message"`
	TaskCount     int            `json:"taskCount"`
	EnabledCount  int            `json:"enabledCount"`
	DisabledCount int            `json:"disabledCount"`
	Hash          string         `json:"hash"`
	Content       string         `json:"content"`
	Tasks         []crontabEntry `json:"tasks"`
	Others        []crontabEntry `json:"others"`
	ReadAt        string         `json:"readAt"`
	ReadAtMs      int64          `json:"readAtMs"` // 读取时刻（毫秒时间戳）
}

// probeTCP 快速探测目标端口是否可达（避免对离线机器做完整 SSH 握手）
func probeTCP(host string, port int, d time.Duration) bool {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), d)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// scanAssetCrontab 扫描单台资产（供并发调用）
func scanAssetCrontab(a *Asset) crontabScanItem {
	item := crontabScanItem{
		AssetID:   a.ID,
		AssetName: assetDisplayName(a),
		VMName:    assetVMName(a),
		IP:        a.IP,
		RunUser:   crontabDefaultRunUser,
		Tasks:     []crontabEntry{},
		Others:    []crontabEntry{},
		ReadAt:    time.Now().Format("2006-01-02 15:04:05"),
		ReadAtMs:  time.Now().UnixMilli(),
	}
	t, err := crontabSSHInfo(a)
	if err != nil {
		item.Status = "invalid"
		item.Message = err.Error()
		return item
	}
	item.IP = t.IP
	item.Host = t.IP
	item.SSHUser = t.SSHUser
	item.RunUser = t.RunUser
	item.RunMode = t.Mode()

	if !t.probeReachable(crontabDialProbe) {
		item.Status = "offline"
		item.Message = fmt.Sprintf("无法从 ansible 控制节点 %s 连接 %s:%d（网络不通或端口未开放）",
			t.runnerName(), t.IP, t.Client.Port)
		return item
	}

	content, exists, err := readRemoteCrontab(t)
	if err != nil {
		item.Status = "error"
		var pe *crontabPrivError
		if errors.As(err, &pe) {
			item.Status = "denied"
		}
		item.Message = err.Error()
		return item
	}

	// 扫描结果会被前端直接当缓存用（抽屉秒开），必须与单机视图同构
	v := buildCrontabView(a, t, content, exists)
	item.Status = "ok"
	item.CrontabOK = true // 漏掉会让前端误报「crontab 不可读」
	item.NoCrontab = v.NoCrontab
	item.Source = v.Source
	item.TaskCount = v.TaskCount
	item.EnabledCount = v.EnabledCount
	item.DisabledCount = v.DisabledCnt
	item.Hash = v.Hash
	item.Content = v.Content
	item.Tasks = v.Tasks
	item.Others = v.Others
	item.ReadAt = v.ReadAt
	item.ReadAtMs = v.ReadAtMs
	crontabViewStore(v) // 扫描结果直接进缓存，随后打开抽屉秒开
	return item
}

// CreateAssetCrontabTask 新增定时任务（追加到 crontab 末尾）
// POST /api/crontab/asset/:id/tasks
func CreateAssetCrontabTask(c *gin.Context) {
	assetID, ok := crontabAssetID(c)
	if !ok {
		return
	}
	var req crontabTaskReq
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	expr, cmd, err := normalizeCronTask(req.Expr, req.Command)
	if err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	enabled := req.Enabled == nil || *req.Enabled
	res, err := mutateAssetCrontab(assetID, req.Hash, func(lines []string) ([]string, error) {
		// 严格「只追加一行」：不额外补空行。
		// 曾经的实现在末尾补空行提升可读性，但删除时不会回收那个空行，
		// 导致「新增再删除」后 crontab 末尾残留孤立空行（与基线不再一致）。
		// 增删对称才能保证平台不改动任何非目标任务行。
		return append(lines, renderUserCronLine(expr, cmd, enabled)), nil
	})
	if err != nil {
		Fail(c, http.StatusBadGateway, 502, err.Error())
		return
	}
	OK(c, res)
}

// UpdateAssetCrontabTask 修改定时任务（含启用/禁用切换）
// PUT /api/crontab/asset/:id/tasks
func UpdateAssetCrontabTask(c *gin.Context) {
	assetID, ok := crontabAssetID(c)
	if !ok {
		return
	}
	var req crontabTaskReq
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	expr, cmd, err := normalizeCronTask(req.Expr, req.Command)
	if err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	enabled := req.Enabled == nil || *req.Enabled
	res, err := mutateAssetCrontab(assetID, req.Hash, func(lines []string) ([]string, error) {
		idx, err := locateLine(lines, req.LineNo, req.OldRaw)
		if err != nil {
			return nil, err
		}
		lines[idx] = renderUserCronLine(expr, cmd, enabled)
		return lines, nil
	})
	if err != nil {
		Fail(c, http.StatusBadGateway, 502, err.Error())
		return
	}
	OK(c, res)
}

// DeleteAssetCrontabTask 删除定时任务
// DELETE /api/crontab/asset/:id/tasks
func DeleteAssetCrontabTask(c *gin.Context) {
	assetID, ok := crontabAssetID(c)
	if !ok {
		return
	}
	var req crontabTaskReq
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	if req.LineNo <= 0 {
		Fail(c, http.StatusBadRequest, 400, "缺少要删除的行号")
		return
	}
	res, err := mutateAssetCrontab(assetID, req.Hash, func(lines []string) ([]string, error) {
		idx, err := locateLine(lines, req.LineNo, req.OldRaw)
		if err != nil {
			return nil, err
		}
		return removeLineAt(lines, idx), nil
	})
	if err != nil {
		Fail(c, http.StatusBadGateway, 502, err.Error())
		return
	}
	OK(c, res)
}

// SaveAssetCrontabRaw 保存整份 crontab 原文（高级编辑）
// PUT /api/crontab/asset/:id/raw
func SaveAssetCrontabRaw(c *gin.Context) {
	assetID, ok := crontabAssetID(c)
	if !ok {
		return
	}
	var req crontabRawReq
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	content := strings.ReplaceAll(req.Content, "\r\n", "\n")
	content = strings.ReplaceAll(content, "\r", "\n")
	// 保护性校验：仅拦截明显异常内容（含 NUL）
	if strings.ContainsRune(content, 0) {
		Fail(c, http.StatusBadRequest, 400, "内容包含非法字符，已拒绝保存")
		return
	}
	res, err := mutateAssetCrontab(assetID, req.Hash, func([]string) ([]string, error) {
		return splitCrontabLines(content), nil
	})
	if err != nil {
		Fail(c, http.StatusBadGateway, 502, err.Error())
		return
	}
	OK(c, res)
}

// SetCrontabTaskNote 保存 / 清除某条定时任务的「用途」备注
// PUT /api/crontab/asset/:id/notes
//
// 只写平台自己的备注表，不碰目标机 crontab，所以不需要连远端、也不受写操作的
// hash 乐观锁约束。用途留空即删除该条备注（前端清空输入框即为删除）。
func SetCrontabTaskNote(c *gin.Context) {
	assetID, ok := crontabAssetID(c)
	if !ok {
		return
	}
	var req crontabNoteReq
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	key := strings.TrimSpace(req.TaskKey)
	if !isCrontabNoteKey(key) {
		Fail(c, http.StatusBadRequest, 400, "任务标识不合法")
		return
	}
	purpose := strings.TrimSpace(req.Purpose)
	if len([]rune(purpose)) > crontabNoteMaxLen {
		Fail(c, http.StatusBadRequest, 400, fmt.Sprintf("用途最多 %d 个字", crontabNoteMaxLen))
		return
	}
	var a Asset
	if err := DB.First(&a, assetID).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "目标机资产不存在")
		return
	}

	var note CrontabTaskNote
	found := DB.Where("asset_id = ? AND task_key = ?", assetID, key).First(&note).Error == nil

	if purpose == "" {
		if found {
			if err := DB.Delete(&note).Error; err != nil {
				Fail(c, http.StatusInternalServerError, 500, "清除用途失败")
				return
			}
		}
		OK(c, crontabNoteResult{TaskKey: key, Purpose: ""})
		return
	}

	operator := ""
	if v, exists := c.Get(ctxUser); exists {
		operator = fmt.Sprint(v)
	}
	fields := map[string]interface{}{"purpose": purpose, "updated_by": operator}
	if found {
		if err := DB.Model(&CrontabTaskNote{}).
			Where("asset_id = ? AND task_key = ?", assetID, key).
			Updates(fields).Error; err != nil {
			Fail(c, http.StatusInternalServerError, 500, "保存用途失败")
			return
		}
	} else if err := DB.Create(&CrontabTaskNote{
		AssetID: assetID, TaskKey: key, Purpose: purpose, UpdatedBy: operator,
	}).Error; err != nil {
		// 并发下可能刚好被别人抢先插入同一条 → 退化为更新，避免 500
		if err2 := DB.Model(&CrontabTaskNote{}).
			Where("asset_id = ? AND task_key = ?", assetID, key).
			Updates(fields).Error; err2 != nil {
			Fail(c, http.StatusInternalServerError, 500, "保存用途失败")
			return
		}
	}
	OK(c, crontabNoteResult{TaskKey: key, Purpose: purpose})
}
