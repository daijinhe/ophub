// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ---------- 系统初始化目录管理（页面可自定义新增初始化选项，与中间件部署配置同构）----------
// 目录驱动「应用中间件安装」向导第 01 步的系统初始化选项：
//   - 内置项：随控制节点真实 system_init 目录登记，启动幂等同步（seed_ver 控制）；
//   - 自定义项：运维在页面新增，启动同步不会触碰（custom=true）；
//   - 删除内置项：写删除墓碑（deleted=true）而非物理删除，避免重启又被同步建回来。

// SysInitCatalogReq 新增/更新请求体
type SysInitCatalogReq struct {
	Key      string   `json:"key"`      // 选项名称（任务唯一标识，向导中勾选的就是它）
	Label    string   `json:"label"`    // 展示名
	Group    string   `json:"group"`    // 向导分组
	Domain   *string  `json:"domain"`   // 目录域：空=系统初始化；gaussdb=GaussDB（对应 GaussDBInitDir）。nil=保持原值
	Playbook string   `json:"playbook"` // 相对所属域根目录的 playbook 路径
	Desc     string   `json:"desc"`     // 说明
	VarMode  string   `json:"varMode"`  // os | cpu | static | none
	VarArgs  string   `json:"varArgs"`  // static 模式的固定变量
	OsTypes  []string `json:"osTypes"`  // 支持的 OS 令牌（空=全部）
	CpuTypes []string `json:"cpuTypes"` // 支持的 CPU 令牌（空=全部）
	OrderNo  int      `json:"orderNo"`
	Enabled  bool     `json:"enabled"`
}

// normalizeSysInitDomain 规范化目录域：只认 gaussdb，其余一律视为系统初始化域（空）
func normalizeSysInitDomain(s string) string {
	if strings.EqualFold(strings.TrimSpace(s), "gaussdb") {
		return "gaussdb"
	}
	return ""
}

// normalizeSysInitVarMode 规范化变量模式，非法值回退 none
func normalizeSysInitVarMode(s string) string {
	switch strings.TrimSpace(s) {
	case "os", "cpu", "static", "none":
		return strings.TrimSpace(s)
	default:
		return "none"
	}
}

// validateSysInitReq 校验请求体，返回错误文案（空串表示通过）
func validateSysInitReq(r SysInitCatalogReq) string {
	if strings.TrimSpace(r.Key) == "" {
		return "选项名称不能为空"
	}
	if len([]rune(strings.TrimSpace(r.Key))) > 64 {
		return "选项名称过长（建议 64 字以内）"
	}
	pb := strings.TrimSpace(r.Playbook)
	if pb == "" {
		return "playbook 路径不能为空"
	}
	if strings.HasPrefix(pb, "/") {
		return "playbook 请填相对路径（相对所属域根目录：系统初始化 system_init / GaussDB gaussDB_init），例如 yum-config/yum-config.yml"
	}
	if strings.Contains(pb, "..") {
		return "playbook 路径不允许包含 .."
	}
	mode := normalizeSysInitVarMode(r.VarMode)
	if mode == "static" && strings.TrimSpace(r.VarArgs) == "" {
		return "变量模式为「固定变量」时必须填写固定变量（如 DISK_DIR=data FORMAT_TYPE=ext4）"
	}
	if mode == "static" && strings.ContainsAny(r.VarArgs, "\"\n") {
		return "固定变量不能包含双引号或换行"
	}
	return ""
}

