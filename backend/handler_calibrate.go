// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// 资源校准（RESOURCE CALIBRATION）
//
// 用途：资产从 Excel 导入后，硬件规格往往与实际不一致（漏填、写错、被云平台改配）。
// 本功能在资产列表对单条资产发起校准：平台**直接 SSH 到目标机**执行一段只读探测命令，采集
//
//	操作系统版本 / CPU类型 / CPU核数 / 内存（GB）/ 系统盘（GB）/ 数据盘1（GB）
//
// 然后与资产已登记值逐项比对，由用户勾选确认后写回资产管理。
//
// 约定（用户口径）：
//   - 系统盘 = vda 大小（无 vda 时回退 sda → nvme0n1 → 第一块磁盘）
//   - 数据盘1 = vdb 大小（无 vdb 时回退 sdb → nvme1n1 → 第二块磁盘）
//   - 内存按标准规格档位吸附（MemTotal 因内核保留略小于标称值，
//     例如标称 16GB 实测约 15.58GiB，直接四舍五入会得到 15，必须吸附回 16）
//   - 操作系统版本按目标机 /etc/os-release 的 **ID + VERSION_ID 拼接**同步
//     （AlmaLinux 8.9 → almalinux8.9、Huawei Cloud EulerOS 2.0 → hce2.0），
//     与中间件部署的 OS 令牌表同构；发行版全名（PRETTY_NAME）只作展示，不写入资产
//   - 探测过程完全只读，不在目标机落地任何文件、不做任何变更
// ============================================================================

// calibrateFieldDef 可校准字段白名单（顺序即前端展示顺序）。
// 只有白名单内的键允许被校准流程写回，避免探测结果污染其它字段。
type calibrateFieldDef struct{ Key, Label string }

var calibrateFieldDefs = []calibrateFieldDef{
	{"操作系统版本", "操作系统版本"},
	{"CPU类型", "CPU类型"},
	{"CPU核数", "CPU核数"},
	{"内存（GB）", "内存（GB）"},
	{"系统盘（GB）", "系统盘（GB）"},
	{"数据盘1（GB）", "数据盘1（GB）"},
}

func calibrateFieldLabel(key string) (string, bool) {
	for _, d := range calibrateFieldDefs {
		if d.Key == key {
			return d.Label, true
		}
	}
	return "", false
}

// calibProbeCmd 目标机只读探测命令。
// 所有取数都来自 /proc、/sys 与 lsblk，普通用户即可读取，无需 sudo。
// 注意：命令体内**不能出现单引号**（外层会用 sh -c "..." 包裹，双引号亦不可随意使用），
// 因此分隔符用 `paste -sd,` 而不是 `tr '\n' ','`。
const calibProbeCmd = `echo "ARCH=$(uname -m 2>/dev/null)"; ` +
	`echo "NPROC=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null)"; ` +
	`echo "MEMKB=$(grep MemTotal /proc/meminfo 2>/dev/null | tr -cd 0-9)"; ` +
	`echo "OSB64=$(cat /etc/os-release 2>/dev/null | base64 -w 0)"; ` +
	`echo "REL=$(cat /etc/centos-release 2>/dev/null || cat /etc/redhat-release 2>/dev/null || cat /etc/kylin-release 2>/dev/null)"; ` +
	`D=$(lsblk -bdno NAME,SIZE 2>/dev/null | paste -sd, -); ` +
	`[ -z "$D" ] && D=$(cat /proc/partitions 2>/dev/null | paste -sd, -); ` +
	`echo "DISKS=$D"; echo "PROBE_END"`

// calibProbeTimeout 单次探测的总体超时（含 SSH 建连）
const calibProbeTimeout = 45 * time.Second

// calibDisk 探测到的一块整盘
type calibDisk struct {
	Name  string `json:"name"`
	Bytes int64  `json:"bytes"`
}

// calibProbeResult 探测结果原始值
type calibProbeResult struct {
	Arch    string
	NProc   string
	MemKB   int64
	OsText  string // /etc/os-release 原文
	RelText string // /etc/centos-release 等发行版自带版本文件（用于补全主版本号）
	Disks   []calibDisk
}

