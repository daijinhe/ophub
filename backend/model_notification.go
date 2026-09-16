package main

import "time"

// Notification 站内信通知（证书到期预警等）
// 由定时任务（证书到期扫描）自动写入，用户在通知中心查看并标记已读。
type Notification struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Type      string    `gorm:"size:64;index" json:"type"` // cert-expiry / cert-expired / system
	RefID     uint      `gorm:"index" json:"refId"`        // 关联对象 ID（如证书 ID）
	Key       string    `gorm:"size:128;index" json:"key"` // 去重键：cert:<id>:<status>，避免重复刷屏
	Title     string    `gorm:"size:255" json:"title"`
	Content   string    `gorm:"type:text" json:"content"`
	Level     string    `gorm:"size:16" json:"level"` // info / warning / danger
	Read      bool      `gorm:"index;default:false" json:"read"`
	CreatedAt time.Time `json:"createdAt"`
}

// TableName 指定表名
func (Notification) TableName() string { return "notifications" }

// NotificationPolicy 通知策略（证书预警阈值 / 邮件开关）
// 以单行（id=1）形式存储，前端在「通知设置」中可调整。
type NotificationPolicy struct {
	ID           uint   `gorm:"primaryKey" json:"id"`
	WarnDays     int    `gorm:"default:30" json:"warnDays"` // 提前多少天开始预警（默认 30）
	EmailEnabled bool   `json:"emailEnabled"`               // 是否启用邮件通知
	EmailTo      string `gorm:"size:255" json:"emailTo"`    // 接收邮箱（逗号分隔）
}

// TableName 指定表名
func (NotificationPolicy) TableName() string { return "notification_policy" }

// getNotifPolicy 读取（并必要时初始化）通知策略单行
func getNotifPolicy() NotificationPolicy {
	var p NotificationPolicy
	if err := DB.First(&p, 1).Error; err != nil {
		p = NotificationPolicy{ID: 1, WarnDays: 30, EmailEnabled: false, EmailTo: ""}
		DB.Create(&p)
	}
	if p.WarnDays <= 0 {
		p.WarnDays = 30
	}
	return p
}
