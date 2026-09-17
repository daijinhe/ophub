package main

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// 配置管理（nginx 配置文件管理）
//
// 用途：从「虚拟机列表（CMDB 资产）」中发现并纳管 nginx 配置文件，提供在线编辑、
// 保存同步（写回目标机并 nginx -t 校验）、拉取、增删改查等能力。
//
// 设计：
//   - 平台 SSH 直连目标机（复用 SSHClient，写入已自带 *.ophub.bak 备份）。
//   - 扫描为只读探测：nginx -t 定位主配置，解析 include 指令展开片段，ReadFile 取内容。
//   - 纳管记录仅缓存内容 + md5；status 反映「平台侧内容」与「远端文件」是否一致。
// ============================================================================

// nginxScanProbeCmd 目标机只读探测：定位 nginx 主配置路径。
// 命令体内不使用单引号（外层由 SSH 会话执行），用 KEY=值 形式便于解析。
const nginxScanProbeCmd = `echo NGINX_NONE=$(command -v nginx >/dev/null 2>&1 && echo NO || echo YES); ` +
	`echo NGINX_VER=$(nginx -v 2>&1 | head -1); ` +
	`_T=$(nginx -t 2>&1); ` +
	`echo NGINX_MAIN=$(echo "$_T" | grep -oE 'configuration file [^ ]+' | head -1 | awk '{print $3}')`

// reNginxInclude 匹配 include 指令（允许引号/相对路径/通配符）
var reNginxInclude = regexp.MustCompile(`(?i)^\s*include\s+(.+?)\s*;`)

// reSafePath 仅允许绝对路径中的常规字符，防止把异常路径拼进远端命令
var reSafePath = regexp.MustCompile(`^/[-A-Za-z0-9_./]+$`)

// md5str 计算字符串 md5（十六进制）
func md5str(s string) string {
	h := md5.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

// assetTarget 由 CMDB 资产组装目标机访问信息（与资源校准 / 定时任务同一套字段口径）。
//
// 2026-09 起所有采集（nginx 扫描 / 拉取 / 写回 / nginx -t）都通过它走 ansible
// 控制节点执行，平台不再直连目标机。
func assetTarget(a Asset) (*crontabTarget, error) {
	t, err := crontabSSHInfo(&a)
	if err != nil {
		return nil, fmt.Errorf("资产 %s：%v", a.Name, err)
	}
	return t, nil
}

// ---------------------------------------------------------------------------
// 扫描：发现目标机 nginx 配置文件
// ---------------------------------------------------------------------------

// ConfigScanScope 返回可扫描的资产清单（供前端扫描选择器使用）。
// GET /api/config/scan/scope
func ConfigScanScope(c *gin.Context) {
	var assets []Asset
	if err := DB.Order("id asc").Find(&assets).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "读取资产失败")
		return
	}
	type item struct {
		ID   uint   `json:"id"`
		Name string `json:"name"`
		IP   string `json:"ip"`
	}
	list := make([]item, 0, len(assets))
	for _, a := range assets {
		fields := map[string]interface{}{}
		if len(a.Fields) > 0 {
			_ = json.Unmarshal(a.Fields, &fields)
			_ = decryptAssetFields(fields)
		}
		// 展示名统一走 AssetDisplayName（与 Web 终端会话名 / 定时任务 / CMDB 同源）
		list = append(list, item{ID: a.ID, Name: AssetDisplayName(&a), IP: extractIP(fields)})
	}
	OK(c, gin.H{"assets": list, "total": len(list)})
}

// scannedNginx 单次扫描发现的一个配置文件
type scannedNginx struct {
	AssetID   uint   `json:"assetId"`
	AssetName string `json:"assetName"`
	Host      string `json:"host"`
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Content   string `json:"content"`
	Md5       string `json:"md5"`
	Size      int    `json:"size"`
	Error     string `json:"error,omitempty"`
}