// calibItem 单个校准项的比对结果（前端逐行展示 + 勾选）
type calibItem struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Imported string `json:"imported"`      // 资产已登记值
	Detected string `json:"detected"`      // 实测值（可写回；操作系统为 os-release 的 ID+版本号）
	Raw      string `json:"raw"`           // 实测原始值（展示/排查用）
	Std      string `json:"std,omitempty"` // 平台标准写法（仅展示，不写入资产）
	Device   string `json:"device,omitempty"`
	Diff     bool   `json:"diff"`           // 是否与已登记值不一致（会改写登记值）
	Same     bool   `json:"same,omitempty"` // 与登记值为同一对象，仅书写不同（操作系统专用）
	Synced   bool   `json:"synced"`         // 是否允许同步（实测值为空时禁止，防止把已登记值覆盖成空）
	Hint     string `json:"hint,omitempty"`
}

// CalibrateAsset 资源校准：SSH 到目标机采集硬件事实并与资产登记值比对。
// POST /api/assets/:id/calibrate
func CalibrateAsset(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var a Asset
	if err := DB.First(&a, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "资产不存在")
		return
	}
	fields := map[string]interface{}{}
	if len(a.Fields) > 0 {
		_ = json.Unmarshal(a.Fields, &fields)
		_ = decryptAssetFields(fields)
	}
	if fields == nil {
		fields = map[string]interface{}{}
	}

	// ---- 1) 组装目标机 SSH 连接信息（与中间件部署同一套字段口径）----
	ip := extractIP(fields)
	if ip == "" {
		Fail(c, http.StatusBadRequest, 400, "该资产未填写「虚拟机IPv4 / 虚拟机EIP-IPv4」，无法校准")
		return
	}
	// 展示名统一走 AssetDisplayName（与 Web 终端会话名 / 定时任务 / CMDB 同源）
	name := AssetDisplayName(&a)
	portStr := toStr(fields["SSH端口"])
	if portStr == "" {
		portStr = "22"
	}
	port, err := strconv.Atoi(strings.TrimSpace(portStr))
	if err != nil || port <= 0 || port > 65535 {
		Fail(c, http.StatusBadRequest, 400, "该资产填写的「SSH端口」不合法："+portStr)
		return
	}
	user := toStr(fields["用户名"])
	if user == "" {
		user = toStr(fields["普通用户"])
	}
	pass := toStr(fields["密码"])
	if pass == "" {
		pass = toStr(fields["普通用户密码"])
	}
	becomePass := toStr(fields["超级管理员用户密码"])
	if user == "" {
		Fail(c, http.StatusBadRequest, 400, "该资产未填写 SSH「用户名 / 普通用户」，无法连接目标机")
		return
	}
	if pass == "" {
		Fail(c, http.StatusBadRequest, 400, "该资产未填写 SSH「密码 / 普通用户密码」，无法连接目标机")
		return
	}

	// ---- 2) 通过 ansible 控制节点采集（资源校准统一走 ansible）----
	started := time.Now()
	zone := toStr(fields["所属网络区域"])
	runner, rerr := ResolveAnsibleRunner(zone)
	if rerr != nil {
		// 与「中间件部署 / 巡检」一致：没有可用的 ansible 控制节点时，
		// 不静默走直 SSH（避免「绕开 ansible」悄悄发生），直接给出明确引导。
		Fail(c, http.StatusBadRequest, 400,
			"该资产未匹配到 ansible 控制节点，无法校准（资产「所属网络区域」="+zone+
				"）。请在「Ansible 节点管理」添加该区域（或任意一台）的控制节点。"+
				"原因："+rerr.Error())
		return
	}

	pr, rawOut, err := runCalibrationProbe(runner, ip, user, pass, port, becomePass)
	if err != nil {
		// ansible 路径报错时，把「通过哪台控制节点」一起带上，方便排查。
		// ⚠️ 本机模式 runner.Node 为 nil（实测 v1.7.13 直接取 .Name 空指针 panic → 500）
		nodeLabel := "本机 ansible"
		if runner.Mode != runnerModeLocal && runner.Node != nil {
			nodeLabel = runner.Node.Name
		}
		Fail(c, http.StatusBadRequest, 400,
			fmt.Sprintf("通过 ansible 控制节点 %s 采集 %s 失败：%v", nodeLabel, ip, err))
		return
	}
	items, warn := buildCalibItems(fields, pr)

	resp := gin.H{
		"assetId":    a.ID,
		"assetName":  name,
		"ip":         ip,
		"zone":       zone,
		"ssh":        fmt.Sprintf("%s@%s:%d", user, ip, port),
		"items":      items,
		"durationMs": time.Since(started).Milliseconds(),
	}
	if warn != "" {
		resp["warning"] = warn
	}
	// 探测结果为空时回传原始输出，便于排查
	if len(items) == 0 {
		resp["probeOutput"] = trimTail(rawOut, 1200)
	}
	OK(c, resp)
}

