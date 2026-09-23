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
   * 面板显示开关（v1.7.41）：`{ 面板key: false }`。
   * ⚠️ 语义是「**表里没有的键 = 展示**」（缺省全开）—— 历史配置没有这个字段，升级后行为不变。
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

/** 屏蔽规则：命中 target 的主机指标不再进入大屏「超阈值主机」面板（v1.7.35） */
export interface PromMaskRule {
  target: string
  metric: 'all' | 'cpu' | 'mem' | 'disk' | 'offline'
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
