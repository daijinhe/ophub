/**
 * Prometheus 监控报表 · Excel 产出（v1.7.36 抽成公共模块）
 *
 * 之所以抽出来：监控报表页与「报告记录」页都要导出同一份报告，
 * 产出口径必须完全一致（同一套阈值判定、同一个降级顺序），
 * 否则「记录里导出的文件」和「当时页面上导出的文件」会不一样。
 *
 * 硬约束：**产物必须 ≤ 5MB，没得商量**。
 * 采用「实测字节 + 逐级降级」：每一步都真的写一遍再量字节，达标即停，
 * 绝不靠「行数 × 估算行宽」猜大小（v1.7.27 血案：估算把 4 个 Sheet 全丢了）。
 * 降级顺序：趋势降采样 → 丢趋势 → 明细只留风险主机 → 明细逐级截断 → 只留概览。
 */
import dayjs from 'dayjs'
import * as XLSX from 'xlsx'
import type { PromReport, PromReportRow } from '../api/prometheus'

/** 报告文件大小硬上限（与巡检季度报告同一口径）：5MB */
export const XLSX_MAX_BYTES = 5 * 1024 * 1024

export const DEFAULT_TH = {
  cpuWarn: 80,
  cpuCrit: 90,
  memWarn: 85,
  memCrit: 95,
  diskWarn: 85,
  diskCrit: 95,
}
export type Thresholds = typeof DEFAULT_TH

export function thOf(cfg?: PromReport['config']): Thresholds {
  return {
    cpuWarn: cfg?.cpuWarn || DEFAULT_TH.cpuWarn,
    cpuCrit: cfg?.cpuCrit || DEFAULT_TH.cpuCrit,
    memWarn: cfg?.memWarn || DEFAULT_TH.memWarn,
    memCrit: cfg?.memCrit || DEFAULT_TH.memCrit,
    diskWarn: cfg?.diskWarn || DEFAULT_TH.diskWarn,
    diskCrit: cfg?.diskCrit || DEFAULT_TH.diskCrit,
  }
}

/** 风险判定：任一指标峰值达严重阈值 = 高；达最低关注阈值 = 中；否则正常 */
export function riskLevel(r: PromReportRow, th: Thresholds): '高' | '中' | '正常' {
  if (r.cpuMax >= th.cpuCrit || r.memMax >= th.memCrit || r.diskMax >= th.diskCrit) return '高'
  const m = Math.max(r.cpuMax, r.memMax, r.diskMax)
  if (m >= Math.min(th.cpuWarn, th.memWarn, th.diskWarn)) return '中'
  return '正常'
}

/**
 * 报告范围文案（v1.7.38）。
 *
 * 按项目出的报告**必须在文件里写明覆盖了哪些项目**：同一周期的报告可能有好几份
 * （每人负责的项目不同），只看到数字而不知道范围，报告就没法用于汇报与追责。
 */
export function scopeTextOf(report: PromReport): string {
  const sys = report.systems || []
  if (sys.length === 0) return '全部项目（数据源下所有主机）'
  return `项目（${sys.length} 个）：${sys.join('、')}`
}

/** 报告范围是否为「指定项目」（false = 全集群口径） */
export function isScoped(report: PromReport): boolean {
  return (report.systems || []).length > 0
}

/**
 * 文件名里的范围后缀。同一周期导出多份项目报告时，
 * 没有后缀会得到一批同名文件（浏览器自动加 (1)(2)），根本分不清谁是谁。
 */
export function scopeFileSuffix(report: PromReport): string {
  const sys = report.systems || []
  if (sys.length === 0) return ''
  const head = sys.length <= 2 ? sys.join('、') : `${sys[0]}等${sys.length}个项目`
  // 文件名非法字符替换掉，避免下载时被浏览器截断
  return `_${head.replace(/[\\/:*?"<>|\s]/g, '_')}`
}

/** 该主机最主要的风险项（取峰值最高的那一项） */
export function mainRisk(r: PromReportRow): { name: string; value: number } {
  const items = [
    { name: 'CPU', value: r.cpuMax },
    { name: '内存', value: r.memMax },
    { name: '磁盘', value: r.diskMax },
  ]
  items.sort((a, b) => b.value - a.value)
  return items[0]
}

interface GroupAgg {
  key: string
  hosts: number
  cpuAvg: number
  cpuMax: number
  memAvg: number
  memMax: number
  diskAvg: number
  diskMax: number
  risk: number
}

