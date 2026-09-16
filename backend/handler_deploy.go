package main

import (
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// redis 默认端口（拓扑模式：集群/哨兵 下注入给部署脚本）
const (
	redisDefaultPort  = 6379
	redisSentinelPort = 26379
)

// ---------- 目录 / 识别 ----------

// ListDeployCatalog 返回中间件部署配置（已启用）+ 部署基目录，供部署向导使用
func ListDeployCatalog(c *gin.Context) {
	var list []DeployMiddleware
	DB.Where("enabled = ?", true).Order("id asc").Find(&list)
	middlewares := make([]gin.H, 0, len(list))
	for _, m := range list {
		pkgs := make([]gin.H, 0)
		for k, p := range m.PkgMap() {
			parts := strings.SplitN(k, "_", 2)
			osType, cpuType := k, ""
			if len(parts) == 2 {
				osType, cpuType = parts[0], parts[1]
			}
			pkgs = append(pkgs, gin.H{
				"osType":  osType,
				"cpuType": cpuType,
				"pkg":     p.Pkg,
				"script":  p.Script,
				"target":  p.Target,
			})
		}
		middlewares = append(middlewares, gin.H{
			"type":        m.Name,
			"label":       m.Label,
			"icon":        m.Icon,
			"category":    m.Category,
			"subDir":      m.SubDirOrName(),
			"style":       m.StyleOrCopy(),
			"playbook":    m.Playbook,
			"installPath": m.InstallPath,
			"defaultPort": m.DefaultPort,
			"certDir":     m.CertDir,
			"ready":       m.Ready,
			"hasCert":     m.NeedCert,
			"needCert":    m.NeedCert,
			"versions":    m.VersionsList(),
			"modes":       m.ModesList(),
			"packages":    pkgs,
		})
	}
	OK(c, gin.H{
		"middlewares": middlewares,
		"deployBase":  Cfg.DeployBase,
	})
}

// DeployTarget 单台目标服务器的识别结果
type DeployTarget struct {
	ID           uint   `json:"id"`
	Name         string `json:"name"`
	IP           string `json:"ip"`
	OsRaw        string `json:"osRaw"`        // CMDB 原始 操作系统版本
	CpuRaw       string `json:"cpuRaw"`       // CMDB 原始 CPU类型
	OsType       string `json:"osType"`       // 映射后的安装包 OS 令牌
	CpuType      string `json:"cpuType"`      // 映射后的 CPU 令牌
	NetworkZone  string `json:"networkZone"`  // 资产「所属网络区域」，用于自动分配执行节点
	Supported    bool   `json:"supported"`    // 是否存在对应离线包
	Reason       string `json:"reason"`       // 不支持原因
	HasCertField bool   `json:"hasCertField"` // 资产本身是否标记了证书（仅供参考）
}

// DetectTargets 按资产ID + 中间件批量识别操作系统 / CPU 类型，判断是否匹配离线包
func DetectTargets(c *gin.Context) {
	var body struct {
		AssetIDs   []uint `json:"assetIds"`
		Middleware string `json:"middleware"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.AssetIDs) == 0 {
		Fail(c, http.StatusBadRequest, 400, "请传入资产ID列表")
		return
	}
	mwName := body.Middleware
	if mwName == "" {
		mwName = "nginx"
	}
	var mw DeployMiddleware
	if err := DB.Where("name = ?", mwName).First(&mw).Error; err != nil {
		Fail(c, http.StatusBadRequest, 400, "中间件不存在")
		return
	}
	var assets []Asset
	DB.Find(&assets, body.AssetIDs)
	byID := map[uint]Asset{}
	for _, a := range assets {
		byID[a.ID] = a
	}
	out := make([]DeployTarget, 0, len(body.AssetIDs))
	for _, id := range body.AssetIDs {
		a, ok := byID[id]
		if !ok {
			continue
		}
		var fields map[string]interface{}
		_ = json.Unmarshal(a.Fields, &fields)
		if fields == nil {
			fields = map[string]interface{}{}
		}
		ip := extractIP(fields)
		// 展示名统一走 AssetDisplayName（与 Web 终端会话名 / 定时任务 / CMDB 同源），
		// 兜底链「虚拟机名称 → 应用系统名称 → 资产名」已在函数内实现。
		name := AssetDisplayName(&a)
		osRaw := toStr(fields["操作系统版本"])
		cpuRaw := toStr(fields["CPU类型"])
		osType := mapOsType(osRaw)
		cpuType := mapCpuType(cpuRaw)
		t := DeployTarget{
			ID:           a.ID,
			Name:         name,
			IP:           ip,
			OsRaw:        osRaw,
			CpuRaw:       cpuRaw,
			OsType:       osType,
			CpuType:      cpuType,
			NetworkZone:  toStr(fields["所属网络区域"]),
			HasCertField: toStr(fields["是否有证书"]) == "是",
		}
		if ip == "" {
			t.Supported = false
			t.Reason = "资产缺少虚拟机IPv4，无法连接"
		} else if osType == "" {
			t.Supported = false
			t.Reason = "操作系统无法识别（原始值：" + osRaw + "），支持：" + strings.Join(mw.SupportMatrix(), "、")
		} else if cpuType == "" {
			t.Supported = false
			t.Reason = "CPU类型无法识别（原始值：" + cpuRaw + "），支持：" + strings.Join(mw.SupportMatrix(), "、")
		} else if _, ok := mw.GetPkg(osType, cpuType, t.NetworkZone); !ok {
			zoneTip := ""
			if t.NetworkZone != "" {
				zoneTip = "（网络区域：" + t.NetworkZone + "）"
			}
			t.Supported = false
			t.Reason = "缺少 " + osType + " / " + cpuType + " 的离线包" + zoneTip +
				"，请在“中间件部署配置”中补充（已登记：" + strings.Join(mw.SupportMatrix(), "、") + "）"
		} else {
			t.Supported = true
		}
		out = append(out, t)
	}
	OK(c, gin.H{"targets": out})
}

// ---------- 中间件部署配置（页面管理）----------

// ListDeployMiddlewares 列出全部中间件配置（含禁用/未就绪）
func ListDeployMiddlewares(c *gin.Context) {
	var list []DeployMiddleware
	DB.Order("id asc").Find(&list)
	OK(c, gin.H{"list": list})
}

// GetDeployMiddleware 详情
func GetDeployMiddleware(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var m DeployMiddleware
	if err := DB.First(&m, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "中间件不存在")
		return
	}
	OK(c, m)
}

// DeployMiddlewareReq 新增/更新请求体
type DeployMiddlewareReq struct {
	Name        string `json:"name"`
	Label       string `json:"label"`
	Icon        string `json:"icon"`
	Description string `json:"description"`
	Category    string `json:"category"` // 分类（Web服务器/运行环境/应用服务器/数据库缓存）
	Versions    string `json:"versions"` // JSON []string
	Packages    string `json:"packages"` // JSON map[osType_cpuType]PkgInfo
	Modes       string `json:"modes"`    // JSON []DeployModeDef 部署模式
	SubDir      string `json:"subDir"`   // 控制节点脚本子目录
	Style       string `json:"style"`    // 部署执行方式：copy / unarchive / dir / playbook
	Playbook    string `json:"playbook"` // style=playbook 时的既有 playbook 路径
	InstallPath string `json:"installPath"`
	DefaultPort string `json:"defaultPort"`
	CertDir     string `json:"certDir"` // 证书下发目录（目标机绝对路径）
	NeedCert    bool   `json:"needCert"`
	Ready       bool   `json:"ready"`
	Enabled     bool   `json:"enabled"`
}

// normalizeStyle 规范化部署方式，非法值回退为 copy
func normalizeStyle(s string) string {
	switch strings.TrimSpace(s) {
	case StyleUnarchive, StyleDir, StylePlaybook:
		return strings.TrimSpace(s)
	default:
		return StyleCopy
	}
}

func (r DeployMiddlewareReq) validate() string {
	if strings.TrimSpace(r.Name) == "" {
		return "类型标识(name)不能为空"
	}
	if strings.TrimSpace(r.Label) == "" {
		return "展示名(label)不能为空"
	}
	// versions / packages 必须是合法 JSON
	if strings.TrimSpace(r.Versions) != "" {
		var v []string
		if err := json.Unmarshal([]byte(r.Versions), &v); err != nil {
			return "版本(versions)不是合法 JSON 数组"
		}
	}
	if strings.TrimSpace(r.Packages) != "" {
		var p map[string]PkgInfo
		if err := json.Unmarshal([]byte(r.Packages), &p); err != nil {
			return "安装包(packages)不是合法 JSON 对象"
		}
	}
	if strings.TrimSpace(r.Modes) != "" {
		var ms []DeployModeDef
		if err := json.Unmarshal([]byte(r.Modes), &ms); err != nil {
			return "部署模式(modes)不是合法 JSON 数组"
		}
		for _, md := range ms {
			if strings.TrimSpace(md.Key) == "" || strings.TrimSpace(md.Label) == "" {
				return "部署模式每项需包含 key 与 label"
			}
			if md.Topology == "roles" && len(md.Roles) == 0 {
				return "角色模式(roles)需定义至少一个角色"
			}
		}
	}
	return ""
}

// CreateDeployMiddleware 新增
func CreateDeployMiddleware(c *gin.Context) {
	var r DeployMiddlewareReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	if msg := r.validate(); msg != "" {
		Fail(c, http.StatusBadRequest, 400, msg)
		return
	}
	name := strings.TrimSpace(r.Name)
	var cnt int64
	DB.Model(&DeployMiddleware{}).Where("name = ?", name).Count(&cnt)
	if cnt > 0 {
		Fail(c, http.StatusBadRequest, 400, "类型标识已存在")
		return
	}
	m := DeployMiddleware{
		Name:        name,
		Label:       strings.TrimSpace(r.Label),
		Icon:        strings.TrimSpace(r.Icon),
		Description: strings.TrimSpace(r.Description),
		Category:    strings.TrimSpace(r.Category),
		Versions:    strings.TrimSpace(r.Versions),
		Packages:    strings.TrimSpace(r.Packages),
		Modes:       strings.TrimSpace(r.Modes),
		SubDir:      strings.TrimSpace(r.SubDir),
		Style:       normalizeStyle(r.Style),
		Playbook:    strings.TrimSpace(r.Playbook),
		InstallPath: strings.TrimSpace(r.InstallPath),
		DefaultPort: strings.TrimSpace(r.DefaultPort),
		CertDir:     strings.TrimSpace(r.CertDir),
		NeedCert:    r.NeedCert,
		Ready:       r.Ready,
		Enabled:     r.Enabled,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}
	if err := DB.Create(&m).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败")
		return
	}
	OK(c, m)
}

// UpdateDeployMiddleware 更新
func UpdateDeployMiddleware(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var m DeployMiddleware
	if err := DB.First(&m, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "中间件不存在")
		return
	}
	var r DeployMiddlewareReq
	if err := c.ShouldBindJSON(&r); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	if msg := r.validate(); msg != "" {
		Fail(c, http.StatusBadRequest, 400, msg)
		return
	}
	m.Label = strings.TrimSpace(r.Label)
	m.Icon = strings.TrimSpace(r.Icon)
	m.Description = strings.TrimSpace(r.Description)
	m.Category = strings.TrimSpace(r.Category)
	m.Versions = strings.TrimSpace(r.Versions)
	m.Packages = strings.TrimSpace(r.Packages)
	m.Modes = strings.TrimSpace(r.Modes)
	m.SubDir = strings.TrimSpace(r.SubDir)
	m.Style = normalizeStyle(r.Style)
	m.Playbook = strings.TrimSpace(r.Playbook)
	m.InstallPath = strings.TrimSpace(r.InstallPath)
	m.DefaultPort = strings.TrimSpace(r.DefaultPort)
	m.CertDir = strings.TrimSpace(r.CertDir)
	m.NeedCert = r.NeedCert
	m.Ready = r.Ready
	m.Enabled = r.Enabled
	m.UpdatedAt = time.Now()
	if err := DB.Save(&m).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败")
		return
	}
	OK(c, m)
}

// DeleteDeployMiddleware 删除
func DeleteDeployMiddleware(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	if err := DB.Delete(&DeployMiddleware{}, id).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "删除失败")
		return
	}
	OK(c, nil)
}

// ---------- 证书仓库 ----------

// parseCertMeta 从 PEM 证书文本中解析元数据（到期时间/签发者/序列号/算法/SAN）。
// 取第一个可解析的 CERTIFICATE 块（通常为服务端证书/叶子证书）。解析失败返回空值，不影响保存。
func parseCertMeta(crtPEM string) (commonName, issuer, serial, algo, sans string, notBefore, notAfter *time.Time) {
	rest := []byte(crtPEM)
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			if len(rest) == 0 {
				break
			}
			continue
		}
		c, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			if len(rest) == 0 {
				break
			}
			continue
		}
		commonName = c.Subject.CommonName
		issuer = c.Issuer.CommonName
		serial = strings.ToUpper(c.SerialNumber.Text(16))
		switch c.PublicKeyAlgorithm {
		case x509.RSA:
			algo = "RSA"
		case x509.ECDSA:
			algo = "ECC"
		case x509.Ed25519:
			algo = "EdDSA"
		default:
			algo = c.PublicKeyAlgorithm.String()
		}
		dns := append([]string{}, c.DNSNames...)
		if commonName != "" && len(dns) > 0 && dns[0] != commonName {
			dns = append([]string{commonName}, dns...)
		}
		sans = strings.Join(dns, ", ")
		nb := c.NotBefore
		na := c.NotAfter
		notBefore = &nb
		notAfter = &na
		return commonName, issuer, serial, algo, sans, notBefore, notAfter
	}
	return "", "", "", "", "", nil, nil
}

// certDaysLeft 计算证书状态与剩余天数（基于到期时间）。
func certDaysLeft(c *DeployCert) (status string, daysLeft int) {
	if c.NotAfter == nil {
		return "unknown", -1
	}
	d := int(time.Until(*c.NotAfter).Hours() / 24)
	daysLeft = d
	switch {
	case d < 0:
		status = "expired"
	case d <= 30:
		status = "expiring"
	default:
		status = "valid"
	}
	return status, daysLeft
}

// certToJSON 将证书记录转为列表/详情用的 JSON（不含私钥明文以外的多余字段）
func certToJSON(crt DeployCert) gin.H {
	status, daysLeft := certDaysLeft(&crt)
	return gin.H{
		"id":           crt.ID,
		"name":         crt.Name,
		"domain":       crt.Domain,
		"sans":         crt.SANs,
		"project":      crt.Project,
		"issuer":       crt.Issuer,
		"serialNumber": crt.SerialNumber,
		"algorithm":    crt.Algorithm,
		"commonName":   crt.CommonName,
		"notBefore":    crt.NotBefore,
		"notAfter":     crt.NotAfter,
		"daysLeft":     daysLeft,
		"status":       status,
		"caContent":    crt.CaContent,
		"crtContent":   crt.CrtContent,
		"keyContent":   crt.KeyContent,
		"remark":       crt.Remark,
		"hasCrt":       strings.TrimSpace(crt.CrtContent) != "",
		"hasKey":       strings.TrimSpace(crt.KeyContent) != "",
		"hasCa":        strings.TrimSpace(crt.CaContent) != "",
		"createdAt":    crt.CreatedAt,
		"updatedAt":    crt.UpdatedAt,
	}
}

// ListDeployCerts 列出全部证书（含自动计算的到期状态/剩余天数）
func ListDeployCerts(c *gin.Context) {
	var list []DeployCert
	DB.Order("id desc").Find(&list)
	out := make([]gin.H, 0, len(list))
	for _, crt := range list {
		out = append(out, certToJSON(crt))
	}
	OK(c, gin.H{"certs": out})
}

// GetDeployCert 证书详情（按 id，含 CRT/KEY/CA 明文，供编辑/更新使用）
func GetDeployCert(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	if id == 0 {
		Fail(c, http.StatusBadRequest, 400, "无效的证书ID")
		return
	}
	var crt DeployCert
	if err := DB.First(&crt, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "证书不存在")
		return
	}
	OK(c, certToJSON(crt))
}

// applyCertBody 将请求体字段写入证书记录，并（若提供了 CRT）重新解析证书元数据。
func applyCertBody(crt *DeployCert, body DeployCert) {
	if strings.TrimSpace(body.Name) != "" {
		crt.Name = strings.TrimSpace(body.Name)
	}
	if strings.TrimSpace(body.Domain) != "" {
		crt.Domain = body.Domain
	}
	if body.SANs != "" {
		crt.SANs = body.SANs
	}
	if body.Project != "" {
		crt.Project = body.Project
	}
	crt.Remark = body.Remark
	if strings.TrimSpace(body.CaContent) != "" {
		crt.CaContent = body.CaContent
	}
	if strings.TrimSpace(body.CrtContent) != "" {
		crt.CrtContent = body.CrtContent
		// 重新解析元数据
		cn, iss, ser, alg, san, nb, na := parseCertMeta(body.CrtContent)
		crt.CommonName = cn
		crt.Issuer = iss
		crt.SerialNumber = ser
		crt.Algorithm = alg
		crt.SANs = san
		crt.NotBefore = nb
		crt.NotAfter = na
		if crt.Domain == "" && cn != "" {
			crt.Domain = cn
		}
	}
	if strings.TrimSpace(body.KeyContent) != "" {
		crt.KeyContent = body.KeyContent
	}
	crt.UpdatedAt = time.Now()
}

// CreateDeployCert 新增/更新证书（按 name 唯一，保存时自动解析 CRT 元数据）
func CreateDeployCert(c *gin.Context) {
	var body DeployCert
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		Fail(c, http.StatusBadRequest, 400, "证书名称不能为空")
		return
	}
	if strings.TrimSpace(body.CrtContent) == "" || strings.TrimSpace(body.KeyContent) == "" {
		Fail(c, http.StatusBadRequest, 400, "证书 CRT 与 KEY 均不能为空")
		return
	}
	var existing DeployCert
	if err := DB.Where("name = ?", body.Name).First(&existing).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			applyCertBody(&body, body)
			body.CreatedAt = time.Now()
			if err := DB.Create(&body).Error; err != nil {
				Fail(c, http.StatusInternalServerError, 500, "保存失败")
				return
			}
			OK(c, gin.H{"id": body.ID})
			return
		}
		Fail(c, http.StatusInternalServerError, 500, "查询失败")
		return
	}
	applyCertBody(&existing, body)
	if err := DB.Save(&existing).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败")
		return
	}
	OK(c, gin.H{"id": existing.ID})
}

// UpdateDeployCert 按 id 更新证书（可只更新部分字段，重传 CRT 会重新解析）
func UpdateDeployCert(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	if id == 0 {
		Fail(c, http.StatusBadRequest, 400, "无效的证书ID")
		return
	}
	var body DeployCert
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	var crt DeployCert
	if err := DB.First(&crt, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "证书不存在")
		return
	}
	applyCertBody(&crt, body)
	if err := DB.Save(&crt).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "保存失败")
		return
	}
	OK(c, gin.H{"id": crt.ID})
}

// DeployCertSummary 证书到期预警汇总：状态计数 + 即将到期（≤30天）列表
func DeployCertSummary(c *gin.Context) {
	var list []DeployCert
	DB.Find(&list)
	counts := map[string]int{"total": len(list), "valid": 0, "expiring": 0, "expired": 0, "unknown": 0}
	expiring := make([]gin.H, 0)
	for _, crt := range list {
		status, days := certDaysLeft(&crt)
		counts[status]++
		if status == "expiring" || status == "expired" {
			expiring = append(expiring, gin.H{
				"id":       crt.ID,
				"name":     crt.Name,
				"domain":   crt.Domain,
				"project":  crt.Project,
				"notAfter": crt.NotAfter,
				"daysLeft": days,
				"status":   status,
			})
		}
	}
	// 即将到期按剩余天数升序（最紧急的在前）
	sort.Slice(expiring, func(i, j int) bool {
		return (expiring[i]["daysLeft"].(int)) < (expiring[j]["daysLeft"].(int))
	})
	OK(c, gin.H{"counts": counts, "expiring": expiring})
}

// DeleteDeployCert 删除证书
func DeleteDeployCert(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	if id == 0 {
		Fail(c, http.StatusBadRequest, 400, "无效的证书ID")
		return
	}
	if err := DB.Delete(&DeployCert{}, id).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "删除失败")
		return
	}
	OK(c, nil)
}

// readFormFile 从 multipart 表单中读取上传文件内容（不存在返回空串）。
func readFormFile(c *gin.Context, field string) string {
	fh, err := c.FormFile(field)
	if err != nil || fh == nil {
		return ""
	}
	f, err := fh.Open()
	if err != nil {
		return ""
	}
	defer f.Close()
	b, err := io.ReadAll(f)
	if err != nil {
		return ""
	}
	return string(b)
}

// UploadDeployCert 通过上传证书文件（CRT/KEY/CA）创建或更新证书，并自动解析 CRT 元数据。
// 支持：新增（按 name 唯一）、更新已有（传 id 或 name 命中），更新时未上传的 KEY/CA 字段保留原值。
func UploadDeployCert(c *gin.Context) {
	name := strings.TrimSpace(c.PostForm("name"))
	if name == "" {
		// 未填名称时，尝试用上传的 CRT 文件名（去掉扩展名）作为默认名称
		if fh, err := c.FormFile("crtFile"); err == nil && fh != nil {
			base := filepath.Base(fh.Filename)
			ext := filepath.Ext(base)
			name = strings.TrimSpace(strings.TrimSuffix(base, ext))
		}
	}
	if name == "" {
		Fail(c, http.StatusBadRequest, 400, "证书名称不能为空（可填写，或由上传的 CRT 文件名自动推断）")
		return
	}

	crtContent := readFormFile(c, "crtFile")
	keyContent := readFormFile(c, "keyFile")
	caContent := readFormFile(c, "caFile")
	if strings.TrimSpace(crtContent) == "" {
		Fail(c, http.StatusBadRequest, 400, "请上传证书文件（.crt / .pem / .cer）")
		return
	}

	body := DeployCert{
		Name:       name,
		Domain:     strings.TrimSpace(c.PostForm("domain")),
		SANs:       strings.TrimSpace(c.PostForm("sans")),
		Project:    strings.TrimSpace(c.PostForm("project")),
		Remark:     c.PostForm("remark"),
		CrtContent: crtContent,
		KeyContent: keyContent,
		CaContent:  caContent,
	}
	if pid := strings.TrimSpace(c.PostForm("projectCategoryId")); pid != "" {
		if n, err := strconv.ParseUint(pid, 10, 64); err == nil {
			u := uint(n)
			body.ProjectCategoryID = &u
		}
	}

	// 定位目标记录：优先按 id，其次按 name
	var crt DeployCert
	idStr := strings.TrimSpace(c.PostForm("id"))
	if idStr != "" {
		if id, err := strconv.Atoi(idStr); err == nil {
			if err2 := DB.First(&crt, id).Error; err2 != nil {
				crt = DeployCert{}
			}
		}
	}
	if crt.ID == 0 {
		var byName DeployCert
		if err := DB.Where("name = ?", name).First(&byName).Error; err == nil {
			crt = byName
		}
	}

	if crt.ID == 0 {
		// 新建：复用 applyCertBody 完成 CRT 解析 + 字段写入
		applyCertBody(&body, body)
		body.CreatedAt = time.Now()
		if err := DB.Create(&body).Error; err != nil {
			Fail(c, http.StatusInternalServerError, 500, "保存失败")
			return
		}
		OK(c, gin.H{"id": body.ID, "created": true})
		return
	}

	// 更新：仅覆盖上传/填写的字段，未上传的 KEY/CA 与未填写的元数据保持不变
	if strings.TrimSpace(crtContent) != "" {
		crt.CrtContent = crtContent
		cn, iss, ser, alg, san, nb, na := parseCertMeta(crtContent)
		crt.CommonName = cn
		crt.Issuer = iss
		crt.SerialNumber = ser
		crt.Algorithm = alg
		crt.SANs = san
		crt.NotBefore = nb
		crt.NotAfter = na
		if crt.Domain == "" && cn != "" {
			crt.Domain = cn
		}
	}
	if strings.TrimSpace(keyContent) != "" {
		crt.KeyContent = keyContent
	}
	if strings.TrimSpace(caContent) != "" {
		crt.CaContent = caContent
	}
	if name != "" {
		crt.Name = name
	}
	if c.PostForm("domain") != "" {
		crt.Domain = strings.TrimSpace(c.PostForm("domain"))
	}
	if c.PostForm("sans") != "" {
		crt.SANs = strings.TrimSpace(c.PostForm("sans"))
	}
	if c.PostForm("project") != "" {
		crt.Project = strings.TrimSpace(c.PostForm("project"))
	}
	if c.PostForm("remark") != "" {
		crt.Remark = c.PostForm("remark")
	}
	if body.ProjectCategoryID != nil {
		crt.ProjectCategoryID = body.ProjectCategoryID
	}
	crt.UpdatedAt = time.Now()
	if err := DB.Save(&crt).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "更新失败")
		return
	}
	OK(c, gin.H{"id": crt.ID, "created": false})
}

// ---------- 执行部署 ----------

// DeployRunMwItem 单个中间件的部署配置（多选时逐项下发，各自带版本/模式/证书）
type DeployRunMwItem struct {
	Middleware string `json:"middleware"`
	Version    string `json:"version"`
	Mode       string `json:"mode"`
	HasCert    bool   `json:"hasCert"`
	CertID     *uint  `json:"certId"`
	CertName   string `json:"certName"`
}

// MwCertSpec 一个中间件槽位的证书下发规格（与 mwList 一一对应）。
// 平台只负责把证书文件送到目标机约定目录并把路径交给安装脚本，
// 具体的 SSL 配置由各中间件自身的脚本完成（nginx 例外：平台写虚拟主机并 reload）。
type MwCertSpec struct {
	HasCert  bool   `json:"hasCert"`
	CertName string `json:"certName"` // 证书名（同时作为文件名前缀）
	CertDir  string `json:"certDir"`  // 目标机证书目录（空=按中间件类型默认）
	Crt      string `json:"crt"`      // 以下三项内容仅在控制节点内部使用，不下发到前端
	Key      string `json:"key"`
	Ca       string `json:"ca"`
	HasCa    bool   `json:"hasCa"`
}

// certDirOf 中间件配置的证书下发目录（目标机绝对路径）。
// nginx 留空：其证书目录随操作系统不同（nginxPaths），在槽位解析时按 OS 补齐。
func certDirOf(m DeployMiddleware) string {
	return strings.TrimSpace(m.CertDir)
}

// DeployRunReq 部署请求
type DeployRunReq struct {
	Middleware     string            `json:"middleware"` // 主中间件（如 nginx）
	Version        string            `json:"version"`
	Mode           string            `json:"mode"`     // 部署模式（如 standalone/cluster/sentinel），中间件无模式时忽略
	Topology       map[uint]string   `json:"topology"` // 节点角色映射 assetId -> role（roles 模式必填）
	HasCert        bool              `json:"hasCert"`
	CertID         *uint             `json:"certId"`
	CertName       string            `json:"certName"`
	Env            string            `json:"env"`         // 环境
	BusinessEnv    string            `json:"businessEnv"` // 业务环境
	AssetIDs       []uint            `json:"assetIds"`
	ManualTargets  []deployTargetRow `json:"manualTargets"`  // 手动录入的目标（不走资产管理），走与资产目标相同的 SSH/部署链路
	ManualTopology map[string]string `json:"manualTopology"` // 手动目标的角色映射（IP -> role），roles 模式必填
	ExtraMW        []string          `json:"extraMw"`        // 额外勾选的中间件类型
	Items          []DeployRunMwItem `json:"items"`          // 逐项配置（优先于 Middleware/ExtraMW，每项自带版本/模式）
	InventoryMode  string            `json:"inventoryMode"`  // Ansible 接入方式：platform（默认）/ group（复用 Jenkins 组）
}

// DeployRun 创建部署任务并异步执行（HTTP 入口：绑定参数后交给 deployRunCore）
func DeployRun(c *gin.Context) {
	var req DeployRunReq
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	deployRunCore(c, req)
}

// deployRunCore 校验请求、创建部署任务记录并异步执行。
// 供 DeployRun（前端向导提交）与 RerunDeployJob（从已有执行记录重跑）共用，
// 重跑时同样走完整校验（中间件启用/版本/模式/证书），证书被删或中间件停用会明确报错而非静默。
func deployRunCore(c *gin.Context, req DeployRunReq) {

	// Ansible 接入方式：platform（平台自建 inventory，默认）/ group（复用 Jenkins 组）
	invMode := resolveInventoryMode(req.InventoryMode)

	// 规整中间件配置：优先使用 items（逐项自带版本/模式），否则回退到 middleware + extraMw 的旧契约
	type mwSpec struct {
		Name    string
		Version string
		Mode    string
	}
	var specs []mwSpec
	if len(req.Items) > 0 {
		seen := map[string]bool{}
		for _, it := range req.Items {
			name := strings.TrimSpace(it.Middleware)
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			specs = append(specs, mwSpec{Name: name, Version: it.Version, Mode: it.Mode})
		}
	} else {
		seen := map[string]bool{}
		if req.Middleware != "" {
			specs = append(specs, mwSpec{Name: req.Middleware, Version: req.Version, Mode: req.Mode})
			seen[req.Middleware] = true
		}
		for _, name := range req.ExtraMW {
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			specs = append(specs, mwSpec{Name: name})
		}
	}
	if len(specs) == 0 {
		Fail(c, http.StatusBadRequest, 400, "请至少选择一个中间件")
		return
	}
	if len(req.AssetIDs) == 0 && len(req.ManualTargets) == 0 {
		Fail(c, http.StatusBadRequest, 400, "请至少选择一台目标服务器（从资产或手动输入中任选其一）")
		return
	}

	// 逐项加载并校验（中间件已就绪/启用、版本与模式在可选范围内）
	mwList := make([]DeployMiddleware, 0, len(specs))
	for _, sp := range specs {
		var m DeployMiddleware
		if err := DB.Where("name = ?", sp.Name).First(&m).Error; err != nil || !m.Ready || !m.Enabled {
			Fail(c, http.StatusBadRequest, 400, fmt.Sprintf("中间件「%s」离线包未就绪或未启用", sp.Name))
			return
		}
		vers := m.VersionsList()
		if len(vers) > 0 {
			verOK := false
			for _, v := range vers {
				if v == sp.Version {
					verOK = true
					break
				}
			}
			if !verOK {
				Fail(c, http.StatusBadRequest, 400, fmt.Sprintf("中间件「%s」的版本不在可选范围内", m.Label))
				return
			}
		}
		if modes := m.ModesList(); len(modes) > 0 {
			ok := false
			for _, md := range modes {
				if md.Key == sp.Mode {
					ok = true
					break
				}
			}
			if !ok {
				Fail(c, http.StatusBadRequest, 400, fmt.Sprintf("中间件「%s」的部署模式无效", m.Label))
				return
			}
		}
		mwList = append(mwList, m)
	}

	// 组模式仅提供主机连通性，不携带平台通用 playbook 所需的每台离线包变量，故不能用于需平台下发包的中间件。
	if invMode == InvModeGroup && hasScriptSlot(mwList) {
		Fail(c, http.StatusBadRequest, 400, "「复用 Jenkins 组」模式仅支持自包含 playbook 类型（系统初始化 / GaussDB / Redis 等）；当前批次包含需要平台下发安装包的中间件（nginx/jdk/php/宝兰德），请改用「平台自建 inventory」模式")
		return
	}

	// 主中间件 = 第一项：模式 / 版本 / 证书按主项校验与执行（与既有部署链路保持一致）
	mainMw := mwList[0]
	mainSpec := specs[0]
	req.Version = mainSpec.Version
	req.Mode = mainSpec.Mode
	// 归一化旧字段，供后续 job 记录与 runDeployJob 使用
	req.ExtraMW = nil
	for _, m := range mwList[1:] {
		req.ExtraMW = append(req.ExtraMW, m.Name)
	}
	req.Middleware = mainMw.Name
	// 未显式传 items 时，补齐为归一化后的列表，便于任务详情展示
	if len(req.Items) == 0 {
		for i, m := range mwList {
			it := DeployRunMwItem{Middleware: m.Name}
			if i < len(specs) {
				it.Version = specs[i].Version
				it.Mode = specs[i].Mode
			}
			req.Items = append(req.Items, it)
		}
	}

	// 证书处理：逐项解析（每个中间件用自己的证书）。
	// items 未携带证书配置时，回退到顶层 hasCert/certId（旧契约，作用于主中间件）。
	loadCert := func(certID uint) (DeployCert, error) {
		var crt DeployCert
		if err := DB.First(&crt, certID).Error; err != nil {
			return crt, fmt.Errorf("证书不存在")
		}
		if strings.TrimSpace(crt.CrtContent) == "" || strings.TrimSpace(crt.KeyContent) == "" {
			return crt, fmt.Errorf("证书「%s」缺少 CRT / KEY 内容", crt.Name)
		}
		return crt, nil
	}
	itemByName := map[string]*DeployRunMwItem{}
	for k := range req.Items {
		if req.Items[k].Middleware != "" {
			itemByName[req.Items[k].Middleware] = &req.Items[k]
		}
	}
	mwCerts := make([]MwCertSpec, len(mwList))
	for i, m := range mwList {
		spec := MwCertSpec{CertDir: certDirOf(m)}
		it := itemByName[m.Name]
		switch {
		case it != nil && it.HasCert:
			if it.CertID == nil || *it.CertID == 0 {
				Fail(c, http.StatusBadRequest, 400, fmt.Sprintf("中间件「%s」已开启证书，请选择证书", m.Label))
				return
			}
			crt, err := loadCert(*it.CertID)
			if err != nil {
				Fail(c, http.StatusBadRequest, 400, err.Error())
				return
			}
			name := strings.TrimSpace(it.CertName)
			if name == "" {
				name = crt.Name
			}
			spec.HasCert, spec.CertName = true, name
			spec.Crt, spec.Key, spec.Ca = crt.CrtContent, crt.KeyContent, crt.CaContent
			spec.HasCa = strings.TrimSpace(crt.CaContent) != ""
		case i == 0 && req.HasCert:
			// 兼容旧契约：顶层证书作用于主中间件
			if req.CertID == nil || *req.CertID == 0 {
				Fail(c, http.StatusBadRequest, 400, "已选择使用证书，请选择证书")
				return
			}
			crt, err := loadCert(*req.CertID)
			if err != nil {
				Fail(c, http.StatusBadRequest, 400, err.Error())
				return
			}
			spec.HasCert, spec.CertName = true, crt.Name
			spec.Crt, spec.Key, spec.Ca = crt.CrtContent, crt.KeyContent, crt.CaContent
			spec.HasCa = strings.TrimSpace(crt.CaContent) != ""
		}
		if spec.HasCert && spec.CertDir == "" && m.Name != "nginx" {
			Fail(c, http.StatusBadRequest, 400,
				fmt.Sprintf("中间件「%s」尚未配置证书下发目录，请到「中间件部署配置」中补充后重试", m.Label))
			return
		}
		mwCerts[i] = spec
	}

	// 模式校验（若中间件定义了部署模式）
	modes := mainMw.ModesList()
	var modeDef *DeployModeDef
	if len(modes) > 0 {
		if req.Mode == "" {
			Fail(c, http.StatusBadRequest, 400, "请选择部署模式")
			return
		}
		for i := range modes {
			if modes[i].Key == req.Mode {
				modeDef = &modes[i]
				break
			}
		}
		if modeDef == nil {
			Fail(c, http.StatusBadRequest, 400, "部署模式无效")
			return
		}
	}

	// 识别目标
	var assets []Asset
	DB.Find(&assets, req.AssetIDs)
	byID := map[uint]Asset{}
	for _, a := range assets {
		byID[a.ID] = a
	}
	targets := make([]deployTargetRow, 0, len(req.AssetIDs))
	var unsupported []string
	for _, id := range req.AssetIDs {
		a, ok := byID[id]
		if !ok {
			continue
		}
		var fields map[string]interface{}
		_ = json.Unmarshal(a.Fields, &fields)
		if fields == nil {
			fields = map[string]interface{}{}
		}
		ip := extractIP(fields)
		// 展示名统一走 AssetDisplayName（与 Web 终端会话名 / 定时任务 / CMDB 同源），
		// 兜底链「虚拟机名称 → 应用系统名称 → 资产名」已在函数内实现。
		name := AssetDisplayName(&a)
		osType := mapOsType(toStr(fields["操作系统版本"]))
		cpuType := mapCpuType(toStr(fields["CPU类型"]))
		zone := toStr(fields["所属网络区域"])
		if ip == "" || osType == "" || cpuType == "" {
			unsupported = append(unsupported, fmt.Sprintf("%s(%s)", name, ip))
			continue
		}
		if _, ok := mainMw.GetPkg(osType, cpuType, zone); !ok {
			unsupported = append(unsupported, fmt.Sprintf("%s(%s)", name, ip))
			continue
		}
		port := toStr(fields["SSH端口"])
		if port == "" {
			port = "22"
		}
		user := toStr(fields["用户名"])
		if user == "" {
			user = toStr(fields["普通用户"])
		}
		pass := toStr(fields["密码"])
		if pass == "" {
			pass = toStr(fields["普通用户密码"])
		}
		become := toStr(fields["超级管理员用户"])
		if become == "" {
			become = "root"
		}
		becomePass := toStr(fields["超级管理员用户密码"])

		// 为每个中间件槽位解析离线包（主中间件必须存在；额外中间件缺失则跳过该槽位）
		slots := make([]gin.H, 0, len(mwList))
		for si, mw := range mwList {
			// 该槽位的证书规格（逐项：每个中间件可各用一张证书）
			cert := MwCertSpec{}
			if si < len(mwCerts) {
				cert = mwCerts[si]
			}
			// nginx 的证书目录随 OS 变化（conf/ssl），此处按该目标的实际安装路径补齐
			certDirSlot := cert.CertDir
			if certDirSlot == "" && mw.Name == "nginx" {
				if _, _, confDir, _ := nginxPaths(osType); confDir != "" {
					certDirSlot = confDir + "/ssl"
				}
			}
			p, ok := mw.GetPkg(osType, cpuType, zone)
			if !ok {
				slots = append(slots, gin.H{
					"pkg": "", "script": "", "scriptName": "", "target": "", "style": mw.StyleOrCopy(),
					"hasCert": cert.HasCert, "certName": cert.CertName, "certDir": certDirSlot, "hasCa": cert.HasCa,
				})
				continue
			}
			// 解压方式（php）：包解压后的目录名与包内脚本名均由包名推导
			unpack := ""
			if mw.StyleOrCopy() == StyleUnarchive {
				b := filepath.Base(p.Pkg)
				unpack = strings.TrimSuffix(strings.TrimSuffix(b, ".tar.gz"), ".tgz")
			}
			slots = append(slots, gin.H{
				"pkg":        p.Pkg,
				"pkgDir":     filepath.Dir(p.Pkg),
				"script":     p.Script,
				"scriptName": filepath.Base(p.Script),
				"unpack":     unpack,
				"target":     p.Target,
				"style":      mw.StyleOrCopy(),
				"hasCert":    cert.HasCert,
				"certName":   cert.CertName,
				"certDir":    certDirSlot,
				"hasCa":      cert.HasCa,
			})
		}
		idx := len(targets)
		role := "node"
		coordinator := false
		if modeDef != nil {
			if modeDef.Topology == "roles" {
				role = req.Topology[a.ID]
			} else if modeDef.Topology == "cluster" && idx == 0 {
				coordinator = true
			}
		}
		targets = append(targets, deployTargetRow{
			ID: a.ID, Name: name, IP: ip, OsType: osType, CpuType: cpuType, Zone: zone,
			Port: port, User: user, Pass: pass, Become: become, BecomePass: becomePass,
			Slots: slots, Role: role, Coordinator: coordinator,
		})
	}

	// 手动输入的目标：与资产目标走相同的 SSH/部署链路。
	// 与资产的差异：1) ID=0（不入库、不参与按 ID 查找）；2) OS/CPU/zone 由用户在向导中显式指定；
	// 3) 角色（roles 模式）按 IP 查 ManualTopology。
	// 前端约束：手动目标 IP 必须唯一（用于角色映射），重复时只取首个的 topology 值并提示。
	manualIPRole := map[string]string{} // 用于 roles 校验的反查与去重提示
	manualIPSeen := map[string]bool{}
	for _, m := range req.ManualTargets {
		mName := strings.TrimSpace(m.Name)
		if mName == "" {
			mName = strings.TrimSpace(m.IP)
		}
		mIP := strings.TrimSpace(m.IP)
		mZone := strings.TrimSpace(m.Zone)
		mOs := mapOsType(strings.TrimSpace(m.OsType))
		mCpu := mapCpuType(strings.TrimSpace(m.CpuType))
		mPort := strings.TrimSpace(m.Port)
		if mPort == "" {
			mPort = "22"
		}
		mUser := strings.TrimSpace(m.User)
		mPass := m.Pass
		mBecome := strings.TrimSpace(m.Become)
		if mBecome == "" {
			mBecome = "root"
		}
		mBecomePass := m.BecomePass

		var miss []string
		if mIP == "" {
			miss = append(miss, "IP")
		}
		if mZone == "" {
			miss = append(miss, "所属网络区域")
		}
		if mOs == "" {
			miss = append(miss, "操作系统版本")
		}
		if mCpu == "" {
			miss = append(miss, "CPU类型")
		}
		if mUser == "" {
			miss = append(miss, "SSH用户")
		}
		if mPass == "" {
			miss = append(miss, "SSH密码")
		}
		if mBecomePass == "" {
			miss = append(miss, "超级管理员密码")
		}
		if len(miss) > 0 {
			unsupported = append(unsupported, fmt.Sprintf("手动目标 %s（缺 %s）", mName, strings.Join(miss, "、")))
			continue
		}
		if manualIPSeen[mIP] {
			unsupported = append(unsupported, fmt.Sprintf("手动目标 %s(IP %s) 与其他手动目标重复，请保留唯一 IP", mName, mIP))
			continue
		}
		manualIPSeen[mIP] = true
		// 主中间件离线包匹配（与资产同口径）
		if _, ok := mainMw.GetPkg(mOs, mCpu, mZone); !ok {
			unsupported = append(unsupported, fmt.Sprintf("%s(%s)", mName, mIP))
			continue
		}
		// 逐项生成 slot（nginx 证书目录随 OS 自适应；其他中间件走 GetPkg）
		mSlots := make([]gin.H, 0, len(mwList))
		for si, mw := range mwList {
			cert := MwCertSpec{}
			if si < len(mwCerts) {
				cert = mwCerts[si]
			}
			certDirSlot := cert.CertDir
			if certDirSlot == "" && mw.Name == "nginx" {
				if _, _, confDir, _ := nginxPaths(mOs); confDir != "" {
					certDirSlot = confDir + "/ssl"
				}
			}
			p, ok := mw.GetPkg(mOs, mCpu, mZone)
			if !ok {
				mSlots = append(mSlots, gin.H{
					"pkg": "", "script": "", "scriptName": "", "target": "", "style": mw.StyleOrCopy(),
					"hasCert": cert.HasCert, "certName": cert.CertName, "certDir": certDirSlot, "hasCa": cert.HasCa,
				})
				continue
			}
			unpack := ""
			if mw.StyleOrCopy() == StyleUnarchive {
				b := filepath.Base(p.Pkg)
				unpack = strings.TrimSuffix(strings.TrimSuffix(b, ".tar.gz"), ".tgz")
			}
			mSlots = append(mSlots, gin.H{
				"pkg": p.Pkg, "pkgDir": filepath.Dir(p.Pkg), "script": p.Script,
				"scriptName": filepath.Base(p.Script), "unpack": unpack, "target": p.Target,
				"style": mw.StyleOrCopy(), "hasCert": cert.HasCert, "certName": cert.CertName,
				"certDir": certDirSlot, "hasCa": cert.HasCa,
			})
		}
		midx := len(targets)
		mRole := "node"
		mCoord := false
		if modeDef != nil {
			if modeDef.Topology == "roles" {
				if r, ok := req.ManualTopology[mIP]; ok && r != "" {
					mRole = r
				}
			} else if modeDef.Topology == "cluster" && midx == 0 {
				mCoord = true
			}
		}
		manualIPRole[mIP] = mRole
		targets = append(targets, deployTargetRow{
			ID: 0, Name: mName, IP: mIP, OsType: mOs, CpuType: mCpu, Zone: mZone,
			Port: mPort, User: mUser, Pass: mPass, Become: mBecome, BecomePass: mBecomePass,
			Slots: mSlots, Role: mRole, Coordinator: mCoord,
		})
	}

	if len(targets) == 0 {
		Fail(c, http.StatusBadRequest, 400, "所选目标均无可用离线包："+strings.Join(unsupported, "、"))
		return
	}

	// 按「所属网络区域」自动解析执行节点（控制节点），缺失则给出明确引导
	zoneRemotes, zoneErr, remotesJSON := resolveDeployRemotes(targets)
	if zoneErr != "" {
		Fail(c, http.StatusBadRequest, 400, zoneErr)
		return
	}

	// 模式相关拓扑校验 + 构造节点清单（供脚本协调）
	var redisNodes []gin.H
	topoJSON := "{}"
	if modeDef != nil {
		switch modeDef.Topology {
		case "cluster":
			if len(targets) != modeDef.NodeCount {
				Fail(c, http.StatusBadRequest, 400, fmt.Sprintf("集群模式需选择 %d 台服务器，当前 %d 台", modeDef.NodeCount, len(targets)))
				return
			}
		case "roles":
			for _, t := range targets {
				role := roleOfTarget(t, req.Topology, manualIPRole)
				valid := false
				for _, r := range modeDef.Roles {
					if r == role {
						valid = true
						break
					}
				}
				if !valid {
					Fail(c, http.StatusBadRequest, 400, fmt.Sprintf("节点 %s 的角色 %q 不在允许范围内", t.Name, role))
					return
				}
			}
			masterCnt, sentinelCnt := 0, 0
			for _, t := range targets {
				switch roleOfTarget(t, req.Topology, manualIPRole) {
				case "master":
					masterCnt++
				case "sentinel":
					sentinelCnt++
				}
			}
			if masterCnt < 1 {
				Fail(c, http.StatusBadRequest, 400, "哨兵模式至少需要 1 个 master 节点")
				return
			}
			if sentinelCnt < 3 {
				Fail(c, http.StatusBadRequest, 400, "哨兵模式至少需要 3 个 sentinel 节点（保证 quorum）")
				return
			}
		}
		redisNodes = make([]gin.H, 0, len(targets))
		for i, t := range targets {
			role := "node"
			if modeDef.Topology == "roles" {
				role = roleOfTarget(t, req.Topology, manualIPRole)
			}
			redisNodes = append(redisNodes, gin.H{
				"ip":          t.IP,
				"port":        redisDefaultPort,
				"role":        role,
				"coordinator": i == 0,
			})
		}
		if b, err := json.Marshal(req.Topology); err == nil {
			topoJSON = string(b)
		}
	}
	redisNodesJSON := "[]"
	if modeDef != nil {
		if b, err := json.Marshal(redisNodes); err == nil {
			redisNodesJSON = string(b)
		}
	}
	// 组模式不写平台 inventory，缺少每台节点的拓扑/角色变量（redis_role / redis_coordinator / 集群节点清单），
	// 故仅支持单机（无拓扑协调）部署；集群/哨兵等需要平台逐台下发变量的模式必须用 platform 模式。
	if invMode == InvModeGroup && modeDef != nil && modeDef.Topology != "" && modeDef.Topology != "single" {
		Fail(c, http.StatusBadRequest, 400, fmt.Sprintf("「复用 Jenkins 组」模式不支持「%s」等带拓扑的部署模式（缺少逐台节点变量），请改用「平台自建 inventory」模式", modeDef.Label))
		return
	}

	// 任务记录保留「首个启用证书的中间件」（便于任务详情直观展示；实际逐项下发见 mwCerts）
	certName := ""
	mainHasCert := false
	for _, c := range mwCerts {
		if c.HasCert {
			mainHasCert, certName = true, c.CertName
			break
		}
	}

	tgtsJSON, _ := json.Marshal(targets)
	extraMWJSON, _ := json.Marshal(req.ExtraMW)
	mwItemsJSON, _ := json.Marshal(req.Items)
	job := DeployJob{
		Middleware:    req.Middleware,
		Version:       req.Version,
		MwItems:       string(mwItemsJSON),
		Mode:          req.Mode,
		Topology:      topoJSON,
		Remotes:       remotesJSON,
		HasCert:       mainHasCert,
		CertID:        req.CertID,
		CertName:      certName,
		Env:           req.Env,
		BusinessEnv:   req.BusinessEnv,
		ExtraMW:       string(extraMWJSON),
		Targets:       string(tgtsJSON),
		InventoryMode: invMode,
		Status:        "pending",
		CreatedBy:     currentUID(c),
		CreatedAt:     time.Now(),
		UpdatedAt:     time.Now(),
	}
	if err := DB.Create(&job).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "创建任务失败")
		return
	}
	// 异步执行：传入中间件列表（用于按槽位生成 playbook）、各网络区域执行节点与拓扑（供脚本自愈 HA）
	go runDeployJob(job.ID, mwList, mwCerts, req.Version, zoneRemotes, string(tgtsJSON), req.Mode, redisNodesJSON, invMode)
	OK(c, gin.H{"jobId": job.ID, "unsupported": unsupported})
}

// GetDeployJob 查询部署任务状态与输出（前端轮询）
func GetDeployJob(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var job DeployJob
	if err := DB.First(&job, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "任务不存在")
		return
	}
	OK(c, job)
}

// ListDeployJobs 查询中间件部署执行记录（分页 + 过滤），供「执行记录」页展示与重跑。
func ListDeployJobs(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 20
	}
	mw := strings.TrimSpace(c.Query("middleware"))
	status := strings.TrimSpace(c.Query("status"))
	q := DB.Model(&DeployJob{})
	if mw != "" {
		q = q.Where("middleware = ?", mw)
	}
	if status != "" {
		q = q.Where("status = ?", status)
	}
	var total int64
	q.Count(&total)
	var jobs []DeployJob
	if err := q.Order("id desc").Offset((page - 1) * size).Limit(size).Find(&jobs).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "查询执行记录失败")
		return
	}
	OK(c, gin.H{"list": jobs, "total": total, "page": page, "size": size})
}

// RerunDeployJob 从已有部署执行记录还原请求并重新执行（供「执行记录」页一键重跑）。
// 复用 deployRunCore 的完整校验链路，保证重跑时中间件/版本/模式/证书仍有效。
func RerunDeployJob(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var job DeployJob
	if err := DB.First(&job, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "原任务不存在")
		return
	}
	// 从记录还原请求参数
	var items []DeployRunMwItem
	_ = json.Unmarshal([]byte(job.MwItems), &items)
	var extraMW []string
	_ = json.Unmarshal([]byte(job.ExtraMW), &extraMW)
	var topo map[uint]string
	_ = json.Unmarshal([]byte(job.Topology), &topo)
	// 目标资产 ID 从 Targets（[]deployTargetRow，含 id 字段）还原
	var targets []struct {
		ID uint `json:"id"`
	}
	_ = json.Unmarshal([]byte(job.Targets), &targets)
	assetIDs := make([]uint, 0, len(targets))
	for _, t := range targets {
		if t.ID > 0 {
			assetIDs = append(assetIDs, t.ID)
		}
	}
	if len(assetIDs) == 0 {
		Fail(c, http.StatusBadRequest, 400, "原任务缺少目标服务器，无法重跑")
		return
	}
	req := DeployRunReq{
		Middleware:    job.Middleware,
		Version:       job.Version,
		Mode:          job.Mode,
		Topology:      topo,
		HasCert:       job.HasCert,
		CertID:        job.CertID,
		CertName:      job.CertName,
		Env:           job.Env,
		BusinessEnv:   job.BusinessEnv,
		AssetIDs:      assetIDs,
		ExtraMW:       extraMW,
		Items:         items,
		InventoryMode: job.InventoryMode,
	}
	deployRunCore(c, req)
}

// ---------- 系统初始化（复用既有 ansible playbook，与 Jenkins stage 对齐）----------

// sysInitTaskDef 一个系统初始化操作（运行期结构，由 DB 目录 loadSysInitCatalog 填充）
type sysInitTaskDef struct {
	Key      string // 选项标签（与前端一致）
	Playbook string // 相对所属域根目录的 playbook 路径
	Desc     string
	VarMode  string // os | cpu | static | none
	VarArgs  string // static 模式的固定变量
	Domain   string // 目录域：空/system=SystemInitDir；gaussdb=GaussDBInitDir
}

// BaseDir 该任务所属域的根目录（控制节点上）
func (t sysInitTaskDef) BaseDir() string {
	return sysInitBaseDirOf(t.Domain)
}

// sysInitBaseDirOf 目录域 → 控制节点上的根目录（系统初始化链路的唯一口径）。
//
//	""（或 system）→ SystemInitDir（system_init）
//	"gaussdb"      → GaussDBInitDir（gaussDB_init）
//
// 末尾斜杠已去除，调用方按 dir + "/" + 相对路径 拼接即可。
func sysInitBaseDirOf(domain string) string {
	if strings.EqualFold(strings.TrimSpace(domain), "gaussdb") {
		return strings.TrimRight(Cfg.GaussDBInitDir, "/")
	}
	return strings.TrimRight(Cfg.SystemInitDir, "/")
}

// loadSysInitCatalog 从 DB 读取已启用的系统初始化操作目录（按 order_no 排序，跳过删除墓碑）
func loadSysInitCatalog() []sysInitTaskDef {
	var rows []SysInitCatalog
	DB.Where("deleted = ?", false).Order("order_no asc, id asc").Find(&rows)
	out := make([]sysInitTaskDef, 0, len(rows))
	for _, r := range rows {
		if !r.Enabled {
			continue
		}
		out = append(out, sysInitTaskDef{Key: r.Key, Playbook: r.Playbook, Desc: r.Desc, VarMode: r.VarMode, VarArgs: r.VarArgs, Domain: r.Domain})
	}
	return out
}

// sysInitExtra 任务自带的静态变量（VarMode=static 的 VarArgs，如 GaussDB 数据盘挂载的
// DISK_DIR / FORMAT_TYPE）。
//
// 历史契约里 VarMode 还有 "os" / "cpu"（表示该任务需要 OS_TYPE / CPU_TYPE）：现在这两个
// 变量已由 sysInitZone 对**每个任务**统一透传（与 Jenkins 的 `-e 'hosts=xxx CPU_TYPE=x86_64'`
// 完全一致），故此处不再重复拼装，避免同一个 `-e` 里出现同名键。
func sysInitExtra(task sysInitTaskDef) string {
	if task.VarMode != "static" {
		return ""
	}
	return strings.TrimSpace(task.VarArgs)
}

// parseStrSlice 解析 JSON 字符串数组（空串/非法返回 nil，表示不限制）
func parseStrSlice(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return nil
	}
	return out
}

// SysInitOptions 返回系统初始化可选操作（含分组/变量契约）、OS/CPU 选项与当前 playbook 根目录
func SysInitOptions(c *gin.Context) {
	cpuTypes := []string{"x86_64", "aarch64"}
	var rows []SysInitCatalog
	DB.Where("deleted = ?", false).Order("order_no asc, id asc").Find(&rows)
	osSet := map[string]bool{}
	tasks := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		if !r.Enabled {
			continue
		}
		osList := parseStrSlice(r.OsTypes)
		for _, o := range osList {
			osSet[o] = true
		}
		group := strings.TrimSpace(r.Group)
		if group == "" {
			group = "其他"
		}
		tasks = append(tasks, gin.H{
			"key":      r.Key,
			"label":    r.Label,
			"group":    group,
			"domain":   r.Domain,
			"desc":     r.Desc,
			"playbook": r.Playbook,
			"varMode":  r.VarMode,
			"varArgs":  r.VarArgs,
			"custom":   r.Custom,
			"osTypes":  osList,
			"cpuTypes": parseStrSlice(r.CpuTypes),
		})
	}
	// OS 选项 = 目录里登记过的 OS 令牌去重（保持稳定顺序），再补默认全集
	osTypes := make([]string, 0, len(osSet))
	for _, o := range sysInitOsTokens {
		if osSet[o] {
			osTypes = append(osTypes, o)
		}
	}
	OK(c, gin.H{
		"tasks":          tasks,
		"osTypes":        osTypes,
		"cpuTypes":       cpuTypes,
		"systemInitDir":  Cfg.SystemInitDir,
		"gaussdbInitDir": Cfg.GaussDBInitDir,
	})
}

// sysInitOsTokens 平台识别的 OS 令牌全集（用于下拉候选与顺序稳定）
var sysInitOsTokens = []string{
	"centos7", "centos8", "almalinux8.9", "almalinux8.10",
	"openEuler20.03", "openEuler22.03", "hce2.0", "kylinV10", "ubuntu22",
	"rocky8", "rocky9", "rhel7", "rhel8", "rhel9",
}

// CreateSysInitJob 创建并异步执行系统初始化任务
func CreateSysInitJob(c *gin.Context) {
	var req struct {
		Tasks         []string          `json:"tasks"`
		AssetIDs      []uint            `json:"assetIds"`
		ManualTargets []deployTargetRow `json:"manualTargets"` // 手动输入的目标（不走资产管理），与资产目标一同执行系统初始化
		OsType        string            `json:"osType"`
		CpuType       string            `json:"cpuType"`
		InventoryMode string            `json:"inventoryMode"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	if len(req.Tasks) == 0 {
		Fail(c, http.StatusBadRequest, 400, "请至少选择一个初始化操作（如无需初始化可跳过）")
		return
	}
	if len(req.AssetIDs) == 0 && len(req.ManualTargets) == 0 {
		Fail(c, http.StatusBadRequest, 400, "请至少选择一台目标服务器（从资产或手动输入中任选其一）")
		return
	}
	valid := map[string]sysInitTaskDef{}
	for _, t := range loadSysInitCatalog() {
		valid[t.Key] = t
	}
	selected := make([]sysInitTaskDef, 0, len(req.Tasks))
	for _, k := range req.Tasks {
		if t, ok := valid[k]; ok {
			selected = append(selected, t)
		}
	}
	if len(selected) == 0 {
		Fail(c, http.StatusBadRequest, 400, "没有有效的初始化操作")
		return
	}

	// 构建目标（复用 CMDB 资产字段，与中间件部署一致）
	var assets []Asset
	DB.Find(&assets, req.AssetIDs)
	byID := map[uint]Asset{}
	for _, a := range assets {
		byID[a.ID] = a
	}
	targets := make([]deployTargetRow, 0, len(req.AssetIDs))
	var unsupported []string
	for _, id := range req.AssetIDs {
		a, ok := byID[id]
		if !ok {
			continue
		}
		var fields map[string]interface{}
		_ = json.Unmarshal(a.Fields, &fields)
		if fields == nil {
			fields = map[string]interface{}{}
		}
		ip := extractIP(fields)
		// 展示名统一走 AssetDisplayName（与 Web 终端会话名 / 定时任务 / CMDB 同源），
		// 兜底链「虚拟机名称 → 应用系统名称 → 资产名」已在函数内实现。
		name := AssetDisplayName(&a)
		zone := toStr(fields["所属网络区域"])
		if ip == "" || zone == "" {
			unsupported = append(unsupported, fmt.Sprintf("%s(缺IP或网络区域)", name))
			continue
		}
		port := toStr(fields["SSH端口"])
		if port == "" {
			port = "22"
		}
		user := toStr(fields["用户名"])
		if user == "" {
			user = toStr(fields["普通用户"])
		}
		pass := toStr(fields["密码"])
		if pass == "" {
			pass = toStr(fields["普通用户密码"])
		}
		become := toStr(fields["超级管理员用户"])
		if become == "" {
			become = "root"
		}
		becomePass := toStr(fields["超级管理员用户密码"])
		targets = append(targets, deployTargetRow{
			ID: a.ID, Name: name, IP: ip, OsType: mapOsType(toStr(fields["操作系统版本"])),
			CpuType: mapCpuType(toStr(fields["CPU类型"])), Zone: zone,
			Port: port, User: user, Pass: pass, Become: become, BecomePass: becomePass,
		})
	}

	// 手动输入的目标：与资产目标走相同的 SSH/部署链路（系统初始化不需要 slots/topology）。
	manualIPSeen := map[string]bool{}
	for _, m := range req.ManualTargets {
		mName := strings.TrimSpace(m.Name)
		if mName == "" {
			mName = strings.TrimSpace(m.IP)
		}
		mIP := strings.TrimSpace(m.IP)
		mZone := strings.TrimSpace(m.Zone)
		mOs := mapOsType(strings.TrimSpace(m.OsType))
		mCpu := mapCpuType(strings.TrimSpace(m.CpuType))
		mPort := strings.TrimSpace(m.Port)
		if mPort == "" {
			mPort = "22"
		}
		mUser := strings.TrimSpace(m.User)
		mPass := m.Pass
		mBecome := strings.TrimSpace(m.Become)
		if mBecome == "" {
			mBecome = "root"
		}
		mBecomePass := m.BecomePass

		var miss []string
		if mIP == "" {
			miss = append(miss, "IP")
		}
		if mZone == "" {
			miss = append(miss, "所属网络区域")
		}
		if mOs == "" {
			miss = append(miss, "操作系统版本")
		}
		if mCpu == "" {
			miss = append(miss, "CPU类型")
		}
		if mUser == "" {
			miss = append(miss, "SSH用户")
		}
		if mPass == "" {
			miss = append(miss, "SSH密码")
		}
		if mBecomePass == "" {
			miss = append(miss, "超级管理员密码")
		}
		if len(miss) > 0 {
			unsupported = append(unsupported, fmt.Sprintf("手动目标 %s（缺 %s）", mName, strings.Join(miss, "、")))
			continue
		}
		if manualIPSeen[mIP] {
			unsupported = append(unsupported, fmt.Sprintf("手动目标 %s(IP %s) 与其他手动目标重复，请保留唯一 IP", mName, mIP))
			continue
		}
		manualIPSeen[mIP] = true
		targets = append(targets, deployTargetRow{
			ID: 0, Name: mName, IP: mIP, OsType: mOs, CpuType: mCpu, Zone: mZone,
			Port: mPort, User: mUser, Pass: mPass, Become: mBecome, BecomePass: mBecomePass,
		})
	}

	if len(targets) == 0 {
		Fail(c, http.StatusBadRequest, 400, "所选服务器均无法识别（需具备 IP 与所属网络区域）："+strings.Join(unsupported, "、"))
		return
	}

	zoneRemotes, zoneErr, _ := resolveDeployRemotes(targets)
	if zoneErr != "" {
		Fail(c, http.StatusBadRequest, 400, zoneErr)
		return
	}

	taskKeys := make([]string, 0, len(selected))
	for _, t := range selected {
		taskKeys = append(taskKeys, t.Key)
	}
	tgtsJSON, _ := json.Marshal(targets)
	tkJSON, _ := json.Marshal(taskKeys)
	job := SysInitJob{
		Tasks:         string(tkJSON),
		Targets:       string(tgtsJSON),
		OsType:        req.OsType,
		CpuType:       req.CpuType,
		InventoryMode: resolveInventoryMode(req.InventoryMode),
		Status:        "pending",
		CreatedBy:     currentUID(c),
		CreatedAt:     time.Now(),
		UpdatedAt:     time.Now(),
	}
	if err := DB.Create(&job).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 500, "创建任务失败")
		return
	}
	go runSysInitJob(job.ID, req.OsType, req.CpuType, selected, zoneRemotes, job.InventoryMode)
	OK(c, gin.H{"id": job.ID, "unsupported": unsupported})
}

