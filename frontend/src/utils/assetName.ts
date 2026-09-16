/**
 * 资产展示名：全系统唯一口径
 *
 * 背景：此前平台里散落着多套互不相干的资产名拼法（Web 终端会话名、CMDB 详情标题、
 * 定时任务列表名、巡检大屏名、nginx 配置纳管名），且部分接口返回的是入库时的快照。
 * 结果在资产管理里改了字段，只有部分页面跟着变，看起来像「不同步」。
 *
 * 约定：
 *   1. 任何地方需要展示资产名，一律调用这里，禁止再各写一份拼接逻辑；
 *   2. 口径固定为 项目简称_环境_业务环境_虚拟机IPv4，与后端
 *      backend/asset_name.go 的 AssetDisplayName **严格对应**；
 *      改这里必须同步改后端，否则前后端会出现两个名字。
 *   3. 空段跳过（避免出现 "A__B" 这种空洞），全空时回退「虚拟机名称」→ 资产名。
 */

export interface AssetLike {
  id?: number
  name?: string
  ip?: string
  fields?: Record<string, any> | null
}

/** 展示名各段对应的 CMDB 字段（顺序即拼接顺序，末尾再补 IP） */
export const ASSET_DISPLAY_KEYS = ['项目简称', '环境', '业务环境'] as const

const str = (v: any): string => (v === null || v === undefined ? '' : String(v).trim())

/** 统一展示名：项目简称_环境_业务环境_虚拟机IPv4 */
export function assetDisplayName(a: AssetLike | null | undefined): string {
  if (!a) return '—'
  const f = (a.fields || {}) as Record<string, any>
  const parts: string[] = []
  for (const k of ASSET_DISPLAY_KEYS) {
    const v = str(f[k])
    if (v) parts.push(v)
  }
  const ip = str(f['虚拟机IPv4']) || str(a.ip)
  if (ip) parts.push(ip)
  if (parts.length) return parts.join('_')
  // 兜底链：虚拟机名称 → 应用系统名称 → 资产名（与后端完全一致）
  const vm = str(f['虚拟机名称'])
  if (vm) return vm
  const app = str(f['应用系统名称'])
  if (app) return app
  return str(a.name) || '—'
}

/** 短名：项目简称_环境_业务环境（不带 IP），用于一行要放很多主机的场景（如巡检大屏） */
export function assetShortDisplayName(a: AssetLike | null | undefined): string {
  if (!a) return '—'
  const f = (a.fields || {}) as Record<string, any>
  const parts: string[] = []
  for (const k of ASSET_DISPLAY_KEYS) {
    const v = str(f[k])
    if (v) parts.push(v)
  }
  if (parts.length) return parts.join('_')
  const vm = str(f['虚拟机名称'])
  if (vm) return vm
  return str(a.name) || '—'
}

/** CMDB「虚拟机名称」原文（云主机名），用作副标题 / 兜底展示 */
export function assetVMName(a: AssetLike | null | undefined): string {
  if (!a) return ''
  const f = (a.fields || {}) as Record<string, any>
  return str(f['虚拟机名称']) || str(a.name)
}

/** 连接地址：虚拟机IPv4 → 资产 IP */
export function assetHost(a: AssetLike | null | undefined): string {
  if (!a) return ''
  const f = (a.fields || {}) as Record<string, any>
  return str(f['虚拟机IPv4']) || str(a.ip)
}
