package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ---- 远端 hosts 读取缓存 ----
// 页面每次刷新/切换节点都会重新 SSH 读整个 hosts 文件（可能上百 KB），
// 在慢网络下要 1~2 秒。这里按节点缓存 30 秒，保存/导入时主动失效。
var (
	remoteHostsCacheMu sync.Mutex
	remoteHostsCache   = map[string]remoteCacheEntry{}
)

type remoteCacheEntry struct {
	content string
	at      time.Time
}

const remoteCacheTTL = 30 * time.Second

func getCachedRemoteHosts(nodeID uint, read func() (string, error)) (string, error) {
	key := fmt.Sprintf("%d", nodeID)
	remoteHostsCacheMu.Lock()
	if e, ok := remoteHostsCache[key]; ok && time.Since(e.at) < remoteCacheTTL {
		remoteHostsCacheMu.Unlock()
		return e.content, nil
	}
	remoteHostsCacheMu.Unlock()
	content, err := read()
	if err != nil {
		return "", err
	}
	remoteHostsCacheMu.Lock()
	remoteHostsCache[key] = remoteCacheEntry{content: content, at: time.Now()}
	remoteHostsCacheMu.Unlock()
	return content, nil
}

func invalidateRemoteHostsCache(nodeID uint) {
	remoteHostsCacheMu.Lock()
	delete(remoteHostsCache, fmt.Sprintf("%d", nodeID))
	remoteHostsCacheMu.Unlock()
}

// loadRemote 根据 :id 加载节点，返回 (remote, ok)；找不到返回 false 并已写响应
func loadRemote(c *gin.Context) (AnsibleRemote, bool) {
	var r AnsibleRemote
	id, _ := strconv.Atoi(c.Param("id"))
	if id == 0 {
		Fail(c, http.StatusBadRequest, 400, "无效的节点 ID")
		return r, false
	}
	if err := DB.First(&r, id).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			Fail(c, http.StatusNotFound, 404, "节点不存在")
			return r, false
		}
		Fail(c, http.StatusInternalServerError, 500, "查询失败: "+err.Error())
		return r, false
	}
	return r, true
}

// ListAnsibleRemotes 列出所有节点（密码/私钥/sudo 密码不返回）
func ListAnsibleRemotes(c *gin.Context) {
	var list []AnsibleRemote
	DB.Order("id asc").Find(&list)
	// 安全字段输出
	out := make([]gin.H, 0, len(list))
	for _, r := range list {
		out = append(out, gin.H{
			"id":          r.ID,
			"name":        r.Name,
			"host":        r.Host,
			"port":        r.Port,
			"user":        r.User,
			"authType":    r.AuthType,
			"hostsPath":   r.HostsPath,
			"networkZone": r.NetworkZone,
			"description": r.Description,
			"status":      r.Status,
			"lastCheckAt": r.LastCheckAt,
			"lastError":   r.LastError,
			"createdAt":   r.CreatedAt,
			"updatedAt":   r.UpdatedAt,
			"hasPassword": r.Password != "",
			"hasKey":      r.PrivateKey != "",
			"hasBecome":   r.BecomePass != "",
		})
	}
	OK(c, gin.H{"list": out, "total": len(out)})
}

// CreateAnsibleRemote 新建节点
func CreateAnsibleRemote(c *gin.Context) {
	var body AnsibleRemote
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	if body.Name == "" || body.Host == "" || body.User == "" {
		Fail(c, http.StatusBadRequest, 400, "名称/主机/用户 不能为空")
		return
	}
	if body.Port == 0 {
		body.Port = 22
	}
	if body.HostsPath == "" {
		body.HostsPath = "/etc/ansible/hosts"
	}
	if body.AuthType == "" {
		if body.PrivateKey != "" {
			body.AuthType = "key"
		} else {
			body.AuthType = "password"
		}
	}
	// 唯一性
	var cnt int64
	DB.Model(&AnsibleRemote{}).Where("name = ?", body.Name).Count(&cnt)
	if cnt > 0 {
		Fail(c, http.StatusBadRequest, 400, "节点名称已存在")
		return
	}
	body.Status = "unknown"
	if err := DB.Create(&body).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "创建失败: "+err.Error())
		return
	}
	OK(c, body)
}

