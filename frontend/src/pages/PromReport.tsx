import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  AlertOutlined,
  BarChartOutlined,
  FileExcelOutlined,
  FundOutlined,
  HddOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import dayjs, { type Dayjs } from 'dayjs'
import * as XLSX from 'xlsx'
import {
  listPromDataSources,
  promReport,
  type PromDataSource,
  type PromReport,
  type PromReportRow,
} from '../api/prometheus'

const { Title, Text } = Typography

function errMsg(e: any, fallback = '操作失败'): string {
  return e?.response?.data?.msg || e?.message || fallback
}

type Period = 'month' | 'quarter' | 'year'

const PERIOD_LABEL: Record<Period, string> = {
  month: '月度',
  quarter: '季度',
  year: '年度',
}

/** 报告文件大小硬上限（与巡检季度报告同一口径）：5MB，没得商量 */
const XLSX_MAX_BYTES = 5 * 1024 * 1024

function usageColor(v: number): string {
  if (v >= 90) return 'red'
  if (v >= 80) return 'orange'
  return 'green'
}

function fmtPct(v: number | undefined | null): string {
  if (v === undefined || v === null) return '—'
  return `${v.toFixed(1)}%`
}

/* --------------------------------------------------------------------------
 * 导出 Excel（给领导看：概览 → 分组汇总 → 明细 → 趋势）
 *
 * 硬约束：**产物必须 ≤ 5MB，没得商量**。
 * 采用「实测字节 + 逐级降级」：每一步都真的写一遍再量字节，达标即停，
 * 绝不靠「行数 × 估算行宽」猜大小（v1.7.27 血案：估算把 4 个 Sheet 全丢了）。
 * 降级顺序：趋势降采样 → 丢趋势 → 明细只留风险主机 → 明细逐级截断 → 只留概览。
 * ------------------------------------------------------------------------ */

const DEFAULT_TH = { cpuWarn: 80, cpuCrit: 90, memWarn: 85, memCrit: 95, diskWarn: 85, diskCrit: 95 }
type Thresholds = typeof DEFAULT_TH

