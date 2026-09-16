package main

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ============================================================================
// 中间件管控 —— 远端探测 / 启停动作 / 配置读写
//
// 执行口径（与定时任务模块完全一致，复用同一套提权解析）：
//   - SSH 直连目标机（AssetID>0 用资产字段；手动纳管用实例自带的连接信息）
//   - 管理目标用户默认 root；sudo 密码优先取实测结果（resolveSudoPass，
//     因为 sudo 校验的是调用者密码，资源清单里的「超级管理员用户密码」经常对不上）
//   - 先按登录用户直接执行，失败再提权重试
//
// 所有拼进远端 shell 的用户可控值（路径 / 端口 / 进程关键字）都经过
// 白名单校验或 shq() 单引号包裹，避免命令注入。
// ============================================================================

const (
	mwOpsProbeTimeout  = 45 * time.Second
	mwOpsActionTimeout = 150 * time.Second
	mwOpsConfigTimeout = 60 * time.Second
	mwOpsMaxConfigSize = 1 << 20 // 单个配置文件上限 1MB（base64 传输）
	mwOpsListLimit     = 200     // 配置候选展开上限
)

// mwOpsPatternOK pgrep 匹配串允许的字符白名单（其余剔除）
var mwOpsPatternOK = regexp.MustCompile(`[^A-Za-z0-9 _.:/|+*-]`)

// mwOpsUnitOK systemd 单元名白名单
var mwOpsUnitOK = regexp.MustCompile(`^[A-Za-z0-9@_.\-]+\.(service|socket|timer|target|path)$`)

// mwOpsPidFromProcField 从 ss / netstat 的进程列里取 PID
var mwOpsPidFromProcField = regexp.MustCompile(`(?:pid=(\d+))|(?:^(\d+)/)`)

// mwOpsVerRe 版本号形态（x.y.z）
var mwOpsVerRe = regexp.MustCompile(`\d+(?:\.\d+){1,3}`)

func mwOpsSanitizePattern(s string) string {
	return strings.TrimSpace(mwOpsPatternOK.ReplaceAllString(strings.TrimSpace(s), ""))
}

// mwOpsResolve 组装目标机访问信息。
// 资产实例以资产字段为准（改名 / 改密码后自动跟随）；手动纳管用实例自身的连接信息。
func mwOpsResolve(inst *MwInstance) (*crontabTarget, error) {
	if inst.AssetID > 0 {
		var a Asset
		if err := DB.First(&a, inst.AssetID).Error; err == nil {
			t, err := crontabSSHInfo(&a)
			if err != nil {
				return nil, err
			}
			return t, nil
		}
		// 资产已被删除 → 继续尝试实例自带连接信息
	}
	if strings.TrimSpace(inst.Host) == "" || strings.TrimSpace(inst.SSHUser) == "" || inst.SSHPass == "" {
		return nil, fmt.Errorf("实例未关联 CMDB 资产，且未填写完整的 SSH 连接信息（IP / 用户名 / 密码）")
	}
	port := 22
	if v, err := strconv.Atoi(strings.TrimSpace(inst.SSHPort)); err == nil && v > 0 && v < 65536 {
		port = v
	}
	runUser := strings.TrimSpace(inst.AdminUser)
	if runUser == "" {
		runUser = crontabDefaultRunUser
	}
	// 手动纳管实例同样走 ansible（按实例上的「网络区域」匹配控制节点，空则兜底第一台）
	runner, rerr := ResolveAnsibleRunner(strings.TrimSpace(inst.Zone))
	if rerr != nil {
		return nil, fmt.Errorf("未匹配到 ansible 控制节点（实例「网络区域」=%s）：%v",
			orDefault(strings.TrimSpace(inst.Zone), "空"), rerr)
	}
	return &crontabTarget{
		Client:  SSHClient{Host: strings.TrimSpace(inst.Host), Port: port, User: inst.SSHUser, Password: inst.SSHPass, BecomePass: inst.AdminPass},
		IP:      strings.TrimSpace(inst.Host),
		SSHUser: inst.SSHUser,
		RunUser: runUser,
		Runner:  runner,
		Zone:    strings.TrimSpace(inst.Zone),
	}, nil
}

// mwOpsPrivPrefix 提权前缀。RunUser 非 root 时显式带 -u。
//
// 已解析出的通道优先（避免每次都拿可能不对的「超级管理员用户密码」试一遍）。
func mwOpsPrivPrefix(t *crontabTarget) string {
	if t.plan.Kind == crontabChanSudo {
		return t.plan.Prefix
	}
	if t.resolvedPrefix != "" {
		return t.resolvedPrefix
	}
	if strings.TrimSpace(t.Client.BecomePass) == "" {
		return ""
	}
	p := strings.ReplaceAll(t.Client.BecomePass, "'", `'\''`)
	run := strings.TrimSpace(t.RunUser)
	if run == "" || run == "root" {
		return fmt.Sprintf("echo '%s' | sudo -S -p '' ", p)
	}
	return fmt.Sprintf("echo '%s' | sudo -S -p '' -u %s ", p, shq(run))
}

