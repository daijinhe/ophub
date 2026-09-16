package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

var wsUpgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
}

// wsMsg 前端 → 后端控制消息（resize / upload）
type wsMsg struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
	// upload 字段
	Path string `json:"path"` // 目标路径
	Data string `json:"data"` // base64 数据块
	Done bool   `json:"done"` // 是否最后一块
}

// WebShellHandler WebSocket SSH 终端：浏览器内直接连接目标机，自动以普通用户登录并 su - root
// 前端连接: /api/ws/ssh?assetId=1&token=<jwt>
func WebShellHandler(c *gin.Context) {
	// 1) query token 鉴权（WebSocket 无法携带 Header）
	token := c.Query("token")
	if token == "" || IsBlacklisted(token) {
		Fail(c, http.StatusUnauthorized, 401, "未登录")
		return
	}
	claims, err := ParseToken(token)
	if err != nil {
		Fail(c, http.StatusUnauthorized, 401, "登录已失效")
		return
	}
	var user User
	if err := DB.Preload("Roles").First(&user, claims.UserID).Error; err != nil || user.Status != 1 {
		Fail(c, http.StatusUnauthorized, 401, "用户不可用")
		return
	}
	// 终端为高敏感操作（可 su - root 拿到目标机最高权限）：仅内置 admin 角色可打开，
	// 避免只读 / 普通操作员角色通过 Web 终端取得目标机 root shell。
	if !isAdminUser(user.ID) {
		Fail(c, http.StatusForbidden, 403, "仅超级管理员可打开终端")
		return
	}
	permOK := false
	for _, r := range user.Roles {
		for _, p := range r.Permissions {
			if p == "cmdb:view" {
				permOK = true
				break
			}
		}
	}
	if !permOK {
		Fail(c, http.StatusForbidden, 403, "无权限: cmdb:view")
		return
	}

	// 2) 资产连接信息（用户密码管理）
	assetID, _ := strconv.Atoi(c.Query("assetId"))
	var a Asset
	if err := DB.First(&a, assetID).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "资产不存在")
		return
	}
	f := map[string]interface{}{}
	_ = json.Unmarshal(a.Fields, &f)
	get := func(k, def string) string {
		if s, ok := f[k].(string); ok && s != "" {
			return s
		}
		return def
	}
	host := get("虚拟机IPv4", a.IP)
	port := get("SSH端口", "65181")
	sshUser := get("普通用户", "")
	userPass := get("普通用户密码", "")
	rootUser := get("超级管理员用户", "root")
	rootPass := get("超级管理员用户密码", "")
	if host == "" || sshUser == "" || userPass == "" {
		Fail(c, http.StatusBadRequest, 400, "资产缺少连接信息（虚拟机IPv4 / 普通用户 / 普通用户密码）")
		return
	}

	// 3) 升级 WebSocket
	ws, err := wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	// 4) SSH 连接
	sshClient, err := ssh.Dial("tcp", host+":"+port, &ssh.ClientConfig{
		User:            sshUser,
		Auth:            []ssh.AuthMethod{ssh.Password(userPass)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         15 * time.Second,
	})
	if err != nil {
		ws.WriteMessage(websocket.TextMessage, []byte("\r\n\x1b[31m[SSH 连接失败] "+err.Error()+"\x1b[0m\r\n"))
		return
	}
	defer sshClient.Close()

	// SSH 层保活：长时间挂起的终端常因容器 NAT / 防火墙空闲回收被静默断开。
	// 每 30s 发一次 openssh keepalive，失败即关闭客户端，让会话正常收尾（而非死挂着假在线）。
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for range t.C {
			if _, _, err := sshClient.SendRequest("keepalive@openssh.com", true, nil); err != nil {
				_ = sshClient.Close()
				return
			}
		}
	}()

	session, err := sshClient.NewSession()
	if err != nil {
		ws.WriteMessage(websocket.TextMessage, []byte("\r\n\x1b[31m[会话创建失败] "+err.Error()+"\x1b[0m\r\n"))
		return
	}
	defer session.Close()

	modes := ssh.TerminalModes{
		ssh.ECHO:          1, // 回显开启（shell 正常态）
		ssh.ICANON:        1, // 规范模式（行缓冲，shell 正常态）
		ssh.ISIG:          1, // 允许 Ctrl+C / Ctrl+Z 等信号（vim 内 Ctrl+C 可被接收）
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	// 初始 TERM 用最通用的 xterm（几乎所有 Linux 都自带其 terminfo）。
	// 真正的 TERM 由登录后的 fixEnv() 探测决定：远端有 xterm-256color 才升级到 256 色，
	// 否则保持 xterm，避免最小化安装（RHEL/CentOS 缺 ncurses-term）因找不到 terminfo
	// 导致 vim/top/less 等全屏程序初始化失败、表现成“完全没反应”。
	_ = session.Setenv("TERM", "xterm")
	if err := session.RequestPty("xterm", 40, 120, modes); err != nil {
		ws.WriteMessage(websocket.TextMessage, []byte("\r\n\x1b[31m[PTY 请求失败] "+err.Error()+"\x1b[0m\r\n"))
		return
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		return
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		return
	}
	session.Stderr = session.Stdout
	if err := session.Shell(); err != nil {
		ws.WriteMessage(websocket.TextMessage, []byte("\r\n\x1b[31m[Shell 启动失败] "+err.Error()+"\x1b[0m\r\n"))
		return
	}

	b := &sshBridge{
		ws:        ws,
		stdin:     stdin,
		stdout:    stdout,
		session:   session,
		sshClient: sshClient,
		done:      make(chan struct{}),
		rootUser:  rootUser,
		rootPass:  rootPass,
	}
	// 登录后：提示 + 自动 su - root（随后由状态机检测密码提示并回填密码）
	stdin.Write([]byte("clear 2>/dev/null; echo '[已连接 " + sshUser + "@" + host + "，正在切换到 " + rootUser + "]'; su - " + rootUser + "\r"))
	b.suState = "waiting_prompt"

	// 兜底：若 2.5s 内未出现密码提示（如已是 root、免密 su、或提示非中英文），
	// 仍补发终端环境修复，保证 vim/top 等全屏程序能正常工作。
	go func() {
		time.Sleep(2500 * time.Millisecond)
		if b.suState != "done" {
			b.fixEnv()
		}
	}()

	go b.pumpStdout()
	go b.pumpStdin()

	// WebSocket 层保活：反向代理会回收长期无数据的连接（nginx 默认 60s，本项目已放宽到 3600s）。
	// 定时发 ping（浏览器自动回 pong）避免纯挂起的终端被中间层静默断开。WriteControl 可与其它
	// 写方法并发调用，故无需 wmu。
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-b.done:
				return
			case <-t.C:
				if err := b.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
					return
				}
			}
		}
	}()

	<-b.done
	_ = session.Close()
}

