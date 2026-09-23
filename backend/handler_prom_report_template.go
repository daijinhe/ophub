package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/datatypes"
)

// promMarshalList 把项目名数组序列化成 JSON（存库用）。
//
// ⚠️ 刻意关掉 HTML 转义：默认 json.Marshal 会把 < > & 写成 \u003c 这样的转义序列，
// 于是「按项目名检索报告记录」（systems_json LIKE '%"项目名"%'）在碰到含这些字符的
// 项目名时会**静默查不到**——不报错、只是永远搜不出结果。关掉转义即可避免。
func promMarshalList(list []string) ([]byte, error) {
	if list == nil {
		list = []string{}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(list); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// ============================================================================
// Prometheus 监控报表「报表模板」+「项目清单」（v1.7.38）
//
// 需求：每个人负责的项目不同，需要为「自己的一个或多个项目」建不同的报表模板，
// 然后按模板生成自己的季度报告。
//
// 设计取舍：
//   - **模板 = 数据源 + 项目范围 + 默认周期 + 名称/备注**，是可复用的「报告口径」，
//     不存报告结果（结果是「报告记录」的职责）。改模板不影响已归档的历史报告。
//   - 「项目」就是 Prometheus target label `system`（与报表「项目名」列同源）。
//     项目清单从 `up` 的 target labels 现算 —— 不另建项目主数据表，
//     因为 Prometheus 侧的 target 才是唯一真相，抄一份到平台只会不一致。
//   - **可见性默认私有**（shared=0）：模板是个人工作口径，只有本人可见可用；
//     需要给别人用时勾「共享」。改 / 删始终只允许本人（或 prom:manage 管理员）。
//   - ⚠️ 权限刻意不用 prom:manage 收口：本功能的目标用户是「只负责自己项目的
//     普通使用者」，若要求 prom:manage 才能建模板，等于把功能锁死在管理员手上。
//     所以路由只要求 prom:view，行级权限在 handler 里判（hasPerm + owner 比对）。
// ============================================================================

// 模板名 / 项目范围的长度上限（防超长字符串进库、进 PromQL）
const (
	promTplNameMax     = 64
	promTplProjectsMax = 200
	promTplProjectMax  = 128
	promTplRemarkMax   = 255
)

// PromReportTemplate 报表模板
type PromReportTemplate struct {
	ID        uint           `gorm:"primaryKey" json:"id"`
	Name      string         `gorm:"size:64;index" json:"name"`
	DSID      uint           `gorm:"index" json:"dsId"`
	DSName    string         `gorm:"size:64" json:"dsName"`
	Period    string         `gorm:"size:16" json:"period"` // 默认周期 month|quarter|year
	Systems   datatypes.JSON `gorm:"type:text" json:"-"`    // 项目范围（JSON 数组）
	Remark    string         `gorm:"size:255" json:"remark"`
	Shared    int            `json:"shared"` // 1=其他人可见并可用（只读）
	OwnerID   uint           `gorm:"index" json:"ownerId"`
	OwnerName string         `gorm:"size:64" json:"ownerName"`
	CreatedAt time.Time      `json:"createdAt"`
	UpdatedAt time.Time      `json:"updatedAt"`

	// 响应附加字段（不进库）
	Projects []string `gorm:"-" json:"systems"`
	CanEdit  bool     `gorm:"-" json:"canEdit"`
}

// promTplProjects 解出模板的项目范围（坏数据返回空切片，不让接口 500）
func promTplProjects(t *PromReportTemplate) []string {
	var out []string
	if len(t.Systems) > 0 {
		_ = json.Unmarshal([]byte(t.Systems), &out)
	}
	if out == nil {
		out = []string{}
	}
	return out
}

// promTplFill 填充响应附加字段（Projects / CanEdit）
func promTplFill(t *PromReportTemplate, c *gin.Context) {
	t.Projects = promTplProjects(t)
	t.CanEdit = promTplCanEdit(c, t)
}

// promTplCanEdit 改 / 删权限：本人，或持有 prom:report:manage 的管理员
func promTplCanEdit(c *gin.Context, t *PromReportTemplate) bool {
	if hasPerm(c, "prom:report:manage") {
		return true
	}
	return t.OwnerID != 0 && t.OwnerID == currentUserID(c)
}

// promTplBody 新建 / 更新模板的请求体
type promTplBody struct {
	Name    string   `json:"name"`
	DSID    uint     `json:"dsId"`
	Period  string   `json:"period"`
	Systems []string `json:"systems"`
	Remark  string   `json:"remark"`
	Shared  *int     `json:"shared"` // 指针区分「未传」与「显式 0」
}

// promTplNormalize 校验并规范化请求体（返回规范化后的项目范围）
func promTplNormalize(b *promTplBody) ([]string, error) {
	b.Name = strings.TrimSpace(b.Name)
	if b.Name == "" {
		return nil, fmt.Errorf("请填写模板名称")
	}
	if len([]rune(b.Name)) > promTplNameMax {
		return nil, fmt.Errorf("模板名称过长（上限 %d 字符）", promTplNameMax)
	}
	b.Remark = strings.TrimSpace(b.Remark)
	if len([]rune(b.Remark)) > promTplRemarkMax {
		return nil, fmt.Errorf("备注过长（上限 %d 字符）", promTplRemarkMax)
	}
	if b.Period == "" {
		b.Period = "quarter" // 本功能的初衷就是季度报告，模板默认取季度
	}
	switch b.Period {
	case "month", "quarter", "year":
	default:
		return nil, fmt.Errorf("周期不合法：%s（可选 month / quarter / year）", b.Period)
	}
	if b.DSID == 0 {
		return nil, fmt.Errorf("请选择数据源")
	}
	// 项目范围：不允许为空 —— 「不限项目」交给「监控报表」页直接生成，
	// 存成模板会造成「以为只统计自己的项目、其实统计了全集群」的误解
	systems := promNormalizeScope(b.Systems)
	if len(systems) == 0 {
		return nil, fmt.Errorf("请至少选择一个项目")
	}
	if len(systems) > promTplProjectsMax {
		return nil, fmt.Errorf("单个模板最多选择 %d 个项目", promTplProjectsMax)
	}
	for _, s := range systems {
		if len([]rune(s)) > promTplProjectMax {
			return nil, fmt.Errorf("项目名过长（上限 %d 字符）：%s", promTplProjectMax, truncateStr(s, 40))
		}
	}
	return systems, nil
}

// promTplNameTaken 同一创建人下模板名不可重复（shared 出去的同名模板不冲突）
func promTplNameTaken(ownerID, excludeID uint, name string) bool {
	var n int64
	q := DB.Model(&PromReportTemplate{}).Where("owner_id = ? and name = ?", ownerID, name)
	if excludeID != 0 {
		q = q.Where("id <> ?", excludeID)
	}
	q.Count(&n)
	return n > 0
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// PromListProjects GET /api/prom/projects?ds=
//
// 返回数据源下的**项目清单**（来自 up 的 target labels），带每个项目的主机数 / 在线数。
// 报表页用它做项目多选，「按项目出报告」的范围就是从这里选的。
//
// unlabeled 是**没打 system 标签**的 target 数：这类主机不属于任何项目，
// 按项目出报告时**一定不会被包含**。必须显式告知用户，否则会以为报告覆盖了全部机器。
func PromListProjects(c *gin.Context) {
	ds, cli, err := resolvePromDS(c)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), promHTTPTimeout)
	defer cancel()
	// 只看 up：每条 up 序列 = 一个采集目标；up 自带 target 注入的 system/department
	upSamples, err := cli.query(ctx, "up", "")
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, "查询采集目标失败："+err.Error())
		return
	}

	type agg struct {
		hosts, online int
		dept          string
	}
	m := map[string]*agg{}
	unlabeled := 0
	for _, s := range upSamples {
		name := strings.TrimSpace(s.Metric["system"])
		if name == "" {
			unlabeled++
			continue
		}
		a := m[name]
		if a == nil {
			a = &agg{}
			m[name] = a
		}
		a.hosts++
		if v, ok := sampleValue(s.Value); ok && v > 0 {
			a.online++
		}
		if a.dept == "" {
			a.dept = strings.TrimSpace(s.Metric["department"])
		}
	}
	list := make([]gin.H, 0, len(m))
	for name, a := range m {
		list = append(list, gin.H{
			"name":       name,
			"hosts":      a.hosts,
			"online":     a.online,
			"offline":    a.hosts - a.online,
			"department": a.dept,
		})
	}
	// 主机多的排前面（最可能需要建模板的往往是自己的大项目），同数按名称
	sort.Slice(list, func(i, j int) bool {
		hi, hj := list[i]["hosts"].(int), list[j]["hosts"].(int)
		if hi != hj {
			return hi > hj
		}
		return list[i]["name"].(string) < list[j]["name"].(string)
	})

	OK(c, gin.H{
		"list":      list,
		"total":     len(list),
		"targets":   len(upSamples),
		"unlabeled": unlabeled,
		"dsId":      ds.ID,
		"dsName":    ds.Name,
	})
}