// scanOneAssetNginx 扫描单台资产上的 nginx 配置（只读）。
func scanOneAssetNginx(a Asset) []scannedNginx {
	t, err := assetTarget(a)
	if err != nil {
		return []scannedNginx{{AssetID: a.ID, AssetName: AssetDisplayName(&a), Error: err.Error()}}
	}
	host := t.IP

	// 1) 解析采集通道（sudo，与定时任务 / 中间件捕捉同源），再探测主配置路径
	//    （经 ansible 控制节点执行）；mwOpsPrivPrefix 给出提权前缀。
	mwOpsEnsurePriv(t)
	pre := mwOpsPrivPrefix(t)
	out, perr := t.exec(pre+nginxScanProbeCmd, 30*time.Second)
	if perr != nil {
		return []scannedNginx{{AssetID: a.ID, AssetName: AssetDisplayName(&a), Host: host,
			Error: "经 ansible 控制节点 " + t.runnerName() + " 探测目标机失败：" + perr.Error()}}
	}
	mainConf := grabKV(out, "NGINX_MAIN")
	// NGINX_NONE=NO 表示 command -v nginx 成功（已安装）；YES 表示未安装
	if mainConf == "" || grabKV(out, "NGINX_NONE") == "YES" {
		return []scannedNginx{{AssetID: a.ID, AssetName: AssetDisplayName(&a), Host: host, Error: "未检测到 nginx（可能未安装或当前用户无权限执行 nginx -t）"}}
	}

	// 2) 解析主配置中的 include，展开为文件列表
	paths := resolveNginxIncludePaths(t, mainConf)
	if len(paths) == 0 {
		return []scannedNginx{{AssetID: a.ID, AssetName: AssetDisplayName(&a), Host: host, Path: mainConf, Kind: NginxKindMain, Error: "已定位主配置但未能展开任何配置文件"}}
	}

	// 3) 逐个读取内容 + md5
	res := make([]scannedNginx, 0, len(paths))
	for _, p := range paths {
		content, rerr := t.ReadFile(p)
		if rerr != nil {
			res = append(res, scannedNginx{AssetID: a.ID, AssetName: AssetDisplayName(&a), Host: host, Path: p, Kind: kindOfNginx(p, mainConf), Error: rerr.Error()})
			continue
		}
		res = append(res, scannedNginx{
			AssetID: a.ID, AssetName: AssetDisplayName(&a), Host: host, Path: p,
			Kind: kindOfNginx(p, mainConf), Content: content, Md5: md5str(content), Size: len(content),
		})
	}
	return res
}

// resolveNginxIncludePaths 读取主配置，解析 include 指令并展开为具体文件路径（含主配置本身）。
func resolveNginxIncludePaths(t *crontabTarget, mainConf string) []string {
	mainContent, err := t.ReadFile(mainConf)
	if err != nil {
		return []string{mainConf}
	}
	base := path.Dir(mainConf)
	seen := map[string]bool{mainConf: true}
	out := []string{mainConf}

	add := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" || seen[p] || !reSafePath.MatchString(p) {
			return
		}
		seen[p] = true
		out = append(out, p)
	}

	for _, line := range strings.Split(mainContent, "\n") {
		m := reNginxInclude.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pat := strings.Trim(strings.TrimSpace(m[1]), `"'`)
		if pat == "" {
			continue
		}
		// 解析为「目录 + 通配符」或「具体文件」
		ref := pat
		if !strings.HasPrefix(ref, "/") {
			ref = base + "/" + pat
		}
		dir := path.Dir(ref)
		glob := path.Base(ref)
		if strings.ContainsAny(glob, "*?") {
			// 通配：列出目录条目后用 Go 侧 path.Match 过滤
			entries := remoteListDir(t, dir)
			for _, name := range entries {
				if ok, _ := path.Match(glob, name); ok {
					add(dir + "/" + name)
				}
			}
		} else {
			// 具体文件（或目录本身）
			if remoteFileExists(t, ref) {
				add(ref)
			} else if remoteDirExists(t, dir) {
				// 可能引用了目录整体，列出其下常规文件
				for _, name := range remoteListDir(t, dir) {
					if !strings.ContainsAny(name, "*?") {
						add(dir + "/" + name)
					}
				}
			}
		}
		if len(out) >= 300 { // 安全上限
			break
		}
	}
	return out
}

