package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// Prometheus 监控（v1.8.0 新增，独立大类）
//
// 设计要点：
//   - 数据源落库（PromDataSource），后端做统一代理：前端永远不直连 Prometheus，
//     避免 CORS / 凭据泄露，Basic/Bearer 凭据只在后端解密使用。
//   - 查询走 Prometheus 官方 HTTP API（/api/v1/query、/api/v1/query_range、
//     /api/v1/label/__name__/values），全部只读（GET），不存在写风险。
//   - 大屏/报表用的聚合指标基于 node_exporter 标准指标口径：
//       CPU  使用率 = 100 * (1 - avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[W])))
//       内存使用率 = 100 * (1 - MemAvailable / MemTotal)
//       磁盘使用率 = max by(instance)(100 * (1 - avail/size))（排除 tmpfs/overlay 等伪文件系统）
//   - ⚠️ Enabled 是布尔语义字段，禁止 gorm default 标签（零值被忽略的坑）。
//
// 权限：prom:view（查看全部）/ prom:manage（管理数据源）/ prom:screen（只看大屏）。
// ============================================================================

// promHTTPTimeout 单次请求 Prometheus 的超时
const promHTTPTimeout = 15 * time.Second

// PromDataSource Prometheus 数据源
type PromDataSource struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"size:64;uniqueIndex" json:"name"`
	URL         string    `gorm:"size:255" json:"url"` // 形如 http://prom:9090
	AuthType    string    `gorm:"size:16" json:"authType"`
	Username    string    `gorm:"size:64" json:"username"`
	PasswordEnc string    `json:"-"` // AES-GCM 密文，不回传前端
	BearerToken string    `json:"-"` // 明文存储，不回传前端
	Enabled     int       `json:"enabled"`
	Remark      string    `gorm:"size:255" json:"remark"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	// authConfigured 是否已配置密码 / token（仅展示用，gorm:"-"）
	AuthConfigured bool `gorm:"-" json:"authConfigured"`
}

// withPromAuthFlags 就地填充 AuthConfigured（列表 / 详情回显用）
func withPromAuthFlags(list []PromDataSource) {
	for i := range list {
		list[i].AuthConfigured = list[i].PasswordEnc != "" || list[i].BearerToken != ""
	}
}

// promAuthBody 创建 / 更新数据源的请求体
type promAuthBody struct {
	Name        string `json:"name"`
	URL         string `json:"url"`
	AuthType    string `json:"authType"`
	Username    string `json:"username"`
	Password    string `json:"password"` // 更新时留空 = 保持原密码
	BearerToken string `json:"bearerToken"`
	Enabled     *int   `json:"enabled"` // 指针区分「未传」与「显式 0」
	Remark      string `json:"remark"`
}

// validatePromBody 校验并规范化数据源请求体
func validatePromBody(b *promAuthBody) error {
	b.Name = strings.TrimSpace(b.Name)
	b.URL = strings.TrimRight(strings.TrimSpace(b.URL), "/")
	if b.Name == "" {
		return fmt.Errorf("请填写数据源名称")
	}
	if len(b.Name) > 64 {
		return fmt.Errorf("数据源名称过长（上限 64 字符）")
	}
	if b.URL == "" {
		return fmt.Errorf("请填写 Prometheus 地址")
	}
	if !strings.HasPrefix(b.URL, "http://") && !strings.HasPrefix(b.URL, "https://") {
		return fmt.Errorf("地址必须以 http:// 或 https:// 开头：%s", b.URL)
	}
	// 禁止在 URL 里内嵌凭据（http://user:pass@host）—— 凭据必须走认证字段
	if strings.Contains(b.URL, "@") {
		return fmt.Errorf("地址不允许包含 @（请在「认证方式」里填写凭据）")
	}
	if b.AuthType == "" {
		b.AuthType = "none"
	}
	switch b.AuthType {
	case "none", "basic", "bearer":
	default:
		return fmt.Errorf("认证方式不合法：%s（可选 none / basic / bearer）", b.AuthType)
	}
	if b.AuthType == "basic" && b.Username == "" {
		return fmt.Errorf("Basic 认证需要填写用户名")
	}
	if b.AuthType == "bearer" && b.BearerToken == "" {
		return fmt.Errorf("Bearer 认证需要填写 Token")
	}
	return nil
}

// ---------------------------------------------------------------------------
// Prometheus HTTP API 客户端
// ---------------------------------------------------------------------------

