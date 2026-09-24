package main

// ============================================================================
// 夜莺（Nightingale / n9e）告警历史采集服务
//
// 需求：「Prometheus 监控 → 监控告警报表」，可导出夜莺过去 90 天的告警记录。
//
// ── 接口事实（v8.0.0 现场实测 2026-09-24，改动前请先复测）──────────────────
//   - 列表：GET <base>/api/n9e/alert-his-events/list?p=1&limit=5000&stime=<unix>&etime=<unix>
//   - 鉴权：请求头 `X-User-Token: <token>`
//     ⚠️ 只认这一个头。实测 `Authorization: Bearer` / 裸 token / Cookie / query 参数
//        全部 401；而 X-User-Token 会直接进入业务校验（返回 400 参数错误而非 401），
//        即「鉴权已通过」。
//   - 返回：{"dat":{"list":[...],"total":N},"err":""}
//
// ── 性能特征（本文件所有设计都围绕它）────────────────────────────────────
//   同一个接口，耗时由**时间跨度**决定，与 limit / 数据量基本无关：
//       1 天 3100 条 → 0.8s        7 天 2.1 万条 → 0.8s
//       30 天 8.6 万条 → 1.1s      90 天 25.6 万条 → 23s（limit 取 100 或 5000 都是 23s）
//   ⇒ 必须按 ≤30 天切片 + 片内翻页。实测 90 天 = 3 片 × 18 页，共 94 秒拉完全部
//     255,950 条，与整体 total 逐条一致、零重复。
//
// ── 为什么要落库而不是每次现拉 ───────────────────────────────────────────
//   90 天全量现拉要 94 秒，页面的查询 / 统计 / 导出都等不起。落库后这三件事
//   走本地 SQL，毫秒级返回；只有「同步」这一步才碰夜莺。
// ============================================================================

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm/clause"
)

// ---------------------------------------------------------------------------
// 连接配置（存 SystemSetting，页面可改、立即生效）
// ---------------------------------------------------------------------------

const (
	n9eBaseKey  = "n9e.base_url"
	n9eTokenKey = "n9e.token"
)

// n9eDefaultBase / n9eDefaultToken 首次启动时写入的初始配置，来自现场提供的接入信息。
// 只是「开箱可用的初值」：写入 DB 后一切以 SystemSetting 为准，页面随时可改，
// 且已存在时不会被覆盖（见 ensureN9eDefaults）。
const (
	n9eDefaultBase  = "http://n9e.internal.example:9999"
	n9eDefaultToken = "e2ac78ce-9838-49ab-bb91-bbe2d6963fba"
)

// n9eHTTPTimeout 单次请求超时。夜莺在 90 天跨度上要 23 秒，所以不能按普通接口设 5~10 秒。
const n9eHTTPTimeout = 120 * time.Second

// n9eMaxDays 允许回溯的最大天数（需求口径就是 90 天）
const n9eMaxDays = 90

// n9eChunkDays 单个时间片的跨度。实测 30 天是「快」与「慢」的分界，
// 超过它耗时陡增到 20 秒以上，所以固定按 30 天切。
const n9eChunkDays = 30

// n9ePageSize 片内每页条数
const n9ePageSize = 5000

// ensureN9eDefaults 首次启动写入初始配置；已有配置时一律不动，避免覆盖用户在页面上的修改。
func ensureN9eDefaults() {
	if getSetting(n9eBaseKey, "") == "" {
		if err := setSetting(n9eBaseKey, n9eDefaultBase); err != nil {
			log.Printf("写入夜莺默认地址失败：%v", err)
		}
	}
	if getSetting(n9eTokenKey, "") == "" {
		if err := setSetting(n9eTokenKey, n9eDefaultToken); err != nil {
			log.Printf("写入夜莺默认 Token 失败：%v", err)
		}
	}
}

// ---------------------------------------------------------------------------
// 本地落库模型
// ---------------------------------------------------------------------------