type sshBridge struct {
	ws        *websocket.Conn
	stdin     io.WriteCloser
	stdout    io.Reader
	session   *ssh.Session
	sshClient *ssh.Client
	done      chan struct{}
	rootUser  string
	rootPass  string
	suState   string // "" | waiting_prompt | done
	suEnvSent bool   // 是否已下发终端环境修复（stty sane + TERM）

	mu          sync.Mutex
	wmu         sync.Mutex
	sftpClient  *sftp.Client
	uploadFile  *sftp.File
	uploadPath  string
	uploadBytes int
}

// wsText 串行化写一条文本消息。
// gorilla/websocket 不支持并发写：pumpStdout（SSH 输出）与 pumpStdin→handleUpload
// （上传提示）可能同时触发写，不加锁会损坏帧、随机断开，表现为终端「不稳定/自己重连」。
func (b *sshBridge) wsText(p []byte) {
	b.wmu.Lock()
	defer b.wmu.Unlock()
	_ = b.ws.WriteMessage(websocket.TextMessage, p)
}

// writeMsg 向后端终端写入一行提示
func (b *sshBridge) writeMsg(s string) {
	b.wsText([]byte("\r\n" + s + "\r\n"))
}

// fixEnv 登录后修复终端环境：su - 会重置环境变量并可能把 PTY 留在异常模式，
// 导致 vim/top/less 等全屏程序无法切换到 raw 模式（表现为快捷键全部失效）。
// 这里下发 stty sane 把终端恢复到规范/回显基线，并自适应选择 TERM。幂等。
func (b *sshBridge) fixEnv() {
	b.mu.Lock()
	if b.suEnvSent {
		b.mu.Unlock()
		return
	}
	b.suEnvSent = true
	b.mu.Unlock()
	// 自适应 TERM：优先 xterm-256color（颜色更丰富），但若远端 terminfo 缺失
	// （最小化安装的 RHEL/CentOS 常见，条目在 ncurses-term 包内、默认不装），
	// 则降级到通用 xterm，保证 vim/top/less 能正常初始化。
	// 必须在 export TERM 之后再 clear，否则 clear 会用错误的 TERM 重绘。
	probe := "if [ -e /usr/share/terminfo/x/xterm-256color ] || [ -e /usr/share/terminfo/78/xterm-256color ] || [ -e /lib/terminfo/x/xterm-256color ] || [ -e /usr/lib/terminfo/x/xterm-256color ] || [ -e /etc/terminfo/x/xterm-256color ] || infocmp xterm-256color >/dev/null 2>&1; then T=xterm-256color; else T=xterm; fi; export TERM=$T; stty sane 2>/dev/null; clear\r"
	_, _ = b.stdin.Write([]byte(probe))
}