// GetAnsibleRemote 获取节点详情（v1.7.1+ P1-4 脱敏：只返 has* 标志 + 用户可编辑的非敏感字段）
//
// 脱敏口径与 ListAnsibleRemotes 一致：真实密码/私钥/sudo 密码不进响应。
// 用户修改这些字段时另起一个专用接口 `POST /api/ansible/remotes/:id/secrets`（v1.7.x 后续可选），
// 或者继续走 UpdateAnsibleRemote，前端用「hasPassword=true → 用户主动改」语义来判断。
func GetAnsibleRemote(c *gin.Context) {
	r, ok := loadRemote(c)
	if !ok {
		return
	}
	OK(c, gin.H{
		"id":          r.ID,
		"name":        r.Name,
		"host":        r.Host,
		"port":        r.Port,
		"user":        r.User,
		"authType":    r.AuthType,
		"hostsPath":   r.HostsPath,
		"networkZone": r.NetworkZone,
		"description": r.Description,
		"status":      r.Status,
		"lastCheckAt": r.LastCheckAt,
		"lastError":   r.LastError,
		"hasPassword": r.Password != "",
		"hasKey":      r.PrivateKey != "",
		"hasBecome":   r.BecomePass != "",
		"createdAt":   r.CreatedAt,
		"updatedAt":   r.UpdatedAt,
	})
}

// UpdateAnsibleRemote 更新节点
func UpdateAnsibleRemote(c *gin.Context) {
	r, ok := loadRemote(c)
	if !ok {
		return
	}
	var body AnsibleRemote
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	// 不允许改 name 重复
	if body.Name != "" && body.Name != r.Name {
		var cnt int64
		DB.Model(&AnsibleRemote{}).Where("name = ? AND id <> ?", body.Name, r.ID).Count(&cnt)
		if cnt > 0 {
			Fail(c, http.StatusBadRequest, 400, "节点名称已存在")
			return
		}
		r.Name = body.Name
	}
	if body.Host != "" {
		r.Host = body.Host
	}
	if body.Port != 0 {
		r.Port = body.Port
	}
	if body.User != "" {
		r.User = body.User
	}
	if body.AuthType != "" {
		r.AuthType = body.AuthType
	}
	// 敏感字段：若请求中传了空串，视为「保持原值不清空」以外；
	// 但本平台目前语义：前端在不修改时会忽略该字段。为简化，约定：
	//  - 字段在请求中传了（即使为空）即覆盖；前端在编辑时若不修改可通过 hasPassword 标志判断
	if body.Password != "" {
		r.Password = body.Password
	}
	if body.PrivateKey != "" {
		r.PrivateKey = body.PrivateKey
	}
	if body.BecomePass != "" {
		r.BecomePass = body.BecomePass
	}
	if body.HostsPath != "" {
		r.HostsPath = body.HostsPath
	}
	r.NetworkZone = body.NetworkZone
	r.Description = body.Description
	if err := DB.Save(&r).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "更新失败: "+err.Error())
		return
	}
	OK(c, r)
}

// DeleteAnsibleRemote 删除节点
func DeleteAnsibleRemote(c *gin.Context) {
	r, ok := loadRemote(c)
	if !ok {
		return
	}
	if err := DB.Delete(&r).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "删除失败: "+err.Error())
		return
	}
	OK(c, gin.H{"id": r.ID})
}

// TestAnsibleRemote 测试节点 SSH 连接 + ansible 版本探测
func TestAnsibleRemote(c *gin.Context) {
	r, ok := loadRemote(c)
	if !ok {
		return
	}
	client := r.ToSSHClient()
	out, err := client.Test()
	now := time.Now()
	r.LastCheckAt = &now
	if err != nil {
		r.Status = "offline"
		r.LastError = err.Error()
		DB.Save(&r)
		Fail(c, http.StatusOK, 500, "连接失败: "+err.Error())
		return
	}
	r.Status = "online"
	r.LastError = ""
	DB.Save(&r)
	OK(c, gin.H{"status": r.Status, "output": out})
}

// GetAnsibleRemoteInfo 收集 ansible 版本/路径/playbooks
func GetAnsibleRemoteInfo(c *gin.Context) {
	r, ok := loadRemote(c)
	if !ok {
		return
	}
	client := r.ToSSHClient()
	info, err := client.Info(r.HostsPath)
	if err != nil {
		Fail(c, http.StatusOK, 500, "获取信息失败: "+err.Error())
		return
	}
	OK(c, info)
}

// RemoteHostsPayload 复用结构化 hosts 写回负载
type RemoteHostsPayload struct {
	File *AnsibleFile `json:"file"`
}

// GetRemoteHosts 读取远端 hosts 并解析为结构
func GetRemoteHosts(c *gin.Context) {
	r, ok := loadRemote(c)
	if !ok {
		return
	}
	client := r.ToSSHClient()
	content, err := getCachedRemoteHosts(r.ID, func() (string, error) {
		return client.ReadFile(r.HostsPath)
	})
	if err != nil {
		// 把真实错误一起返回，前端展示出来便于排查（不再静默吞错）
		OK(c, gin.H{
			"path":   r.HostsPath,
			"file":   &AnsibleFile{Groups: []AnsibleGroup{}},
			"exists": false,
			"error":  err.Error(),
		})
		return
	}
	file := parseAnsibleHosts(content)
	OK(c, gin.H{"path": r.HostsPath, "file": file, "exists": true})
}