// runSysInitJob 按网络区域分组执行所选初始化操作
func runSysInitJob(jobID uint, osType, cpuType string, selected []sysInitTaskDef, zoneRemotes map[string]AnsibleRemote, invMode string) {
	setJob := func(status, output, errMsg string) {
		var job SysInitJob
		if DB.First(&job, jobID).Error != nil {
			return
		}
		job.Status = status
		if output != "" {
			job.Output = output
		}
		job.ErrorMsg = errMsg
		now := time.Now()
		job.FinishedAt = &now
		job.UpdatedAt = now
		DB.Save(&job)
	}
	var job SysInitJob
	if DB.First(&job, jobID).Error != nil {
		return
	}
	job.Status = "running"
	job.UpdatedAt = time.Now()
	DB.Save(&job)

	var targets []deployTargetRow
	if err := json.Unmarshal([]byte(job.Targets), &targets); err != nil {
		setJob("failed", "", "目标解析失败: "+err.Error())
		return
	}
	if len(targets) == 0 {
		setJob("failed", "", "任务无目标服务器")
		return
	}
	groups := map[string][]deployTargetRow{}
	var order []string
	for _, t := range targets {
		if _, ok := groups[t.Zone]; !ok {
			groups[t.Zone] = nil
			order = append(order, t.Zone)
		}
		groups[t.Zone] = append(groups[t.Zone], t)
	}

	var buf strings.Builder
	var firstErr string
	for _, zone := range order {
		remote, ok := zoneRemotes[zone]
		if !ok {
			msg := fmt.Sprintf("网络区域「%s」未找到对应的执行节点", zone)
			buf.WriteString("\n[ERROR] " + msg + "\n")
			if firstErr == "" {
				firstErr = msg
			}
			continue
		}
		out, runErr := sysInitZone(remote.ToSSHClient(), fmt.Sprintf("%d_%s", jobID, zone), zone, groups[zone], osType, cpuType, selected, invMode)
		buf.WriteString(fmt.Sprintf("\n================ 网络区域：%s（控制节点 %s / %s）================\n", zone, remote.Name, remote.Host))
		buf.WriteString(out)
		if runErr != nil {
			msg := fmt.Sprintf("网络区域 %s 执行失败: %s", zone, runErr.Error())
			buf.WriteString("\n[ERROR] " + msg + "\n")
			if firstErr == "" {
				firstErr = msg
			}
		}
	}
	if firstErr != "" {
		setJob("failed", buf.String(), firstErr)
		return
	}
	setJob("success", buf.String(), "")
}

