package main

// ============================================================================
// 「监控告警报表」导出模板（v1.7.51）
//
// 需求：不同的人关注的字段不一样，需要各自建一套「导出哪些列 + 什么筛选条件」的
// 模板，以后按模板一键导出同一份报表。
//
// 设计取舍：
//   - 模板 = 列集合（有序） + 筛选条件 + 时间范围，**不存导出结果**。
//   - 时间范围存「相对天数」（days = 7/30/90）而非绝对时间戳：模板是要长期复用的，
//     存死区间的话过一个月就永远导出空表。只有「自定义区间」才存字面 stime/etime，
//     并且导出时仍会被夹进本地保留的 90 天窗口。
//   - 可见范围：**全局共享** —— 所有人都能看、能用、能改，记录创建人便于追溯。
//     与周报模板（默认私有、仅本人可改）刻意不同：这里是「团队报表口径」而非
//     「个人工作口径」，同一口径让多人各自导出才需要共享。
//   - 权限复用 prom:alert:view（读）/ prom:alert:export（写），**不新增菜单与权限码**：
//     导出模板是导出能力的附属物，单独开一套权限码只会让角色配置变复杂。
//
// ⚠️ 列的 Key 定义在 handler_prom_n9e.go 的 n9eExportCols（单一事实源），
// 本文件只负责「存哪些 Key」与「按 Key 还原成列」。
// ============================================================================

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/datatypes"
)

const (
	// 模板名 / 说明长度上限（防超长字符串进库）
	n9eTplNameMax   = 64
	n9eTplRemarkMax = 255
	// 筛选条件里 ID 数组的长度上限（防超大 JSON 进库）
	n9eTplIDsMax = 200
)

// N9eExportTemplate 导出模板。
//
// Columns / Filter 存 JSON 文本（datatypes.JSON）：列是有序列表、筛选是一组异构条件，
// 拆成多张关联表对这个量级（几十条模板）纯属过度设计。
type N9eExportTemplate struct {
	ID        uint           `gorm:"primaryKey" json:"id"`
	Name      string         `gorm:"size:64;index" json:"name"`
	Remark    string         `gorm:"size:255" json:"remark"`
	Columns   datatypes.JSON `gorm:"type:text" json:"-"`
	Filter    datatypes.JSON `gorm:"type:text" json:"-"`
	OwnerID   uint           `gorm:"index" json:"ownerId"`
	OwnerName string         `gorm:"size:64" json:"ownerName"`
	CreatedAt time.Time      `json:"-"`
	UpdatedAt time.Time      `json:"-"`
}

// TableName 表名（GORM 默认复数化对 N9e 这种前缀会拼成 n9e_export_templates，显式写死更稳）
func (N9eExportTemplate) TableName() string { return "n9e_export_templates" }

// n9eTplFilter 落库形态的筛选条件（字段齐全，读出来即可直接用）
type n9eTplFilter struct {
	TimeMode      string   `json:"timeMode"` // days = 相对天数（推荐）；custom = 字面区间
	Days          int      `json:"days"`
	Stime         int64    `json:"stime"`
	Etime         int64    `json:"etime"`
	DatasourceIDs []int    `json:"datasourceIds"`
	GroupIDs      []int    `json:"groupIds"`
	RuleProds     []string `json:"ruleProds"` // 监控类型（v1.7.52，对齐夜莺 rule_prods）
	Severity      int      `json:"severity"`  // 0 = 全部
	Recovered     int      `json:"recovered"` // -1 = 全部；0 = 未恢复；1 = 已恢复
	Department    string   `json:"department"`
	Keyword       string   `json:"keyword"`
}

// n9eTplFilterIn 入参形态：⚠️ 用指针区分「没传」与「显式传了 0」。
//
// 这不是洁癖 —— Recovered 的 0 是合法取值（未恢复），如果直接用非指针结构体接收，
// 「字段缺失」会静默变成「只看未恢复」，用户建出来的模板导出结果凭空少一大半，
// 而且页面上完全看不出来哪里错了。
type n9eTplFilterIn struct {
	TimeMode      string   `json:"timeMode"`
	Days          *int     `json:"days"`
	Stime         *int64   `json:"stime"`
	Etime         *int64   `json:"etime"`
	DatasourceIDs []int    `json:"datasourceIds"`
	GroupIDs      []int    `json:"groupIds"`
	RuleProds     []string `json:"ruleProds"`
	Severity      *int     `json:"severity"`
	Recovered     *int     `json:"recovered"`
	Department    string   `json:"department"`
	Keyword       string   `json:"keyword"`
}