// SaveRemoteHosts 结构化保存到远端 hosts
func SaveRemoteHosts(c *gin.Context) {
	r, ok := loadRemote(c)
	if !ok {
		return
	}
	var body RemoteHostsPayload
	if err := c.ShouldBindJSON(&body); err != nil || body.File == nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	client := r.ToSSHClient()
	if err := client.WriteFile(r.HostsPath, serializeAnsibleFile(body.File)); err != nil {
		Fail(c, http.StatusOK, 500, "保存失败: "+err.Error())
		return
	}
	invalidateRemoteHostsCache(r.ID)
	OK(c, gin.H{"msg": "已保存", "path": r.HostsPath})
}

// GetRemoteHostsRaw 读取原始 hosts 文本
func GetRemoteHostsRaw(c *gin.Context) {
	r, ok := loadRemote(c)
	if !ok {
		return
	}
	client := r.ToSSHClient()
	content, err := getCachedRemoteHosts(r.ID, func() (string, error) {
		return client.ReadFile(r.HostsPath)
	})
	if err != nil {
		OK(c, gin.H{"path": r.HostsPath, "content": "", "exists": false})
		return
	}
	OK(c, gin.H{"path": r.HostsPath, "content": content, "exists": true})
}

// SaveRemoteHostsRaw 写入原始 hosts 文本
func SaveRemoteHostsRaw(c *gin.Context) {
	r, ok := loadRemote(c)
	if !ok {
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	client := r.ToSSHClient()
	if err := client.WriteFile(r.HostsPath, body.Content); err != nil {
		Fail(c, http.StatusOK, 500, "保存失败: "+err.Error())
		return
	}
	invalidateRemoteHostsCache(r.ID)
	OK(c, gin.H{"msg": "已保存", "path": r.HostsPath})
}

// ImportCMDBToRemote 把 CMDB 资产写入指定远程节点的 hosts
// 与本地 ImportAnsibleFromCMDB 类似，但写入远端 SSH
func ImportCMDBToRemote(c *gin.Context) {
	r, ok := loadRemote(c)
	if !ok {
		return
	}
	var body struct {
		Group         string `json:"group"`
		Port          string `json:"port"`
		SshUser       string `json:"sshUser"`
		SshPass       string `json:"sshPass"`
		BecomePass    string `json:"becomePass"`
		CommentTpl    string `json:"commentTpl"`
		CategoryID    *uint  `json:"categoryId"`
		AssetIDs      []uint `json:"assetIds"`      // 指定资产 ID（传入时仅导入这些资产，优先于 categoryId）
		UseAssetCreds bool   `json:"useAssetCreds"` // 使用资产自带 SSH 凭据（SSH端口/用户名/密码/超级管理员用户密码）
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	if body.Group == "" {
		Fail(c, http.StatusBadRequest, 400, "分组名不能为空")
		return
	}
	// 查询资产：指定 assetIds 时只导入这些资产；否则按分类子树导入
	q := DB.Model(&Asset{})
	if len(body.AssetIDs) > 0 {
		q = q.Where("id IN ?", body.AssetIDs)
	} else if body.CategoryID != nil {
		ids := collectSubtreeIDs(*body.CategoryID)
		q = q.Where("category_id IN ?", ids)
	}
	var assets []Asset
	q.Find(&assets)
	if len(assets) == 0 {
		Fail(c, http.StatusBadRequest, 400, "未找到可导入的资产")
		return
	}
	// 读取远端 hosts
	client := r.ToSSHClient()
	content, err := client.ReadFile(r.HostsPath)
	if err != nil {
		// 不存在则视为空
		content = ""
	}
	file := parseAnsibleHosts(content)
	gi := -1
	for i, g := range file.Groups {
		if g.Name == body.Group {
			gi = i
			break
		}
	}
	if gi == -1 {
		file.Groups = append(file.Groups, AnsibleGroup{Name: body.Group, Hosts: []AnsibleHost{}})
		gi = len(file.Groups) - 1
	}
	existing := map[string]bool{}
	for _, h := range file.Groups[gi].Hosts {
		existing[h.IP] = true
	}
	added, skipped := 0, 0
	for _, a := range assets {
		var fields map[string]interface{}
		_ = json.Unmarshal(a.Fields, &fields)
		_ = decryptAssetFields(fields)
		if fields == nil {
			fields = map[string]interface{}{}
		}
		ip := extractIP(fields)
		if ip == "" {
			skipped++
			continue
		}
		if existing[ip] {
			skipped++ // 已在清单中，跳过
			continue
		}
		// SSH 凭据：勾选「使用资产自带凭据」时优先取资产字段，缺省回落到统一填写的值
		port, sshUser := body.Port, body.SshUser
		sshPass, becomePass := body.SshPass, body.BecomePass
		if body.UseAssetCreds {
			if v := toStr(fields["SSH端口"]); v != "" {
				port = v
			}
			if v := toStr(fields["用户名"]); v != "" {
				sshUser = v
			}
			if v := toStr(fields["密码"]); v != "" {
				sshPass = v
			}
			if v := toStr(fields["超级管理员用户密码"]); v != "" {
				becomePass = v
			}
		}
		vars := map[string]string{}
		if port != "" {
			vars["ansible_ssh_port"] = port
		}
		if sshUser != "" {
			vars["ansible_ssh_user"] = sshUser
		}
		if sshPass != "" {
			vars["ansible_ssh_pass"] = sshPass
		}
		if becomePass != "" {
			vars["ansible_become_pass"] = becomePass
		}
		comment := replaceTpl(body.CommentTpl, fields)
		file.Groups[gi].Hosts = append(file.Groups[gi].Hosts, AnsibleHost{
			IP:      ip,
			Vars:    vars,
			Comment: comment,
		})
		existing[ip] = true
		added++
	}
	if err := client.WriteFile(r.HostsPath, serializeAnsibleFile(file)); err != nil {
		Fail(c, http.StatusOK, 500, "写入远端失败: "+err.Error())
		return
	}
	invalidateRemoteHostsCache(r.ID)
	OK(c, gin.H{"group": body.Group, "added": added, "skipped": skipped, "total": len(file.Groups[gi].Hosts)})
}

// ExecRemoteCommand 在远端执行一条 ansible/shell 命令（拓展功能）
//
// 安全收口（v1.7.1+ · P0-5）：
//   - 仅运维可用的命令白名单（ansible / ansible-playbook / ansible-vault / ansible-doc / ansible-inventory / ansible-galaxy）
//   - 显式拒绝：bash / sh / curl / wget / ssh / scp / python / nc / netcat 等
//     反向 shell / 直接 ssh 接入等危险命令
//   - 路由层为 RequireAdminRole —— 普通 ansible:exec 用户不再能直接调
//   - 单次 stdout 限制 64KB
func ExecRemoteCommand(c *gin.Context) {
	r, ok := loadRemote(c)
	if !ok {
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
	// 命令白名单校验：只看命令开头第一个 token
	if err := validateAnsibleCmd(cmd); err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	client := r.ToSSHClient()
	out, err := client.Run(cmd)
	if len(out) > 64*1024 {
		out = out[:64*1024] + "\n...(已截断)"
	}
	if err != nil {
		OK(c, gin.H{"stdout": out, "error": err.Error()})
		return
	}
	OK(c, gin.H{"stdout": out})
}

// ansibleWhiteList 允许的 ansible 系列命令（含绝对路径变体）。
// 拒绝：bash / sh / curl / wget / ssh / scp / python / nc / netcat 等。
var ansibleWhiteList = []string{
	"/usr/bin/ansible ",
	"/usr/local/bin/ansible ",
	"ansible ", // 当前用户 PATH 中的 ansible
	"ansible-playbook ",
	"ansible-vault ",
	"ansible-doc ",
	"ansible-inventory ",
	"ansible-galaxy ",
}

func validateAnsibleCmd(cmd string) error {
	// 取命令的第一个非参数 token（处理可能的 sudo / doas 等前缀）
	fields := strings.Fields(cmd)
	if len(fields) == 0 {
		return fmt.Errorf("命令不能为空")
	}
	first := fields[0]
	// 兼容「绝对路径 ansible」与「当前 shell PATH 中的 ansible」
	for _, allowed := range ansibleWhiteList {
		if strings.HasPrefix(cmd, allowed) || strings.EqualFold(cmd, strings.TrimSpace(allowed)) {
			_ = first
			return nil
		}
	}
	// 「sudo ansible」「sudo -E ansible」 等也允许
	if first == "sudo" || first == "doas" {
		// 找下个 token
		for i := 1; i < len(fields); i++ {
			f := fields[i]
			if strings.HasPrefix(f, "-") {
				continue
			}
			for _, allowed := range ansibleWhiteList {
				if strings.HasPrefix(f+" ", allowed) || strings.EqualFold(f, strings.TrimSpace(allowed)) {
					_ = i
					return nil
				}
			}
			break
		}
	}
	return fmt.Errorf("拒绝命令：仅允许 ansible / ansible-playbook 等 ansible 系列子命令（%q）", first)
}
