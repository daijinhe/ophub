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

/** 报告文件大小硬上限（与巡检季度报告同一口径） */
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

  /* ---------- 导出 Excel ---------- */
  const exportXlsx = useCallback(() => {
    if (!report) return
    try {
      const wb = XLSX.utils.book_new()
      // Sheet1 报告概览
      const overview = [
        ['Prometheus 监控报表'],
        ['报告周期', report.periodCN],
        ['数据窗口', `${report.start} ~ ${report.end}`],
        ['聚合采样点数', report.points],
        ['主机数量', report.hostCount],
        [],
        ['全集群 CPU 均值', fmtPct(report.fleet.cpuAvg)],
        ['全集群 CPU 峰值', fmtPct(report.fleet.cpuMax)],
        ['全集群 内存 均值', fmtPct(report.fleet.memAvg)],
        ['全集群 内存 峰值', fmtPct(report.fleet.memMax)],
        ['全集群 磁盘 均值', fmtPct(report.fleet.diskAvg)],
        ['全集群 磁盘 峰值', fmtPct(report.fleet.diskMax)],
        ['峰值≥90% 的主机数', report.fleet.alertHit],
      ]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(overview), '报告概览')
      // Sheet2 主机资源明细
      const header = ['实例', '主机名', 'CPU均值%', 'CPU峰值%', '内存均值%', '内存峰值%', '磁盘均值%', '磁盘峰值%', '峰值风险']
      const body = report.rows.map((r) => [
        r.instance,
        r.hostname || '',
        r.cpuAvg,
        r.cpuMax,
        r.memAvg,
        r.memMax,
        r.diskAvg,
        r.diskMax,
        Math.max(r.cpuMax, r.memMax, r.diskMax) >= 90 ? '高' : Math.max(r.cpuMax, r.memMax, r.diskMax) >= 80 ? '中' : '正常',
      ])
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...body]), '主机资源明细')
      // Sheet3 趋势数据
      const trendHeader = ['时间', 'CPU使用率%(全集群均值)', '内存使用率%(全集群均值)']
      const trendBody = report.trend.map((p) => [
        dayjs(p.ts * 1000).format('YYYY-MM-DD HH:mm'),
        p.cpu ?? '',
        p.mem ?? '',
      ])
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([trendHeader, ...trendBody]), '趋势数据')

      // 实测字节超限 → 丢趋势 Sheet（先压缩、再丢弃，趋势最可再生）
      let out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
      if (out.byteLength > XLSX_MAX_BYTES && wb.SheetNames.length === 3) {
        wb.SheetNames = wb.SheetNames.filter((n) => n !== '趋势数据')
        delete wb.Sheets['趋势数据']
        out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
        message.warning('数据量过大，已自动省略「趋势数据」Sheet')
      }
      if (out.byteLength > XLSX_MAX_BYTES) {
        message.error('报告数据过大（超过 5MB），请缩小周期或主机范围')
        return
      }
      const blob = new Blob([out], { type: 'application/octet-stream' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `Prometheus监控报表_${report.periodCN}.xlsx`
      a.click()
      URL.revokeObjectURL(a.href)
      message.success('导出成功')
    } catch (e: any) {
      message.error('导出失败:' + (e?.message || e))
    }
  }, [report])

  /* ---------- 明细表 ---------- */
  const columns = useMemo(
    () => [
      { title: '实例', dataIndex: 'instance', width: 190, ellipsis: true },
      { title: '主机名', dataIndex: 'hostname', width: 160, ellipsis: true, render: (v: string) => v || '—' },
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
          const m = Math.max(r.cpuMax, r.memMax, r.diskMax)
          return m >= 90 ? <Tag color="red">高</Tag> : m >= 80 ? <Tag color="orange">中</Tag> : <Tag color="green">正常</Tag>
        },
      },
    ],
    [],
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          <BarChartOutlined style={{ marginRight: 8 }} />
          Prometheus 监控报表
        </Title>
        <Tag color="purple">v1.8.0</Tag>
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
              scroll={{ x: 1100 }}
            />
          </Card>
        </>
      )}
    </div>
  )
}
