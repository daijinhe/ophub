package main

import (
	"crypto/rand"
	"math/big"
	"strconv"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

// ListUsers 用户列表（分页 + 关键字）
func ListUsers(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "10"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 10
	}
	kw := c.Query("keyword")
	q := DB.Model(&User{})
	if kw != "" {
		q = q.Where("username LIKE ? OR nickname LIKE ? OR email LIKE ?", "%"+kw+"%", "%"+kw+"%", "%"+kw+"%")
	}
	var total int64
	q.Count(&total)
	var users []User
	q.Preload("Roles").Order("id desc").Limit(size).Offset((page - 1) * size).Find(&users)
	PageOK(c, users, total, page, size)
}

type userMutateReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Nickname string `json:"nickname"`
	Email    string `json:"email"`
	Phone    string `json:"phone"`
	RoleIDs  []uint `json:"roleIds"`
	// Status 用指针：区分「未传」（保持原值）与「显式传 0」（禁用）
	Status *int `json:"status"`
}

// CreateUser 新建用户
func CreateUser(c *gin.Context) {
	var r userMutateReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	if r.Username == "" || r.Password == "" {
		Fail(c, 400, 400, "用户名和密码必填")
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
	status := 1
	if r.Status != nil {
		status = *r.Status
	}
	user := User{
		Username:     r.Username,
		PasswordHash: string(hash),
		PasswordEnc:  enc,
		Nickname:     r.Nickname,
		Email:        r.Email,
		Phone:        r.Phone,
		Status:       status,
	}
	if len(r.RoleIDs) > 0 {
		var roles []Role
		DB.Find(&roles, r.RoleIDs)
		user.Roles = roles
	}
	if err := DB.Create(&user).Error; err != nil {
		Fail(c, 500, 500, "创建失败")
		return
	}
	OK(c, gin.H{"id": user.ID})
}

// UpdateUser 编辑用户
func UpdateUser(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var r userMutateReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	var user User
	if err := DB.First(&user, id).Error; err != nil {
		Fail(c, 404, 404, "用户不存在")
		return
	}
	user.Nickname = r.Nickname
	user.Email = r.Email
	user.Phone = r.Phone
	if r.Status != nil {
		user.Status = *r.Status
	}
	if r.Password != "" {
		hash, _ := bcrypt.GenerateFromPassword([]byte(r.Password), bcrypt.DefaultCost)
		enc, _ := encryptPassword(r.Password)
		user.PasswordHash = string(hash)
		user.PasswordEnc = enc
	}
	if len(r.RoleIDs) > 0 {
		var roles []Role
		DB.Find(&roles, r.RoleIDs)
		DB.Model(&user).Association("Roles").Replace(roles)
	}
	DB.Save(&user)
	OK(c, nil)
}

// RevealUserPassword 查看指定用户的登录密码（仅超级管理员）。
// 依赖可逆密文 PasswordEnc；历史账号（仅有 bcrypt 哈希）需先「重置密码」。
func RevealUserPassword(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var user User
	if err := DB.First(&user, id).Error; err != nil {
		Fail(c, 404, 404, "用户不存在")
		return
	}
	pwd, err := decryptPassword(user.PasswordEnc)
	if err != nil || pwd == "" {
		Fail(c, 400, 400, "该账号暂无可用密码记录（历史数据），请先「重置密码」后再查看")
		return
	}
	OK(c, gin.H{"id": user.ID, "username": user.Username, "password": pwd})
}

// ResetUserPassword 重置指定用户密码为随机串（仅超级管理员），并返回新密码供告知用户。
func ResetUserPassword(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var user User
	if err := DB.First(&user, id).Error; err != nil {
		Fail(c, 404, 404, "用户不存在")
		return
	}
	pwd := randomPassword(12)
	if err := setUserPassword(&user, pwd); err != nil {
		Fail(c, 500, 500, "重置失败")
		return
	}
	OK(c, gin.H{"id": user.ID, "username": user.Username, "password": pwd})
}

// setUserPassword 同时写入 bcrypt 哈希（登录校验）与可逆密文（供查看）
func setUserPassword(user *User, plain string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	enc, err := encryptPassword(plain)
	if err != nil {
		return err
	}
	user.PasswordHash = string(hash)
	user.PasswordEnc = enc
	return DB.Save(user).Error
}

// randomPassword 生成含大小写字母与数字的随机密码（去除了易混淆字符）
func randomPassword(n int) string {
	const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, n)
	for i := range b {
		idx, err := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		if err != nil {
			b[i] = chars[0]
			continue
		}
		b[i] = chars[idx.Int64()]
	}
	return string(b)
}

// DeleteUser 删除用户
func DeleteUser(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var user User
	if err := DB.First(&user, id).Error; err != nil {
		Fail(c, 404, 404, "用户不存在")
		return
	}
	DB.Model(&user).Association("Roles").Clear()
	if err := DB.Delete(&user).Error; err != nil {
		Fail(c, 500, 500, "删除失败")
		return
	}
	OK(c, nil)
}