// mwOpsEnsurePriv 解析并应用本目标的采集通道（带指纹缓存）。
//
// 顺序与 crontab 读取路径完全一致（见 crontabTarget.privPlans）：
//  0. 其它模块已解析过 → 直接用（crontabPrivCache 按「主机+凭据」指纹共享，
//     于是「定时任务面板读一次」就能让中间件启停/捕捉秒级复用同一通道）；
//  1. sudo：实测出可用密码源（免密 → 超级管理员密码 → SSH 用户密码）。
//
// 全部不可用时返回 false，调用方沿用直连结果（保持旧行为，不阻断业务）。
func mwOpsEnsurePriv(t *crontabTarget) bool {
	run := strings.TrimSpace(t.RunUser)
	if run == "" || run == t.SSHUser {
		if run == "" {
			run = t.SSHUser
		}
		t.RunUser = run
		t.applyPlan(crontabPrivPlan{Kind: crontabChanDirect})
		return true
	}
	if p, ok := crontabPrivLookup(t); ok {
		t.applyPlan(p)
		return true
	}
	// sudo（实测密码源；resolveSudoPass 内部有二级缓存）
	res, err := resolveSudoPass(t.Runner, t.Client.Host, t.Client.Port, t.SSHUser, t.Client.Password, run, t.Client.BecomePass)
	if err == nil {
		t.Client.BecomePass = res.Pass
		t.resolvedPrefix = "" // 让 privPrefix 按实测结果重新拼（可能变成免密 = 空）
		if pre := mwOpsPrivPrefix(t); pre != "" {
			t.applyPlan(crontabPrivPlan{Kind: crontabChanSudo, Prefix: pre})
			crontabPrivRemember(t, t.plan)
			return true
		}
		// 免密 sudo：把前缀标记好，避免下次又去试密码
		pre := "sudo -n "
		if strings.TrimSpace(run) != "" && run != "root" {
			pre = "sudo -n -u " + shq(run) + " "
		}
		t.applyPlan(crontabPrivPlan{Kind: crontabChanSudo, Prefix: pre})
		crontabPrivRemember(t, t.plan)
		return true
	}
	return false
}

// mwOpsRunPriv 执行远端命令：先直连，失败再提权重试。
// 返回 (输出, 执行方式描述, 错误)。错误里带 stderr，便于在页面上直接给出原因。
//
// 提权三步走（顺序很重要）：
//  1. 未解析通道时，先拿请求里给的「超级管理员用户密码」当 sudo 密码试一次
//     （命中时最快，0.1s 级）；
//  2. 没命中就解析通道（sudo 免密/密码 实测）后重试；
//  3. 第 2 步是必须的：资源清单里的「超级管理员用户密码」在真实环境里经常并不是
//     sudo 密码（sudo 校验的是**调用者**的密码），只试一次会让所有启停 / 写配置动作
//     全部失败。
func mwOpsRunPriv(t *crontabTarget, script string, timeout time.Duration) (string, string, error) {
	// 直接（SSH 用户即跑脚本用户）。
	// 执行通道统一走 t.runScript：ansible 模式下是 `-m script`（SCP 到目标机再执行，
	// 天然不受 sshd argv/stdin ~1.2K 限制影响），无控制节点时才回退直连 SSH 的分段推送。
	out, err := t.runScript("", script, timeout)
	if err == nil {
		return out, t.Mode(), nil
	}
	directOut, directErr := out, err
	if strings.TrimSpace(t.RunUser) == "" || strings.TrimSpace(t.RunUser) == t.SSHUser {
		return directOut, "direct", directErr
	}
	if t.plan.Kind == "" {
		if pre := mwOpsPrivPrefix(t); pre != "" {
			if o2, e2 := t.runScript(pre, script, timeout); e2 == nil {
				return o2, "sudo", nil
			}
		}
		mwOpsEnsurePriv(t)
	}
	if pre := mwOpsPrivPrefix(t); pre != "" {
		if o2, e2 := t.runScript(pre, script, timeout); e2 == nil {
			return o2, t.Mode(), nil
		}
	}
	return directOut, "direct", directErr
}

// ---------------- 状态探测 ----------------

// mwOpsProc 一个匹配到的进程
type mwOpsProc struct {
	Pid     int    `json:"pid"`
	User    string `json:"user"`
	Elapsed string `json:"elapsed"`
	CPU     string `json:"cpu"`
	Mem     string `json:"mem"`
	Args    string `json:"args"`
}

// mwOpsPort 一条监听
type mwOpsPort struct {
	Addr string `json:"addr"`
	Port string `json:"port"`
	Pid  int    `json:"pid"`
	Proc string `json:"proc"`
}

// mwOpsUnit systemd 单元状态
type mwOpsUnit struct {
	Name  string `json:"name"`
	State string `json:"state"`
}

// mwOpsProbeResult 一次状态探测的解析结果
type mwOpsProbeResult struct {
	Pids    []int       `json:"pids"`
	Procs   []mwOpsProc `json:"procs"`
	Units   []mwOpsUnit `json:"units"`
	Systemd bool        `json:"systemd"`
	Ports   []mwOpsPort `json:"ports"`
	Dirs    []string    `json:"dirs"`
	VerRaw  string      `json:"verRaw"`
	Raw     string      `json:"raw"`
	Via     string      `json:"via"`
}

