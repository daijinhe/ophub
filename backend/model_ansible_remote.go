// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import "time"

// AnsibleRemote 远程 Ansible 节点
// 每个节点对应一台安装了 ansible 的服务器，
// 平台通过 SSH 连接该节点并管理其 hosts 文件与执行 ansible 命令
type AnsibleRemote struct {
	ID          uint       `gorm:"primaryKey" json:"id"`
	Name        string     `gorm:"size:128;uniqueIndex" json:"name"`         // 节点名称（唯一）
	Host        string     `gorm:"size:128" json:"host"`                     // SSH 主机 (IP/域名)
	Port        int        `gorm:"default:22" json:"port"`                   // SSH 端口
	User        string     `gorm:"size:64" json:"user"`                      // SSH 用户
	AuthType    string     `gorm:"size:16;default:password" json:"authType"` // password | key
	Password    string     `gorm:"size:255" json:"password,omitempty"`       // 密码（敏感字段）
	PrivateKey  string     `gorm:"type:text" json:"privateKey,omitempty"`    // SSH 私钥（敏感字段）
	BecomePass  string     `gorm:"size:255" json:"becomePass,omitempty"`     // sudo 密码（敏感字段）
	HostsPath   string     `gorm:"size:255" json:"hostsPath"`                // 远端 hosts 文件路径（默认 /etc/ansible/hosts）
	NetworkZone string     `gorm:"size:64" json:"networkZone"`               // 关联的网络区域（如 互联网/政务外网），用于按资产「所属网络区域」自动分配执行节点
	Description string     `gorm:"size:512" json:"description"`              // 备注
	Status      string     `gorm:"size:32;default:unknown" json:"status"`    // unknown | online | offline
	LastCheckAt *time.Time `json:"lastCheckAt"`                              // 最近一次连通性检测时间
	LastError   string     `gorm:"size:512" json:"lastError"`                // 最近一次错误信息
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

// TableName 指定表名
func (AnsibleRemote) TableName() string { return "ansible_remotes" }
