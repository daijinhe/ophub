package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// failWithData 失败返回但带上执行详情（命令 + 输出），便于页面直接展示远端报错
func failWithData(c *gin.Context, httpStatus, code int, msg string, data interface{}) {
	c.JSON(httpStatus, Resp{Code: code, Msg: msg, Data: data})
}

// ============================================================================
// 中间件管控 HTTP 接口
//
// 页面「中间件运维 → 中间件管控」：
//   - 实例列表（按类型 / 状态 / 关键字筛选）+ 统计
//   - 从「部署执行记录」一键同步实例
//   - 单台 / 批量检测（进程是否存活、systemd 状态、监听端口）
//   - 启停 / 重启 / 重载；按 PID 结束进程
//   - 配置文件在线查看 / 编辑 / 校验 / 回滚
// ============================================================================

const mwOpsBatchConcurrency = 6

// ---------------- 类型档案 ----------------

// ListMwOpsProfiles 类型能力档案列表（含各类实例数）
// GET /api/mwops/profiles
func ListMwOpsProfiles(c *gin.Context) {
	var rows []MwOpsProfile
	if err := DB.Order("id asc").Find(&rows).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "读取类型档案失败")
		return
	}
	type cnt struct {
		MwType string
		N      int
	}
	var counts []cnt
	DB.Model(&MwInstance{}).Select("mw_type, count(*) as n").Group("mw_type").Scan(&counts)
	cm := map[string]int{}
	for _, x := range counts {
		cm[x.MwType] = x.N
	}
	list := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		list = append(list, gin.H{
			"type": r.Type, "label": r.Label, "icon": r.Icon, "category": r.Category,
			"processPattern": r.ProcessPattern, "units": r.UnitList(),
			"defaultPaths": r.PathList(), "defaultPort": r.DefaultPort,
			"configPaths": r.ConfigPathList(), "configTestCmd": r.ConfigTestCmd,
			"versionCmd": r.VersionCmd,
			"cmdStart":   r.CmdStart, "cmdStop": r.CmdStop, "cmdRestart": r.CmdRestart, "cmdReload": r.CmdReload,
			"processOnly": r.ProcessOnly, "desc": r.Desc, "enabled": r.Enabled,
			"instanceCount": cm[r.Type],
		})
	}
	OK(c, gin.H{"list": list})
}

