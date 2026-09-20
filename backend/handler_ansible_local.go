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
func TestLocalAnsible(c *gin.Context) {
	if _, err := exec.LookPath("ansible"); err != nil {
		Fail(c, http.StatusServiceUnavailable, 503, "ansible 不在 PATH 中")
		return
	}
	hostsPath := Cfg.AnsibleHosts
	// 拼装 ansible all -i <hosts> --list-hosts -m ping -o
	// 用 list-hosts 是为了即便 hosts 为空也能快速给出可读输出
	cmd := fmt.Sprintf(`ansible all -i %s --list-hosts 2>&1; echo __SEP__; ansible all -i %s -m ping -o 2>&1`,
		shq(hostsPath), shq(hostsPath))
	ctx, cancel := newDeadlineContext(30 * time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "bash", "-c", cmd).CombinedOutput()
	parts := strings.Split(string(out), "__SEP__")
	listOut := ""
	pingOut := ""
	if len(parts) >= 1 {
		listOut = strings.TrimSpace(parts[0])
	}
	if len(parts) >= 2 {
		pingOut = strings.TrimSpace(parts[1])
	}
	OK(c, gin.H{
		"hosts":     listOut,
		"ping":      pingOut,
		"error":     errMsgOf(err),
		"hostsPath": hostsPath,
	})
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