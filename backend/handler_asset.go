package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// GetFields 返回字段 schema（分组、字段、关键列）
func GetFields(c *gin.Context) {
	OK(c, gin.H{
		"groups":     FieldGroups,
		"fields":     FieldDefs,
		"keyColumns": KeyColumns,
	})
}

// ListAssets 资产列表（按分类子树 + 关键字 + 分页）
func ListAssets(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 20
	}
	catID := c.Query("categoryId")
	kw := c.Query("keyword")
	env := c.Query("env")
	businessEnv := c.Query("businessEnv")

	// 排序：sortField 为资产列名（id/name/ip/created_at/category_id）或 CMDB 字段 key
	orderClause, ok := buildAssetOrderClause(c, c.Query("sortField"), c.Query("sortOrder"))
	if !ok {
		return // 排序字段非法，响应已写入
	}

	q := DB.Model(&Asset{})
	if catID != "" {
		id, _ := strconv.Atoi(catID)
		ids := collectSubtreeIDs(uint(id))
		q = q.Where("category_id IN ?", ids)
	}
	if kw != "" {
		// 关键字同时命中「中间件捕捉」结果里的中间件类型（如输入 nginx / redis 也能搜出来）
		q = q.Where(
			"name LIKE ? OR ip LIKE ? OR fields::text LIKE ? OR id IN (SELECT asset_id FROM mw_captures WHERE mw_types ILIKE ?)",
			"%"+kw+"%", "%"+kw+"%", "%"+kw+"%", "%"+kw+"%")
	}
	if env != "" {
		q = q.Where("fields->>'环境' = ?", env)
	}
	if businessEnv != "" {
		q = q.Where("fields->>'业务环境' = ?", businessEnv)
	}
	var total int64
	q.Count(&total)
	var assets []Asset
	q.Order(orderClause).Limit(size).Offset((page - 1) * size).Find(&assets)
	// 派生展示名，供前端所有「选择资产 / 展示名」场景统一使用
	withDisplayNames(assets)
	// 中间件捕捉摘要：供列表的「中间件」列展示（不落库，仅响应填充）
	attachMwCaptureBrief(assets)
	PageOK(c, assets, total, page, size)
}

// buildAssetOrderClause 生成安全的 ORDER BY 子句。
// sortField 支持资产列名（id/name/ip/created_at/category_id）或 CMDB 字段 key（存于 JSONB fields）。
// 返回 ok=false 表示排序字段非法（响应已写入，调用方应直接 return）。
func buildAssetOrderClause(c *gin.Context, sortField, sortOrder string) (string, bool) {
	order := strings.ToLower(strings.TrimSpace(sortOrder))
	if order != "asc" && order != "desc" {
		order = "asc"
	}
	// 未指定排序字段：默认按 ID 倒序（最新录入在前）
	if strings.TrimSpace(sortField) == "" {
		return "id desc", true
	}
	// 资产表普通列：白名单内直接排序
	switch sortField {
	case "id", "name", "ip", "created_at", "category_id":
		return fmt.Sprintf("%s %s", sortField, order), true
	}
	// CMDB 字段：必须命中字段定义白名单，避免任意字符串拼进 SQL
	valid := false
	for _, f := range FieldDefs {
		if f.Key == sortField {
			valid = true
			break
		}
	}
	if !valid {
		Fail(c, http.StatusBadRequest, 400, "排序字段无效")
		return "", false
	}
	// 数值内容按数值大小排序（否则 "10" 会排在 "9" 之前），
	// 非数值内容按文本排序并统一排在末尾（NULLS LAST）。
	return fmt.Sprintf(
		"CASE WHEN fields->>'%s' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (fields->>'%s')::numeric ELSE NULL END %s NULLS LAST, fields->>'%s' %s",
		sortField, sortField, order, sortField, order,
	), true
}

// GetAsset 资产详情（全字段）
func GetAsset(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var a Asset
	if err := DB.First(&a, id).Error; err != nil {
		Fail(c, 404, 404, "资产不存在")
		return
	}
	// 派生展示名（单个资产直接赋值，不能走 withDisplayNames——那会改在副本上）
	a.DisplayName = AssetDisplayName(&a)
	OK(c, a)
}

type assetReq struct {
	CategoryID uint                   `json:"categoryId"`
	Name       string                 `json:"name"`
	IP         string                 `json:"ip"`
	Fields     map[string]interface{} `json:"fields"`
}