// sysInitZone 在指定控制节点上针对一组目标，逐个执行所选 playbook（顺序，等价于 Jenkins 的 switch 串）
// OS_TYPE / CPU_TYPE 解析优先级：传入值（手动覆盖）→ 资产字段（操作系统版本 / CPU类型）→ 后台探测（cat /etc/os-release + uname -m）。
// ctlRunPrefix 返回在控制节点上执行 ansible-playbook 所需的命令前缀。
// 背景：控制节点上的脚本根目录（如 /data/jenkins_home/...）通常只有 root 可读可进入，
// 而平台以普通运维用户（如 yyds）SSH 登录，直接执行会 Permission denied。
// 规则：当前用户能读到该路径 → 不加前缀（保持原有行为）；读不到 → 用 sudo 提权执行。
func ctlRunPrefix(client SSHClient, probePath string) string {
	cmd := fmt.Sprintf("[ -r %s ] && echo __R_OK__", shellQuotePath(probePath))
	if out, err := client.RunWithTimeout(cmd, 20*time.Second); err == nil && strings.Contains(out, "__R_OK__") {
		return ""
	}
	if p := client.sudoPrefix(); p != "" {
		return p
	}
	return "sudo -n " // 未配置 sudo 密码时尝试免密 sudo，失败会给出明确报错
}

