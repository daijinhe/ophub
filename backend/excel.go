package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/xuri/excelize/v2"
)

// cellToStr 将单元格值转为字符串（统一存储格式）
func cellToStr(v interface{}) string {
	if v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%v", t)
	case bool:
		return fmt.Sprintf("%t", t)
	default:
		return fmt.Sprintf("%v", t)
	}
}

// normalizeHeaderLabel 把模板表头的别名统一为字段 Label。
// 兼容不同版本模板的写法：系统盘 / 内存(GB) 等的半角括号 / 空格写法 -> 全角标准写法。
func normalizeHeaderLabel(h string) string {
	switch h {
	case "系统盘", "系统盘 (GB)", "系统盘(GB)":
		return "系统盘（GB）"
	case "内存(GB)":
		return "内存（GB）"
	case "项目规划资源使用量 - 内存(GB)":
		return "项目规划资源使用量 - 内存（GB）"
	case "已申请资源使用量 - 内存(GB)":
		return "已申请资源使用量 - 内存（GB）"
	case "本次申请总量 - 内存(GB)":
		return "本次申请总量 - 内存（GB）"
	}
	return h
}

// res08Keys 收集「资源申请信息」(08) 分组的字段 key。
// 第二个 sheet（资源下发信息）只导入这些字段，且只导入系统当前已存在的字段。
func res08Keys() map[string]bool {
	m := map[string]bool{}
	for _, def := range FieldDefs {
		if def.Group == "资源申请信息" {
			m[def.Key] = true
		}
		for _, g := range def.Groups {
			if g == "资源申请信息" {
				m[def.Key] = true
				break
			}
		}
	}
	return m
}

// buildKeyOf 根据表头生成「列下标 -> 字段 key」的映射。
// allowKeys 用于限定集合（nil 表示所有系统字段；非 nil 表示仅允许列表内的 key）。
// 说明文字列 / 无法识别的列 -> keyOf[i] = ""（在数据行写入时被跳过）。
func buildKeyOf(header []string, allowKeys map[string]bool) []string {
	keyOf := make([]string, len(header))
	used := map[string]int{}
	for i, h := range header {
		if h == "" || strings.Contains(h, "后面信息需要自行填写") ||
			strings.Contains(h, "下发的资源表清单") || strings.Contains(h, "自行统计填写") {
			keyOf[i] = ""
			continue
		}
		h = normalizeHeaderLabel(h)
		var cands []string
		for _, def := range FieldDefs {
			if def.Label == h {
				cands = append(cands, def.Key)
			}
		}
		if allowKeys != nil {
			kept := make([]string, 0, len(cands))
			for _, k := range cands {
				if allowKeys[k] {
					kept = append(kept, k)
				}
			}
			cands = kept
		}
		idx := used[h]
		if idx < len(cands) {
			keyOf[i] = cands[idx]
			used[h]++
		} else {
			keyOf[i] = ""
		}
	}
	return keyOf
}

// collectSheet1Merges 读取第二个 sheet（资源下发信息），按数据行下标 0..N-1 收集
// 「08 资源申请信息」分组的字段映射。下标与 sheet0 数据行一一对应（1:1），
// 即使该行所有 08 字段都为空也保留下标，保证位置严格对齐。
func collectSheet1Merges(f *excelize.File, sheetName string, allowKeys map[string]bool) map[int]map[string]string {
	out := map[int]map[string]string{}
	rows, err := f.GetRows(sheetName)
	if err != nil || len(rows) < 2 {
		return out
	}
	header := rows[0]
	keyOf := buildKeyOf(header, allowKeys)
	for i, row := range rows[1:] {
		fields := map[string]string{}
		for j := range header {
			if j >= len(row) {
				continue
			}
			k := keyOf[j]
			if k == "" {
				continue
			}
			v := cellToStr(row[j])
			// 重复表头空值不覆盖
			if prev, ok := fields[k]; ok && prev != "" && v == "" {
				continue
			}
			fields[k] = v
		}
		// 保留所有数据行下标（含空行），保证与 sheet0 第 i 行严格对齐
		out[i] = fields
	}
	return out
}

// importFromExcel 解析 Excel 模板并写入资产。
// 模板含两个 sheet：
//   - 录入信息（sheet0）：主资产字段全量 upsert（沿用旧版匹配逻辑，保证与历史导入行为一致）。
//   - 资源下发信息（sheet1）：仅「资源申请信息(08)」分组字段；按数据行下标与 sheet0
//     一一对应合并到 sheet0 已 upsert 的资产（不依赖 IP/名称匹配）。
func importFromExcel(path string, categoryID uint, createdBy uint) (int, error) {
	f, err := excelize.OpenFile(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return 0, fmt.Errorf("文件无工作表")
	}
	var s1Merges map[int]map[string]string
	if len(sheets) >= 2 {
		s1Merges = collectSheet1Merges(f, sheets[1], res08Keys())
	} else {
		s1Merges = map[int]map[string]string{}
	}
	n := importSheet(f, sheets[0], categoryID, createdBy, s1Merges)
	log.Printf("[import] sheet0(录入信息) processed=%d sheet1(资源下发信息) rows=%d category=%d", n, len(s1Merges), categoryID)
	return n, nil
}