// remoteListDir 列出远端目录下的条目名（不含路径）。失败返回空。
func remoteListDir(t *crontabTarget, dir string) []string {
	if !reSafePath.MatchString(dir) {
		return nil
	}
	// 套上提权前缀：sudo 通道下以特权身份列目录。
	cmd := fmt.Sprintf(`%sls -1L %s 2>/dev/null`, t.sudoPrefix(), shq(dir))
	out, err := t.exec(cmd, 15*time.Second)
	if err != nil {
		return nil
	}
	names := make([]string, 0)
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(l)
		if l != "" {
			names = append(names, l)
		}
	}
	return names
}

func remoteFileExists(t *crontabTarget, p string) bool {
	if !reSafePath.MatchString(p) {
		return false
	}
	cmd := fmt.Sprintf(`%stest -f %s && echo OK || echo NO`, t.sudoPrefix(), shq(p))
	out, err := t.exec(cmd, 10*time.Second)
	if err != nil {
		return false
	}
	return strings.Contains(out, "OK")
}

func remoteDirExists(t *crontabTarget, p string) bool {
	if !reSafePath.MatchString(p) {
		return false
	}
	cmd := fmt.Sprintf(`%stest -d %s && echo OK || echo NO`, t.sudoPrefix(), shq(p))
	out, err := t.exec(cmd, 10*time.Second)
	if err != nil {
		return false
	}
	return strings.Contains(out, "OK")
}

// kindOfNginx 根据路径特征归类（用于前端展示与排序）。
func kindOfNginx(p, mainConf string) string {
	if p == mainConf {
		return NginxKindMain
	}
	lp := strings.ToLower(p)
	switch {
	case strings.Contains(lp, "conf.d"):
		return NginxKindConfD
	case strings.Contains(lp, "sites-enabled"):
		return NginxKindSite
	case strings.Contains(lp, "conf.modules.d"), strings.Contains(lp, "modules-enabled"):
		return NginxKindModule
	default:
		return NginxKindOther
	}
}

// ScanNginxConfigs 扫描 nginx 配置：可指定单台资产 assetId，或 all=true 扫描全部资产。
// POST /api/config/scan  body: {"assetId":0,"all":false}
// 返回扫描到的配置文件（含内容），不落库；由前端选择后调用 /import 持久化。
func ScanNginxConfigs(c *gin.Context) {
	var req struct {
		AssetID uint `json:"assetId"`
		All     bool `json:"all"`
	}
	_ = c.ShouldBindJSON(&req)

	var assets []Asset
	if req.All {
		if err := DB.Find(&assets).Error; err != nil {
			Fail(c, http.StatusInternalServerError, 500, "读取资产列表失败")
			return
		}
	} else {
		if req.AssetID == 0 {
			Fail(c, http.StatusBadRequest, 400, "请指定 assetId 或 all=true")
			return
		}
		var a Asset
		if err := DB.First(&a, req.AssetID).Error; err != nil {
			Fail(c, http.StatusNotFound, 404, "资产不存在")
			return
		}
		assets = []Asset{a}
	}

	results := scanAssetsConcurrently(assets)
	total := 0
	okCount := 0
	for _, r := range results {
		if r.Error != "" {
			continue
		}
		total++
		okCount++
	}
	OK(c, gin.H{
		"items":      results,
		"assetCount": len(assets),
		"foundCount": total,
		"okCount":    okCount,
	})
}