/** 按维度聚合：均值取各主机均值再平均，峰值取各主机峰值的最高 */
export function aggregateBy(
  rows: PromReportRow[],
  dim: 'department' | 'system',
  th: Thresholds,
): GroupAgg[] {
  const m = new Map<string, GroupAgg>()
  for (const r of rows) {
    const k = (dim === 'department' ? r.department : r.system) || '未分组'
    let g = m.get(k)
    if (!g) {
      g = { key: k, hosts: 0, cpuAvg: 0, cpuMax: 0, memAvg: 0, memMax: 0, diskAvg: 0, diskMax: 0, risk: 0 }
      m.set(k, g)
    }
    g.hosts += 1
    g.cpuAvg += r.cpuAvg
    g.memAvg += r.memAvg
    g.diskAvg += r.diskAvg
    g.cpuMax = Math.max(g.cpuMax, r.cpuMax)
    g.memMax = Math.max(g.memMax, r.memMax)
    g.diskMax = Math.max(g.diskMax, r.diskMax)
    if (riskLevel(r, th) !== '正常') g.risk += 1
  }
  const out = Array.from(m.values()).map((g) => ({
    ...g,
    cpuAvg: Number((g.cpuAvg / g.hosts).toFixed(1)),
    memAvg: Number((g.memAvg / g.hosts).toFixed(1)),
    diskAvg: Number((g.diskAvg / g.hosts).toFixed(1)),
  }))
  out.sort((a, b) => Math.max(b.cpuMax, b.memMax, b.diskMax) - Math.max(a.cpuMax, a.memMax, a.diskMax))
  return out
}

/** 健康评分（比率口径，避免「按条数扣分 → 必得 0 分」的老坑） */
export function healthScore(rows: PromReportRow[], fleet: PromReport['fleet'], th: Thresholds) {
  const water = (fleet.cpuAvg + fleet.memAvg + fleet.diskAvg) / 3
  const total = rows.length || 1
  const risk = rows.filter((r) => riskLevel(r, th) !== '正常').length
  const crit = rows.filter((r) => riskLevel(r, th) === '高').length
  const riskRatio = risk / total
  const critRatio = crit / total
  const score = Math.max(0, Math.min(100, 100 - water * 0.55 - riskRatio * 100 * 0.3 - critRatio * 100 * 0.15))
  const level = score >= 90 ? '优秀' : score >= 80 ? '良好' : score >= 70 ? '一般' : score >= 60 ? '需关注' : '需整改'
  return { score: Math.round(score), level, risk, crit, riskRatio }
}

function setCols(ws: any, widths: number[]) {
  ws['!cols'] = widths.map((w) => ({ wch: w }))
}

/** 趋势降采样：等间隔抽点，首尾必留（保留整体形状） */
function downsample<T>(arr: T[], limit: number): T[] {
  if (limit <= 0 || arr.length <= limit) return arr
  const out: T[] = []
  const step = (arr.length - 1) / (limit - 1)
  for (let i = 0; i < limit; i++) out.push(arr[Math.round(i * step)])
  return out
}