// promClient 单个数据源的只读客户端
type promClient struct {
	base     string
	authType string
	username string
	password string
	token    string
	http     *http.Client
}

// newPromClient 从数据源记录构建客户端（密码解密失败报错）
func newPromClient(ds *PromDataSource) (*promClient, error) {
	c := &promClient{
		base:     strings.TrimRight(ds.URL, "/"),
		authType: ds.AuthType,
		username: ds.Username,
		token:    ds.BearerToken,
		http:     &http.Client{Timeout: promHTTPTimeout},
	}
	if ds.PasswordEnc != "" {
		plain, err := decryptField(ds.PasswordEnc)
		if err != nil {
			return nil, fmt.Errorf("解密密码失败：%v", err)
		}
		c.password = plain
	}
	return c, nil
}

// promSample 即时向量样本
type promSample struct {
	Metric map[string]string `json:"metric"`
	Value  []interface{}     `json:"value"` // [ts, "value"]
}

// promSeries 区间向量序列
type promSeries struct {
	Metric map[string]string `json:"metric"`
	Values [][]interface{}   `json:"values"` // [[ts, "value"], ...]
}

// promAPIResp Prometheus /api/v1/* 统一响应
type promAPIResp struct {
	Status string          `json:"status"`
	Error  string          `json:"error"`
	Data   json.RawMessage `json:"data"`
}

// promQueryData data 节点
type promQueryData struct {
	ResultType string          `json:"resultType"`
	Result     json.RawMessage `json:"result"`
}

// api 调用 Prometheus 只读 GET 接口
func (p *promClient) api(ctx context.Context, path string, q url.Values, out *promAPIResp) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.base+path+"?"+q.Encode(), nil)
	if err != nil {
		return fmt.Errorf("构造请求失败：%v", err)
	}
	switch p.authType {
	case "basic":
		req.SetBasicAuth(p.username, p.password)
	case "bearer":
		req.Header.Set("Authorization", "Bearer "+p.token)
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return fmt.Errorf("请求 Prometheus 失败：%v", err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 32*1024*1024))
	if err != nil {
		return fmt.Errorf("读取响应失败：%v", err)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Prometheus 返回 HTTP %d：%s", resp.StatusCode, truncateStr(string(b), 300))
	}
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("解析响应失败：%v", err)
	}
	if out.Status != "success" {
		return fmt.Errorf("Prometheus 查询失败：%s", out.Error)
	}
	return nil
}

// query 即时查询，返回向量样本（兼容返回 scalar 的情况——空 result）
func (p *promClient) query(ctx context.Context, expr string, ts string) ([]promSample, error) {
	q := url.Values{"query": []string{expr}}
	if ts != "" {
		q.Set("time", ts)
	}
	var resp promAPIResp
	if err := p.api(ctx, "/api/v1/query", q, &resp); err != nil {
		return nil, err
	}
	var d promQueryData
	if err := json.Unmarshal(resp.Data, &d); err != nil {
		return nil, fmt.Errorf("解析查询结果失败：%v", err)
	}
	var samples []promSample
	if err := json.Unmarshal(d.Result, &samples); err != nil {
		// resultType=scalar 时 result 是 [ts,"value"]，此时按空处理
		return []promSample{}, nil
	}
	return samples, nil
}

// queryRange 区间查询，返回矩阵序列
func (p *promClient) queryRange(ctx context.Context, expr string, start, end, step int64) ([]promSeries, error) {
	q := url.Values{
		"query": []string{expr},
		"start": []string{strconv.FormatInt(start, 10)},
		"end":   []string{strconv.FormatInt(end, 10)},
		"step":  []string{strconv.Itoa(int(step)) + "s"},
	}
	var resp promAPIResp
	if err := p.api(ctx, "/api/v1/query_range", q, &resp); err != nil {
		return nil, err
	}
	var d promQueryData
	if err := json.Unmarshal(resp.Data, &d); err != nil {
		return nil, fmt.Errorf("解析区间结果失败：%v", err)
	}
	var series []promSeries
	if err := json.Unmarshal(d.Result, &series); err != nil {
		return nil, fmt.Errorf("解析区间结果失败：%v", err)
	}
	return series, nil
}

// ---------------------------------------------------------------------------
// 标准指标 PromQL（node_exporter 口径）
// ---------------------------------------------------------------------------

