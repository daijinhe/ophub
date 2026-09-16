import api from './client'

// ============================================================================
// 定时任务（crontab）—— 数据源就是目标机上 `crontab -l` 的输出
//
// 平台以「维护用户」（默认 root）身份执行 `crontab -l` 读出该用户 crontab 的
// 真实内容，增删改通过 crontab 自身安装回去；平台不存任务副本，
// 读到什么就是机器上真实在跑的。每次写操作都要带上读取时返回的 hash（乐观锁），
// 避免覆盖别人刚做的改动。
//
// 2026-09-16 收敛：不再读 /etc/crontab、/etc/cron.d/* 与
// /etc/cron.{hourly,daily,weekly,monthly}/*。
// 注意：用户 crontab 的任务行**没有「运行用户」段**，整份 crontab 都属于
// 同一个用户（见 AssetCrontabView.user）。
// ============================================================================

/** crontab 行类型 */
export type CrontabLineKind = 'task' | 'disabled' | 'comment' | 'env' | 'blank'

/** 用户 crontab 中的一行（任务行，或注释 / 环境变量 / 空行） */
export interface CrontabEntry {
  /** 1-based 行号，修改删除时用于定位 */
  lineNo: number
  /** 原始行内容（定位 + 并发校验） */
  raw: string
  kind: CrontabLineKind
  expr?: string
  command?: string
  enabled: boolean
  /** cron 中文描述（平台解析） */
  describe?: string
  /** 「用途」备注的存储键（按命令计算；仅单机视图返回） */
  noteKey?: string
  /** 人工填写的用途（平台侧备注，不写回目标机） */
  purpose?: string
}

/** 资产选择项 */
export interface CrontabHostOption {
  assetId: number
  /** 展示名：与 Web 终端会话名同源（项目简称_环境_业务环境_虚拟机IPv4） */
  assetName: string
  /** CMDB「虚拟机名称」原文（列表副标题） */
  vmName?: string
  ip: string
  sshHost?: string
  sshUser?: string
  /** crontab 的归属用户（默认 root，读写的就是这个人的 crontab） */
  runUser: string
  /** 提权方式：direct = SSH 用户即目标用户；sudo = sudo 提权 */
  runMode?: 'direct' | 'sudo'
  /** 提权信息是否就绪（direct 或已填超级管理员密码） */
  sudoReady?: boolean
  /** 资产 SSH 信息是否完整（不完整不可选） */
  ready: boolean
  reason?: string
}

/** 某台资产上某用户的 crontab 全貌 */
export interface AssetCrontabView {
  assetId: number
  /** 展示名：与 Web 终端会话名同源（项目简称_环境_业务环境_虚拟机IPv4） */
  assetName: string
  /** CMDB「虚拟机名称」原文 */
  vmName?: string
  ip: string
  /** 实际连接的主机（IP 或域名） */
  host: string
  /** SSH 登录用户 */
  sshUser: string
  /** crontab 的归属用户（默认 root） */
  user: string
  runMode: 'direct' | 'sudo'
  /** 读取成功即可管理（提权失败 / 网络不通时为 false） */
  crontabAvailable: boolean
  /** 该用户当前还没有 crontab（0 条任务，新增任务时由 crontab 自动创建） */
  noCrontab?: boolean
  /** 实际执行的读取命令，如 `crontab -l` / `sudo -u root crontab -l` */
  source?: string
  /** 内容指纹，写操作时回传做乐观锁 */
  hash: string
  /** crontab 原文（`crontab -l` 的逐字节输出） */
  content: string
  /** 任务行（含被禁用的） */
  tasks: CrontabEntry[]
  /** 非任务行：注释 / 环境变量 / 空行 */
  others: CrontabEntry[]
  taskCount: number
  enabledCount: number
  disabledCount: number
  readAt: string
  /** 读取时刻（毫秒时间戳），用于判断本地缓存是否仍然新鲜 */
  readAtMs?: number
  /** 本次是否来自平台短时缓存（未重新连目标机） */
  cached?: boolean
}

/** 批量扫描的单台结果状态（「无 crontab」不再单列状态，走 ok + noCrontab 标记） */
export type CrontabScanStatus = 'ok' | 'offline' | 'denied' | 'invalid' | 'error'