// UpdateMwOpsProfile 修改类型能力档案（现场路径 / 单元名 / 命令模板不一致时按环境调整）
// PUT /api/mwops/profiles/:type
func UpdateMwOpsProfile(c *gin.Context) {
	t := mwOpsTypeAlias(c.Param("type"))
	var p MwOpsProfile
	if err := DB.Where("type = ?", t).First(&p).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "类型档案不存在："+t)
		return
	}
	var req struct {
		Label          *string   `json:"label"`
		ProcessPattern *string   `json:"processPattern"`
		Units          *[]string `json:"units"`
		DefaultPaths   *[]string `json:"defaultPaths"`
		DefaultPort    *string   `json:"defaultPort"`
		ConfigPaths    *[]string `json:"configPaths"`
		ConfigTestCmd  *string   `json:"configTestCmd"`
		VersionCmd     *string   `json:"versionCmd"`
		CmdStart       *string   `json:"cmdStart"`
		CmdStop        *string   `json:"cmdStop"`
		CmdRestart     *string   `json:"cmdRestart"`
		CmdReload      *string   `json:"cmdReload"`
		Desc           *string   `json:"desc"`
		Enabled        *bool     `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	if req.Label != nil {
		p.Label = strings.TrimSpace(*req.Label)
	}
	if req.ProcessPattern != nil {
		p.ProcessPattern = strings.TrimSpace(*req.ProcessPattern)
	}
	if req.Units != nil {
		p.Units = strings.Join(*req.Units, ",")
	}
	if req.DefaultPaths != nil {
		p.DefaultPaths = encodeStrList(*req.DefaultPaths)
	}
	if req.DefaultPort != nil {
		p.DefaultPort = strings.TrimSpace(*req.DefaultPort)
	}
	if req.ConfigPaths != nil {
		p.ConfigPaths = encodeStrList(*req.ConfigPaths)
	}
	if req.ConfigTestCmd != nil {
		p.ConfigTestCmd = strings.TrimSpace(*req.ConfigTestCmd)
	}
	if req.VersionCmd != nil {
		p.VersionCmd = strings.TrimSpace(*req.VersionCmd)
	}
	if req.CmdStart != nil {
		p.CmdStart = strings.TrimSpace(*req.CmdStart)
	}
	if req.CmdStop != nil {
		p.CmdStop = strings.TrimSpace(*req.CmdStop)
	}
	if req.CmdRestart != nil {
		p.CmdRestart = strings.TrimSpace(*req.CmdRestart)
	}
	if req.CmdReload != nil {
		p.CmdReload = strings.TrimSpace(*req.CmdReload)
	}
	if req.Desc != nil {
		p.Desc = strings.TrimSpace(*req.Desc)
	}
	if req.Enabled != nil {
		p.Enabled = *req.Enabled
	}
	// 改动后视为「运维自定义」，不再被内置同步覆盖
	p.SeedVer = mwOpsSeedVer + 1
	p.UpdatedAt = time.Now()
	if err := DB.Save(&p).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败")
		return
	}
	OK(c, gin.H{"type": p.Type})
}

// ---------------- 实例 CRUD ----------------

// mwOpsInstanceReq 实例新建/编辑入参
type mwOpsInstanceReq struct {
	MwType         string   `json:"mwType"`
	Version        string   `json:"version"`
	AssetID        uint     `json:"assetId"`
	Host           string   `json:"host"`
	Zone           string   `json:"zone"`
	Port           string   `json:"port"`
	InstallPath    string   `json:"installPath"`
	ProcessPattern string   `json:"processPattern"`
	Unit           string   `json:"unit"`
	CmdStart       string   `json:"cmdStart"`
	CmdStop        string   `json:"cmdStop"`
	CmdRestart     string   `json:"cmdRestart"`
	CmdReload      string   `json:"cmdReload"`
	ConfigPaths    []string `json:"configPaths"`
	SSHPort        string   `json:"sshPort"`
	SSHUser        string   `json:"sshUser"`
	SSHPass        string   `json:"sshPass"`
	AdminUser      string   `json:"adminUser"`
	AdminPass      string   `json:"adminPass"`
	Remark         string   `json:"remark"`
	Enabled        *bool    `json:"enabled"`
}

// mwAssetFields 取资产的 fields 映射
func mwAssetFields(a *Asset) map[string]interface{} {
	fields := map[string]interface{}{}
	if a != nil && len(a.Fields) > 0 {
		_ = json.Unmarshal(a.Fields, &fields)
		_ = decryptAssetFields(fields)
	}
	return fields
}

// applyMwOpsInstanceReq 校验并入参落到实例对象上。creating=true 时校验必填。
//
// 编辑（creating=false）遵循本模块统一的「留空 = 保持原值」口径：
// 未提供 assetId 且未提供 host 时不改动归属；手动归属下留空的连接字段不被清空
// （否则一次只改「单元名」的局部 PUT 会把 SSH 用户名清掉，后续检测直接连不上）。
func applyMwOpsInstanceReq(inst *MwInstance, req *mwOpsInstanceReq, creating bool) error {
	mwType := mwOpsTypeAlias(req.MwType)
	if mwType == "" {
		return fmt.Errorf("请选择中间件类型")
	}
	prof := mwOpsProfileFor(mwType)
	if prof == nil {
		return fmt.Errorf("未知的中间件类型：%s（请先在「类型档案」中登记）", req.MwType)
	}
	inst.MwType = mwType

	switch {
	case req.AssetID > 0:
		var a Asset
		if err := DB.First(&a, req.AssetID).Error; err != nil {
			return fmt.Errorf("所选资产不存在")
		}
		fields := mwAssetFields(&a)
		ip := extractIP(fields)
		if ip == "" {
			return fmt.Errorf("资产「%s」未填写「虚拟机IPv4 / 虚拟机EIP-IPv4」，无法远程连接", AssetDisplayName(&a))
		}
		inst.AssetID = req.AssetID
		inst.AssetName = AssetDisplayName(&a)
		inst.Host = ip
		inst.Zone = toStr(fields["所属网络区域"])
		// 资产实例的 SSH 覆盖字段一律清空，避免与资产字段形成第二套凭据
		inst.SSHPort, inst.SSHUser, inst.SSHPass, inst.AdminUser, inst.AdminPass = "", "", "", "", ""

	case strings.TrimSpace(req.Host) != "":
		inst.AssetID = 0
		inst.AssetName = ""
		inst.Host = strings.TrimSpace(req.Host)
		// 手动归属：留空的连接字段在编辑时保持原值
		if v := strings.TrimSpace(req.Zone); v != "" || creating {
			inst.Zone = v
		}
		if v := strings.TrimSpace(req.SSHPort); v != "" || creating {
			inst.SSHPort = v
		}
		if v := strings.TrimSpace(req.SSHUser); v != "" || creating {
			inst.SSHUser = v
		}
		if v := strings.TrimSpace(req.AdminUser); v != "" || creating {
			inst.AdminUser = v
		}
		if req.SSHPass != "" {
			inst.SSHPass = req.SSHPass
		}
		if req.AdminPass != "" {
			inst.AdminPass = req.AdminPass
		}
		if creating && (inst.SSHUser == "" || inst.SSHPass == "") {
			return fmt.Errorf("手动纳管的实例必须填写 SSH 用户名与密码")
		}

	case creating:
		return fmt.Errorf("请选择资产，或填写目标机 IP")
	}
	// 其余情形（编辑且未提供归属信息）→ 原资产 / 手动归属与连接信息一律保持不变

	inst.Version = strings.TrimSpace(req.Version)
	inst.Port = strings.TrimSpace(req.Port)
	inst.InstallPath = strings.TrimSpace(req.InstallPath)
	inst.ProcessPattern = strings.TrimSpace(req.ProcessPattern)
	inst.Unit = strings.TrimSpace(req.Unit)
	inst.CmdStart = strings.TrimSpace(req.CmdStart)
	inst.CmdStop = strings.TrimSpace(req.CmdStop)
	inst.CmdRestart = strings.TrimSpace(req.CmdRestart)
	inst.CmdReload = strings.TrimSpace(req.CmdReload)
	if len(req.ConfigPaths) > 0 {
		paths := make([]string, 0, len(req.ConfigPaths))
		for _, p := range req.ConfigPaths {
			if p = strings.TrimSpace(p); p != "" {
				paths = append(paths, p)
			}
		}
		inst.ConfigPaths = encodeStrList(paths)
	} else {
		inst.ConfigPaths = ""
	}
	inst.Remark = strings.TrimSpace(req.Remark)
	if req.Enabled != nil {
		inst.Enabled = *req.Enabled
	} else if creating {
		inst.Enabled = true
	}
	// 同主机同类型只允许一个实例（唯一索引兜底，这里给出友好提示）
	q := DB.Model(&MwInstance{}).Where("host = ? AND mw_type = ?", inst.Host, inst.MwType)
	if inst.ID > 0 {
		q = q.Where("id <> ?", inst.ID)
	}
	var dupCount int64
	q.Count(&dupCount)
	if dupCount > 0 {
		return fmt.Errorf("%s 上已存在 %s 实例，请勿重复添加", inst.Host, prof.Label)
	}
	return nil
}

// ListMwOpsInstances 实例列表
// GET /api/mwops/instances?mwType=&status=&keyword=&assetId=
func ListMwOpsInstances(c *gin.Context) {
	q := DB.Model(&MwInstance{})
	if v := strings.TrimSpace(c.Query("mwType")); v != "" {
		q = q.Where("mw_type = ?", mwOpsTypeAlias(v))
	}
	if v := strings.TrimSpace(c.Query("status")); v != "" {
		q = q.Where("status = ?", v)
	}
	if v := strings.TrimSpace(c.Query("assetId")); v != "" {
		if id, err := strconv.Atoi(v); err == nil {
			q = q.Where("asset_id = ?", id)
		}
	}
	if kw := strings.TrimSpace(c.Query("keyword")); kw != "" {
		like := "%" + kw + "%"
		// 资产改名后历史快照搜不到 → 额外纳入「当前展示名命中」的资产
		if ids := assetIDsByDisplayName(kw); len(ids) > 0 {
			q = q.Where("(host LIKE ? OR asset_name LIKE ? OR install_path LIKE ? OR remark LIKE ? OR asset_id IN ?)",
				like, like, like, like, ids)
		} else {
			q = q.Where("(host LIKE ? OR asset_name LIKE ? OR install_path LIKE ? OR remark LIKE ?)",
				like, like, like, like)
		}
	}
	var list []MwInstance
	if err := q.Order("mw_type asc, host asc, id asc").Find(&list).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "查询失败")
		return
	}
	// 展示名以资产当前值为准（库里那份只是纳管时的快照）
	refreshAssetNameSnapshots(len(list),
		func(i int) uint { return list[i].AssetID },
		func(i int, name string) { list[i].AssetName = name },
	)

	stats := gin.H{"total": len(list), "running": 0, "stopped": 0, "unknown": 0, "enabled": 0}
	byType := map[string]int{}
	for _, r := range list {
		switch r.Status {
		case MwOpsRunning:
			stats["running"] = stats["running"].(int) + 1
		case MwOpsStopped:
			stats["stopped"] = stats["stopped"].(int) + 1
		default:
			stats["unknown"] = stats["unknown"].(int) + 1
		}
		if r.Enabled {
			stats["enabled"] = stats["enabled"].(int) + 1
		}
		byType[r.MwType]++
	}
	OK(c, gin.H{"list": list, "stats": stats, "byType": byType})
}

// GetMwOpsInstance 实例详情（仅数据库记录）
func GetMwOpsInstance(c *gin.Context) {
	inst, ok := loadMwOpsInstance(c)
	if !ok {
		return
	}
	OK(c, inst)
}

// CreateMwOpsInstance 新增实例
// POST /api/mwops/instances
func CreateMwOpsInstance(c *gin.Context) {
	var req mwOpsInstanceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	inst := MwInstance{Source: MwOpsSourceManual, CreatedBy: currentUserID(c)}
	if err := applyMwOpsInstanceReq(&inst, &req, true); err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	inst.CreatedAt = time.Now()
	inst.UpdatedAt = time.Now()
	if err := DB.Create(&inst).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "创建失败："+err.Error())
		return
	}
	OK(c, inst)
}

// UpdateMwOpsInstance 编辑实例
// PUT /api/mwops/instances/:id
//
// 入参语义（两类字段不同，别混）：
//   - 归属与连接：可省略。不传 assetId 也不传 host → 归属与连接信息**原样保留**；
//     传了 host 时，留空的 zone / sshPort / sshUser / adminUser 同样保持原值，
//     密码留空 = 不改密码（因为密码从不返回给前端，无法回填）。
//   - 覆盖项（installPath / port / version / processPattern / unit / cmd* / configPaths）：
//     **全量替换**。空值即「清除该覆盖项、回到类型档案的默认值」，
//     所以调用方必须把要保留的覆盖项一并带上（前端编辑弹窗即按此发送完整表单）。
func UpdateMwOpsInstance(c *gin.Context) {
	inst, ok := loadMwOpsInstance(c)
	if !ok {
		return
	}
	var req mwOpsInstanceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	if req.MwType == "" {
		req.MwType = inst.MwType
	}
	if err := applyMwOpsInstanceReq(inst, &req, false); err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	inst.UpdatedAt = time.Now()
	if err := DB.Save(inst).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败："+err.Error())
		return
	}
	OK(c, inst)
}

// DeleteMwOpsInstance 删除实例（只删平台记录，绝不动目标机）
// DELETE /api/mwops/instances/:id
func DeleteMwOpsInstance(c *gin.Context) {
	inst, ok := loadMwOpsInstance(c)
	if !ok {
		return
	}
	if err := DB.Delete(inst).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "删除失败")
		return
	}
	OK(c, gin.H{"deleted": true, "note": "仅删除平台纳管记录，目标机上的进程与文件未做任何改动"})
}

func loadMwOpsInstance(c *gin.Context) (*MwInstance, bool) {
	id, _ := strconv.Atoi(c.Param("id"))
	var inst MwInstance
	if err := DB.First(&inst, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "实例不存在")
		return nil, false
	}
	return &inst, true
}

// ---------------- 从部署记录同步 ----------------

// SyncMwOpsFromDeploy 扫描「部署执行记录」，把已部署的中间件登记为可运维实例（幂等）。
// 已存在的记录只补充部署来源信息，不覆盖运维在页面上填的路径 / 命令。
// POST /api/mwops/instances/sync-deploy
func SyncMwOpsFromDeploy(c *gin.Context) {
	var jobs []DeployJob
	if err := DB.Where("status = ?", "success").Order("id asc").Find(&jobs).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "读取部署记录失败")
		return
	}
	created, updated, skipped, failed := 0, 0, 0, 0
	var notes []string

	for _, job := range jobs {
		var targets []deployTargetRow
		_ = json.Unmarshal([]byte(job.Targets), &targets)
		if len(targets) == 0 {
			continue
		}
		// 本次任务涉及的中间件类型（优先逐项配置，回退主中间件）
		type mwPick struct{ name, version, mode string }
		picks := []mwPick{}
		var items []DeployRunMwItem
		if strings.TrimSpace(job.MwItems) != "" {
			_ = json.Unmarshal([]byte(job.MwItems), &items)
		}
		seen := map[string]bool{}
		for _, it := range items {
			t := mwOpsTypeAlias(it.Middleware)
			if t != "" && !seen[t] {
				seen[t] = true
				picks = append(picks, mwPick{name: t, version: it.Version, mode: it.Mode})
			}
		}
		if len(picks) == 0 && strings.TrimSpace(job.Middleware) != "" {
			t := mwOpsTypeAlias(job.Middleware)
			picks = append(picks, mwPick{name: t, version: job.Version, mode: job.Mode})
		}
		if len(picks) == 0 {
			continue
		}

		for _, t := range targets {
			if strings.TrimSpace(t.IP) == "" {
				continue
			}
			for _, p := range picks {
				prof := mwOpsProfileFor(p.name)
				if prof == nil {
					skipped++
					continue
				}
				// 找该中间件的部署配置，按 OS/CPU/区域解析真实安装路径
				installPath := ""
				var dm DeployMiddleware
				if DB.Where("name = ?", p.name).First(&dm).Error == nil {
					if pkg, ok := dm.GetPkg(t.OsType, t.CpuType, t.Zone); ok {
						installPath = strings.TrimSpace(pkg.Target)
					}
				}
				var cur MwInstance
				err := DB.Where("host = ? AND mw_type = ?", t.IP, p.name).First(&cur).Error
				if err == nil {
					changed := false
					if cur.DeployJobID == 0 {
						cur.Source = MwOpsSourceDeploy
						cur.DeployJobID = job.ID
						changed = true
					}
					if cur.InstallPath == "" && installPath != "" {
						cur.InstallPath = installPath
						changed = true
					}
					if cur.Version == "" && strings.TrimSpace(p.version) != "" {
						cur.Version = strings.TrimSpace(p.version)
						changed = true
					}
					if cur.Port == "" && strings.TrimSpace(prof.DefaultPort) != "" {
						cur.Port = strings.TrimSpace(prof.DefaultPort)
						changed = true
					}
					if changed {
						cur.UpdatedAt = time.Now()
						DB.Save(&cur)
						updated++
					}
					continue
				}
				rec := MwInstance{
					MwType: p.name, Version: strings.TrimSpace(p.version),
					AssetID: t.ID, AssetName: strings.TrimSpace(t.Name),
					Host: t.IP, Zone: strings.TrimSpace(t.Zone),
					Port: strings.TrimSpace(prof.DefaultPort), InstallPath: installPath,
					Source: MwOpsSourceDeploy, DeployJobID: job.ID,
					Status: MwOpsUnknown, StatusText: "尚未检测", Enabled: true,
					CreatedBy: currentUserID(c), CreatedAt: time.Now(), UpdatedAt: time.Now(),
				}
				if rec.AssetID == 0 {
					// 手动目标（不在 CMDB 中）：把部署时使用的连接信息带过来，保证可远程操作
					rec.AssetName = ""
					rec.SSHPort, rec.SSHUser, rec.SSHPass = t.Port, t.User, t.Pass
					rec.AdminUser, rec.AdminPass = t.Become, t.BecomePass
				}
				if rec.AssetID > 0 {
					var a Asset
					if DB.First(&a, rec.AssetID).Error == nil {
						rec.AssetName = AssetDisplayName(&a)
						rec.Host = extractIP(mwAssetFields(&a))
						if rec.Host == "" {
							rec.Host = t.IP
						}
					}
				}
				if err := DB.Create(&rec).Error; err != nil {
					failed++
					if len(notes) < 5 {
						notes = append(notes, fmt.Sprintf("%s/%s：%v", t.IP, p.name, err))
					}
					continue
				}
				created++
			}
		}
	}
	OK(c, gin.H{
		"created": created, "updated": updated, "skipped": skipped, "failed": failed,
		"jobCount": len(jobs), "notes": notes,
	})
}

// ---------------- 检测 ----------------

// mwOpsApplyProbe 把探测结果回写到实例（状态 + 实测发现的路径 / 版本 / 端口）
func mwOpsApplyProbe(inst *MwInstance, prof *MwOpsProfile, probe *mwOpsProbeResult) {
	now := time.Now()
	inst.LastCheckAt = &now
	inst.LastOutput = probe.Raw
	inst.LastError = ""
	inst.Status, inst.StatusText = mwOpsProbeStatus(probe, inst)
	if strings.TrimSpace(inst.InstallPath) == "" && len(probe.Dirs) > 0 {
		inst.InstallPath = probe.Dirs[0]
	}
	if v := mwOpsParseVersion(probe.VerRaw); v != "" {
		inst.Version = v
	}
	if strings.TrimSpace(inst.Port) == "" {
		pidSet := map[int]bool{}
		for _, p := range probe.Pids {
			pidSet[p] = true
		}
		for _, p := range probe.Ports {
			if p.Pid > 0 && pidSet[p.Pid] && p.Port != "" {
				inst.Port = p.Port
				break
			}
		}
	}
	// 资产名称 / 网络区域以资产当前值为准
	if inst.AssetID > 0 {
		var a Asset
		if DB.First(&a, inst.AssetID).Error == nil {
			inst.AssetName = AssetDisplayName(&a)
			if z := toStr(mwAssetFields(&a)["所属网络区域"]); z != "" {
				inst.Zone = z
			}
		}
	}
}

// mwOpsCheckOne 检测单个实例并落库
func mwOpsCheckOne(inst *MwInstance, prof *MwOpsProfile) (*mwOpsProbeResult, error) {
	probe, err := mwOpsProbe(inst, prof)
	now := time.Now()
	if err != nil {
		inst.LastCheckAt = &now
		inst.Status = MwOpsUnknown
		inst.StatusText = "检测失败"
		inst.LastError = err.Error()
		if probe != nil {
			inst.LastOutput = probe.Raw
		}
		inst.UpdatedAt = now
		DB.Save(inst)
		return probe, err
	}
	mwOpsApplyProbe(inst, prof, probe)
	inst.UpdatedAt = now
	DB.Save(inst)
	return probe, nil
}

// CheckMwOpsInstance 单台检测（含进程 / 端口 / systemd 明细）
// POST /api/mwops/instances/:id/check
func CheckMwOpsInstance(c *gin.Context) {
	inst, ok := loadMwOpsInstance(c)
	if !ok {
		return
	}
	prof := mwOpsProfileFor(inst.MwType)
	if prof == nil {
		Fail(c, http.StatusBadRequest, 400, "该实例的类型档案不存在："+inst.MwType)
		return
	}
	probe, err := mwOpsCheckOne(inst, prof)
	if err != nil {
		OK(c, gin.H{"instance": inst, "probe": probe, "ok": false, "error": err.Error()})
		return
	}
	OK(c, gin.H{"instance": inst, "probe": probe, "ok": true})
}

// CheckMwOpsInstancesBatch 批量检测（并发 6）。ids 为空时检测全部启用实例。
// POST /api/mwops/instances/check-batch  body: {"ids":[1,2]}
func CheckMwOpsInstancesBatch(c *gin.Context) {
	var req struct {
		IDs []uint `json:"ids"`
		All bool   `json:"all"`
	}
	_ = c.ShouldBindJSON(&req)

	var list []MwInstance
	q := DB.Model(&MwInstance{})
	if len(req.IDs) > 0 {
		q = q.Where("id IN ?", req.IDs)
	} else if !req.All {
		q = q.Where("enabled = ?", true)
	}
	if err := q.Order("id asc").Limit(300).Find(&list).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "读取实例失败")
		return
	}
	if len(list) == 0 {
		OK(c, gin.H{"checked": 0, "running": 0, "stopped": 0, "failed": 0})
		return
	}

	var mu sync.Mutex
	checked, running, stopped, failed := 0, 0, 0, 0
	var failures []string
	sem := make(chan struct{}, mwOpsBatchConcurrency)
	var wg sync.WaitGroup
	for i := range list {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			inst := &list[i]
			prof := mwOpsProfileFor(inst.MwType)
			mu.Lock()
			defer mu.Unlock()
			checked++
			if prof == nil {
				failed++
				return
			}
			if _, err := mwOpsCheckOne(inst, prof); err != nil {
				failed++
				if len(failures) < 8 {
					failures = append(failures, fmt.Sprintf("%s/%s：%v", inst.Host, prof.Label, err))
				}
				return
			}
			if inst.Status == MwOpsRunning {
				running++
			} else {
				stopped++
			}
		}(i)
	}
	wg.Wait()
	OK(c, gin.H{
		"checked": checked, "running": running, "stopped": stopped, "failed": failed,
		"failures": failures,
	})
}

// ---------------- 动作 ----------------

// mwOpsResolveConfPath 解析「首个存在的配置文件」路径（命令模板里的 {conf}）
func mwOpsResolveConfPath(inst *MwInstance, prof *MwOpsProfile, probe *mwOpsProbeResult) string {
	files, err := mwOpsListConfigFiles(inst, prof, probe)
	if err != nil {
		return ""
	}
	for _, f := range files {
		if f.Exists {
			return f.Path
		}
	}
	return ""
}

// MwOpsInstanceAction 启停 / 重启 / 重载
// POST /api/mwops/instances/:id/action  body: {"action":"restart","confirm":true}
func MwOpsInstanceAction(c *gin.Context) {
	inst, ok := loadMwOpsInstance(c)
	if !ok {
		return
	}
	var req struct {
		Action  string `json:"action"`
		Confirm bool   `json:"confirm"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	action := strings.ToLower(strings.TrimSpace(req.Action))
	switch action {
	case MwOpsActStart, MwOpsActStop, MwOpsActRestart, MwOpsActReload:
	default:
		Fail(c, http.StatusBadRequest, 400, "不支持的操作："+req.Action)
		return
	}
	if (action == MwOpsActStop || action == MwOpsActRestart) && !req.Confirm {
		Fail(c, http.StatusBadRequest, 400, "停止 / 重启属于影响业务的操作，请确认后再执行")
		return
	}
	prof := mwOpsProfileFor(inst.MwType)
	if prof == nil {
		Fail(c, http.StatusBadRequest, 400, "该实例的类型档案不存在："+inst.MwType)
		return
	}
	probe, perr := mwOpsProbe(inst, prof)
	if perr != nil && probe == nil {
		Fail(c, http.StatusBadRequest, 400, perr.Error())
		return
	}
	confPath := ""
	if strings.Contains(actionTemplate(inst, prof, action), "{conf}") {
		confPath = mwOpsResolveConfPath(inst, prof, probe)
	}
	cmd, via, out, err := mwOpsRunAction(inst, prof, probe, action, confPath)
	// 无论成功失败都重新探测一次，让页面看到最新状态
	probe2, _ := mwOpsCheckOne(inst, prof)
	resp := gin.H{
		"ok": err == nil, "action": action, "cmd": cmd, "via": via,
		"output": truncateForUI(out, 4000), "instance": inst, "probe": probe2,
	}
	if err != nil {
		failWithData(c, http.StatusBadRequest, 400, err.Error(), resp)
		return
	}
	OK(c, resp)
}

