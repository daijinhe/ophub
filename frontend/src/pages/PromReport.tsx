import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
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
  HistoryOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import dayjs, { type Dayjs } from 'dayjs'
import {
  listPromDataSources,
  promGenerateReport,
  type PromDataSource,
  type PromReport,
  type PromReportRow,
} from '../api/prometheus'
// Excel 产出与健康评分抽到公共模块：「报告记录」页回看时要用同一套口径重新导出
import { exportPromReportXlsx, healthScore, riskLevel, thOf } from '../utils/promReportExcel'

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

function usageColor(v: number): string {
  if (v >= 90) return 'red'
  if (v >= 80) return 'orange'
  return 'green'
}

function fmtPct(v: number | undefined | null): string {
  if (v === undefined || v === null) return '—'
  return `${v.toFixed(1)}%`
}

export default function PromReportPage() {
  const [dss, setDss] = useState<PromDataSource[]>([])
  const [ds, setDs] = useState<number | null>(null)
  const [period, setPeriod] = useState<Period>('month')
  const [ref, setRef] = useState<Dayjs | null>(dayjs())
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<PromReport | null>(null)
  // 归档结果（v1.7.36）：生成即写入「报告记录」
  const [archivedId, setArchivedId] = useState<number | null>(null)

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
    setArchivedId(null)
    try {
      // 服务端「生成 + 归档」一次完成，不再额外查一遍 Prometheus
      const r = await promGenerateReport(ds, period, ref ? ref.format('YYYY-MM-DD') : undefined)
      const rep = r.report
      setReport(rep)
      if (r.id) setArchivedId(r.id)
      if (!rep.rows || rep.rows.length === 0) {
        message.warning(`${PERIOD_LABEL[period]}窗口内没有采到任何主机数据（确认 node_exporter 已接入且 Prometheus 有历史数据）`)
      } else if (r.id) {
        message.success(`已生成 ${rep.periodCN} 报告：${rep.hostCount} 台主机，并归档到「报告记录」#${r.id}`)
      } else {
        message.success(`已生成 ${rep.periodCN} 报告：${rep.hostCount} 台主机`)
      }
      if (r.msg && !r.id) message.warning(r.msg)
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
        {
          name: '磁盘使用率（全集群均值）',
          type: 'line',
          showSymbol: false,
          data: report.trend.map((p) => p.disk ?? null),
          lineStyle: { color: '#34d399', width: 1.5 },
          areaStyle: { color: 'rgba(52,211,153,0.12)' },
        },
      ],
    } as any
  }, [report])

  /* ---------- 导出 Excel：实测字节 + 逐级降级，保证 ≤5MB ---------- */
  const exportXlsx = useCallback(() => {
    if (!report) return
    const dsName = dss.find((x) => x.id === ds)?.name || '—'
    try {
      const r = exportPromReportXlsx(report, dsName)
      if (r.ok) {
        message.success(`导出成功（${(r.bytes / 1024 / 1024).toFixed(2)}MB）${r.tip ? ' · ' + r.tip : ''}`)
      } else {
        message.error('报告数据过大，已尝试全部降级策略仍超过 5MB，请缩小周期或联系管理员')
      }
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
        <Tag color="purple">v1.7.36</Tag>
        <Space style={{ marginLeft: 'auto' }}>
          <Button
            icon={<HistoryOutlined />}
            onClick={() => window.open('/prom/report-records', '_blank')}
          >
            报告记录
          </Button>
        </Space>
      </div>

      {archivedId && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          message={`本次报告已归档为「报告记录 #${archivedId}」`}
          description="可在「报告记录」里随时回看这份报告并重新导出 Excel —— 数据是生成时冻结的快照，不会随后续采集变化。"
          action={
            <Button
              size="small"
              onClick={() => window.open(`/prom/report-records?view=${archivedId}`, '_blank')}
            >
              查看
            </Button>
          }
        />
      )}

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
