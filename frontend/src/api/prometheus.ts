import api from './client'

// ============================================================================
// Prometheus 监控（v1.8.0） API
//
// 与后端 handler_prom.go / handler_prom_dashboard.go 的路由一一对应。
// 后端统一走 OK() 包装（{code,msg,data}）→ 这里统一解 .data.data，
// **别学 scripts.ts 只解一层**（那边是裸 gin.H 返回，历史原因）。
// ============================================================================

export interface PromDataSource {
  id: number
  name: string
  url: string
  authType: 'none' | 'basic' | 'bearer'
  username: string
  enabled: number
  remark: string
  authConfigured?: boolean
  createdAt?: string
  updatedAt?: string
}

export interface PromTestResult {
  msg: string
  elapsedMs: number
  targets: number
  online: number
  offline: number
  version: string
}

export interface PromSample {
  metric: Record<string, string>
  value: [number, string]
}

export interface PromSeries {
  metric: Record<string, string>
  values: [number, string][]
}

export interface PromHostStat {
  instance: string
  hostname: string
  department: string
  system: string
  env: string
  deployserver: string
  up: boolean
  cpu: number
  mem: number
  disk: number
  /** 网络使用率（%，出+入速率 ÷ 参考带宽）。v1.7.39 与巡检大屏同版面后新增 */
  net: number
  /** 发行版原文（node_os_info.pretty_name；老 node_exporter 退化成家族名） */
  osName: string
  /** 归一后的 OS 家族（「操作系统分布」面板按它聚合） */
  osFamily: string
}

export interface PromTopEntry {
  instance: string
  hostname: string
  department: string
  system: string
  env: string
  deployserver: string
  value: number
}

export interface PromIssue {
  instance: string
  name: string
  department: string
  system: string
  env: string
  deployserver: string
  metric: 'cpu' | 'mem' | 'disk' | 'offline'
  metricCN: string
  value: number
  level: 'crit' | 'warn'
  levelCN: string
}

export interface PromIssueStat {
  crit: number
  warn: number
  hosts: number
  /**
   * 按指标拆分的严重 / 关注项数（v1.7.39）。
   * 左栏「磁盘超阈值」那一格必须用它取数 —— `issues` 有条数上限（100），
   * 真爆了会被截断，从截断后的列表里数会少算。
   */
  byMetric?: Record<string, PromMetricIssue>
}

/** 单个指标的严重 / 关注项数 */
export interface PromMetricIssue {
  warn: number
  crit: number
}

export interface PromGroupStat {
  key: string
  hosts: number
  online: number
  cpuAvg: number
  memAvg: number
  diskAvg: number
  maxVal: number
  riskHosts: number
}

export interface PromCfgView {
  title: string
  autoCollect: number
  intervalSec: number
  cpuWarn: number
  cpuCrit: number
  memWarn: number
  memCrit: number
  diskWarn: number
  diskCrit: number
  topN: number
  hostLimit: number
  showOffline: number
  trendHours: number
  groupBy: 'system' | 'department' | 'env' | 'deployserver'
  /**
   * 网络参考带宽（Mbps，默认 1000）。v1.7.39 新增。
   * 网络使用率 = 出+入速率 ÷ (网卡上报速率 || 参考带宽)。
   * 网卡上报 `node_network_speed_bytes` 的主机极少（实测 9/910），
   * 没有它就只能按参考带宽算百分比 —— 否则网络那一列全空、版面与巡检大屏对不齐。
   */
  netBaseMbps: number
  /**
   * 规则模式（v1.7.41）：
   *  - `blacklist`（默认）：命中规则的 (主机,指标) **不展示**
   *  - `whitelist`：**只展示**命中规则的，用于「只想在大屏上盯这几台机器/这几个指标」
   */
  maskMode: PromMaskMode
  /**
   * 风险项等级口径（v1.7.41）：
   *  - `all`（默认）全部超阈值项都上屏
   *  - `crit` 只展示严重（`warn` 全隐藏）
   *  - `warn` 只展示关注（`crit` 全隐藏）
   */
  riskLevel: PromRiskLevel
  /**
   * 面板显示开关（v1.7.41；v1.7.42 把「负载 TOP」从一个组键拆成 topCpu/topMem/topDisk/topNet）。
   * ⚠️ 语义是「**表里没有的键 = 展示**」（缺省全开）—— 历史配置没有这个字段，升级后行为不变。
   * 键清单见 `utils/promPanels.ts` 的 `PROM_PANELS`（后端有同名白名单，两边必须一一对应）。
   */
  panels?: Record<string, boolean>
  masks?: PromMaskRule[]
}

