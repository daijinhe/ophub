// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

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

// PermissionCatalog 扁平权限目录（前端角色编辑使用）。
//
// ⚠️ 定义已迁到 perm_tree.go —— 由 MenuPermTree 自动派生，**不要再手工维护这张表**。
// 这样权限目录的 Group（= 菜单祖先路径）与权限显示名（= 节点名 + 动作名）
// 永远与菜单一致；新增菜单只需在 MenuPermTree 里加一个节点。
var PermissionCatalog = buildPermissionCatalog()

// AllPermissionCodes 全部权限码（由菜单权限树派生）
func AllPermissionCodes() []string {
	codes := make([]string, 0, len(PermissionCatalog))
	for _, p := range PermissionCatalog {
		codes = append(codes, p.Code)
	}
	return codes
}