// normalize 归一化入参 → 落库形态：补齐缺省值、夹紧越界值、截断超长数组。
func (in n9eTplFilterIn) normalize() n9eTplFilter {
	f := n9eTplFilter{
		TimeMode:      in.TimeMode,
		DatasourceIDs: n9eCapInts(in.DatasourceIDs, n9eTplIDsMax),
		GroupIDs:      n9eCapInts(in.GroupIDs, n9eTplIDsMax),
		RuleProds:     n9eParseRuleProds(strings.Join(in.RuleProds, ",")),
		Department:    strings.TrimSpace(in.Department),
		Keyword:       strings.TrimSpace(in.Keyword),
		Recovered:     -1,
	}
	if f.TimeMode != "custom" {
		f.TimeMode = "days"
	}
	if in.Days != nil {
		f.Days = *in.Days
	}
	if f.Days <= 0 || f.Days > n9eMaxDays {
		f.Days = n9eMaxDays
	}
	if in.Stime != nil {
		f.Stime = *in.Stime
	}
	if in.Etime != nil {
		f.Etime = *in.Etime
	}
	if in.Severity != nil {
		f.Severity = *in.Severity
	}
	if in.Recovered != nil {
		f.Recovered = *in.Recovered
	}
	// 越界值一律回退到「全部」，而不是原样存进去 —— 存了一个含义不明的数，
	// 导出时会被当成一个永远匹配不到的条件，用户只会看到「导出 0 条」。
	if f.Severity < 0 || f.Severity > 3 {
		f.Severity = 0
	}
	if f.Recovered < -1 || f.Recovered > 1 {
		f.Recovered = -1
	}
	return f
}

// toQuery 把模板条件转成查询条件。
//
// ⚠️ 必须与 n9eParseQuery 产出**同构**的 n9eQuery（同一套 apply()）：
// 模板走一条独立的条件拼装路径，迟早会和页面查询口径对不上，
// 那时会出现「模板导出的数和页面上看到的不一样」这种最难解释的问题。
func (f n9eTplFilter) toQuery() n9eQuery {
	q := n9eQuery{
		GroupIDs:      f.GroupIDs,
		DatasourceIDs: f.DatasourceIDs,
		RuleProds:     f.RuleProds,
		Severity:      f.Severity,
		Recovered:     f.Recovered,
		Keyword:       strings.TrimSpace(f.Keyword),
		Department:    strings.TrimSpace(f.Department),
	}
	now := time.Now().Unix()
	if f.TimeMode == "custom" && f.Stime > 0 && f.Etime > f.Stime {
		q.Stime, q.Etime = f.Stime, f.Etime
	} else {
		days := f.Days
		if days <= 0 || days > n9eMaxDays {
			days = n9eMaxDays
		}
		q.Etime = now
		q.Stime = now - int64(days)*86400
	}
	// 与 n9eParseQuery 同口径夹紧 90 天
	if q.Etime-q.Stime > int64(n9eMaxDays)*86400 {
		q.Stime = q.Etime - int64(n9eMaxDays)*86400
	}
	return q
}

// ColList 读出列 Key 列表（JSON 损坏时返回空 → 导出时回退全列）
func (t *N9eExportTemplate) ColList() []string {
	var keys []string
	if len(t.Columns) > 0 {
		_ = json.Unmarshal(t.Columns, &keys)
	}
	return keys
}

// FilterStruct 读出筛选条件。
// ⚠️ 先铺默认值再反序列化：JSON 里缺字段时保留默认（Recovered 默认 -1 = 全部），
// 而不是退化成 Go 零值 0（= 只看未恢复）。
func (t *N9eExportTemplate) FilterStruct() n9eTplFilter {
	f := n9eTplFilter{Recovered: -1, TimeMode: "days", Days: n9eMaxDays}
	if len(t.Filter) > 0 {
		_ = json.Unmarshal(t.Filter, &f)
	}
	return f
}

// n9eCapInts 过滤非正数、截断超长数组；返回空切片（而不是 nil）让 JSON 序列化成 []
func n9eCapInts(in []int, max int) []int {
	out := make([]int, 0, len(in))
	for _, v := range in {
		if len(out) >= max {
			break
		}
		if v > 0 {
			out = append(out, v)
		}
	}
	return out
}

// n9eSafeFileName 把模板名清理成可安全用于文件名的片段。
// Windows 上 \ / : * ? " < > | 都是非法字符，留着会让浏览器下载出一个乱码名或直接失败。
func n9eSafeFileName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 32 || strings.ContainsRune(`\/:*?"<>|`, r) {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return "模板"
	}
	if rs := []rune(out); len(rs) > 40 {
		out = string(rs[:40])
	}
	return out
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

// PromN9eExportColumns 可选导出列清单（供前端列勾选；也用于校验列 Key 仍有效）
func PromN9eExportColumns(c *gin.Context) {
	type colVO struct {
		Key   string `json:"key"`
		Label string `json:"label"`
	}
	list := make([]colVO, 0, len(n9eExportCols))
	for _, col := range n9eExportCols {
		list = append(list, colVO{Key: col.Key, Label: col.Label})
	}
	OK(c, gin.H{"list": list})
}

