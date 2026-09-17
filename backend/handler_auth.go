package main

import (
	"log"
	"strings"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type registerReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Nickname string `json:"nickname"`
	Email    string `json:"email"`
	Phone    string `json:"phone"`
}

// Register 公开注册（默认绑定普通成员角色）
func Register(c *gin.Context) {
	var r registerReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	if r.Username == "" || r.Password == "" {
		Fail(c, 400, 400, "用户名和密码必填")
		return
	}
	if err := validatePasswordStrength(r.Password); err != nil {
		Fail(c, 400, 400, err.Error())
		return
	}
	var cnt int64
	DB.Model(&User{}).Where("username = ?", r.Username).Count(&cnt)
	if cnt > 0 {
		Fail(c, 400, 400, "用户名已存在")
		return
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(r.Password), bcrypt.DefaultCost)
	enc, _ := encryptPassword(r.Password)
	member := Role{}
	DB.Where("code = ?", "member").First(&member)
	user := User{
		Username:     r.Username,
		PasswordHash: string(hash),
		PasswordEnc:  enc,
		Nickname:     r.Nickname,
		Email:        r.Email,
		Phone:        r.Phone,
		Status:       1,
		Roles:        []Role{member},
	}
	if err := DB.Create(&user).Error; err != nil {
		Fail(c, 500, 500, "注册失败")
		return
	}
	OK(c, gin.H{"id": user.ID, "username": user.Username})
}

// Login 登录并签发 JWT
func Login(c *gin.Context) {
	var r loginReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	ip := c.ClientIP()
	// 1) 限流预检（P1-7）
	if err := LoginRateLimitCheck(ip, r.Username); err != nil {
		Fail(c, 429, 429, err.Error())
		return
	}
	var user User
	if err := DB.Preload("Roles").Where("username = ?", r.Username).First(&user).Error; err != nil {
		RecordLoginFailure(ip, r.Username)
		Fail(c, 401, 401, "用户名或密码错误")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(r.Password)) != nil {
		_, locked := RecordLoginFailure(ip, r.Username)
		if locked {
			log.Printf("[安全] 登录失败触发锁定：user=%s ip=%s", r.Username, ip)
		}
		Fail(c, 401, 401, "用户名或密码错误")
		return
	}
	if user.Status != 1 {
		Fail(c, 403, 403, "账号已被禁用")
		return
	}
	RecordLoginSuccess(ip, r.Username)
	token, err := GenerateToken(user.ID, user.Username)
	if err != nil {
		Fail(c, 500, 500, "生成令牌失败")
		return
	}
	OK(c, gin.H{
		"token":    token,
		"username": user.Username,
		"nickname": user.Nickname,
		"perms":    aggregatePerms(user.Roles),
		"roles":    user.Roles,
		"isAdmin":  hasAdminRole(user.Roles),
	})
}

// Logout 登出（令牌黑名单）
func Logout(c *gin.Context) {
	hdr := c.GetHeader("Authorization")
	token := strings.TrimPrefix(hdr, "Bearer ")
	_ = LogoutToken(token)
	OK(c, nil)
}

// Me 当前用户信息
func Me(c *gin.Context) {
	uid := currentUID(c)
	var user User
	if err := DB.Preload("Roles").First(&user, uid).Error; err != nil {
		Fail(c, 404, 404, "用户不存在")
		return
	}
	OK(c, gin.H{
		"id":       user.ID,
		"username": user.Username,
		"nickname": user.Nickname,
		"email":    user.Email,
		"phone":    user.Phone,
		"status":   user.Status,
		"roles":    user.Roles,
		"perms":    aggregatePerms(user.Roles),
		"isAdmin":  hasAdminRole(user.Roles),
	})
}

// ChangeMyPassword 修改自己的密码（需校验原密码）
func ChangeMyPassword(c *gin.Context) {
	var r struct {
		OldPassword string `json:"oldPassword"`
		NewPassword string `json:"newPassword"`
	}
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	if len(r.NewPassword) < 6 {
		Fail(c, 400, 400, "新密码长度至少 6 位")
		return
	}
	var user User
	if err := DB.First(&user, currentUID(c)).Error; err != nil {
		Fail(c, 404, 404, "用户不存在")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(r.OldPassword)) != nil {
		Fail(c, 400, 400, "原密码不正确")
		return
	}
	if err := setUserPassword(&user, r.NewPassword); err != nil {
		Fail(c, 500, 500, "修改失败")
		return
	}
	OK(c, nil)
}

// GetMyPassword 查看自己的登录密码
func GetMyPassword(c *gin.Context) {
	var user User
	if err := DB.First(&user, currentUID(c)).Error; err != nil {
		Fail(c, 404, 404, "用户不存在")
		return
	}
	pwd, err := decryptPassword(user.PasswordEnc)
	if err != nil || pwd == "" {
		Fail(c, 400, 400, "暂无可查看的密码记录，请先修改一次密码")
		return
	}
	OK(c, gin.H{"username": user.Username, "password": pwd})
}

// hasAdminRole 判断角色集合中是否含内置 admin
func hasAdminRole(roles []Role) bool {
	for _, r := range roles {
		if r.Code == "admin" {
			return true
		}
	}
	return false
}

func aggregatePerms(roles []Role) []string {
	perms := []string{}
	seen := map[string]bool{}
	for _, role := range roles {
		for _, p := range role.Permissions {
			if !seen[p] {
				seen[p] = true
				perms = append(perms, p)
			}
		}
	}
	return perms
}