// N9eAlertEvent 夜莺历史告警事件（本地副本）
//
// 主键直接用夜莺的事件 id（autoIncrement:false），因此重复同步天然按 id 幂等，
// 不需要额外去重逻辑。
type N9eAlertEvent struct {
	ID               int64     `gorm:"primaryKey;autoIncrement:false" json:"id"`
	Cate             string    `gorm:"size:32" json:"cate"`
	Cluster          string    `gorm:"size:128" json:"cluster"`
	GroupID          int       `gorm:"index" json:"groupId"`
	GroupName        string    `gorm:"size:128;index" json:"groupName"`
	RuleID           int       `json:"ruleId"`
	RuleName         string    `gorm:"size:255;index" json:"ruleName"`
	RuleNote         string    `gorm:"size:512" json:"ruleNote"`
	Severity         int       `gorm:"index" json:"severity"`
	TargetIdent      string    `gorm:"size:255;index" json:"targetIdent"`
	TargetHost       string    `gorm:"size:128;index" json:"targetHost"`
	Department       string    `gorm:"size:128;index" json:"department"`
	SystemName       string    `gorm:"size:128;index" json:"systemName"`
	TriggerTime      int64     `gorm:"index" json:"triggerTime"`
	TriggerValue     string    `gorm:"size:64" json:"triggerValue"`
	RecoverTime      int64     `gorm:"index" json:"recoverTime"`
	IsRecovered      int       `gorm:"index" json:"isRecovered"`
	FirstTriggerTime int64     `json:"firstTriggerTime"`
	NotifyCurNumber  int       `json:"notifyCurNumber"`
	NotifyChannels   string    `gorm:"size:255" json:"notifyChannels"`
	TagsJSON         string    `gorm:"type:text" json:"-"`
	SyncedAt         time.Time `json:"syncedAt"`
}

// TableName 固定表名（避免 GORM 复数化规则带来的意外）
func (N9eAlertEvent) TableName() string { return "n9e_alert_events" }

// ---------------------------------------------------------------------------
// 夜莺 HTTP 客户端
// ---------------------------------------------------------------------------

type n9eClient struct {
	base  string
	token string
	http  *http.Client
}

// newN9eClient 从 SystemSetting 构建客户端；未配置时给出可操作的提示。
func newN9eClient() (*n9eClient, error) {
	base := strings.TrimSpace(getSetting(n9eBaseKey, ""))
	token := strings.TrimSpace(getSetting(n9eTokenKey, ""))
	if base == "" {
		return nil, fmt.Errorf("未配置夜莺地址，请到「监控告警报表 → 连接设置」里填写")
	}
	if token == "" {
		return nil, fmt.Errorf("未配置夜莺 API Token，请到「监控告警报表 → 连接设置」里填写")
	}
	return &n9eClient{
		base:  strings.TrimRight(base, "/"),
		token: token,
		http:  &http.Client{Timeout: n9eHTTPTimeout},
	}, nil
}

// n9eHisEvent 夜莺历史告警记录（只声明用得到的字段；夜莺返回的字段远多于此）
type n9eHisEvent struct {
	ID               int64    `json:"id"`
	Cate             string   `json:"cate"`
	Cluster          string   `json:"cluster"`
	GroupID          int      `json:"group_id"`
	GroupName        string   `json:"group_name"`
	RuleID           int      `json:"rule_id"`
	RuleName         string   `json:"rule_name"`
	RuleNote         string   `json:"rule_note"`
	Severity         int      `json:"severity"`
	TargetIdent      string   `json:"target_ident"`
	TriggerTime      int64    `json:"trigger_time"`
	TriggerValue     string   `json:"trigger_value"`
	RecoverTime      int64    `json:"recover_time"`
	IsRecovered      int      `json:"is_recovered"`
	FirstTriggerTime int64    `json:"first_trigger_time"`
	NotifyCurNumber  int      `json:"notify_cur_number"`
	NotifyChannels   []string `json:"notify_channels"`
	Tags             []string `json:"tags"`
}

type n9eHisEventResp struct {
	Dat struct {
		List  []n9eHisEvent `json:"list"`
		Total int           `json:"total"`
	} `json:"dat"`
	Err string `json:"err"`
}

