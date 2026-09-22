import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Card,
  Col,
  Empty,
  Input,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  AreaChartOutlined,
  CaretRightOutlined,
  NodeIndexOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import {
  listPromDataSources,
  promMetricNames,
  promQuery,
  promQueryRange,
  PROM_PRESETS,
  type PromDataSource,
  type PromSample,
  type PromSeries,
} from '../api/prometheus'

const { Title, Text } = Typography

function errMsg(e: any, fallback = '查询失败'): string {
  return e?.response?.data?.msg || e?.message || fallback
}

const RANGE_QUICKS: { label: string; seconds: number; step: number }[] = [
  { label: '近 1 小时', seconds: 3600, step: 30 },
  { label: '近 6 小时', seconds: 6 * 3600, step: 120 },
  { label: '近 24 小时', seconds: 24 * 3600, step: 600 },
  { label: '近 3 天', seconds: 3 * 86400, step: 1800 },
  { label: '近 7 天', seconds: 7 * 86400, step: 3600 },
]

const SERIES_COLORS = [
  '#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f87171',
  '#f472b6', '#60a5fa', '#4ade80', '#fb923c', '#22d3ee',
  '#c084fc', '#facc15',
]

function seriesName(metric: Record<string, string>): string {
  // 展示优先级：instance > nodename/hostname/job > 全量 label 串
  return (
    metric.instance ||
    metric.hostname ||
    metric.nodename ||
    metric.job ||
    JSON.stringify(metric)
  )
}

