package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
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
	// Origin 白名单由 env ALLOW_WS_ORIGINS / ALLOW_WS_ANY_ORIGIN 控制（默认拒绝跨域）。
	// 与 DB 无关是为了即使前端未配置也不能裸奔；如确实需要全开（仅推荐开发环境）
	// 由 ALLOW_WS_ANY_ORIGIN=true 打开。
	CheckOrigin:     wsCheckOrigin,
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
}

// wsCheckOrigin 校验 WebSocket upgrade 的 Origin 头。
//
// 判定顺序（任一命中即放行）：
//  1. 无 Origin：非浏览器客户端（CLI / curl / 探活脚本）不带 Origin → 放行；
//  2. ALLOW_WS_ANY_ORIGIN=true：显式全放行（仅调试用）；
//  3. **同源**：Origin 的 host[:port] 与请求 Host 一致 → 放行。
//     平台会被内网不同 IP / 域名访问（10.x/192.168.x/主机名），逐条写死白名单不现实，
//     「同源」才是贴合实际且安全的默认策略。
//  4. ALLOW_WS_ORIGINS 显式白名单（逗号分隔）匹配 → 放行；列表里写 `*` 表示全放行。
//
// ⚠️ 历史坑（v1.7.0 引入 403）：当时 getWsOrigins() 在 ALLOW_WS_ORIGINS 为空时会
// 回落到 CORS 的 ALLOW_ORIGINS（`.env` 默认 `*`），而这里的比较是**字面量**比较，
// `*` 与 `http://localhost:10001` 永不相等 → 浏览器（升级 WS 必带 Origin）100% 被拒。
// 现在：白名单里的 `*` 按下标通配处理，且不再从 CORS 配置回落（见 getWsOrigins）。
func wsCheckOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// 非浏览器客户端（CLI、curl、监测）一般不带 Origin；允许。
		return true
	}
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("ALLOW_WS_ANY_ORIGIN"))); v == "true" || v == "1" || v == "yes" {
		return true
	}
	// 同源放行（协议不敏感：兼容 https 反代与 http 直连的混用）。
	if sameOrigin(origin, r.Host) {
		return true
	}
	allowList := strings.TrimSpace(getWsOrigins())
	for _, a := range strings.Split(allowList, ",") {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		if a == "*" {
			// 显式通配：仅当运维明确在 ALLOW_WS_ORIGINS 里写 `*` 才生效。
			log.Println("[ws] ALLOW_WS_ORIGINS 含 `*`：WebSocket 已全放行（仅建议调试期使用）")
			return true
		}
		if strings.EqualFold(strings.TrimRight(a, "/"), strings.TrimRight(origin, "/")) {
			return true
		}
	}
	log.Printf("[ws] 拒绝跨域 WebSocket：Origin=%q Host=%q ALLOW_WS_ORIGINS=%q（同源或加入白名单后重试）", origin, r.Host, allowList)
	return false
}

// sameOrigin 判断 Origin 头的 host[:port] 是否与请求的 Host 一致。
//
// 两种形态都接受：
//   - Host 带端口（nginx 配 `proxy_set_header Host $http_host`）→ 精确比 host:port；
//   - Host 不带端口（nginx 用 `$host`，端口被吃掉）→ 只比 hostname（容错，否则必然误判跨域）。
//
// 说明：容错分支只放宽了「端口」，域名仍必须一致，且本端点还要求一次性 ticket，
// 因此不会让 evil.com 之类的跨站页面拿到终端。
func sameOrigin(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || host == "" {
		return false
	}
	if strings.EqualFold(u.Host, host) {
		return true
	}
	// Host 无端口 → 退化为 hostname 比较。
	if !strings.Contains(host, ":") {
		return strings.EqualFold(u.Hostname(), host)
	}
	return false
}

