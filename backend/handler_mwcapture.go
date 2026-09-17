package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xuri/excelize/v2"
)

// ============================================================================
// 中间件捕捉 —— HTTP 接口
//
// 路由（见 main.go）：
//   GET    /api/mwcapture/assets          资产列表（带捕捉摘要，供页面左栏）
//   POST   /api/mwcapture/run             批量捕捉（并发执行 + 落库 upsert）
//   GET    /api/mwcapture/asset/:id       单资产捕捉结果（?raw=1 带原始输出）
//   DELETE /api/mwcapture/asset/:id       清除某资产的捕捉结果
//   GET    /api/mwcapture/export          导出捕捉结果 Excel
// ============================================================================

// mwCaptureConcurrency 批量捕捉并发度。
// 每台机器一次 SSH + 一段带 find/ss/java -version 的探测脚本，
// 并发太高会把控制机与目标机同时压满，4 是实测比较稳的值。
const mwCaptureConcurrency = 4

// mwAssetCaptureBrief 资产列表里的捕捉摘要
type mwAssetCaptureBrief struct {
	Status     string   `json:"status"`
	MwTypes    []string `json:"mwTypes"`
	CapturedAt string   `json:"capturedAt"`
	Privileged bool     `json:"privileged"`
	Error      string   `json:"error"`
	Count      int      `json:"count"`
}

// mwCaptureSummaryMap 批量取资产的捕捉摘要
func mwCaptureSummaryMap(ids []uint) map[uint]*mwAssetCaptureBrief {
	out := map[uint]*mwAssetCaptureBrief{}
	if len(ids) == 0 {
		return out
	}
	var rows []MwCapture
	DB.Where("asset_id IN ?", ids).Find(&rows)
	for i := range rows {
		r := rows[i]
		out[r.AssetID] = &mwAssetCaptureBrief{
			Status:     r.Status,
			MwTypes:    r.TypeList(),
			CapturedAt: r.CapturedAt.Format("2006-01-02 15:04:05"),
			Privileged: r.Privileged,
			Error:      r.Error,
			Count:      len(r.ItemList()),
		}
	}
	return out
}

// ListMwCaptureAssets 可捕捉的资产列表 + 已有捕捉摘要
// GET /api/mwcapture/assets?keyword=&zone=
func ListMwCaptureAssets(c *gin.Context) {
	var assets []Asset
	DB.Order("id desc").Find(&assets)

	kw := strings.ToLower(strings.TrimSpace(c.Query("keyword")))
	zone := strings.TrimSpace(c.Query("zone"))
	ids := make([]uint, 0, len(assets))
	for i := range assets {
		ids = append(ids, assets[i].ID)
	}
	sum := mwCaptureSummaryMap(ids)

	list := make([]gin.H, 0, len(assets))
	for i := range assets {
		a := assets[i]
		f := assetFieldsMap(&a)
		aZone := toStr(f["所属网络区域"])
		if zone != "" && aZone != zone {
			continue
		}
		if kw != "" {
			hay := strings.ToLower(strings.Join([]string{
				AssetDisplayName(&a), a.Name, a.IP,
				toStr(f["虚拟机IPv4"]), toStr(f["虚拟机名称"]), toStr(f["应用系统名称"]),
			}, " "))
			if !strings.Contains(hay, kw) {
				continue
			}
		}
		item := gin.H{
			"assetId":   a.ID,
			"assetName": AssetDisplayName(&a),
			"vmName":    AssetVMName(&a),
			"ip":        a.IP,
			"zone":      aZone,
			"ready":     true,
		}
		if t, err := crontabSSHInfo(&a); err == nil {
			item["sshHost"] = t.IP
			item["sshUser"] = t.SSHUser
			item["runUser"] = t.RunUser
		} else {
			item["ready"] = false
			item["reason"] = err.Error()
		}
		if b, ok := sum[a.ID]; ok {
			item["capture"] = b
		}
		list = append(list, item)
	}
	OK(c, gin.H{"list": list, "total": len(list)})
}

// mwCaptureRunReq 批量捕捉请求
type mwCaptureRunReq struct {
	AssetIDs []uint `json:"assetIds"`
	Keyword  string `json:"keyword"`
	Zone     string `json:"zone"`
}

