import api from './client'

export interface MetricDef {
  category: string
  key: string
  label: string
  unit: string
  kind: string
  warn: number
  crit: number
  note: string
  isPercent: boolean
}

export interface MetricGroup {
  key: string
  label: string
  metrics: MetricDef[]
}

export interface InspectionCatalog {
  groups: MetricGroup[]
  metrics: MetricDef[]
  categories: string[]
}

export interface InspectionTask {
  id: number
  name: string
  scopeType: string
  categoryId?: number | null
  assetIds?: number[]
  metrics?: string[] // 存储的是选中的采集分类键
  categories?: string[]
  freq: string
  remoteNodeId?: number | null
  remoteNodeName?: string
  sshUser?: string
  sshPort?: number
  scheduleEnabled: boolean
  lastRunAt?: string
  nextRunAt?: string
  status: string
  createdAt?: string
}

export const FreqOptions = [
  { label: '手动执行', value: 'manual' },
  { label: '每日', value: 'day' },
  { label: '每周', value: 'week' },
  { label: '每月', value: 'month' },
  { label: '每季度', value: 'quarter' },
  { label: '每年', value: 'year' },
]

export const ScopeOptions = [
  { label: '全部资产', value: 'all' },
  { label: '按分类', value: 'category' },
  { label: '手动选择', value: 'selected' },
]

export const getMetricCatalog = () =>
  api.get('/inspection/metrics').then((r) => r.data.data as InspectionCatalog)

export const listTasks = () => api.get('/inspection/tasks').then((r) => r.data.data)

export const createTask = (d: any) => api.post('/inspection/tasks', d).then((r) => r.data)
export const updateTask = (id: number, d: any) =>
  api.put(`/inspection/tasks/${id}`, d).then((r) => r.data)
export const deleteTask = (id: number) =>
  api.delete(`/inspection/tasks/${id}`).then((r) => r.data)
export const batchDeleteTasks = (ids: number[]) =>
  api.delete('/inspection/tasks/batch', { data: { ids } }).then((r) => r.data)
export const runTask = (id: number) =>
  api.post(`/inspection/tasks/${id}/run`).then((r) => r.data)

export const listRecords = (params: any) =>
  api.get('/inspection/records', { params }).then((r) => r.data.data)
export const getRecord = (id: number) =>
  api.get(`/inspection/records/${id}`).then((r) => r.data.data)
export const batchDeleteRecords = (ids: number[]) =>
  api.delete('/inspection/records', { data: { ids } }).then((r) => r.data)
export const listResults = (recordId: number) =>
  api.get('/inspection/results', { params: { recordId } }).then((r) => r.data.data)

export const getDashboard = (params?: { env?: string; zone?: string; arch?: string }) =>
  api.get('/inspection/dashboard', { params }).then((r) => r.data.data)
export const getExport = (period: string, ref: string, taskId?: number, recordId?: number) =>
  api
    .get('/inspection/export', { params: { period, ref, taskId, recordId } })
    .then((r) => r.data.data)

// ===== 告警规则（按项目/应用系统/资产自定义阈值 + 屏蔽告警）=====

export interface ThresholdDef {
  key: string
  label: string
  unit: string
  kind: string // percent | number | ratio
  warn: number
  crit: number
  note: string
}

/** 阈值覆盖：字段缺省 = 沿用默认；crit 显式填 0 = 关闭严重级别判定 */
export interface ThresholdOverride {
  warn?: number | null
  crit?: number | null
}

export interface InspectionAlertRule {
  id: number
  name: string
  enabled: boolean
  matchType: string // project | system | asset
  matchValues: (string | number)[]
  thresholds: Record<string, ThresholdOverride>
  thresholdCount?: number
  muteAll: boolean
  muteMetrics: string[]
  mutedCount?: number
  priority: number
  remark: string
  createdAt?: string
  updatedAt?: string
  _preview?: { matched: number; total: number }
}

export interface AlertRuleCatalog {
  thresholds: ThresholdDef[]
  projects: string[]
  systems: string[]
  assets: { id: number; name: string; ip: string; project: string; system: string }[]
}

export const MatchTypeOptions = [
  { label: '按项目简称', value: 'project' },
  { label: '按应用系统名称', value: 'system' },
  { label: '按指定资产', value: 'asset' },
]

export const MATCH_TYPE_LABEL: Record<string, string> = {
  project: '项目简称',
  system: '应用系统名称',
  asset: '指定资产',
}

export const listAlertRules = () =>
  api.get('/inspection/alert-rules').then((r) => r.data.data)

export const getAlertRuleCatalog = () =>
  api.get('/inspection/alert-rules/catalog').then((r) => r.data.data as AlertRuleCatalog)

export const createAlertRule = (d: any) =>
  api.post('/inspection/alert-rules', d).then((r) => r.data)

export const updateAlertRule = (id: number, d: any) =>
  api.put(`/inspection/alert-rules/${id}`, d).then((r) => r.data)

export const deleteAlertRule = (id: number) =>
  api.delete(`/inspection/alert-rules/${id}`).then((r) => r.data)

export const previewAlertRule = (d: any) =>
  api.post('/inspection/alert-rules/preview', d).then((r) => r.data.data)
