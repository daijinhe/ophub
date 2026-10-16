// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"net/http"
	"os"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

// AnsibleGroup 解析后的 hosts 分组
type AnsibleGroup struct {
	Name      string        `json:"name"`      // 组名（不含方括号）
	Vars      []string      `json:"vars"`      // [组名] 下方 [组名:vars] 变量（可选，展示用）
	Hosts     []AnsibleHost `json:"hosts"`     // 组内主机
	RawBefore string        `json:"rawBefore"` // 该组之前的非结构化内容（注释/空行）
}

// AnsibleHost 单台主机
type AnsibleHost struct {
	IP      string            `json:"ip"`      // 主机地址（可能是 IP 或 hostname）
	Vars    map[string]string `json:"vars"`    // ansible_ssh_port / user / pass / become_pass 等
	Comment string            `json:"comment"` // 行尾 # 注释
	RawLine string            `json:"rawLine"` // 原始行（用于导入 CMDB 映射时保留）
}

// AnsibleFile 整个 hosts 文件结构
type AnsibleFile struct {
	Groups  []AnsibleGroup `json:"groups"`
	RawTop  string         `json:"rawTop"`  // 文件开头（首个 [group] 之前的内容）
	RawTail string         `json:"rawTail"` // 文件结尾的零散内容
}

// parseAnsibleHosts 解析 INI 风格 ansible hosts 文件
func parseAnsibleHosts(content string) *AnsibleFile {
	file := &AnsibleFile{Groups: []AnsibleGroup{}}
	lines := strings.Split(content, "\n")
	curGroup := -1
	var buf []string // 收集非组内容
	flush := func(target *string) {
		txt := strings.Join(buf, "\n")
		*target = txt
		buf = nil
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			buf = append(buf, line)
			continue
		}
		if strings.HasPrefix(trimmed, "#") {
			buf = append(buf, line)
			continue
		}
		// 组头 [name] 或 [name:vars] / [name:children]
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			inner := strings.Trim(trimmed, "[]")
			if idx := strings.Index(inner, ":"); idx >= 0 {
				// 子组/变量组，简化为归属到同名组
				inner = inner[:idx]
			}
			if curGroup == -1 {
				flush(&file.RawTop)
			}
			file.Groups = append(file.Groups, AnsibleGroup{Name: inner, Hosts: []AnsibleHost{}})
			curGroup = len(file.Groups) - 1
			continue
		}
		// 主机行
		if curGroup == -1 {
			buf = append(buf, line)
			continue
		}
		h := parseHostLine(trimmed)
		file.Groups[curGroup].Hosts = append(file.Groups[curGroup].Hosts, h)
	}
	flush(&file.RawTail)
	return file
}

// parseHostLine 解析一行主机定义
// 例：198.51.100.62 ansible_ssh_port=65181 ansible_ssh_user=test ansible_ssh_pass=xxx ansible_become_pass=yyy #注释
func parseHostLine(line string) AnsibleHost {
	h := AnsibleHost{Vars: map[string]string{}}
	// 去掉行尾注释
	comment := ""
	if idx := strings.Index(line, " #"); idx >= 0 {
		comment = strings.TrimSpace(line[idx+1:])
		line = strings.TrimSpace(line[:idx])
	} else if idx := strings.Index(line, "\t#"); idx >= 0 {
		comment = strings.TrimSpace(line[idx+1:])
		line = strings.TrimSpace(line[:idx])
	}
	h.Comment = strings.TrimPrefix(comment, "#")
	h.RawLine = line
	parts := strings.Fields(line)
	if len(parts) > 0 {
		h.IP = parts[0]
	}
	for _, p := range parts[1:] {
		if eq := strings.Index(p, "="); eq > 0 {
			k := p[:eq]
			v := p[eq+1:]
			h.Vars[k] = v
		}
	}
	return h
}