// RunMwCapture 批量捕捉中间件信息
// POST /api/mwcapture/run
func RunMwCapture(c *gin.Context) {
	var req mwCaptureRunReq
	_ = c.ShouldBindJSON(&req)
	if len(req.AssetIDs) == 0 {
		Fail(c, http.StatusBadRequest, 400, "请先选择要捕捉的资产")
		return
	}
	if len(req.AssetIDs) > 200 {
		Fail(c, http.StatusBadRequest, 400, "单次最多捕捉 200 台资产")
		return
	}
	operator := ""
	if v, exists := c.Get(ctxUser); exists {
		operator = fmt.Sprint(v)
	}

	var assets []Asset
	DB.Where("id IN ?", req.AssetIDs).Find(&assets)
	// 保持与前端勾选顺序一致（按 id 升序稳定输出）
	sort.Slice(assets, func(i, j int) bool { return assets[i].ID < assets[j].ID })

	type runItem struct {
		AssetID    uint     `json:"assetId"`
		AssetName  string   `json:"assetName"`
		Status     string   `json:"status"`
		MwTypes    []string `json:"mwTypes"`
		Error      string   `json:"error"`
		DurationMs int64    `json:"durationMs"`
	}
	results := make([]runItem, len(assets))
	sem := make(chan struct{}, mwCaptureConcurrency)
	var wg sync.WaitGroup
	for i := range assets {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			a := assets[i]
			rec := mwCaptureAsset(&a, operator)
			saveMwCapture(rec)
			results[i] = runItem{
				AssetID:    rec.AssetID,
				AssetName:  rec.AssetName,
				Status:     rec.Status,
				MwTypes:    rec.TypeList(),
				Error:      rec.Error,
				DurationMs: rec.DurationMs,
			}
		}(i)
	}
	wg.Wait()

	okCnt, noneCnt, errCnt, mwTot := 0, 0, 0, 0
	for _, r := range results {
		switch r.Status {
		case MwCaptureStatusFailed:
			errCnt++
		case MwCaptureStatusNone:
			noneCnt++
		default:
			okCnt++
		}
		mwTot += len(r.MwTypes)
	}
	OK(c, gin.H{
		"list":            results,
		"scanned":         len(results),
		"okCount":         okCnt,
		"noneCount":       noneCnt,
		"errorCount":      errCnt,
		"middlewareTotal": mwTot,
		"capturedAt":      time.Now().Format("2006-01-02 15:04:05"),
	})
}