/** 批量扫描的单台结果 */
export interface CrontabScanItem extends AssetCrontabView {
  status: CrontabScanStatus
  /** 异常时的原因说明 */
  message: string
  /** 读取时刻（毫秒时间戳） */
  readAtMs?: number
}

/** 批量扫描结果 */
export interface CrontabScanResult {
  list: CrontabScanItem[]
  total: number
  /** 实际扫描的资产数 */
  scanned: number
  okCount: number
  /** 有定时任务的机器数 */
  taskHostCount: number
  errorCount: number
  taskTotal: number
  scannedAt: string
}


/** 写操作结果 */
export interface CrontabWriteResult {
  /** 远端备份路径（内容无变化时为空） */
  backup: string
  hash: string
  changed: boolean
}

/** 任务写入载荷 */
export interface CrontabTaskPayload {
  hash: string
  lineNo?: number
  oldRaw?: string
  expr: string
  command: string
  enabled?: boolean
}

/** 资产列表（定时任务可管理范围） */
export async function listCrontabAssets(): Promise<CrontabHostOption[]> {
  const r = await api.get('/crontab/assets')
  return (r.data.data.list || []) as CrontabHostOption[]
}

/**
 * 批量扫描各资产上维护用户的 crontab（`crontab -l`）。
 * 后端并发读取（含 TCP 预探测与单机超时），资产多时耗时较长，因此不设客户端超时。
 */
export async function scanCrontabAssets(body: {
  assetIds?: number[]
  categoryId?: number
  keyword?: string
  onlyWithTasks?: boolean
} = {}): Promise<CrontabScanResult> {
  const r = await api.post('/crontab/scan', body, { timeout: 0 })
  return r.data.data as CrontabScanResult
}

/**
 * 读取某台资产的定时任务。
 * @param opts.refresh 传 true 强制重连目标机取最新内容；不传时后端会复用
 *                     15 秒内的同名机器读取结果（连续点开几台再点回来不重复 SSH）。
 */
export async function getAssetCrontab(
  assetId: number,
  opts: { refresh?: boolean } = {},
): Promise<AssetCrontabView> {
  const r = await api.get(`/crontab/asset/${assetId}`, {
    params: opts.refresh ? { refresh: 1 } : undefined,
  })
  return r.data.data as AssetCrontabView
}

/** 新增任务（追加到 crontab 末尾） */
export async function createCrontabTask(assetId: number, body: CrontabTaskPayload): Promise<CrontabWriteResult> {
  const r = await api.post(`/crontab/asset/${assetId}/tasks`, body)
  return r.data.data as CrontabWriteResult
}

/** 修改任务（含启用 / 禁用切换） */
export async function updateCrontabTask(assetId: number, body: CrontabTaskPayload): Promise<CrontabWriteResult> {
  const r = await api.put(`/crontab/asset/${assetId}/tasks`, body)
  return r.data.data as CrontabWriteResult
}

/** 删除任务 */
export async function deleteCrontabTask(
  assetId: number,
  body: { hash: string; lineNo: number; oldRaw: string },
): Promise<CrontabWriteResult> {
  const r = await api.delete(`/crontab/asset/${assetId}/tasks`, { data: body })
  return r.data.data as CrontabWriteResult
}

/** 保存整份 crontab 原文（高级编辑） */
export async function saveCrontabRaw(
  assetId: number,
  body: { hash: string; content: string },
): Promise<CrontabWriteResult> {
  const r = await api.put(`/crontab/asset/${assetId}/raw`, body)
  return r.data.data as CrontabWriteResult
}

/**
 * 保存某条定时任务的「用途」备注（平台侧人工标注，不写回目标机）。
 * 传空字符串即清除该条备注。
 */
export async function setCrontabTaskNote(
  assetId: number,
  body: { taskKey: string; purpose: string },
): Promise<{ taskKey: string; purpose: string }> {
  const r = await api.put(`/crontab/asset/${assetId}/notes`, body)
  return r.data.data as { taskKey: string; purpose: string }
}