// sysInitZone 在指定控制节点上，针对该网络区域下的一组目标执行系统初始化 playbook。
func sysInitZone(client SSHClient, stamp, zone string, targets []deployTargetRow, osType, cpuType string, selected []sysInitTaskDef, invMode string) (string, error) {
	// 解析 sudo 提权密码（同 deployZone：sudo 校验调用者密码，不能直接取「超级管理员用户密码」）
	sudoNotes := resolveZoneSudoPass(targets)

	// OS/CPU 令牌解析优先级：请求显式指定 → 资产/区域归纳 → 后台探测。
	// 区域内取值不一致（mixed）时**不**通过 -e 统一下发，改由每台主机的 os_type/cpu_type
	// 各自生效 —— -e 的优先级高于主机变量，统一下发会让一台的架构覆盖另一台。
	zoneOs, zoneCpu := strings.TrimSpace(osType), strings.TrimSpace(cpuType)
	srcOs, srcCpu := "manual", "manual"
	zoneMixed := false
	if zoneOs == "" || zoneCpu == "" {
		aOs, aCpu, aMixed := zoneOSCPU(targets)
		if zoneOs == "" {
			zoneOs, srcOs = aOs, "asset"
		}
		if zoneCpu == "" {
			zoneCpu, srcCpu = aCpu, "asset"
		}
		zoneMixed = aMixed
	}
	if zoneOs == "" || zoneCpu == "" {
		detOs, detCpu, derr := detectOSCPU(client, targets[0])
		if derr != nil {
			return "", fmt.Errorf("操作系统/CPU 探测失败（%s）：%w", targets[0].IP, derr)
		}
		if zoneOs == "" {
			zoneOs = detOs
			srcOs = "detected"
		}
		if zoneCpu == "" {
			zoneCpu = detCpu
			srcCpu = "detected"
		}
	}
	// 主机行兜底值：区域级令牌为空时逐台回落，避免写出空主机变量
	fallbackOs, fallbackCpu := zoneOs, zoneCpu
	for _, t := range targets {
		if fallbackOs == "" {
			fallbackOs = t.OsType
		}
		if fallbackCpu == "" {
			fallbackCpu = t.CpuType
		}
	}

	invPath := "/tmp/ophub_si_" + stamp + ".ini"
	// Ansible 接入方式：group 模式临时登记「<15位随机数>-应用安装」主机组（不传 -i，用控制节点默认 inventory）
	// -i 参数值用双引号引用：网络区域名可能含中文/空格（文件名形如 ophub_si_<job>_<区域>.ini）
	invArg := "-i " + quote(invPath)
	hostsVal := "sysinit_targets"
	groupNote := ""
	groupCleanup := func() {}
	if invMode == InvModeGroup {
		gs, err := setupGroupInventory(client, stamp, targets)
		if err != nil {
			return "", err
		}
		hostsVal, invArg, groupCleanup, groupNote = gs.Hosts, gs.InvArg, gs.Cleanup, gs.Note
	}
	defer groupCleanup()

	// 预检：所选任务的 playbook（含 GaussDB 域）在控制节点上是否存在。
	// 系统初始化链路的 playbook 全部位于受限目录，缺失/路径写错时提前给出明确提示，
	// 避免串到一半才失败。命令无法执行时（权限/连接问题）不阻断，交由后续报错兜底。
	pbPaths := make([]string, 0, len(selected))
	pbSeen := map[string]bool{}
	for _, task := range selected {
		p := filepath.Join(task.BaseDir(), task.Playbook)
		if !pbSeen[p] {
			pbSeen[p] = true
			pbPaths = append(pbPaths, p)
		}
	}
	if miss := controlNodeMissing(client, pbPaths); len(miss) > 0 {
		return "", fmt.Errorf("执行节点 %s 上缺少初始化 playbook：\n  - %s\n请在控制节点补齐该文件，或在「系统初始化配置」中修正 playbook 路径",
			client.Host, strings.Join(miss, "\n  - "))
	}

	var inv strings.Builder
	inv.WriteString("[sysinit_targets]\n")
	for _, t := range targets {
		// 每台主机写自己的 OS/CPU（大小写双份：脚本既可能读 os_type，也可能读 OS_TYPE），
		// 与中间件部署的 platform inventory 保持同一口径。
		os, cpu := t.OsType, t.CpuType
		if os == "" {
			os = fallbackOs
		}
		if cpu == "" {
			cpu = fallbackCpu
		}
		inv.WriteString(fmt.Sprintf("%s %s os_type=%s cpu_type=%s OS_TYPE=%s CPU_TYPE=%s\n",
			strings.TrimSpace(t.IP), hostConnVars(t), quote(os), quote(cpu), quote(os), quote(cpu)))
	}
	if invMode != InvModeGroup {
		if err := client.WriteFile(invPath, inv.String()); err != nil {
			return "", fmt.Errorf("写入临时 inventory 失败: %w", err)
		}
		defer client.Run("rm -f " + quote(invPath))
	}

	var buf strings.Builder
	buf.WriteString(groupNote)
	buf.WriteString(sudoPassNotesBlock(sudoNotes))
	buf.WriteString(fmt.Sprintf("\n🔍 操作系统/CPU 识别：OS_TYPE=%s（来源 %s），CPU_TYPE=%s（来源 %s）\n",
		zoneOs, osSourceLabel(srcOs), zoneCpu, osSourceLabel(srcCpu)))
	if zoneMixed {
		buf.WriteString("⚠️ 本区域目标存在多种操作系统/CPU，未通过 -e 统一下发 OS_TYPE/CPU_TYPE（由每台主机变量各自生效）\n")
	}
	var firstErr string
	// 控制节点脚本目录（如 /data/jenkins_home/...）通常仅 root 可读；系统初始化域与
	// GaussDB 域的目录权限可能不同，故按「playbook 所在目录」分别解析提权前缀并缓存，
	// 不能只探测第一个任务后全批复用（否则 GaussDB 域会 Permission denied）。
	prefixCache := map[string]string{}
	prefixNoted := map[string]bool{}
	for _, task := range selected {
		pbPath := filepath.Join(task.BaseDir(), task.Playbook)
		dir := filepath.Dir(pbPath)
		runPrefix, ok := prefixCache[dir]
		if !ok {
			runPrefix = ctlRunPrefix(client, pbPath)
			prefixCache[dir] = runPrefix
			if runPrefix != "" && !prefixNoted[dir] {
				prefixNoted[dir] = true
				buf.WriteString(fmt.Sprintf("ℹ️ 控制节点目录 %s 为受限目录，已自动使用 sudo 执行（普通用户直读会 Permission denied）\n", dir))
			}
		}
		// 统一透传 hosts + OS_TYPE / CPU_TYPE（等价 Jenkins 的 -e 'hosts=xxx CPU_TYPE=x86_64'），
		// 任务自带的静态变量（如 GaussDB 数据盘挂载的 DISK_DIR / FORMAT_TYPE）追加在后。
		args := "hosts=" + hostsVal
		if zoneOs != "" && !zoneMixed {
			args += " OS_TYPE=" + shellQuote(zoneOs)
		}
		if zoneCpu != "" && !zoneMixed {
			args += " CPU_TYPE=" + shellQuote(zoneCpu)
		}
		if extra := sysInitExtra(task); extra != "" {
			args += " " + extra
		}
		cmd := runPrefix + fmt.Sprintf("bash -lc 'ansible-playbook %s %s -e \"%s\" 2>&1'", shellQuote(pbPath), invArg, args)
		buf.WriteString(fmt.Sprintf("\n🔧 正在执行: %s\n", task.Key))
		out, runErr := client.Run(cmd)
		buf.WriteString(out)
		if runErr != nil {
			buf.WriteString(fmt.Sprintf("\n❌ %s 失败: %v\n", task.Key, runErr))
			if firstErr == "" {
				firstErr = fmt.Sprintf("%s 失败", task.Key)
			}
		} else {
			buf.WriteString(fmt.Sprintf("\n✅ %s 完成\n", task.Key))
		}
	}
	if firstErr != "" {
		return buf.String(), fmt.Errorf("%s", firstErr)
	}
	return buf.String(), nil
}