// serializeAnsibleFile 将结构还原为 INI 文本
func serializeAnsibleFile(file *AnsibleFile) string {
	var b strings.Builder
	if strings.TrimSpace(file.RawTop) != "" {
		b.WriteString(file.RawTop)
		if !strings.HasSuffix(file.RawTop, "\n") {
			b.WriteString("\n")
		}
	}
	for i, g := range file.Groups {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString("[" + g.Name + "]\n")
		for _, h := range g.Hosts {
			b.WriteString(hostToLine(h))
			b.WriteString("\n")
		}
	}
	if strings.TrimSpace(file.RawTail) != "" {
		b.WriteString("\n")
		b.WriteString(file.RawTail)
		if !strings.HasSuffix(file.RawTail, "\n") {
			b.WriteString("\n")
		}
	}
	return b.String()
}

func hostToLine(h AnsibleHost) string {
	var b strings.Builder
	b.WriteString(h.IP)
	// 固定顺序输出常用变量，其余按 key 排序
	order := []string{"ansible_ssh_port", "ansible_ssh_user", "ansible_ssh_pass", "ansible_become_pass"}
	seen := map[string]bool{}
	for _, k := range order {
		if v, ok := h.Vars[k]; ok {
			b.WriteString(" " + k + "=" + v)
			seen[k] = true
		}
	}
	keys := make([]string, 0, len(h.Vars))
	for k := range h.Vars {
		if !seen[k] {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		b.WriteString(" " + k + "=" + h.Vars[k])
	}
	if h.Comment != "" {
		b.WriteString(" #" + h.Comment)
	}
	return b.String()
}

// GetAnsibleHosts 读取并解析 hosts 文件
func GetAnsibleHosts(c *gin.Context) {
	path := Cfg.AnsibleHosts
	content, err := os.ReadFile(path)
	if err != nil {
		// 文件不存在时返回空结构，便于前端新建
		OK(c, gin.H{
			"path":   path,
			"file":   &AnsibleFile{Groups: []AnsibleGroup{}},
			"exists": false,
		})
		return
	}
	strContent := string(content)
	// 去 BOM（v1.7.11+）：某些 ansible 主机清单工具导出的 UTF-8 文件带 BOM，
	// 第一行 `[xxx]` 实际是 \ufeff[xxx]，TrimSpace 会吞 \ufeff 之后的方括号还在，
	// 但更安全的做法是一开头就剥掉。
	if strings.HasPrefix(strContent, "\ufeff") {
		strContent = strings.TrimPrefix(strContent, "\ufeff")
	}
	file := parseAnsibleHosts(strContent)
	// 调试字段 v1.7.11+：返回 Go 实际读到的字节数 / 行数 / 解析出的统计，
	// 排查「前端显示 0 分组但容器内手动能列出 403 台」类的差异。
	groupCount := 0
	hostCount := 0
	for _, g := range file.Groups {
		groupCount++
		hostCount += len(g.Hosts)
	}
	OK(c, gin.H{
		"path":        path,
		"file":        file,
		"exists":      true,
		"_fileBytes":  len(content),
		"_fileLines":  strings.Count(strContent, "\n"),
		"_groupCount": groupCount,
		"_hostCount":  hostCount,
	})
}

// SaveAnsibleHosts 用结构覆盖写入 hosts 文件
func SaveAnsibleHosts(c *gin.Context) {
	var body struct {
		File *AnsibleFile `json:"file"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.File == nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	path := Cfg.AnsibleHosts
	content := serializeAnsibleFile(body.File)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		Fail(c, http.StatusInternalServerError, 500, "写入失败: "+err.Error())
		return
	}
	OK(c, gin.H{"path": path, "msg": "已保存"})
}

// RawAnsibleHosts 直接读写 hosts 原始文本（高级编辑）
func RawAnsibleHosts(c *gin.Context) {
	path := Cfg.AnsibleHosts
	if c.Request.Method == http.MethodGet {
		content, err := os.ReadFile(path)
		if err != nil {
			OK(c, gin.H{"path": path, "content": "", "exists": false})
			return
		}
		OK(c, gin.H{"path": path, "content": string(content), "exists": true})
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体无效")
		return
	}
	if err := os.WriteFile(path, []byte(body.Content), 0o644); err != nil {
		Fail(c, http.StatusInternalServerError, 500, "写入失败: "+err.Error())
		return
	}
	OK(c, gin.H{"path": path, "msg": "已保存"})
}

// ImportAnsibleFromCMDB 依据 CMDB 资产生成 ansible 主机并写入指定分组
// 录入格式：
// [分组名]
// IP ansible_ssh_port=端口 ansible_ssh_user=用户 ansible_ssh_pass=密码 ansible_become_pass=sudo密码 #备注
func ImportAnsibleFromCMDB(c *gin.Context) {
	var body struct {
		Group         string `json:"group"`         // 目标分组名
		Port          string `json:"port"`          // 默认 SSH 端口
		SshUser       string `json:"sshUser"`       // 默认 SSH 用户
		SshPass       string `json:"sshPass"`       // 默认 SSH 密码
		BecomePass    string `json:"becomePass"`    // 默认 sudo 密码
		CommentTpl    string `json:"commentTpl"`    // 备注模板，可用 {应用系统名称} {归属部门} 占位
		CategoryID    *uint  `json:"categoryId"`    // 限定分类（可选）
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
		Fail(c, http.StatusBadRequest, 400, "未找到可导入的资产（请先确认 CMDB 中有带 IPv4 的资产）")
		return
	}
	// 读取现有文件
	content, _ := os.ReadFile(Cfg.AnsibleHosts)
	file := parseAnsibleHosts(string(content))
	// 找目标分组或新建
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
			skipped++ // 无 IP，无法作为 ansible 主机
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
	if err := os.WriteFile(Cfg.AnsibleHosts, []byte(serializeAnsibleFile(file)), 0o644); err != nil {
		Fail(c, http.StatusInternalServerError, 500, "写入失败: "+err.Error())
		return
	}
	OK(c, gin.H{"group": body.Group, "added": added, "skipped": skipped, "total": len(file.Groups[gi].Hosts)})
}

// CmdbAssets 返回带 IP 的资产列表，供前端「从资产选择」多选用
// 仅返回有 IPv4 的资产，便于直接作为 ansible 主机地址
func CmdbAssets(c *gin.Context) {
	var assets []Asset
	DB.Model(&Asset{}).Find(&assets)
	list := make([]gin.H, 0, len(assets))
	for _, a := range assets {
		var fields map[string]interface{}
		_ = json.Unmarshal(a.Fields, &fields)
		_ = decryptAssetFields(fields)
		if fields == nil {
			fields = map[string]interface{}{}
		}
		ip := extractIP(fields)
		if ip == "" {
			continue
		}
		// 展示名统一走 AssetDisplayName（与 Web 终端会话名 / 定时任务 / CMDB 同源）
		name := AssetDisplayName(&a)
		list = append(list, gin.H{
			"id":     a.ID,
			"name":   name,
			"ip":     ip,
			"fields": fields,
		})
	}
	OK(c, gin.H{"assets": list})
}

// extractIP 从资产 fields 取 IPv4
func extractIP(fields map[string]interface{}) string {
	if v, ok := fields["虚拟机IPv4"]; ok {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	if v, ok := fields["虚拟机EIP-IPv4"]; ok {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return ""
}

// replaceTpl 用资产字段替换备注模板占位符 {字段名}
func replaceTpl(tpl string, fields map[string]interface{}) string {
	if tpl == "" {
		return ""
	}
	out := tpl
	for k, v := range fields {
		ph := "{" + k + "}"
		if strings.Contains(out, ph) {
			out = strings.ReplaceAll(out, ph, toStr(v))
		}
	}
	return out
}