// ApplyCalibration 确认同步：把用户勾选的校准结果写回资产。
// POST /api/assets/:id/calibrate/apply  body: {"fields":{"CPU核数":"8", ...}}
func ApplyCalibration(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var req struct {
		Fields map[string]string `json:"fields"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Fields) == 0 {
		Fail(c, http.StatusBadRequest, 400, "请选择要同步的校准项")
		return
	}
	// 白名单校验（只有校准项允许写回）
	clean := map[string]interface{}{}
	for k, v := range req.Fields {
		if _, ok := calibrateFieldLabel(k); !ok {
			Fail(c, http.StatusBadRequest, 400, "不允许同步字段："+k)
			return
		}
		v = strings.TrimSpace(v)
		if v == "" {
			continue // 空值不写入，避免把已登记信息抹掉
		}
		clean[k] = v
	}
	if len(clean) == 0 {
		Fail(c, http.StatusBadRequest, 400, "没有可写入的有效值")
		return
	}

	var a Asset
	if err := DB.First(&a, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "资产不存在")
		return
	}
	m := map[string]interface{}{}
	if len(a.Fields) > 0 {
		_ = json.Unmarshal(a.Fields, &m)
		_ = decryptAssetFields(m)
	}
	if m == nil {
		m = map[string]interface{}{}
	}
	synced := make([]string, 0, len(clean))
	for k, v := range clean {
		m[k] = v
		synced = append(synced, k)
	}
	a.Fields = toJSON(m)
	if err := DB.Save(&a).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "同步失败")
		return
	}
	OK(c, gin.H{"synced": synced, "assetId": a.ID})
}

// ---------------------------------------------------------------------------
// 探测执行
// ---------------------------------------------------------------------------

// runCalibrationProbe 通过 ansible 控制节点在目标机执行只读探测命令并解析输出。
// 2026-09 起 calibrate 统一走 ansible：SSHClient 直连目标机的旧路径已废弃，
// 平台现在仅「到控制节点」走 SSHClient，到目标机由控制节点上的 ansible 命令完成。
//
// calibrate 探测不需 sudo（所有读数来自 /proc、/sys、lsblk）——Adhoc 不提权，
// 避免「资产没填 SSH 密码但填了超级管理员密码」时 ansible_ssh_pass 为空被拒。
//
// 返回 (解析结果, 原始输出, 错误)。
func runCalibrationProbe(runner *AnsibleRunner, ip, user, pass string, port int, becomePass string) (*calibProbeResult, string, error) {
	out, err := runner.Adhoc(ip, user, pass, port, calibProbeCmd,
		false /*become*/, "", calibProbeTimeout)
	if err != nil {
		// ansible 失败时 stdout 里有详细 UNREACHABLE/UNREACHABLE/FAILED 信息（如
		// "10.x.x.x | UNREACHABLE!: Failed to connect to the host via ssh..."），
		// 把它附在错误里方便排查。
		return nil, out, fmt.Errorf("ansible 采集失败：%v（ansible 输出：%s）", err, trimTail(out, 400))
	}
	pr := parseProbeOutput(out)
	if pr.Arch == "" && pr.NProc == "" && pr.MemKB == 0 && pr.OsText == "" {
		return nil, out, fmt.Errorf("未能从目标机 %s 获取任何硬件信息，请检查该机是否为 Linux 系统以及 SSH 用户权限。原始输出：%s",
			ip, trimTail(strings.TrimSpace(out), 600))
	}
	return pr, out, nil
}

// parseProbeOutput 解析 `KEY=值` 形式的探测输出
func parseProbeOutput(out string) *calibProbeResult {
	pr := &calibProbeResult{
		Arch:    grabKV(out, "ARCH"),
		NProc:   grabKV(out, "NPROC"),
		RelText: grabKV(out, "REL"),
	}
	pr.MemKB, _ = strconv.ParseInt(grabKV(out, "MEMKB"), 10, 64)
	if b64 := grabKV(out, "OSB64"); b64 != "" {
		if dec, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64)); err == nil {
			pr.OsText = string(dec)
		}
	}
	pr.Disks = parseDisks(grabKV(out, "DISKS"))
	return pr
}

// grabKV 从命令输出中提取 `KEY=值`（取该行标记之后的全部内容）
func grabKV(out, key string) string {
	marker := key + "="
	for _, line := range strings.Split(out, "\n") {
		if i := strings.Index(line, marker); i >= 0 {
			return strings.TrimSpace(line[i+len(marker):])
		}
	}
	return ""
}

var (
	reWholeDiskPart = regexp.MustCompile(`^(sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+)[0-9]+$`)
	reNVMePart      = regexp.MustCompile(`^nvme[0-9]+n[0-9]+p[0-9]+$`)
	reMMCPart       = regexp.MustCompile(`^mmcblk[0-9]+p[0-9]+$`)
)

// isWholeDisk 判断设备名是否是一块整盘（排除分区 / 光驱 / loop / 逻辑卷）
func isWholeDisk(n string) bool {
	ln := strings.ToLower(strings.TrimSpace(n))
	if ln == "" {
		return false
	}
	for _, p := range []string{"loop", "sr", "dm-", "ram", "md", "zram"} {
		if strings.HasPrefix(ln, p) {
			return false
		}
	}
	if reWholeDiskPart.MatchString(ln) || reNVMePart.MatchString(ln) || reMMCPart.MatchString(ln) {
		return false
	}
	return true
}

// parseDisks 解析磁盘列表。兼容两种来源：
//   - lsblk -bdno NAME,SIZE → "vda 107374182400,vdb 214748364800"（逗号分隔，字节）
//   - /proc/partitions      → "8 0 104857600 vda,..."（blocks 单位 1024B）
func parseDisks(raw string) []calibDisk {
	out := make([]calibDisk, 0, 4)
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		f := strings.Fields(part)
		var nm string
		var bytes int64
		switch len(f) {
		case 2: // lsblk: NAME SIZE(bytes)
			nm = f[0]
			bytes, _ = strconv.ParseInt(f[1], 10, 64)
		case 4: // /proc/partitions: major minor #blocks name
			nm = f[3]
			if blocks, err := strconv.ParseInt(f[2], 10, 64); err == nil && blocks > 0 {
				bytes = blocks * 1024
			}
		default:
			continue
		}
		if !isWholeDisk(nm) || bytes <= 0 || seen[nm] {
			continue
		}
		seen[nm] = true
		out = append(out, calibDisk{Name: nm, Bytes: bytes})
	}
	return out
}

// pickDisks 按用户口径挑选系统盘与数据盘1：
// 系统盘优先 vda → sda → nvme0n1 → 第一块；数据盘优先 vdb → sdb → nvme1n1 → 第二块。
func pickDisks(disks []calibDisk) (sys, data *calibDisk) {
	prefer := func(names ...string) *calibDisk {
		for _, n := range names {
			for i := range disks {
				if strings.EqualFold(disks[i].Name, n) {
					return &disks[i]
				}
			}
		}
		return nil
	}
	sys = prefer("vda", "sda", "nvme0n1", "hda", "xvda")
	if sys == nil && len(disks) > 0 {
		sys = &disks[0]
	}
	data = prefer("vdb", "sdb", "nvme1n1", "hdb", "xvdb")
	if data != nil && sys != nil && strings.EqualFold(data.Name, sys.Name) {
		data = nil
	}
	if data == nil {
		for i := range disks {
			if sys != nil && strings.EqualFold(disks[i].Name, sys.Name) {
				continue
			}
			data = &disks[i]
			break
		}
	}
	return
}

// ---------------------------------------------------------------------------
// 比对与建议值
// ---------------------------------------------------------------------------

// buildCalibItems 把探测结果转成逐项比对结果。
// 第二返回值非空表示有需要注意的告警（前端以 warning 展示）。
func buildCalibItems(imported map[string]interface{}, pr *calibProbeResult) ([]calibItem, string) {
	warn := ""
	items := make([]calibItem, 0, len(calibrateFieldDefs))
	add := func(it calibItem) {
		it.Imported = strings.TrimSpace(it.Imported)
		it.Detected = strings.TrimSpace(it.Detected)
		if it.Detected == "" {
			it.Synced = false
			it.Diff = it.Imported != ""
		} else {
			it.Synced = true
		}
		items = append(items, it)
	}

	// ---- 操作系统版本 ----
	// 写入资产的是 /etc/os-release 的 ID + VERSION_ID 拼接值
	// （AlmaLinux 8.9 → almalinux8.9、Huawei Cloud EulerOS 2.0 → hce2.0、
	//  Kylin V10 → kylinV10），与平台中间件部署的 OS 令牌表同构；
	// 发行版全名（PRETTY_NAME）只作为「实测原始值」展示。
	importedOS := toStr(imported["操作系统版本"])
	detectedOS, osStd, osRaw := "", "", ""
	if pr.OsText != "" {
		kv := parseOsReleaseText(pr.OsText)
		pretty := strings.TrimSpace(strings.ReplaceAll(kv["PRETTY_NAME"], "\n", " "))
		if pretty == "" {
			pretty = strings.TrimSpace(strings.Join([]string{kv["NAME"], kv["VERSION_ID"]}, " "))
		}
		if pretty == "" {
			pretty = strings.TrimSpace(kv["ID"])
		}
		osRaw = pretty

		// ID：发行版标识（os-release 非标准时可缺，回退 NAME）
		id := strings.TrimSpace(kv["ID"])
		if id == "" {
			id = strings.TrimSpace(kv["NAME"])
		}
		// 版本号：VERSION_ID 优先；缺失时回退 VERSION
		// （VERSION 常带描述，如 "8.9 (Midnight Oncologist)"，只取版本号段）。
		ver := strings.TrimSpace(kv["VERSION_ID"])
		if ver == "" {
			ver = strings.TrimSpace(kv["VERSION"])
			if i := strings.IndexAny(ver, " ("); i > 0 {
				ver = strings.TrimSpace(ver[:i])
			}
		}
		detectedOS = strings.TrimSpace(id + ver)
		if detectedOS == "" {
			detectedOS = pretty
		}

		// 「平台识别」展示用版本号：VERSION_ID 只有主版本号时（CentOS 写作 "7"），
		// 借发行版自带版本文件补全成 "7.9"，只影响提示文案，不写入资产。
		verDisp := ver
		if !strings.Contains(verDisp, ".") {
			if rv := firstDottedVersion(pr.RelText); rv != "" && strings.HasPrefix(rv, strings.TrimLeft(verDisp, "vV")) {
				verDisp = rv
			}
		}
		osStd = osDisplayName(simplifyOS(pretty+" "+kv["ID"]), verDisp, pretty)
	} else {
		warn = "未能读取目标机 /etc/os-release，操作系统版本无法校准"
	}
	osItem := calibItem{
		Key: "操作系统版本", Label: "操作系统版本",
		Imported: importedOS, Detected: detectedOS, Raw: osRaw,
	}
	// 「同一系统、只是书写不同」：语义等价（OS 令牌 / 家族级一致）但文本不同。
	osItem.Same = detectedOS != "" && importedOS != "" &&
		osEqual(importedOS, detectedOS) && !textEqual(importedOS, detectedOS)
	// 同步写入的是「ID+版本号」写法，因此只要文本不同就算差异（默认勾选，可取消）。
	osItem.Diff = !textEqual(importedOS, detectedOS)
	if osStd != "" && !textEqual(osStd, detectedOS) {
		osItem.Std = osStd
	}
	switch {
	case detectedOS == "":
		osItem.Hint = "未采集到操作系统信息，该项不做同步"
	case mapOsType(detectedOS) == "":
		osItem.Hint = "实测发行版不在平台中间件安装令牌表内：同步后不影响资产管理，但中间件部署可能无法自动识别该系统"
	case osItem.Same:
		osItem.Hint = "与登记信息为同一系统，仅书写不同；同步后将改写为「ID+版本号」写法"
	}
	add(osItem)

	// ---- CPU类型 ----
	importedCPU := toStr(imported["CPU类型"])
	detectedCPU := ""
	if pr.Arch != "" {
		if t := mapCpuType(pr.Arch); t != "" {
			detectedCPU = t
		} else {
			detectedCPU = pr.Arch
		}
	}
	cpuItem := calibItem{Key: "CPU类型", Label: "CPU类型", Imported: importedCPU, Detected: detectedCPU, Raw: pr.Arch}
	cpuItem.Diff = !cpuTypeEqual(importedCPU, detectedCPU)
	if detectedCPU == "" {
		cpuItem.Hint = "未采集到 CPU 架构信息，该项不做同步"
	}
	add(cpuItem)

	// ---- CPU核数 ----
	importedCore := toStr(imported["CPU核数"])
	coreItem := calibItem{Key: "CPU核数", Label: "CPU核数", Imported: importedCore, Detected: pr.NProc, Raw: pr.NProc}
	if pr.NProc != "" {
		coreItem.Raw = pr.NProc + " (nproc)"
	}
	if pr.NProc == "" {
		coreItem.Hint = "未采集到 CPU 核数信息，该项不做同步"
	}
	coreItem.Diff = !numEqual(importedCore, pr.NProc)
	add(coreItem)

	// ---- 内存（GB） ----
	importedMem := toStr(imported["内存（GB）"])
	detMemStr := ""
	memItem := calibItem{Key: "内存（GB）", Label: "内存（GB）", Imported: importedMem}
	if pr.MemKB > 0 {
		detMemStr = fmtNum(snapMemGB(float64(pr.MemKB) / 1048576.0))
		memItem.Detected = detMemStr
		memItem.Raw = fmt.Sprintf("MemTotal %d kB ≈ %.2f GiB（已按标准规格吸附）", pr.MemKB, float64(pr.MemKB)/1048576.0)
	} else {
		memItem.Raw = "未读取到 /proc/meminfo MemTotal"
		memItem.Hint = "未采集到内存信息，该项不做同步"
	}
	memItem.Diff = !numEqual(importedMem, detMemStr)
	add(memItem)

	// ---- 磁盘 ----
	sysDisk, dataDisk := pickDisks(pr.Disks)
	add(diskItem("系统盘（GB）", toStr(imported["系统盘（GB）"]), sysDisk, "系统盘", "vda"))
	add(diskItem("数据盘1（GB）", toStr(imported["数据盘1（GB）"]), dataDisk, "数据盘1", "vdb"))

	return items, warn
}

func diskItem(key, imported string, d *calibDisk, human, expectDev string) calibItem {
	it := calibItem{Key: key, Label: key, Imported: imported}
	if d == nil {
		it.Raw = "未检测到可用的" + human + "设备"
		it.Hint = fmt.Sprintf("目标机未检测到 %s（按 %s 识别），该项不做同步", human, expectDev)
		return it
	}
	gb := float64(d.Bytes) / 1073741824.0
	it.Detected = fmtNum(gb)
	it.Device = d.Name
	it.Raw = fmt.Sprintf("%s %.2f GiB (%d bytes)", d.Name, gb, d.Bytes)
	it.Diff = !numEqual(imported, it.Detected)
	return it
}

// parseOsReleaseText 解析 os-release 键值（兼容 CRLF / 引号）
func parseOsReleaseText(txt string) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(strings.ReplaceAll(txt, "\r", ""), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		i := strings.Index(line, "=")
		if i <= 0 {
			continue
		}
		k := strings.TrimSpace(line[:i])
		v := strings.Trim(strings.TrimSpace(line[i+1:]), `"'`)
		if _, ok := m[k]; !ok {
			m[k] = v
		}
	}
	return m
}