export interface PromTrendPoint {
  ts: number
  cpu?: number | null
  mem?: number | null
  disk?: number | null
}

/**
 * 屏蔽规则（v1.7.35；v1.7.42 起扩到负载榜）。
 *
 * 作用面：**风险项清单（实时告警列表）+ 对应指标的负载榜**。
 * metric 决定管哪个维度 —— 选 `cpu` 就同时管 CPU 告警项与「CPU 负载 TOP N」，
 * 选 `all` 则该主机的一切维度都按规则处理。
 */
export interface PromMaskRule {
  target: string
  metric: 'all' | 'cpu' | 'mem' | 'disk' | 'net' | 'offline'
  note?: string
}

/** 屏蔽规则模式（v1.7.41）：黑名单=命中即隐藏；白名单=只展示命中的 */
export type PromMaskMode = 'blacklist' | 'whitelist'

/** 风险项等级口径（v1.7.41）：大屏上允许出现哪种等级的超阈值项 */
export type PromRiskLevel = 'all' | 'crit' | 'warn'

export interface PromUsageDist {
  low: number
  mid: number
  high: number
  crit: number
  /** 离线 / 无数据（后端口径：!up 或 max(CPU,内存,磁盘) 为 0） */
  none: number
}

/** 名称 / 数量对（操作系统分布、告警等级分布用） */
export interface PromNameVal {
  name: string
  value: number
}

/** 全集群容量总量（左栏顶部三列卡：CPU 核数 / 内存 / 存储） */
export interface PromCapacity {
  cores: number
  memGb: number
  diskGb: number
}

/** 告警趋势的单个时间点（严重 / 关注项数） */
export interface PromAlertTrendPoint {
  ts: number
  crit: number
  warn: number
}

export interface PromOverview {
  generatedAt: string
  collectMs: number
  source: string
  dsName: string
  /** hosts = 真正采集到资源的主机数（有 CPU/内存/磁盘 任一数据） */
  up: { total: number; online: number; offline: number; hosts: number }
  avg: { cpu: number; mem: number; disk: number; net: number }
  usageDist: PromUsageDist
  trend: PromTrendPoint[]
  hosts: PromHostStat[]
  top: { cpu: PromTopEntry[]; mem: PromTopEntry[]; disk: PromTopEntry[]; net: PromTopEntry[] }
  issues: PromIssue[]
  issueStat: PromIssueStat
  groups: PromGroupStat[]
  config: PromCfgView
  // ---- v1.7.39：与巡检大屏同版面后补齐的面板数据 ----
  capacity: PromCapacity
  osDist: PromNameVal[]
  /** 项目数（target label `system` 去重） */
  projects: number
  /** 部门数（target label `department` 去重） */
  depts: number
  alertTrend: PromAlertTrendPoint[]
}

export interface PromSnapshotResp {
  ready: boolean
  collecting: boolean
  autoCollect: number
  intervalSec: number
  nextAt: number
  msg: string
  config: PromCfgView
  data: PromOverview | null
}

export interface PromReportRow {
  instance: string
  hostname: string
  department: string
  system: string
  env: string
  deployserver: string
  cpuAvg: number
  cpuMax: number
  memAvg: number
  memMax: number
  diskAvg: number
  diskMax: number
}

export interface PromReport {
  period: 'month' | 'quarter' | 'year'
  periodCN: string
  start: string
  end: string
  points: number
  hostCount: number
  fleet: {
    cpuAvg: number
    cpuMax: number
    memAvg: number
    memMax: number
    diskAvg: number
    diskMax: number
    alertHit: number
  }
  trend: PromTrendPoint[]
  rows: PromReportRow[]
  config: PromCfgView
  // 项目范围（v1.7.38）：systems 为空数组 = 不限项目（覆盖数据源全部主机）
  systems: string[]
  scopeText: string
  scopeTargets: number
  hint: string
}

/* ---------------- 项目清单 / 报表模板（v1.7.38） ---------------- */