// PromListReportTemplates GET /api/prom/report-templates
//
// 可见范围：本人的模板 + 别人共享的模板；管理员（prom:report:manage）看全部（便于排查）。
func PromListReportTemplates(c *gin.Context) {
	uid := currentUserID(c)
	q := DB.Model(&PromReportTemplate{})
	if !hasPerm(c, "prom:report:manage") {
		q = q.Where("owner_id = ? OR shared = 1", uid)
	}
	var list []PromReportTemplate
	if err := q.Order("updated_at desc, id desc").Find(&list).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 1, "查询报表模板失败："+err.Error())
		return
	}
	if list == nil {
		list = []PromReportTemplate{}
	}
	for i := range list {
		promTplFill(&list[i], c)
	}
	// 本人的排前面，方便「打开页面先看到自己的」
	sort.SliceStable(list, func(i, j int) bool {
		if (list[i].OwnerID == uid) != (list[j].OwnerID == uid) {
			return list[i].OwnerID == uid
		}
		return false
	})
	mine := 0
	for i := range list {
		if list[i].OwnerID == uid {
			mine++
		}
	}
	OK(c, gin.H{"list": list, "total": len(list), "mine": mine, "uid": uid})
}

// PromCreateReportTemplate POST /api/prom/report-templates
func PromCreateReportTemplate(c *gin.Context) {
	var body promTplBody
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 1, "请求体不合法："+err.Error())
		return
	}
	systems, err := promTplNormalize(&body)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	// 数据源必须是当前可用的，避免建出一个「一生成就报错」的模板
	ds, err := promResolveDSByID(body.DSID)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	uid := currentUserID(c)
	if promTplNameTaken(uid, 0, body.Name) {
		Fail(c, http.StatusBadRequest, 1, "你已有一个同名模板："+body.Name)
		return
	}
	raw, err := promMarshalList(systems)
	if err != nil {
		Fail(c, http.StatusInternalServerError, 1, "序列化项目范围失败："+err.Error())
		return
	}
	t := PromReportTemplate{
		Name:      body.Name,
		DSID:      ds.ID,
		DSName:    ds.Name,
		Period:    body.Period,
		Systems:   datatypes.JSON(raw),
		Remark:    body.Remark,
		Shared:    0,
		OwnerID:   uid,
		OwnerName: currentUserName(c),
	}
	if body.Shared != nil {
		t.Shared = promBool01(*body.Shared)
	}
	if err := DB.Create(&t).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 1, "创建失败："+err.Error())
		return
	}
	promTplFill(&t, c)
	OK(c, gin.H{"msg": "模板已创建", "template": t})
}