const (
	mwOpsMarkStart = "##OPHUB_MWOPS##"
	mwOpsMarkEnd   = "##OPHUB_MWOPS_END##"
)

// mwOpsProbeToken 探测脚本内的自识别标记。
//
// 为什么需要它：远端命令由 sshd 以 `sh -c "<整段脚本>"` 方式执行，脚本正文会出现在
// 这个 sh 进程的 cmdline 里 —— 于是 `pgrep -f "nginx: master"` 会把「承载探测脚本的
// shell 自己」也算进去，导致无论中间件是否在跑都返回「运行中」。
// 做法：脚本里埋一个固定标记串，逐 PID 读 /proc/<pid>/cmdline，命中标记的一律排除。
const mwOpsProbeToken = "__mwops_probe_self__"

// mwOpsProbeScript 生成只读探测脚本（一次 SSH 完成：进程 / systemd 单元 / 监听端口 / 安装目录 / 版本）。
// 脚本整体以 `;` 串接并用 true 收尾，保证退出码为 0（避免 SSH 把非零码当失败）。
func mwOpsProbeScript(pattern string, units []string, paths []string, verCmd string) string {
	pat := mwOpsSanitizePattern(pattern)
	var b strings.Builder
	b.WriteString(`echo "` + mwOpsMarkStart + `"; `)
	b.WriteString(`TOK=` + mwOpsProbeToken + `; `)
	// 1) 进程（先粗筛，再排除「承载本脚本的 shell」自身）
	if pat != "" {
		b.WriteString(`if command -v pgrep >/dev/null 2>&1; then RAW=$(pgrep -f -- "` + pat + `" 2>/dev/null); ` +
			`else RAW=$(ps -ef 2>/dev/null | grep -E "` + pat + `" | grep -v grep | awk '{print $2}'); fi; `)
	} else {
		b.WriteString(`RAW=""; `)
	}
	b.WriteString(`PIDS=""; for p in $RAW; do ` +
		`C=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null); ` +
		`case "$C" in *"$TOK"*) continue;; esac; ` +
		`case " $PIDS " in *" $p "*) continue;; esac; ` +
		`PIDS="$PIDS $p"; done; `)
	b.WriteString(`echo "PIDS=$PIDS"; `)
	b.WriteString(`if [ -n "$PIDS" ]; then ` +
		`PSL=$(ps -eo pid=,user=,etime=,pcpu=,pmem=,args= -p $(echo "$PIDS" | tr ' ' ',') 2>/dev/null); ` +
		`if [ -z "$PSL" ]; then PSL=$(ps -o pid=,user=,args= -p $(echo "$PIDS" | tr ' ' ',') 2>/dev/null); fi; ` +
		`echo "$PSL" | sed 's/^[[:space:]]*//' | awk 'NF>0{print "PS=" $0}'; fi; `)
	// 2) systemd 单元
	b.WriteString(`if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then echo "SYSTEMD=yes"; `)
	for _, u := range units {
		u = strings.TrimSpace(u)
		if u == "" || strings.ContainsAny(u, "'\"`$;|&<> \t") {
			continue
		}
		b.WriteString(`for n in "` + u + `" "` + u + `.service"; do ` +
			`E=$(systemctl list-unit-files --no-legend "$n" 2>/dev/null | awk 'NR==1{print $1}'); ` +
			`if [ -n "$E" ]; then echo "UNIT=$E|$(systemctl is-active "$E" 2>/dev/null)"; break; fi; done; `)
	}
	b.WriteString(`else echo "SYSTEMD=no"; fi; `)
	// 3) 监听端口（输出全部 TCP 监听，Go 侧按端口 / PID 过滤，避免远端复杂引用）
	b.WriteString(`(ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | awk 'NR>1{print "PORT=" $4 "|" $NF}' | head -200; `)
	// 4) 安装目录
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "'\"`$;|&<> \t") {
			continue
		}
		b.WriteString(`[ -d ` + shq(p) + ` ] && echo "DIR=` + p + `"; `)
	}
	// 5) 版本
	if vc := strings.TrimSpace(verCmd); vc != "" {
		b.WriteString(`V=$( ` + vc + ` 2>/dev/null | head -2 | tr '\n' ' '); echo "VER=$V"; `)
	}
	b.WriteString(`echo "` + mwOpsMarkEnd + `"; true`)
	return b.String()
}

