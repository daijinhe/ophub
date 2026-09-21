/**
 * 巡检「季度报告」xlsx 生成器
 *
 * 背景：巡检结果按天/周/月跑,但季度报告需要把 90 天里所有 result 拉到一张表里。
 *       单条 result 一行,资产多 + 调度密集时一行就要 30+ 列,90 天累计可能 50K 行,
 *       写成 xlsx 经常超过 5MB;本工具负责:
 *         1. 调后端拉整个季度的 result / alert 数据;
 *         2. 派生 6 个 sheet:概览 / 各次运行 / 资产明细 / 告警明细 / 资产趋势 / 按天趋势;
 *         3. 5MB 硬上限 — 超限时按 sheet 优先级降级(先丢按天趋势 → 资产明细 → 资产趋势),
 *            保证文件**永远 ≤ maxMB**,不被浏览器或邮件拒收;
 *         4. 返回 Blob + 字节数,前端直接触发下载。
 *
 * 约定:
 *   - 「季度范围」交给后端 periodRange("quarter", ref) 算,前端只决定 ref。
 *     ref 取季度中间月份 15 号,避开月初/月末边界(periodRange 按 ref 计算所在季度)。
 *   - 不修改 inspectionRows 列顺序 —— 直接用后端给的 key;只在前置聚合时排序/求最大最小。
 */
import * as XLSX from 'xlsx'
import { getExport } from '../api/inspection'

// 单 sheet 行数 / 字节数经验值(xlsx 是 zip 压缩,SheetJS 写出来大约 50~80 字节/行;
// 这里给的是「保守阈值」—— 实际更小,但宁可估大也不要估小导致漏掉降级)。
const ROW_BYTES_ESTIMATE = 80

export interface QuarterReportOptions {
  year: number
  quarter: 1 | 2 | 3 | 4
  taskId?: number
  /** 5MB 硬上限 */
  maxMB?: number
}

export interface QuarterReportResult {
  blob: Blob
  filename: string
  sizeBytes: number
  sizeMB: number
  /** 是否降级过(为了 5MB) */
  degraded: boolean
  /** 因为超 5MB 被丢弃的 sheet 名(顺序就是被丢的顺序) */
  droppedSheets: string[]
  stats: {
    quarterStart: string
    quarterEnd: string
    totalRecords: number
    totalResults: number
    totalAlerts: number
    avgCpu: number
    avgMem: number
    avgDisk: number
  }
}

/** 把季度里的任意一天传给后端 periodRange,后端会算出整季度的起止日期 */
function quarterRefDate(year: number, q: number): string {
  // Q1=1月15, Q2=4月15, Q3=7月15, Q4=10月15(避开月初/月末边界)
  const month = (q - 1) * 3 + 1
  return `${year}-${String(month).padStart(2, '0')}-15`
}

const QUARTER_LABEL: Record<number, string> = { 1: 'Q1', 2: 'Q2', 3: 'Q3', 4: 'Q4' }

interface SheetSpec {
  key: string // sheet 名(同时做 sheet 顺序的 key)
  title: string
  build: () => { aoa: any[][]; cols: number[] } // AOA = array of arrays
}

/** 字节可读格式化 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 数字保留 1 位,空 / NaN 统一显示 '—'
 */
function num(v: any, fixed = 1): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  if (!isFinite(n)) return '—'
  return fixed >= 0 ? n.toFixed(fixed) : String(n)
}

/**
 * 把后端 fmtVal 加了单位后缀的字符串("100.0%"、"15.6GB"、"3.0核"、"216.0"、"0.5次")
 * 还原成 Number。**只剥后缀、不动小数点),剥了单位后 isFinite 才不会 NaN。
 *
 * 这是 v1.7.26 季度报告里一个隐蔽的坑:不剥后缀的话 cpuCnt/memCnt 永远是 0,
 * 整个「资产趋势」Sheet 的 CPU/内存/磁盘 列全部显示 "—" —— 看起来像没数据,
 * 实际是 NaN 被吃掉了。
 */
function parseMetric(v: any): number {
  if (v === null || v === undefined || v === '') return NaN
  // 先尝试直接转(数值类型)
  const direct = Number(v)
  if (isFinite(direct)) return direct
  // 字符串:去掉尾部单位(常见单位列表)
  const s = String(v).trim()
  const m = s.match(/^[-+]?\d+(\.\d+)?/)
  return m ? Number(m[0]) : NaN
}

