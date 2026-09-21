package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// 本机 Ansible 管理（v1.7.10 起新增）
//
// 与「远端 Ansible 管理」（/ansible/remotes/:id/...）并行：
//   - 远端管理：维护多台控制节点，各自 SSH 后管 hosts 文件 + 调 ansible
//   - 本机管理：直接管理 backend 容器内的 /etc/ansible/，在容器内 exec ansible
//
// 适用场景：服务器本身装了 ansible（内网部署的常见情形），没必要绕远端控制节点。
// ResolveAnsibleRunner 已优先尝试 LocalRunner，本页只是把 LocalRunner 的能力
// 完整暴露给用户看 + 排查故障用。
//
// 三类端点：
//   GET  /ansible/local/info  ：探测本机 ansible 版本、hosts 路径、playbook 目录
//   POST /ansible/local/test   ：执行 `ansible all -m ping`，输出可用性 + ping 结果
//   POST /ansible/local/exec   ：任意 ansible* 命令（白名单同远端 ExecRemoteCommand）
//
// 注意：本机模式的 ansible 在 backend 容器内以 root 运行；hosts 文件由
// ansible-data volume 管理（compose.yml: ansible-data:/etc/ansible）。
// ============================================================================

// localAnsibleInfo 本机 ansible 环境信息（前端「本机 Ansible 管理」首页展示用）
type localAnsibleInfo struct {
	Available       bool     `json:"available"`        // 本机 ansible 是否可用
	AnsibleVersion  string   `json:"ansibleVersion"`   // ansible --version 首行
	PythonVersion   string   `json:"pythonVersion"`    // ansible --version 中 python 版本行
	ConfigFile      string   `json:"configFile"`       // ansible.cfg 路径
	HostsPath       string   `json:"hostsPath"`        // /etc/ansible/hosts（=Cfg.AnsibleHosts）
	PlaybookDirs    []string `json:"playbookDirs"`     // 探测到的 playbook 目录
	Error           string   `json:"error"`            // 不可用时填这个
}

// GetLocalAnsibleInfo 探测本机 ansible 环境，前端「本机 Ansible 管理」首页展示。
func GetLocalAnsibleInfo(c *gin.Context) {
	info := localAnsibleInfo{
		HostsPath: Cfg.AnsibleHosts,
		PlaybookDirs: []string{},
	}
	// ansible 二进制
	if _, err := exec.LookPath("ansible"); err != nil {
		info.Available = false
		info.Error = "ansible 二进制不在 PATH 中（容器镜像未安装？）"
		OK(c, info)
		return
	}
	// ansible --version
	out, err := exec.Command("ansible", "--version").CombinedOutput()
	if err != nil {
		info.Available = false
		info.Error = fmt.Sprintf("ansible --version 失败：%v", err)
		OK(c, info)
		return
	}
	info.Available = true
	for _, ln := range strings.Split(string(out), "\n") {
		ln = strings.TrimSpace(ln)
		switch {
		case strings.HasPrefix(ln, "ansible [core"):
			info.AnsibleVersion = ln
		case strings.HasPrefix(ln, "  config file ="):
			info.ConfigFile = strings.TrimSpace(strings.TrimPrefix(ln, "  config file ="))
		case strings.HasPrefix(ln, "  python version ="):
			info.PythonVersion = strings.TrimSpace(strings.TrimPrefix(ln, "  python version ="))
		}
	}
	// 探测常用 playbook 目录
	for _, dir := range []string{
		"/etc/ansible/playbooks",
		"/data/ansible/playbooks",
		"/data/jenkins_home/ansible/playbooks",
	} {
		if entries, err := readDirNames(dir); err == nil && len(entries) > 0 {
			info.PlaybookDirs = append(info.PlaybookDirs, dir)
		}
	}
	OK(c, info)
}

// readDirNames 只列子项名（用于探测 playbook 目录是否非空）
func readDirNames(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names, nil
}