// saveMwCapture 落库（同资产覆盖，幂等）。
//
// 合并策略：重新捕捉只刷新「本次扫描命中的类型」条目，保留两类不被覆盖——
//  1. 用户在详情里手工添加的其他类型（如 mysql，扫描器不扫）
//  2. 用户自定义字段（CustomFields）
//
// 这样「捕捉 + 手工补充」可以共存，重跑捕捉不会把手工填的内容洗掉。
//
// 失败保护：当 rec.Status == Failed 时本次扫描结果不可信，**不再 merge**，
// 直接用 rec 的当前 items（解析失败的空数组）覆盖 — 否则用户会在 UI 上看
// 到上次成功跑出的旧 items 与本次「failed」状态共存的奇怪组合（典型的
// sshd 拒收长 cmd / sudo 密码错误场景）。这样下次重捕成功时，扫描结果会
// 正常 merge 上 CustomFields。
func saveMwCapture(rec *MwCapture) {
	var cur MwCapture
	if err := DB.Where("asset_id = ?", rec.AssetID).First(&cur).Error; err == nil {
		if rec.Status == MwCaptureStatusFailed {
			// 失败时不再 merge 旧 items — 否则会暴露与当前失败状态不符的旧数据
			rec.Items = "[]"
			rec.MwTypes = ""
			rec.CustomFields = cur.CustomFieldList()
			if b, err := json.Marshal(rec.CustomFields); err == nil {
				rec.CustomFieldsJSON = string(b)
			}
			rec.ID = cur.ID
			rec.CreatedAt = cur.CreatedAt
			// 注意：失败时不再 Save 整条（会覆盖 status/error 等关键字段之外的 detail），
			// 只更新「本次失败信号 + 清空扫描态 items」三个字段，保留旧的 CustomFields/CustomFieldsJSON。
			DB.Model(&MwCapture{}).Where("id = ?", cur.ID).Updates(map[string]interface{}{
				"status":             rec.Status,
				"mw_types":           rec.MwTypes,
				"items":              rec.Items,
				"custom_fields_json": rec.CustomFieldsJSON,
				"error":              rec.Error,
				"privileged":         rec.Privileged,
				"captured_at":        rec.CapturedAt,
				"captured_by":        rec.CapturedBy,
				"duration_ms":        rec.DurationMs,
			})
			return
		}
		scanItems := rec.ItemList()
		// 「手工填的代码业务(biz)」按 type+codePath/jar 维度从老 items 回填到本次扫描结果，
		// 否则用户手填的 biz 会被脚本输出整条覆盖（业务名不会自动采集，只在重捕后保留）。
		scanItems = mergeHandBiz(scanItems, cur.ItemList())
		scanTypes := map[string]bool{}
		for _, it := range scanItems {
			scanTypes[it.Type] = true
		}
		kept := []MwCaptureItem{}
		for _, it := range cur.ItemList() {
			if !scanTypes[it.Type] {
				kept = append(kept, it)
			}
		}
		merged := append(kept, scanItems...)
		if b, err := json.Marshal(merged); err == nil {
			rec.Items = string(b)
		}
		types := make([]string, 0, len(merged))
		for _, it := range merged {
			types = append(types, it.Type)
		}
		rec.MwTypes = strings.Join(types, ",")
		rec.CustomFields = cur.CustomFieldList()
		if b, err := json.Marshal(rec.CustomFields); err == nil {
			rec.CustomFieldsJSON = string(b)
		}
		rec.ID = cur.ID
		rec.CreatedAt = cur.CreatedAt
		if err := DB.Save(rec).Error; err != nil {
			// 覆盖失败时退回更新关键字段，避免整条记录丢失
			DB.Model(&MwCapture{}).Where("id = ?", cur.ID).Updates(map[string]interface{}{
				"status": rec.Status, "mw_types": rec.MwTypes, "items": rec.Items,
				"custom_fields_json": rec.CustomFieldsJSON, "error": rec.Error, "privileged": rec.Privileged,
				"captured_at": rec.CapturedAt, "captured_by": rec.CapturedBy, "duration_ms": rec.DurationMs,
			})
		}
		return
	}
	if b, err := json.Marshal(rec.CustomFields); err == nil {
		rec.CustomFieldsJSON = string(b)
	}
	if err := DB.Create(rec).Error; err != nil {
		fmt.Printf("中间件捕捉落库失败 asset=%d: %v\n", rec.AssetID, err)
	}
}

// GetMwCapture 单资产的捕捉结果
// GET /api/mwcapture/asset/:id[?raw=1]
func GetMwCapture(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		Fail(c, http.StatusBadRequest, 400, "资产 ID 不合法")
		return
	}
	var rec MwCapture
	if err := DB.Where("asset_id = ?", id).First(&rec).Error; err != nil {
		OK(c, gin.H{"assetId": id, "exists": false})
		return
	}
	resp := gin.H{
		"assetId":      rec.AssetID,
		"exists":       true,
		"status":       rec.Status,
		"mwTypes":      rec.TypeList(),
		"items":        rec.ItemList(),
		"customFields": rec.CustomFieldList(),
		"error":        rec.Error,
		"privileged":   rec.Privileged,
		"durationMs":   rec.DurationMs,
		"capturedAt":   rec.CapturedAt.Format("2006-01-02 15:04:05"),
		"capturedBy":   rec.CapturedBy,
		"host":         rec.Host,
		"zone":         rec.Zone,
	}
	if c.Query("raw") == "1" {
		resp["raw"] = rec.Raw
	}
	OK(c, resp)
}

// mwCaptureUpdateReq 详情里手工修改 / 补充中间件信息
type mwCaptureUpdateReq struct {
	Items        []MwCaptureItem `json:"items"`
	CustomFields []MwKv          `json:"customFields"`
}