// getWsOrigins 返回 WebSocket 白名单。
//
// ⚠️ 刻意**不**回落 CORS 的 ALLOW_ORIGINS：CORS 里的 `*` 是为普通 AJAX 放行，
// 而 WebSocket 一旦通配就等于放弃跨站劫持防护（v1.7.0 引入白名单的初衷）。
// 空字符串 = 只允许同源访问，跨域需求请显式配置 ALLOW_WS_ORIGINS。
func getWsOrigins() string {
	return strings.TrimSpace(os.Getenv("ALLOW_WS_ORIGINS"))
}

// publicRegistrationAllowed 公开注册开关。
func publicRegistrationAllowed() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("ALLOW_PUBLIC_REGISTER")))
	return v == "true" || v == "1" || v == "yes"
}

// publicRegistrationDisabledHandler 注册被关闭时的兜底响应（前端可识别并显示提示）。
func publicRegistrationDisabledHandler(c *gin.Context) {
	c.JSON(http.StatusForbidden, gin.H{
		"code":    403,
		"message": "公开注册已关闭（默认安全策略）。如需开启请设置环境变量 ALLOW_PUBLIC_REGISTER=true 并重启后端",
	})
}

// enforceProductionSecrets 生产环境强制密钥非默认值（v1.7.1 引入）。
//
//   - JWT_SECRET 仍是默认值 + .dev 以外 → panic（拒绝启动）
//   - PWD_ENC_KEY 仍是默认值 + 仍是 .dev 以外 → panic
//   - dev 环境打 warning，但仍允许启动，方便本机开发
//
// 生成强随机密钥：`openssl rand -base64 48` 或 `head -c 48 /dev/urandom | base64`。
func enforceProductionSecrets(c Config) {
	if strings.EqualFold(c.Env, "dev") {
		// 开发环境仍打印 warning，便于发现「忘改密钥就上生产」
		if c.JWTSecret == "ophub-secret-change-me" {
			log.Println("[警告] dev 环境仍使用默认 JWT_SECRET；上线前务必修改")
		}
		if c.PwdEncKey == "" {
			log.Println("[警告] dev 环境未配置 PWD_ENC_KEY；将使用内置默认值")
		}
		return
	}
	mustChange := false
	if c.JWTSecret == "ophub-secret-change-me" || c.JWTSecret == "" {
		log.Println("[panic] 检测到 JWT_SECRET 仍是内置默认值或为空")
		mustChange = true
	}
	if c.PwdEncKey == "" || c.PwdEncKey == "ophub-default-pwd-enc-key-please-change" {
		log.Println("[panic] 检测到 PWD_ENC_KEY 仍是内置默认值或为空")
		mustChange = true
	}
	if mustChange {
		log.Fatalf("生产环境必须显式设置 JWT_SECRET 与 PWD_ENC_KEY。可用：openssl rand -base64 48")
	}
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
	// 1) 用一次性 ticket 鉴权（v1.7.1 改造，规避 token 走 URL 进 nginx access log）。
	//    调用方先 POST /api/ws/ssh/ticket 拿一个 60s 一次性的 ticket，
	//    再用 ws://.../api/ws/ssh?ticket=xxx&assetId=N 升级 WebSocket。
	//    ticket 在 ws 升级成功后才消费（consume），升级失败时 ticket 仍可用。
	ticket := c.Query("ticket")
	var (
		uidFromTicket uint
		uidLegacy     uint
		legacyMode    bool
	)
	if ticket == "" {
		if !strings.EqualFold(os.Getenv("ALLOW_WS_TOKEN_URL"), "true") {
			Fail(c, http.StatusUnauthorized, 401, "WebSocket 需要先调用 /api/ws/ssh/ticket 获取一次性 ticket")
			return
		}
		legacyMode = true
		uid, err := getUIDFromToken(c.Query("token"))
		if err != nil || uid == 0 {
			Fail(c, http.StatusUnauthorized, 401, "登录已失效")
			return
		}
		uidLegacy = uid
	} else {
		prev, err := peekWSTicket(ticket)
		if err != nil {
			Fail(c, http.StatusUnauthorized, 401, "ticket 无效或已过期："+err.Error())
			return
		}
		uidFromTicket = prev.UserID
	}
	uid := uidFromTicket
	if uid == 0 {
		uid = uidLegacy
	}
	var user User
	if err := DB.Preload("Roles").First(&user, uid).Error; err != nil || user.Status != 1 {
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
	// P1-3：解密拿 SSH 凭据（数据库里是密文）
	_ = decryptAssetFields(f)
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

	// 3) 升级 WebSocket（Origin 由 wsUpgrader.CheckOrigin 校验）
	ws, err := wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	// 升级成功 → 立即消费 ticket（一次性）。后续 SSH 任何失败都不再退还。
	if !legacyMode && ticket != "" {
		_, _ = consumeWSTicket(ticket)
	}

	// 4) SSH 连接
	sshClient, err := ssh.Dial("tcp", host+":"+port, &ssh.ClientConfig{
		User:            sshUser,
		Auth:            []ssh.AuthMethod{ssh.Password(userPass)},
		HostKeyCallback: makeHostKeyCallback(),
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
//
// 安全约束（v1.7.1+ · P1-8）：
//   - 仅 allowlist 内的目标目录（默认 /tmp/ /data/ /home/<user>/uploads/）；
//     禁止写到 /etc /root/.ssh /var/spool/cron 等敏感路径。
//   - 文件扩展名限制在白名单（.sh .conf .txt .tar.gz 等）；禁止 .so .py .elf。
//   - 最终路径：解析后的绝对路径必须在 allowlist 任一条目下（含前缀匹配 /home/<user>/uploads）。
//   - 单文件大小上限 10 MiB（base64 算上 ~13.3 MiB），避免 admin 在目标机被一齐拖到 OOM。
func (b *sshBridge) handleUpload(m wsMsg) {
	if m.Path == "" {
		b.writeMsg("\x1b[31m[上传失败] 缺少目标路径\x1b[0m")
		return
	}
	// 1) 路径合法性
	if err := wsUploadCheckPath(m.Path); err != nil {
		b.writeMsg("\x1b[31m[上传失败] " + err.Error() + "\x1b[0m")
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
		// 2) 实时前缀再校验一次（sftp.Getwd 返回的可能是 /root/，而我们最终路径仍是 CLI 拿到的）
		if abs, err := b.sftpClient.RealPath(path); err == nil {
			if err2 := wsUploadCheckAbsPath(abs); err2 != nil {
				b.writeMsg("\x1b[31m[上传失败] " + err2.Error() + "\x1b[0m")
				return
			}
			path = abs
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
	// 3) 单块大小上限（base64 长度 <= 14 MiB 解码约 10 MiB；防止一次大文件写爆 sftpClient 内 buf）
	if len(m.Data) > 14*1024*1024 {
		b.writeMsg("\x1b[31m[上传失败] 单块过大（>14MiB base64），请用 smaller chunks\x1b[0m")
		_ = b.uploadFile.Close()
		b.uploadFile = nil
		return
	}
	if m.Data != "" {
		raw, err := base64.StdEncoding.DecodeString(m.Data)
		if err == nil && len(raw) > 0 {
			_, _ = b.uploadFile.Write(raw)
			b.uploadBytes += len(raw)
		}
	}
	if b.uploadBytes > wsUploadMaxSize {
		b.writeMsg(fmt.Sprintf("\x1b[31m[上传失败] 单文件超 %d MiB 上限\x1b[0m", wsUploadMaxSize/(1024*1024)))
		_ = b.uploadFile.Close()
		b.uploadFile = nil
		return
	}
	if m.Done {
		_ = b.uploadFile.Close()
		b.uploadFile = nil
		b.writeMsg("\x1b[32m[上传完成] " + b.uploadPath + "（" + fmtBytes(b.uploadBytes) + "）\x1b[0m")
		b.uploadPath = ""
	}
}

// wsUploadMaxSize 单文件硬上限（10 MiB）。
const wsUploadMaxSize = 10 * 1024 * 1024

// wsUploadAllowedExts 允许的扩展名（小写，含 "."）。其它一律拒绝。
// 故意没列可执行类（.so .py .sh 不允许基线），避免直接往主机写脚本后被 cron 触发。
var wsUploadAllowedExts = map[string]bool{
	".txt":        true,
	".log":        true,
	".md":         true,
	".json":       true,
	".csv":        true,
	".conf":       true,
	".cfg":        true,
	".ini":        true,
	".yaml":       true,
	".yml":        true,
	".xml":        true,
	".properties": true,
	".tar":        true,
	".gz":         true,
	".tgz":        true,
	".zip":        true,
	".bak":        true,
	".bak.":       true, // 任意 .bak.* 也允许
}

// wsUploadAllowedPrefixes 允许上传到的目标路径前缀（绝对路径）。
//
// 含义：写入文件的绝对路径必须以其中任一条为前缀。
// 系统常用敏感路径（/etc、/var/spool/cron、/root/.ssh）故意**不**列在白名单；
// 写出清单后由审计/SOC 复核。
func wsUploadAllowedPrefixes() []string {
	return []string{
		"/tmp/",
		"/var/tmp/",
		"/data/",
		"/srv/",
		"/opt/ophub_uploads/",
	}
}

// wsUploadCheckPath 客户端提交路径的合法性（前置校验）；通过后再用 RealPath 二次校验。
func wsUploadCheckPath(path string) error {
	if path == "" {
		return fmt.Errorf("路径为空")
	}
	// 拒绝绝对 /etc 类、否定前缀
	for _, deny := range []string{"/etc/", "/etc", "/var/spool/cron/", "/root/.ssh/", "/usr/lib/", "/usr/bin/", "/bin/", "/sbin/"} {
		if strings.HasPrefix(path, deny) {
			return fmt.Errorf("禁止的上传路径前缀：%s", deny)
		}
	}
	// 拒绝 .. 路径片段
	for _, seg := range strings.Split(path, "/") {
		if seg == ".." {
			return fmt.Errorf("路径中禁止 '..' 片段")
		}
	}
	// 扩展名白名单
	ext := strings.ToLower(filepath.Ext(path))
	if ext == "" {
		return fmt.Errorf("文件无扩展名，不允许上传（请显式给出）")
	}
	// .bak.<ext> 也允许
	if !wsUploadAllowedExts[ext] {
		// 仅在 ".bak" 不是 ext（如 "x.bak.txt"）时再放过
		base := filepath.Base(path)
		idx := strings.LastIndex(base, ".")
		if idx > 0 && strings.HasPrefix(base[idx:], ".bak") {
			// 保留原检查；若 .bak 后还有合法扩展也 OK
		} else {
			return fmt.Errorf("不允许的扩展名：%s（白名单：.txt .log .conf .json .yaml ...）", ext)
		}
	}
	return nil
}

// wsUploadCheckAbsPath 真实路径（已 sftp.RealPath 解析）必须落在 allowlist 前缀下。
func wsUploadCheckAbsPath(abs string) error {
	if abs == "" {
		return fmt.Errorf("路径解析失败")
	}
	allowed := false
	for _, pre := range wsUploadAllowedPrefixes() {
		if strings.HasPrefix(abs, pre) {
			allowed = true
			break
		}
	}
	// /home/<user>/uploads/ 也允许
	if !allowed && strings.HasPrefix(abs, "/home/") {
		// 必须含 /uploads/ 子目录
		rest := strings.TrimPrefix(abs, "/home/")
		if i := strings.Index(rest, "/"); i > 0 {
			if strings.HasPrefix(rest[i:], "/uploads/") {
				allowed = true
			}
		}
	}
	if !allowed {
		return fmt.Errorf("目标路径不在白名单（需 /tmp/ /data/ /home/<user>/uploads/ 等）")
	}
	return nil
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