// mwOpsParseProbe 解析探测输出
func mwOpsParseProbe(out string) *mwOpsProbeResult {
	r := &mwOpsProbeResult{Pids: []int{}, Procs: []mwOpsProc{}, Units: []mwOpsUnit{}, Ports: []mwOpsPort{}, Dirs: []string{}}
	r.Raw = out
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "PIDS="):
			for _, f := range strings.Fields(strings.TrimPrefix(line, "PIDS=")) {
				if n, err := strconv.Atoi(f); err == nil {
					r.Pids = append(r.Pids, n)
				}
			}
		case strings.HasPrefix(line, "PS="):
			fields := strings.Fields(strings.TrimPrefix(line, "PS="))
			if len(fields) < 2 {
				continue
			}
			p := mwOpsProc{Pid: atoiSafe(fields[0]), User: fields[1]}
			// 6 列表头（pid user etime pcpu pmem args）与 3 列表头（pid user args）都由 args 收尾
			if len(fields) >= 6 {
				p.Elapsed, p.CPU, p.Mem = fields[2], fields[3], fields[4]
				p.Args = strings.Join(fields[5:], " ")
			} else {
				p.Args = strings.Join(fields[2:], " ")
			}
			if p.Pid > 0 {
				r.Procs = append(r.Procs, p)
			}
		case strings.HasPrefix(line, "UNIT="):
			body := strings.TrimPrefix(line, "UNIT=")
			i := strings.LastIndex(body, "|")
			if i <= 0 {
				continue
			}
			name, state := strings.TrimSpace(body[:i]), strings.TrimSpace(body[i+1:])
			if !mwOpsUnitOK.MatchString(name) {
				continue
			}
			// 单元候选列表里可能既写了 "bws310" 又写了 "bws310.service"，
			// systemd 会把两者都解析到同一个单元 → 按名称去重，避免页面重复展示
			dup := false
			for _, u := range r.Units {
				if u.Name == name {
					dup = true
					break
				}
			}
			if dup {
				continue
			}
			r.Units = append(r.Units, mwOpsUnit{Name: name, State: state})
		case line == "SYSTEMD=yes":
			r.Systemd = true
		case strings.HasPrefix(line, "PORT="):
			body := strings.TrimPrefix(line, "PORT=")
			i := strings.LastIndex(body, "|")
			if i < 0 {
				continue
			}
			addr, proc := strings.TrimSpace(body[:i]), strings.TrimSpace(body[i+1:])
			if addr == "" {
				continue
			}
			p := mwOpsPort{Addr: addr, Proc: proc}
			p.Port = portOfAddr(addr)
			if m := mwOpsPidFromProcField.FindStringSubmatch(proc); m != nil {
				if m[1] != "" {
					p.Pid = atoiSafe(m[1])
				} else {
					p.Pid = atoiSafe(m[2])
				}
			}
			r.Ports = append(r.Ports, p)
		case strings.HasPrefix(line, "DIR="):
			if d := strings.TrimSpace(strings.TrimPrefix(line, "DIR=")); d != "" {
				r.Dirs = append(r.Dirs, d)
			}
		case strings.HasPrefix(line, "VER="):
			r.VerRaw = strings.TrimSpace(strings.TrimPrefix(line, "VER="))
		}
	}
	return r
}

