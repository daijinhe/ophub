// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

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
  /** @deprecated 单选分类（老口径）。新任务一律写 categoryIds，此字段仅用于读历史任务。 */
  categoryId?: number | null
  /** 按分类时生效：任意层级的分类 ID 列表（单选=1 个、多选=多个），选父级自动含全部子孙 */
  categoryIds?: number[]
  assetIds?: number[]
  metrics?: string[] // 存储的是选中的采集分类键
  categories?: string[]
  freq: string
  /** Freq=minute：每隔 N 分钟（1-1440） */
  intervalMin?: number
  /** Freq=hour：每隔 N 小时（1-72） */
  intervalHour?: number
  /** Freq=week：1=周一 … 7=周日 */
  weekday?: number
  /** Freq=month：每月几号（1-31） */
  monthDay?: number
  /** Freq=day/week/month：执行时刻「时」（0-23） */
  runHour?: number
  /** Freq=hour/day/week/month：执行时刻「分」（0-59） */
  runMinute?: number
  remoteNodeId?: number | null
  remoteNodeName?: string
  /** 采集失败时用模拟数据兜底（仅演示；默认关，失败即记为 fail 并给出真实原因） */
  allowSimulated?: boolean
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
  { label: '每隔 N 分钟', value: 'minute' },
  { label: '每隔 N 小时', value: 'hour' },
  { label: '每天（指定时刻）', value: 'day' },
  { label: '每周（指定星期）', value: 'week' },
  { label: '每月（指定日期）', value: 'month' },
  { label: '每季度', value: 'quarter' },
  { label: '每年', value: 'year' },
]

/** 星期选项：与后端 Weekday 口径一致（1=周一 … 7=周日） */
export const WeekdayOptions = [
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 7 },
]

/** 每月日期选项（1-31，当月天数不足时后端自动取月末） */
export const MonthDayOptions = Array.from({ length: 31 }, (_, i) => ({
  label: `${i + 1} 号`,
  value: i + 1,
}))

const pad2 = (n?: number) => String(n ?? 0).padStart(2, '0')

/**
 * 把任务的调度配置渲染成人话 —— 任务列表、巡检大屏共用这一个口径。
 * 后端 computeNextRun 按同一套字段推算下次执行时间，两边必须逐字对应。
 */
export function scheduleText(t: Partial<InspectionTask> | undefined | null): string {
  if (!t) return '—'
  switch (t.freq) {
    case 'manual':
      return '手动执行'
    case 'minute':
      return `每隔 ${t.intervalMin || 1} 分钟`
    case 'hour':
      return `每隔 ${t.intervalHour || 1} 小时（第 ${t.runMinute || 0} 分）`
    case 'day':
      return `每天 ${pad2(t.runHour)}:${pad2(t.runMinute)}`
    case 'week':
      return `每周${
        WeekdayOptions.find((w) => w.value === t.weekday)?.label || '一'
      } ${pad2(t.runHour)}:${pad2(t.runMinute)}`
    case 'month':
      return `每月 ${t.monthDay || 1} 号 ${pad2(t.runHour)}:${pad2(t.runMinute)}`
    case 'quarter':
      return '每季度'
    case 'year':
      return '每年'
    default:
      return '手动执行'
  }
}

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
