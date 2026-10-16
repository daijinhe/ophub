// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSHClient 远程 ansible 节点 SSH 客户端
type SSHClient struct {
	Host       string // 主机地址 (IP / 域名)
	Port       int    // SSH 端口
	User       string // SSH 用户
	Password   string // 密码（与 PrivateKey 二选一，可并存）
	PrivateKey string // SSH 私钥（PEM 文本，可选）
	BecomePass string // sudo 密码（可选；非空时使用 sudo -S 提权）
}

func (c SSHClient) dial() (*ssh.Client, error) {
	var methods []ssh.AuthMethod
	if strings.TrimSpace(c.PrivateKey) != "" {
		signer, err := ssh.ParsePrivateKey([]byte(c.PrivateKey))
		if err == nil {
			methods = append(methods, ssh.PublicKeys(signer))
		}
		// 私钥解析失败不直接返回，允许与密码并存时仍尝试密码
	}
	if c.Password != "" {
		methods = append(methods, ssh.Password(c.Password))
	}
	if len(methods) == 0 {
		return nil, fmt.Errorf("无可用认证方式（需提供密码或私钥）")
	}
	cfg := &ssh.ClientConfig{
		User:            c.User,
		Auth:            methods,
		HostKeyCallback: makeHostKeyCallback(),
		Timeout:         15 * time.Second,
	}
	return ssh.Dial("tcp", fmt.Sprintf("%s:%d", c.Host, c.Port), cfg)
}

// sudoPrefix 若设置了 becomePass，则返回 "echo '***' | sudo -S -p ” "；否则空串
// 内部会自动转义单引号，避免命令注入
func (c SSHClient) sudoPrefix() string {
	if c.BecomePass == "" {
		return ""
	}
	pass := strings.ReplaceAll(c.BecomePass, "'", "'\\''")
	return fmt.Sprintf("echo '%s' | sudo -S -p '' ", pass)
}

// runSSH 在已建立的连接上执行一条命令，返回 stdout / stderr / error
func runSSH(client *ssh.Client, cmd string) (string, string, error) {
	sess, err := client.NewSession()
	if err != nil {
		return "", "", err
	}
	defer sess.Close()
	var stdout, stderr bytes.Buffer
	sess.Stdout = &stdout
	sess.Stderr = &stderr
	err = sess.Run(cmd)
	return stdout.String(), stderr.String(), err
}

// Test 测试连通性，并附带收集 ansible 信息
// 不运行 `ansible --version`（会触发 ansible 内部 tmp 目录初始化，
// 在普通用户下会因 /tmp/.ansible/tmp/ 权限问题报错，与本平台无关）
func (c SSHClient) Test() (string, error) {
	client, err := c.dial()
	if err != nil {
		return "", err
	}
	defer client.Close()
	cmd := `echo PING-OK && uname -a && echo --- && echo 'ansible 路径:' && (command -v ansible || echo '未在 PATH 中找到 ansible（不影响本平台直接读写 hosts 文件）')`
	out, _, err := runSSH(client, cmd)
	if err != nil {
		return out, err
	}
	return out, nil
}