// CreateAsset 新建资产
func CreateAsset(c *gin.Context) {
	var r assetReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	if r.CategoryID == 0 {
		Fail(c, 400, 400, "请选择分类")
		return
	}
	if r.Fields == nil {
		r.Fields = map[string]interface{}{}
	}
	a := Asset{
		CategoryID: r.CategoryID,
		Name:       firstNonEmpty(r.Name, sprintField(r.Fields, "虚拟机名称"), sprintField(r.Fields, "虚拟机IPv4"), sprintField(r.Fields, "应用系统名称")),
		IP:         firstNonEmpty(r.IP, sprintField(r.Fields, "虚拟机IPv4")),
		Fields:     toJSON(r.Fields),
		CreatedBy:  currentUID(c),
	}
	if err := DB.Create(&a).Error; err != nil {
		Fail(c, 500, 500, "创建失败")
		return
	}
	OK(c, gin.H{"id": a.ID})
}

// UpdateAsset 编辑资产
func UpdateAsset(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var r assetReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, 400, 400, "参数错误")
		return
	}
	var a Asset
	if err := DB.First(&a, id).Error; err != nil {
		Fail(c, 404, 404, "资产不存在")
		return
	}
	if r.Fields == nil {
		r.Fields = map[string]interface{}{}
	}
	a.CategoryID = r.CategoryID
	a.Name = firstNonEmpty(r.Name, sprintField(r.Fields, "虚拟机名称"), sprintField(r.Fields, "虚拟机IPv4"), sprintField(r.Fields, "应用系统名称"))
	a.IP = firstNonEmpty(r.IP, sprintField(r.Fields, "虚拟机IPv4"))
	a.Fields = toJSON(r.Fields)
	if err := DB.Save(&a).Error; err != nil {
		Fail(c, 500, 500, "保存失败")
		return
	}
	// 展示名派生自 fields：清掉带旧名字的派生缓存，否则定时任务等页面短时间内仍是旧名
	InvalidateAssetDerivedCaches(a.ID)
	OK(c, nil)
}

// DeleteAsset 删除资产
func DeleteAsset(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	if err := DB.Delete(&Asset{}, id).Error; err != nil {
		Fail(c, 500, 500, "删除失败")
		return
	}
	// 连带清掉该资产的定时任务「用途」备注，避免留下孤儿行
	DB.Where("asset_id = ?", id).Delete(&CrontabTaskNote{})
	// 中间件捕捉快照同样随资产删除
	DB.Where("asset_id = ?", id).Delete(&MwCapture{})
	OK(c, nil)
}