// promQLCPU CPU 使用率（per instance）。window 由调用方按查询步长传入（rate 窗口 ≥ 2*step）。
func promQLCPU(window string) string {
	return fmt.Sprintf(`100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[%s])))`, window)
}

const promQLMem = `100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)`

const promQLDisk = `max by (instance) (100 * (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|devtmpfs|overlay|squashfs|iso9660",mountpoint!~"^/(run|dev|sys)"} / node_filesystem_size_bytes{fstype!~"tmpfs|devtmpfs|overlay|squashfs|iso9660",mountpoint!~"^/(run|dev|sys)"}))`

const promQLUname = `node_uname_info`

// sampleValue 取样本值（value[1] 是 string 形式的浮点数）
func sampleValue(v []interface{}) (float64, bool) {
	if len(v) < 2 {
		return 0, false
	}
	s, ok := v[1].(string)
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

// sampleTS 取样本时间戳（value[0] 是 float64 形式的 unix 秒）
func sampleTS(v []interface{}) int64 {
	if len(v) < 1 {
		return 0
	}
	f, ok := v[0].(float64)
	if !ok {
		return 0
	}
	return int64(f)
}

// ---------------------------------------------------------------------------
// handler 工具
// ---------------------------------------------------------------------------

// resolvePromDS 按参数 ds（id）或 name 取启用的数据源并构建客户端
func resolvePromDS(c *gin.Context) (*PromDataSource, *promClient, error) {
	var ds PromDataSource
	idStr := strings.TrimSpace(c.Query("ds"))
	name := strings.TrimSpace(c.Query("dsName"))
	if idStr == "" && name == "" {
		// 兜底：只有一个数据源时直接用它
		var all []PromDataSource
		if err := DB.Where("enabled = 1").Order("id asc").Limit(2).Find(&all).Error; err != nil {
			return nil, nil, fmt.Errorf("查询数据源失败：%v", err)
		}
		if len(all) == 0 {
			return nil, nil, fmt.Errorf("没有可用的 Prometheus 数据源，请先在「数据源管理」添加")
		}
		if len(all) > 1 {
			return nil, nil, fmt.Errorf("存在多个数据源，请指定 ds 参数")
		}
		ds = all[0]
	} else {
		dbq := DB
		if idStr != "" {
			id, err := strconv.ParseUint(idStr, 10, 64)
			if err != nil || id == 0 {
				return nil, nil, fmt.Errorf("数据源 id 不合法：%s", idStr)
			}
			dbq = dbq.Where("id = ?", id)
		} else {
			dbq = dbq.Where("name = ?", name)
		}
		if err := dbq.First(&ds).Error; err != nil {
			return nil, nil, fmt.Errorf("数据源不存在：%s", idStr+name)
		}
	}
	if ds.Enabled != 1 {
		return nil, nil, fmt.Errorf("数据源已停用：%s", ds.Name)
	}
	cli, err := newPromClient(&ds)
	if err != nil {
		return nil, nil, err
	}
	return &ds, cli, nil
}

// truncateStr 截断字符串（错误信息防超长）
func truncateStr(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}

// ---------------------------------------------------------------------------
// CRUD + 连通性测试
// ---------------------------------------------------------------------------

// ListPromDataSources GET /api/prom/datasources
func ListPromDataSources(c *gin.Context) {
	var list []PromDataSource
	if err := DB.Order("id asc").Find(&list).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 1, "查询失败："+err.Error())
		return
	}
	withPromAuthFlags(list)
	OK(c, gin.H{"list": list})
}

// CreatePromDataSource POST /api/prom/datasources
func CreatePromDataSource(c *gin.Context) {
	var body promAuthBody
	{
		if err := c.ShouldBindJSON(&body); err != nil {
			Fail(c, http.StatusBadRequest, 1, "请求体不合法："+err.Error())
			return
		}
		if err := validatePromBody(&body); err != nil {
			Fail(c, http.StatusBadRequest, 1, err.Error())
			return
		}
		var n int64
		DB.Model(&PromDataSource{}).Where("name = ?", body.Name).Count(&n)
		if n > 0 {
			Fail(c, http.StatusBadRequest, 1, "数据源名称已存在："+body.Name)
			return
		}
		ds := PromDataSource{
			Name:     body.Name,
			URL:      body.URL,
			AuthType: body.AuthType,
			Username: body.Username,
			Enabled:  1,
			Remark:   body.Remark,
		}
		if body.Enabled != nil {
			ds.Enabled = *body.Enabled
		}
		if body.AuthType == "basic" {
			enc, err := encryptField(body.Password)
			if err != nil {
				Fail(c, http.StatusInternalServerError, 1, "加密密码失败："+err.Error())
				return
			}
			ds.PasswordEnc = enc
		}
		if body.AuthType == "bearer" {
			ds.BearerToken = body.BearerToken
		}
		if err := DB.Create(&ds).Error; err != nil {
			Fail(c, http.StatusInternalServerError, 1, "创建失败："+err.Error())
			return
		}
		OK(c, gin.H{"msg": "创建成功", "id": ds.ID})
	}
}