/** 项目（Prometheus target label `system`）及其主机数 */
export interface PromProject {
  name: string
  hosts: number
  online: number
  offline: number
  department: string
}

export interface PromProjectList {
  list: PromProject[]
  total: number
  /** 该数据源下 Prometheus 采集目标总数 */
  targets: number
  /** 没打 system 标签的目标数 —— 这类主机不属于任何项目，按项目出报告时不会被包含 */
  unlabeled: number
  dsId: number
  dsName: string
}

export interface PromReportTemplate {
  id: number
  name: string
  dsId: number
  dsName: string
  period: 'month' | 'quarter' | 'year'
  systems: string[]
  remark: string
  /** 1=共享给他人可用（只读） */
  shared: number
  ownerId: number
  ownerName: string
  createdAt: string
  updatedAt: string
  /** 当前登录人是否可改 / 删（本人或 prom:manage） */
  canEdit: boolean
}

export interface PromReportTemplateList {
  list: PromReportTemplate[]
  total: number
  /** 其中属于当前登录人的个数 */
  mine: number
  uid: number
}

export interface PromReportTemplateBody {
  name: string
  dsId: number
  period: 'month' | 'quarter' | 'year'
  systems: string[]
  remark?: string
  shared?: number
}

export function listPromProjects(ds?: number): Promise<PromProjectList> {
  return unwrap(api.get('/prom/projects', { params: ds ? { ds } : {} }))
}

export function listPromReportTemplates(): Promise<PromReportTemplateList> {
  return unwrap(api.get('/prom/report-templates'))
}

export function createPromReportTemplate(
  body: PromReportTemplateBody,
): Promise<{ msg: string; template: PromReportTemplate }> {
  return unwrap(api.post('/prom/report-templates', body))
}

export function updatePromReportTemplate(
  id: number,
  body: PromReportTemplateBody,
): Promise<{ msg: string; template: PromReportTemplate }> {
  return unwrap(api.put(`/prom/report-templates/${id}`, body))
}

export function deletePromReportTemplate(id: number): Promise<{ msg: string }> {
  return unwrap(api.delete(`/prom/report-templates/${id}`))
}

const unwrap = <T,>(p: Promise<any>): Promise<T> =>
  p.then((r) => (r.data && typeof r.data.data !== 'undefined' ? r.data.data : r.data))

/* ---------------- 数据源管理 ---------------- */

export function listPromDataSources(): Promise<{ list: PromDataSource[] }> {
  return unwrap(api.get('/prom/datasources'))
}

export interface PromDSBody {
  name: string
  url: string
  authType: string
  username?: string
  password?: string
  bearerToken?: string
  enabled?: number
  remark?: string
}

export function createPromDataSource(body: PromDSBody): Promise<{ msg: string; id: number }> {
  return unwrap(api.post('/prom/datasources', body))
}

export function updatePromDataSource(id: number, body: PromDSBody): Promise<{ msg: string }> {
  return unwrap(api.put(`/prom/datasources/${id}`, body))
}

export function deletePromDataSource(id: number): Promise<{ msg: string }> {
  return unwrap(api.delete(`/prom/datasources/${id}`))
}

/** 连通性测试；extra 用于「未保存先测试」场景（把表单当前值直接带给后端） */
export function testPromDataSource(
  id: number,
  extra?: Partial<PromDSBody>,
): Promise<PromTestResult> {
  return unwrap(api.post(`/prom/datasources/${id}/test`, extra || {}))
}

/* ---------------- 查询代理（指标页用） ---------------- */

export function promQuery(ds: number, query: string, time?: string): Promise<{ samples: PromSample[] }> {
  return unwrap(api.get('/prom/query', { params: { ds, query, time } }))
}

export function promQueryRange(
  ds: number,
  query: string,
  start: number,
  end: number,
  step: number,
): Promise<{ series: PromSeries[] }> {
  return unwrap(api.get('/prom/query_range', { params: { ds, query, start, end, step } }))
}

export function promMetricNames(ds: number): Promise<{ names: string[] }> {
  return unwrap(api.get('/prom/metric-names', { params: { ds } }))
}

export function promLabelValues(ds: number, name: string): Promise<{ values: string[] }> {
  return unwrap(api.get(`/prom/label/${encodeURIComponent(name)}/values`, { params: { ds } }))
}

