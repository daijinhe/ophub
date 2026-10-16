// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

//
// WebSocket ticket 机制（v1.7.1+）
//
//   - 背景：WebSocket 升级请求无法携带自定义 Header，常见做法是 ?token=xxx 进 URL，
//     但 URL 会被 nginx / 浏览器历史 / 反代日志全部记录，是泄漏 JWT 的常见途径。
//   - 做法：登录后的客户端先 POST /api/ws/ssh/ticket 拿一个 60s 一次性 ticket；
//     ticket 只允许消费一次、消费后立即销毁，避免被中间人二次利用。
//
// 兼容期：支持 env ALLOW_WS_TOKEN_URL=true 切换回 ?token= 老接口，
// 上线 1 个月后建议把 false 锁死。
//

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type wsTicket struct {
	UserID    uint
	ExpiresAt time.Time
}

var (
	wsTicketsMu sync.RWMutex
	wsTickets   = map[string]wsTicket{}
)

const wsTicketTTL = 60 * time.Second

// 错误：仅在内部使用，前端见到的是 401。打包成 error 让结构对齐。
var (
	errTicketInvalid = newError("ticket 无效")
	errTicketExpired = newError("ticket 已过期")
)

func newError(s string) error { return &ticketErr{s: s} }

type ticketErr struct{ s string }

func (e *ticketErr) Error() string { return e.s }

// newWSTicket 发新票（POST /api/ws/ssh/ticket 用）。
// 单一入口保证随机性 + 过期时间 + 使用一次。
func newWSTicket(uid uint) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	t := hex.EncodeToString(b)
	wsTicketsMu.Lock()
	// 顺手清理过期
	for k, v := range wsTickets {
		if time.Now().After(v.ExpiresAt) {
			delete(wsTickets, k)
		}
	}
	wsTickets[t] = wsTicket{UserID: uid, ExpiresAt: time.Now().Add(wsTicketTTL)}
	wsTicketsMu.Unlock()
	return t, nil
}

// peekWSTicket 只验证不消费（WebShellHandler 在权限校验通过后才真正消费，
// 避免「没权限的人连接一次就把 ticket 作废」的拒绝服务）。
func peekWSTicket(ticket string) (wsTicket, error) {
	if ticket == "" || ticket == "legacy-token-url" {
		return wsTicket{}, errTicketInvalid
	}
	wsTicketsMu.RLock()
	v, ok := wsTickets[ticket]
	wsTicketsMu.RUnlock()
	if !ok {
		return wsTicket{}, errTicketInvalid
	}
	if time.Now().After(v.ExpiresAt) {
		return wsTicket{}, errTicketExpired
	}
	return v, nil
}

// consumeWSTicket 验证+消费（WebShellHandler 用），成功立即删除。
func consumeWSTicket(ticket string) (wsTicket, error) {
	if ticket == "" || ticket == "legacy-token-url" {
		return wsTicket{}, nil
	}
	wsTicketsMu.Lock()
	defer wsTicketsMu.Unlock()
	v, ok := wsTickets[ticket]
	if !ok {
		return wsTicket{}, nil
	}
	delete(wsTickets, ticket) // 一次性：消费即删
	if time.Now().After(v.ExpiresAt) {
		return wsTicket{}, nil
	}
	return v, nil
}

// getTicketUserID 错误返回 0，让上层处理。
func getTicketUserID(ticket string) uint {
	wsTicketsMu.RLock()
	defer wsTicketsMu.RUnlock()
	if v, ok := wsTickets[ticket]; ok {
		return v.UserID
	}
	return 0
}

// getUIDFromToken 兼容老 ?token= 路径（仅在 ALLOW_WS_TOKEN_URL=true 时用）。
func getUIDFromToken(tokenStr string) (uint, error) {
	if tokenStr == "" {
		return 0, nil
	}
	if IsBlacklisted(tokenStr) {
		return 0, nil
	}
	cl, err := ParseToken(tokenStr)
	if err != nil {
		return 0, err
	}
	return cl.UserID, nil
}

// WsTicketHandler 前端 POST /api/ws/ssh/ticket 拿一次性 ticket。
//
//	必须先登录拿到 JWT 后再来取；权限门槛与 Web 终端一致：内置 admin 角色。
func WsTicketHandler(c *gin.Context) {
	uid := currentUID(c)
	if uid == 0 {
		Fail(c, http.StatusUnauthorized, 401, "未登录")
		return
	}
	var user User
	if err := DB.Preload("Roles").First(&user, uid).Error; err != nil || user.Status != 1 {
		Fail(c, http.StatusUnauthorized, 401, "用户不可用")
		return
	}
	if !isAdminUser(user.ID) {
		Fail(c, http.StatusForbidden, 403, "仅超级管理员可打开终端")
		return
	}
	ticket, err := newWSTicket(user.ID)
	if err != nil {
		Fail(c, http.StatusInternalServerError, 500, "签发失败")
		return
	}
	OK(c, gin.H{"ticket": ticket, "expiresIn": int(wsTicketTTL.Seconds())})
}