// listHisEvents 拉取一页历史告警。
func (n *n9eClient) listHisEvents(ctx context.Context, stime, etime int64, page, limit int) ([]n9eHisEvent, int, error) {
	q := url.Values{}
	q.Set("p", strconv.Itoa(page))
	q.Set("limit", strconv.Itoa(limit))
	q.Set("stime", strconv.FormatInt(stime, 10))
	q.Set("etime", strconv.FormatInt(etime, 10))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.base+"/api/n9e/alert-his-events/list?"+q.Encode(), nil)
	if err != nil {
		return nil, 0, fmt.Errorf("构造请求失败：%v", err)
	}
	req.Header.Set("X-User-Token", n.token)
	req.Header.Set("Accept", "application/json")
	resp, err := n.http.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("连接夜莺失败：%v", err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024*1024))
	if err != nil {
		return nil, 0, fmt.Errorf("读取响应失败：%v", err)
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, 0, fmt.Errorf("夜莺拒绝访问（401）：Token 无效或已过期，请到「连接设置」更新")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("夜莺返回 HTTP %d：%s", resp.StatusCode, truncateStr(string(b), 300))
	}
	var out n9eHisEventResp
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, 0, fmt.Errorf("解析夜莺响应失败：%v（响应片段：%s）", err, truncateStr(string(b), 200))
	}
	if out.Err != "" {
		return nil, 0, fmt.Errorf("夜莺返回错误：%s", out.Err)
	}
	return out.Dat.List, out.Dat.Total, nil
}

// Ping 连通性测试：拉一页（limit=1）验证地址与 Token。
func (n *n9eClient) Ping(ctx context.Context) (int, error) {
	now := time.Now().Unix()
	_, total, err := n.listHisEvents(ctx, now-3600, now, 1, 1)
	if err != nil {
		return 0, err
	}
	return total, nil
}

// ---------------------------------------------------------------------------
// 同步（分片拉取 + 批量落库）
// ---------------------------------------------------------------------------

// N9eSyncState 同步进度（内存态，供前端轮询）。同一时刻只允许一个同步任务。
type N9eSyncState struct {
	Running    bool   `json:"running"`
	Phase      string `json:"phase"`
	Days       int    `json:"days"`
	Fetched    int    `json:"fetched"`
	Total      int    `json:"total"`
	ChunkIndex int    `json:"chunkIndex"`
	ChunkTotal int    `json:"chunkTotal"`
	StartedAt  string `json:"startedAt"`
	FinishedAt string `json:"finishedAt"`
	ElapsedMS  int64  `json:"elapsedMs"`
	Error      string `json:"error"`
}

var (
	n9eSyncMu    sync.Mutex
	n9eSyncState N9eSyncState
)

// n9eSyncSnapshot 读当前同步状态（副本，避免外部持有锁）
func n9eSyncSnapshot() N9eSyncState {
	n9eSyncMu.Lock()
	defer n9eSyncMu.Unlock()
	s := n9eSyncState
	return s
}

// n9eSetSyncState 更新同步状态
func n9eSetSyncState(fn func(*N9eSyncState)) {
	n9eSyncMu.Lock()
	defer n9eSyncMu.Unlock()
	fn(&n9eSyncState)
}

// StartN9eSync 启动一次后台同步；返回 false 表示已有任务在跑（不重复启动）。
// days 会自动收敛到 [1, n9eMaxDays]。
func StartN9eSync(days int) bool {
	if days <= 0 {
		days = n9eMaxDays
	}
	if days > n9eMaxDays {
		days = n9eMaxDays
	}
	n9eSyncMu.Lock()
	if n9eSyncState.Running {
		n9eSyncMu.Unlock()
		return false
	}
	n9eSyncState = N9eSyncState{
		Running:   true,
		Phase:     "准备中",
		Days:      days,
		StartedAt: time.Now().Format("2006-01-02 15:04:05"),
	}
	n9eSyncMu.Unlock()

	go runN9eSync(days)
	return true
}