// jsonArr 序列化字符串数组（nil 序列化为 "[]"）
func jsonArr(v []string) string {
	if v == nil {
		v = []string{}
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// sysInitCatalogView 行 → 前端结构
func sysInitCatalogView(r SysInitCatalog) gin.H {
	return gin.H{
		"id":        r.ID,
		"key":       r.Key,
		"label":     r.Label,
		"group":     r.Group,
		"domain":    r.Domain,
		"playbook":  r.Playbook,
		"desc":      r.Desc,
		"varMode":   r.VarMode,
		"varArgs":   r.VarArgs,
		"osTypes":   parseStrSlice(r.OsTypes),
		"cpuTypes":  parseStrSlice(r.CpuTypes),
		"orderNo":   r.OrderNo,
		"enabled":   r.Enabled,
		"custom":    r.Custom,
		"deleted":   r.Deleted,
		"seedVer":   r.SeedVer,
		"updatedAt": r.UpdatedAt,
	}
}

// ListSysInitCatalog 目录全量列表（含停用项；不含删除墓碑）
func ListSysInitCatalog(c *gin.Context) {
	var rows []SysInitCatalog
	q := DB.Order("order_no asc, id asc")
	if c.Query("withDeleted") != "1" {
		q = q.Where("deleted = ?", false)
	}
	q.Find(&rows)
	list := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		list = append(list, sysInitCatalogView(r))
	}
	// 已登记过头分组（用于新增时下拉候选）
	groups := []string{}
	seen := map[string]bool{}
	for _, r := range rows {
		g := strings.TrimSpace(r.Group)
		if g != "" && !seen[g] {
			seen[g] = true
			groups = append(groups, g)
		}
	}
	OK(c, gin.H{
		"list":           list,
		"groups":         groups,
		"osTypes":        sysInitOsTokens,
		"cpuTypes":       []string{"x86_64", "aarch64"},
		"systemInitDir":  sysInitBaseDirOf(""),
		"gaussdbInitDir": sysInitBaseDirOf("gaussdb"),
		"seedVer":        sysInitSeedVer,
	})
}

// CreateSysInitCatalog 新增自定义初始化项
func CreateSysInitCatalog(c *gin.Context) {
	var r SysInitCatalogReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	if msg := validateSysInitReq(r); msg != "" {
		Fail(c, http.StatusBadRequest, 400, msg)
		return
	}
	key := strings.TrimSpace(r.Key)
	var exist SysInitCatalog
	if err := DB.Where("key = ?", key).First(&exist).Error; err == nil {
		if !exist.Deleted {
			Fail(c, http.StatusBadRequest, 400, "已存在同名初始化项："+key)
			return
		}
		// 同名项处于删除墓碑状态：视为恢复并覆盖为新配置
		exist.Deleted = false
		exist.Enabled = r.Enabled
		applySysInitReq(&exist, r)
		exist.UpdatedAt = time.Now()
		if e := DB.Save(&exist).Error; e != nil {
			Fail(c, http.StatusInternalServerError, 500, "保存失败")
			return
		}
		OK(c, sysInitCatalogView(exist))
		return
	}
	m := SysInitCatalog{
		Key:       key,
		Custom:    true, // 页面新增的一律标记为自定义，内置目录同步不会覆盖
		CreatedAt: time.Now(),
	}
	applySysInitReq(&m, r)
	if err := DB.Create(&m).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败")
		return
	}
	OK(c, sysInitCatalogView(m))
}

// applySysInitReq 把请求体写入模型（新增/更新共用）
func applySysInitReq(m *SysInitCatalog, r SysInitCatalogReq) {
	m.Key = strings.TrimSpace(r.Key)
	m.Label = strings.TrimSpace(r.Label)
	if m.Label == "" {
		m.Label = m.Key
	}
	m.Group = strings.TrimSpace(r.Group)
	if m.Group == "" {
		m.Group = "自定义"
	}
	// domain 为指针：未传（nil）时保持原值，避免页面编辑内置项时误清空 GaussDB 域
	if r.Domain != nil {
		m.Domain = normalizeSysInitDomain(*r.Domain)
	}
	m.Playbook = strings.TrimSpace(r.Playbook)
	m.Desc = strings.TrimSpace(r.Desc)
	m.VarMode = normalizeSysInitVarMode(r.VarMode)
	if m.VarMode == "static" {
		m.VarArgs = strings.TrimSpace(r.VarArgs)
	} else {
		m.VarArgs = ""
	}
	m.OsTypes = jsonArr(normTokenList(r.OsTypes))
	m.CpuTypes = jsonArr(normTokenList(r.CpuTypes))
	m.OrderNo = r.OrderNo
	m.Enabled = r.Enabled
	m.UpdatedAt = time.Now()
}