/* ---------------- 大屏 / 报表 ---------------- */

export function promOverview(ds?: number): Promise<PromOverview> {
  return unwrap(api.get('/prom/overview', { params: ds ? { ds } : {} }))
}

/**
 * 预览报告（不算归档记录）。「生成并归档」走 promGenerateReport。
 *
 * `systems` 是**项目范围**（v1.7.38）：传数组 = 只统计这些项目，传 `[]` 或不传 = 不限项目
 * （全集群口径）。刻意用**重复参数**序列化（`systems=A&systems=B`，靠 `indexes: null`
 * 关掉 axios 默认的 `systems[]=` 写法），因为后端按 `c.QueryArray("systems")` 读；
 * 一旦写成 `systems[]=`，后端取不到值会**静默退化成全集群**，报告数字看着正常但是错的。
 * 也正因为项目名可能自带逗号，这里不能用 `join(',')` 糊过去。
 */
export function promReport(
  ds: number,
  period: 'month' | 'quarter' | 'year',
  ref?: string,
  systems?: string[],
): Promise<PromReport> {
  return unwrap(
    api.get('/prom/report', {
      params: { ds, period, ref, systems: systems && systems.length ? systems : undefined },
      paramsSerializer: { indexes: null },
    }),
  )
}

/* ---------------- 大屏采集 / 配置管理（v1.7.33） ---------------- */

export interface PromScreenConfig extends PromCfgView {
  id: number
  remark: string
  updatedAt?: string
}

export interface PromCollectStatus {
  id: number
  name: string
  ready: boolean
  busy: boolean
  generatedAt: string
  collectMs: number
  hosts: number
  source: string
  msg: string
}

export interface PromScreenConfigResp {
  config: PromScreenConfig
  status: PromCollectStatus[]
  nextAt: number
}

export function getPromScreenConfig(): Promise<PromScreenConfigResp> {
  return unwrap(api.get('/prom/screen-config'))
}

export function savePromScreenConfig(body: Partial<PromScreenConfig>): Promise<{ msg: string; config: PromScreenConfig }> {
  return unwrap(api.put('/prom/screen-config', body))
}

/** 读最新采集快照（不查 Prometheus，秒回） */
export function promSnapshot(ds?: number): Promise<PromSnapshotResp> {
  return unwrap(api.get('/prom/snapshot', { params: ds ? { ds } : {} }))
}

/** 手动触发一次采集（同步等待，采集完大屏立即刷新） */
export function promCollectNow(ds?: number): Promise<{ msg: string; generatedAt: string; hosts: number; collectMs: number }> {
  return unwrap(api.post('/prom/collect', undefined, { params: ds ? { ds } : {} }))
}

/* ---------------- 被屏蔽目标明细（v1.7.43） ---------------- */

/**
 * 「大屏为什么看不到这一条」的原因码（后端 handler_prom_masked.go 的同一套常量）：
 *  - `mask`     黑名单模式：命中屏蔽规则
 *  - `notwhite` 白名单模式：不在白名单里
 *  - `risk`     等级口径收窄（riskLevel = crit / warn 时被收掉的那一档）
 *  - `truncate` 清单超过大屏上限（100 条）被截掉 —— 不是被屏蔽，但同样没上屏
 */
export type PromHideReason = 'mask' | 'notwhite' | 'risk' | 'truncate'

/** 本次快照生效的判级阈值（表格给水位标色用，避免前端硬编码） */
export interface PromHiddenThresholds {
  cpuWarn: number
  cpuCrit: number
  memWarn: number
  memCrit: number
  diskWarn: number
  diskCrit: number
}

/** 被屏蔽的主机（目标维度）：这条回答「哪些目标被屏蔽了、它现在什么水位」 */
export interface PromHiddenHost {
  instance: string
  hostname: string
  name: string
  department: string
  system: string
  env: string
  deployserver: string
  up: boolean
  cpu: number
  mem: number
  disk: number
  net: number
  /** 被屏蔽的维度：cpu | mem | disk | net | offline */
  dims: string[]
  dimsCN: string[]
  risk: 'none' | 'warn' | 'crit'
  riskCN: string
  reason: PromHideReason
  reasonCN: string
  /** 命中的规则描述（黑名单模式才有） */
  rules: string[]
}

