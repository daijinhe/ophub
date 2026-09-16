package main

import "time"

// NginxConfig nginx 配置文件纳管记录。
//
// 设计要点：
//   - 以「资产 + 远端绝对路径」唯一定位一个被纳管的配置文件（ConfigType 预留其它配置类型扩展）。
//   - Content 为最近一次拉取/编辑后的内容缓存；RemoteMd5 为远端真实文件 md5。
//     两者相等即 status=synced，不相等即 status=modified，拉取失败即 status=notfound/error。
//   - 写回（sync）通过 SSHClient.WriteFile 完成，写入前平台已为其生成 *.ophub.bak 备份。
type NginxConfig struct {
	ID         uint       `gorm:"primaryKey" json:"id"`
	ConfigType string     `gorm:"size:32;not null;default:'nginx';uniqueIndex:uniq_cfg,priority:1" json:"configType"` // 预留：nginx / apache / ...
	AssetID    uint       `gorm:"index;uniqueIndex:uniq_cfg,priority:2" json:"assetId"`
	AssetName  string     `gorm:"size:255" json:"assetName"`
	Host       string     `gorm:"size:64;index" json:"host"`
	Path       string     `gorm:"size:512;not null;uniqueIndex:uniq_cfg,priority:3" json:"path"`
	Kind       string     `gorm:"size:32" json:"kind"` // main / conf.d / site / module / other
	Content    string     `gorm:"type:text" json:"content"`
	RemoteMd5  string     `gorm:"size:64" json:"remoteMd5"`
	Status     string     `gorm:"size:16;not null;default:'unknown'" json:"status"` // synced / modified / error / notfound / unknown
	LastSyncAt *time.Time `json:"lastSyncAt"`
	LastScanAt *time.Time `json:"lastScanAt"`
	CreatedBy  uint       `json:"createdBy"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

// nginxConfig status 常量
const (
	NginxStatusSynced   = "synced"
	NginxStatusModified = "modified"
	NginxStatusError    = "error"
	NginxStatusNotFound = "notfound"
	NginxStatusUnknown  = "unknown"
)

// nginxConfigKind 常量（按路径特征归类）
const (
	NginxKindMain   = "main"   // nginx.conf 主配置
	NginxKindConfD  = "conf.d" // conf.d 片段
	NginxKindSite   = "site"   // sites-enabled 站点
	NginxKindModule = "module" // conf.modules.d / modules-enabled
	NginxKindOther  = "other"  // 其它 include
)