// reDottedVer 形如 7.9 / 7.9.2009 的版本号
var reDottedVer = regexp.MustCompile(`(\d+\.\d+(?:\.\d+)?)`)

// firstDottedVersion 从发行版版本文件里取出「主.次」版本号（7.9.2009 → 7.9），
// 取不到返回空串。
func firstDottedVersion(s string) string {
	m := reDottedVer.FindStringSubmatch(s)
	if len(m) < 2 {
		return ""
	}
	parts := strings.Split(m[1], ".")
	if len(parts) > 2 {
		return parts[0] + "." + parts[1]
	}
	return m[1]
}

// osDisplayName 生成「平台标准写法」：中文家族名 + 版本号，
// 例如 华为欧拉 HCE2.0 / 银河麒麟 V10 / openEuler 20.03。
// 仅用于前端提示（资产里写入的是实测原值），故只需贴合人工录入习惯、便于比对理解。
func osDisplayName(family, ver, pretty string) string {
	if family == "" || family == "其他" {
		return pretty
	}
	ver = strings.TrimSpace(ver)
	// 版本号里的括号内容（如 "2.0 (aarch64)"）不写入资产
	if i := strings.IndexAny(ver, "(（"); i > 0 {
		ver = strings.TrimSpace(ver[:i])
	}
	if ver == "" {
		return family
	}
	switch family {
	case "华为 HCE":
		return "华为欧拉 HCE" + ver
	case "银河麒麟":
		return "银河麒麟 " + ver
	case "中标麒麟":
		return "中标麒麟 " + ver
	case "统信 UOS":
		return "统信 UOS " + ver
	case "openKylin":
		return "openKylin " + ver
	}
	return family + " " + ver
}