function thOf(cfg?: PromReport['config']): Thresholds {
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
function riskLevel(r: PromReportRow, th: Thresholds): '高' | '中' | '正常' {
  if (r.cpuMax >= th.cpuCrit || r.memMax >= th.memCrit || r.diskMax >= th.diskCrit) return '高'
  const m = Math.max(r.cpuMax, r.memMax, r.diskMax)
  if (m >= Math.min(th.cpuWarn, th.memWarn, th.diskWarn)) return '中'
  return '正常'
}

/** 该主机最主要的风险项（取峰值最高的那一项） */
function mainRisk(r: PromReportRow): { name: string; value: number } {
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
function aggregateBy(rows: PromReportRow[], dim: 'department' | 'system', th: Thresholds): GroupAgg[] {
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
function healthScore(rows: PromReportRow[], fleet: PromReport['fleet'], th: Thresholds) {
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
function buildWorkbook(
  report: PromReport,
  dsName: string,
  th: Thresholds,
  opts: { trendLimit: number; detailRows: PromReportRow[]; detailNote: string },
) {
  const wb = XLSX.utils.book_new()
  const now = dayjs().format('YYYY-MM-DD HH:mm')
  const hs = healthScore(report.rows, report.fleet, th)
  const judge = (v: number) => (v >= 90 ? '偏高' : v >= 80 ? '关注' : '正常')

  /* ---------- Sheet1 报告概览（领导一页纸） ---------- */
  const byDept = aggregateBy(report.rows, 'department', th)
  const topRisk = report.rows
    .map((r) => ({ r, m: mainRisk(r) }))
    .filter((x) => riskLevel(x.r, th) !== '正常')
    .sort((a, b) => b.m.value - a.m.value)
    .slice(0, 10)
  const conclusion =
    hs.crit > 0
      ? `本期 ${report.hostCount} 台主机中 ${hs.crit} 台出现严重水位（峰值达严重阈值），建议优先排查下方风险主机清单。`
      : hs.risk > 0
        ? `本期 ${report.hostCount} 台主机整体平稳，${hs.risk} 台处于关注区间，建议持续观察。`
        : `本期 ${report.hostCount} 台主机全部在阈值内运行，资源水位健康。`

  const ov: (string | number)[][] = [
    [`Prometheus 监控报表 · ${report.periodCN}`],
    [],
    ['报告周期', report.periodCN],
    ['数据窗口', `${report.start} ~ ${report.end}`],
    ['生成时间', now],
    ['数据源', dsName],
    ['统计范围', `${report.hostCount} 台主机 · 每主机 ${report.points} 个采样点`],
    [],
    ['一、整体结论'],
    ['健康评分', `${hs.score} 分（${hs.level}）`],
    ['结论摘要', conclusion],
    [],
    ['二、全集群资源水位'],
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
    ['所属部门', '项目名', '虚拟机IPv4', '环境', '业务环境', '最高峰值%', '主要风险项', '风险'],
    ...topRisk.map((x) => [
      x.r.department || '',
      x.r.system || '',
      x.r.instance,
      x.r.env || '',
      x.r.deployserver || '',
      Number(x.m.value.toFixed(1)),
      x.m.name,
      riskLevel(x.r, th),
    ]),
    [],
    ['五、Sheet 说明'],
    ['分组汇总', '按所属部门 / 项目名聚合的均值与峰值，用于横向对比'],
    ['主机资源明细', `每台主机的均值 / 峰值与风险判定${opts.detailNote}`],
    ['资源趋势', opts.trendLimit === 0 ? '（数据量超限，本期已省略）' : '全集群均值随时间变化'],
  ]
  const wsOv = XLSX.utils.aoa_to_sheet(ov)
  setCols(wsOv, [24, 20, 18, 14, 14, 14, 14, 12])
  wsOv['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }]
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
      ['时间', 'CPU使用率%(全集群均值)', '内存使用率%(全集群均值)'],
      ...pts.map((p) => [dayjs(p.ts * 1000).format('YYYY-MM-DD HH:mm'), p.cpu ?? '', p.mem ?? '']),
    ]
    const wsT = XLSX.utils.aoa_to_sheet(t)
    setCols(wsT, [20, 24, 24])
    XLSX.utils.book_append_sheet(wb, wsT, '资源趋势')
  }
  return wb
}

/**
 * Prometheus 监控报表（v1.8.0）
 *
 * 月度 / 季度 / 年度：把时间窗内每台主机的 CPU / 内存 / 磁盘聚合成
 * 「均值 + 峰值」，产出 KPI、趋势图、主机明细，可导出 Excel。
 * 与巡检报表同一产出口径（SheetJS + 5MB 上限 + 先压缩后丢弃）。
 */
export default function PromReportPage() {
  const [dss, setDss] = useState<PromDataSource[]>([])
  const [ds, setDs] = useState<number | null>(null)
  const [period, setPeriod] = useState<Period>('month')
  const [ref, setRef] = useState<Dayjs | null>(dayjs())
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<PromReport | null>(null)

  useEffect(() => {
    listPromDataSources()
      .then((r) => {
        const usable = (r.list || []).filter((x) => x.enabled === 1)
        setDss(usable)
        if (usable.length > 0) setDs(usable[0].id)
      })
      .catch((e) => message.error('加载数据源失败:' + errMsg(e)))
  }, [])

  const generate = useCallback(async () => {
    if (!ds) {
      message.warning('请先选择数据源')
      return
    }
    setLoading(true)
    try {
      const r = await promReport(ds, period, ref ? ref.format('YYYY-MM-DD') : undefined)
      setReport(r)
      if (!r.rows || r.rows.length === 0) {
        message.warning(`${PERIOD_LABEL[period]}窗口内没有采到任何主机数据（确认 node_exporter 已接入且 Prometheus 有历史数据）`)
      } else {
        message.success(`已生成 ${r.periodCN} 报告：${r.hostCount} 台主机`)
      }
    } catch (e) {
      message.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [ds, period, ref])

  const refPicker = useMemo(() => {
    if (period === 'month') return <DatePicker picker="month" value={ref} onChange={setRef} allowClear={false} />
    if (period === 'quarter') return <DatePicker picker="quarter" value={ref} onChange={setRef} allowClear={false} />
    return <DatePicker picker="year" value={ref} onChange={setRef} allowClear={false} />
  }, [period, ref])

  /* ---------- 图表 ---------- */
  const barOption = useMemo(() => {
    if (!report || !report.rows.length) return null
    const rows = report.rows.slice(0, 15)
    const names = rows.map((r) => r.hostname || r.instance)
    return {
      grid: { left: 56, right: 16, top: 40, bottom: 90 },
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { fontSize: 11 } },
      xAxis: {
        type: 'category',
        data: names,
        axisLabel: { rotate: 40, fontSize: 10, interval: 0 },
      },
      yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
      series: [
        {
          name: 'CPU 均值',
          type: 'bar',
          stack: 'x',
          data: rows.map((r) => r.cpuAvg),
          itemStyle: { color: '#38bdf8' },
        },
        {
          name: 'CPU 峰值',
          type: 'bar',
          data: rows.map((r) => r.cpuMax),
          itemStyle: { color: '#0ea5e9' },
        },
        {
          name: '内存均值',
          type: 'bar',
          data: rows.map((r) => r.memAvg),
          itemStyle: { color: '#a78bfa' },
        },
        {
          name: '内存峰值',
          type: 'bar',
          data: rows.map((r) => r.memMax),
          itemStyle: { color: '#8b5cf6' },
        },
        {
          name: '磁盘均值',
          type: 'bar',
          data: rows.map((r) => r.diskAvg),
          itemStyle: { color: '#34d399' },
        },
        {
          name: '磁盘峰值',
          type: 'bar',
          data: rows.map((r) => r.diskMax),
          itemStyle: { color: '#10b981' },
        },
      ],
    } as any
  }, [report])

  const trendOption = useMemo(() => {
    if (!report || !report.trend.length) return null
    return {
      grid: { left: 56, right: 16, top: 34, bottom: 44 },
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { fontSize: 11 } },
      xAxis: {
        type: 'category',
        data: report.trend.map((p) => dayjs(p.ts * 1000).format('MM-DD HH:mm')),
        axisLabel: { fontSize: 10 },
      },
      yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
      series: [
        {
          name: 'CPU 使用率（全集群均值）',
          type: 'line',
          showSymbol: false,
          data: report.trend.map((p) => p.cpu ?? null),
          lineStyle: { color: '#38bdf8', width: 1.5 },
          areaStyle: { color: 'rgba(56,189,248,0.12)' },
        },
        {
          name: '内存使用率（全集群均值）',
          type: 'line',
          showSymbol: false,
          data: report.trend.map((p) => p.mem ?? null),
          lineStyle: { color: '#a78bfa', width: 1.5 },
          areaStyle: { color: 'rgba(167,139,250,0.12)' },
        },
      ],
    } as any
  }, [report])

  /* ---------- 导出 Excel：实测字节 + 逐级降级，保证 ≤5MB ---------- */
  const exportXlsx = useCallback(() => {
    if (!report) return
    const th = thOf(report.config)
    const dsName = dss.find((x) => x.id === ds)?.name || '—'
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

    try {
      for (const s of strategies) {
        const wb = buildWorkbook(report, dsName, th, s)
        const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
        // 实测字节达标即导出（绝不靠估算行数判断）
        if (out.byteLength <= XLSX_MAX_BYTES) {
          const blob = new Blob([out], { type: 'application/octet-stream' })
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = `Prometheus监控报表_${report.periodCN}_${dayjs().format('YYYYMMDD')}.xlsx`
          a.click()
          URL.revokeObjectURL(a.href)
          message.success(`导出成功（${(out.byteLength / 1024 / 1024).toFixed(2)}MB）${s.tip ? ' · ' + s.tip : ''}`)
          return
        }
      }
      message.error('报告数据过大，已尝试全部降级策略仍超过 5MB，请缩小周期或联系管理员')
    } catch (e: any) {
      message.error('导出失败:' + (e?.message || e))
    }
  }, [report, ds, dss])

  /* ---------- 明细表（列顺序与导出 Excel 完全一致） ---------- */
  const th = useMemo(() => thOf(report?.config), [report?.config])
  const hs = useMemo(
    () => (report ? healthScore(report.rows, report.fleet, th) : null),
    [report, th],
  )
  const columns = useMemo(
    () => [
      { title: '所属部门', dataIndex: 'department', width: 110, ellipsis: true, render: (v: string) => v || '—' },
      { title: '项目名', dataIndex: 'system', width: 130, ellipsis: true, render: (v: string) => v || '—' },
      { title: '虚拟机IPv4', dataIndex: 'instance', width: 160, ellipsis: true },
      { title: '环境', dataIndex: 'env', width: 100, ellipsis: true, render: (v: string) => v || '—' },
      { title: '业务环境', dataIndex: 'deployserver', width: 120, ellipsis: true, render: (v: string) => v || '—' },
      {
        title: 'CPU 均值',
        dataIndex: 'cpuAvg',
        width: 100,
        render: (v: number) => fmtPct(v),
      },
      {
        title: 'CPU 峰值',
        dataIndex: 'cpuMax',
        width: 100,
        render: (v: number) => <Tag color={usageColor(v)} style={{ margin: 0 }}>{fmtPct(v)}</Tag>,
      },
      { title: '内存均值', dataIndex: 'memAvg', width: 100, render: (v: number) => fmtPct(v) },
      {
        title: '内存峰值',
        dataIndex: 'memMax',
        width: 100,
        render: (v: number) => <Tag color={usageColor(v)} style={{ margin: 0 }}>{fmtPct(v)}</Tag>,
      },
      { title: '磁盘均值', dataIndex: 'diskAvg', width: 100, render: (v: number) => fmtPct(v) },
      {
        title: '磁盘峰值',
        dataIndex: 'diskMax',
        width: 100,
        render: (v: number) => <Tag color={usageColor(v)} style={{ margin: 0 }}>{fmtPct(v)}</Tag>,
      },
      {
        title: '风险',
        key: 'risk',
        width: 80,
        render: (_: any, r: PromReportRow) => {
          const lv = riskLevel(r, th)
          return (
            <Tag color={lv === '高' ? 'red' : lv === '中' ? 'orange' : 'green'} style={{ margin: 0 }}>
              {lv}
            </Tag>
          )
        },
      },
    ],
    [th],
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          <BarChartOutlined style={{ marginRight: 8 }} />
          Prometheus 监控报表
        </Title>
        <Tag color="purple">v1.7.33</Tag>
      </div>

      {/* 生成条件 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Row gutter={[8, 8]} align="middle">
          <Col>
            <Select
              style={{ minWidth: 200 }}
              placeholder="选择数据源"
              value={ds}
              onChange={setDs}
              options={dss.map((d) => ({ value: d.id, label: `${d.name}（${d.url}）` }))}
            />
          </Col>
          <Col>
            <Select
              style={{ width: 110 }}
              value={period}
              onChange={(v) => setPeriod(v)}
              options={(Object.keys(PERIOD_LABEL) as Period[]).map((p) => ({
                value: p,
                label: PERIOD_LABEL[p],
              }))}
            />
          </Col>
          <Col>{refPicker}</Col>
          <Col>
            <Space>
              <Button type="primary" icon={<FundOutlined />} loading={loading} onClick={generate}>
                生成报告
              </Button>
              <Button icon={<FileExcelOutlined />} disabled={!report} onClick={exportXlsx}>
                导出 Excel
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {loading ? (
        <Card size="small">
          <div style={{ padding: 64, textAlign: 'center' }}>
            <Spin tip="正在聚合历史数据（区间越长耗时越久）…" />
          </div>
        </Card>
      ) : !report ? (
        <Card size="small">
          <Empty
            description="选择数据源与周期后点击「生成报告」"
            style={{ padding: 60 }}
          />
        </Card>
      ) : (
        <>
          {/* KPI */}
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic title="主机数量" value={report.hostCount} suffix="台" />
              </Card>
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic
                  title="CPU 均值 / 峰值"
                  value={report.fleet.cpuAvg}
                  precision={1}
                  suffix={`% / ${fmtPct(report.fleet.cpuMax)}`}
                  valueStyle={{ color: usageColor(report.fleet.cpuMax) }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic
                  title="内存 均值 / 峰值"
                  value={report.fleet.memAvg}
                  precision={1}
                  suffix={`% / ${fmtPct(report.fleet.memMax)}`}
                  valueStyle={{ color: usageColor(report.fleet.memMax) }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic
                  title="磁盘 均值 / 峰值"
                  value={report.fleet.diskAvg}
                  precision={1}
                  suffix={`% / ${fmtPct(report.fleet.diskMax)}`}
                  valueStyle={{ color: usageColor(report.fleet.diskMax) }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic
                  title="峰值风险主机"
                  value={report.fleet.alertHit}
                  suffix="台"
                  prefix={<AlertOutlined />}
                  valueStyle={{ color: report.fleet.alertHit > 0 ? '#ef4444' : undefined }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic
                  title="健康评分"
                  value={hs?.score ?? 0}
                  suffix={`/ 100 · ${hs?.level ?? '—'}`}
                  valueStyle={{
                    color:
                      (hs?.score ?? 0) >= 80 ? '#16a34a' : (hs?.score ?? 0) >= 60 ? '#d97706' : '#dc2626',
                  }}
                />
                <Text type="secondary" style={{ fontSize: 11 }}>
                  资源水位 + 风险主机占比综合评定
                </Text>
              </Card>
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic title="报告周期" value={report.periodCN} prefix={<ThunderboltOutlined />} />
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {report.start} ~ {report.end} · {report.points} 个采样点
                </Text>
              </Card>
            </Col>
          </Row>

          {/* 趋势 + 对比 */}
          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col xs={24} lg={12}>
              <Card size="small" title="全集群资源趋势">
                {trendOption ? (
                  <ReactECharts option={trendOption} notMerge style={{ height: 320 }} lazyUpdate />
                ) : (
                  <Empty description="无趋势数据" style={{ padding: 40 }} />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" title="主机资源对比（TOP15，按 CPU 峰值）">
                {barOption ? (
                  <ReactECharts option={barOption} notMerge style={{ height: 320 }} lazyUpdate />
                ) : (
                  <Empty description="无主机数据" style={{ padding: 40 }} />
                )}
              </Card>
            </Col>
          </Row>

          {/* 明细 */}
          <Card
            size="small"
            title={
              <span>
                <HddOutlined /> 主机资源明细（{report.hostCount} 台）
              </span>
            }
          >
            <Table
              rowKey="instance"
              size="small"
              columns={columns}
              dataSource={report.rows}
              pagination={{ pageSize: 20, showSizeChanger: true }}
              scroll={{ x: 1300 }}
            />
          </Card>
        </>
      )}
    </div>
  )
}
