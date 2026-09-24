package main

// ============================================================================
// 「监控告警报表」导出 —— 概览 Sheet（v1.7.54）
//
// 需求：「像巡检季度报告那样，先给一页总结概览，后面再是明细」。
// 所以导出的 xlsx 从 1 个 Sheet 变成 2 个：
//
//	概览      ← 本文件：报告范围 / 筛选条件 / 告警总览 / 等级与类型分布 /
//	            业务组·数据源·规则·部门 TOP10 / 按天趋势 / Sheet 说明
//	告警明细  ← handler_prom_n9e.go 里原来的那张表（列由模板或 cols 决定）
//
// ⚠️ 概览里每个数字都必须与页面上的统计卡 / 图表**同口径**：全部走同一个
// n9eQuery.apply(q)，绝不另写一份 SQL。各写一份必然漂移，最后会出现
// 「概览写 25 万、明细只有 21 万」这类最难解释、也最难被发现的问题 ——
// 而概览恰恰是别人最先看、也最信的那一页。
// ============================================================================

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
	"gorm.io/gorm"
)

// n9eTZ 报表展示时区（东八区）。
//
// ⚠️ 后端容器与 PostgreSQL 都是 UTC，而看报表的人在 +08:00。
// 直接用 time.Unix(ts, 0).Format(...) 会导出**比页面早 8 小时**的时间：
// v1.7.54 实测同一个事件，接口给 2026-09-24 13:35:59（页面 dayjs 按本地时区渲染），
// 导出的 xlsx 里却写着 05:35:59 —— 两边对不上，而报表是拿去开会用的。
// 报表是给人看的，统一按东八区输出（与页面所见一致）。
var n9eTZ = time.FixedZone("CST", 8*3600)

// n9eTimeStr unix 秒 → 东八区「2006-01-02 15:04:05」；0 返回空串
func n9eTimeStr(ts int64) string {
	if ts <= 0 {
		return ""
	}
	return time.Unix(ts, 0).In(n9eTZ).Format("2006-01-02 15:04:05")
}

// n9eDateStr unix 秒 → 东八区「2006-01-02」；0 返回空串
func n9eDateStr(ts int64) string {
	if ts <= 0 {
		return ""
	}
	return time.Unix(ts, 0).In(n9eTZ).Format("2006-01-02")
}

// n9eNowStr 当前东八区时间串（容器跑在 UTC，不能直接用 time.Now()）
func n9eNowStr() string {
	return time.Now().In(n9eTZ).Format("2006-01-02 15:04:05")
}

// n9eCountKV 概览 Sheet 的分组统计行
type n9eCountKV struct {
	Key   string
	Value int64
}

// n9ePct 占比文案。总数 0 时给「—」而不是 NaN% —— 空报表也要能看懂。
func n9ePct(v, total int64) string {
	if total <= 0 {
		return "—"
	}
	return fmt.Sprintf("%.1f%%", float64(v)/float64(total)*100)
}

// n9ePickNames 按给定 id 顺序把名称取出来，查不到的退化为 #id
// （宁可显示 #12，也不能让这一格空着让人以为「没筛选」）
func n9ePickNames(ids []int, m map[int]string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if n, ok := m[id]; ok && n != "" {
			out = append(out, n)
		} else {
			out = append(out, fmt.Sprintf("#%d", id))
		}
	}
	return out
}

// n9eGroupNames 业务组 id → 名称（以同步时落下的清单表为准）
func n9eGroupNames(ids []int) []string {
	if len(ids) == 0 || DB == nil {
		return nil
	}
	var rows []N9eBusiGroup
	DB.Where("id IN ?", ids).Find(&rows)
	m := map[int]string{}
	for _, r := range rows {
		m[r.ID] = r.Name
	}
	return n9ePickNames(ids, m)
}