/** 常用 cron 计划（新增时一键套用） */
export const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: '每分钟', expr: '* * * * *' },
  { label: '每 5 分钟', expr: '*/5 * * * *' },
  { label: '每 10 分钟', expr: '*/10 * * * *' },
  { label: '每 30 分钟', expr: '*/30 * * * *' },
  { label: '每小时整点', expr: '0 * * * *' },
  { label: '每天 00:00', expr: '0 0 * * *' },
  { label: '每天 01:00', expr: '0 1 * * *' },
  { label: '每天 02:30', expr: '30 2 * * *' },
  { label: '每天 06:00', expr: '0 6 * * *' },
  { label: '每周一 09:00', expr: '0 9 * * 1' },
  { label: '每月 1 日 00:00', expr: '0 0 1 * *' },
  { label: '开机时执行', expr: '@reboot' },
  { label: '每小时整点（@宏）', expr: '@hourly' },
  { label: '每天 00:00（@宏）', expr: '@daily' },
]

/** 前端 cron 表达式预校验（与后端 validateCron 口径一致，用于即时提示） */
export function validateCronClient(expr: string): string {
  const e = (expr || '').trim().replace(/\s+/g, ' ')
  if (!e) return 'cron 表达式不能为空'
  if (e.startsWith('@')) {
    const macros = ['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']
    return macros.includes(e.toLowerCase()) ? '' : '不支持的 @ 宏（可用：@reboot / @hourly / @daily / @weekly / @monthly / @yearly）'
  }
  const parts = e.split(' ')
  if (parts.length !== 5) return `cron 表达式应为 5 段（分 时 日 月 周），当前 ${parts.length} 段`
  const ranges: [string, number, number][] = [
    ['分钟', 0, 59],
    ['小时', 0, 23],
    ['日', 1, 31],
    ['月', 1, 12],
    ['星期', 0, 7],
  ]
  for (let i = 0; i < 5; i++) {
    const [name, lo, hi] = ranges[i]
    const items = parts[i].split(',')
    for (const raw of items) {
      const item = raw.trim()
      if (!item) return `${name} 字段存在空的取值项`
      let body = item
      let step = 1
      const slash = item.lastIndexOf('/')
      if (slash >= 0) {
        body = item.slice(0, slash)
        const st = Number(item.slice(slash + 1))
        if (!Number.isInteger(st) || st <= 0) return `${name} 字段的步长不合法：${item}`
        step = st
      }
      let a = lo
      let b = hi
      if (body !== '*') {
        if (body.includes('-')) {
          const [s1, s2] = body.split('-')
          const n1 = numOf(s1, i)
          const n2 = numOf(s2, i)
          if (n1 == null || n2 == null) return `${name} 字段的区间不合法：${item}`
          if (n1 < lo || n1 > hi || n2 < lo || n2 > hi) return `${name} 字段取值超出范围（${lo}-${hi}）：${item}`
          if (n1 > n2) return `${name} 字段的区间起点大于终点：${item}`
          a = n1
          b = n2
        } else {
          const n1 = numOf(body, i)
          if (n1 == null) return `${name} 字段取值不合法：${item}`
          if (n1 < lo || n1 > hi) return `${name} 字段取值超出范围（${lo}-${hi}）：${item}`
          if (slash >= 0) {
            a = n1
            b = hi
          } else {
            a = n1
            b = n1
          }
        }
      }
      for (let v = a; v <= b; v += step) {
        if (v < lo || v > hi) return `${name} 字段取值超出范围（${lo}-${hi}）：${item}`
      }
    }
  }
  return ''
}

