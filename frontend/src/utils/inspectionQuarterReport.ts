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

export interface QuarterReportOptions {
  year: number
  quarter: 1 | 2 | 3 | 4
  taskId?: number
  /** 任务名称：传入时文件名带任务名、概览标注「巡检任务」（按任务独立导出用） */
  taskName?: string
  /** 5MB 硬上限 */
  maxMB?: number
}

/**
 * Sheet 装配模式 —— 5MB 不够时**先压缩、再丢弃**。
 *
 * v1.7.27 实测：300 台 × 12 次（3607 行 / 13232 条告警）的真实 xlsx 是
 * 「资产明细 9.4MB + 告警明细 5.7MB」，按老逻辑（超了就整表丢）会产出
 * 一个只有「概览+各次运行」的 23KB 空壳 —— 用户要的资产明细/告警明细全没了。
 * 所以降级顺序改成：
 *   ① 全量（小数据量直接过）
 *   ② 压缩：资产明细 → 每台资产只留最新一次快照；告警明细 → 按「资产+指标」聚合
 *   ③ 还超才丢 Sheet，且每一步都用**真实写出的字节**判断（估算公式误差可达 20 倍）
 */
export interface SheetMode {
  /** 资产明细：full=每次采集一行；latest=每台资产只保留最新一次 */
  detail: 'full' | 'latest'
  /** 告警明细：full=每条告警一行；agg=按「资产+指标」聚合 */
  alert: 'full' | 'agg'
  /** 告警明细最多保留的行数（兜底截断；0/undefined=不限） */
  alertLimit?: number
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
  /** 被压缩过的 sheet 说明(没丢,只是聚合了) */
  compactedNotes: string[]
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

  // 2. 派生各 sheet 的 AOA（先按「全量」装配）
  const makeSpecs = (mode: SheetMode) =>
    buildSheets(rows, alerts, summary, range, opts.year, opts.quarter, mode, opts.taskName)

  // 3. 写 → **实测**字节。
  //    不再用「行数 × 估算行宽」的公式：300 台量级下估算 15MB、真实 15MB 虽然碰巧接近，
  //    但 50 台量级下估算能差 20 倍，会把明明能装下的 sheet 白白丢掉。
  //    直接写一次再量，最多多花几百毫秒，换来的判断是准的。
  const DROP_ORDER = ['按天趋势', '资产趋势', '资产明细', '告警明细']
  let mode: SheetMode = { detail: 'full', alert: 'full' }
  let specsKept = makeSpecs(mode)
  let dropped: string[] = []
  let compactedNotes: string[] = []
  let result = writeWorkbook(specsKept)
  let degraded = false

  if (result.bytes > maxBytes) {
    // ① 先压缩两张大表(不丢 sheet) —— 保住用户最关心的资产明细 / 告警明细
    mode = { detail: 'latest', alert: 'agg' }
    const compactSpecs = makeSpecs(mode)
    const compactRes = writeWorkbook(compactSpecs)
    compactedNotes = [
      '资产明细：每台资产只保留季度内最新一次快照（逐次波动见「资产趋势」）',
      '告警明细：按「资产 + 指标」聚合（次数 / 最高值 / 首次末次时间）',
    ]
    degraded = true
    specsKept = compactSpecs
    result = compactRes

    // ② 压缩后仍超 → 才按优先级丢 sheet,每丢一次实测一次
    for (const k of DROP_ORDER) {
      if (result.bytes <= maxBytes) break
      const idx = specsKept.findIndex((s) => s.key === k)
      if (idx < 0) continue
      dropped.push(specsKept.splice(idx, 1)[0].key)
      result = writeWorkbook(specsKept)
    }

    // ③ 极端兜底：告警明细按「严重优先」逐级截断,保证文件一定 ≤ maxMB
    let guard = 0
    let limit = 5000
    while (result.bytes > maxBytes && guard < 6) {
      limit = Math.max(200, Math.floor(limit / 2))
      mode = { ...mode, alertLimit: limit }
      specsKept = makeSpecs(mode)
      result = writeWorkbook(specsKept)
      compactedNotes = [
        '资产明细：每台资产只保留季度内最新一次快照（逐次波动见「资产趋势」）',
        `告警明细：按「资产 + 指标」聚合后仍超限，已按严重优先截断至 ${limit} 行`,
      ]
      guard++
    }
  }

