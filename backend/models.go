package main

import (
	"time"

	"github.com/lib/pq"
	"gorm.io/datatypes"
)

// User 系统用户。
// PasswordEnc 为明文的可逆密文（AES-GCM，base64），仅用于「查看密码」；登录校验始终以
// PasswordHash（bcrypt）为准，该字段可能为空（历史数据需重置一次后才有）。
// 注意：Status 不要加 gorm 的 default 标签 —— 带 default 时 GORM 会忽略零值字段，
// 会导致「新建用户时显式选禁用（status=0）」被数据库默认值 1 覆盖；各处创建均已显式赋值。
type User struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	Username     string    `gorm:"size:64;uniqueIndex" json:"username"`
	PasswordHash string    `json:"-"`
	PasswordEnc  string    `json:"-"`
	Nickname     string    `gorm:"size:128" json:"nickname"`
	Email        string    `gorm:"size:128" json:"email"`
	Phone        string    `gorm:"size:32" json:"phone"`
	Status       int       `json:"status"` // 1 启用 0 禁用
	Roles        []Role    `gorm:"many2many:user_roles;" json:"roles"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// Role 角色（含权限码）
type Role struct {
	ID          uint           `gorm:"primaryKey" json:"id"`
	Name        string         `gorm:"size:64;uniqueIndex" json:"name"`
	Code        string         `gorm:"size:64;uniqueIndex" json:"code"`
	Description string         `gorm:"size:255" json:"description"`
	Permissions pq.StringArray `gorm:"type:text[]" json:"permissions"`
	CreatedAt   time.Time      `json:"createdAt"`
}

// Category CMDB 多级分类（部门/项目树）
type Category struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ParentID  *uint     `gorm:"index" json:"parentId"`
	Name      string    `gorm:"size:128" json:"name"`
	Level     int       `json:"level"`
	Path      string    `gorm:"size:512;index" json:"path"`
	Sort      int       `json:"sort"`
	CreatedAt time.Time `json:"createdAt"`
}

// Asset 虚拟机资产（全字段存于 Fields JSONB）
type Asset struct {
	ID         uint           `gorm:"primaryKey" json:"id"`
	CategoryID uint           `gorm:"index" json:"categoryId"`
	Name       string         `gorm:"size:255;index" json:"name"`
	IP         string         `gorm:"size:64;index" json:"ip"`
	Fields     datatypes.JSON `json:"fields"`
	CreatedBy  uint           `json:"createdBy"`
	CreatedAt  time.Time      `json:"createdAt"`
	UpdatedAt  time.Time      `json:"updatedAt"`
	// DisplayName 由 fields 实时派生的展示名（项目简称_环境_业务环境_虚拟机IPv4）。
	// 不落库（gorm:"-"）：前端所有「选择资产 / 展示资产名」的地方统一读它，
	// 避免各页面各拼一套导致改名后不同步。由 withDisplayNames() 填充。
	DisplayName string `gorm:"-" json:"displayName"`

	// 中间件捕捉摘要：不落库（gorm:"-"），仅列表响应按需填充，
	// 供资产列表的「中间件」列展示与搜索（数据源 mw_captures 表）。
	MwTypes      string `gorm:"-" json:"mwTypes,omitempty"`
	MwStatus     string `gorm:"-" json:"mwStatus,omitempty"`
	MwCapturedAt string `gorm:"-" json:"mwCapturedAt,omitempty"`
}

// withDisplayNames 就地填充一批资产的 DisplayName
func withDisplayNames(assets []Asset) {
	for i := range assets {
		assets[i].DisplayName = AssetDisplayName(&assets[i])
	}
}

// CrontabTaskNote 定时任务的「用途」人工备注。
// 定时任务本身不落库（数据源永远是目标机 crontab，见 handler_crontab.go），
// 这里只存「用途」这一层人工标注：以「资产 + 任务指纹」为键，指纹由命令算出，
// 任务在机器上被改掉后自然失配，备注不会串到别的任务上。
type CrontabTaskNote struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	AssetID   uint      `gorm:"not null;uniqueIndex:idx_ct_note_asset_key" json:"assetId"`
	TaskKey   string    `gorm:"size:64;not null;uniqueIndex:idx_ct_note_asset_key" json:"taskKey"`
	Purpose   string    `gorm:"type:text" json:"purpose"`
	UpdatedBy string    `gorm:"size:64" json:"updatedBy"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// PermissionDef 权限目录项
type PermissionDef struct {
	Code  string `json:"code"`
	Name  string `json:"name"`
	Group string `json:"group"`
}

// PermissionCatalog 权限目录（前端角色编辑使用）
var PermissionCatalog = []PermissionDef{
	{Code: "dashboard:view", Name: "查看概览", Group: "概览"},
	{Code: "user:view", Name: "查看用户", Group: "用户管理"},
	{Code: "user:create", Name: "新建用户", Group: "用户管理"},
	{Code: "user:update", Name: "编辑用户", Group: "用户管理"},
	{Code: "user:delete", Name: "删除用户", Group: "用户管理"},
	{Code: "role:view", Name: "查看角色", Group: "角色权限"},
	{Code: "role:create", Name: "新建角色", Group: "角色权限"},
	{Code: "role:update", Name: "编辑角色", Group: "角色权限"},
	{Code: "role:delete", Name: "删除角色", Group: "角色权限"},
	{Code: "cmdb:view", Name: "查看资产", Group: "CMDB资产"},
	{Code: "cmdb:create", Name: "新建资产", Group: "CMDB资产"},
	{Code: "cmdb:update", Name: "编辑资产", Group: "CMDB资产"},
	{Code: "cmdb:delete", Name: "删除资产", Group: "CMDB资产"},
	{Code: "cmdb:import", Name: "导入资产", Group: "CMDB资产"},
	{Code: "cmdb:export", Name: "导出资产", Group: "CMDB资产"},
	{Code: "category:manage", Name: "管理分类", Group: "分类管理"},
	{Code: "ansible:manage", Name: "Ansible 主机管理", Group: "自动化运维"},
	{Code: "deploy:manage", Name: "应用中间件安装", Group: "自动化运维"},
	{Code: "mwops:view", Name: "查看中间件运维", Group: "中间件运维"},
	{Code: "mwops:manage", Name: "管理中间件（启停/配置）", Group: "中间件运维"},
	{Code: "mwcapture:view", Name: "查看中间件捕捉", Group: "中间件运维"},
	{Code: "mwcapture:manage", Name: "执行中间件捕捉", Group: "中间件运维"},
	{Code: "crontab:view", Name: "查看定时任务", Group: "自动化运维"},
	{Code: "crontab:manage", Name: "管理定时任务", Group: "自动化运维"},
	{Code: "config:view", Name: "查看配置管理", Group: "配置管理"},
	{Code: "config:manage", Name: "管理配置文件", Group: "配置管理"},
	{Code: "inspection:view", Name: "查看巡检", Group: "智能巡检"},
	{Code: "inspection:screen", Name: "查看巡检大屏（只看大屏）", Group: "智能巡检"},
	{Code: "inspection:manage", Name: "管理巡检任务与告警规则", Group: "智能巡检"},
}

// AllPermissionCodes 全部权限码
func AllPermissionCodes() []string {
	codes := make([]string, 0, len(PermissionCatalog))
	for _, p := range PermissionCatalog {
		codes = append(codes, p.Code)
	}
	return codes
}
