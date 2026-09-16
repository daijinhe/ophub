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

// collectSubtreeIDs 收集分类及其所有子孙的分类 ID
func collectSubtreeIDs(rootID uint) []uint {
	var cats []Category
	DB.Find(&cats)
	var root *Category
	for i := range cats {
		if cats[i].ID == rootID {
			root = &cats[i]
			break
		}
	}
	if root == nil {
		return []uint{}
	}
	ids := []uint{root.ID}
	for _, c := range cats {
		if c.Path == root.Path || strings.HasPrefix(c.Path, root.Path+"/") {
			ids = append(ids, c.ID)
		}
	}
	return ids
}