/** 被隐藏的风险项（条目维度）：字段与大屏清单一致，额外带原因与主机当前水位 */
export interface PromHiddenIssue extends PromIssue {
  reason: PromHideReason
  reasonCN: string
  ruleTarget?: string
  ruleMetric?: string
  note?: string
  hostUp: boolean
  hostCpu: number
  hostMem: number
  hostDisk: number
  hostNet: number
}

/** 被屏蔽掉的榜位：`wouldRank` = 不屏蔽时的名次（1 起），≤ topN 才是「本来能上屏」的 */
export interface PromHiddenRank {
  metric: 'cpu' | 'mem' | 'disk' | 'net'
  metricCN: string
  wouldRank: number
  instance: string
  hostname: string
  name: string
  department: string
  system: string
  env: string
  deployserver: string
  value: number
  reason: PromHideReason
  reasonCN: string
  ruleTarget?: string
  note?: string
}

export interface PromHiddenCounts {
  fleetHosts: number
  hiddenHosts: number
  issueTotal: number
  issueShown: number
  issueHidden: number
  maskedIssues: number
  riskIssues: number
  truncIssues: number
  rankSlots: number
  rankBeyond: number
  hostsCapped: boolean
  issuesCapped: boolean
}

/** 提示条：级别由后端判定（`error` = 需要马上处理，如白名单空规则导致全隐藏） */
export interface PromHiddenNotice {
  level: 'error' | 'warning' | 'info'
  text: string
}

export interface PromHiddenResp {
  dsId: number
  dsName: string
  ready: boolean
  collecting: boolean
  msg: string
  generatedAt: string
  collectMs: number
  maskMode: PromMaskMode
  riskLevel: PromRiskLevel
  topN: number
  masks: PromMaskRule[]
  thresholds: PromHiddenThresholds
  hosts: PromHiddenHost[]
  issues: PromHiddenIssue[]
  ranks: PromHiddenRank[]
  counts: PromHiddenCounts
  notices: PromHiddenNotice[]
}

/**
 * 被屏蔽目标明细：大屏上看不到的主机 / 风险项 / 榜位 + 它们当前的实时指标。
 * 服务端读快照现算（不查 Prometheus），毫秒级。
 */
export function promHidden(ds?: number): Promise<PromHiddenResp> {
  return unwrap(api.get('/prom/hidden', { params: ds ? { ds } : {} }))
}

/* ---------------- 报告记录（v1.7.36） ---------------- */

/** 列表项（不含明细数据，避免列表接口过大） */
export interface PromReportRecord {
  id: number
  title: string
  dsId: number
  dsName: string
  period: 'month' | 'quarter' | 'year'
  periodCN: string
  refDate: string
  start: string
  end: string
  hostCount: number
  points: number
  score: number
  level: string
  riskHosts: number
  critHosts: number
  cpuAvg: number
  cpuMax: number
  memAvg: number
  memMax: number
  diskAvg: number
  diskMax: number
  alertHit: number
  rowsTruncated: number
  remark: string
  createdBy: number
  createdByName: string
  createdAt: string
  // 项目范围（v1.7.38）：归档时冻结，回看历史报告才知道它覆盖了哪些项目
  systems: string[]
  systemCount: number
  scopeText: string
  templateId: number
  templateName: string
}

/** 详情（列表字段 + 冻结的报告数据） */
export interface PromReportRecordDetail extends PromReportRecord {
  rows: PromReportRow[]
  trend: PromTrendPoint[]
  fleet: PromReport['fleet']
  config: PromReport['config']
}

export interface PromReportRecordList {
  list: PromReportRecord[]
  total: number
  page: number
  pageSize: number
}

export interface PromGenerateResult {
  report: PromReport
  archived: boolean
  id?: number
  title?: string
  scopeText?: string
  templateId?: number
  templateName?: string
  msg?: string
}

/**
 * 生成报告并归档（一次聚合，两个用途：页面展示 + 报告记录）。
 *
 * systems 是**项目范围**：传数组 = 只统计这些项目；传 `[]` = 不限项目（全集群口径）；
 * 传 undefined 且带 templateId 时沿用模板范围。三者语义不同，别图省事都传 undefined。
 */