// scanAssetsConcurrently 并发扫描（worker 池），避免单机超时拖垮整体。
func scanAssetsConcurrently(assets []Asset) []scannedNginx {
	const workers = 8
	ch := make(chan Asset, len(assets))
	for _, a := range assets {
		ch <- a
	}
	close(ch)

	var mu sync.Mutex
	var all []scannedNginx
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for a := range ch {
				rs := scanOneAssetNginx(a)
				mu.Lock()
				all = append(all, rs...)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return all
}

// ImportNginxConfigs 将扫描结果中选中的项持久化为纳管记录。
// POST /api/config/import  body: {"items":[{"assetId":1,"path":"/etc/nginx/conf.d/a.conf","kind":"conf.d"}]}
func ImportNginxConfigs(c *gin.Context) {
	var req struct {
		Items []struct {
			AssetID   uint   `json:"assetId"`
			Path      string `json:"path"`
			Kind      string `json:"kind"`
			Content   string `json:"content"`
			Md5       string `json:"md5"`
			AssetName string `json:"assetName"`
			Host      string `json:"host"`
		} `json:"items"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Items) == 0 {
		Fail(c, http.StatusBadRequest, 400, "请选择要导入的配置项")
		return
	}
	created, skipped, failed := 0, 0, 0
	for _, it := range req.Items {
		if it.AssetID == 0 || it.Path == "" {
			failed++
			continue
		}
		var dup NginxConfig
		if err := DB.Where("config_type = ? AND asset_id = ? AND path = ?", "nginx", it.AssetID, it.Path).First(&dup).Error; err == nil {
			skipped++
			continue
		}
		// 资产名/主机回退
		name, host := it.AssetName, it.Host
		if name == "" || host == "" {
			var a Asset
			if DB.First(&a, it.AssetID).Error == nil {
				fields := map[string]interface{}{}
				if len(a.Fields) > 0 {
					_ = json.Unmarshal(a.Fields, &fields)
	_ = decryptAssetFields(fields)
				}
				if name == "" {
					name = AssetDisplayName(&a)
				}
				if host == "" {
					host = extractIP(fields)
				}
			}
		}
		md5v := it.Md5
		if md5v == "" {
			md5v = md5str(it.Content)
		}
		status := NginxStatusSynced
		if it.Content == "" {
			status = NginxStatusUnknown
		}
		rec := NginxConfig{
			ConfigType: "nginx",
			AssetID:    it.AssetID,
			AssetName:  name,
			Host:       host,
			Path:       it.Path,
			Kind:       it.Kind,
			Content:    it.Content,
			RemoteMd5:  md5v,
			Status:     status,
			LastScanAt: timePtr(time.Now()),
		}
		if err := DB.Create(&rec).Error; err != nil {
			failed++
			continue
		}
		created++
	}
	OK(c, gin.H{"created": created, "skipped": skipped, "failed": failed})
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

// ListNginxConfigs 列表（支持资产/状态/关键字过滤）。
// GET /api/config?assetId=&status=&keyword=
func ListNginxConfigs(c *gin.Context) {
	q := DB.Model(&NginxConfig{}).Where("config_type = ?", "nginx")
	if v := c.Query("assetId"); v != "" {
		if id, err := strconv.Atoi(v); err == nil {
			q = q.Where("asset_id = ?", id)
		}
	}
	if v := c.Query("status"); v != "" {
		q = q.Where("status = ?", v)
	}
	if kw := strings.TrimSpace(c.Query("keyword")); kw != "" {
		like := "%" + kw + "%"
		// 库里的 asset_name 是历史快照，资产改名后会搜不到；
		// 故额外把「当前展示名命中关键字」的资产也纳入，保证用新名字照样能查到。
		if ids := assetIDsByDisplayName(kw); len(ids) > 0 {
			q = q.Where("(path LIKE ? OR asset_name LIKE ? OR host LIKE ? OR asset_id IN ?)", like, like, like, ids)
		} else {
			q = q.Where("(path LIKE ? OR asset_name LIKE ? OR host LIKE ?)", like, like, like)
		}
	}
	var list []NginxConfig
	if err := q.Order("asset_id asc, kind asc, path asc").Find(&list).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "查询失败")
		return
	}
	// 展示名以资产当前值为准（库里那份只是入库时的快照，资产改名后会过期）
	refreshAssetNameSnapshots(len(list),
		func(i int) uint { return list[i].AssetID },
		func(i int, name string) { list[i].AssetName = name },
	)
	// 汇总统计
	stats := gin.H{"total": len(list), "synced": 0, "modified": 0, "error": 0, "notfound": 0, "unknown": 0}
	for _, r := range list {
		switch r.Status {
		case NginxStatusSynced:
			stats["synced"] = stats["synced"].(int) + 1
		case NginxStatusModified:
			stats["modified"] = stats["modified"].(int) + 1
		case NginxStatusError:
			stats["error"] = stats["error"].(int) + 1
		case NginxStatusNotFound:
			stats["notfound"] = stats["notfound"].(int) + 1
		default:
			stats["unknown"] = stats["unknown"].(int) + 1
		}
	}
	OK(c, gin.H{"list": list, "stats": stats})
}

// GetNginxConfig 详情（含内容）。GET /api/config/:id
func GetNginxConfig(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var r NginxConfig
	if err := DB.First(&r, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "记录不存在")
		return
	}
	OK(c, r)
}

// CreateNginxConfig 新增纳管项（可指定初始内容；不自动写回远端，需手动同步）。
// POST /api/config  body: {"assetId":1,"path":"/etc/nginx/conf.d/new.conf","kind":"conf.d","content":""}
func CreateNginxConfig(c *gin.Context) {
	var req struct {
		AssetID uint   `json:"assetId"`
		Path    string `json:"path"`
		Kind    string `json:"kind"`
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	if req.AssetID == 0 || strings.TrimSpace(req.Path) == "" {
		Fail(c, http.StatusBadRequest, 400, "资产与路径不能为空")
		return
	}
	req.Path = strings.TrimSpace(req.Path)
	var a Asset
	if err := DB.First(&a, req.AssetID).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "资产不存在")
		return
	}
	var dup NginxConfig
	if err := DB.Where("config_type = ? AND asset_id = ? AND path = ?", "nginx", req.AssetID, req.Path).First(&dup).Error; err == nil {
		Fail(c, http.StatusBadRequest, 400, "该资产下已存在相同路径的纳管记录")
		return
	}
	fields := map[string]interface{}{}
	if len(a.Fields) > 0 {
		_ = json.Unmarshal(a.Fields, &fields)
		_ = decryptAssetFields(fields)
	}
	rec := NginxConfig{
		ConfigType: "nginx",
		AssetID:    req.AssetID,
		AssetName:  AssetDisplayName(&a),
		Host:       extractIP(fields),
		Path:       req.Path,
		Kind:       req.Kind,
		Content:    req.Content,
		RemoteMd5:  "",
		Status:     NginxStatusUnknown,
		CreatedBy:  currentUserID(c),
	}
	if req.Kind == "" {
		rec.Kind = kindOfNginx(req.Path, req.Path)
	}
	if err := DB.Create(&rec).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "创建失败")
		return
	}
	OK(c, rec)
}

// UpdateNginxConfig 更新元数据（路径/类型）。内容变更统一走 sync/pull。
// PUT /api/config/:id  body: {"path":"...","kind":"..."}
func UpdateNginxConfig(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var r NginxConfig
	if err := DB.First(&r, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "记录不存在")
		return
	}
	var req struct {
		Path string `json:"path"`
		Kind string `json:"kind"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	if strings.TrimSpace(req.Path) != "" && req.Path != r.Path {
		np := strings.TrimSpace(req.Path)
		var dup NginxConfig
		if err := DB.Where("config_type = ? AND asset_id = ? AND path = ? AND id <> ?", "nginx", r.AssetID, np, r.ID).First(&dup).Error; err == nil {
			Fail(c, http.StatusBadRequest, 400, "该资产下已存在相同路径的纳管记录")
			return
		}
		r.Path = np
	}
	if req.Kind != "" {
		r.Kind = req.Kind
	}
	if err := DB.Save(&r).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "更新失败")
		return
	}
	OK(c, r)
}

