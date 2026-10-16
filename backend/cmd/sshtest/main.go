// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

// 测试程序：模拟 webshell.go 的完整流程，自动化驱动 vim。
// 用法: sshtest (无参数)
//
// 跑通：dial -> requestPty(xterm) -> shell -> "clear; echo ...; su - root"
//
//	-> 等待 password 提示 -> 回填 root 密码 -> fixEnv -> 启动 vim
//	-> 发按键 i/h/e/l/l/o/Esc/:wq -> 验证 stdout 是否响应 + 文件内容
package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "FATAL:", err)
		os.Exit(1)
	}
}

// fixEnvProbe 完全复刻 backend/webshell.go 里的 probe 命令
const fixEnvProbe = "if [ -e /usr/share/terminfo/x/xterm-256color ] || [ -e /usr/share/terminfo/78/xterm-256color ] || [ -e /lib/terminfo/x/xterm-256color ] || [ -e /usr/lib/terminfo/x/xterm-256color ] || [ -e /etc/terminfo/x/xterm-256color ] || infocmp xterm-256color >/dev/null 2>&1; then T=xterm-256color; else T=xterm; fi; export TERM=$T; stty sane 2>/dev/null; clear\r"

func main() {
	const (
		host = "test-sshd"
		port = "22"
		user = "root"
		pass = "rootpass"
	)
	cfg := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.Password(pass)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}
	cli, err := ssh.Dial("tcp", host+":"+port, cfg)
	must(err)
	defer cli.Close()
	sess, err := cli.NewSession()
	must(err)
	defer sess.Close()
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.ICANON:        1,
		ssh.ISIG:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	must(sess.RequestPty("xterm", 40, 120, modes))
	_ = sess.Setenv("TERM", "xterm") // sshd 默认 AcceptEnv 不接受，会返回错误，按 webshell.go 忽略
	stdin, err := sess.StdinPipe()
	must(err)
	stdout, err := sess.StdoutPipe()
	must(err)
	sess.Stderr = sess.Stdout
	must(sess.Shell())

	// 抓取 stdout
	var buf bytes.Buffer
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(&buf, stdout)
		close(done)
	}()

	// 复刻 webshell.go 的 "clear 2>/dev/null; echo '[已连接 ... 正在切换到 root]'; su - root\r"
	// （这里直接 root 登录，所以不发 su 命令，但保持 echo 一致便于验证）
	time.Sleep(500 * time.Millisecond)
	_, _ = stdin.Write([]byte("clear 2>/dev/null; echo '[已连接 " + user + "@" + host + "]'; export PS1='ROOT# '\r"))

	// 模拟 fixEnv 触发（无 su 密码提示，直接在 500ms 后下发）
	time.Sleep(800 * time.Millisecond)
	_, _ = stdin.Write([]byte(fixEnvProbe))

	// 等 fixEnv 跑完（clear 完）
	time.Sleep(1500 * time.Millisecond)
	fmt.Println("--- AFTER fixEnv ---")
	fmt.Println(escape(buf.String()))
	buf.Reset()

	// 检查 TERM 与 stty
	_, _ = stdin.Write([]byte("echo TERM=$TERM; stty -a | head -2\r"))
	time.Sleep(800 * time.Millisecond)
	fmt.Println("--- ENV CHECK ---")
	fmt.Println(escape(buf.String()))
	buf.Reset()

	// 启动 vim
	_, _ = stdin.Write([]byte("rm -f /tmp/t.txt; vim -u NONE /tmp/t.txt\r"))
	time.Sleep(2500 * time.Millisecond)
	fmt.Println("--- AFTER vim launch ---")
	fmt.Println(escape(buf.String()))
	buf.Reset()

	// 按 i 进 insert
	_, _ = stdin.Write([]byte("i"))
	time.Sleep(800 * time.Millisecond)
	fmt.Println("--- AFTER 'i' (should see INSERT) ---")
	fmt.Println(escape(buf.String()))
	buf.Reset()

	// 输入 hello
	_, _ = stdin.Write([]byte("hello"))
	time.Sleep(800 * time.Millisecond)
	fmt.Println("--- AFTER 'hello' ---")
	fmt.Println(escape(buf.String()))
	buf.Reset()

	// Esc
	_, _ = stdin.Write([]byte("\x1b"))
	time.Sleep(800 * time.Millisecond)
	fmt.Println("--- AFTER Esc ---")
	fmt.Println(escape(buf.String()))
	buf.Reset()

	// :wq
	_, _ = stdin.Write([]byte(":wq\r"))
	time.Sleep(1500 * time.Millisecond)
	fmt.Println("--- AFTER :wq ---")
	fmt.Println(escape(buf.String()))
	buf.Reset()

	// 检查文件内容
	_, _ = stdin.Write([]byte("cat /tmp/t.txt; echo END\r"))
	time.Sleep(1000 * time.Millisecond)
	fmt.Println("--- FILE CONTENT ---")
	fmt.Println(escape(buf.String()))

	// 主动关闭 stdin/sess，让 io.Copy 完成 done channel
	_ = stdin.Close()
	_ = sess.Close()
	<-done
}

func escape(s string) string {
	s = strings.ReplaceAll(s, "\x1b", "<ESC>")
	s = strings.ReplaceAll(s, "\r", "<CR>\n")
	return s
}