func atoiSafe(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

// portOfAddr 从 "0.0.0.0:8089" / "*:17000" / "[::]:80" 中取端口
func portOfAddr(addr string) string {
	i := strings.LastIndex(addr, ":")
	if i < 0 || i == len(addr)-1 {
		return ""
	}
	return addr[i+1:]
}

// mwOpsProbe 探测实例状态。pickDirs 为候选安装路径（用于自动发现）。
func mwOpsProbe(inst *MwInstance, prof *MwOpsProfile) (*mwOpsProbeResult, error) {
	t, err := mwOpsResolve(inst)
	if err != nil {
		return nil, err
	}
	pattern := mwOpsPick(inst.ProcessPattern, prof.ProcessPattern)
	units := prof.UnitList()
	verCmd := mwOpsRenderCmd(prof.VersionCmd, inst, prof, nil, "")
	paths := []string{}
	if strings.TrimSpace(inst.InstallPath) != "" {
		paths = append(paths, strings.TrimSpace(inst.InstallPath))
	}
	for _, p := range prof.PathList() {
		if !containsStr(paths, p) {
			paths = append(paths, p)
		}
	}
	script := mwOpsProbeScript(pattern, units, paths, verCmd)
	out, via, rerr := mwOpsRunPriv(t, script, mwOpsProbeTimeout)
	res := mwOpsParseProbe(out)
	res.Via = via
	if rerr != nil && len(res.Procs) == 0 && res.Systemd == false && strings.TrimSpace(res.Raw) == "" {
		return res, fmt.Errorf("连接目标机失败：%v", rerr)
	}
	// 安装路径是本次探测发现时，用发现的路径补一次版本探测（首次纳管时版本号才拿得到）
	if strings.TrimSpace(res.VerRaw) == "" && strings.TrimSpace(inst.InstallPath) == "" &&
		len(res.Dirs) > 0 && strings.TrimSpace(prof.VersionCmd) != "" {
		tmp := *inst
		tmp.InstallPath = res.Dirs[0]
		vc := mwOpsRenderCmd(prof.VersionCmd, &tmp, prof, res, "")
		if out2, _, err2 := mwOpsRunPriv(t, vc+" 2>&1 | head -2", 20*time.Second); err2 == nil {
			res.VerRaw = strings.TrimSpace(out2)
		}
	}
	return res, nil
}

// mwOpsProbeStatus 由探测结果判定运行状态 + 人类可读摘要
func mwOpsProbeStatus(r *mwOpsProbeResult, inst *MwInstance) (string, string) {
	running := len(r.Pids) > 0
	activeUnit := ""
	for _, u := range r.Units {
		if u.State == "active" || u.State == "activating" || u.State == "reloading" {
			running = true
			if activeUnit == "" {
				activeUnit = u.Name + "(" + u.State + ")"
			}
		}
	}
	// 端口（优先取实例配置端口，否则取进程对应的监听）
	portHit := ""
	if want := strings.TrimSpace(inst.Port); want != "" {
		for _, p := range r.Ports {
			if p.Port == want {
				portHit = p.Addr
				break
			}
		}
	}
	if portHit == "" {
		pidSet := map[int]bool{}
		for _, p := range r.Pids {
			pidSet[p] = true
		}
		for _, p := range r.Ports {
			if p.Pid > 0 && pidSet[p.Pid] {
				portHit = p.Addr
				break
			}
		}
	}

	var parts []string
	if len(r.Procs) > 0 {
		parts = append(parts, fmt.Sprintf("进程 %d 个（PID %d）", len(r.Procs), r.Procs[0].Pid))
	}
	if activeUnit != "" {
		parts = append(parts, "服务 "+activeUnit)
	}
	if portHit != "" {
		parts = append(parts, "监听 "+portHit)
	}
	if running {
		if len(parts) == 0 {
			parts = append(parts, "运行中")
		}
		return MwOpsRunning, strings.Join(parts, " · ")
	}
	if len(parts) > 0 {
		return MwOpsStopped, strings.Join(append(parts, "未运行"), " · ")
	}
	if len(r.Dirs) == 0 {
		return MwOpsStopped, "未检测到进程 / 服务，且未发现安装目录（可能未安装或路径需在实例中指定）"
	}
	return MwOpsStopped, "未检测到进程 / 服务（安装目录存在：" + r.Dirs[0] + "）"
}

// ---------------- 动作（启停重启重载 / 结束进程） ----------------

// mwOpsRenderCtx 命令模板占位符取值
type mwOpsRenderCtx struct {
	Path string
	Sbin string
	Conf string
	Port string
	Pid  string
	Unit string
}

// mwOpsRender 渲染命令模板：{path} {sbin} {conf} {port} {pid} {unit}
func mwOpsRender(tpl string, ctx mwOpsRenderCtx) string {
	if strings.TrimSpace(tpl) == "" {
		return ""
	}
	rep := map[string]string{
		"{path}": shellArgOrEmpty(ctx.Path),
		"{sbin}": shellArgOrEmpty(ctx.Sbin),
		"{conf}": shellArgOrEmpty(ctx.Conf),
		"{port}": shellArgOrEmpty(ctx.Port),
		"{pid}":  shellArgOrEmpty(ctx.Pid),
		"{unit}": shellArgOrEmpty(ctx.Unit),
	}
	out := tpl
	for _, k := range []string{"{path}", "{sbin}", "{conf}", "{port}", "{pid}", "{unit}"} {
		out = strings.ReplaceAll(out, k, rep[k])
	}
	return out
}

func shellArgOrEmpty(v string) string {
	if strings.TrimSpace(v) == "" {
		return ""
	}
	return shq(strings.TrimSpace(v))
}

// mwOpsRenderCmd 便捷渲染（空探测结果也能用）
func mwOpsRenderCmd(tpl string, inst *MwInstance, prof *MwOpsProfile, probe *mwOpsProbeResult, confPath string) string {
	return mwOpsRender(tpl, mwOpsCtxOf(inst, prof, probe, confPath))
}

func mwOpsCtxOf(inst *MwInstance, prof *MwOpsProfile, probe *mwOpsProbeResult, confPath string) mwOpsRenderCtx {
	ip := strings.TrimSpace(inst.InstallPath)
	if ip == "" && probe != nil {
		if len(probe.Dirs) > 0 {
			ip = probe.Dirs[0]
		}
	}
	port := strings.TrimSpace(inst.Port)
	if port == "" && prof != nil {
		port = strings.TrimSpace(prof.DefaultPort)
	}
	pid := ""
	unit := strings.TrimSpace(inst.Unit)
	if probe != nil {
		if len(probe.Procs) > 0 {
			pid = strconv.Itoa(probe.Procs[0].Pid)
		}
		// 端口优先取实测监听（比配置默认值更真实）
		if strings.TrimSpace(inst.Port) == "" {
			pidSet := map[int]bool{}
			for _, p := range probe.Pids {
				pidSet[p] = true
			}
			for _, p := range probe.Ports {
				if p.Pid > 0 && pidSet[p.Pid] {
					port = p.Port
					break
				}
			}
		}
		if unit == "" && len(probe.Units) > 0 {
			unit = probe.Units[0].Name
		}
	}
	return mwOpsRenderCtx{
		Path: ip,
		Sbin: path.Join(ip, "sbin"),
		Conf: confPath,
		Port: port,
		Pid:  pid,
		Unit: unit,
	}
}

// 动作名
const (
	MwOpsActStart   = "start"
	MwOpsActStop    = "stop"
	MwOpsActRestart = "restart"
	MwOpsActReload  = "reload"
)

// mwOpsActionCmd 解析出真正要在目标机上执行的命令。
// 优先用 systemd（单元真实存在时最可靠），否则回退类型/实例的命令模板。
func mwOpsActionCmd(inst *MwInstance, prof *MwOpsProfile, probe *mwOpsProbeResult, action, confPath string) (string, string, error) {
	unit := strings.TrimSpace(inst.Unit)
	if unit == "" && probe != nil && probe.Systemd {
		for _, u := range probe.Units {
			if u.State != "" {
				unit = u.Name
				break
			}
		}
	}
	if unit != "" && mwOpsUnitOK.MatchString(unit) {
		switch action {
		case MwOpsActStart, MwOpsActStop, MwOpsActRestart, MwOpsActReload:
			return "systemctl " + action + " " + shq(unit), "systemd:" + unit, nil
		}
	}
	tpl := ""
	switch action {
	case MwOpsActStart:
		tpl = mwOpsPick(inst.CmdStart, prof.CmdStart)
	case MwOpsActStop:
		tpl = mwOpsPick(inst.CmdStop, prof.CmdStop)
	case MwOpsActRestart:
		tpl = mwOpsPick(inst.CmdRestart, prof.CmdRestart)
	case MwOpsActReload:
		tpl = mwOpsPick(inst.CmdReload, prof.CmdReload)
	}
	if strings.TrimSpace(tpl) == "" {
		hint := ""
		if prof != nil && prof.ProcessOnly {
			hint = "（该类型以进程管理为主，建议在「进程」里按 PID 操作，或在实例中补充自定义启停命令）"
		}
		return "", "", fmt.Errorf("未配置「%s」命令%s，请在「类型档案」或该实例中补充后重试", mwOpsActionLabel(action), hint)
	}
	cmd := mwOpsRender(tpl, mwOpsCtxOf(inst, prof, probe, confPath))
	return cmd, "template", nil
}

// mwOpsActionLabel 动作的中文名
func mwOpsActionLabel(action string) string {
	switch action {
	case MwOpsActStart:
		return "启动"
	case MwOpsActStop:
		return "停止"
	case MwOpsActRestart:
		return "重启"
	case MwOpsActReload:
		return "重载"
	}
	return action
}

// mwOpsRunAction 执行动作，返回命令、执行方式与输出
func mwOpsRunAction(inst *MwInstance, prof *MwOpsProfile, probe *mwOpsProbeResult, action, confPath string) (cmd, via, out string, err error) {
	t, rerr := mwOpsResolve(inst)
	if rerr != nil {
		return "", "", "", rerr
	}
	cmd, via, aerr := mwOpsActionCmd(inst, prof, probe, action, confPath)
	if aerr != nil {
		return "", "", "", aerr
	}
	o, runVia, e := mwOpsRunPriv(t, cmd, mwOpsActionTimeout)
	if e != nil {
		return cmd, via, o, fmt.Errorf("%s 执行失败：%v", mwOpsActionLabel(action), e)
	}
	return cmd, via + "/" + runVia, o, nil
}

// ---------------- 配置文件 ----------------

// mwOpsConfigFile 一个可纳管的配置文件
type mwOpsConfigFile struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
	Size   int    `json:"size"`
	Md5    string `json:"md5"`
	Mtime  string `json:"mtime"`
	Backup bool   `json:"backup"` // 是否存在 *.ophub.bak（可回滚）
}