// osSourceLabel 将 OS/CPU 来源标记转为中文展示
func osSourceLabel(s string) string {
	switch s {
	case "asset":
		return "资产管理"
	case "detected":
		return "后台探测"
	case "manual":
		return "手动指定"
	default:
		return "未知"
	}
}

// parseOsRelease 从 ansible -m shell 输出中解析 ID / ID_LIKE / VERSION_ID / 架构。
// ansible 输出形如：  <ip> | CHANGED | rc=0 >>\n<os-release 内容>\n@@@\n<x86_64>
func parseOsRelease(out string) (id, idLike, ver, arch string) {
	body := out
	if i := strings.Index(out, ">>"); i >= 0 {
		body = out[i+2:]
	}
	if i := strings.Index(body, "@@@"); i >= 0 {
		arch = strings.TrimSpace(body[i+3:])
		body = body[:i]
	}
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "ID="):
			id = strings.Trim(strings.TrimPrefix(line, "ID="), "\"' ")
		case strings.HasPrefix(line, "ID_LIKE="):
			idLike = strings.Trim(strings.TrimPrefix(line, "ID_LIKE="), "\"' ")
		case strings.HasPrefix(line, "VERSION_ID="):
			ver = strings.Trim(strings.TrimPrefix(line, "VERSION_ID="), "\"' ")
		}
	}
	return
}

// detectOSCPU 在控制节点上 SSH 到目标机执行 `cat /etc/os-release` + `uname -m`，
// 解析为平台 OS 令牌与 CPU 令牌（与 Jenkins「操作系统和cpu类型检测」stage 一致）。
// 仅当资产未登记「操作系统版本 / CPU类型」时调用。
func detectOSCPU(client SSHClient, target deployTargetRow) (string, string, error) {
	stamp := fmt.Sprintf("%d_%s", target.ID, target.IP)
	invPath := "/tmp/ophub_detect_" + stamp + ".ini"
	inv := fmt.Sprintf("[det]\n%s ansible_port=%s ansible_user=%s ansible_ssh_pass=%s ansible_become_user=%s ansible_become_pass=%s ansible_become_method=sudo ansible_ssh_common_args=-o StrictHostKeyChecking=no\n",
		quote(target.IP), quote(target.Port), quote(target.User), quote(target.Pass), quote(target.Become), quote(target.BecomePass))
	if err := client.WriteFile(invPath, inv); err != nil {
		return "", "", fmt.Errorf("写入探测 inventory 失败: %w", err)
	}
	defer client.Run("rm -f " + invPath)

	scriptPath := "/tmp/ophub_detect_" + stamp + ".sh"
	script := fmt.Sprintf("ansible %s -i %s -m shell -a 'cat /etc/os-release | tr \"\\n\" \" \"; echo @@@; uname -m' 2>&1\n",
		target.IP, invPath)
	if err := client.WriteFile(scriptPath, script); err != nil {
		return "", "", fmt.Errorf("写入探测脚本失败: %w", err)
	}
	defer client.Run("rm -f " + scriptPath)

	out, err := client.Run("bash " + scriptPath)
	if err != nil {
		return "", "", fmt.Errorf("探测命令执行失败: %w", err)
	}
	id, idLike, ver, arch := parseOsRelease(out)
	osType := normalizeOsType(id, idLike, ver)
	cpuType := "x86_64"
	la := strings.ToLower(arch)
	if strings.Contains(la, "aarch") || strings.Contains(la, "arm64") {
		cpuType = "aarch64"
	}
	if osType == "" {
		return "", "", fmt.Errorf("无法识别操作系统（ID=%s VERSION_ID=%s），请在资产管理补充「操作系统版本」", id, ver)
	}
	return osType, cpuType, nil
}

// GetSysInitJob 查询系统初始化任务状态与输出（前端轮询）
func GetSysInitJob(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	var job SysInitJob
	if err := DB.First(&job, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 404, "任务不存在")
		return
	}
	OK(c, job)
}

// ListSysInitJobs 最近系统初始化任务列表
func ListSysInitJobs(c *gin.Context) {
	var jobs []SysInitJob
	DB.Order("id desc").Limit(50).Find(&jobs)
	OK(c, jobs)
}

// srcOf 返回资产字段是否已有值，用于判定来源
func srcOf(v string) string {
	if v != "" {
		return "asset"
	}
	return "unknown"
}