/** 组装工作簿；opts 控制降级策略 */
export function buildWorkbook(
  report: PromReport,
  dsName: string,
  th: Thresholds,
  opts: { trendLimit: number; detailRows: PromReportRow[]; detailNote: string; generatedAt?: string },
) {
  const wb = XLSX.utils.book_new()
  const now = opts.generatedAt || dayjs().format('YYYY-MM-DD HH:mm')
  const hs = healthScore(report.rows, report.fleet, th)
  const judge = (v: number) => (v >= 90 ? '偏高' : v >= 80 ? '关注' : '正常')

  /* ---------- Sheet1 报告概览（领导一页纸） ---------- */
  const byDept = aggregateBy(report.rows, 'department', th)
  const topRisk = report.rows
    .map((r) => ({ r, m: mainRisk(r) }))
    .filter((x) => riskLevel(x.r, th) !== '正常')
    .sort((a, b) => b.m.value - a.m.value)
    .slice(0, 10)
  const scoped = isScoped(report)
  // 「全集群」这个说法在按项目出报告时是错的，会让人误以为覆盖了全部机器
  const fleetWord = scoped ? '所选项目' : '全集群'
  const conclusion =
    hs.crit > 0
      ? `本期 ${report.hostCount} 台主机中 ${hs.crit} 台出现严重水位（峰值达严重阈值），建议优先排查下方风险主机清单。`
      : hs.risk > 0
        ? `本期 ${report.hostCount} 台主机整体平稳，${hs.risk} 台处于关注区间，建议持续观察。`
        : `本期 ${report.hostCount} 台主机全部在阈值内运行，资源水位健康。`

  const ov: (string | number)[][] = [
    [`Prometheus 监控报表 · ${report.periodCN}`],
    [],
    ['报告范围', scopeTextOf(report)],
    ['报告周期', report.periodCN],
    ['数据窗口', `${report.start} ~ ${report.end}`],
    ['生成时间', now],
    ['数据源', dsName],
    ['统计范围', `${report.hostCount} 台主机 · 每主机 ${report.points} 个采样点`],
    ...(scoped
      ? ([
          ['范围说明', `本报告仅统计上述项目的主机，未包含数据源内的其他项目`],
        ] as (string | number)[][])
      : []),
    [],
    ['一、整体结论'],
    ['健康评分', `${hs.score} 分（${hs.level}）`],
    ['结论摘要', conclusion],
    [],
    [`二、${fleetWord}资源水位`],
    ['指标', '均值', '峰值', '判定'],
    ['CPU 使用率', report.fleet.cpuAvg, report.fleet.cpuMax, judge(report.fleet.cpuMax)],
    ['内存使用率', report.fleet.memAvg, report.fleet.memMax, judge(report.fleet.memMax)],
    ['磁盘使用率', report.fleet.diskAvg, report.fleet.diskMax, judge(report.fleet.diskMax)],
    [],
    ['三、风险概览'],
    ['项目', '数值'],
    ['严重主机（峰值达严重阈值）', `${hs.crit} 台`],
    ['关注主机（峰值达关注阈值）', `${hs.risk - hs.crit} 台`],
    ['风险主机占比', `${(hs.riskRatio * 100).toFixed(1)}%`],
    ['涉及部门', `${byDept.length} 个`],
    [],
    ['四、风险主机 TOP10'],
    ['所属部门', '项目名', '虚拟机IPv4', '环境', '业务环境', '最高峰值%'],
    ...topRisk.map((x) => [
      x.r.department || '',
      x.r.system || '',
      x.r.instance,
      x.r.env || '',
      x.r.deployserver || '',
      Number(x.m.value.toFixed(1)),
    ]),
    [],
    ['五、Sheet 说明'],
    ['分组汇总', '按所属部门 / 项目名聚合的均值与峰值，用于横向对比'],
    ['主机资源明细', `每台主机的均值 / 峰值与风险判定${opts.detailNote}`],
    ['资源趋势', opts.trendLimit === 0 ? '（数据量超限，本期已省略）' : `${fleetWord}均值随时间变化`],
  ]
  const wsOv = XLSX.utils.aoa_to_sheet(ov)
  setCols(wsOv, [24, 20, 18, 14, 14, 14])
  wsOv['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }]
  XLSX.utils.book_append_sheet(wb, wsOv, '报告概览')

  /* ---------- Sheet2 分组汇总 ---------- */
  const sum: (string | number)[][] = [
    ['分组汇总（按所属部门）'],
    ['所属部门', '主机数', 'CPU均值%', 'CPU峰值%', '内存均值%', '内存峰值%', '磁盘均值%', '磁盘峰值%', '风险主机'],
  ]
  for (const g of byDept) {
    sum.push([g.key, g.hosts, g.cpuAvg, g.cpuMax, g.memAvg, g.memMax, g.diskAvg, g.diskMax, g.risk])
  }
  const sysRows = aggregateBy(report.rows, 'system', th)
  sum.push([])
  sum.push(['分组汇总（按项目名）'])
  sum.push(['项目名', '主机数', 'CPU均值%', 'CPU峰值%', '内存均值%', '内存峰值%', '磁盘均值%', '磁盘峰值%', '风险主机'])
  for (const g of sysRows) {
    sum.push([g.key, g.hosts, g.cpuAvg, g.cpuMax, g.memAvg, g.memMax, g.diskAvg, g.diskMax, g.risk])
  }
  const wsSum = XLSX.utils.aoa_to_sheet(sum)
  setCols(wsSum, [22, 10, 11, 11, 11, 11, 11, 11, 10])
  wsSum['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 8 } },
    { s: { r: byDept.length + 3, c: 0 }, e: { r: byDept.length + 3, c: 8 } },
  ]
  XLSX.utils.book_append_sheet(wb, wsSum, '分组汇总')

  /* ---------- Sheet3 主机资源明细（列顺序按需求固定） ---------- */
  const header = [
    '所属部门', '项目名', '虚拟机IPv4', '环境', '业务环境',
    'CPU均值%', 'CPU峰值%', '内存均值%', '内存峰值%', '磁盘均值%', '磁盘峰值%', '风险',
  ]
  const body = opts.detailRows.map((r) => [
    r.department || '',
    r.system || '',
    r.instance,
    r.env || '',
    r.deployserver || '',
    Number(r.cpuAvg.toFixed(1)),
    Number(r.cpuMax.toFixed(1)),
    Number(r.memAvg.toFixed(1)),
    Number(r.memMax.toFixed(1)),
    Number(r.diskAvg.toFixed(1)),
    Number(r.diskMax.toFixed(1)),
    riskLevel(r, th),
  ])
  const wsDetail = XLSX.utils.aoa_to_sheet([header, ...body])
  setCols(wsDetail, [16, 18, 16, 10, 12, 10, 10, 10, 10, 10, 10, 8])
  XLSX.utils.book_append_sheet(wb, wsDetail, '主机资源明细')

  /* ---------- Sheet4 资源趋势 ---------- */
  if (opts.trendLimit !== 0) {
    const pts = downsample(report.trend, opts.trendLimit)
    const t: (string | number)[][] = [
      ['时间', `CPU使用率%(${fleetWord}均值)`, `内存使用率%(${fleetWord}均值)`, `磁盘使用率%(${fleetWord}均值)`],
      ...pts.map((p) => [
        dayjs(p.ts * 1000).format('YYYY-MM-DD HH:mm'),
        p.cpu ?? '',
        p.mem ?? '',
        p.disk ?? '',
      ]),
    ]
    const wsT = XLSX.utils.aoa_to_sheet(t)
    setCols(wsT, [20, 24, 24, 24])
    XLSX.utils.book_append_sheet(wb, wsT, '资源趋势')
  }
  return wb
}

/**
 * 导出报告为 Excel：实测字节 + 逐级降级，保证 ≤5MB。
 * 返回 { ok, bytes, tip } —— 调用方按 ok 决定提示文案。
 */
export function exportPromReportXlsx(
  report: PromReport,
  dsName: string,
  fileName?: string,
  generatedAt?: string,
): { ok: boolean; bytes: number; tip: string } {
  const th = thOf(report.config)
  const all = report.rows
  const riskRows = all.filter((r) => riskLevel(r, th) !== '正常')

  type Strategy = { trendLimit: number; detailRows: PromReportRow[]; detailNote: string; tip: string }
  const strategies: Strategy[] = [
    { trendLimit: 100000, detailRows: all, detailNote: '', tip: '' },
    { trendLimit: 500, detailRows: all, detailNote: '', tip: '趋势已降采样' },
    { trendLimit: 0, detailRows: all, detailNote: '', tip: '已省略「资源趋势」Sheet' },
    { trendLimit: 0, detailRows: riskRows, detailNote: '（数据量超限，明细仅保留风险主机）', tip: '明细仅保留风险主机' },
    { trendLimit: 0, detailRows: all.slice(0, 3000), detailNote: '（数据量超限，明细已截断至 3000 行）', tip: '明细截断至 3000 行' },
    { trendLimit: 0, detailRows: all.slice(0, 1000), detailNote: '（数据量超限，明细已截断至 1000 行）', tip: '明细截断至 1000 行' },
    { trendLimit: 0, detailRows: all.slice(0, 300), detailNote: '（数据量超限，明细已截断至 300 行）', tip: '明细截断至 300 行' },
    { trendLimit: 0, detailRows: [], detailNote: '（数据量超限，本期仅保留概览与分组汇总）', tip: '仅保留概览与汇总' },
  ]

  for (const s of strategies) {
    const wb = buildWorkbook(report, dsName, th, {
      trendLimit: s.trendLimit,
      detailRows: s.detailRows,
      detailNote: s.detailNote,
      generatedAt,
    })
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    // 实测字节达标即导出（绝不靠估算行数判断）
    if (out.byteLength <= XLSX_MAX_BYTES) {
      const blob = new Blob([out], { type: 'application/octet-stream' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download =
        fileName ||
        `Prometheus监控报表_${report.periodCN}${scopeFileSuffix(report)}_${dayjs().format('YYYYMMDD')}.xlsx`
      a.click()
      URL.revokeObjectURL(a.href)
      return { ok: true, bytes: out.byteLength, tip: s.tip }
    }
  }
  return { ok: false, bytes: 0, tip: '' }
}