// UpdatePromDataSource PUT /api/prom/datasources/:id
func UpdatePromDataSource(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		Fail(c, http.StatusBadRequest, 1, "id 不合法")
		return
	}
	var body promAuthBody
	if err := c.ShouldBindJSON(&body); err != nil {
		Fail(c, http.StatusBadRequest, 1, "请求体不合法："+err.Error())
		return
	}
	if err := validatePromBody(&body); err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	var ds PromDataSource
	if err := DB.First(&ds, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 1, "数据源不存在")
		return
	}
	// 名称唯一性（排除自身）
	var n int64
	DB.Model(&PromDataSource{}).Where("name = ? and id <> ?", body.Name, id).Count(&n)
	if n > 0 {
		Fail(c, http.StatusBadRequest, 1, "数据源名称已存在："+body.Name)
		return
	}
	ds.Name = body.Name
	ds.URL = body.URL
	ds.AuthType = body.AuthType
	ds.Username = body.Username
	ds.Remark = body.Remark
	if body.Enabled != nil {
		ds.Enabled = *body.Enabled
	}
	switch body.AuthType {
	case "basic":
		if body.Password != "" {
			enc, err := encryptField(body.Password)
			if err != nil {
				Fail(c, http.StatusInternalServerError, 1, "加密密码失败："+err.Error())
				return
			}
			ds.PasswordEnc = enc
		}
		ds.BearerToken = ""
	case "bearer":
		if body.BearerToken != "" {
			ds.BearerToken = body.BearerToken
		}
		ds.PasswordEnc = ""
		ds.Username = ""
	default:
		ds.PasswordEnc = ""
		ds.BearerToken = ""
		ds.Username = ""
	}
	if err := DB.Save(&ds).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 1, "保存失败："+err.Error())
		return
	}
	OK(c, gin.H{"msg": "保存成功"})
}

// DeletePromDataSource DELETE /api/prom/datasources/:id
func DeletePromDataSource(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		Fail(c, http.StatusBadRequest, 1, "id 不合法")
		return
	}
	if err := DB.Delete(&PromDataSource{}, id).Error; err != nil {
		Fail(c, http.StatusInternalServerError, 1, "删除失败："+err.Error())
		return
	}
	OK(c, gin.H{"msg": "已删除"})
}

// TestPromDataSource POST /api/prom/datasources/:id/test
// 连通性测试：查 up 指标，返回延迟 / 目标总数 / 在线数 / server 版本
func TestPromDataSource(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		Fail(c, http.StatusBadRequest, 1, "id 不合法")
		return
	}
	var ds PromDataSource
	if err := DB.First(&ds, id).Error; err != nil {
		Fail(c, http.StatusNotFound, 1, "数据源不存在")
		return
	}
	// 表单里直接测试（未保存）时支持传 url/authType/username/password/token 覆盖
	var body promAuthBody
	_ = c.ShouldBindJSON(&body) // body 可以为空
	cli, err := newPromClient(&ds)
	if err != nil {
		Fail(c, http.StatusInternalServerError, 1, err.Error())
		return
	}
	if body.URL != "" {
		cli.base = strings.TrimRight(body.URL, "/")
	}
	if body.AuthType != "" {
		cli.authType = body.AuthType
		cli.username = body.Username
		cli.token = body.BearerToken
		if body.Password != "" {
			cli.password = body.Password
		}
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), promHTTPTimeout)
	defer cancel()
	start := time.Now()
	samples, err := cli.query(ctx, "up", "")
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, "连接失败："+err.Error())
		return
	}
	online, offline := 0, 0
	for _, s := range samples {
		if v, ok := sampleValue(s.Value); ok && v > 0 {
			online++
		} else {
			offline++
		}
	}
	// 版本探测（可选，失败不影响测试结论）。注意 Prometheus 的 buildinfo
	// 响应是 {status, data:{version}}，data 节点本身就是对象，别再套一层 Data。
	version := ""
	var bi promAPIResp
	q := url.Values{}
	if err := cli.api(ctx, "/api/v1/status/buildinfo", q, &bi); err == nil {
		var info struct {
			Version string `json:"version"`
		}
		if json.Unmarshal(bi.Data, &info) == nil {
			version = info.Version
		}
	}
	OK(c, gin.H{
		"msg":       "连接成功",
		"elapsedMs": elapsed,
		"targets":   len(samples),
		"online":    online,
		"offline":   offline,
		"version":   version,
	})
}

