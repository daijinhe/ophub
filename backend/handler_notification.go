package main

import (
	"fmt"
	"net/smtp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// ListNotifications 通知列表（站内信）+ 未读计数
// 支持 ?unread=1（仅未读）、?page=&size=（分页，默认取最近 50 条）
func ListNotifications(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "50"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 50
	}
	onlyUnread := c.Query("unread") == "1"

	q := DB.Model(&Notification{})
	if onlyUnread {
		q = q.Where("read = ?", false)
	}
	var total int64
	q.Count(&total)
	var list []Notification
	q.Order("id desc").Limit(size).Offset((page - 1) * size).Find(&list)

	// 未读总数（与过滤无关）
	var unread int64
	DB.Model(&Notification{}).Where("read = ?", false).Count(&unread)

	OK(c, gin.H{"list": list, "total": total, "unread": unread, "page": page, "pageSize": size})
}

// MarkNotificationRead 标记单条已读
func MarkNotificationRead(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	if id == 0 {
		Fail(c, 400, 400, "无效的通知ID")
		return
	}
	DB.Model(&Notification{}).Where("id = ?", id).Update("read", true)
	OK(c, nil)
}

// MarkAllNotificationsRead 全部标记已读
func MarkAllNotificationsRead(c *gin.Context) {
	DB.Model(&Notification{}).Where("read = ?", false).Update("read", true)
	OK(c, nil)
}

// GetNotifPolicy 读取通知策略（预警阈值 / 邮件开关）
func GetNotifPolicy(c *gin.Context) {
	OK(c, getNotifPolicy())
}

// UpdateNotifPolicy 更新通知策略（仅管理员 deploy:manage）
func UpdateNotifPolicy(c *gin.Context) {
	var body NotificationPolicy
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	if body.WarnDays <= 0 {
		body.WarnDays = 30
	}
	p := getNotifPolicy()
	p.WarnDays = body.WarnDays
	p.EmailEnabled = body.EmailEnabled
	p.EmailTo = strings.TrimSpace(body.EmailTo)
	DB.Save(&p)
	OK(c, p)
}

// sendEmail 通过 SMTP 发送纯文本邮件（best-effort：失败仅记录，不影响主流程）
func sendEmail(to, subject, body string) error {
	if Cfg.SMTPHost == "" || Cfg.SMTPPort == 0 {
		return fmt.Errorf("SMTP 未配置")
	}
	toList := strings.Split(to, ",")
	cleaned := make([]string, 0, len(toList))
	for _, t := range toList {
		t = strings.TrimSpace(t)
		if t != "" {
			cleaned = append(cleaned, t)
		}
	}
	if len(cleaned) == 0 {
		return fmt.Errorf("无有效收件人")
	}
	from := Cfg.SMTPFrom
	if from == "" {
		from = Cfg.SMTPUser
	}
	msg := []byte("From: " + from + "\r\n" +
		"To: " + strings.Join(cleaned, ",") + "\r\n" +
		"Subject: " + subject + "\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/plain; charset=UTF-8\r\n" +
		"\r\n" +
		body + "\r\n")
	addr := fmt.Sprintf("%s:%d", Cfg.SMTPHost, Cfg.SMTPPort)
	var auth smtp.Auth
	if Cfg.SMTPUser != "" {
		auth = smtp.PlainAuth("", Cfg.SMTPUser, Cfg.SMTPPass, Cfg.SMTPHost)
	}
	return smtp.SendMail(addr, auth, from, cleaned, msg)
}