export function promGenerateReport(
  ds: number,
  period: 'month' | 'quarter' | 'year',
  ref?: string,
  title?: string,
  systems?: string[],
  templateId?: number,
): Promise<PromGenerateResult> {
  const body: Record<string, unknown> = { ds, period, ref, title }
  if (systems !== undefined) body.systems = systems
  if (templateId) body.templateId = templateId
  return unwrap(api.post('/prom/reports/generate', body))
}

export function listPromReports(params: {
  ds?: number
  period?: string
  /** 按项目名查历史报告（匹配归档时冻结的项目范围） */
  system?: string
  kw?: string
  page?: number
  pageSize?: number
}): Promise<PromReportRecordList> {
  return unwrap(api.get('/prom/reports', { params }))
}

export function getPromReport(id: number): Promise<PromReportRecordDetail> {
  return unwrap(api.get(`/prom/reports/${id}`))
}

export function updatePromReport(
  id: number,
  body: { title?: string; remark?: string },
): Promise<{ msg: string; record: PromReportRecord }> {
  return unwrap(api.put(`/prom/reports/${id}`, body))
}

export function deletePromReport(id: number): Promise<{ msg: string }> {
  return unwrap(api.delete(`/prom/reports/${id}`))
}

/* ---------------- 常用预置 PromQL（node_exporter 口径） ---------------- */

export const PROM_PRESETS: { label: string; query: string; range: boolean }[] = [
  {
    label: 'CPU 使用率',
    query: '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))',
    range: true,
  },
  {
    label: '内存使用率',
    query: '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
    range: true,
  },
  {
    label: '磁盘使用率',
    query:
      'max by (instance) (100 * (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|devtmpfs|overlay|squashfs"} / node_filesystem_size_bytes{fstype!~"tmpfs|devtmpfs|overlay|squashfs"}))',
    range: true,
  },
  {
    label: '系统负载',
    query: 'node_load1',
    range: true,
  },
  {
    label: '网络出流量',
    query: 'sum by (instance) (rate(node_network_send_bytes_total{device!~"lo|veth.*"}[5m]))',
    range: true,
  },
  {
    label: '网络入流量',
    query: 'sum by (instance) (rate(node_network_receive_bytes_total{device!~"lo|veth.*"}[5m]))',
    range: true,
  },
  {
    label: '存活目标',
    query: 'up',
    range: false,
  },
  {
    label: '内存总量(GB)',
    query: 'node_memory_MemTotal_bytes / 1024 / 1024 / 1024',
    range: false,
  },
]

// ============================================================================
// 监控告警报表 —— 夜莺（Nightingale）历史告警
//
// 与后端 handler_prom_n9e.go 的路由一一对应。数据流：
//   夜莺 API --(同步)--> 本地库 n9e_alert_events --(查询/统计/导出)--> 页面
// 之所以不是每次现拉：实测 90 天全量要 94 秒，页面等不起（见后端 service_n9e.go 注释）。
// ============================================================================

export interface N9eConfig {
  baseUrl: string
  hasToken: boolean
  tokenMask: string
  maxDays: number
  chunkDays: number
  pageSize: number
  lastSyncAt: string
  syncedRows: number
}

export interface N9eSyncState {
  running: boolean
  phase: string
  days: number
  fetched: number
  total: number
  chunkIndex: number
  chunkTotal: number
  startedAt: string
  finishedAt: string
  elapsedMs: number
  error: string
}

/** 夜莺告警记录（本地库副本；与后端 N9eAlertEvent 字段一一对应） */
export interface N9eAlertEvent {
  id: number
  cate: string
  /** 监控类型（夜莺 rule_prod）：metric / host / logging / … */
  ruleProd: string
  datasourceId: number
  datasourceName: string
  cluster: string
  groupId: number
  groupName: string
  ruleId: number
  ruleName: string
  ruleNote: string
  severity: number
  targetIdent: string
  targetHost: string
  department: string
  systemName: string
  triggerTime: number
  triggerValue: string
  recoverTime: number
  isRecovered: number
  firstTriggerTime: number
  notifyCurNumber: number
  notifyChannels: string
  syncedAt: string
}

export interface N9eKv {
  key: string
  value: number
}