// DetectSysInitEnv 探测系统初始化所需的 OS_TYPE / CPU_TYPE：优先使用资产管理字段，
// 缺失时在控制节点上后台探测（cat /etc/os-release + uname -m），返回每个目标与每个网络区域的
// 识别结果及来源（asset / detected / unknown）。供前端在「应用中间件安装」向导第一步展示，无需用户手选。
func DetectSysInitEnv(c *gin.Context) {
	var req struct {
		AssetIDs []uint `json:"assetIds"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		Fail(c, http.StatusBadRequest, 400, "参数错误")
		return
	}
	if len(req.AssetIDs) == 0 {
		Fail(c, http.StatusBadRequest, 400, "请选择目标服务器")
		return
	}
	var assets []Asset
	DB.Find(&assets, req.AssetIDs)
	byID := map[uint]Asset{}
	for _, a := range assets {
		byID[a.ID] = a
	}
	targets := make([]deployTargetRow, 0, len(req.AssetIDs))
	var unsupported []string
	for _, id := range req.AssetIDs {
		a, ok := byID[id]
		if !ok {
			continue
		}
		var fields map[string]interface{}
		_ = json.Unmarshal(a.Fields, &fields)
		if fields == nil {
			fields = map[string]interface{}{}
		}
		ip := extractIP(fields)
		// 展示名统一走 AssetDisplayName（与 Web 终端会话名 / 定时任务 / CMDB 同源），
		// 兜底链「虚拟机名称 → 应用系统名称 → 资产名」已在函数内实现。
		name := AssetDisplayName(&a)
		zone := toStr(fields["所属网络区域"])
		if ip == "" || zone == "" {
			unsupported = append(unsupported, fmt.Sprintf("%s(缺IP或网络区域)", name))
			continue
		}
		port := toStr(fields["SSH端口"])
		if port == "" {
			port = "22"
		}
		user := toStr(fields["用户名"])
		if user == "" {
			user = toStr(fields["普通用户"])
		}
		pass := toStr(fields["密码"])
		if pass == "" {
			pass = toStr(fields["普通用户密码"])
		}
		become := toStr(fields["超级管理员用户"])
		if become == "" {
			become = "root"
		}
		becomePass := toStr(fields["超级管理员用户密码"])
		targets = append(targets, deployTargetRow{
			ID: a.ID, Name: name, IP: ip, OsType: mapOsType(toStr(fields["操作系统版本"])),
			CpuType: mapCpuType(toStr(fields["CPU类型"])), Zone: zone,
			Port: port, User: user, Pass: pass, Become: become, BecomePass: becomePass,
		})
	}
	if len(targets) == 0 {
		Fail(c, http.StatusBadRequest, 400, "所选服务器均无法识别（需具备 IP 与所属网络区域）："+strings.Join(unsupported, "、"))
		return
	}
	zoneRemotes, zoneErr, _ := resolveDeployRemotes(targets)
	if zoneErr != "" {
		Fail(c, http.StatusBadRequest, 400, zoneErr)
		return
	}

	groups := map[string][]deployTargetRow{}
	var order []string
	for _, t := range targets {
		if _, ok := groups[t.Zone]; !ok {
			groups[t.Zone] = nil
			order = append(order, t.Zone)
		}
		groups[t.Zone] = append(groups[t.Zone], t)
	}

	perTarget := make([]gin.H, 0, len(targets))
	zones := make([]gin.H, 0, len(order))
	for _, zone := range order {
		remote, ok := zoneRemotes[zone]
		if !ok {
			zones = append(zones, gin.H{"zone": zone, "osType": "", "cpuType": "", "osSource": "unknown", "cpuSource": "unknown", "error": "未配置执行节点"})
			for _, t := range groups[zone] {
				perTarget = append(perTarget, gin.H{"id": t.ID, "name": t.Name, "ip": t.IP, "zone": zone, "osType": t.OsType, "cpuType": t.CpuType, "osSource": srcOf(t.OsType), "cpuSource": srcOf(t.CpuType)})
			}
			continue
		}
		zoneOs, zoneCpu, srcOs, srcCpu := "", "", "unknown", "unknown"
		for _, t := range groups[zone] {
			if zoneOs == "" && t.OsType != "" {
				zoneOs = t.OsType
				srcOs = "asset"
			}
			if zoneCpu == "" && t.CpuType != "" {
				zoneCpu = t.CpuType
				srcCpu = "asset"
			}
		}
		if zoneOs == "" || zoneCpu == "" {
			detOs, detCpu, derr := detectOSCPU(remote.ToSSHClient(), groups[zone][0])
			if derr == nil {
				if zoneOs == "" {
					zoneOs = detOs
					srcOs = "detected"
				}
				if zoneCpu == "" {
					zoneCpu = detCpu
					srcCpu = "detected"
				}
			}
		}
		zones = append(zones, gin.H{"zone": zone, "osType": zoneOs, "cpuType": zoneCpu, "osSource": srcOs, "cpuSource": srcCpu})
		for _, t := range groups[zone] {
			osT, osS := t.OsType, srcOf(t.OsType)
			if osT == "" {
				osT, osS = zoneOs, srcOs
			}
			cpuT, cpuS := t.CpuType, srcOf(t.CpuType)
			if cpuT == "" {
				cpuT, cpuS = zoneCpu, srcCpu
			}
			perTarget = append(perTarget, gin.H{"id": t.ID, "name": t.Name, "ip": t.IP, "zone": zone, "osType": osT, "cpuType": cpuT, "osSource": osS, "cpuSource": cpuS})
		}
	}
	OK(c, gin.H{"targets": perTarget, "zones": zones, "unsupported": unsupported})
}

// ---------- 异步执行核心 ----------

// deployTargetRow 反序列化自 DeployJob.Targets JSON 的单台目标
type deployTargetRow struct {
	ID          uint    `json:"id"`
	Name        string  `json:"name"`
	IP          string  `json:"ip"`
	OsType      string  `json:"osType"`
	CpuType     string  `json:"cpuType"`
	Port        string  `json:"port"`
	User        string  `json:"user"`
	Pass        string  `json:"pass"`
	Become      string  `json:"become"`
	BecomePass  string  `json:"becomePass"`
	Zone        string  `json:"zone"` // 所属网络区域，用于自动分配执行节点
	Slots       []gin.H `json:"slots"`
	Role        string  `json:"role"`
	Coordinator bool    `json:"coordinator"`
}

// roleOfTarget 取单台目标的角色：资产目标按 AssetID 查 Topology；手动目标按 IP 查 ManualTopology。
// 两者互斥（资产 ID>0、手动 ID=0），分别从两个映射取角色，未配置则返回空串。
func roleOfTarget(t deployTargetRow, assetTopology map[uint]string, manualIPRole map[string]string) string {
	if t.ID != 0 {
		return assetTopology[t.ID]
	}
	return manualIPRole[t.IP]
}

// resolveDeployRemotes 依据各目标服务器的「所属网络区域」自动匹配 Ansible 控制节点。
// 返回 (区域->节点 映射, 错误信息, 映射JSON)。错误信息为空表示全部解析成功；
// 错误信息会明确引导：服务器未填网络区域 -> 先到资产管理录入；某区域无节点 -> 到 Ansible 节点管理添加。
func resolveDeployRemotes(targets []deployTargetRow) (map[string]AnsibleRemote, string, string) {
	var remotes []AnsibleRemote
	DB.Order("id asc").Find(&remotes)
	byZone := map[string]AnsibleRemote{}
	for _, r := range remotes {
		if r.NetworkZone == "" {
			continue
		}
		if _, ok := byZone[r.NetworkZone]; !ok {
			byZone[r.NetworkZone] = r
		}
	}
	zoneRemotes := map[string]AnsibleRemote{}
	missZone := []string{}
	missNode := map[string]bool{}
	for _, t := range targets {
		if t.Zone == "" {
			missZone = append(missZone, fmt.Sprintf("%s(%s)", t.Name, t.IP))
			continue
		}
		if _, ok := zoneRemotes[t.Zone]; ok {
			continue
		}
		r, ok := byZone[t.Zone]
		if !ok {
			missNode[t.Zone] = true
			continue
		}
		zoneRemotes[t.Zone] = r
	}
	var msg string
	if len(missZone) > 0 {
		msg = "以下服务器未填写「所属网络区域」，无法分配执行节点，请先在「资产管理」录入服务器信息（含所属网络区域）：" + strings.Join(missZone, "、")
	}
	if len(missNode) > 0 {
		zones := make([]string, 0, len(missNode))
		for z := range missNode {
			zones = append(zones, z)
		}
		extra := "；网络区域「" + strings.Join(zones, "」「") + "」未配置执行节点，请在「Ansible 节点管理」添加该区域的 Ansible 控制节点"
		if msg != "" {
			msg += extra
		} else {
			msg = "网络区域「" + strings.Join(zones, "」「") + "」未配置执行节点，请在「Ansible 节点管理」添加该区域的 Ansible 控制节点"
		}
	}
	if msg != "" {
		return nil, msg, "{}"
	}
	idMap := map[string]uint{}
	for z, r := range zoneRemotes {
		idMap[z] = r.ID
	}
	b, _ := json.Marshal(idMap)
	return zoneRemotes, "", string(b)
}

// ---------- Ansible 接入方式：platform（平台自建临时 inventory）/ group（复用 Jenkins 组）----------
//
// 背景：Jenkins pipeline 先做「资源整理」——把本批次目标的连接信息（IP + ansible_ssh_port /
// ansible_ssh_user / ansible_ssh_pass / ansible_become_pass，全部取自资源清单）临时写进 ansible
// 主机组「<15位随机数>-应用安装」，再 `ansible-playbook -e 'hosts=<组名> CPU_TYPE=<cpu>' <playbook>`
// 执行。平台默认写自己的临时 inventory（更可控、不依赖控制节点脚本）；组模式则复刻 Jenkins 的做法。
//
// 约束：组模式只提供「主机连通性」，不携带平台通用 playbook 所需的每台离线包变量
// （mw0_pkg 等），因此仅兼容「自包含 playbook 类型」（系统初始化 / GaussDB / Redis playbook）；
// 需要平台下发安装包的中间件（nginx/jdk/php/宝兰德）必须用 platform 模式。

const (
	InvModePlatform = "platform"
	InvModeGroup    = "group"
)

// resolveInventoryMode 解析本次的接入方式：请求级显式指定优先，其次全局配置，默认 platform。
func resolveInventoryMode(reqMode string) string {
	if m := strings.ToLower(strings.TrimSpace(reqMode)); m == InvModeGroup || m == InvModePlatform {
		return m
	}
	if strings.ToLower(strings.TrimSpace(Cfg.DeployInventoryMode)) == InvModeGroup {
		return InvModeGroup
	}
	return InvModePlatform
}

// controlNodeCDIR 控制节点上脚本根目录（CDIR）。DEPLOY_BASE 形如 <CDIR>/main/app_choice → 上两级。
func controlNodeCDIR() string {
	base := strings.TrimRight(Cfg.DeployBase, "/")
	return filepath.Dir(filepath.Dir(base))
}

// ansibleManagerScript 组模式下 ansible_host_manager.py 的绝对路径（未配置时按 CDIR 推导）。
func ansibleManagerScript() string {
	if p := strings.TrimSpace(Cfg.AnsibleHostManager); p != "" {
		return p
	}
	return filepath.Join(controlNodeCDIR(), "ansible_host_manager.py")
}

// controlNodeTmpDir 控制节点上的临时目录（<CDIR>/tmp），与 Jenkins 的 TMP_DIR 一致。
func controlNodeTmpDir() string {
	return filepath.Join(controlNodeCDIR(), "tmp")
}

// randProjectName 生成 15 位随机数字项目名（与 Jenkins pipeline 一致，用作组名与临时文件前缀）。
func randProjectName() string {
	const digits = "0123456789"
	b := make([]byte, 15)
	for i := range b {
		b[i] = digits[rand.Intn(len(digits))]
	}
	return string(b)
}

// shq 用单引号安全包裹 shell 参数（内部单引号按 POSIX 规则转义）。
func shq(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// shSingleDQ 生成 Jenkins 风格的 '"v"'（外层单引号保护、内层保留双引号）：
// python 脚本收到的实参是带双引号的 "v"。用于 ansible_host_manager.py 的密码参数。
func shSingleDQ(v string) string {
	return shq(`"` + v + `"`)
}

// hostConnVars 单台主机在 ansible inventory 中的连接变量，格式与 Jenkins「资源整理」写出的主机行一致：
//
//	198.51.100.115 ansible_ssh_port=65181 ansible_ssh_user=centos ansible_ssh_pass=xx ansible_become_pass=yy
//
// ansibleSSHCommonArgs 平台写入 inventory 主机行的 SSH 公共参数（中间件部署与系统初始化共用）。
//
// 两个关键点：
//  1. 值必须整体用双引号包裹。ansible 用 shlex 解析 INI 主机行，未加引号的
//     `ansible_ssh_common_args=-o StrictHostKeyChecking=no` 会被拆成 `-o` 与一个
//     孤立键值对 `StrictHostKeyChecking=no`，ssh 最终只拿到裸 `-o` 而报
//     “option requires an argument”，部署在第一步就失败；
//  2. StrictHostKeyChecking=no + UserKnownHostsFile=/dev/null —— 首次连接新主机
//     （known_hosts 无记录）或目标机重装后 host key 变化时，非交互环境下不会卡在
//     Host key verification failed。Jenkins 侧同样依赖这组参数，故此处与之对齐。
const ansibleSSHCommonArgs = `ansible_ssh_common_args="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"`

// hostConnVars 单台主机在 ansible inventory 中的连接变量，格式与 Jenkins「资源整理」写出的主机行一致：
//
//	198.51.100.115 ansible_ssh_port=65181 ansible_ssh_user=centos ansible_ssh_pass=xx ansible_become_pass=yy
//
// 取值全部来自资源清单：SSH端口 / 用户名（普通用户）/ 密码；提权密码由
// resolveZoneSudoPass 在目标机上实测得出（不直接取「超级管理员用户密码」，
// 因为 sudo 默认校验的是调用者密码，两者在多数环境并不相同）。
// become 用户非 root 时才额外下发 ansible_become_user（root 是 ansible 默认值，无需显式指定）。
// 目标机为免密 sudo 时 BecomePass 为空 → 不下发 ansible_become_pass（空密码反而会认证失败）。
// 值统一加双引号：ansible INI 解析对含 # / 空格 / 括号（如密码 qzH]Gtc32nBQFHH[G）的值更安全。
func hostConnVars(t deployTargetRow) string {
	port := strings.TrimSpace(t.Port)
	if port == "" {
		port = "22"
	}
	user := strings.TrimSpace(t.User)
	if user == "" {
		user = "root"
	}
	var sb strings.Builder
	sb.WriteString("ansible_ssh_port=" + quote(port))
	sb.WriteString(" ansible_ssh_user=" + quote(user))
	sb.WriteString(" ansible_ssh_pass=" + quote(t.Pass))
	if become := strings.TrimSpace(t.Become); become != "" && become != "root" {
		sb.WriteString(" ansible_become_user=" + quote(become))
	}
	sb.WriteString(" ansible_become_method=sudo")
	if p := strings.TrimSpace(t.BecomePass); p != "" {
		sb.WriteString(" ansible_become_pass=" + quote(p))
	}
	sb.WriteString(" " + ansibleSSHCommonArgs)
	return sb.String()
}

// groupCredSig 主机 SSH 凭据指纹。Jenkins 的 ansible_host_manager.py 一次只接收一套 SSH 凭据
// （端口/用户/密码/提权密码），用该指纹判断本批次能否安全共用一套。
func groupCredSig(t deployTargetRow) string {
	return strings.Join([]string{
		strings.TrimSpace(t.Port), strings.TrimSpace(t.User), t.Pass,
		strings.TrimSpace(t.Become), t.BecomePass,
	}, "\x00")
}

// zoneOSCPU 归纳一个网络区域（一次 ansible-playbook 调用）的 OS / CPU 令牌，用于 -e 透传，
// 等价 Jenkins 的 `ansible-playbook -e 'hosts=xxx-应用安装 CPU_TYPE=x86_64'`。
// 区域内取值一致（常态）→ 返回该值；存在多种取值 → mixed=true，此时不下发 -e（避免用一台的
// 架构覆盖另一台），platform 模式仍由每台主机的 cpu_type / CPU_TYPE 变量各自生效。
func zoneOSCPU(targets []deployTargetRow) (os, cpu string, mixed bool) {
	for _, t := range targets {
		if v := strings.TrimSpace(t.OsType); v != "" {
			if os == "" {
				os = v
			} else if os != v {
				mixed = true
			}
		}
		if v := strings.TrimSpace(t.CpuType); v != "" {
			if cpu == "" {
				cpu = v
			} else if cpu != v {
				mixed = true
			}
		}
	}
	return
}

// groupSetup 组模式在控制节点上临时登记主机组的结果。
type groupSetup struct {
	Hosts   string // 组名：ansible-playbook -e hosts=<组名>
	InvArg  string // "" = 用控制节点默认 inventory（Jenkins 组已登记在其中）；否则 "-i <临时文件>"
	Note    string // 写入执行日志的说明
	Cleanup func()
}

// setupGroupInventory 组模式：在控制节点临时登记「<15位随机数>-应用安装」主机组，随后用
// `ansible-playbook -e "hosts=<组名> CPU_TYPE=<cpu>"` 执行，等价 Jenkins pipeline 的「资源整理」步骤。
//
// 两种落地方式：
//  1. 本批次目标 SSH 凭据一致（常态）→ 调用控制节点既有 ansible_host_manager.py 建组，
//     组登记在控制节点默认 inventory 中，调用 playbook 时不传 -i（真正“复用 Jenkins 组”）；
//  2. 凭据不一致 → 该脚本一次只能接收一套凭据，套用会出现「拿 A 机密码登 B 机」，
//     此时由平台在控制节点写一份等价的临时 inventory（同样的主机行格式、同样的组名），用 -i 指定。
func setupGroupInventory(client SSHClient, stamp string, targets []deployTargetRow) (groupSetup, error) {
	gs := groupSetup{Cleanup: func() {}}
	if len(targets) == 0 {
		return gs, fmt.Errorf("无目标服务器")
	}
	proj := randProjectName()
	gs.Hosts = proj + "-应用安装"

	sameCreds := true
	sig := groupCredSig(targets[0])
	for _, t := range targets[1:] {
		if groupCredSig(t) != sig {
			sameCreds = false
			break
		}
	}

	if sameCreds {
		script := ansibleManagerScript()
		tmpDir := controlNodeTmpDir()
		ipList := filepath.Join(tmpDir, proj+"_IP_LIST.list")
		t := targets[0]
		rootDirect := "false"
		if strings.EqualFold(strings.TrimSpace(t.User), "root") {
			rootDirect = "true"
		}
		var lines strings.Builder
		for _, x := range targets {
			if ip := strings.TrimSpace(x.IP); ip != "" {
				lines.WriteString(ip + "\n")
			}
		}

		if _, err := client.Run("mkdir -p " + shq(tmpDir)); err != nil {
			return groupSetup{Cleanup: func() {}}, fmt.Errorf("创建控制节点临时目录失败: %w", err)
		}
		if err := client.WriteFile(ipList, lines.String()); err != nil {
			return groupSetup{Cleanup: func() {}}, fmt.Errorf("写入 IP 列表失败: %w", err)
		}
		gs.Cleanup = func() { client.Run("rm -f " + shq(ipList)) }

		prefix := ctlRunPrefix(client, script)
		inner := fmt.Sprintf("python3 %s %s %s %s %s %s --ip-file %s --root-direct-con %s",
			shq(script), shq(proj), shq(t.Port), shq(t.User), shSingleDQ(t.Pass), shSingleDQ(t.BecomePass),
			shq(ipList), shq(rootDirect))
		out, err := client.Run(prefix + "bash -lc " + shq(inner))
		if err != nil {
			gs.Cleanup()
			return groupSetup{Cleanup: func() {}}, fmt.Errorf("ansible_host_manager.py 执行失败（请确认控制节点存在 %s）: %v\n%s", script, err, out)
		}
		gs.Note = fmt.Sprintf("ℹ️ Ansible 接入：复用 Jenkins 主机组「%s」（ansible_host_manager.py 登记 %d 台，连接信息取自资源清单）\n",
			gs.Hosts, len(targets))
		return gs, nil
	}

	invPath := "/tmp/ophub_grp_" + stamp + ".ini"
	var b strings.Builder
	b.WriteString("[" + gs.Hosts + "]\n")
	for _, t := range targets {
		if ip := strings.TrimSpace(t.IP); ip != "" {
			b.WriteString(ip + " " + hostConnVars(t) + "\n")
		}
	}
	if err := client.WriteFile(invPath, b.String()); err != nil {
		return groupSetup{Cleanup: func() {}}, fmt.Errorf("写入组模式临时 inventory 失败: %w", err)
	}
	gs.InvArg = "-i " + quote(invPath)
	gs.Cleanup = func() { client.Run("rm -f " + quote(invPath)) }
	gs.Note = fmt.Sprintf("ℹ️ Ansible 接入：临时主机组「%s」（本批次 %d 台 SSH 凭据不一致，改为逐台下发连接信息；未调用 ansible_host_manager.py）\n",
		gs.Hosts, len(targets))
	return gs, nil
}

// runDeployJob 按网络区域分组，在各自的控制节点上并行/顺序执行 ansible-playbook。
func runDeployJob(jobID uint, mwList []DeployMiddleware, mwCerts []MwCertSpec, version string, zoneRemotes map[string]AnsibleRemote, targetsJSON, redisMode, redisNodesJSON, invMode string) {
	setJob := func(status, output, errMsg string) {
		var job DeployJob
		if DB.First(&job, jobID).Error != nil {
			return
		}
		job.Status = status
		if output != "" {
			job.Output = output
		}
		job.ErrorMsg = errMsg
		now := time.Now()
		job.FinishedAt = &now
		job.UpdatedAt = now
		DB.Save(&job)
	}
	var job DeployJob
	if DB.First(&job, jobID).Error != nil {
		return
	}
	job.Status = "running"
	job.UpdatedAt = time.Now()
	DB.Save(&job)

	// 解析目标
	var targets []deployTargetRow
	if err := json.Unmarshal([]byte(targetsJSON), &targets); err != nil {
		setJob("failed", "", "目标解析失败: "+err.Error())
		return
	}
	if len(targets) == 0 {
		setJob("failed", "", "任务无目标服务器")
		return
	}

	// 按网络区域分组（保持首次出现顺序）
	groups := map[string][]deployTargetRow{}
	var order []string
	for _, t := range targets {
		if _, ok := groups[t.Zone]; !ok {
			groups[t.Zone] = nil
			order = append(order, t.Zone)
		}
		groups[t.Zone] = append(groups[t.Zone], t)
	}

	var buf strings.Builder
	var firstErr string
	for _, zone := range order {
		remote, ok := zoneRemotes[zone]
		if !ok {
			msg := fmt.Sprintf("网络区域「%s」未找到对应的执行节点", zone)
			buf.WriteString("\n[ERROR] " + msg + "\n")
			if firstErr == "" {
				firstErr = msg
			}
			continue
		}
		out, runErr := deployZone(remote.ToSSHClient(), fmt.Sprintf("%d_%s", jobID, zone), zone, groups[zone], len(mwList), mwCerts, redisMode, redisNodesJSON, mwList, invMode)
		buf.WriteString(fmt.Sprintf("\n================ 网络区域：%s（控制节点 %s / %s）================\n", zone, remote.Name, remote.Host))
		buf.WriteString(out)
		if runErr != nil {
			msg := fmt.Sprintf("网络区域 %s 执行失败: %s", zone, runErr.Error())
			buf.WriteString("\n[ERROR] " + msg + "\n")
			if firstErr == "" {
				firstErr = msg
			}
		}
	}

	if firstErr != "" {
		setJob("failed", buf.String(), firstErr)
		return
	}
	setJob("success", buf.String(), "")
}

// deployZone 在指定控制节点上，针对该网络区域下的一组目标执行 ansible-playbook。
func deployZone(client SSHClient, stamp, zone string, targets []deployTargetRow, slotCount int, mwCerts []MwCertSpec, redisMode, redisNodesJSON string, mwList []DeployMiddleware, invMode string) (string, error) {
	// 0) 解析 sudo 提权密码：资源清单的「超级管理员用户密码」在多数环境并非 sudo
	//    实际校验的密码（sudo 默认校验调用者密码）→ 直连目标机实测后再写进 inventory，
	//    否则 ansible 会在 Gathering Facts 就报 "Incorrect sudo password"。
	sudoNotes := resolveZoneSudoPass(targets)

	// OS/CPU 自动探测：资产未登记「操作系统版本 / CPU类型」时，后台探测补全（与系统初始化一致）
	for i := range targets {
		if targets[i].OsType == "" || targets[i].CpuType == "" {
			detOs, detCpu, derr := detectOSCPU(client, targets[i])
			if derr != nil {
				return "", fmt.Errorf("目标 %s 操作系统/CPU 探测失败：%w", targets[i].IP, derr)
			}
			if targets[i].OsType == "" {
				targets[i].OsType = detOs
			}
			if targets[i].CpuType == "" {
				targets[i].CpuType = detCpu
			}
		}
	}

	invPath := "/tmp/ophub_inv_" + stamp + ".ini"
	pbPath := "/tmp/ophub_pb_" + stamp + ".yml"
	certDir := "/tmp/ophub_certs_" + stamp

	// Ansible 接入方式：group 模式临时登记「<15位随机数>-应用安装」主机组（不写平台 inventory，
	// 也不传 -i）；platform 模式写平台临时 inventory 并用 -i 指定。
	// -i 参数值用双引号引用：文件名形如 ophub_inv_<job>_<网络区域>.ini，区域名可能含中文/空格
	invArg := "-i " + quote(invPath)
	hostsVal := "mw_targets"
	groupNote := ""
	groupCleanup := func() {}
	if invMode == InvModeGroup {
		gs, err := setupGroupInventory(client, stamp, targets)
		if err != nil {
			return "", err
		}
		hostsVal, invArg, groupCleanup, groupNote = gs.Hosts, gs.InvArg, gs.Cleanup, gs.Note
	}
	defer groupCleanup()

	// 本区域的 OS/CPU 令牌（用于 -e 透传，等价 Jenkins 的 -e 'hosts=<组> CPU_TYPE=x86_64'）
	zoneOs, zoneCpu, zoneMixed := zoneOSCPU(targets)

	// 1) 写临时 inventory（每台主机的连接信息 + 每个中间件槽位的离线包路径）
	var inv strings.Builder
	inv.WriteString("[mw_targets]\n")
	for _, t := range targets {
		_, sbin, confDir, root := nginxPaths(t.OsType)
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("%s %s os_type=%s cpu_type=%s OS_TYPE=%s CPU_TYPE=%s nginx_conf_dir=%s nginx_sbin=%s nginx_root=%s",
			strings.TrimSpace(t.IP), hostConnVars(t),
			quote(t.OsType), quote(t.CpuType), quote(t.OsType), quote(t.CpuType),
			quote(confDir), quote(sbin), quote(root)))
		for i, slot := range t.Slots {
			pkg, _ := slot["pkg"].(string)
			pkgDir, _ := slot["pkgDir"].(string)
			script, _ := slot["script"].(string)
			scriptName, _ := slot["scriptName"].(string)
			unpack, _ := slot["unpack"].(string)
			target, _ := slot["target"].(string)
			style, _ := slot["style"].(string)
			if style == "" {
				style = StyleCopy
			}
			sb.WriteString(fmt.Sprintf(" mw%d_pkg=%s mw%d_pkg_dir=%s mw%d_script=%s mw%d_script_name=%s mw%d_unpack=%s mw%d_target=%s mw%d_style=%s",
				i, quote(pkg), i, quote(pkgDir), i, quote(script), i, quote(scriptName),
				i, quote(unpack), i, quote(target), i, quote(style)))
			// 逐项证书变量：平台只把证书送到 mw{i}_cert_dir，具体 SSL 配置交给各中间件脚本
			hasCertSlot, _ := slot["hasCert"].(bool)
			certNameSlot, _ := slot["certName"].(string)
			certDirSlot, _ := slot["certDir"].(string)
			hasCaSlot, _ := slot["hasCa"].(bool)
			certSrcSlot := ""
			hasCertStr, hasCaStr := "False", "False"
			if hasCertSlot {
				hasCertStr = "True"
				certSrcSlot = fmt.Sprintf("%s/mw%d", certDir, i)
			}
			if hasCaSlot {
				hasCaStr = "True"
			}
			sb.WriteString(fmt.Sprintf(" mw%d_has_cert=%s mw%d_has_ca=%s mw%d_cert_name=%s mw%d_cert_dir=%s mw%d_cert_src=%s",
				i, quote(hasCertStr), i, quote(hasCaStr), i, quote(certNameSlot), i, quote(certDirSlot), i, quote(certSrcSlot)))
		}
		// 拓扑模式（如 Redis 集群/哨兵）：注入每台节点的角色与协调节点标记
		if redisMode != "" {
			role := t.Role
			if role == "" {
				role = "node"
			}
			sb.WriteString(fmt.Sprintf(" redis_role=%s redis_coordinator=%s",
				quote(role), quote(fmt.Sprintf("%v", t.Coordinator))))
		}
		sb.WriteString("\n")
		inv.WriteString(sb.String())
	}
	if invMode != InvModeGroup {
		if err := client.WriteFile(invPath, inv.String()); err != nil {
			return "", fmt.Errorf("写入临时 inventory 失败: %w", err)
		}
	}

	// 1.5) 若有拓扑模式，把全局拓扑变量写成 json 文件，供 ansible -e @file 读取
	redisVarsPath := ""
	if redisMode != "" {
		redisVarsPath = "/tmp/ophub_redis_" + stamp + ".json"
		rv, _ := json.Marshal(map[string]interface{}{
			"redis_mode":          redisMode,
			"redis_nodes_json":    redisNodesJSON,
			"redis_port":          redisDefaultPort,
			"redis_sentinel_port": redisSentinelPort,
		})
		if err := client.WriteFile(redisVarsPath, string(rv)); err != nil {
			return "", fmt.Errorf("写入拓扑变量失败: %w", err)
		}
	}

	// 2) 逐项把证书写到控制节点临时目录（每项一个子目录，避免多中间件同名证书互相覆盖）
	for i, c := range mwCerts {
		if !c.HasCert {
			continue
		}
		sub := fmt.Sprintf("%s/mw%d", certDir, i)
		if err := client.WriteFile(sub+"/"+c.CertName+".crt", c.Crt); err != nil {
			return "", fmt.Errorf("下发证书 CRT 失败（%s）: %w", c.CertName, err)
		}
		if err := client.WriteFile(sub+"/"+c.CertName+".key", c.Key); err != nil {
			return "", fmt.Errorf("下发证书 KEY 失败（%s）: %w", c.CertName, err)
		}
		if c.HasCa {
			_ = client.WriteFile(sub+"/"+c.CertName+".ca.crt", c.Ca)
		}
	}

	// 3) 预检：控制节点上的离线包 / 脚本 / playbook 是否存在
	//    两个网络区域（互联网 / 政务外网）的脚本可能不一致，缺失时提前给出明确提示，
	//    避免 ansible 跑到一半才失败。
	if miss := preflightCheck(client, mwList, targets); len(miss) > 0 {
		cleanup := "rm -f " + quote(invPath)
		if redisVarsPath != "" {
			cleanup += " " + quote(redisVarsPath)
		}
		client.Run(cleanup)
		return "", fmt.Errorf("执行节点 %s 上缺少离线文件：\n  - %s\n请在该区域的 Ansible 控制节点补齐后重试，或在“中间件部署配置”中调整路径",
			client.Host, strings.Join(miss, "\n  - "))
	}

	// 4) 组装并执行命令：
	//    先跑通用 playbook（copy / unarchive / dir 三种风格的槽位 + 可选 nginx 证书），
	//    再逐个执行 playbook 风格中间件自带的既有 yml（如 redis）。
	// 顶层变量保留给主中间件（nginx 等）使用；其余槽位走 mw{i}_* 变量
	mainHasCert := len(mwCerts) > 0 && mwCerts[0].HasCert
	hasCertStr := "False"
	certNameMain, certSrcMain := "", ""
	if mainHasCert {
		hasCertStr = "True"
		certNameMain = mwCerts[0].CertName
		certSrcMain = certDir + "/mw0"
	}
	// -e 变量：hosts（主机组）+ OS_TYPE / CPU_TYPE（资源清单取值，供 playbook 按架构/系统选包），
	// 与 Jenkins 的 `ansible-playbook -e 'hosts=<组> CPU_TYPE=x86_64'` 完全一致。
	args := fmt.Sprintf("hosts=%s has_cert=%s cert_name=%s cert_src=%s",
		hostsVal, hasCertStr, shellQuote(certNameMain), shellQuote(certSrcMain))
	if zoneCpu != "" && !zoneMixed {
		args += " CPU_TYPE=" + shellQuote(zoneCpu)
	}
	if zoneOs != "" && !zoneMixed {
		args += " OS_TYPE=" + shellQuote(zoneOs)
	}
	// 拓扑变量走独立的 -e @file：不能拼进上面那个 -e 字符串，否则 ansible 会把 "-e" 当作变量名
	topoArg := ""
	if redisVarsPath != "" {
		topoArg = " -e @" + redisVarsPath
	}

	var outBuf strings.Builder
	outBuf.WriteString(groupNote)
	outBuf.WriteString(sudoPassNotesBlock(sudoNotes))
	if zoneMixed {
		outBuf.WriteString("⚠️ 本区域目标存在多种操作系统/CPU 版本，未通过 -e 统一下发 OS_TYPE/CPU_TYPE（由每台主机变量各自生效）\n")
	} else if zoneCpu != "" || zoneOs != "" {
		outBuf.WriteString(fmt.Sprintf("🔍 资源清单取值：OS_TYPE=%s，CPU_TYPE=%s（随 -e 下发）\n", zoneOs, zoneCpu))
	}
	var runErr error
	if hasScriptSlot(mwList) {
		pb := buildDeployPlaybook(slotCount, mwList, mwCerts)
		if err := client.WriteFile(pbPath, pb); err != nil {
			return "", fmt.Errorf("写入 playbook 失败: %w", err)
		}
		// 不切换 cwd：group 模式（不传 -i）依赖控制节点默认 inventory（ansible.cfg 的
		// inventory 配置），`cd /tmp` 会改变 ansible.cfg 的搜索起点，可能让「复用 Jenkins 组」
		// 找不到刚登记的主机组。playbook 与 inventory 均为绝对路径，cwd 不影响它们。
		cmd := fmt.Sprintf("bash -lc 'ansible-playbook %s %s -e \"%s\"%s 2>&1'",
			pbPath, invArg, args, topoArg)
		var out string
		out, runErr = client.Run(cmd)
		outBuf.WriteString(out)
	}
	if runErr == nil {
		for _, mw := range mwList {
			if mw.StyleOrCopy() != StylePlaybook || strings.TrimSpace(mw.Playbook) == "" {
				continue
			}
			outBuf.WriteString(fmt.Sprintf("\n---- 执行既有 playbook：%s（%s）----\n", mw.Playbook, mw.Label))
			// 既有 playbook 同样依赖 CPU_TYPE / OS_TYPE（如 redis 按架构取离线包）
			pbArgs := "hosts=" + hostsVal
			if zoneCpu != "" && !zoneMixed {
				pbArgs += " CPU_TYPE=" + shellQuote(zoneCpu)
			}
			if zoneOs != "" && !zoneMixed {
				pbArgs += " OS_TYPE=" + shellQuote(zoneOs)
			}
			prefix := ctlRunPrefix(client, mw.Playbook)
			// 既有 playbook 是 Jenkins 侧编写、自包含的（端口/路径写在 yml 内），
			// 只透传 hosts + OS_TYPE/CPU_TYPE，不注入平台内部的拓扑变量，避免与 yml 自身默认值冲突。
			cmd := prefix + fmt.Sprintf("bash -lc 'ansible-playbook %s %s -e \"%s\" 2>&1'",
				mw.Playbook, invArg, pbArgs)
			out, err := client.Run(cmd)
			outBuf.WriteString(out)
			if err != nil {
				runErr = err
				break
			}
		}
	}
	out := outBuf.String()

	// 5) 清理控制节点临时文件（尽力而为）
	cleanup := "rm -f " + quote(invPath) + " " + quote(pbPath)
	if redisVarsPath != "" {
		cleanup += " " + quote(redisVarsPath)
	}
	cleanup += " && rm -rf " + quote(certDir)
	client.Run(cleanup)

	return out, runErr
}

// hasScriptSlot 是否存在需要平台生成任务的槽位（copy / unarchive / dir）。
// playbook 风格由控制节点既有 yml 负责，不进通用 playbook。
func hasScriptSlot(mwList []DeployMiddleware) bool {
	for _, m := range mwList {
		if m.StyleOrCopy() != StylePlaybook {
			return true
		}
	}
	return false
}

// controlNodeMissing 批量检查控制节点上的文件是否存在，返回缺失清单（为空=全部就位）。
//
// 三态语义：只有命令**成功执行**时才相信输出；命令失败（受限目录不可读、SSH 异常等）
// 返回 nil 不阻断部署 —— 避免因权限探测误报把本来可用的任务拦下，交由后续实际执行报错。
// 单条命令批量检查以省下 SSH 往返；控制节点脚本根目录多为 root 权限，先 sudo -n 再回退当前用户。
// 中间件部署（preflightCheck）与系统初始化（sysInitZone）共用同一口径。
func controlNodeMissing(client SSHClient, files []string) []string {
	if len(files) == 0 {
		return nil
	}
	var sb strings.Builder
	sb.WriteString("for f in")
	for _, f := range files {
		sb.WriteString(" " + shellQuotePath(f))
	}
	sb.WriteString("; do [ -e \"$f\" ] || echo \"MISSING:$f\"; done")
	out, err := client.Run(ctlCmdWithSudoFallback(sb.String()))
	if err != nil {
		return nil
	}
	var miss []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "MISSING:") {
			miss = append(miss, strings.TrimSpace(strings.TrimPrefix(line, "MISSING:")))
		}
	}
	return miss
}

// preflightCheck 预检控制节点上本批次所需的离线文件（离线包 / 脚本 / 既有 playbook）是否存在。
// 返回缺失文件列表（为空表示全部就位）。两个网络区域（互联网 / 政务外网）的脚本可能不一致，
// 缺失时提前给出明确提示，避免 ansible 跑到一半才失败。
func preflightCheck(client SSHClient, mwList []DeployMiddleware, targets []deployTargetRow) []string {
	need := map[string]bool{}
	for _, mw := range mwList {
		if mw.StyleOrCopy() == StylePlaybook {
			if strings.TrimSpace(mw.Playbook) != "" {
				need[mw.Playbook] = true
			}
		}
	}
	for _, t := range targets {
		for i, slot := range t.Slots {
			if i >= len(mwList) {
				break
			}
			style := mwList[i].StyleOrCopy()
			if style == StylePlaybook {
				continue // 既有 playbook 内部自行取包，已在上面校验
			}
			pkg, _ := slot["pkg"].(string)
			script, _ := slot["script"].(string)
			if pkg != "" {
				need[pkg] = true
			}
			// dir 风格下发整个 files 目录，脚本位于其中
			if script != "" && style != StyleUnarchive {
				need[script] = true
			}
		}
	}
	files := make([]string, 0, len(need))
	for f := range need {
		files = append(files, f)
	}
	sort.Strings(files)
	return controlNodeMissing(client, files)
}

// shellQuotePath 用单引号包裹路径（控制节点本地 shell，路径均为平台登记值）
func shellQuotePath(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// buildDeployPlaybook 生成通用部署 playbook：
// 每个中间件槽位（mw0 为主，mw1+ 为额外勾选）按自身风格安装：
//
//	copy      → 上传安装包 + 部署脚本，执行脚本；
//	unarchive → 上传并解压安装包，执行包内同名脚本；
//	dir       → 上传整个 files 目录，执行目录内脚本；
//	playbook  → 跳过（由控制节点既有 yml 单独执行）。
//
// 证书按槽位逐项下发（mw{i}_* 变量）：平台只把 CRT/KEY/CA 送到 mw{i}_cert_dir，
// 并通过 HAS_CERT / CERT_NAME / CERT_DIR / CERT_CRT / CERT_KEY / CERT_CA 环境变量
// 把路径交给安装脚本，由各中间件脚本自行完成 SSL 配置（如 宝兰德 BWS310）；
// nginx 例外：平台额外写入虚拟主机配置并 reload。
func buildDeployPlaybook(slotCount int, mwList []DeployMiddleware, mwCerts []MwCertSpec) string {
	var b strings.Builder
	b.WriteString(`---
- hosts: "{{ hosts }}"
  gather_facts: false
  become: true
  become_user: root
  vars:
    nginx_conf_dir: "{{ nginx_conf_dir }}"
    nginx_sbin: "{{ nginx_sbin }}"
    nginx_root: "{{ nginx_root }}"
    redis_mode: "{{ redis_mode | default('standalone') }}"
    redis_nodes_json: "{{ redis_nodes_json | default('[]') }}"
    redis_port: "{{ redis_port | default(6379) }}"
    redis_sentinel_port: "{{ redis_sentinel_port | default(26379) }}"
  tasks:
`)
	// 证书环境变量：注入安装脚本，脚本据此自行配置 SSL
	// HAS_CA 必须一并注入：脚本要据此判断是否把 CA 链接入信任库（未开 CA 时
	// CERT_CA 指向的 .ca.crt 并不存在，直接引用会失败）。
	certEnv := func(i int) string {
		return fmt.Sprintf(`        HAS_CERT: "{{ mw%d_has_cert }}"
        HAS_CA: "{{ mw%d_has_ca }}"
        CERT_NAME: "{{ mw%d_cert_name }}"
        CERT_DIR: "{{ mw%d_cert_dir }}"
        CERT_CRT: "{{ mw%d_cert_dir }}/{{ mw%d_cert_name }}.crt"
        CERT_KEY: "{{ mw%d_cert_dir }}/{{ mw%d_cert_name }}.key"
        CERT_CA: "{{ mw%d_cert_dir }}/{{ mw%d_cert_name }}.ca.crt"
`, i, i, i, i, i, i, i, i, i, i)
	}
	// certTasks 该槽位的证书下发任务（先于安装脚本执行，脚本内即可直接读取）
	certTasks := func(i int, label string) string {
		return fmt.Sprintf(`    - name: "创建证书目录 [%s]"
      file:
        path: "{{ mw%d_cert_dir }}"
        state: directory
        mode: "0755"
      when: mw%d_has_cert | bool

    - name: "下发证书 CRT [%s]"
      copy:
        src: "{{ mw%d_cert_src }}/{{ mw%d_cert_name }}.crt"
        dest: "{{ mw%d_cert_dir }}/{{ mw%d_cert_name }}.crt"
        mode: "0644"
      when: mw%d_has_cert | bool

    - name: "下发证书 KEY [%s]"
      copy:
        src: "{{ mw%d_cert_src }}/{{ mw%d_cert_name }}.key"
        dest: "{{ mw%d_cert_dir }}/{{ mw%d_cert_name }}.key"
        mode: "0600"
      when: mw%d_has_cert | bool

    - name: "下发 CA 链 [%s]"
      copy:
        src: "{{ mw%d_cert_src }}/{{ mw%d_cert_name }}.ca.crt"
        dest: "{{ mw%d_cert_dir }}/{{ mw%d_cert_name }}.ca.crt"
        mode: "0644"
      when: mw%d_has_cert | bool and mw%d_has_ca | bool

`, label, i, i, label, i, i, i, i, i, label, i, i, i, i, i, label, i, i, i, i, i, i)
	}
	// nginx 槽位（证书需额外写虚拟主机并 reload）
	nginxIdx := -1
	for i := range mwList {
		if mwList[i].Name == "nginx" {
			nginxIdx = i
			break
		}
	}
	for i := 0; i < slotCount; i++ {
		label := "中间件"
		style := StyleCopy
		if i < len(mwList) {
			label = mwList[i].Label
			style = mwList[i].StyleOrCopy()
		}
		if style == StylePlaybook {
			continue // 由控制节点既有 playbook 单独执行
		}
		slotHasCert := i < len(mwCerts) && mwCerts[i].HasCert
		switch style {
		case StyleUnarchive:
			// 上传并解压安装包（如 php：包内自带同名安装脚本）
			b.WriteString(fmt.Sprintf(`    - name: "上传并解压安装包 [%s]"
      unarchive:
        src: "{{ mw%d_pkg }}"
        dest: "/tmp/"
        remote_src: no
      when: mw%d_pkg != ""

`, label, i, i))
		case StyleDir:
			// 上传整个 files 目录再执行脚本（如 宝兰德 BWS310：脚本依赖同目录配置文件）
			b.WriteString(fmt.Sprintf(`    - name: "上传安装文件目录 [%s]"
      copy:
        src: "{{ mw%d_pkg_dir }}/"
        dest: "/tmp/"
      when: mw%d_pkg != ""

`, label, i, i))
		default:
			// copy：上传安装包 + 部署脚本（nginx / jdk）
			b.WriteString(fmt.Sprintf(`    - name: "上传安装包 [%s]"
      copy:
        src: "{{ mw%d_pkg }}"
        dest: "/tmp/"
      when: mw%d_pkg != ""

    - name: "上传部署脚本 [%s]"
      copy:
        src: "{{ mw%d_script }}"
        dest: "/tmp/"
      when: mw%d_pkg != "" and mw%d_script != ""

`, label, i, i, label, i, i, i))
		}
		// 证书文件先落地，安装脚本执行时即可读取
		if slotHasCert {
			b.WriteString(certTasks(i, label))
		}
		// 执行安装脚本（注入证书环境变量，脚本自行完成 SSL 配置）
		switch style {
		case StyleUnarchive:
			b.WriteString(fmt.Sprintf(`    - name: "执行包内安装脚本 [%s]"
      command: "bash /tmp/{{ mw%d_unpack }}/{{ mw%d_unpack }}.sh"
      environment:
%s      when: mw%d_pkg != ""

`, label, i, i, certEnv(i), i))
		case StyleDir:
			b.WriteString(fmt.Sprintf(`    - name: "执行部署脚本 [%s]"
      command: "bash /tmp/{{ mw%d_script_name }}"
      environment:
%s      when: mw%d_pkg != "" and mw%d_script_name != ""

`, label, i, certEnv(i), i, i))
		default:
			b.WriteString(fmt.Sprintf(`    - name: "执行部署脚本 [%s]"
      command: "bash /tmp/{{ mw%d_script_name }} {{ mw%d_target }}"
      environment:
%s        REDIS_MODE: "{{ redis_mode }}"
        REDIS_ROLE: "{{ redis_role | default('node') }}"
        REDIS_COORDINATOR: "{{ redis_coordinator | default('false') }}"
        REDIS_PORT: "{{ redis_port }}"
        REDIS_SENTINEL_PORT: "{{ redis_sentinel_port }}"
        REDIS_NODES_JSON: "{{ redis_nodes_json }}"
      when: mw%d_pkg != "" and mw%d_script_name != ""

`, label, i, i, certEnv(i), i, i))
		}
	}
	// nginx 专属：证书已下发到 nginx_conf_dir/ssl，这里补虚拟主机配置并重载
	if nginxIdx >= 0 && nginxIdx < len(mwCerts) && mwCerts[nginxIdx].HasCert {
		n := nginxIdx
		b.WriteString(fmt.Sprintf(`    - name: "创建 conf.d 目录（存放 SSL 虚拟主机）"
      file:
        path: "{{ nginx_conf_dir }}/conf.d"
        state: directory
        mode: "0755"
      when: mw%d_has_cert | bool

    - name: "写入 SSL 虚拟主机配置"
      copy:
        content: |
          server {
              listen 443 ssl;
              server_name {{ mw%d_cert_name }};
              ssl_certificate     {{ mw%d_cert_dir }}/{{ mw%d_cert_name }}.crt;
              ssl_certificate_key {{ mw%d_cert_dir }}/{{ mw%d_cert_name }}.key;
              location / {
                  root {{ nginx_root }};
                  index index.html index.htm;
              }
          }
        dest: "{{ nginx_conf_dir }}/conf.d/{{ mw%d_cert_name }}.conf"
      when: mw%d_has_cert | bool

    - name: "重载 nginx 使配置生效"
      command: "{{ nginx_sbin }} -s reload"
      when: mw%d_has_cert | bool
`, n, n, n, n, n, n, n, n, n))
	}
	return b.String()
}

// nginxPaths 按操作系统返回 nginx 安装前缀/可执行/配置目录/默认根目录
func nginxPaths(osType string) (prefix, sbin, confDir, root string) {
	switch osType {
	case "openEuler20.03":
		return "/data/nginx", "/data/nginx/sbin/nginx", "/data/nginx/conf", "/data/wwwroot/default"
	default: // centos7 / almalinux8.9
		return "/opt/servers/nginx", "/opt/servers/nginx/sbin/nginx", "/opt/servers/nginx/conf", "/opt/wwwroot/default"
	}
}

// quote 用于 inventory 主机变量的双引号包裹（去除可能破坏 INI 的引号/反斜杠）
func quote(s string) string {
	s = strings.ReplaceAll(s, "\\", "")
	s = strings.ReplaceAll(s, "\"", "")
	s = strings.ReplaceAll(s, "\n", "")
	return "\"" + s + "\""
}

// shellQuote 用于命令 -e 参数值的安全包裹（仅允许安全字符，去除危险字符）
func shellQuote(s string) string {
	s = strings.ReplaceAll(s, "'", "")
	s = strings.ReplaceAll(s, "\"", "")
	s = strings.ReplaceAll(s, "$", "")
	s = strings.ReplaceAll(s, "`", "")
	s = strings.ReplaceAll(s, "\\", "")
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, ";", "")
	s = strings.ReplaceAll(s, "&", "")
	s = strings.ReplaceAll(s, "|", "")
	s = strings.ReplaceAll(s, ">", "")
	s = strings.ReplaceAll(s, "<", "")
	s = strings.ReplaceAll(s, "(", "")
	s = strings.ReplaceAll(s, ")", "")
	return s
}