// BatchDeleteAssets 批量删除资产
func BatchDeleteAssets(c *gin.Context) {
	var req struct {
		IDs []uint `json:"ids"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.IDs) == 0 {
		Fail(c, 400, 400, "请选择要删除的资产")
		return
	}
	if err := DB.Delete(&Asset{}, req.IDs).Error; err != nil {
		Fail(c, 500, 500, "批量删除失败")
		return
	}
	// 连带清掉这些资产的定时任务「用途」备注
	DB.Where("asset_id IN ?", req.IDs).Delete(&CrontabTaskNote{})
	DB.Where("asset_id IN ?", req.IDs).Delete(&MwCapture{})
	OK(c, gin.H{"deleted": len(req.IDs)})
}

// BatchUpdateAssets 批量修改资产（合并指定字段到每个选中的资产）
func BatchUpdateAssets(c *gin.Context) {
	var req struct {
		IDs    []uint                 `json:"ids"`
		Fields map[string]interface{} `json:"fields"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.IDs) == 0 {
		Fail(c, 400, 400, "请选择要修改的资产")
		return
	}
	if len(req.Fields) == 0 {
		Fail(c, 400, 400, "请至少填写一个要修改的字段")
		return
	}
	var assets []Asset
	DB.Find(&assets, req.IDs)
	if len(assets) == 0 {
		Fail(c, 404, 404, "未找到选中的资产")
		return
	}
	for i := range assets {
		var m map[string]interface{}
		if len(assets[i].Fields) > 0 {
			if err := json.Unmarshal(assets[i].Fields, &m); err != nil || m == nil {
				m = map[string]interface{}{}
			}
		}
		if m == nil {
			m = map[string]interface{}{}
		}
		for k, v := range req.Fields {
			if v == nil {
				delete(m, k)
			} else {
				m[k] = v
			}
		}
		assets[i].Fields = toJSON(m)
		// 重新派生 name / ip（与编辑资产逻辑一致）
		assets[i].Name = firstNonEmpty(
			sprintField(m, "虚拟机名称"),
			sprintField(m, "虚拟机IPv4"),
			sprintField(m, "应用系统名称"),
		)
		assets[i].IP = sprintField(m, "虚拟机IPv4")
	}
	// 逐条保存（每条合并结果不同）
	if err := DB.Transaction(func(tx *gorm.DB) error {
		for i := range assets {
			if err := tx.Save(&assets[i]).Error; err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		Fail(c, 500, 500, "批量修改失败")
		return
	}
	for i := range assets {
		InvalidateAssetDerivedCaches(assets[i].ID)
	}
	OK(c, gin.H{"updated": len(assets)})
}

// ImportAssets 从 Excel 模板导入资产到指定分类
func ImportAssets(c *gin.Context) {
	catIDStr := c.PostForm("categoryId")
	if catIDStr == "" {
		Fail(c, 400, 400, "请选择导入分类")
		return
	}
	catID, _ := strconv.Atoi(catIDStr)
	var cat Category
	if err := DB.First(&cat, catID).Error; err != nil {
		Fail(c, 404, 404, "分类不存在")
		return
	}
	file, err := c.FormFile("file")
	if err != nil {
		Fail(c, 400, 400, "请上传文件")
		return
	}
	tmp := filepath.Join(Cfg.UploadDir, fmt.Sprintf("%d_%d_%s", catID, time.Now().UnixNano(), file.Filename))
	if err := c.SaveUploadedFile(file, tmp); err != nil {
		Fail(c, 500, 500, "保存文件失败")
		return
	}
	defer func() { _ = os.Remove(tmp) }()
	n, err := importFromExcel(tmp, uint(catID), currentUID(c))
	if err != nil {
		Fail(c, 500, 500, err.Error())
		return
	}
	// 导入会改写大量资产的展示名字段，全量清派生缓存，避免页面继续显示旧名
	InvalidateAllAssetDerivedCaches()
	OK(c, gin.H{"imported": n})
}

// ExportAssets 导出资产为 Excel（按分类子树 + 关键字，排序与列表保持一致）
func ExportAssets(c *gin.Context) {
	catID := c.Query("categoryId")
	kw := c.Query("keyword")
	env := c.Query("env")
	businessEnv := c.Query("businessEnv")

	// 与列表共用同一套排序规则，保证导出顺序与页面所见一致
	orderClause, ok := buildAssetOrderClause(c, c.Query("sortField"), c.Query("sortOrder"))
	if !ok {
		return
	}

	q := DB.Model(&Asset{})
	if catID != "" {
		id, _ := strconv.Atoi(catID)
		ids := collectSubtreeIDs(uint(id))
		q = q.Where("category_id IN ?", ids)
	}
	if kw != "" {
		// 关键字同时命中「中间件捕捉」结果里的中间件类型（如输入 nginx / redis 也能搜出来）
		q = q.Where(
			"name LIKE ? OR ip LIKE ? OR fields::text LIKE ? OR id IN (SELECT asset_id FROM mw_captures WHERE mw_types ILIKE ?)",
			"%"+kw+"%", "%"+kw+"%", "%"+kw+"%", "%"+kw+"%")
	}
	if env != "" {
		q = q.Where("fields->>'环境' = ?", env)
	}
	if businessEnv != "" {
		q = q.Where("fields->>'业务环境' = ?", businessEnv)
	}
	var assets []Asset
	q.Order(orderClause).Find(&assets)
	// 导出带上「中间件」列（来自中间件捕捉快照）
	attachMwCaptureBrief(assets)
	buf, err := exportToExcel(assets)
	if err != nil {
		Fail(c, 500, 500, err.Error())
		return
	}
	filename := fmt.Sprintf("cmdb_export_%s.xlsx", time.Now().Format("20060102_150405"))
	c.Header("Content-Disposition", "attachment; filename="+filename)
	c.Header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buf.Bytes())
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// sprintField 安全地把 map 值转字符串：nil 或 Go 默认 "<nil>" 视为空
func sprintField(m map[string]interface{}, key string) string {
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	s := fmt.Sprint(v)
	if s == "<nil>" {
		return ""
	}
	return s
}