// PromN9eTplList 模板列表（全局共享，按最近更新排序）
func PromN9eTplList(c *gin.Context) {
	rows := make([]N9eExportTemplate, 0)
	if DB != nil {
		DB.Order("updated_at DESC, id DESC").Limit(200).Find(&rows)
	}
	list := make([]gin.H, 0, len(rows))
	for i := range rows {
		t := &rows[i]
		cols := t.ColList()
		list = append(list, gin.H{
			"id":        t.ID,
			"name":      t.Name,
			"remark":    t.Remark,
			"columns":   cols,
			"colCount":  len(cols),
			"filter":    t.FilterStruct(),
			"ownerId":   t.OwnerID,
			"ownerName": t.OwnerName,
			"createdAt": t.CreatedAt.Format(time.RFC3339),
			"updatedAt": t.UpdatedAt.Format(time.RFC3339),
		})
	}
	OK(c, gin.H{"list": list})
}

// n9eTplIn 保存模板入参
type n9eTplIn struct {
	Name    string         `json:"name"`
	Remark  string         `json:"remark"`
	Columns []string       `json:"columns"`
	Filter  n9eTplFilterIn `json:"filter"`
}

// PromN9eTplSave 新建 / 更新导出模板。
// 路由带 :id 是更新，不带是新建 —— 共用一套校验与归一化逻辑。
func PromN9eTplSave(c *gin.Context) {
	var in n9eTplIn
	if err := c.ShouldBindJSON(&in); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数解析失败："+err.Error())
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		Fail(c, http.StatusBadRequest, 400, "模板名称不能为空")
		return
	}
	if len([]rune(in.Name)) > n9eTplNameMax {
		Fail(c, http.StatusBadRequest, 400, fmt.Sprintf("模板名称不能超过 %d 个字符", n9eTplNameMax))
		return
	}
	in.Remark = strings.TrimSpace(in.Remark)
	if len([]rune(in.Remark)) > n9eTplRemarkMax {
		Fail(c, http.StatusBadRequest, 400, fmt.Sprintf("说明不能超过 %d 个字符", n9eTplRemarkMax))
		return
	}
	if DB == nil {
		Fail(c, http.StatusInternalServerError, 500, "数据库未就绪")
		return
	}

	// 列 Key 归一化：丢未知/重复 Key；一个都不剩就**显式存下全列** ——
	// 存空数组会让「以后新增了列，这个模板要不要带上」变成不可判定的语义。
	cols := n9eColsByKeys(in.Columns)
	colKeys := make([]string, 0, len(cols))
	for _, col := range cols {
		colKeys = append(colKeys, col.Key)
	}
	colsJSON, err := json.Marshal(colKeys)
	if err != nil {
		Fail(c, http.StatusInternalServerError, 500, "序列化列失败："+err.Error())
		return
	}
	filterJSON, err := json.Marshal(in.Filter.normalize())
	if err != nil {
		Fail(c, http.StatusInternalServerError, 500, "序列化筛选条件失败："+err.Error())
		return
	}

	var tpl N9eExportTemplate
	if idStr := strings.TrimSpace(c.Param("id")); idStr != "" {
		id, convErr := strconv.Atoi(idStr)
		if convErr != nil || id <= 0 {
			Fail(c, http.StatusBadRequest, 400, "模板 ID 非法")
			return
		}
		if err := DB.First(&tpl, id).Error; err != nil {
			Fail(c, http.StatusNotFound, 404, "模板不存在或已被删除")
			return
		}
	}

	tpl.Name = in.Name
	tpl.Remark = in.Remark
	tpl.Columns = datatypes.JSON(colsJSON)
	tpl.Filter = datatypes.JSON(filterJSON)
	if tpl.ID == 0 {
		tpl.OwnerID = currentUserID(c)
		tpl.OwnerName = currentUserName(c)
		if err := DB.Create(&tpl).Error; err != nil {
			Fail(c, http.StatusInternalServerError, 500, "保存失败："+err.Error())
			return
		}
	} else if err := DB.Save(&tpl).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败："+err.Error())
		return
	}
	OK(c, gin.H{"id": tpl.ID})
}

// PromN9eTplDelete 删除导出模板
func PromN9eTplDelete(c *gin.Context) {
	id, err := strconv.Atoi(strings.TrimSpace(c.Param("id")))
	if err != nil || id <= 0 {
		Fail(c, http.StatusBadRequest, 400, "模板 ID 非法")
		return
	}
	if DB == nil {
		Fail(c, http.StatusInternalServerError, 500, "数据库未就绪")
		return
	}
	var tpl N9eExportTemplate
	if err := DB.First(&tpl, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "模板不存在或已被删除")
		return
	}
	if err := DB.Delete(&N9eExportTemplate{}, id).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "删除失败："+err.Error())
		return
	}
	OK(c, gin.H{"id": id})
}
