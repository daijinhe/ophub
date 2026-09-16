package main

import (
	"encoding/json"
	"strings"

	"github.com/gin-gonic/gin"
)

// MwTemplateResp 返回前端的中间件模板结构
type MwTemplateResp struct {
	Type   string    `json:"type"`
	Fields []MwField `json:"fields"`
}

// ListMwTemplates 列出全部中间件类型模板（供资产表单按类型动态渲染）
func ListMwTemplates(c *gin.Context) {
	var rows []MwTemplate
	DB.Order("order_no asc, type asc").Find(&rows)
	out := make([]MwTemplateResp, 0, len(rows))
	for _, r := range rows {
		var fields []MwField
		_ = json.Unmarshal([]byte(r.Fields), &fields)
		if fields == nil {
			fields = []MwField{}
		}
		out = append(out, MwTemplateResp{Type: r.Type, Fields: fields})
	}
	OK(c, out)
}

// UpsertMwTemplate 新建或更新某中间件类型的字段模板（类型名在路径中）
func UpsertMwTemplate(c *gin.Context) {
	t := strings.TrimSpace(c.Param("type"))
	if t == "" {
		Fail(c, 400, 400, "类型名称不能为空")
		return
	}
	var body struct {
		Fields []MwField `json:"fields"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	for i, f := range body.Fields {
		if f.Key == "" {
			body.Fields[i].Key = f.Label
		}
		if body.Fields[i].Key == "" {
			Fail(c, 400, 400, "字段名不能为空")
			return
		}
	}
	b, err := json.Marshal(body.Fields)
	if err != nil {
		Fail(c, 500, 500, "序列化失败")
		return
	}
	var existing MwTemplate
	if err := DB.Where("type = ?", t).First(&existing).Error; err != nil {
		var maxOrder int
		DB.Model(&MwTemplate{}).Select("COALESCE(MAX(order_no),0)").Scan(&maxOrder)
		if err := DB.Create(&MwTemplate{Type: t, Fields: string(b), OrderNo: maxOrder + 1}).Error; err != nil {
			Fail(c, 500, 500, "保存失败")
			return
		}
	} else {
		existing.Fields = string(b)
		if err := DB.Save(&existing).Error; err != nil {
			Fail(c, 500, 500, "保存失败")
			return
		}
	}
	OK(c, gin.H{"type": t})
}

// DeleteMwTemplate 删除某中间件类型模板（含内置类型，满足「已存在的也可以删除」）
func DeleteMwTemplate(c *gin.Context) {
	t := strings.TrimSpace(c.Param("type"))
	if t == "" {
		Fail(c, 400, 400, "类型名称不能为空")
		return
	}
	if err := DB.Where("type = ?", t).Delete(&MwTemplate{}).Error; err != nil {
		Fail(c, 500, 500, "删除失败")
		return
	}
	OK(c, nil)
}
