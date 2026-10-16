// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// CategoryNode 分类树节点
type CategoryNode struct {
	Category
	Children []*CategoryNode `json:"children"`
}

// GetCategoryTree 分类树
func GetCategoryTree(c *gin.Context) {
	var cats []Category
	DB.Order("sort asc, id asc").Find(&cats)
	OK(c, buildTree(cats))
}

func buildTree(cats []Category) []*CategoryNode {
	byID := map[uint]*CategoryNode{}
	for _, cat := range cats {
		cp := cat
		byID[cp.ID] = &CategoryNode{Category: cp}
	}
	var roots []*CategoryNode
	for _, n := range byID {
		if n.ParentID != nil {
			if parent, ok := byID[*n.ParentID]; ok {
				parent.Children = append(parent.Children, n)
				continue
			}
		}
		roots = append(roots, n)
	}
	sortCategoryNodes(roots)
	return roots
}

// sortCategoryNodes 按名称升序（首字母 A-Z）递归排序分类树，保证渲染顺序确定
func sortCategoryNodes(ns []*CategoryNode) {
	sort.Slice(ns, func(i, j int) bool { return ns[i].Name < ns[j].Name })
	for _, n := range ns {
		if len(n.Children) > 0 {
			sortCategoryNodes(n.Children)
		}
	}
}

type categoryReq struct {
	Name     string `json:"name"`
	ParentID *uint  `json:"parentId"`
	Sort     int    `json:"sort"`
}

// CreateCategory 新建分类（多级）
func CreateCategory(c *gin.Context) {
	var r categoryReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	if r.Name == "" {
		Fail(c, 400, 400, "名称必填")
		return
	}
	cat := Category{Name: r.Name, ParentID: r.ParentID, Sort: r.Sort}
	DB.Create(&cat)
	applyPath(&cat)
	DB.Save(&cat)
	OK(c, cat)
}

// UpdateCategory 编辑分类
func UpdateCategory(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var r categoryReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	var cat Category
	if err := DB.First(&cat, id).Error; err != nil {
		Fail(c, 404, 404, "分类不存在")
		return
	}
	if r.ParentID != nil && *r.ParentID == cat.ID {
		Fail(c, 400, 400, "父级不能是自己")
		return
	}
	cat.Name = r.Name
	cat.Sort = r.Sort
	cat.ParentID = r.ParentID
	applyPath(&cat)
	DB.Save(&cat)
	OK(c, cat)
}

// DeleteCategory 删除分类（有子分类或资产则拒绝）
func DeleteCategory(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var cnt int64
	DB.Model(&Category{}).Where("parent_id = ?", id).Count(&cnt)
	if cnt > 0 {
		Fail(c, 400, 400, "请先删除子分类")
		return
	}
	DB.Model(&Asset{}).Where("category_id = ?", id).Count(&cnt)
	if cnt > 0 {
		Fail(c, 400, 400, "该分类下存在资产，无法删除")
		return
	}
	if err := DB.Delete(&Category{}, id).Error; err != nil {
		Fail(c, 500, 500, "删除失败")
		return
	}
	OK(c, nil)
}

// applyPath 根据父级计算 level 与 path（物化路径）
func applyPath(cat *Category) {
	if cat.ParentID != nil {
		var p Category
		if err := DB.First(&p, *cat.ParentID).Error; err == nil {
			cat.Level = p.Level + 1
			cat.Path = p.Path + "/" + strconv.Itoa(int(cat.ID))
			return
		}
	}
	cat.Level = 1
	cat.Path = "/0/" + strconv.Itoa(int(cat.ID))
}

// existingCategoryIDs 过滤出分类表里真实存在的分类 ID：保持入参顺序、去重、丢弃 0。
// 任务保存时用它把「已被删除的分类」剔掉，避免存下一批永远匹配不到资产的幽灵 ID。
func existingCategoryIDs(ids []uint) []uint {
	out := []uint{}
	if len(ids) == 0 {
		return out
	}
	var cats []Category
	DB.Select("id").Find(&cats)
	has := map[uint]bool{}
	for _, c := range cats {
		has[c.ID] = true
	}
	seen := map[uint]bool{}
	for _, id := range ids {
		if id == 0 || seen[id] || !has[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// collectSubtreeIDs 收集分类及其所有子孙的分类 ID（单选口径，保留给历史调用点）
func collectSubtreeIDs(rootID uint) []uint {
	return collectSubtreesIDs([]uint{rootID})
}

// collectSubtreesIDs 收集多个分类（各自含其全部子孙）的并集分类 ID。
//
// 用途：巡检任务「按分类」支持任意层级的多选 —— 每个选中节点都按「本节点 + 全部子孙」
// 展开，多个节点之间做并集去重（选父级又选其子级不会重复，也不会漏）。
// 不存在的分类 ID 直接跳过（任务保存后分类被删掉时不至于整体失败）。
func collectSubtreesIDs(rootIDs []uint) []uint {
	if len(rootIDs) == 0 {
		return []uint{}
	}
	var cats []Category
	DB.Find(&cats)
	if len(cats) == 0 {
		return []uint{}
	}
	byID := map[uint]*Category{}
	for i := range cats {
		byID[cats[i].ID] = &cats[i]
	}
	seen := map[uint]bool{}
	out := []uint{}
	for _, rid := range rootIDs {
		root, ok := byID[rid]
		if !ok {
			continue
		}
		for i := range cats {
			c := &cats[i]
			if seen[c.ID] {
				continue
			}
			if c.Path == root.Path || strings.HasPrefix(c.Path, root.Path+"/") {
				seen[c.ID] = true
				out = append(out, c.ID)
			}
		}
	}
	return out
}