// PromUpdateReportTemplate PUT /api/prom/report-templates/:id
//
// 只能改自己的模板；管理员（prom:manage）可改任何人的（用于纠正误配）。
// 创建人 / 数据源快照不因更新而改变归属。
func PromUpdateReportTemplate(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		Fail(c, http.StatusBadRequest, 1, "模板 id 不合法")
		return
	}
	var t PromReportTemplate
	if err := DB.Where("id = ?", id).First(&t).Error; err != nil {
		Fail(c, http.StatusNotFound, 1, "模板不存在或已删除")
		return
	}
	if !promTplCanEdit(c, &t) {
		Fail(c, http.StatusForbidden, 1, "只能修改自己创建的模板")
		return
	}
	var body promTplBody
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 1, "请求体不合法："+err.Error())
		return
	}
	systems, err := promTplNormalize(&body)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	ds, err := promResolveDSByID(body.DSID)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	if promTplNameTaken(t.OwnerID, t.ID, body.Name) {
		Fail(c, http.StatusBadRequest, 1, "该创建人已有同名模板："+body.Name)
		return
	}
	raw, err := promMarshalList(systems)
	if err != nil {
		Fail(c, http.StatusInternalServerError, 1, "序列化项目范围失败："+err.Error())
		return
	}
	t.Name = body.Name
	t.DSID = ds.ID
	t.DSName = ds.Name
	t.Period = body.Period
	t.Systems = datatypes.JSON(raw)
	t.Remark = body.Remark
	if body.Shared != nil {
		t.Shared = promBool01(*body.Shared)
	}
	if err := DB.Save(&t).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 1, "保存失败："+err.Error())
		return
	}
	promTplFill(&t, c)
	OK(c, gin.H{"msg": "已保存", "template": t})
}

// PromDeleteReportTemplate DELETE /api/prom/report-templates/:id
func PromDeleteReportTemplate(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		Fail(c, http.StatusBadRequest, 1, "模板 id 不合法")
		return
	}
	var t PromReportTemplate
	if err := DB.Where("id = ?", id).First(&t).Error; err != nil {
		Fail(c, http.StatusNotFound, 1, "模板不存在或已删除")
		return
	}
	if !promTplCanEdit(c, &t) {
		Fail(c, http.StatusForbidden, 1, "只能删除自己创建的模板")
		return
	}
	if err := DB.Delete(&PromReportTemplate{}, id).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 1, "删除失败："+err.Error())
		return
	}
	OK(c, gin.H{"msg": "模板已删除（已归档的历史报告不受影响）"})
}

// promBool01 把任意整数收敛为 0/1（前端可能传 true/false 序列化成 1/0，也可能传别的）
func promBool01(v int) int {
	if v == 1 {
		return 1
	}
	return 0
}