export interface N9eStats {
  total: number
  recovered: number
  unresolved: number
  hostCount: number
  ruleCount: number
  bySeverity: N9eKv[]
  byGroup: N9eKv[]
  byRule: N9eKv[]
  byDept: N9eKv[]
  bySystem: N9eKv[]
  byDay: N9eKv[]
  stime: number
  etime: number
  localRows: number
  lastSyncAt: string
}

/** 列表 / 统计 / 导出共用的查询条件（三处必须同参，否则会出现「页面数与导出数不一致」） */
export interface N9eQueryParams {
  days?: number
  stime?: number
  etime?: number
  groupIds?: string
  datasourceIds?: string
  /** 监控类型多选（逗号分隔：metric,host,logging） */
  ruleProds?: string
  severity?: number
  recovered?: number
  department?: string
  keyword?: string
}

// ---------------------------------------------------------------------------
// 导出模板（v1.7.51）
//
// 模板 = 有序的列集合 + 筛选条件 + 时间范围。可见范围是**全局共享**：
// 所有人都能用、能改，列表里显示创建人便于追溯。
// ⚠️ 列的 key 定义在后端 n9eExportCols（单一事实源），前端只负责勾选与排序，
// 不要在前端硬编码列清单 —— 否则后端加了列、前端下拉里没有。
// ---------------------------------------------------------------------------

/** 导出模板里保存的筛选条件 */
export interface N9eExportFilter {
  /** days = 相对天数（推荐，长期有效）；custom = 字面区间 */
  timeMode: 'days' | 'custom'
  days: number
  stime: number
  etime: number
  datasourceIds: number[]
  groupIds: number[]
  /** 监控类型（v1.7.52，对齐夜莺 rule_prods） */
  ruleProds: string[]
  severity: number
  recovered: number
  department: string
  keyword: string
}

export interface N9eExportTemplate {
  id: number
  name: string
  remark: string
  /** 列 Key 列表，顺序即导出列顺序 */
  columns: string[]
  colCount: number
  filter: N9eExportFilter
  ownerId: number
  ownerName: string
  createdAt: string
  updatedAt: string
}

/** 保存模板的入参（新建走 create，改走 update） */
export interface N9eExportTemplateInput {
  name: string
  remark: string
  columns: string[]
  filter: N9eExportFilter
}

export interface N9eExportCol {
  key: string
  label: string
}

export function listN9eExportColumns(): Promise<{ list: N9eExportCol[] }> {
  return unwrap(api.get('/prom/n9e/export-columns'))
}

export function listN9eExportTemplates(): Promise<{ list: N9eExportTemplate[] }> {
  return unwrap(api.get('/prom/n9e/export-templates'))
}

export function createN9eExportTemplate(
  body: N9eExportTemplateInput,
): Promise<{ id: number }> {
  return unwrap(api.post('/prom/n9e/export-templates', body))
}

export function updateN9eExportTemplate(
  id: number,
  body: N9eExportTemplateInput,
): Promise<{ id: number }> {
  return unwrap(api.put(`/prom/n9e/export-templates/${id}`, body))
}

export function deleteN9eExportTemplate(id: number): Promise<{ id: number }> {
  return unwrap(api.delete(`/prom/n9e/export-templates/${id}`))
}

export function getN9eConfig(): Promise<N9eConfig> {
  return unwrap(api.get('/prom/n9e-config'))
}

export function saveN9eConfig(body: { baseUrl: string; token?: string }): Promise<{ msg: string }> {
  return unwrap(api.put('/prom/n9e-config', body))
}

/** 连通性测试；extra 用于「未保存先测试」 */
export function testN9eConfig(body: {
  baseUrl?: string
  token?: string
}): Promise<{ ok: boolean; msg: string; elapsed: number }> {
  return unwrap(api.post('/prom/n9e-config/test', body))
}

export function startN9eSync(days: number): Promise<{ started: boolean; msg: string }> {
  return unwrap(api.post('/prom/n9e/sync', { days }))
}

export function getN9eSyncStatus(): Promise<{ state: N9eSyncState; localRows: number }> {
  return unwrap(api.get('/prom/n9e/sync-status'))
}

export function listN9eEvents(
  params: N9eQueryParams & { page?: number; pageSize?: number },
): Promise<{ list: N9eAlertEvent[]; total: number; page: number; pageSize: number }> {
  return unwrap(api.get('/prom/n9e/events', { params }))
}

