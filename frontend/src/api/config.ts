// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import api from './client'

// ============================================================================
// 配置管理（nginx 配置文件管理）
// ============================================================================

export interface NginxConfigItem {
  id: number
  configType: string
  assetId: number
  assetName: string
  host: string
  path: string
  kind: string // main / conf.d / site / module / other
  content: string
  remoteMd5: string
  status: string // synced / modified / error / notfound / unknown
  lastSyncAt: string | null
  lastScanAt: string | null
  createdAt: string
  updatedAt: string
}

export interface NginxConfigStats {
  total: number
  synced: number
  modified: number
  error: number
  notfound: number
  unknown: number
}

export interface ScannedNginxItem {
  assetId: number
  assetName: string
  host: string
  path: string
  kind: string
  content: string
  md5: string
  size: number
  error?: string
}

export interface ScanScopeAsset {
  id: number
  name: string
  ip: string
}

const unwrap = <T,>(d: { code: number; msg: string; data: T }): T => {
  if (d.code !== 0) throw new Error(d.msg || '请求失败')
  return d.data
}

// 可扫描资产清单（扫描选择器）
export async function configScanScope(): Promise<{ assets: ScanScopeAsset[]; total: number }> {
  const { data } = await api.get('/config/scan/scope')
  return unwrap(data)
}

// 扫描 nginx 配置：单台 assetId 或 all
export async function scanNginxConfigs(payload: { assetId?: number; all?: boolean }): Promise<{
  items: ScannedNginxItem[]
  assetCount: number
  foundCount: number
  okCount: number
}> {
  const { data } = await api.post('/config/scan', payload, { timeout: 300000 })
  return unwrap(data)
}

// 导入扫描结果（持久化为纳管记录）
export async function importNginxConfigs(items: Array<Partial<ScannedNginxItem>>): Promise<{
  created: number
  skipped: number
  failed: number
}> {
  const { data } = await api.post('/config/import', { items })
  return unwrap(data)
}

// 纳管列表（含统计）
export async function listNginxConfigs(params: {
  assetId?: number
  status?: string
  keyword?: string
}): Promise<{ list: NginxConfigItem[]; stats: NginxConfigStats }> {
  const { data } = await api.get('/config', { params })
  return unwrap(data)
}

// 详情（含内容）
export async function getNginxConfig(id: number): Promise<NginxConfigItem> {
  const { data } = await api.get(`/config/${id}`)
  return unwrap(data)
}

// 新增纳管项（可带初始内容；不自动写远端）
export async function createNginxConfig(payload: {
  assetId: number
  path: string
  kind?: string
  content?: string
}): Promise<NginxConfigItem> {
  const { data } = await api.post('/config', payload)
  return unwrap(data)
}

// 更新元数据（路径/类型）
export async function updateNginxConfig(
  id: number,
  payload: { path?: string; kind?: string }
): Promise<NginxConfigItem> {
  const { data } = await api.put(`/config/${id}`, payload)
  return unwrap(data)
}

// 删除纳管项；deleteRemote=true 时一并删除远端文件
export async function deleteNginxConfig(id: number, deleteRemote = false): Promise<{ deleted: boolean; remoteDeleted?: boolean; remoteWarning?: string }> {
  const { data } = await api.delete(`/config/${id}`, { params: deleteRemote ? { deleteRemote: 'true' } : {} })
  return unwrap(data)
}

// 从远端拉取内容
export async function pullNginxConfig(id: number): Promise<NginxConfigItem> {
  const { data } = await api.post(`/config/${id}/pull`, {}, { timeout: 120000 })
  return unwrap(data)
}

// 保存并同步到远端（nginx -t 校验）
export async function syncNginxConfig(
  id: number,
  content: string
): Promise<{ id: number; status: string; valid: boolean; validateOutput: string; remoteMd5: string; lastSyncAt: string | null }> {
  const { data } = await api.post(`/config/${id}/sync`, { content }, { timeout: 120000 })
  return unwrap(data)
}
