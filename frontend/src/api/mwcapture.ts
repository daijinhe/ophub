// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import api from './client'

// ---------------------------------------------------------------------------
// 中间件捕捉（Middleware Capture）
//
// 与「中间件管控（mwops）」的区别：管控管的是**已纳管**实例，
// 捕捉是**不预设装了什么**、只读扫描整机，把存量中间件也一并捞出来。
// ---------------------------------------------------------------------------

/** 代码路径（按端口配对：一台机器上两个端口常对应两套代码）
 *
 * `biz` 是手工填写的「代码业务」，采集脚本不解析。
 */
export interface MwCodePath {
  port: string
  path: string
  /** 代码业务（手动填写，例如：权责清单/信访系统） */
  biz?: string
}

/** 一个 Java 应用（可能多个 jar / 多个应用） */
export interface MwJavaApp {
  pid: number
  name: string
  jar: string
  codePath: string
  /** 代码业务（手动填写） */
  biz?: string
  port: string
  command: string
  version: string
}

/** 通用键值（redis 的存储位置等） */
export interface MwKv {
  key: string
  value: string
}

/** 一类中间件的捕捉结果（没有的字段为空，前端不渲染空行） */
export interface MwCaptureItem {
  type: string
  label: string
  running: boolean
  version?: string
  ports?: string[]
  installPath?: string
  configPaths?: string[]
  logPaths?: string[]
  codePaths?: MwCodePath[]
  certs?: string[]
  jars?: MwJavaApp[]
  storage?: MwKv[]
  /** 访问密码（2026-09-17 新增，当前仅 redis 使用，可就地编辑） */
  password?: string
  notes?: string[]
}

/** 单资产捕捉结果 */
export interface MwCaptureDetail {
  assetId: number
  exists: boolean
  status?: string
  mwTypes?: string[]
  items?: MwCaptureItem[]
  customFields?: MwKv[]
  error?: string
  privileged?: boolean
  durationMs?: number
  capturedAt?: string
  capturedBy?: string
  host?: string
  zone?: string
  raw?: string
}

/** 资产列表项（带捕捉摘要） */
export interface MwCaptureAssetItem {
  assetId: number
  assetName: string
  vmName: string
  ip: string
  zone: string
  ready: boolean
  reason?: string
  sshHost?: string
  sshUser?: string
  runUser?: string
  capture?: {
    status: string
    mwTypes: string[]
    capturedAt: string
    privileged: boolean
    error: string
    count: number
  }
}

export interface MwCaptureRunResult {
  assetId: number
  assetName: string
  status: string
  mwTypes: string[]
  error: string
  durationMs: number
}

export const MW_CAPTURE_STATUS_TEXT: Record<string, string> = {
  ok: '已捕捉',
  partial: '已捕捉（信息不全）',
  none: '未发现中间件',
  failed: '捕捉失败',
}

/** 目标中间件（用于「未发现」提示、列表标签、以及详情里「添加中间件」的可选项） */
export const MW_CAPTURE_TYPES: { type: string; label: string; short: string }[] = [
  { type: 'nginx', label: 'Nginx', short: 'nginx' },
  { type: 'php', label: 'PHP-FPM', short: 'php' },
  { type: 'java', label: 'Java', short: 'java' },
  { type: 'redis', label: 'Redis', short: 'redis' },
  { type: 'es', label: 'ElasticSearch', short: 'es' },
  { type: 'bws310', label: '宝兰德 BWS310', short: 'bws310' },
  { type: 'tomcat', label: 'Tomcat', short: 'tomcat' },
]

/** 资产列表（带捕捉摘要） */
export const listMwCaptureAssets = (params?: { keyword?: string; zone?: string }) =>
  api.get<{ code: number; data: { list: MwCaptureAssetItem[]; total: number } }>('/mwcapture/assets', { params })

/** 批量捕捉（耗时较长，单独放宽超时） */
export const runMwCapture = (assetIds: number[]) =>
  api.post<{
    code: number
    data: {
      list: MwCaptureRunResult[]
      scanned: number
      okCount: number
      noneCount: number
      errorCount: number
      middlewareTotal: number
      capturedAt: string
    }
  }>(
    '/mwcapture/run',
    { assetIds },
    // 单批最多 6 台、并发 4，最坏情况也要 200s 量级，默认 60s 会被截断
    { timeout: 600000 },
  )

/** 单资产捕捉结果 */
export const getMwCapture = (assetId: number, raw = false) =>
  api.get<{ code: number; data: MwCaptureDetail }>(`/mwcapture/asset/${assetId}`, {
    params: raw ? { raw: 1 } : undefined,
  })

/** 清除某资产的捕捉结果 */
export const deleteMwCapture = (assetId: number) =>
  api.delete<{ code: number }>(`/mwcapture/asset/${assetId}`)

/** 保存资产详情里手工修改 / 补充的中间件信息（含自定义字段） */
export const updateMwCapture = (assetId: number, payload: { items: MwCaptureItem[]; customFields: MwKv[] }) =>
  api.put<{ code: number }>(`/mwcapture/asset/${assetId}`, payload)

/** 导出捕捉结果 Excel */
export const exportMwCaptures = (assetIds?: number[]) =>
  api.get('/mwcapture/export', {
    params: assetIds && assetIds.length ? { ids: assetIds.join(',') } : undefined,
    responseType: 'blob',
    timeout: 120000,
  })

/** 触发浏览器下载 */
export function downloadBlob(data: BlobPart, filename: string) {
  const url = window.URL.createObjectURL(new Blob([data]))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.URL.revokeObjectURL(url)
}