// importSheet 解析 sheet0（录入信息）并写入资产，每条非空数据行：
//  1. 沿用旧版 upsert 匹配（upsertKey=ip 否则 name，查询 ip=? OR (ip=” AND name=?)），新建或更新资产；
//  2. 若 s1Merges 在同下标有 08 分组字段，则合并到该资产 Fields（严格按数据行下标 1:1 对应）。
func importSheet(f *excelize.File, sheet string, categoryID uint, createdBy uint, s1Merges map[int]map[string]string) int {
	rows, err := f.GetRows(sheet)
	if err != nil || len(rows) < 2 {
		return 0
	}
	header := rows[0]
	keyOf := buildKeyOf(header, nil)
	count := 0
	for i, row := range rows[1:] {
		fields := map[string]interface{}{}
		for j := range header {
			if j >= len(row) {
				continue
			}
			k := keyOf[j]
			if k == "" {
				continue
			}
			v := cellToStr(row[j])
			// 重复表头空值不覆盖
			if prev, ok := fields[k].(string); ok && prev != "" && v == "" {
				continue
			}
			fields[k] = v
		}
		// 跳过全空行（模板中可能带大量空行）
		allEmpty := true
		for _, v := range fields {
			if s, ok := v.(string); ok && s != "" {
				allEmpty = false
				break
			}
		}
		if allEmpty {
			continue
		}
		ip := cellToStr(fields["虚拟机IPv4"])
		name := cellToStr(fields["应用系统名称"])
		if name == "" {
			name = cellToStr(fields["虚拟机名称"])
		}
		// 沿用旧版 upsert 匹配
		upsertKey := ip
		if upsertKey == "" {
			upsertKey = name
		}
		if upsertKey == "" {
			continue
		}
		var existing Asset
		found := false
		res := DB.Where("category_id = ? AND (ip = ? OR (ip = '' AND name = ?))", categoryID, upsertKey, upsertKey).First(&existing)
		if res.Error == nil && existing.ID != 0 {
			found = true
		}
		if !found {
			existing = Asset{CategoryID: categoryID, Name: name, IP: ip, Fields: toJSON(fields), CreatedBy: createdBy}
			DB.Create(&existing)
		} else {
			existing.Fields = toJSON(fields)
			existing.IP = ip
			existing.Name = name
			DB.Save(&existing)
		}
		// 合并 sheet1 的 08 资源申请信息字段（按数据行下标 1:1 对应 sheet0 本行）
		if s1 := s1Merges[i]; len(s1) > 0 {
			var cur map[string]interface{}
			_ = json.Unmarshal(existing.Fields, &cur)
			if cur == nil {
				cur = map[string]interface{}{}
			}
			for k, v := range s1 {
				cur[k] = v
			}
			existing.Fields = toJSON(cur)
			DB.Save(&existing)
		}
		count++
	}
	return count
}

// exportToExcel 将资产列表导出为 Excel（表头为模板字段）
func exportToExcel(assets []Asset) (*bytes.Buffer, error) {
	f := excelize.NewFile()
	sheet := "CMDB资产"
	f.SetSheetName("Sheet1", sheet)
	// 隐藏字段（如 用户名/密码）不参与导出：与前端列表/详情「不展示」保持一致。
	cols := make([]FieldDef, 0, len(FieldDefs))
	for _, def := range FieldDefs {
		if def.Hidden {
			continue
		}
		cols = append(cols, def)
	}
	for i, def := range cols {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		f.SetCellValue(sheet, cell, def.Label)
	}
	// 末尾追加一列「中间件」：来自「中间件捕捉」结果，与资源列表新增的那一列同口径
	// （捕捉是只读快照、不是 CMDB 登记字段，所以不进入 FieldDefs，单独补列）
	mwCol := len(cols) + 1
	if cell, err := excelize.CoordinatesToCellName(mwCol, 1); err == nil {
		f.SetCellValue(sheet, cell, "中间件")
	}
	for r, a := range assets {
		row := r + 2
		var m map[string]interface{}
		if len(a.Fields) > 0 {
			_ = json.Unmarshal(a.Fields, &m)
		}
		for i, def := range cols {
			cell, _ := excelize.CoordinatesToCellName(i+1, row)
			val := ""
			if m != nil {
				if v, ok := m[def.Key]; ok && v != nil {
					val = fmt.Sprintf("%v", v)
				}
			}
			f.SetCellValue(sheet, cell, val)
		}
		if cell, err := excelize.CoordinatesToCellName(mwCol, row); err == nil {
			f.SetCellValue(sheet, cell, mwTypeLabels(a.MwTypes))
		}
	}
	return f.WriteToBuffer()
}