func actionTemplate(inst *MwInstance, prof *MwOpsProfile, action string) string {
	switch action {
	case MwOpsActStart:
		return mwOpsPick(inst.CmdStart, prof.CmdStart)
	case MwOpsActStop:
		return mwOpsPick(inst.CmdStop, prof.CmdStop)
	case MwOpsActRestart:
		return mwOpsPick(inst.CmdRestart, prof.CmdRestart)
	case MwOpsActReload:
		return mwOpsPick(inst.CmdReload, prof.CmdReload)
	}
	return ""
}

// MwOpsInstanceKill 按 PID 结束进程（仅限该实例当前匹配到的进程）
// POST /api/mwops/instances/:id/kill  body: {"pid":123,"signal":"15"}
func MwOpsInstanceKill(c *gin.Context) {
	inst, ok := loadMwOpsInstance(c)
	if !ok {
		return
	}
	var req struct {
		Pid    int    `json:"pid"`
		Signal string `json:"signal"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Pid <= 0 {
		Fail(c, http.StatusBadRequest, 400, "请提供要结束的进程 PID")
		return
	}
	prof := mwOpsProfileFor(inst.MwType)
	if prof == nil {
		Fail(c, http.StatusBadRequest, 400, "该实例的类型档案不存在："+inst.MwType)
		return
	}
	probe, perr := mwOpsProbe(inst, prof)
	if perr != nil && probe == nil {
		Fail(c, http.StatusBadRequest, 400, perr.Error())
		return
	}
	out, err := mwOpsKillProcess(inst, prof, probe, req.Pid, req.Signal)
	if err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	mwOpsCheckOne(inst, prof)
	OK(c, gin.H{"ok": true, "pid": req.Pid, "output": truncateForUI(out, 2000), "instance": inst})
}

// ---------------- 配置管理 ----------------

// ListMwOpsConfigs 列出该实例可纳管的配置文件（含存在性 / 大小 / md5 / 是否有备份）
// GET /api/mwops/instances/:id/configs
func ListMwOpsConfigs(c *gin.Context) {
	inst, ok := loadMwOpsInstance(c)
	if !ok {
		return
	}
	prof := mwOpsProfileFor(inst.MwType)
	if prof == nil {
		Fail(c, http.StatusBadRequest, 400, "该实例的类型档案不存在："+inst.MwType)
		return
	}
	probe, _ := mwOpsProbe(inst, prof)
	files, err := mwOpsListConfigFiles(inst, prof, probe)
	if err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	OK(c, gin.H{
		"list":        files,
		"candidates":  mwOpsConfigCandidates(inst, prof, probe),
		"testCmd":     prof.ConfigTestCmd,
		"reloadCmd":   mwOpsPick(inst.CmdReload, prof.CmdReload),
		"processOnly": prof.ProcessOnly,
		"installPath": inst.InstallPath,
	})
}

// GetMwOpsConfig 读取单个配置文件内容
// GET /api/mwops/instances/:id/config?path=/xxx
func GetMwOpsConfig(c *gin.Context) {
	inst, ok := loadMwOpsInstance(c)
	if !ok {
		return
	}
	prof := mwOpsProfileFor(inst.MwType)
	if prof == nil {
		Fail(c, http.StatusBadRequest, 400, "该实例的类型档案不存在："+inst.MwType)
		return
	}
	target := strings.TrimSpace(c.Query("path"))
	probe, _ := mwOpsProbe(inst, prof)
	if err := mwOpsAssertPathAllowed(inst, prof, probe, target); err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	content, err := mwOpsReadConfig(inst, target)
	if err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	OK(c, gin.H{
		"path": target, "content": content,
		"md5": md5hex(content), "size": len(content),
		"testCmd":   prof.ConfigTestCmd,
		"reloadCmd": mwOpsPick(inst.CmdReload, prof.CmdReload),
	})
}

// SaveMwOpsConfig 保存配置文件：写回（自动备份）→ 可选校验 → 可选重载
// POST /api/mwops/instances/:id/config  body: {"path":"","content":"","test":true,"reload":true}
func SaveMwOpsConfig(c *gin.Context) {
	inst, ok := loadMwOpsInstance(c)
	if !ok {
		return
	}
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
		Test    *bool  `json:"test"`
		Reload  bool   `json:"reload"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	prof := mwOpsProfileFor(inst.MwType)
	if prof == nil {
		Fail(c, http.StatusBadRequest, 400, "该实例的类型档案不存在："+inst.MwType)
		return
	}
	target := strings.TrimSpace(req.Path)
	probe, _ := mwOpsProbe(inst, prof)
	if err := mwOpsAssertPathAllowed(inst, prof, probe, target); err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	if err := mwOpsWriteConfig(inst, target, req.Content); err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	resp := gin.H{"saved": true, "path": target}

	doTest := req.Test == nil || *req.Test
	valid := true
	testOut := ""
	if doTest {
		valid, testOut = mwOpsConfigTest(inst, prof, probe, target)
	}
	resp["valid"] = valid
	resp["validateOutput"] = truncateForUI(testOut, 4000)

	if valid && req.Reload {
		cmd, via, out, err := mwOpsRunAction(inst, prof, probe, MwOpsActReload, target)
		resp["reloadCmd"] = cmd
		resp["reloadVia"] = via
		resp["reloadOutput"] = truncateForUI(out, 4000)
		if err != nil {
			resp["reloaded"] = false
			resp["reloadError"] = err.Error()
		} else {
			resp["reloaded"] = true
		}
	}
	// 刷新文件状态（含备份标记 / 新 md5）
	if files, err := mwOpsListConfigFiles(inst, prof, probe); err == nil {
		resp["files"] = files
	}
	mwOpsCheckOne(inst, prof)
	resp["instance"] = inst
	OK(c, resp)
}

// RestoreMwOpsConfig 从 *.ophub.bak 回滚，并可再校验 / 重载
// POST /api/mwops/instances/:id/config/restore  body: {"path":"","test":true,"reload":false}
func RestoreMwOpsConfig(c *gin.Context) {
	inst, ok := loadMwOpsInstance(c)
	if !ok {
		return
	}
	var req struct {
		Path   string `json:"path"`
		Test   *bool  `json:"test"`
		Reload bool   `json:"reload"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	prof := mwOpsProfileFor(inst.MwType)
	if prof == nil {
		Fail(c, http.StatusBadRequest, 400, "该实例的类型档案不存在："+inst.MwType)
		return
	}
	target := strings.TrimSpace(req.Path)
	probe, _ := mwOpsProbe(inst, prof)
	if err := mwOpsAssertPathAllowed(inst, prof, probe, target); err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	if err := mwOpsRestoreConfig(inst, target); err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	resp := gin.H{"restored": true, "path": target}
	doTest := req.Test == nil || *req.Test
	if doTest {
		valid, out := mwOpsConfigTest(inst, prof, probe, target)
		resp["valid"] = valid
		resp["validateOutput"] = truncateForUI(out, 4000)
	}
	if req.Reload {
		_, _, out, err := mwOpsRunAction(inst, prof, probe, MwOpsActReload, target)
		resp["reloaded"] = err == nil
		resp["reloadOutput"] = truncateForUI(out, 4000)
	}
	if files, err := mwOpsListConfigFiles(inst, prof, probe); err == nil {
		resp["files"] = files
	}
	OK(c, resp)
}

// truncateForUI 截断过长的命令输出（保留头尾，避免前端渲染卡顿）
func truncateForUI(s string, max int) string {
	if len(s) <= max {
		return s
	}
	half := max / 2
	return s[:half] + fmt.Sprintf("\n…（省略 %d 字节）…\n", len(s)-max) + s[len(s)-half:]
}