// DeleteNginxConfig 删除纳管项；deleteRemote=true 时一并删除远端文件。
// DELETE /api/config/:id?deleteRemote=true
func DeleteNginxConfig(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var r NginxConfig
	if err := DB.First(&r, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "记录不存在")
		return
	}
	if c.Query("deleteRemote") == "true" && r.Path != "" {
		var a Asset
		if DB.First(&a, r.AssetID).Error == nil {
			if t, err := assetTarget(a); err == nil {
				mwOpsEnsurePriv(t) // 解析通道：sudo
				cmd := fmt.Sprintf(`rm -f %s`, shq(r.Path))
				if _, werr := t.exec(t.sudoPrefix()+cmd, 20*time.Second); werr != nil {
					// 远端删除失败不阻断平台记录删除，但返回告警
					OK(c, gin.H{"deleted": true, "remoteDeleted": false, "remoteWarning": werr.Error()})
					_ = DB.Delete(&r).Error
					return
				}
			}
		}
	}
	if err := DB.Delete(&r).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "删除失败")
		return
	}
	OK(c, gin.H{"deleted": true, "remoteDeleted": c.Query("deleteRemote") == "true"})
}

// PullNginxConfig 从远端重新拉取内容到平台缓存。
// POST /api/config/:id/pull
func PullNginxConfig(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var r NginxConfig
	if err := DB.First(&r, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "记录不存在")
		return
	}
	var a Asset
	if err := DB.First(&a, r.AssetID).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "关联资产不存在")
		return
	}
	t, err := assetTarget(a)
	if err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	mwOpsEnsurePriv(t) // 解析通道：sudo
	content, rerr := t.ReadFile(r.Path)
	if rerr != nil {
		r.Status = NginxStatusNotFound
		r.RemoteMd5 = ""
		_ = DB.Save(&r).Error
		Fail(c, http.StatusBadRequest, 400, "拉取远端文件失败："+rerr.Error())
		return
	}
	now := time.Now()
	r.Content = content
	r.RemoteMd5 = md5str(content)
	r.Status = NginxStatusSynced
	r.LastSyncAt = &now
	r.LastScanAt = &now
	if err := DB.Save(&r).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败")
		return
	}
	OK(c, r)
}