// TestLocalAnsible 执行 `ansible all -m ping` 并回传输出。
// 前端用这个确认 ansible 实际可用（不只是二进制存在）。
//
// v1.7.11 之前的实现走 `bash -c 'ansible ...'`，发现服务器上某些版本/manual 之间
// 会回 0 hosts（容器内手动 bash 同样命令能列出 403 台，差异在 Go exec 视角下某种 env
// 或 stdin 行为）。改为直接 `exec.CommandContext("ansible", ...)`，绕开 bash 这一层，
// 同时显式注入最小 env，避免 PID 1 进程的 env 影响 ansible 解析 inventory。
func TestLocalAnsible(c *gin.Context) {
	if _, err := exec.LookPath("ansible"); err != nil {
		Fail(c, http.StatusServiceUnavailable, 503, "ansible 不在 PATH 中")
		return
	}
	hostsPath := Cfg.AnsibleHosts
	// 显式最小 env：PATH 必含 ansible 所在；HOME 让 ansible 的 ~/.ansible/ 路径可定位；
	// LANG/LC_ALL=C.UTF-8 保 hosts 文件里的中文组名能正确解析（避免 CPython 默认 ASCII
	// 在某些 alpine 镜像里把 inventory 文件当二进制跳过）。
	execEnv := []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
	}
	runAnsible := func(args ...string) ([]byte, error) {
		ctx, cancel := newDeadlineContext(30 * time.Second)
		defer cancel()
		c := exec.CommandContext(ctx, "ansible", args...)
		c.Env = execEnv
		return c.CombinedOutput()
	}
	listOut, err1 := runAnsible("all", "-i", hostsPath, "--list-hosts")
	pingOut, err2 := runAnsible("all", "-i", hostsPath, "-m", "ping", "-o")
	// 调试用：回传实际跑了什么 + 容器视角，便于排障
	debugInfo := fmt.Sprintf(
		"hostsPath=%s\nhostsFileExists=%v\nhostsFileBytes=%d\ngoCmd=ansible %s\ngoEnv=%v\nerrList=%v\nerrPing=%v\n",
		hostsPath,
		fileExists(hostsPath),
		fileSize(hostsPath),
		strings.Join([]string{"all", "-i", hostsPath, "--list-hosts"}, " "),
		execEnv,
		err1, err2,
	)
	OK(c, gin.H{
		"hosts":     string(listOut),
		"ping":      string(pingOut),
		"error":     errMsgOf(err1) + " / " + errMsgOf(err2),
		"hostsPath": hostsPath,
		"_debug":    debugInfo,
	})
}

// fileExists 仅用于 TestLocalAnsible 的 _debug 输出，错误一律返回 false
func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// fileSize 返回文件字节数（错误时返 0）
func fileSize(p string) int {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return int(st.Size())
}

// ExecLocalCommand 在本机 backend 容器内执行任意 ansible* 命令。
// 白名单与远端 ExecRemoteCommand 一致（ansible / ansible-playbook / ansible-doc 等）。
func execLocalCommand(c *gin.Context) {
	if _, err := exec.LookPath("ansible"); err != nil {
		Fail(c, http.StatusServiceUnavailable, 503, "ansible 不在 PATH 中")
		return
	}
	var body struct {
		Command string `json:"command"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	cmd := strings.TrimSpace(body.Command)
	if cmd == "" {
		Fail(c, http.StatusBadRequest, 400, "命令不能为空")
		return
	}
	if err := validateAnsibleCmd(cmd); err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	ctx, cancel := newDeadlineContext(60 * time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "bash", "-c", cmd).CombinedOutput()
	if len(out) > 64*1024 {
		out = append(out[:64*1024], []byte("\n...(已截断)")...)
	}
	if err != nil {
		OK(c, gin.H{"stdout": string(out), "error": err.Error()})
		return
	}
	OK(c, gin.H{"stdout": string(out)})
}

// errMsgOf 把 exec 错误转成可读字符串（nil 时返回 ""）
func errMsgOf(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// 复用现有 shq / validateAnsibleCmd（来自 handler_ansible_remote.go / service_ansible_runner.go）。
// 跨文件同包直接可用，不需要额外 import。