/**
 * 估一行平均字节 — 简单用「AOA 中最长行」转字符串后的字节数作为代表,
 * 实际 SheetJS 会更小(zip + sharedStrings),所以这是**保守估计**。
 */
function estimateBytes(ws: { aoa: any[][] }): number {
  if (!ws.aoa || ws.aoa.length === 0) return 200 // 空表也给点兜底
  let max = 0
  for (const row of ws.aoa) {
    let len = 0
    for (const cell of row) {
      const s = cell === null || cell === undefined ? '' : String(cell)
      len += s.length * 3 // UTF-8 中文按 3 字节估
    }
    if (len > max) max = len
  }
  // 表头 + 表体 + 列宽描述 ≈ 行数 × max
  return ws.aoa.length * Math.max(max, ROW_BYTES_ESTIMATE) + 1024
}

/** 真正写到 xlsx,返回 Blob + 字节 */
function writeWorkbook(builders: SheetSpec[]): { blob: Blob; bytes: number; keptKeys: string[] } {
  const wb = XLSX.utils.book_new()
  const keptKeys: string[] = []
  for (const spec of builders) {
    const { aoa, cols } = spec.build()
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    // SheetJS 类型定义里 !cols 是 number[],但实际接受 {wch:number}[](更准确),
    // 这里强行 any 绕过 —— 写出来是符合 SheetJS 文档格式的
    ;(ws as any)['!cols'] = cols.map((w) => ({ wch: w }))
    ;(ws as any)['!freeze'] = { xSplit: 0, ySplit: 1 }
    XLSX.utils.book_append_sheet(wb, ws, spec.key)
    keptKeys.push(spec.key)
  }
  // 写成 ArrayBuffer,再包成 Blob 算精确字节
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const bytes = buf.byteLength
  return { blob: new Blob([buf], { type: 'application/octet-stream' }), bytes, keptKeys }
}

/**
 * 生成季度报告 xlsx(自动降级保证 ≤ maxMB)
 */
export async function buildQuarterReportXlsx(opts: QuarterReportOptions): Promise<QuarterReportResult> {
  const maxMB = opts.maxMB ?? 5
  const maxBytes = maxMB * 1024 * 1024
  const ref = quarterRefDate(opts.year, opts.quarter)

  // 1. 拉后端数据
  const data = await getExport('quarter', ref, opts.taskId)
  const rows: any[] = (data.rows || []).slice()
  const alerts: any[] = (data.alerts || []).slice()
  const range = data.range || {}
  const summary = data.summary || {}

  // 2. 派生各 sheet 的 AOA
  const specs = buildSheets(rows, alerts, summary, range, opts.year, opts.quarter)

  // 3. 估算字节 — 超限就按优先级丢 sheet
  let estimate = specs.reduce((sum, s) => sum + estimateBytes({ aoa: s.build().aoa }), 0)
  // SheetJS + zip 压缩会让实际文件比估算小,这里给个 1.5x 安全系数
  estimate = Math.ceil(estimate * 1.5)

  // 降级顺序:按天趋势 → 资产明细 → 资产趋势 → 告警明细(一般到不了最后一步)
  const DROP_ORDER = ['按天趋势', '资产明细', '资产趋势', '告警明细']
  let specsKept = specs.slice()
  let dropped: string[] = []
  let degraded = false
  for (const k of DROP_ORDER) {
    if (estimate <= maxBytes) break
    const idx = specsKept.findIndex((s) => s.key === k)
    if (idx >= 0) {
      // 同步丢掉对应的 sheet,但实际估算里也要重算
      const removed = specsKept.splice(idx, 1)[0]
      dropped.push(removed.key)
      estimate = specsKept.reduce((sum, s) => sum + estimateBytes({ aoa: s.build().aoa }), 0)
      estimate = Math.ceil(estimate * 1.5)
      degraded = true
    }
  }

  // 4. 真正写出来 + 字节检查(估算是估算,实际以写出来为准)
  let result = writeWorkbook(specsKept)
  // 如果实际字节还是超,继续丢 sheet(实测兜底)
  let safety = 0
  while (result.bytes > maxBytes && safety < DROP_ORDER.length) {
    const k = DROP_ORDER[safety]
    if (specsKept.findIndex((s) => s.key === k) >= 0) {
      const idx = specsKept.findIndex((s) => s.key === k)
      const removed = specsKept.splice(idx, 1)[0]
      dropped.push(removed.key)
      result = writeWorkbook(specsKept)
      degraded = true
    }
    safety++
  }

  const filename = `巡检季度报告_${opts.year}${QUARTER_LABEL[opts.quarter]}_${(range.start || '').replace(/-/g, '')}-${(range.end || '').replace(/-/g, '')}.xlsx`

  // 5. 派生统计
  // 各次运行(按 巡检时间 + 任务名称 聚合)
  const runsMap = new Map<string, { runAt: string; taskName: string; total: number; ok: number; fail: number; alertCount: number; source: string }>()
  for (const r of rows) {
    const key = `${r['巡检时间']}__${r['任务名称']}`
    const cur = runsMap.get(key) || {
      runAt: r['巡检时间'],
      taskName: r['任务名称'],
      total: 0,
      ok: 0,
      fail: 0,
      alertCount: 0,
      source: r['采集来源'] || '',
    }
    cur.total++
    if (r['状态'] === '正常') cur.ok++
    else if (r['状态'] === '失败') cur.fail++
    if (r['告警项']) cur.alertCount += String(r['告警项']).split(/[、，]/).filter(Boolean).length
    runsMap.set(key, cur)
  }

  return {
    blob: result.blob,
    filename,
    sizeBytes: result.bytes,
    sizeMB: result.bytes / 1024 / 1024,
    degraded,
    droppedSheets: dropped,
    stats: {
      quarterStart: range.start || '',
      quarterEnd: range.end || '',
      totalRecords: runsMap.size,
      totalResults: rows.length,
      totalAlerts: alerts.length,
      avgCpu: Number(summary.avgCpu || 0),
      avgMem: Number(summary.avgMem || 0),
      avgDisk: Number(summary.avgDisk || 0),
    },
  }
}