// UpdateMwCapture 在资产详情里保存手工修改 / 补充的中间件信息（含自定义字段）
// PUT /api/mwcapture/asset/:id
func UpdateMwCapture(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		Fail(c, http.StatusBadRequest, 400, "资产 ID 不合法")
		return
	}
	var req mwCaptureUpdateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "请求体格式错误")
		return
	}
	bItems, err := json.Marshal(req.Items)
	if err != nil {
		Fail(c, http.StatusBadRequest, 400, "条目序列化失败")
		return
	}
	bCustom, err := json.Marshal(req.CustomFields)
	if err != nil {
		Fail(c, http.StatusBadRequest, 400, "自定义字段序列化失败")
		return
	}
	types := make([]string, 0, len(req.Items))
	for _, it := range req.Items {
		if it.Type != "" {
			types = append(types, it.Type)
		}
	}

	var rec MwCapture
	now := time.Now()
	if err := DB.Where("asset_id = ?", id).First(&rec).Error; err == nil {
		status := MwCaptureStatusNone
		if len(req.Items) > 0 {
			status = MwCaptureStatusOK
		}
		if err := DB.Model(&MwCapture{}).Where("id = ?", rec.ID).Updates(map[string]interface{}{
			"status":             status,
			"mw_types":           strings.Join(types, ","),
			"items":              string(bItems),
			"custom_fields_json": string(bCustom),
			"captured_at":        now,
		}).Error; err != nil {
			Fail(c, http.StatusInternalServerError, 500, "保存失败："+err.Error())
			return
		}
		OK(c, gin.H{"assetId": id, "updated": true})
		return
	}
	// 尚无捕捉记录：以手工内容新建一条
	newRec := &MwCapture{
		AssetID:          uint(id),
		Status:           MwCaptureStatusNone,
		MwTypes:          strings.Join(types, ","),
		Items:            string(bItems),
		CustomFieldsJSON: string(bCustom),
		CapturedAt:       now,
		CapturedBy:       "",
	}
	if len(req.Items) > 0 {
		newRec.Status = MwCaptureStatusOK
	}
	operator := ""
	if v, exists := c.Get(ctxUser); exists {
		operator = fmt.Sprint(v)
	}
	newRec.CapturedBy = operator
	if err := DB.Create(newRec).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败："+err.Error())
		return
	}
	OK(c, gin.H{"assetId": id, "created": true})
}

// DeleteMwCapture 清除某资产的捕捉结果
// DELETE /api/mwcapture/asset/:id
func DeleteMwCapture(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		Fail(c, http.StatusBadRequest, 400, "资产 ID 不合法")
		return
	}
	if err := DB.Where("asset_id = ?", id).Delete(&MwCapture{}).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "清除捕捉结果失败")
		return
	}
	OK(c, gin.H{"assetId": id})
}

// mwCaptureRow 导出用的扁平行（一个资产 × 一个中间件 = 一行）
type mwCaptureRow struct {
	AssetName string
	Host      string
	Zone      string
	MwLabel   string
	Running   string
	Version   string
	Ports     string
	Install   string
	Config    string
	Logs      string
	Code      string
	Certs     string
	Jar       string
	Command   string
	Storage   string
	Notes     string
	Captured  string
}

func mwCaptureRows(recs []MwCapture) []mwCaptureRow {
	rows := []mwCaptureRow{}
	for i := range recs {
		rec := recs[i]
		when := rec.CapturedAt.Format("2006-01-02 15:04:05")
		items := rec.ItemList()
		if len(items) == 0 {
			rows = append(rows, mwCaptureRow{
				AssetName: rec.AssetName, Host: rec.Host, Zone: rec.Zone,
				MwLabel: "（未捕捉到中间件）", Notes: rec.Error, Captured: when,
			})
			continue
		}
		for _, it := range items {
			run := "未运行"
			if it.Running {
				run = "运行中"
			}
			var install, certs, jar, cmd, storage string
			install = it.InstallPath
			certs = strings.Join(it.Certs, "\n")
			storage = mwKvLines(it.Storage)
			if len(it.Jars) > 0 {
				names, cmds := []string{}, []string{}
				for _, j := range it.Jars {
					names = append(names, j.Name)
					if strings.TrimSpace(j.Command) != "" {
						cmds = append(cmds, fmt.Sprintf("pid %d：%s", j.Pid, j.Command))
					}
				}
				jar = strings.Join(names, "\n")
				cmd = strings.Join(cmds, "\n")
			}
			rows = append(rows, mwCaptureRow{
				AssetName: rec.AssetName,
				Host:      rec.Host,
				Zone:      rec.Zone,
				MwLabel:   it.Label,
				Running:   run,
				Version:   it.Version,
				Ports:     strings.Join(it.Ports, ","),
				Install:   install,
				Config:    strings.Join(it.ConfigPaths, "\n"),
				Logs:      strings.Join(it.LogPaths, "\n"),
				Code:      mwCodePathLines(it.CodePaths),
				Certs:     certs,
				Jar:       jar,
				Command:   cmd,
				Storage:   storage,
				Notes:     strings.Join(it.Notes, "；"),
				Captured:  when,
			})
		}
	}
	return rows
}