// ensureSFTP 懒创建 SFTP 客户端
func (b *sshBridge) ensureSFTP() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.sftpClient == nil {
		sc, err := sftp.NewClient(b.sshClient)
		if err != nil {
			return err
		}
		b.sftpClient = sc
	}
	return nil
}

// handleUpload 处理文件上传块：seq=0 建文件，随后追加，done 关闭并提示
func (b *sshBridge) handleUpload(m wsMsg) {
	if m.Path == "" {
		b.writeMsg("\x1b[31m[上传失败] 缺少目标路径\x1b[0m")
		return
	}
	if b.uploadFile == nil {
		if err := b.ensureSFTP(); err != nil {
			b.writeMsg("\x1b[31m[上传失败] SFTP 初始化失败: " + err.Error() + "\x1b[0m")
			return
		}
		path := m.Path
		if strings.HasPrefix(path, "~") {
			if wd, err := b.sftpClient.Getwd(); err == nil {
				path = strings.Replace(path, "~", wd, 1)
			}
		}
		f, err := b.sftpClient.Create(path)
		if err != nil {
			b.writeMsg("\x1b[31m[上传失败] " + err.Error() + "\x1b[0m")
			return
		}
		b.uploadFile = f
		b.uploadPath = path
		b.uploadBytes = 0
		b.writeMsg("\x1b[33m[上传中] " + path + "\x1b[0m")
	}
	if m.Data != "" {
		raw, err := base64.StdEncoding.DecodeString(m.Data)
		if err == nil && len(raw) > 0 {
			_, _ = b.uploadFile.Write(raw)
			b.uploadBytes += len(raw)
		}
	}
	if m.Done {
		_ = b.uploadFile.Close()
		b.uploadFile = nil
		b.writeMsg("\x1b[32m[上传完成] " + b.uploadPath + "（" + fmtBytes(b.uploadBytes) + "）\x1b[0m")
		b.uploadPath = ""
	}
}

func fmtBytes(n int) string {
	switch {
	case n >= 1048576:
		return strconv.FormatFloat(float64(n)/1048576, 'f', 1, 64) + " MB"
	case n >= 1024:
		return strconv.FormatFloat(float64(n)/1024, 'f', 1, 64) + " KB"
	default:
		return strconv.Itoa(n) + " B"
	}
}

// pumpStdout SSH 输出 → WebSocket，并检测 su 密码提示自动回填
func (b *sshBridge) pumpStdout() {
	defer close(b.done)
	buf := make([]byte, 8192)
	for {
		n, err := b.stdout.Read(buf)
		if n > 0 {
			if b.suState == "waiting_prompt" {
				low := strings.ToLower(string(buf[:n]))
				if strings.Contains(low, "password") || strings.Contains(low, "口令") || strings.Contains(low, "密码") {
					b.suState = "done"
					go func() {
						time.Sleep(500 * time.Millisecond)
						_, _ = b.stdin.Write([]byte(b.rootPass + "\r"))
						time.Sleep(400 * time.Millisecond)
						b.fixEnv()
					}()
				}
			}
			b.wsText(buf[:n])
		}
		if err != nil {
			b.wsText([]byte("\r\n\x1b[33m[连接已断开]\x1b[0m\r\n"))
			return
		}
	}
}

// pumpStdin WebSocket → SSH stdin（支持 resize / upload 控制消息）
func (b *sshBridge) pumpStdin() {
	for {
		mt, msg, err := b.ws.ReadMessage()
		if err != nil {
			// 前端 WebSocket 已断开（关窗 / 网络中断）：主动关闭 SSH 会话，让 pumpStdout
			// 随之退出并 close(done)，避免后端会话与 SSH 连接泄漏（长期运行会累积成不稳定）。
			_ = b.session.Close()
			return
		}
		if mt == websocket.TextMessage {
			// 尝试解析控制消息
			var ctl wsMsg
			if json.Unmarshal(msg, &ctl) == nil && ctl.Type != "" {
				switch ctl.Type {
				case "resize":
					if ctl.Cols > 0 && ctl.Rows > 0 {
						_ = b.session.WindowChange(ctl.Rows, ctl.Cols)
					}
					continue
				case "upload":
					b.handleUpload(ctl)
					continue
				}
			}
			_, _ = b.stdin.Write(msg)
		}
	}
}
