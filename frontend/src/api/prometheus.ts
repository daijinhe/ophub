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

export interface PromUsageDist {
  low: number
  mid: number
  high: number
  crit: number
  none: number
}

export interface PromOverview {
  generatedAt: string
  collectMs: number
  source: string
  dsName: string
  up: { total: number; online: number; offline: number }
  avg: { cpu: number; mem: number; disk: number }
  usageDist: PromUsageDist
  trend: PromTrendPoint[]
  hosts: PromHostStat[]
  top: { cpu: PromTopEntry[]; mem: PromTopEntry[]; disk: PromTopEntry[] }
  issues: PromIssue[]
  issueStat: PromIssueStat
  groups: PromGroupStat[]
  config: PromCfgView
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

export function promReport(
  ds: number,
  period: 'month' | 'quarter' | 'year',
  ref?: string,
): Promise<PromReport> {
  return unwrap(api.get('/prom/report', { params: { ds, period, ref } }))
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