// runN9eSync 按 ≤n9eChunkDays 切片拉取并落库。
func runN9eSync(days int) {
	t0 := time.Now()
	fail := func(msg string) {
		n9eSetSyncState(func(s *N9eSyncState) {
			s.Running = false
			s.Phase = "失败"
			s.Error = msg
			s.FinishedAt = time.Now().Format("2006-01-02 15:04:05")
			s.ElapsedMS = time.Since(t0).Milliseconds()
		})
	}

	cli, err := newN9eClient()
	if err != nil {
		fail(err.Error())
		return
	}
	ctx := context.Background()
	now := time.Now().Unix()
	startAll := now - int64(days)*86400
	chunkSec := int64(n9eChunkDays) * 86400

	// 先探一次总量，用于进度百分比（这一步在 90 天跨度上会花 ~23 秒，值得：
	// 没有它前端就只能显示「已拉取 N 条」而不知道还要多久）
	n9eSetSyncState(func(s *N9eSyncState) { s.Phase = "统计总数" })
	_, grandTotal, err := cli.listHisEvents(ctx, startAll, now, 1, 1)
	if err != nil {
		fail(fmt.Sprintf("连接夜莺失败：%v", err))
		return
	}

	chunkTotal := 0
	for s := startAll; s < now; s += chunkSec {
		chunkTotal++
	}

	all := make([]N9eAlertEvent, 0, 4096)
	idx := 0
	for s := startAll; s < now; s += chunkSec {
		e := s + chunkSec
		if e > now {
			e = now
		}
		idx++
		n9eSetSyncState(func(st *N9eSyncState) {
			st.ChunkIndex = idx
			st.ChunkTotal = chunkTotal
			st.Total = grandTotal
			st.Phase = fmt.Sprintf("拉取第 %d/%d 片（%s ~ %s）",
				idx, chunkTotal,
				time.Unix(s, 0).Format("01-02"), time.Unix(e, 0).Format("01-02"))
		})

		page := 1
		for {
			list, _, err := cli.listHisEvents(ctx, s, e, page, n9ePageSize)
			if err != nil {
				fail(fmt.Sprintf("拉取第 %d 片第 %d 页失败：%v", idx, page, err))
				return
			}
			for i := range list {
				all = append(all, n9eConvertEvent(&list[i]))
			}
			n9eSetSyncState(func(st *N9eSyncState) { st.Fetched = len(all) })

			if len(list) < n9ePageSize {
				break
			}
			page++
			if page > 500 {
				log.Printf("夜莺同步：片 %d 翻页超过 500 页，提前结束该片", idx)
				break
			}
		}

		// 每片落一次库：中断时已拉取的部分不至于白费
		if err := n9eUpsertEvents(all); err != nil {
			fail(fmt.Sprintf("写入数据库失败：%v", err))
			return
		}
		all = all[:0]
	}

	// 清理超出保留窗口的旧记录。
	// 需求口径就是「最近 90 天」，不清理的话这张表会以每天约 3000 条的速度无限增长。
	// 无条件按 90 天窗口裁：即使本次只同步了 7 天，把 90 天以前的历史删掉也符合口径。
	if res := DB.Where("trigger_time < ?", now-int64(n9eMaxDays)*86400).Delete(&N9eAlertEvent{}); res.Error != nil {
		log.Printf("清理 %d 天前的历史告警失败（不影响本次同步结果）：%v", n9eMaxDays, res.Error)
	} else if res.RowsAffected > 0 {
		log.Printf("已清理 %d 天前的历史告警 %d 条", n9eMaxDays, res.RowsAffected)
	}

	n9eSetSyncState(func(s *N9eSyncState) {
		s.Running = false
		s.Phase = "完成"
		s.Fetched = grandTotal
		s.FinishedAt = time.Now().Format("2006-01-02 15:04:05")
		s.ElapsedMS = time.Since(t0).Milliseconds()
	})
	log.Printf("夜莺告警同步完成：%d 天，%d 条，耗时 %s", days, grandTotal, time.Since(t0).Round(time.Second))
}