// normTokenList 去空白、去重、保持顺序
func normTokenList(in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// UpdateSysInitCatalog 更新（内置项更新后 seed_ver 置为当前版本，避免下次启动被同步覆盖）
func UpdateSysInitCatalog(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var m SysInitCatalog
	if err := DB.First(&m, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "初始化项不存在")
		return
	}
	var r SysInitCatalogReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	if msg := validateSysInitReq(r); msg != "" {
		Fail(c, http.StatusBadRequest, 400, msg)
		return
	}
	// 改名时校验唯一
	key := strings.TrimSpace(r.Key)
	if key != m.Key {
		var cnt int64
		DB.Model(&SysInitCatalog{}).Where("key = ? AND deleted = ?", key, false).Count(&cnt)
		if cnt > 0 {
			Fail(c, http.StatusBadRequest, 400, "已存在同名初始化项："+key)
			return
		}
	}
	applySysInitReq(&m, r)
	if !m.Custom {
		m.SeedVer = sysInitSeedVer
	}
	if err := DB.Save(&m).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败")
		return
	}
	OK(c, sysInitCatalogView(m))
}

// DeleteSysInitCatalog 删除：自定义项物理删除；内置项写墓碑（重启不会复活，可点「同步内置目录」恢复）
func DeleteSysInitCatalog(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var m SysInitCatalog
	if err := DB.First(&m, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "初始化项不存在")
		return
	}
	if m.Custom {
		if err := DB.Delete(&SysInitCatalog{}, id).Error; err != nil {
			Fail(c, http.StatusInternalServerError, 500, "删除失败")
			return
		}
		OK(c, gin.H{"deleted": "hard", "key": m.Key})
		return
	}
	m.Deleted = true
	m.Enabled = false
	m.UpdatedAt = time.Now()
	if err := DB.Save(&m).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "删除失败")
		return
	}
	OK(c, gin.H{"deleted": "tombstone", "key": m.Key})
}

// ToggleSysInitCatalog 启用/停用（PATCH）
func ToggleSysInitCatalog(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var m SysInitCatalog
	if err := DB.First(&m, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "初始化项不存在")
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.Enabled == nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	m.Enabled = *body.Enabled
	m.UpdatedAt = time.Now()
	if err := DB.Save(&m).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败")
		return
	}
	OK(c, sysInitCatalogView(m))
}

// SyncSysInitCatalogAPI 重新同步内置目录（可顺带清除删除墓碑，恢复被删的内置项）
func SyncSysInitCatalogAPI(c *gin.Context) {
	var body struct {
		Restore bool `json:"restore"`
	}
	_ = c.ShouldBindJSON(&body)
	restored := int64(0)
	if body.Restore {
		res := DB.Model(&SysInitCatalog{}).Where("deleted = ? AND custom = ?", true, false).
			Updates(map[string]interface{}{"deleted": false, "enabled": true, "seed_ver": 0, "updated_at": time.Now()})
		restored = res.RowsAffected
	}
	SyncSysInitCatalog()
	var total, enabled int64
	DB.Model(&SysInitCatalog{}).Where("deleted = ?", false).Count(&total)
	DB.Model(&SysInitCatalog{}).Where("deleted = ? AND enabled = ?", false, true).Count(&enabled)
	OK(c, gin.H{"restored": restored, "total": total, "enabled": enabled})
}

// ---------- 控制节点读取（系统初始化 playbook 目录为 root 权限，普通用户需 sudo）----------

// ctlCmdWithSudoFallback 包装只读命令：优先 sudo -n（免密）执行，失败回退当前用户执行。
// 命令整体交给 bash -c，避免 cd/管道/&& 被前缀拆散。
func ctlCmdWithSudoFallback(cmd string) string {
	q := "'" + strings.ReplaceAll(cmd, "'", "'\\''") + "'"
	return "sudo -n bash -c " + q + " 2>/dev/null || bash -c " + q
}