/** Prometheus 指标查询（v1.8.0）：指标浏览 + PromQL 编辑 + 即时/区间双模式 */
export default function PromMetrics() {
  const [dss, setDss] = useState<PromDataSource[]>([])
  const [ds, setDs] = useState<number | null>(null)
  const [names, setNames] = useState<string[]>([])
  const [mode, setMode] = useState<'instant' | 'range'>('range')
  const [rangeIdx, setRangeIdx] = useState(1)
  const [query, setQuery] = useState(PROM_PRESETS[0].query)
  const [loading, setLoading] = useState(false)

  // 结果
  const [samples, setSamples] = useState<PromSample[] | null>(null)
  const [series, setSeries] = useState<PromSeries[] | null>(null)

  /* ---------- 初始化：数据源 + 指标名 ---------- */
  useEffect(() => {
    listPromDataSources()
      .then((r) => {
        const usable = (r.list || []).filter((x) => x.enabled === 1)
        setDss(usable)
        if (usable.length > 0) setDs(usable[0].id)
      })
      .catch((e) => message.error('加载数据源失败:' + errMsg(e)))
  }, [])

  const loadNames = useCallback(() => {
    if (!ds) return
    promMetricNames(ds)
      .then((r) => setNames(r.names || []))
      .catch(() => setNames([]))
  }, [ds])

  useEffect(() => {
    loadNames()
  }, [loadNames])

  /* ---------- 执行查询 ---------- */
  const run = useCallback(async () => {
    if (!ds) {
      message.warning('请先选择数据源')
      return
    }
    if (!query.trim()) {
      message.warning('请填写 PromQL')
      return
    }
    setLoading(true)
    try {
      if (mode === 'instant') {
        const r = await promQuery(ds, query.trim())
        setSamples(r.samples || [])
        setSeries(null)
      } else {
        const qk = RANGE_QUICKS[rangeIdx]
        const end = Math.floor(Date.now() / 1000)
        const start = end - qk.seconds
        const r = await promQueryRange(ds, query.trim(), start, end, qk.step)
        setSeries(r.series || [])
        setSamples(null)
      }
    } catch (e) {
      message.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [ds, mode, query, rangeIdx])

  /* ---------- 区间结果 → ECharts ---------- */
  const rangeOption = useMemo(() => {
    if (!series) return null
    if (series.length === 0) return { empty: true } as any
    const xs: number[] = []
    const first = series[0].values || []
    for (const v of first) xs.push(v[0])
    const lines = series.slice(0, 20).map((s, i) => ({
      name: seriesName(s.metric),
      type: 'line' as const,
      showSymbol: false,
      lineStyle: { width: 1.5 },
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      data: (s.values || []).map((v) => parseFloat(v[1])),
    }))
    return {
      empty: xs.length === 0,
      grid: { left: 56, right: 16, top: 34, bottom: 44 },
      tooltip: { trigger: 'axis' },
      legend: { type: 'scroll', top: 0, textStyle: { color: 'var(--text-2, #64748b)', fontSize: 11 } },
      xAxis: {
        type: 'category',
        data: xs.map((t) => new Date(t * 1000).toLocaleTimeString('zh-CN', { hour12: false })),
        axisLabel: { fontSize: 10 },
      },
      yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
      series: lines,
    } as any
  }, [series])

  /* ---------- 即时结果表 ---------- */
  const instantRows = useMemo(() => {
    if (!samples) return []
    return samples.map((s, i) => {
      const v = parseFloat(s.value?.[1] ?? '0')
      return {
        key: i,
        name: seriesName(s.metric),
        value: isNaN(v) ? (s.value?.[1] ?? '—') : v,
        labels: s.metric || {},
      }
    })
  }, [samples])

  const nameOptions = useMemo(() => names.map((n) => ({ value: n, label: n })), [names])
  const chartRef = useRef<any>(null)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          <NodeIndexOutlined style={{ marginRight: 8 }} />
          Prometheus 指标查询
        </Title>
        <Tag color="purple">v1.8.0</Tag>
      </div>

      {/* 查询条件 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Row gutter={[8, 8]} align="middle">
          <Col>
            <Select
              style={{ minWidth: 200 }}
              placeholder="选择数据源"
              value={ds}
              onChange={(v) => setDs(v)}
              options={dss.map((d) => ({ value: d.id, label: `${d.name}（${d.url}）` }))}
              showSearch
              optionFilterProp="label"
            />
          </Col>
          <Col>
            <Segmented
              value={mode}
              onChange={(v) => setMode(v as any)}
              options={[
                { value: 'range', label: '区间', icon: <AreaChartOutlined /> },
                { value: 'instant', label: '即时', icon: <CaretRightOutlined /> },
              ]}
            />
          </Col>
          {mode === 'range' && (
            <Col>
              <Select
                style={{ width: 130 }}
                value={rangeIdx}
                onChange={(v) => setRangeIdx(v)}
                options={RANGE_QUICKS.map((q, i) => ({ value: i, label: q.label }))}
              />
            </Col>
          )}
          <Col flex="auto">
            <Input.Search
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onSearch={run}
              placeholder={'输入 PromQL，如 100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))'}
              enterButton={
                <Button type="primary" icon={<CaretRightOutlined />} loading={loading}>
                  查询
                </Button>
              }
              allowClear
            />
          </Col>
          <Col>
            <Tooltip title="刷新指标名列表">
              <Button icon={<ReloadOutlined />} onClick={loadNames} />
            </Tooltip>
          </Col>
        </Row>
        {/* 预置查询 + 指标名浏览 */}
        <Row gutter={[8, 8]} style={{ marginTop: 8 }}>
          <Col>
            <Space size={4} wrap>
              <Text type="secondary" style={{ fontSize: 12 }}>
                预置：
              </Text>
              {PROM_PRESETS.map((p) => (
                <Tag
                  key={p.label}
                  style={{ cursor: 'pointer' }}
                  color="geekblue"
                  onClick={() => {
                    setQuery(p.query)
                    setMode(p.range ? 'range' : 'instant')
                  }}
                >
                  {p.label}
                </Tag>
              ))}
            </Space>
          </Col>
        </Row>
        <Row style={{ marginTop: 8 }}>
          <Col span={24}>
            <Select
              style={{ width: '100%' }}
              placeholder="浏览指标名（输入过滤，点击填入查询）"
              options={nameOptions}
              showSearch
              filterOption={(input, opt) =>
                String(opt?.value || '').toLowerCase().includes(input.toLowerCase())
              }
              onChange={(v) => setQuery(String(v))}
              allowClear={false}
              data-metric-select="1"
            />
          </Col>
        </Row>
      </Card>

      {/* 结果 */}
      <Card size="small" title={mode === 'range' ? '区间趋势' : '即时快照'}>
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : mode === 'range' ? (
          rangeOption === null || rangeOption.empty ? (
            <Empty description="无数据（检查 PromQL 或时间范围）" style={{ padding: 40 }} />
          ) : (
            <ReactECharts
              ref={chartRef}
              option={rangeOption}
              notMerge
              style={{ height: 420 }}
              lazyUpdate
            />
          )
        ) : instantRows.length === 0 ? (
          <Empty description="无数据" style={{ padding: 40 }} />
        ) : (
          <Table
            rowKey="key"
            size="small"
            dataSource={instantRows}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            columns={[
              { title: '序列', dataIndex: 'name', width: 240, ellipsis: true },
              {
                title: '值',
                dataIndex: 'value',
                width: 160,
                render: (v: number) => <Text strong>{typeof v === 'number' ? v.toFixed(4).replace(/\.?0+$/, '') : v}</Text>,
              },
              {
                title: 'Labels',
                dataIndex: 'labels',
                render: (m: Record<string, string>) => (
                  <Space size={4} wrap>
                    {Object.entries(m).map(([k, v]) => (
                      <Tag key={k + v} style={{ margin: 0, fontSize: 11 }}>
                        {k}={v}
                      </Tag>
                    ))}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  )
}