// mwOpsConfigCandidates 渲染配置文件候选（保留通配，后续远端展开）
func mwOpsConfigCandidates(inst *MwInstance, prof *MwOpsProfile, probe *mwOpsProbeResult) []string {
	tpls := inst.ConfigPathList()
	if len(tpls) == 0 && prof != nil {
		tpls = prof.ConfigPathList()
	}
	ctx := mwOpsCtxOf(inst, prof, probe, "")
	out := []string{}
	for _, tpl := range tpls {
		p := strings.TrimSpace(mwOpsRender(tpl, ctx))
		p = strings.Trim(p, "'")
		if p == "" {
			continue
		}
		if !containsStr(out, p) {
			out = append(out, p)
		}
	}
	return out
}

// mwOpsListConfigFiles 展开候选（含 * 通配）并逐个探测状态
func mwOpsListConfigFiles(inst *MwInstance, prof *MwOpsProfile, probe *mwOpsProbeResult) ([]mwOpsConfigFile, error) {
	t, err := mwOpsResolve(inst)
	if err != nil {
		return nil, err
	}
	var concrete []string
	for _, c := range mwOpsConfigCandidates(inst, prof, probe) {
		if !strings.HasPrefix(c, "/") {
			continue
		}
		if !strings.Contains(c, "*") {
			if !containsStr(concrete, c) {
				concrete = append(concrete, c)
			}
			continue
		}
		dir, glob := path.Dir(c), path.Base(c)
		for _, name := range mwOpsListDir(t, dir) {
			if ok, _ := path.Match(glob, name); ok {
				full := dir + "/" + name
				if !containsStr(concrete, full) {
					concrete = append(concrete, full)
				}
			}
		}
		if len(concrete) >= mwOpsListLimit {
			break
		}
	}
	if len(concrete) == 0 {
		return []mwOpsConfigFile{}, nil
	}
	sort.Strings(concrete)

	// 一条命令批量取状态：CFG=path|size|md5|mtime|backupExists
	var b strings.Builder
	b.WriteString("for p in")
	for _, p := range concrete {
		b.WriteString(" " + shq(p))
	}
	b.WriteString(`; do if [ -f "$p" ]; then ` +
		`SZ=$(wc -c <"$p" 2>/dev/null | tr -d ' '); ` +
		`MD=$(md5sum "$p" 2>/dev/null | cut -c1-32); ` +
		`TM=$(stat -c %y "$p" 2>/dev/null || stat -f %Sm "$p" 2>/dev/null); ` +
		`BK=0; [ -f "$p.ophub.bak" ] && BK=1; ` +
		`echo "CFG=$p|$SZ|$MD|$TM|$BK"; else echo "MISS=$p"; fi; done; true`)
	out, _, rerr := mwOpsRunPriv(t, b.String(), mwOpsConfigTimeout)
	if rerr != nil && strings.TrimSpace(out) == "" {
		return nil, fmt.Errorf("读取配置文件状态失败：%v", rerr)
	}
	found := map[string]mwOpsConfigFile{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "CFG="):
			body := strings.TrimPrefix(line, "CFG=")
			parts := strings.SplitN(body, "|", 5)
			if len(parts) < 5 {
				continue
			}
			found[parts[0]] = mwOpsConfigFile{
				Path: parts[0], Exists: true, Size: atoiSafe(parts[1]),
				Md5: parts[2], Mtime: strings.TrimSpace(parts[3]), Backup: parts[4] == "1",
			}
		case strings.HasPrefix(line, "MISS="):
			p := strings.TrimSpace(strings.TrimPrefix(line, "MISS="))
			found[p] = mwOpsConfigFile{Path: p, Exists: false}
		}
	}
	res := make([]mwOpsConfigFile, 0, len(concrete))
	for _, p := range concrete {
		if v, ok := found[p]; ok {
			res = append(res, v)
		} else {
			res = append(res, mwOpsConfigFile{Path: p, Exists: false})
		}
	}
	return res, nil
}