// n9eUpsertEvents 批量 upsert（按夜莺事件 id 幂等）。
// 一页 5000 条 × 3 片分批写，避免单条 SQL 参数过多。
func n9eUpsertEvents(rows []N9eAlertEvent) error {
	if len(rows) == 0 {
		return nil
	}
	const batch = 500
	for i := 0; i < len(rows); i += batch {
		end := i + batch
		if end > len(rows) {
			end = len(rows)
		}
		chunk := rows[i:end]
		err := DB.Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "id"}},
			DoUpdates: clause.AssignmentColumns([]string{
				"cate", "cluster", "group_id", "group_name", "rule_id", "rule_name",
				"rule_note", "severity", "target_ident", "target_host", "department",
				"system_name", "trigger_time", "trigger_value", "recover_time",
				"is_recovered", "first_trigger_time", "notify_cur_number",
				"notify_channels", "tags_json", "synced_at",
			}),
		}).Create(&chunk).Error
		if err != nil {
			return err
		}
	}
	return nil
}

// n9eConvertEvent 把夜莺原始记录转成落库模型，并从 tags 里解析目标对象与归属信息。
//
// 实测：target_ident 在本环境恒为空，真正的主机信息只在 tags 里
// （instance=198.51.100.22:9100 / department=xx事业部 / system=xx系统），
// 所以必须从 tags 解析，否则报表里「目标」一列会全空。
func n9eConvertEvent(ev *n9eHisEvent) N9eAlertEvent {
	row := N9eAlertEvent{
		ID:               ev.ID,
		Cate:             ev.Cate,
		Cluster:          ev.Cluster,
		GroupID:          ev.GroupID,
		GroupName:        ev.GroupName,
		RuleID:           ev.RuleID,
		RuleName:         ev.RuleName,
		RuleNote:         ev.RuleNote,
		Severity:         ev.Severity,
		TargetIdent:      ev.TargetIdent,
		TriggerTime:      ev.TriggerTime,
		TriggerValue:     ev.TriggerValue,
		RecoverTime:      ev.RecoverTime,
		IsRecovered:      ev.IsRecovered,
		FirstTriggerTime: ev.FirstTriggerTime,
		NotifyCurNumber:  ev.NotifyCurNumber,
		NotifyChannels:   strings.Join(ev.NotifyChannels, ","),
		SyncedAt:         time.Now(),
	}
	instance := ""
	for _, t := range ev.Tags {
		k, v, ok := strings.Cut(t, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "instance":
			instance = strings.TrimSpace(v)
		case "department":
			row.Department = strings.TrimSpace(v)
		case "system":
			row.SystemName = strings.TrimSpace(v)
		}
	}
	if instance != "" {
		if row.TargetIdent == "" {
			row.TargetIdent = instance
		}
		// 去掉 :9100 之类的端口，便于按主机聚合
		host := instance
		if i := strings.LastIndex(host, ":"); i > 0 {
			host = host[:i]
		}
		row.TargetHost = host
	}
	if b, err := json.Marshal(ev.Tags); err == nil {
		row.TagsJSON = string(b)
	}
	return row
}

// n9eSeverityLabel 告警等级中文名（夜莺口径：1=提醒 2=警告 3=严重）
func n9eSeverityLabel(v int) string {
	switch v {
	case 1:
		return "提醒"
	case 2:
		return "警告"
	case 3:
		return "严重"
	default:
		return fmt.Sprintf("未知(%d)", v)
	}
}

// n9eTagValue 从落库的 tags JSON 里取某个 key 的值（导出时补 department 等）
func n9eTagValue(tagsJSON, key string) string {
	if tagsJSON == "" {
		return ""
	}
	var tags []string
	if err := json.Unmarshal([]byte(tagsJSON), &tags); err != nil {
		return ""
	}
	prefix := key + "="
	for _, t := range tags {
		if strings.HasPrefix(t, prefix) {
			return strings.TrimPrefix(t, prefix)
		}
	}
	return ""
}