// SyncNginxConfig 在线编辑后保存到远端并做 nginx -t 校验。
// POST /api/config/:id/sync  body: {"content":"..."}
func SyncNginxConfig(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var r NginxConfig
	if err := DB.First(&r, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "记录不存在")
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Content == "" {
		Fail(c, http.StatusBadRequest, 400, "请提供要保存的配置内容")
		return
	}
	var a Asset
	if err := DB.First(&a, r.AssetID).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "关联资产不存在")
		return
	}
	t, err := assetTarget(a)
	if err != nil {
		Fail(c, http.StatusBadRequest, 400, err.Error())
		return
	}
	mwOpsEnsurePriv(t) // 解析通道：sudo

	// 写回远端（WriteFile 已自带 *.ophub.bak 备份）
	if werr := t.WriteFile(r.Path, req.Content); werr != nil {
		r.Status = NginxStatusError
		_ = DB.Save(&r).Error
		Fail(c, http.StatusBadRequest, 400, "写入远端失败："+werr.Error())
		return
	}

	// nginx -t 配置校验（必要时 sudo 重试）
	valid, vout := nginxConfigTest(t)

	now := time.Now()
	r.Content = req.Content
	r.RemoteMd5 = md5str(req.Content)
	if valid {
		r.Status = NginxStatusSynced
	} else {
		r.Status = NginxStatusError
	}
	r.LastSyncAt = &now
	if err := DB.Save(&r).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败")
		return
	}
	OK(c, gin.H{
		"id":             r.ID,
		"status":         r.Status,
		"valid":          valid,
		"validateOutput": vout,
		"remoteMd5":      r.RemoteMd5,
		"lastSyncAt":     r.LastSyncAt,
	})
}

// nginxConfigTest 运行 nginx -t 校验配置；成功返回 (true, 输出)。
func nginxConfigTest(t *crontabTarget) (bool, string) {
	cmd := `nginx -t 2>&1`
	out, err := t.exec(cmd, 30*time.Second)
	if err == nil {
		return true, strings.TrimSpace(out)
	}
	// 普通用户无权限读取部分配置时，用 sudo 重试
	if t.Client.BecomePass != "" {
		out2, err2 := t.exec(t.sudoPrefix()+cmd, 30*time.Second)
		if err2 == nil {
			return true, strings.TrimSpace(out2)
		}
		return false, strings.TrimSpace(out2)
	}
	return false, strings.TrimSpace(out)
}

// timePtr 小工具
func timePtr(t time.Time) *time.Time { return &t }