// =========================================================================
// 6 个 sheet 的具体构造
// =========================================================================

function buildSheets(
  rows: any[],
  alerts: any[],
  summary: any,
  range: any,
  year: number,
  quarter: number
): SheetSpec[] {
  // ---- 概览 sheet ----
  const totalAlerts = alerts.length
  const criticalAlerts = alerts.filter((a) => a['级别'] === '严重').length
  const warnAlerts = alerts.filter((a) => a['级别'] === '预警').length
  const okCount = rows.filter((r) => r['状态'] === '正常').length
  const failCount = rows.filter((r) => r['状态'] === '失败').length
  const successRate = rows.length > 0 ? ((okCount / rows.length) * 100).toFixed(1) + '%' : '—'
  // 健康评分 = 100 - 平均CPU*0.3 - 平均内存*0.3 - 平均磁盘*0.4 - 告警数(严重5x预警1x)
  const avgCpu = Number(summary.avgCpu || 0)
  const avgMem = Number(summary.avgMem || 0)
  const avgDisk = Number(summary.avgDisk || 0)
  const healthScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        100 - avgCpu * 0.3 - avgMem * 0.3 - avgDisk * 0.4 - criticalAlerts * 5 - warnAlerts
      )
    )
  )
  const healthColor = healthScore >= 85 ? '良好' : healthScore >= 65 ? '关注' : '风险'

  const overviewAoa: any[][] = [
    [`${year} 年 ${QUARTER_LABEL[quarter]} 智能巡检季度报告`],
    [],
    ['季度范围', `${range.start || '—'}  ~  ${range.end || '—'}  (含首日)`],
    ['生成时间', new Date().toLocaleString('zh-CN')],
    [],
    ['一、整体健康'],
    ['健康评分', `${healthScore} 分 (${healthColor})`],
    ['平均 CPU 使用率', `${num(avgCpu)}%`],
    ['平均内存使用率', `${num(avgMem)}%`],
    ['平均磁盘使用率', `${num(avgDisk)}%`],
    [],
    ['二、巡检规模'],
    ['总运行次数', '—'], // 各次运行 sheet 里看
    ['总采集资产数（result 行）', rows.length],
    ['正常采集', `${okCount} (${successRate})`],
    ['采集失败', failCount],
    [],
    ['三、告警汇总'],
    ['告警总条数', totalAlerts],
    ['  其中严重告警', criticalAlerts],
    ['  其中预警告警', warnAlerts],
    [],
    ['四、本报告 Sheet 说明'],
    ['概览', '本页'],
    ['各次运行', '每行 = 一次巡检运行的汇总(成功/失败/告警数)'],
    ['资产明细', '每行 = 单台资产的单次采集快照(指标明细)'],
    ['告警明细', '每行 = 一次告警(系统/IP/指标/级别/数值)'],
    ['资产趋势', '每行 = 一台资产的季度聚合(最高/最低/平均指标)'],
    ['按天趋势', '每行 = 一天的汇总(平均指标 + 告警数 + 采集资产数)'],
    [],
    ['提示', '本报告由 云枢 OpsHub · 智能运维平台自动生成 · 数据采集走 Ansible / SSH'],
  ]

  // 运行时回填总运行次数
  const runsMap = new Map<string, number>()
  for (const r of rows) {
    const k = `${r['巡检时间']}__${r['任务名称']}`
    runsMap.set(k, (runsMap.get(k) || 0) + 1)
  }
  overviewAoa[12][1] = String(runsMap.size)

  // ---- 各次运行 sheet ----
  const runsHeader = ['巡检时间', '任务名称', '总资产数', '成功', '失败', '告警条数', '采集来源']
  const runsAoa: any[][] = [runsHeader]
  const runsData = new Map<string, any>()
  for (const r of rows) {
    const k = `${r['巡检时间']}__${r['任务名称']}`
    const cur: any = runsData.get(k) || {
      runAt: r['巡检时间'],
      taskName: r['任务名称'],
      total: 0,
      ok: 0,
      fail: 0,
      alertCount: 0,
      source: r['采集来源'] || '',
    }
    cur.total++
    if (r['状态'] === '正常') cur.ok++
    else if (r['状态'] === '失败') cur.fail++
    if (r['告警项']) cur.alertCount += String(r['告警项']).split(/[、，]/).filter(Boolean).length
    runsData.set(k, cur)
  }
  const runsList = Array.from(runsData.values()).sort((a, b) =>
    String(a.runAt).localeCompare(String(b.runAt))
  )
  for (const x of runsList) {
    runsAoa.push([x.runAt, x.taskName, x.total, x.ok, x.fail, x.alertCount, x.source])
  }

  // ---- 资产明细 sheet ----
  // 取 row 的所有 key,排除一些无意义字段
  const DROP_DETAIL = new Set(['主机名', '时区', '最近启动时间', '核心进程总数', '核心进程未运行数', 'CPU型号', '系统架构', '系统族', '缓存/缓冲'])
  const colsSet = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) if (!DROP_DETAIL.has(k)) colsSet.add(k)
  // 排序:核心标识 → 操作系统 → CPU → 内存 → 磁盘 → 网络 → 进程/服务/安全 → 尾部基础列
  const ORDER = [
    '巡检时间', '任务名称', 'ERP系统名称', '归属部门', '虚拟机IPv4', '状态',
    '操作系统', '系统版本', 'CPU类型', '内核版本', 'SELinux状态', 'NTP偏差(ms)',
    'CPU核心数', 'CPU整体使用率', 'I/O等待', '单核最高使用率',
    '系统负载(1m)', '系统负载(5m)', '系统负载(15m)',
    '物理内存总量', '内存已用', '可用内存', '内存使用率',
    'Swap总量', 'Swap已用', 'Swap使用率',
    '系统盘使用率', '系统盘inode使用率', '系统盘容量',
    '数据盘最高使用率', '数据盘最高inode使用率', '数据盘数量', 'NAS最高使用率',
    '网卡带宽最高使用率', '丢包率', 'TCP重传率',
    'TCP ESTABLISHED', 'TCP TIME_WAIT', 'TCP SYN_RECV', 'TCP CLOSE_WAIT',
    '监听端口数', 'TCP连接总数',
    '总进程数', '僵尸进程数',
    '纳管中间件数', '关键端口监听数',
    '防火墙状态', 'SELinux', 'root远程登录', '近24h失败SSH登录', '开放端口数',
    '采集来源', '告警项',
  ]
  const detailCols: string[] = []
  for (const k of ORDER) if (colsSet.has(k)) { detailCols.push(k); colsSet.delete(k) }
  // 剩下的列也保留(防止遗漏新指标)
  for (const k of colsSet) detailCols.push(k)

  // 排序:失败 / 告警资产排前面(便于打开报表先看风险)
  const sortedRows = rows.slice().sort((a, b) => {
    const sf = (a['状态'] === '失败' ? 0 : 1) - (b['状态'] === '失败' ? 0 : 1)
    if (sf !== 0) return sf
    const aa = a['告警项'] ? 0 : 1
    const bb = b['告警项'] ? 0 : 1
    if (aa !== bb) return aa - bb
    return 0
  })

  const detailAoa: any[][] = [detailCols]
  for (const r of sortedRows) {
    const row: any[] = []
    for (const col of detailCols) row.push(r[col] ?? '')
    detailAoa.push(row)
  }

  // ---- 告警明细 sheet ----
  const alertCols = ['ERP系统名称', '归属部门', '虚拟机IPv4', '巡检时间', '分类', '指标', '级别', '数值', '说明', '开发人员']
  const alertAoa: any[][] = [alertCols]
  for (const a of alerts) {
    alertAoa.push(alertCols.map((c) => a[c] ?? ''))
  }

  // ---- 资产趋势 sheet(按资产聚合) ----
  const assetMap = new Map<string, {
    name: string
    ip: string
    department: string
    cpuMax: number; cpuMin: number; cpuSum: number; cpuCnt: number
    memMax: number; memMin: number; memSum: number; memCnt: number
    diskMax: number; diskMin: number; diskSum: number; diskCnt: number
    alertTotal: number; alertCritical: number
    firstAlertAt: string; lastAlertAt: string
    failCount: number
  }>()
  for (const r of rows) {
    const k = `${r['ERP系统名称']}__${r['虚拟机IPv4']}`
    let cur = assetMap.get(k)
    if (!cur) {
      cur = {
        name: r['ERP系统名称'] || '',
        ip: r['虚拟机IPv4'] || '',
        department: r['归属部门'] || '',
        cpuMax: -Infinity, cpuMin: Infinity, cpuSum: 0, cpuCnt: 0,
        memMax: -Infinity, memMin: Infinity, memSum: 0, memCnt: 0,
        diskMax: -Infinity, diskMin: Infinity, diskSum: 0, diskCnt: 0,
        alertTotal: 0, alertCritical: 0,
        firstAlertAt: '', lastAlertAt: '',
        failCount: 0,
      }
      assetMap.set(k, cur)
    }
    // ⚠ 后端 fmtVal 加了单位后缀("100.0%"/"15.6GB"),直接 Number() 拿 NaN,
// 必须用 parseMetric 剥掉尾部单位再转
    const cpu = parseMetric(r['CPU整体使用率'])
    if (isFinite(cpu)) { cur.cpuMax = Math.max(cur.cpuMax, cpu); cur.cpuMin = Math.min(cur.cpuMin, cpu); cur.cpuSum += cpu; cur.cpuCnt++ }
    const mem = parseMetric(r['内存使用率'])
    if (isFinite(mem)) { cur.memMax = Math.max(cur.memMax, mem); cur.memMin = Math.min(cur.memMin, mem); cur.memSum += mem; cur.memCnt++ }
    const disk = parseMetric(r['系统盘使用率'])
    if (isFinite(disk)) { cur.diskMax = Math.max(cur.diskMax, disk); cur.diskMin = Math.min(cur.diskMin, disk); cur.diskSum += disk; cur.diskCnt++ }
    if (r['告警项']) {
      const items = String(r['告警项']).split(/[、，]/).filter(Boolean)
      cur.alertTotal += items.length
      // 通过 alerts sheet 关联级别较费,先粗略按 critical 数
      const matchCrit = alerts.filter((a) => a['ERP系统名称'] === cur.name && a['虚拟机IPv4'] === cur.ip && a['级别'] === '严重').length
      cur.alertCritical = Math.max(cur.alertCritical, matchCrit)
      const t = r['巡检时间'] || ''
      if (!cur.firstAlertAt || t < cur.firstAlertAt) cur.firstAlertAt = t
      if (!cur.lastAlertAt || t > cur.lastAlertAt) cur.lastAlertAt = t
    }
    if (r['状态'] === '失败') cur.failCount++
  }
  const trendHeader = ['ERP系统名称', '归属部门', '虚拟机IPv4', '采集次数', '采集失败次数', 'CPU最高%', 'CPU最低%', 'CPU平均%', '内存最高%', '内存最低%', '内存平均%', '磁盘最高%', '磁盘最低%', '磁盘平均%', '告警总数', '严重告警数', '首次告警时间', '末次告警时间']
  const trendAoa: any[][] = [trendHeader]
  for (const a of Array.from(assetMap.values()).sort((x, y) => y.alertCritical - x.alertCritical || y.alertTotal - x.alertTotal)) {
    trendAoa.push([
      a.name, a.department, a.ip,
      a.cpuCnt, a.failCount,
      a.cpuCnt ? a.cpuMax.toFixed(1) : '—',
      a.cpuCnt ? a.cpuMin.toFixed(1) : '—',
      a.cpuCnt ? (a.cpuSum / a.cpuCnt).toFixed(1) : '—',
      a.memCnt ? a.memMax.toFixed(1) : '—',
      a.memCnt ? a.memMin.toFixed(1) : '—',
      a.memCnt ? (a.memSum / a.memCnt).toFixed(1) : '—',
      a.diskCnt ? a.diskMax.toFixed(1) : '—',
      a.diskCnt ? a.diskMin.toFixed(1) : '—',
      a.diskCnt ? (a.diskSum / a.diskCnt).toFixed(1) : '—',
      a.alertTotal, a.alertCritical,
      a.firstAlertAt || '—',
      a.lastAlertAt || '—',
    ])
  }

  // ---- 按天趋势 sheet(按日期聚合) ----
  const dayMap = new Map<string, { total: number; ok: number; fail: number; alerts: number; cpuSum: number; cpuCnt: number; memSum: number; memCnt: number; diskSum: number; diskCnt: number }>()
  for (const r of rows) {
    const t = r['巡检时间'] || ''
    const day = t.slice(0, 10) // YYYY-MM-DD
    if (!day) continue
    let cur = dayMap.get(day)
    if (!cur) { cur = { total: 0, ok: 0, fail: 0, alerts: 0, cpuSum: 0, cpuCnt: 0, memSum: 0, memCnt: 0, diskSum: 0, diskCnt: 0 }; dayMap.set(day, cur) }
    cur.total++
    if (r['状态'] === '正常') cur.ok++
    else if (r['状态'] === '失败') cur.fail++
    if (r['告警项']) cur.alerts += String(r['告警项']).split(/[、，]/).filter(Boolean).length
    // 按天趋势 — 同样用 parseMetric 剥单位
    const cpu = parseMetric(r['CPU整体使用率'])
    if (isFinite(cpu)) { cur.cpuSum += cpu; cur.cpuCnt++ }
    const mem = parseMetric(r['内存使用率'])
    if (isFinite(mem)) { cur.memSum += mem; cur.memCnt++ }
    const disk = parseMetric(r['系统盘使用率'])
    if (isFinite(disk)) { cur.diskSum += disk; cur.diskCnt++ }
  }
  const dayHeader = ['日期', '采集资产数', '正常', '失败', '告警条数', 'CPU平均%', '内存平均%', '磁盘平均%']
  const dayAoa: any[][] = [dayHeader]
  for (const d of Array.from(dayMap.keys()).sort()) {
    const x = dayMap.get(d)!
    dayAoa.push([
      d,
      x.total,
      x.ok,
      x.fail,
      x.alerts,
      x.cpuCnt ? (x.cpuSum / x.cpuCnt).toFixed(1) : '—',
      x.memCnt ? (x.memSum / x.memCnt).toFixed(1) : '—',
      x.diskCnt ? (x.diskSum / x.diskCnt).toFixed(1) : '—',
    ])
  }

  // 列宽
  const detailColWidths = detailCols.map((h) =>
    h === 'ERP系统名称' ? 28 :
    h === '虚拟机IPv4' ? 16 :
    h === '告警项' ? 50 :
    h === '巡检时间' ? 18 :
    h === '操作系统' || h === '内核版本' || h === 'CPU类型' || h === '归属部门' ? 22 :
    14
  )
  const runsColWidths = [18, 28, 14, 10, 10, 12, 14]
  const alertColWidths = alertCols.map((h) => h === '说明' ? 50 : h === '开发人员' ? 20 : h === '虚拟机IPv4' ? 16 : h === 'ERP系统名称' ? 28 : 14)
  const trendColWidths = [28, 22, 16, 12, 14, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 14, 18, 18]
  const dayColWidths = [14, 14, 12, 12, 12, 12, 12, 12]

  return [
    { key: '概览', title: '概览', build: () => ({ aoa: overviewAoa, cols: [22, 50] }) },
    { key: '各次运行', title: '各次运行', build: () => ({ aoa: runsAoa, cols: runsColWidths }) },
    { key: '资产明细', title: '资产明细', build: () => ({ aoa: detailAoa, cols: detailColWidths }) },
    { key: '告警明细', title: '告警明细', build: () => ({ aoa: alertAoa, cols: alertColWidths }) },
    { key: '资产趋势', title: '资产趋势', build: () => ({ aoa: trendAoa, cols: trendColWidths }) },
    { key: '按天趋势', title: '按天趋势', build: () => ({ aoa: dayAoa, cols: dayColWidths }) },
  ]
}

/** 下载工具 — InspectionRecords 里直接调用 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export { fmtBytes }