// mwOpsListDir 列出远端目录下的条目名
func mwOpsListDir(t *crontabTarget, dir string) []string {
	if !reSafePath.MatchString(dir) {
		return nil
	}
	out, _, err := mwOpsRunPriv(t, fmt.Sprintf(`ls -1A %s 2>/dev/null | head -%d`, shq(dir), mwOpsListLimit), 20*time.Second)
	if err != nil {
		return nil
	}
	names := []string{}
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			names = append(names, l)
		}
	}
	return names
}

// mwOpsAssertPathAllowed 校验目标路径在该实例的候选范围内（防越权写任意文件）
func mwOpsAssertPathAllowed(inst *MwInstance, prof *MwOpsProfile, probe *mwOpsProbeResult, target string) error {
	target = strings.TrimSpace(target)
	if target == "" || !strings.HasPrefix(target, "/") || !reSafePath.MatchString(target) {
		return fmt.Errorf("非法的文件路径：%s", target)
	}
	for _, c := range mwOpsConfigCandidates(inst, prof, probe) {
		if c == target {
			return nil
		}
		if strings.Contains(c, "*") {
			if ok, _ := path.Match(c, target); ok {
				return nil
			}
		}
	}
	return fmt.Errorf("路径 %s 不在该实例的配置文件候选范围内，已拒绝写入（可在实例的「配置文件路径」中补充）", target)
}

// mwOpsReadConfig 读取远端配置文件内容
func mwOpsReadConfig(inst *MwInstance, target string) (string, error) {
	t, err := mwOpsResolve(inst)
	if err != nil {
		return "", err
	}
	cmd := fmt.Sprintf(`base64 %s 2>/dev/null | tr -d '\n'`, shq(target))
	out, _, rerr := mwOpsRunPriv(t, cmd, mwOpsConfigTimeout)
	if rerr != nil {
		return "", fmt.Errorf("读取失败：%v", rerr)
	}
	dec, derr := base64.StdEncoding.DecodeString(strings.TrimSpace(out))
	if derr != nil {
		return "", fmt.Errorf("内容解码失败（远端输出可能被截断）：%v", derr)
	}
	return string(dec), nil
}