  // 按任务独立导出时文件名带任务名（v1.7.29）；任务名里的非法文件字符替换成 _
  const taskTag = opts.taskName
    ? `_${opts.taskName.replace(/[\\/:*?"<>|]/g, '_')}`
    : ''
  const filename = `巡检季度报告${taskTag}_${opts.year}${QUARTER_LABEL[opts.quarter]}_${(range.start || '').replace(/-/g, '')}-${(range.end || '').replace(/-/g, '')}.xlsx`

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
    compactedNotes,
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
  quarter: number,
  mode: SheetMode = { detail: 'full', alert: 'full' },
  taskName?: string
): SheetSpec[] {
  // ---- 概览 sheet ----
  const totalAlerts = alerts.length
  const criticalAlerts = alerts.filter((a) => a['级别'] === '严重').length
  const warnAlerts = alerts.filter((a) => a['级别'] === '预警').length
  const okCount = rows.filter((r) => r['状态'] === '正常').length
  const failCount = rows.filter((r) => r['状态'] === '失败').length
  const successRate = rows.length > 0 ? ((okCount / rows.length) * 100).toFixed(1) + '%' : '—'
  const avgCpu = Number(summary.avgCpu || 0)
  const avgMem = Number(summary.avgMem || 0)
  const avgDisk = Number(summary.avgDisk || 0)
  // 健康评分(占位,真正的分数在「资产趋势」算完后回填 —— 见下方 setOverview)
  // ⚠ 旧公式把「告警条数」直接当扣分项(严重×5 + 预警×1),300 台 × 一个季度
  //   一万多条告警时必然算出 0 分,所有季度都是 0,完全失去区分度。
  //   改成**比率口径**:资源水位扣分 + 告警资产占比扣分 + 严重告警占比扣分。
  let healthScore = 0
  const healthColorOf = (s: number) => (s >= 85 ? '良好' : s >= 65 ? '关注' : '风险')

  // ---- 巡检项目列表（v1.7.29）：本季度巡检覆盖的所有项目简称，放在「整体健康」之前 ----
  // 按 (项目简称, IP) 去重统计每个项目的资产台数
  const projAssets = new Map<string, Set<string>>()
  for (const r of rows) {
    const p = String(r['项目简称'] || '').trim() || '—'
    const ip = String(r['虚拟机IPv4'] || '').trim()
    if (!projAssets.has(p)) projAssets.set(p, new Set())
    if (ip) projAssets.get(p)!.add(ip)
  }
  const projectNames = Array.from(projAssets.keys()).sort((a, b) => a.localeCompare(b, 'zh'))
  const projectAoa: any[][] = projectNames.map((p) => [p, `${projAssets.get(p)!.size} 台`])

  const overviewAoa: any[][] = [
    [`${year} 年 ${QUARTER_LABEL[quarter]} 智能巡检季度报告`],
    [],
    ['季度范围', `${range.start || '—'}  ~  ${range.end || '—'}  (含首日)`],
    ['生成时间', new Date().toLocaleString('zh-CN')],
    ...(taskName ? [['巡检任务', taskName] as any[]] : []),
    [],
    ['一、巡检项目列表', `共 ${projectNames.length} 个项目`],
    ...projectAoa,
    [],
    ['二、整体健康'],
    ['健康评分', '—'], // 资产趋势算完后回填
    ['平均 CPU 使用率', `${num(avgCpu)}%`],
    ['平均内存使用率', `${num(avgMem)}%`],
    ['平均磁盘使用率', `${num(avgDisk)}%`],
    [],
    ['三、巡检规模'],
    ['总运行次数', '—'], // 各次运行 sheet 里看
    ['总采集资产数（result 行）', rows.length],
    ['正常采集', `${okCount} (${successRate})`],
    ['采集失败', failCount],
    [],
    ['四、告警汇总'],
    ['告警总条数', totalAlerts],
    ['  其中严重告警', criticalAlerts],
    ['  其中预警告警', warnAlerts],
    ['告警资产占比', '—'], // 回填
    ['严重告警占比', '—'], // 回填
    [],
    ['五、本报告 Sheet 说明'],
    ['概览', '本页'],
    ['各次运行', '每行 = 一次巡检运行的汇总(成功/失败/告警数)'],
    ['资产明细', mode.detail === 'latest'
      ? '每行 = 一台资产（季度内最新一次快照；逐次波动见「资产趋势」）'
      : '每行 = 单台资产的单次采集快照(指标明细)'],
    ['告警明细', mode.alert === 'agg'
      ? '每行 = 一台资产 × 一个指标的季度聚合(次数 / 最高值 / 首次末次)'
      : '每行 = 一次告警(项目/IP/指标/级别/数值)'],
    ['资产趋势', '每行 = 一台资产的季度聚合(最高/最低/平均指标)'],
    ['按天趋势', '每行 = 一天的汇总(平均指标 + 告警数 + 采集资产数)'],
    [],
  ]

  // 按「标签」回填概览单元格 —— 不用下标,免得以后加一行就把别的值写错位置
  const setOverview = (label: string, value: any) => {
    for (const row of overviewAoa) {
      if (row && row[0] === label) { row[1] = value; return }
    }
  }
  const runsMap = new Map<string, number>()
  for (const r of rows) {
    const k = `${r['巡检时间']}__${r['任务名称']}`
    runsMap.set(k, (runsMap.get(k) || 0) + 1)
  }
  setOverview('总运行次数', String(runsMap.size))

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
    '巡检时间', '任务名称', '项目简称', '归属部门', '虚拟机IPv4', '状态',
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

  // 压缩模式:每台资产只保留「季度内最新一次」快照 —— 300 台 × 12 次时能把
  // 3600 行压到 300 行(9.4MB → 0.8MB),而逐次波动在「资产趋势」里依然完整。
  let detailRows = sortedRows
  if (mode.detail === 'latest') {
    const latestMap = new Map<string, any>()
    for (const r of sortedRows) {
      const k = `${r['项目简称'] || ''}__${r['虚拟机IPv4'] || ''}`
      const prev = latestMap.get(k)
      if (!prev || String(r['巡检时间'] || '') > String(prev['巡检时间'] || '')) latestMap.set(k, r)
    }
    detailRows = Array.from(latestMap.values())
  }

  const detailAoa: any[][] = [detailCols]
  for (const r of detailRows) {
    const row: any[] = []
    for (const col of detailCols) row.push(r[col] ?? '')
    detailAoa.push(row)
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
    const k = `${r['项目简称']}__${r['虚拟机IPv4']}`
    let cur = assetMap.get(k)
    if (!cur) {
      cur = {
        name: r['项目简称'] || '',
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
    //   必须用 parseMetric 剥掉尾部单位再转
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
      const matchCrit = alerts.filter((a) => a['项目简称'] === cur!.name && a['虚拟机IPv4'] === cur!.ip && a['级别'] === '严重').length
      cur.alertCritical = Math.max(cur.alertCritical, matchCrit)
      const t = r['巡检时间'] || ''
      if (!cur.firstAlertAt || t < cur.firstAlertAt) cur.firstAlertAt = t
      if (!cur.lastAlertAt || t > cur.lastAlertAt) cur.lastAlertAt = t
    }
    if (r['状态'] === '失败') cur.failCount++
  }
  const trendHeader = ['项目简称', '归属部门', '虚拟机IPv4', '采集次数', '采集失败次数', 'CPU最高%', 'CPU最低%', 'CPU平均%', '内存最高%', '内存最低%', '内存平均%', '磁盘最高%', '磁盘最低%', '磁盘平均%', '告警总数', '严重告警数', '首次告警时间', '末次告警时间']
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

  // ---- 健康评分(比率口径,见概览处的注释)----
  const assetTotal = assetMap.size
  const alertAssetCount = Array.from(assetMap.values()).filter((a) => a.alertTotal > 0).length
  const alertAssetRatio = assetTotal ? alertAssetCount / assetTotal : 0
  const critRatio = totalAlerts ? criticalAlerts / totalAlerts : 0
  const resourcePenalty = (avgCpu * 0.3 + avgMem * 0.3 + avgDisk * 0.4) * 0.6 // 资源水位最多扣 ~60 分
  healthScore = Math.max(0, Math.min(100, Math.round(
    100 - resourcePenalty - alertAssetRatio * 20 - critRatio * 20
  )))
  setOverview('健康评分', `${healthScore} 分 (${healthColorOf(healthScore)})`)
  setOverview('告警资产占比', `${(alertAssetRatio * 100).toFixed(1)}%（${alertAssetCount}/${assetTotal} 台）`)
  setOverview('严重告警占比', `${(critRatio * 100).toFixed(1)}%（${criticalAlerts}/${totalAlerts}）`)

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
    h === '项目简称' ? 28 :
    h === '虚拟机IPv4' ? 16 :
    h === '告警项' ? 50 :
    h === '巡检时间' ? 18 :
    h === '操作系统' || h === '内核版本' || h === 'CPU类型' || h === '归属部门' ? 22 :
    14
  )
  const runsColWidths = [18, 28, 14, 10, 10, 12, 14]
  const trendColWidths = [28, 22, 16, 12, 14, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 14, 18, 18]
  const dayColWidths = [14, 14, 12, 12, 12, 12, 12, 12]

  // ---- 告警明细 sheet ----
  if (mode.alert === 'agg') {
    // 聚合模式:按「资产 + 指标」合并 —— 13232 条压到约 2~3 千行(5.7MB → 1MB 级)。
    // 级别取出现过的最高档,数值取峰值,时间给首次/末次,便于判断「是一直有还是偶发」。
    const aggMap = new Map<string, {
      name: string; dept: string; ip: string; cat: string; metric: string
      level: string; maxVal: number; cnt: number; first: string; last: string
      note: string; developer: string
    }>()
    for (const a of alerts) {
      const k = `${a['项目简称'] || ''}__${a['虚拟机IPv4'] || ''}__${a['指标'] || ''}`
      const t = String(a['巡检时间'] || '')
      let cur = aggMap.get(k)
      if (!cur) {
        cur = {
          name: a['项目简称'] || '', dept: a['归属部门'] || '', ip: a['虚拟机IPv4'] || '',
          cat: a['分类'] || '', metric: a['指标'] || '', level: a['级别'] || '',
          maxVal: -Infinity, cnt: 0, first: t, last: t,
          note: a['说明'] || '', developer: a['开发人员'] || '',
        }
        aggMap.set(k, cur)
      }
      cur.cnt++
      if (a['级别'] === '严重') cur.level = '严重'
      const v = parseMetric(a['数值'])
      if (isFinite(v)) cur.maxVal = Math.max(cur.maxVal, v)
      if (t && (!cur.first || t < cur.first)) cur.first = t
      if (t && (!cur.last || t > cur.last)) cur.last = t
    }
    const aggCols = ['项目简称', '归属部门', '虚拟机IPv4', '指标', '分类', '级别',
      '出现次数', '最高数值', '首次告警', '末次告警', '说明', '开发人员']
    const aggAoa: any[][] = [aggCols]
    const aggList = Array.from(aggMap.values()).sort((x, y) => {
      const lv = (x.level === '严重' ? 0 : 1) - (y.level === '严重' ? 0 : 1)
      if (lv !== 0) return lv
      return y.cnt - x.cnt
    })
    const limited = mode.alertLimit && mode.alertLimit > 0 ? aggList.slice(0, mode.alertLimit) : aggList
    for (const a of limited) {
      aggAoa.push([
        a.name, a.dept, a.ip, a.metric, a.cat, a.level, a.cnt,
        isFinite(a.maxVal) ? String(a.maxVal) : '—',
        a.first || '—', a.last || '—', a.note, a.developer,
      ])
    }
    return assemble({
      overviewAoa, runsAoa, runsColWidths, detailAoa, detailCols, detailColWidths,
      alertAoa: aggAoa, alertCols: aggCols, trendAoa, trendColWidths, dayAoa, dayColWidths,
    })
  }

  const alertCols = ['项目简称', '归属部门', '虚拟机IPv4', '巡检时间', '分类', '指标', '级别', '数值', '说明', '开发人员']
  const alertAoa: any[][] = [alertCols]
  const alertSorted = alerts.slice().sort((x, y) =>
    (x['级别'] === '严重' ? 0 : 1) - (y['级别'] === '严重' ? 0 : 1))
  const alertUsed = mode.alertLimit && mode.alertLimit > 0 ? alertSorted.slice(0, mode.alertLimit) : alertSorted
  for (const a of alertUsed) {
    alertAoa.push(alertCols.map((c) => a[c] ?? ''))
  }
  return assemble({
    overviewAoa, runsAoa, runsColWidths, detailAoa, detailCols, detailColWidths,
    alertAoa, alertCols, trendAoa, trendColWidths, dayAoa, dayColWidths,
  })
}

