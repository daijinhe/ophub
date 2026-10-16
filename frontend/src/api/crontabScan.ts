// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import api from './client'

/** 扫描批次 */
export interface CrontabScanJob {
  id: number
  name: string
  /** running / done / failed / stopped */
  status: string
  scopeDesc: string
  scopeJson: string
  total: number
  scanned: number
  okCount: number
  failCount: number
  skipCount: number
  taskCount: number
  managedCount: number
  unmanagedCount: number
  enabledCount: number
  disabledCount: number
  dangerCount: number
  warnCount: number
  hostWithTask: number
  durationMs: number
  error: string
  startedAt?: string
  finishedAt?: string
  createdAt: string
}

/** 批次内单台目标机的扫描结果 */
export interface CrontabScanAsset {
  id: number
  jobId: number
  assetId: number
  assetName: string
  host: string
  sshUser: string
  categoryId: number
  /** 业务项目（分类树首层） */
  project: string
  categoryPath: string
  env: string
  businessEnv: string
  zone: string
  osFamily: string
  osRaw: string
  /** ok / fail / skip */
  status: string
  error: string
  totalLines: number
  taskCount: number
  managedCount: number
  unmanagedCount: number
  enabledCount: number
  disabledCount: number
  dangerCount: number
  warnCount: number
  contentHash: string
  durationMs: number
  scannedAt?: string
}

/** 扫描发现的一条定时任务（含分类结果） */
export interface CrontabScanTask {
  id: number
  jobId: number
  assetId: number
  assetName: string
  host: string
  project: string
  env: string
  businessEnv: string
  zone: string
  osFamily: string
  lineNo: number
  raw: string
  name: string
  cronExpr: string
  command: string
  enabled: boolean
  /** managed / unmanaged */
  origin: string
  /** minute/hour/day/week/month/year/boot/custom/unknown */
  freq: string
  freqLabel: string
  /** backup/log/clean/sync/monitor/restart/report/script/other */
  category: string
  categoryLabel: string
  /** danger/warn/normal */
  risk: string
  riskLabel: string
  riskNotes: string
  describe: string
  platformTaskId: number
  drift: boolean
  anomaly: string
  adopted: boolean
}

export interface CrontabScanScope {
  assetIds?: number[]
  categoryId?: number
  keyword?: string
  env?: string
  businessEnv?: string
  zone?: string
  onlyReady?: boolean
}

export interface ScanScopePreview {
  total: number
  ready: number
  missingCred: number
  missingIP: number
  desc: string
  limit: number
  overLimit: boolean
  samples: { assetId: number; assetName: string; ip: string; ssh: string }[]
}

export interface CronDimCount {
  key: string
  label: string
  count: number
}

export interface ScanSummary {
  job: CrontabScanJob
  byOrigin: CronDimCount[]
  byFreq: CronDimCount[]
  byCategory: CronDimCount[]
  byRisk: CronDimCount[]
  byProject: CronDimCount[]
  byEnv: CronDimCount[]
  byZone: CronDimCount[]
  byOS: CronDimCount[]
  topHosts: { name: string; host: string; count: number }[]
}

export async function previewCrontabScanScope(scope: CrontabScanScope): Promise<ScanScopePreview> {
  const params: Record<string, any> = {
    categoryId: scope.categoryId || undefined,
    keyword: scope.keyword || undefined,
    env: scope.env || undefined,
    businessEnv: scope.businessEnv || undefined,
    zone: scope.zone || undefined,
    onlyReady: scope.onlyReady ? 1 : undefined,
  }
  if (scope.assetIds && scope.assetIds.length) params.assetIds = scope.assetIds.join(',')
  const r = await api.get('/crontab/scan/scope', { params })
  return r.data.data as ScanScopePreview
}

export async function startCrontabScan(body: { name?: string; scope: CrontabScanScope }) {
  const r = await api.post('/crontab/scan', body)
  return r.data.data.job as CrontabScanJob
}