// mwOpsWriteConfig 写回远端：临时文件 → 备份 *.ophub.bak → 原子替换 → 修正权限
//
// 关键点：重定向必须发生在**被提权的那个 shell 里**。
// 若写成 `printf|base64 -d > /etc/xxx.tmp` 再整条命令加 sudo 前缀，
// 重定向是由非特权的登录用户建立的——/etc/nginx 之类的目录不可写，写配置永远失败。
// 做法：先在 /tmp（所有用户可写）落临时文件，再用 `sudo sh -c '...'` 里做备份与 mv。
func mwOpsWriteConfig(inst *MwInstance, target, content string) error {
	if len(content) > mwOpsMaxConfigSize {
		return fmt.Errorf("配置内容过大（%d 字节，上限 %d）", len(content), mwOpsMaxConfigSize)
	}
	t, err := mwOpsResolve(inst)
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("/tmp/.ophub_mwops_%d.tmp", time.Now().UnixNano())
	enc := base64.StdEncoding.EncodeToString([]byte(content))
	q := strconv.Quote(target) // 路径已过 reSafePath 白名单，双引号包裹即足够
	tmpQ := strconv.Quote(tmp)
	// 1) 先在 /tmp（所有用户可写）把内容解出来；2) 备份原文件 → 原子替换 → 权限修正
	// 整条脚本由 mwOpsRunPriv 包成 `sh -c '...'` 后统一执行/提权，故重定向也跟着提权。
	script := fmt.Sprintf(`printf '%%s' %s | base64 -d > %s && cp -a %s %s.ophub.bak 2>/dev/null; mv -f %s %s && chmod 644 %s; rm -f %s`,
		shq(enc), tmpQ, q, q, tmpQ, q, q, tmpQ)
	if _, _, rerr := mwOpsRunPriv(t, script, mwOpsConfigTimeout); rerr != nil {
		return fmt.Errorf("写入失败：%v", rerr)
	}
	return nil
}

// mwOpsRestoreConfig 从 *.ophub.bak 回滚
func mwOpsRestoreConfig(inst *MwInstance, target string) error {
	t, err := mwOpsResolve(inst)
	if err != nil {
		return err
	}
	q := shq(target)
	cmd := fmt.Sprintf(`test -f %s.ophub.bak && cp -a %s.ophub.bak %s && chmod 644 %s`, q, q, q, q)
	if _, _, rerr := mwOpsRunPriv(t, cmd, mwOpsConfigTimeout); rerr != nil {
		return fmt.Errorf("回滚失败（可能不存在备份 %s.ophub.bak）：%v", target, rerr)
	}
	return nil
}

// mwOpsConfigTest 运行类型的配置校验命令（如 nginx -t）
func mwOpsConfigTest(inst *MwInstance, prof *MwOpsProfile, probe *mwOpsProbeResult, confPath string) (bool, string) {
	if prof == nil || strings.TrimSpace(prof.ConfigTestCmd) == "" {
		return true, "" // 该类型无校验命令
	}
	t, err := mwOpsResolve(inst)
	if err != nil {
		return false, err.Error()
	}
	cmd := mwOpsRender(prof.ConfigTestCmd, mwOpsCtxOf(inst, prof, probe, confPath))
	if strings.TrimSpace(cmd) == "" {
		return true, ""
	}
	out, _, rerr := mwOpsRunPriv(t, cmd+` 2>&1`, mwOpsConfigTimeout)
	ok := rerr == nil
	// nginx/php-fpm -t 成功/失败都会把结论写在输出里，输出含 failed/error 时按失败处理
	low := strings.ToLower(out)
	if ok && (strings.Contains(low, " failed") || strings.Contains(low, "emerg") || strings.Contains(low, "error")) {
		ok = false
	}
	return ok, strings.TrimSpace(out)
}

// mwOpsKillProcess 结束指定 PID（必须属于该实例当前匹配到的进程）
func mwOpsKillProcess(inst *MwInstance, prof *MwOpsProfile, probe *mwOpsProbeResult, pid int, signal string) (string, error) {
	if pid <= 0 {
		return "", fmt.Errorf("PID 不合法")
	}
	allowed := false
	for _, p := range probe.Pids {
		if p == pid {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", fmt.Errorf("PID %d 不属于该实例当前匹配到的进程，已拒绝操作（请先重新检测）", pid)
	}
	sig := "-15"
	if strings.TrimSpace(signal) == "9" || strings.EqualFold(strings.TrimSpace(signal), "kill") {
		sig = "-9"
	}
	t, err := mwOpsResolve(inst)
	if err != nil {
		return "", err
	}
	cmd := fmt.Sprintf(`kill %s %d`, sig, pid)
	out, _, rerr := mwOpsRunPriv(t, cmd, mwOpsConfigTimeout)
	if rerr != nil {
		return out, fmt.Errorf("结束进程失败：%v", rerr)
	}
	return out, nil
}

// ---------------- 小工具 ----------------

// mwOpsPick 取实例覆盖值，为空回退类型档案值
func mwOpsPick(instVal, profVal string) string {
	if strings.TrimSpace(instVal) != "" {
		return strings.TrimSpace(instVal)
	}
	return strings.TrimSpace(profVal)
}

func md5hex(s string) string {
	h := md5.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

// mwOpsParseVersion 从命令输出里抽取版本号（x.y.z）
func mwOpsParseVersion(raw string) string {
	if m := mwOpsVerRe.FindString(raw); m != "" {
		return m
	}
	return ""
}
