package main

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	ctxUID   = "uid"
	ctxPerms = "perms"
	ctxUser  = "username"
)

// AuthMiddleware 鉴权中间件：校验 JWT 并注入用户权限
//
// 兼容两种 token 形式（v1.7.1+）：
//   - Authorization: Bearer <token>（老路径，外部 API 调用）
//   - Cookie: ophub_token=<token>（httpOnly 新路径，前端浏览器自动发）
func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		token := ""
		hdr := c.GetHeader("Authorization")
		if hdr != "" && strings.HasPrefix(hdr, "Bearer ") {
			token = strings.TrimPrefix(hdr, "Bearer ")
		}
		if token == "" {
			// cookie 兜底：浏览器在同源 fetch/XHR 时会自动带上 ophub_token
			if ck, err := c.Cookie("ophub_token"); err == nil {
				token = ck
			}
		}
		if token == "" {
			Fail(c, http.StatusUnauthorized, 401, "未登录")
			c.Abort()
			return
		}
		if IsBlacklisted(token) {
			Fail(c, http.StatusUnauthorized, 401, "登录已失效")
			c.Abort()
			return
		}
		claims, err := ParseToken(token)
		if err != nil {
			Fail(c, http.StatusUnauthorized, 401, "登录已失效")
			c.Abort()
			return
		}
		var user User
		if err := DB.Preload("Roles").First(&user, claims.UserID).Error; err != nil {
			Fail(c, http.StatusUnauthorized, 401, "用户不存在")
			c.Abort()
			return
		}
		if user.Status != 1 {
			Fail(c, http.StatusForbidden, 403, "账号已被禁用")
			c.Abort()
			return
		}
		perms := []string{}
		for _, r := range user.Roles {
			perms = append(perms, r.Permissions...)
		}
		c.Set(ctxUID, user.ID)
		c.Set(ctxUser, user.Username)
		c.Set(ctxPerms, perms)
		c.Next()
	}
}

// RequirePermission 权限校验中间件
func RequirePermission(code string) gin.HandlerFunc {
	return func(c *gin.Context) {
		perms, _ := c.Get(ctxPerms)
		plist, _ := perms.([]string)
		for _, p := range plist {
			if p == code {
				c.Next()
				return
			}
		}
		Fail(c, http.StatusForbidden, 403, "无权限: "+code)
		c.Abort()
	}
}

// RequireAnyPermission 任一权限码命中即放行（any-of）。
// 用于「同一份数据被多个入口共用」的场景：例如巡检大屏的数据接口，
// 既服务于原有 inspection:view（巡检任务/报表使用者），
// 也服务于只授予巡检大屏权限的 inspection:screen（只看大屏的账号）。
func RequireAnyPermission(codes ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		perms, _ := c.Get(ctxPerms)
		plist, _ := perms.([]string)
		for _, p := range plist {
			for _, want := range codes {
				if p == want {
					c.Next()
					return
				}
			}
		}
		Fail(c, http.StatusForbidden, 403, "无权限: "+strings.Join(codes, " 或 "))
		c.Abort()
	}
}

// RequireAdminRole 仅内置 admin 角色可通过。
// 用于「查看 / 重置他人密码」这类高敏感操作：不通过权限码授予，避免误配。
func RequireAdminRole() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !isAdminUser(currentUID(c)) {
			Fail(c, http.StatusForbidden, 403, "仅超级管理员可执行该操作")
			c.Abort()
			return
		}
		c.Next()
	}
}

// isAdminUser 判断用户是否属于内置 admin 角色
func isAdminUser(uid uint) bool {
	if uid == 0 {
		return false
	}
	var user User
	if err := DB.Preload("Roles").First(&user, uid).Error; err != nil {
		return false
	}
	for _, r := range user.Roles {
		if r.Code == "admin" {
			return true
		}
	}
	return false
}

// currentUID 取当前登录用户 ID
func currentUID(c *gin.Context) uint {
	v, _ := c.Get(ctxUID)
	id, _ := v.(uint)
	return id
}