/** 把 6 张表按固定顺序装成 SheetSpec[] */
function assemble(p: {
  overviewAoa: any[][]
  runsAoa: any[][]; runsColWidths: number[]
  detailAoa: any[][]; detailCols: string[]; detailColWidths: number[]
  alertAoa: any[][]; alertCols: string[]
  trendAoa: any[][]; trendColWidths: number[]
  dayAoa: any[][]; dayColWidths: number[]
}): SheetSpec[] {
  const alertColWidths = p.alertCols.map((h) =>
    h === '说明' ? 50 : h === '开发人员' ? 20 : h === '虚拟机IPv4' ? 16 : h === '项目简称' ? 28 : 14)
  return [
    { key: '概览', title: '概览', build: () => ({ aoa: p.overviewAoa, cols: [22, 50] }) },
    { key: '各次运行', title: '各次运行', build: () => ({ aoa: p.runsAoa, cols: p.runsColWidths }) },
    { key: '资产明细', title: '资产明细', build: () => ({ aoa: p.detailAoa, cols: p.detailColWidths }) },
    { key: '告警明细', title: '告警明细', build: () => ({ aoa: p.alertAoa, cols: alertColWidths }) },
    { key: '资产趋势', title: '资产趋势', build: () => ({ aoa: p.trendAoa, cols: p.trendColWidths }) },
    { key: '按天趋势', title: '按天趋势', build: () => ({ aoa: p.dayAoa, cols: p.dayColWidths }) },
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