// ctlClient 取一个可用的控制节点 SSH 客户端（AnsibleRemote 按 id 升序取第一个连通的）
func ctlClient() (SSHClient, AnsibleRemote, error) {
	var remotes []AnsibleRemote
	DB.Order("id asc").Find(&remotes)
	if len(remotes) == 0 {
		return SSHClient{}, AnsibleRemote{}, fmt.Errorf("未配置 Ansible 控制节点")
	}
	for _, r := range remotes {
		cli := r.ToSSHClient()
		if out, err := cli.RunWithTimeout("echo __CTL_OK__", 15*time.Second); err == nil && strings.Contains(out, "__CTL_OK__") {
			return cli, r, nil
		}
	}
	return SSHClient{}, AnsibleRemote{}, fmt.Errorf("控制节点均不可达（已尝试 %d 个）", len(remotes))
}

// ListSysInitPlaybooks 列出控制节点指定目录域下的 playbook 相对路径。
// domain 为空/system → SystemInitDir；gaussdb → GaussDBInitDir（与 sysInitBaseDirOf 同一口径）。
func ListSysInitPlaybooks(c *gin.Context) {
	cli, remote, err := ctlClient()
	if err != nil {
		Fail(c, http.StatusServiceUnavailable, 503, err.Error())
		return
	}
	domain := normalizeSysInitDomain(c.Query("domain"))
	dir := sysInitBaseDirOf(domain)
	// 不用 find -printf（各发行版支持不一致），改用 cd + sed 去前缀
	cmd := ctlCmdWithSudoFallback(fmt.Sprintf("cd %s && find . -maxdepth 3 -name '*.yml' | sed 's|^\\./||' | sort", shellQuotePath(dir)))
	out, rerr := cli.RunWithTimeout(cmd, 60*time.Second)
	if rerr != nil {
		Fail(c, http.StatusBadGateway, 502, "读取控制节点目录失败："+rerr.Error())
		return
	}
	files := []string{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		files = append(files, line)
	}
	sort.Strings(files)
	OK(c, gin.H{
		"dir":    dir,
		"domain": domain,
		"node":   remote.Name + "（" + remote.Host + "）",
		"files":  files,
		"count":  len(files),
	})
}

// CheckSysInitPlaybook 校验 playbook 在控制节点上是否存在，并返回头部内容预览
func CheckSysInitPlaybook(c *gin.Context) {
	cli, remote, err := ctlClient()
	if err != nil {
		Fail(c, http.StatusServiceUnavailable, 503, err.Error())
		return
	}
	var body struct {
		Playbook string `json:"playbook"`
		Lines    int    `json:"lines"`
		Domain   string `json:"domain"` // 目录域：空/system=SystemInitDir；gaussdb=GaussDBInitDir
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	pb := strings.TrimSpace(body.Playbook)
	if pb == "" || strings.HasPrefix(pb, "/") || strings.Contains(pb, "..") {
		Fail(c, http.StatusBadRequest, 400, "playbook 必须是相对路径")
		return
	}
	if body.Lines <= 0 || body.Lines > 200 {
		body.Lines = 60
	}
	domain := normalizeSysInitDomain(body.Domain)
	full := sysInitBaseDirOf(domain) + "/" + pb
	exists := false
	if out, e := cli.RunWithTimeout(ctlCmdWithSudoFallback("[ -e "+shellQuotePath(full)+" ] && echo __YES__"), 30*time.Second); e == nil && strings.Contains(out, "__YES__") {
		exists = true
	}
	head := ""
	if exists {
		cmd := ctlCmdWithSudoFallback(fmt.Sprintf("head -n %d %s", body.Lines, shellQuotePath(full)))
		if out, e := cli.RunWithTimeout(cmd, 30*time.Second); e == nil {
			head = out
		}
	}
	OK(c, gin.H{
		"playbook": pb,
		"fullPath": full,
		"domain":   domain,
		"exists":   exists,
		"node":     remote.Name + "（" + remote.Host + "）",
		"head":     head,
	})
}