// n9eDatasourceNames 数据源 id → 名称（事件表里已有同步时建好的 id→name 映射）
func n9eDatasourceNames(ids []int) []string {
	if len(ids) == 0 || DB == nil {
		return nil
	}
	type kv struct {
		DatasourceID   int
		DatasourceName string
	}
	var rows []kv
	DB.Model(&N9eAlertEvent{}).
		Select("datasource_id, datasource_name").
		Where("datasource_id IN ?", ids).
		Group("datasource_id, datasource_name").Scan(&rows)
	m := map[int]string{}
	for _, r := range rows {
		if r.DatasourceName != "" {
			m[r.DatasourceID] = r.DatasourceName
		}
	}
	return n9ePickNames(ids, m)
}

// n9eFilterDesc 把当前查询条件拼成一句可读说明（概览的「筛选条件」行）。
//
// 报表最容易被问的一句话就是「这是筛了什么的数？」—— 空报表尤其如此，
// 所以未加任何条件时也要显式写「全部（未加筛选条件）」，不能留空白。
func n9eFilterDesc(q n9eQuery) string {
	var parts []string
	if len(q.GroupIDs) > 0 {
		parts = append(parts, "业务组："+strings.Join(n9eGroupNames(q.GroupIDs), "、"))
	}
	if len(q.DatasourceIDs) > 0 {
		parts = append(parts, "数据源："+strings.Join(n9eDatasourceNames(q.DatasourceIDs), "、"))
	}
	if len(q.RuleProds) > 0 {
		labels := make([]string, 0, len(q.RuleProds))
		for _, p := range q.RuleProds {
			labels = append(labels, n9eRuleProdLabel(p))
		}
		parts = append(parts, "监控类型："+strings.Join(labels, "、"))
	}
	if q.Severity > 0 {
		parts = append(parts, "告警级别："+n9eSeverityLabel(q.Severity))
	}
	switch q.Recovered {
	case 0:
		parts = append(parts, "事件类别：触发（未恢复）")
	case 1:
		parts = append(parts, "事件类别：已恢复")
	}
	if q.Keyword != "" {
		parts = append(parts, "关键字："+q.Keyword)
	}
	if q.Department != "" {
		parts = append(parts, "部门："+q.Department)
	}
	if len(parts) == 0 {
		return "全部（未加筛选条件）"
	}
	return strings.Join(parts, "；")
}

// n9eOverviewData 概览需要的全部统计（一次查完，避免逐个区块各查一遍）
type n9eOverviewData struct {
	Total      int64
	Recovered  int64
	HostCount  int64
	RuleCount  int64
	BySeverity []n9eCountKV
	ByProd     []n9eCountKV
	ByGroup    []n9eCountKV
	ByDatasrc  []n9eCountKV
	ByRule     []n9eCountKV
	ByDept     []n9eCountKV
	ByDay      []n9eCountKV
}

// n9eCollectOverview 按当前筛选条件汇总（全部复用 n9eQuery.apply）
func n9eCollectOverview(q n9eQuery) *n9eOverviewData {
	d := &n9eOverviewData{}
	if DB == nil {
		return d
	}
	base := func() *gorm.DB { return q.apply(DB.Model(&N9eAlertEvent{})) }

	if err := base().Count(&d.Total).Error; err != nil {
		return d
	}
	base().Where("is_recovered = 1").Count(&d.Recovered)
	base().Where("target_host <> ''").Distinct("target_host").Count(&d.HostCount)
	base().Distinct("rule_id").Count(&d.RuleCount)

	// 等级：按 severity 升序（1=S1 最严重在前），与夜莺一致
	base().Select("severity::text as key, count(*) as value").
		Group("severity").Order("severity ASC").Scan(&d.BySeverity)
	// 监控类型：空值归到「(未标注)」，避免 TOP 榜里出现一行空名字
	base().Select("CASE WHEN rule_prod = '' THEN '(未标注)' ELSE rule_prod END as key, count(*) as value").
		Group("key").Order("value DESC").Scan(&d.ByProd)
	base().Select("group_name as key, count(*) as value").
		Where("group_name <> ''").Group("group_name").Order("value DESC").Limit(10).Scan(&d.ByGroup)
	base().Select("datasource_name as key, count(*) as value").
		Where("datasource_name <> ''").Group("datasource_name").Order("value DESC").Limit(10).Scan(&d.ByDatasrc)
	base().Select("rule_name as key, count(*) as value").
		Where("rule_name <> ''").Group("rule_name").Order("value DESC").Limit(10).Scan(&d.ByRule)
	base().Select("department as key, count(*) as value").
		Where("department <> ''").Group("department").Order("value DESC").Limit(10).Scan(&d.ByDept)
	// 逐日趋势：⚠️ 必须显式转东八区再取日期。
	// 容器与 PG 都是 UTC，直接 to_timestamp(trigger_time)::date 会把
	// 北京时间 00:00~08:00 的告警算进「前一天」。
	base().Select("to_char(to_timestamp(trigger_time) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') as key, count(*) as value").
		Group("key").Order("key ASC").Scan(&d.ByDay)

	return d
}