// ReadFile 读取远端文件（必要时通过 sudo），返回原始字节内容
// 若文件不可读（权限不足），返回明确错误提示，而不是悄悄返回空字符串
func (c SSHClient) ReadFile(path string) (string, error) {
	client, err := c.dial()
	if err != nil {
		return "", err
	}
	defer client.Close()
	// 先探测可读性（直接读 / sudo 读），不可读则直接返回明确错误，
	// 避免后续命令静默失败、用户看不到明确提示
	checkCmd := fmt.Sprintf(`if [ -r %s ]; then echo OK; elif %stest -r %s; then echo OK; else echo NO; fi`,
		shq(path), c.sudoPrefix(), shq(path))
	checkOut, checkStderr, _ := runSSH(client, checkCmd)
	if !strings.Contains(checkOut, "OK") {
		return "", fmt.Errorf("文件不可读：%s（请检查 SSH 用户权限，或在节点配置中设置 sudo 密码 / 配置 NOPASSWD sudo）: %s",
			path, strings.TrimSpace(checkStderr))
	}
	// 可读，开始读取
	cmd := fmt.Sprintf(`if [ -r %s ]; then cat %s; else %scat %s; fi | base64 -w 0`,
		shq(path), shq(path), c.sudoPrefix(), shq(path))
	out, _, err := runSSH(client, cmd)
	if err != nil {
		return "", fmt.Errorf("读取失败: %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(out))
	if err != nil {
		return "", fmt.Errorf("base64 解码失败: %v（远端输出可能被截断或非文本）: %s", err, out)
	}
	return string(decoded), nil
}

// WriteFile 写入远端文件（必要时通过 sudo），写入前备份原文件为 *.ophub.bak
// 先检查目录是否可写，避免写入时默默失败
func (c SSHClient) WriteFile(path, content string) error {
	client, err := c.dial()
	if err != nil {
		return err
	}
	defer client.Close()
	encoded := base64.StdEncoding.EncodeToString([]byte(content))
	// 先检查目录是否可写
	dir := path
	if idx := strings.LastIndex(path, "/"); idx > 0 {
		dir = path[:idx]
	}
	preCheck := fmt.Sprintf(`%stest -w %s && echo OK || echo NO`, c.sudoPrefix(), shq(dir))
	preOut, preStderr, _ := runSSH(client, preCheck)
	if !strings.Contains(preOut, "OK") {
		return fmt.Errorf("目录不可写：%s（请在节点配置中设置 sudo 密码或配置 NOPASSWD sudo）: %s",
			dir, strings.TrimSpace(preStderr))
	}
	// 写入临时文件 → 备份原文件 → 原子替换 → 修正权限
	// 用 sh 而非 bash：POSIX sh 在 CentOS/Alpine/busybox 上通用（bash 在 Alpine 会 127）
	cmd := fmt.Sprintf(`%ssh -c "echo %s | base64 -d > %s.ophub.tmp && cp %s %s.ophub.bak 2>/dev/null; mv -f %s.ophub.tmp %s && chmod 644 %s"`,
		c.sudoPrefix(), encoded, path, path, path, path, path, path)
	_, stderr, err := runSSH(client, cmd)
	if err != nil {
		return fmt.Errorf("写入失败: %v: %s", err, stderr)
	}
	return nil
}

// RunWithTimeout 执行远端命令并设置总体超时，避免目标机卡死导致 HTTP 请求长时间悬挂。
// 超时后强制关闭连接并返回明确错误（用于资源校准等交互式探测）。
//
// 实际执行逻辑被抽到 runDirect — 需要跑「shell 脚本」时改用 RunBigScript，
// 它会自动判断命令长度，超过 1500 字节走「分段推送 + bash 临时文件」路径，
// 以绕过某些 sshd 对 argv/stdin 严格 ~1.2K 的限制（Huawei Cloud EulerOS
// aarch64 上的 OpenSSH 8.8p1 实测会直接 reset TCP 连接）。
func (c SSHClient) RunWithTimeout(cmd string, timeout time.Duration) (string, error) {
	return c.runDirect(cmd, timeout)
}

// runDirect 原 RunWithTimeout 的实际执行逻辑被抽出到这个函数，便于 RunBigScript
// 在「短命令」路径上复用。
func (c SSHClient) runDirect(cmd string, timeout time.Duration) (string, error) {
	client, err := c.dial()
	if err != nil {
		return "", err
	}
	defer client.Close()
	type result struct {
		out string
		err error
	}
	ch := make(chan result, 1)
	go func() {
		out, stderr, err := runSSH(client, cmd)
		if err != nil {
			err = fmt.Errorf("%v: %s", err, strings.TrimSpace(stderr))
		}
		ch <- result{out: out, err: err}
	}()
	select {
	case r := <-ch:
		return r.out, r.err
	case <-time.After(timeout):
		_ = client.Close() // 关闭连接会让阻塞中的 session 立即返回，避免 goroutine 泄漏
		select {
		case r := <-ch:
			return r.out, fmt.Errorf("执行超时（%s）", timeout)
		default:
		}
		return "", fmt.Errorf("执行超时（%s）", timeout)
	}
}

// runBigScript 把 script 按段写到远端 /tmp/.mwcapture.sh，最后 bash 跑它。
//
// 详见 RunBigScript 注释。这里假定调用前已经判定 cmd 长度超阈值。
func (c SSHClient) runBigScript(sudoPrefix, script string, timeout time.Duration) (string, error) {
	client, err := c.dial()
	if err != nil {
		return "", err
	}
	defer client.Close()
	const tmpPath = "/tmp/.mwcapture.sh"
	// 先清空旧文件
	if _, _, err := runSSH(client, "rm -f "+shq(tmpPath)+" && : > "+shq(tmpPath)); err != nil {
		// 清空失败不致命：后续 echo overwrite 会覆盖
	}
	// 分段 base64 写入：每段压缩后 ~330 字节（raw=240），连 echo + base64 + 重定向
	// 整段命令字串仍 < 700 字节。阈值卡在某些奇葩 sshd 上（Huawei Cloud EulerOS
	// aarch64 实测约 1.2K 字节时会被 reset TCP，没有 stderr）— 留余量。
	const chunkRaw = 240
	enc := base64.StdEncoding
	for i := 0; i < len(script); i += chunkRaw {
		end := i + chunkRaw
		if end > len(script) {
			end = len(script)
		}
		b64 := enc.EncodeToString([]byte(script[i:end]))
		op := ">"
		if i > 0 {
			op = ">>"
		}
		writeCmd := fmt.Sprintf("(echo '%s' | base64 -d %s %s) && :", b64, op, shq(tmpPath))
		if _, stderr, err := runSSH(client, writeCmd); err != nil {
			return "", fmt.Errorf("脚本上传失败（offset=%d）：%v: %s", i, err, strings.TrimSpace(stderr))
		}
	}
	runCmd := "chmod 0755 " + shq(tmpPath)
	if _, stderr, err := runSSH(client, runCmd); err != nil {
		return "", fmt.Errorf("chmod 失败：%v: %s", err, strings.TrimSpace(stderr))
	}
	execCmd := "sh " + shq(tmpPath)
	if sudoPrefix != "" {
		execCmd = strings.TrimSpace(sudoPrefix) + " " + execCmd
	}
	out, stderr, err := runSSH(client, execCmd)
	if err != nil {
		return out, fmt.Errorf("%v: %s", err, strings.TrimSpace(stderr))
	}
	return out, nil
}

// runWithBigCmdLength RunScript 阈值：超过此字节数会被分桶走「分段 push 到
// 远端临时文件 + bash」路径；阈值以下走 RunWithTimeout 原路径。
const runWithBigCmdLength = 1500

// RunBigScript 在远端跑一段 shell 脚本（可能很长，~9KB）。
//
// 与 RunWithTimeout("sh -c " + shq(script), timeout) 的区别：当 script 较长（拼接
// 后超过 1500 字节）时，sshd 对 argv/stdin 长度有限制，把 9KB shell 直接 inline 进
// `sh -c '...'` 会触发某些 sshd reset 连接。
//
// 这里把脚本按 raw 字节切分到 ~240 字节/段，每段用 `echo <base64> | base64 -d (>|>>) /tmp/.mwcapture.sh`
// 这种短命令 + base64 推送到远端，最后用 `sh /tmp/.mwcapture.sh`（必要时前置 sudo 前缀）
// 跑它。整段代码 xfer 到 ssh 通道的全部命令字串都不超过 ~700 字节。
//
// sudoPrefix 同 RunWithTimeout：非空时会被拼在执行命令最外层。
func (c SSHClient) RunBigScript(sudoPrefix, script string, timeout time.Duration) (string, error) {
	fullCmd := "sh -c " + shq(script)
	if sudoPrefix != "" {
		fullCmd = strings.TrimSpace(sudoPrefix) + " " + fullCmd
	}
	if len(fullCmd) < runWithBigCmdLength {
		return c.RunWithTimeout(fullCmd, timeout)
	}
	return c.runBigScript(sudoPrefix, script, timeout)
}

// Run 在远端执行任意命令，返回合并的 stdout
func (c SSHClient) Run(cmd string) (string, error) {
	client, err := c.dial()
	if err != nil {
		return "", err
	}
	defer client.Close()
	out, stderr, err := runSSH(client, cmd)
	if err != nil {
		return out, fmt.Errorf("%v: %s", err, stderr)
	}
	return out, nil
}

// AnsibleInfo 节点 ansible 信息（拓展功能用）
type AnsibleInfo struct {
	AnsibleVersion string   `json:"ansibleVersion"` // ansible [core X.Y.Z]
	ConfigFile     string   `json:"configFile"`     // CONFIG FILE = ...
	PythonVersion  string   `json:"pythonVersion"`  // python version = ...
	HostsPath      string   `json:"hostsPath"`      // 节点自定义的路径
	PlaybookDirs   []string `json:"playbookDirs"`   // 探测到的 playbook 目录
}

// Info 收集节点 ansible / hosts / playbooks 信息
// 使用 `ansible --version` 失败时降级为空版本号，不强制要求 ansible --version 必须成功
func (c SSHClient) Info(remoteHostsPath string) (*AnsibleInfo, error) {
	client, err := c.dial()
	if err != nil {
		return nil, err
	}
	defer client.Close()

	info := &AnsibleInfo{HostsPath: remoteHostsPath}
	// 用 `2>&1 || true` 抑制 ansible 内部 tmp 目录初始化失败导致的非零退出
	out, _, _ := runSSH(client, "ansible --version 2>&1 || true")
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "ansible ") && !strings.Contains(line, "ERROR"):
			parts := strings.Fields(line)
			if len(parts) >= 3 {
				info.AnsibleVersion = strings.Join(parts[2:], " ")
			}
		case strings.HasPrefix(line, "  config file ="):
			info.ConfigFile = strings.TrimSpace(strings.TrimPrefix(line, "  config file ="))
		case strings.HasPrefix(line, "  python version ="):
			info.PythonVersion = strings.TrimSpace(strings.TrimPrefix(line, "  python version ="))
		}
	}

	// 探测常见 playbook 目录
	pbOut, _, _ := runSSH(client,
		"for d in /etc/ansible/playbooks /opt/ansible/playbooks $HOME/ansible/playbooks /root/ansible/playbooks /home/*/ansible/playbooks; do [ -d \"$d\" ] && echo \"$d\"; done; true")
	for _, line := range strings.Split(pbOut, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			info.PlaybookDirs = append(info.PlaybookDirs, line)
		}
	}
	return info, nil
}

// ToSSHClient 将数据库行转为 SSHClient
func (r AnsibleRemote) ToSSHClient() SSHClient {
	return SSHClient{
		Host:       r.Host,
		Port:       r.Port,
		User:       r.User,
		Password:   r.Password,
		PrivateKey: r.PrivateKey,
		BecomePass: r.BecomePass,
	}
}