func mwKvLines(kvs []MwKv) string {
	out := []string{}
	for _, kv := range kvs {
		out = append(out, kv.Key+"："+kv.Value)
	}
	return strings.Join(out, "\n")
}

func mwCodePathLines(cps []MwCodePath) string {
	out := []string{}
	for _, cp := range cps {
		if cp.Port == "" {
			out = append(out, cp.Path)
			continue
		}
		out = append(out, cp.Port+" → "+cp.Path)
	}
	return strings.Join(out, "\n")
}

// ExportMwCaptures 导出捕捉结果 Excel
// GET /api/mwcapture/export?ids=1,2,3
func ExportMwCaptures(c *gin.Context) {
	q := DB.Model(&MwCapture{})
	if raw := strings.TrimSpace(c.Query("ids")); raw != "" {
		ids := []uint{}
		for _, s := range strings.Split(raw, ",") {
			if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && n > 0 {
				ids = append(ids, uint(n))
			}
		}
		if len(ids) > 0 {
			q = q.Where("asset_id IN ?", ids)
		}
	}
	var recs []MwCapture
	q.Find(&recs)
	sort.Slice(recs, func(i, j int) bool { return recs[i].AssetID < recs[j].AssetID })

	rows := mwCaptureRows(recs)
	headers := []string{"资产名称", "虚拟机IPv4", "网络区域", "中间件", "运行状态", "版本号",
		"端口", "安装位置", "配置文件位置", "日志路径", "代码路径", "证书路径",
		"JAR包名", "启动命令", "存储位置", "备注", "捕捉时间"}
	f := excelize.NewFile()
	sheet := "中间件捕捉"
	f.SetSheetName("Sheet1", sheet)
	for i, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		_ = f.SetCellValue(sheet, cell, h)
	}
	for r, row := range rows {
		vals := []string{row.AssetName, row.Host, row.Zone, row.MwLabel, row.Running,
			row.Version, row.Ports, row.Install, row.Config, row.Logs, row.Code,
			row.Certs, row.Jar, row.Command, row.Storage, row.Notes, row.Captured}
		for i, v := range vals {
			cell, _ := excelize.CoordinatesToCellName(i+1, r+2)
			_ = f.SetCellValue(sheet, cell, v)
		}
	}
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		Fail(c, http.StatusInternalServerError, 500, "导出失败："+err.Error())
		return
	}
	filename := fmt.Sprintf("mw_capture_%s.xlsx", time.Now().Format("20060102_150405"))
	c.Header("Content-Disposition", "attachment; filename="+filename)
	c.Header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buf.Bytes())
}

// assetFieldsMap 取资产 fields 的 map 形式
func assetFieldsMap(a *Asset) map[string]interface{} {
	m := map[string]interface{}{}
	if a != nil && len(a.Fields) > 0 {
		_ = json.Unmarshal(a.Fields, &m)
		_ = decryptAssetFields(m)
	}
	return m
}

// attachMwCaptureBrief 给一批资产填上中间件捕捉摘要（列表「中间件」列用）
func attachMwCaptureBrief(assets []Asset) {
	ids := make([]uint, 0, len(assets))
	for i := range assets {
		ids = append(ids, assets[i].ID)
	}
	sum := mwCaptureSummaryMap(ids)
	for i := range assets {
		if b, ok := sum[assets[i].ID]; ok {
			assets[i].MwStatus = b.Status
			assets[i].MwCapturedAt = b.CapturedAt
			if len(b.MwTypes) > 0 {
				assets[i].MwTypes = strings.Join(b.MwTypes, ",")
			}
		}
	}
}