// 概览 Sheet 的行样式
const (
	n9eOvData = iota
	n9eOvTitle
	n9eOvSection
	n9eOvHead
)

// n9eOvRow 概览的一行：A 列标签 / B 列值 / C 列备注（占比）
type n9eOvRow struct {
	A, C string
	B    interface{}
	Kind int
}

// n9eBuildOverviewSheet 写「概览」Sheet（调用方负责把它放到第一个位置）。
func n9eBuildOverviewSheet(f *excelize.File, q n9eQuery, cols []n9eExportCol, tplName string) error {
	const sheet = "概览"
	if _, err := f.NewSheet(sheet); err != nil {
		return err
	}

	d := n9eCollectOverview(q)
	unresolved := d.Total - d.Recovered

	var rows []n9eOvRow
	title := func(a string) { rows = append(rows, n9eOvRow{A: a, Kind: n9eOvTitle}) }
	section := func(a string) { rows = append(rows, n9eOvRow{A: a, Kind: n9eOvSection}) }
	blank := func() { rows = append(rows, n9eOvRow{}) }
	data := func(a string, b interface{}, c string) {
		rows = append(rows, n9eOvRow{A: a, B: b, C: c})
	}
	head := func(a, b, c string) {
		rows = append(rows, n9eOvRow{A: a, B: b, C: c, Kind: n9eOvHead})
	}
	// 分组榜：条数 + 占比（占比按「筛选后总数」算，口径与页面统计卡一致）
	rank := func(items []n9eCountKV) {
		for _, it := range items {
			rows = append(rows, n9eOvRow{A: it.Key, B: it.Value, C: n9ePct(it.Value, d.Total)})
		}
	}

	title("夜莺告警报表")

	// ---- 报告范围 / 筛选条件 ----
	data("报告时间范围", n9eDateStr(q.Stime)+" ~ "+n9eDateStr(q.Etime), fmt.Sprintf("共 %d 天", int((q.Etime-q.Stime)/86400)+1))
	data("生成时间", n9eNowStr(), "")
	data("筛选条件", n9eFilterDesc(q), "")
	src := "夜莺（Nightingale）历史告警本地快照"
	if ts := n9eLastSyncAt(); ts != "" {
		// n9eLastSyncAt 给的是 RFC3339（带时区），这里转成东八区给人看
		if t, err := time.Parse(time.RFC3339, ts); err == nil {
			src += "；数据同步于 " + t.In(n9eTZ).Format("2006-01-02 15:04:05")
		}
	}
	data("数据来源", src, "")
	if tplName != "" {
		data("导出模板", tplName, "")
	}
	data("明细列数", fmt.Sprintf("%d 列", len(cols)), "")

	// ---- 一、告警总览 ----
	blank()
	section("一、告警总览")
	data("告警总数", d.Total, "本页统计口径与页面统计卡一致")
	data("  未恢复", unresolved, n9ePct(unresolved, d.Total))
	data("  已恢复", d.Recovered, n9ePct(d.Recovered, d.Total))
	data("涉及主机数", d.HostCount, "")
	data("涉及告警规则数", d.RuleCount, "")

	// ---- 二、告警级别分布 ----
	blank()
	section("二、告警级别分布")
	head("级别", "条数", "占比")
	if len(d.BySeverity) == 0 {
		data("（无数据）", "", "")
	}
	for _, it := range d.BySeverity {
		n, _ := strconv.Atoi(it.Key)
		data(n9eSeverityLabel(n), it.Value, n9ePct(it.Value, d.Total))
	}

	// ---- 三、监控类型分布 ----
	blank()
	section("三、监控类型分布")
	head("监控类型", "条数", "占比")
	if len(d.ByProd) == 0 {
		data("（无数据）", "", "")
	}
	for _, it := range d.ByProd {
		label := it.Key
		if label != "(未标注)" {
			label = n9eRuleProdLabel(label)
		}
		data(label, it.Value, n9ePct(it.Value, d.Total))
	}

	// ---- 四~七、四张 TOP10 榜 ----
	blank()
	section("四、业务组 TOP10")
	head("业务组", "条数", "占比")
	if len(d.ByGroup) == 0 {
		data("（无数据）", "", "")
	}
	rank(d.ByGroup)

	blank()
	section("五、数据源 TOP10")
	head("数据源", "条数", "占比")
	if len(d.ByDatasrc) == 0 {
		data("（无数据）", "", "")
	}
	rank(d.ByDatasrc)

	blank()
	section("六、告警规则 TOP10")
	head("规则名称", "条数", "占比")
	if len(d.ByRule) == 0 {
		data("（无数据）", "", "")
	}
	rank(d.ByRule)

	blank()
	section("七、归属部门 TOP10")
	head("归属部门", "条数", "占比")
	if len(d.ByDept) == 0 {
		data("（无数据）", "", "")
	}
	rank(d.ByDept)

	// ---- 八、按天趋势 ----
	blank()
	section("八、按天趋势")
	head("日期", "告警条数", "占比")
	if len(d.ByDay) == 0 {
		data("（无数据）", "", "")
	}
	for _, it := range d.ByDay {
		data(it.Key, it.Value, n9ePct(it.Value, d.Total))
	}

	// ---- 九、Sheet 说明 ----
	blank()
	section("九、本报告 Sheet 说明")
	data("概览", "本页：报告范围 / 筛选条件 / 汇总统计", "")
	data("告警明细", fmt.Sprintf("每行 = 一条告警记录（共 %d 列，列顺序见表头）", len(cols)), "")

	// ---- 落盘 ----
	styleTitle, err := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true, Size: 14}})
	if err != nil {
		return err
	}
	styleSection, err := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true, Size: 11}})
	if err != nil {
		return err
	}
	styleHead, err := f.NewStyle(&excelize.Style{
		Font: &excelize.Font{Bold: true},
		Fill: excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{"F2F2F2"}},
	})
	if err != nil {
		return err
	}

	_ = f.SetColWidth(sheet, "A", "A", 34)
	_ = f.SetColWidth(sheet, "B", "B", 56)
	_ = f.SetColWidth(sheet, "C", "C", 12)

	for i, r := range rows {
		line := i + 1
		aCell, _ := excelize.CoordinatesToCellName(1, line)
		bCell, _ := excelize.CoordinatesToCellName(2, line)
		cCell, _ := excelize.CoordinatesToCellName(3, line)
		_ = f.SetCellValue(sheet, aCell, r.A)
		if r.B != nil {
			_ = f.SetCellValue(sheet, bCell, r.B)
		}
		if r.C != "" {
			_ = f.SetCellValue(sheet, cCell, r.C)
		}
		switch r.Kind {
		case n9eOvTitle:
			_ = f.SetCellStyle(sheet, aCell, cCell, styleTitle)
		case n9eOvSection:
			_ = f.SetCellStyle(sheet, aCell, cCell, styleSection)
		case n9eOvHead:
			_ = f.SetCellStyle(sheet, aCell, cCell, styleHead)
		}
	}
	// 标题行横跨三列，看起来更像一张报表
	_ = f.MergeCell(sheet, "A1", "C1")
	return nil
}
