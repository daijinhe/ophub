// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import api from './client'

/** 单个校准项（后端逐项比对结果） */
export interface CalibItem {
  key: string
  label: string
  /** 资产已登记值 */
  imported: string
  /** 实测值（可写回）；操作系统写入的是 /etc/os-release 的 ID+版本号（如 almalinux8.9） */
  detected: string
  /** 实测原始值，用于人工核对 */
  raw: string
  /** 平台标准写法（仅提示，不写入资产） */
  std?: string
  /** 识别到的磁盘设备名 */
  device?: string
  /** 是否与已登记值不一致（同步会改写登记值） */
  diff: boolean
  /** 与登记值为同一对象、仅书写不同（操作系统专用） */
  same?: boolean
  /** 是否允许同步（实测值为空时为 false，避免把已登记值覆盖成空） */
  synced: boolean
  hint?: string
}

/** 资源校准采集结果 */
export interface CalibResult {
  assetId: number
  assetName: string
  ip: string
  zone: string
  ssh: string
  items: CalibItem[]
  durationMs: number
  warning?: string
  probeOutput?: string
}

/**
 * 发起资源校准：后端 SSH 直连目标机采集硬件规格并与资产登记值比对。
 * 探测走真实 SSH，耗时可能较长，这里单独放宽超时。
 */
export async function calibrateAsset(assetId: number): Promise<CalibResult> {
  const { data } = await api.post(`/assets/${assetId}/calibrate`, {}, { timeout: 120000 })
  return data.data
}

/** 确认同步：把勾选的校准项写回资产 */
export async function applyCalibration(assetId: number, fields: Record<string, string>): Promise<{ synced: string[] }> {
  const { data } = await api.post(`/assets/${assetId}/calibrate/apply`, { fields })
  return data.data
}