// memLadder 常见内存规格档位（GB），用于把 MemTotal 吸附回标称值
var memLadder = []float64{1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024}

// snapMemGB 把实测内存 GiB 吸附到标称规格。
// MemTotal 会因内核保留略小于标称值（标称 16GB 实测约 15.58GiB），
// 直接四舍五入会得到 15，因此：先向上取整，若正好是标准档位则采用；
// 否则取「比它大的最近档位且偏差不超过 5%」，都不满足则保留向上取整值。
func snapMemGB(gb float64) float64 {
	if gb <= 0 {
		return 0
	}
	c := math.Ceil(gb - 1e-6)
	for _, l := range memLadder {
		if math.Abs(l-c) < 1e-6 {
			return l
		}
	}
	for _, l := range memLadder {
		if l > gb {
			if l <= c*1.05 {
				return l
			}
			break
		}
	}
	return c
}

// fmtNum 数值格式化：整数不带小数点，否则保留 1 位小数
func fmtNum(v float64) string {
	r := math.Round(v*10) / 10
	if math.Abs(r-math.Round(r)) < 1e-9 {
		return strconv.FormatInt(int64(math.Round(r)), 10)
	}
	return strconv.FormatFloat(r, 'f', 1, 64)
}

// numEqual 数值比较（任一侧为空则要求两侧都为空；任一侧非数值则按文本比较；容差 2%，最小 1）
func numEqual(a, b string) bool {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	if a == "" || b == "" {
		return a == b
	}
	fa, ea := strconv.ParseFloat(a, 64)
	fb, eb := strconv.ParseFloat(b, 64)
	if ea != nil || eb != nil {
		return strings.EqualFold(a, b)
	}
	tol := math.Max(1, math.Abs(fb)*0.02)
	return math.Abs(fa-fb) <= tol
}