export async function listCrontabScanJobs(params: { page?: number; size?: number; keyword?: string; status?: string }) {
  const r = await api.get('/crontab/scan/jobs', { params })
  const d = r.data.data
  return { list: (d.list || []) as CrontabScanJob[], total: d.total as number }
}

export async function getCrontabScanJob(id: number) {
  const r = await api.get(`/crontab/scan/jobs/${id}`)
  return r.data.data as CrontabScanJob
}

export async function crontabScanSummary(id: number) {
  const r = await api.get(`/crontab/scan/jobs/${id}/summary`)
  return r.data.data as ScanSummary
}

export async function listCrontabScanAssets(
  id: number,
  params: { page?: number; size?: number; status?: string; keyword?: string; hasTask?: string } = {},
) {
  const r = await api.get(`/crontab/scan/jobs/${id}/assets`, { params })
  const d = r.data.data
  return { list: (d.list || []) as CrontabScanAsset[], total: d.total as number }
}

export interface ScanTaskFilter {
  page?: number
  size?: number
  origin?: string
  category?: string
  freq?: string
  risk?: string
  enabled?: string
  assetId?: number
  project?: string
  env?: string
  zone?: string
  osFamily?: string
  riskOnly?: string
  keyword?: string
}

export async function listCrontabScanTasks(id: number, params: ScanTaskFilter = {}) {
  const r = await api.get(`/crontab/scan/jobs/${id}/tasks`, { params })
  const d = r.data.data
  return { list: (d.list || []) as CrontabScanTask[], total: d.total as number }
}

export async function stopCrontabScanJob(id: number) {
  const r = await api.post(`/crontab/scan/jobs/${id}/stop`)
  return r.data.data as { stopping: number }
}

export async function deleteCrontabScanJob(id: number) {
  const r = await api.delete(`/crontab/scan/jobs/${id}`)
  return r.data.data as { deleted: number }
}

export interface AdoptResult {
  adopted: { scanTaskId: number; taskId: number; name: string; assetId: number; assetName: string; host: string }[]
  failed: { scanTaskId: number; name: string; error: string }[]
  okCount: number
  failCount: number
}

export async function adoptScanTasks(ids: number[]): Promise<AdoptResult> {
  const r = await api.post('/crontab/scan/adopt', { ids })
  return r.data.data as AdoptResult
}

/** 分类维度的展示配置（顺序 / 配色），前端统一口径 */
export const SCAN_RISK_META: Record<string, { color: string; label: string }> = {
  danger: { color: 'red', label: '高危' },
  warn: { color: 'orange', label: '需关注' },
  normal: { color: 'green', label: '正常' },
}

export const SCAN_ORIGIN_META: Record<string, { color: string; label: string }> = {
  managed: { color: 'blue', label: '平台纳管' },
  unmanaged: { color: 'purple', label: '人工维护' },
}

export const SCAN_CATEGORY_META: Record<string, { color: string; label: string }> = {
  backup: { color: 'geekblue', label: '数据备份' },
  monitor: { color: 'cyan', label: '监控采集' },
  sync: { color: 'gold', label: '数据同步' },
  log: { color: 'volcano', label: '日志处理' },
  clean: { color: 'magenta', label: '临时清理' },
  restart: { color: 'lime', label: '服务重启' },
  report: { color: 'purple', label: '统计报表' },
  script: { color: 'blue', label: '脚本执行' },
  other: { color: 'default', label: '其他命令' },
}

export const SCAN_FREQ_META: Record<string, { color: string; label: string }> = {
  minute: { color: 'red', label: '每分钟级' },
  hour: { color: 'orange', label: '每小时级' },
  day: { color: 'blue', label: '每天' },
  week: { color: 'geekblue', label: '每周' },
  month: { color: 'purple', label: '每月' },
  year: { color: 'cyan', label: '每年' },
  boot: { color: 'magenta', label: '开机时' },
  custom: { color: 'default', label: '自定义' },
  unknown: { color: 'default', label: '无法解析' },
}