/**
 * 三个「选项 + 条数」下拉接口只关心时间范围。
 * ⚠️ 必须带上当前时间范围：下拉里的条数是按**同一时间窗**统计出来的，
 * 不带的话下拉写「公共组件政务外 (95674)」、点进去总数 95669，用户只会认为报表算错了。
 */
export type N9eTimeParams = Pick<N9eQueryParams, 'days' | 'stime' | 'etime'>

/**
 * 业务组选项（带条数）。
 *
 * ⚠️ 后端返回的是**全部**业务组（对齐夜莺的 busi-groups 清单，本环境 24 个），
 * 而不是「历史告警里出现过的那些」（只有 11 个）。同步时会把清单整份落到
 * n9e_busi_groups 表，因此升级后需**重新同步一次**（未同步过时会退化成按事件去重）。
 */
export function listN9eGroups(
  params?: N9eTimeParams,
): Promise<{ list: { groupId: number; groupName: string; n: number }[] }> {
  return unwrap(api.get('/prom/n9e/groups', { params }))
}

/**
 * 监控类型选项（对齐夜莺的固定清单 Metric / Host / Log，带条数）。
 * 与夜莺一致：允许 0 条也会列出来，用户要能看见「Host 这个类型没有告警」。
 */
export function listN9eRuleProds(params?: N9eTimeParams): Promise<{
  list: { value: string; label: string; n: number }[]
}> {
  return unwrap(api.get('/prom/n9e/rule-prods', { params }))
}

/**
 * 数据源选项（本地库 distinct，带条数）。
 * ⚠️ 老环境升级到本版本后，历史数据的 datasource_id 为 0，需要**先重新同步一次**
 * 数据源选项才会出现（只读本地库是刻意的：避免列出没有数据的数据源让用户选到空结果）。
 */
export function listN9eDatasources(params?: N9eTimeParams): Promise<{
  list: { datasourceId: number; datasourceName: string; n: number }[]
}> {
  return unwrap(api.get('/prom/n9e/datasources', { params }))
}

export function listN9eDepartments(params?: N9eTimeParams): Promise<{
  departments: { value: string; n: number }[]
  systems: { value: string; n: number }[]
}> {
  return unwrap(api.get('/prom/n9e/departments', { params }))
}

export function getN9eStats(params: N9eQueryParams): Promise<N9eStats> {
  return unwrap(api.get('/prom/n9e/stats', { params }))
}

/**
 * 导出夜莺告警记录为 xlsx。
 *
 * 用 axios 取 blob 而不是 window.open：导出接口要带 Authorization 头，
 * 直接开新窗口带不上；且后端在出错时返回的是 JSON，需要在这里识别后抛出可读提示。
 * timeout 单独放宽到 5 分钟 —— 25 万行生成 xlsx 会超过全局的 60 秒。
 */
/**
 * 导出告警记录为 xlsx。
 *
 * 两种用法：
 * - 传 `tplId`：后端**以模板为准**（列 + 筛选 + 时间范围全取模板，忽略其余筛选参数），
 *   文件名为「夜莺告警记录_<模板名>_...xlsx」。
 * - 不传 tplId：用 `params` 里的筛选条件，`cols` 可指定导出列（逗号分隔的列 Key；不传 = 全列）。
 */
export async function exportN9eAlerts(
  params: N9eQueryParams & { cols?: string; tplId?: number },
): Promise<{ blob: Blob; filename: string }> {
  const r = await api.get('/prom/n9e/export', {
    params,
    responseType: 'blob',
    timeout: 300000,
  })
  const blob = r.data as Blob
  const ctype = String(r.headers?.['content-type'] || blob.type || '')
  if (ctype.includes('application/json')) {
    const text = await blob.text()
    let msg = '导出失败'
    try {
      const j = JSON.parse(text)
      if (j && j.msg) msg = j.msg
    } catch {
      // 解析不出 JSON 就用默认提示
    }
    throw new Error(msg)
  }
  let filename = '夜莺告警记录.xlsx'
  const cd = String(r.headers?.['content-disposition'] || '')
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd)
  if (m) {
    try {
      filename = decodeURIComponent(m[1])
    } catch {
      // 解码失败就用默认文件名
    }
  }
  return { blob, filename }
}
