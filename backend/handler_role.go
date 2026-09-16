package main

import (
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/lib/pq"
)

// ListRoles 角色列表
func ListRoles(c *gin.Context) {
	var roles []Role
	DB.Order("id").Find(&roles)
	OK(c, roles)
}

// ListPermissions 权限目录
func ListPermissions(c *gin.Context) {
	OK(c, PermissionCatalog)
}

type roleReq struct {
	Name        string   `json:"name"`
	Code        string   `json:"code"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
}

// unknownPermCodes 返回其中不在权限目录内的权限码。
// 权限码拼错或已过期时若静默写入，角色会「看起来已授权、实际不生效」，事后极难排查，
// 所以统一在落库前校验并显式报错。
func unknownPermCodes(codes []string) []string {
	known := make(map[string]bool, len(PermissionCatalog))
	for _, code := range AllPermissionCodes() {
		known[code] = true
	}
	var unknown []string
	for _, code := range codes {
		if !known[code] {
			unknown = append(unknown, code)
		}
	}
	return unknown
}

// CreateRole 新建角色
func CreateRole(c *gin.Context) {
	var r roleReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	if r.Name == "" || r.Code == "" {
		Fail(c, 400, 400, "名称和编码必填")
		return
	}
	if unknown := unknownPermCodes(r.Permissions); len(unknown) > 0 {
		Fail(c, 400, 400, "包含未知权限码："+strings.Join(unknown, "、"))
		return
	}
	var cnt int64
	DB.Model(&Role{}).Where("code = ?", r.Code).Count(&cnt)
	if cnt > 0 {
		Fail(c, 400, 400, "角色编码已存在")
		return
	}
	role := Role{
		Name:        r.Name,
		Code:        r.Code,
		Description: r.Description,
		Permissions: pq.StringArray(r.Permissions),
	}
	if err := DB.Create(&role).Error; err != nil {
		Fail(c, 500, 500, "创建失败")
		return
	}
	OK(c, gin.H{"id": role.ID})
}

// UpdateRole 编辑角色（编码为不可变字段，不接受修改）
func UpdateRole(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var r roleReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	if r.Name == "" {
		Fail(c, 400, 400, "名称必填")
		return
	}
	if unknown := unknownPermCodes(r.Permissions); len(unknown) > 0 {
		Fail(c, 400, 400, "包含未知权限码："+strings.Join(unknown, "、"))
		return
	}
	var role Role
	if err := DB.First(&role, id).Error; err != nil {
		Fail(c, 404, 404, "角色不存在")
		return
	}
	role.Name = r.Name
	role.Description = r.Description
	role.Permissions = pq.StringArray(r.Permissions)
	if err := DB.Save(&role).Error; err != nil {
		Fail(c, 500, 500, "保存失败")
		return
	}
	OK(c, nil)
}

// DeleteRole 删除角色（内置 admin 不可删）
func DeleteRole(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var role Role
	if err := DB.First(&role, id).Error; err != nil {
		Fail(c, 404, 404, "角色不存在")
		return
	}
	if role.Code == "admin" {
		Fail(c, 400, 400, "内置管理员角色不可删除")
		return
	}
	if err := DB.Delete(&role).Error; err != nil {
		Fail(c, 500, 500, "删除失败")
		return
	}
	OK(c, nil)
}