// ---------------------------------------------------------------------------
// 查询代理（指标查询页用）
// ---------------------------------------------------------------------------

// PromProxyQuery GET /api/prom/query?ds=&query=&time=
func PromProxyQuery(c *gin.Context) {
	expr := strings.TrimSpace(c.Query("query"))
	if expr == "" {
		Fail(c, http.StatusBadRequest, 1, "请填写 PromQL 查询语句")
		return
	}
	_, cli, err := resolvePromDS(c)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), promHTTPTimeout)
	defer cancel()
	samples, err := cli.query(ctx, expr, strings.TrimSpace(c.Query("time")))
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	OK(c, gin.H{"samples": samples})
}

// PromProxyQueryRange GET /api/prom/query_range?ds=&query=&start=&end=&step=
// start/end 为 unix 秒，step 为秒
func PromProxyQueryRange(c *gin.Context) {
	expr := strings.TrimSpace(c.Query("query"))
	if expr == "" {
		Fail(c, http.StatusBadRequest, 1, "请填写 PromQL 查询语句")
		return
	}
	start, err1 := strconv.ParseInt(c.Query("start"), 10, 64)
	end, err2 := strconv.ParseInt(c.Query("end"), 10, 64)
	step, err3 := strconv.ParseInt(c.Query("step"), 10, 64)
	if err1 != nil || err2 != nil || err3 != nil || start <= 0 || end <= start || step < 5 {
		Fail(c, http.StatusBadRequest, 1, "时间参数不合法（start/end 为 unix 秒，step ≥ 5，end > start）")
		return
	}
	if end-start > 400*24*3600 {
		Fail(c, http.StatusBadRequest, 1, "查询区间过长（上限 400 天）")
		return
	}
	_, cli, err := resolvePromDS(c)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), promHTTPTimeout)
	defer cancel()
	series, err := cli.queryRange(ctx, expr, start, end, step)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	OK(c, gin.H{"series": series})
}

// PromMetricNames GET /api/prom/metric-names?ds= —— /api/v1/label/__name__/values
func PromMetricNames(c *gin.Context) {
	_, cli, err := resolvePromDS(c)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	var resp promAPIResp
	ctx, cancel := context.WithTimeout(c.Request.Context(), promHTTPTimeout)
	defer cancel()
	if err := cli.api(ctx, "/api/v1/label/__name__/values", url.Values{}, &resp); err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	var names []string
	if err := json.Unmarshal(resp.Data, &names); err != nil {
		Fail(c, http.StatusInternalServerError, 1, "解析指标名失败："+err.Error())
		return
	}
	OK(c, gin.H{"names": names})
}

// PromLabelValues GET /api/prom/label/:name/values?ds=
func PromLabelValues(c *gin.Context) {
	name := strings.TrimSpace(c.Param("name"))
	if name == "" || strings.ContainsAny(name, "{} \t") {
		Fail(c, http.StatusBadRequest, 1, "label 名不合法")
		return
	}
	_, cli, err := resolvePromDS(c)
	if err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	var resp promAPIResp
	ctx, cancel := context.WithTimeout(c.Request.Context(), promHTTPTimeout)
	defer cancel()
	if err := cli.api(ctx, "/api/v1/label/"+url.PathEscape(name)+"/values", url.Values{}, &resp); err != nil {
		Fail(c, http.StatusBadRequest, 1, err.Error())
		return
	}
	var values []string
	if err := json.Unmarshal(resp.Data, &values); err != nil {
		Fail(c, http.StatusInternalServerError, 1, "解析 label 值失败："+err.Error())
		return
	}
	OK(c, gin.H{"values": values})
}