// cpuTypeEqual CPU 类型一致性（令牌级优先，回退文本级）
func cpuTypeEqual(imported, detected string) bool {
	if strings.TrimSpace(imported) == "" || strings.TrimSpace(detected) == "" {
		return strings.TrimSpace(imported) == strings.TrimSpace(detected)
	}
	ti, td := mapCpuType(imported), mapCpuType(detected)
	if ti != "" && ti == td {
		return true
	}
	return textEqual(imported, detected)
}

// textEqual 文本比较：忽略大小写、空格与标点
func textEqual(a, b string) bool {
	norm := func(s string) string {
		s = strings.ToLower(strings.TrimSpace(s))
		var sb strings.Builder
		for _, r := range s {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r > 127 {
				sb.WriteRune(r)
			}
		}
		return sb.String()
	}
	na, nb := norm(a), norm(b)
	return na != "" && na == nb
}

// osEqual 操作系统一致性判定（三级，命中即可）：
//  1. 与中间件部署一致的 OS 令牌级相等（华为欧拉 HCE2.0 ≡ Huawei Cloud EulerOS 2.0）
//  2. OS 家族级相等（simplifyOS）
//  3. 文本级相等
func osEqual(imported, detected string) bool {
	imported, detected = strings.TrimSpace(imported), strings.TrimSpace(detected)
	if imported == "" || detected == "" {
		return imported == detected
	}
	pi, pd := mapOsType(imported), mapOsType(detected)
	if pi != "" && pi == pd {
		return true
	}
	fi, fd := simplifyOS(imported), simplifyOS(detected)
	if fi != "" && fi != "其他" && fi == fd {
		return true
	}
	return textEqual(imported, detected)
}

// trimTail 截取末尾 n 个字符（错误输出关键信息通常在尾部）
func trimTail(s string, n int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return "…" + string(r[len(r)-n:])
}