const MACRO_CN: Record<string, string> = {
  '@reboot': '开机时执行',
  '@yearly': '每年 1 月 1 日 00:00',
  '@annually': '每年 1 月 1 日 00:00',
  '@monthly': '每月 1 日 00:00',
  '@weekly': '每周日 00:00',
  '@daily': '每天 00:00',
  '@midnight': '每天 00:00',
  '@hourly': '每小时整点',
}

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 展开单个 cron 字段为升序取值集合；无法解析返回 null */
function expandField(raw: string, fieldIdx: number): number[] | null {
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ]
  const [lo, hi] = ranges[fieldIdx]
  const out = new Set<number>()
  for (const piece of raw.split(',')) {
    const item = piece.trim()
    if (!item) return null
    let step = 1
    let body = item
    const slash = item.lastIndexOf('/')
    if (slash >= 0) {
      body = item.slice(0, slash).trim()
      const st = Number(item.slice(slash + 1))
      if (!Number.isInteger(st) || st <= 0) return null
      step = st
    }
    let a = lo
    let b = hi
    if (body !== '*') {
      if (body.includes('-')) {
        const [s1, s2] = body.split('-')
        const n1 = numOf(s1, fieldIdx)
        const n2 = numOf(s2, fieldIdx)
        if (n1 == null || n2 == null || n1 > n2) return null
        a = n1
        b = n2
      } else {
        const n1 = numOf(body, fieldIdx)
        if (n1 == null) return null
        if (slash >= 0) {
          a = n1
          b = hi
        } else {
          a = n1
          b = n1
        }
      }
    }
    for (let v = a; v <= b; v += step) {
      if (v < lo || v > hi) return null
      out.add(fieldIdx === 4 && v === 7 ? 0 : v)
    }
  }
  return out.size ? [...out].sort((x, y) => x - y) : null
}

/** 转义命令中的 %（crontab 里 % 之后的内容会被当作 stdin 送入），与后端口径一致 */
export function escapeCronPercent(cmd: string): string {
  let out = ''
  let prev = ''
  for (const ch of cmd) {
    if (ch === '%' && prev !== '\\') out += '\\'
    out += ch
    prev = ch
  }
  return out
}

/**
 * 前端 cron 中文描述（仅用于编辑时的即时预览，权威描述以平台解析为准）。
 * 无法精确概括时返回「自定义计划」。
 */
export function describeCronClient(expr: string): string {
  const e = (expr || '').trim().replace(/\s+/g, ' ')
  if (!e) return ''
  if (e.startsWith('@')) return MACRO_CN[e.toLowerCase()] || '自定义计划'
  const p = e.split(' ')
  if (p.length !== 5) return ''
  const [mn, hr, dm, mo, dw] = p

  // 日期部分
  const dmSet = dm === '*' ? null : expandField(dm, 2)
  const moSet = mo === '*' ? null : expandField(mo, 3)
  const dwSet = dw === '*' ? null : expandField(dw, 4)
  let date = ''
  if (dm === '*' && mo === '*' && dw === '*') date = '每天'
  else if (dm === '*' && mo === '*' && dwSet) {
    date = '每' + dwSet.map((v) => '周' + WEEKDAY_CN[v % 7].slice(1)).join('、')
  } else if (mo === '*' && dmSet && dmSet.length === 1 && dw === '*') date = `每月 ${dmSet[0]} 日`
  else if (moSet && moSet.length === 1 && dmSet && dmSet.length === 1 && dw === '*')
    date = `每年 ${moSet[0]} 月 ${dmSet[0]} 日`
  else if (mo.startsWith('*/') && dm === '*' && dw === '*') date = `每 ${Number(mo.slice(2))} 个月`
  else return '自定义计划'

  // 时间部分
  let tm = ''
  if (hr === '*' && mn === '*') tm = '每分钟'
  else if (hr === '*' && mn.startsWith('*/')) tm = `每 ${Number(mn.slice(2))} 分钟`
  else if (hr === '*' && mn === '0') tm = '每小时整点'
  else if (hr === '*' && /^\d+$/.test(mn)) tm = `每小时第 ${Number(mn)} 分`
  else if (hr.startsWith('*/') && /^\d+$/.test(mn)) tm = `每 ${Number(hr.slice(2))} 小时的第 ${Number(mn)} 分`
  else if (/^\d+$/.test(hr) && /^\d+$/.test(mn)) tm = `${String(hr).padStart(2, '0')}:${String(mn).padStart(2, '0')}`
  else if (/^\d+$/.test(hr) && mn.startsWith('*/')) tm = `${Number(hr)} 点起每 ${Number(mn.slice(2))} 分钟`
  else return '自定义计划'

  if (tm === '每分钟' && date === '每天') return '每分钟'
  return date + ' ' + tm
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const DOWS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function numOf(token: string, fieldIdx: number): number | null {
  const t = (token || '').trim().toLowerCase()
  if (fieldIdx === 3 && MONTHS[t] != null) return MONTHS[t]
  if (fieldIdx === 4 && DOWS[t] != null) return DOWS[t]
  const n = Number(t)
  return Number.isInteger(n) ? n : null
}
