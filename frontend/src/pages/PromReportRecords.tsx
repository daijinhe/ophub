import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import dayjs from 'dayjs'
import {
  deletePromReport,
  getPromReport,
  listPromDataSources,
  listPromProjects,
  listPromReports,
  updatePromReport,
  type PromDataSource,
  type PromProject,
  type PromReport,
  type PromReportRecord,
  type PromReportRecordDetail,
  type PromReportRow,
} from '../api/prometheus'
import { exportPromReportXlsx, healthScore, riskLevel, scopeFileSuffix, thOf } from '../utils/promReportExcel'
import { useAuth } from '../store/AuthContext'

const { Title, Text } = Typography

function errMsg(e: any, fallback = '操作失败'): string {
  return e?.response?.data?.msg || e?.message || fallback
}

const PERIOD_CN: Record<string, string> = {
  month: '月度',
  quarter: '季度',
  year: '年度',
}

function fmtPct(v: number | undefined | null): string {
  if (v === undefined || v === null) return '—'
  return `${v.toFixed(1)}%`
}

function usageColor(v: number): string {
  if (v >= 90) return 'red'
  if (v >= 80) return 'orange'
  return 'green'
}

function scoreColor(s: number): string {
  if (s >= 80) return '#16a34a'
  if (s >= 60) return '#d97706'
  return '#dc2626'
}

/**
 * Prometheus 监控 · 报告记录（v1.7.36）
 *
 * 「监控报表」每次点「生成报告」都会归档一条记录（服务端一次聚合完成构建 + 落库）。
 * 这里负责：按数据源 / 周期 / 关键字检索历史报告、回看冻结快照、重新导出 Excel、改名、删除。
 *
 * ⚠️ 归档存的是报告数据（rows/trend/fleet/config），不是 xlsx 文件：
 * 数据是生成时的冻结快照，用同一套产出口径重新生成即可，且「≤5MB 降级策略」继续生效。
 */
export default function PromReportRecords({
  embedded = false,
  viewId = null,
  onCloseView,
}: {
  /**
   * 嵌在「监控报表」页签里时置 true：不渲染页面级标题栏（标题由外层的 Tabs 承载），
   * 避免同一页出现「Prometheus 监控报表」+「报告记录」两级标题。
   */
  embedded?: boolean
  /** 深链要打开的报告 id（由外层从 ?view= 解析后传入；为 null 表示没有深链） */
  viewId?: number | null
  /** 抽屉被关掉时通知外层清掉 ?view= 参数 */
  onCloseView?: () => void
} = {}) {
  // 重命名 / 删除按细粒度码显隐：后端分别是 PUT/DELETE /prom/reports/:id 的
  // prom:report:update / prom:report:delete。
  // ⚠️ 不再用 hasPerm('prom:manage')：它是后端 migrateLegacyPerms 会展开并移除的历史聚合码，
  // 前端判定恒为 false，会把这两个按钮一直藏住。
  const { hasPerm } = useAuth()
  const [dss, setDss] = useState<PromDataSource[]>([])
  const [ds, setDs] = useState<number | undefined>(undefined)
  const [period, setPeriod] = useState<string | undefined>(undefined)
  // 项目筛选（v1.7.38）：项目名是「按数据源」取的，没选数据源就无从列出，
  // 所以这个筛选在未选数据源时置灰（而不是给一个会搜不到东西的输入框）
  const [projects, setProjects] = useState<PromProject[]>([])
  const [projLoading, setProjLoading] = useState(false)
  const [sysFilter, setSysFilter] = useState<string | undefined>(undefined)
  const [kw, setKw] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [list, setList] = useState<PromReportRecord[]>([])
  const [loading, setLoading] = useState(false)

  const [detail, setDetail] = useState<PromReportRecordDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [renameId, setRenameId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await listPromReports({ ds, period, system: sysFilter, kw: kw || undefined, page, pageSize })
      setList(r.list || [])
      setTotal(r.total || 0)
    } catch (e) {
      message.error('加载报告记录失败:' + errMsg(e))
      setList([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [ds, period, sysFilter, kw, page, pageSize])

  useEffect(() => {
    listPromDataSources()
      .then((r) => setDss(r.list || []))
      .catch(() => undefined)
  }, [])

  // 切数据源时重拉项目清单，并清掉上一个数据源的项目筛选
  useEffect(() => {
    setSysFilter(undefined)
    if (!ds) {
      setProjects([])
      return
    }
    setProjLoading(true)
    listPromProjects(ds)
      .then((r) => setProjects(r.list || []))
      .catch(() => setProjects([]))
      .finally(() => setProjLoading(false))
  }, [ds])

  useEffect(() => {
    load()
  }, [load])

  // 深链支持：从监控报表页「查看」带过来的 ?view=<id>。
  // 嵌入模式由外层解析 URL 后通过 viewId 传入（外层还负责在关抽屉时清掉参数）；
  // 独立路由访问时仍然自己读一次 URL，保证老书签 / 直链不失效。
  useEffect(() => {
    if (viewId) {
      openDetail(viewId)
      return
    }
    if (embedded) return
    const m = /[?&]view=(\d+)/.exec(window.location.search)
    if (m) openDetail(Number(m[1]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId, embedded])

  const openDetail = useCallback(async (id: number) => {
    setDetailOpen(true)
    setDetailLoading(true)
    try {
      const d = await getPromReport(id)
      setDetail(d)
    } catch (e) {
      message.error('加载报告详情失败:' + errMsg(e))
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const download = useCallback((d: PromReportRecordDetail) => {
    const rep: PromReport = {
      period: d.period,
      periodCN: d.periodCN,
      start: d.start,
      end: d.end,
      points: d.points,
      hostCount: d.hostCount,
      fleet: d.fleet,
      trend: d.trend || [],
      rows: d.rows || [],
      config: d.config,
      systems: d.systems || [],
      scopeText: d.scopeText || '',
      scopeTargets: 0,
      hint: '',
    }
    // 文件名带范围后缀：同一周期的多份项目报告要能区分开
    const file = `Prometheus监控报表_${d.periodCN}${scopeFileSuffix(rep)}_${dayjs(d.createdAt).format('YYYYMMDD-HHmm')}.xlsx`
    const r = exportPromReportXlsx(rep, d.dsName, file, dayjs(d.createdAt).format('YYYY-MM-DD HH:mm'))
    if (r.ok) {
      message.success(`已导出（${(r.bytes / 1024 / 1024).toFixed(2)}MB）${r.tip ? ' · ' + r.tip : ''}`)
    } else {
      message.error('该报告数据过大，降级后仍超过 5MB，无法导出')
    }
  }, [])

  const onDelete = useCallback(
    (r: PromReportRecord) => {
      Modal.confirm({
        title: '删除报告记录',
        content: `确认删除「${r.title}」？删除后无法恢复（该报告将不能再回看或导出）。`,
        okText: '确认删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          try {
            await deletePromReport(r.id)
            message.success('已删除')
            if (detail?.id === r.id) setDetailOpen(false)
            load()
          } catch (e) {
            message.error('删除失败:' + errMsg(e))
          }
        },
      })
    },
    [detail, load],
  )

  const submitRename = useCallback(async () => {
    if (!renameId) return
    const t = renameVal.trim()
    if (!t) {
      message.warning('标题不能为空')
      return
    }
    try {
      await updatePromReport(renameId, { title: t })
      message.success('已重命名')
      setRenameOpen(false)
      load()
      if (detail?.id === renameId) setDetail({ ...detail, title: t })
    } catch (e) {
      message.error('保存失败:' + errMsg(e))
    }
  }, [renameId, renameVal, detail, load])

  const columns = useMemo(
    () => [
      {
        title: '报告标题',
        dataIndex: 'title',
        key: 'title',
        ellipsis: true,
        render: (v: string, r: PromReportRecord) => (
          <div>
            <div style={{ fontWeight: 600 }}>{v}</div>
            {r.remark && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {r.remark}
              </Text>
            )}
          </div>
        ),
      },
      {
        title: '周期',
        dataIndex: 'period',
        key: 'period',
        width: 110,
        render: (v: string, r: PromReportRecord) => (
          <div>
            <Tag color="blue">{PERIOD_CN[v] || v}</Tag>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>{r.periodCN}</div>
          </div>
        ),
      },
      {
        title: '报告范围',
        key: 'scope',
        width: 210,
        render: (_: any, r: PromReportRecord) => {
          const sys = r.systems || []
          if (sys.length === 0) {
            return (
              <div>
                <Tag color="gold" style={{ margin: 0 }}>
                  全部项目
                </Tag>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>不限项目范围</div>
              </div>
            )
          }
          return (
            <div>
              <Tag color="blue" style={{ margin: 0 }}>
                {sys.length} 个项目
              </Tag>
              <Tooltip title={sys.join('、')}>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                  {sys.slice(0, 2).join('、')}
                  {sys.length > 2 ? ` 等 ${sys.length} 个` : ''}
                </div>
              </Tooltip>
              {r.templateName && (
                <div style={{ fontSize: 11, color: '#94a3b8' }}>模板：{r.templateName}</div>
              )}
            </div>
          )
        },
      },
      {
        title: '数据源',
        dataIndex: 'dsName',
        key: 'dsName',
        width: 150,
        ellipsis: true,
      },
      {
        title: '数据窗口',
        key: 'win',
        width: 190,
        render: (_: any, r: PromReportRecord) => (
          <div style={{ fontSize: 12 }}>
            <div>{r.start}</div>
            <div style={{ color: '#94a3b8' }}>至 {r.end}</div>
          </div>
        ),
      },
      {
        title: '主机数',
        dataIndex: 'hostCount',
        key: 'hostCount',
        width: 90,
        render: (v: number, r: PromReportRecord) => (
          <div>
            <div>{v} 台</div>
            {r.rowsTruncated === 1 && (
              <Tooltip title="主机数超过归档上限，明细只保留了水位最高的一批">
                <Tag color="orange" style={{ marginTop: 2, fontSize: 10, lineHeight: '16px' }}>
                  明细已裁剪
                </Tag>
              </Tooltip>
            )}
          </div>
        ),
      },
      {
        title: '健康评分',
        dataIndex: 'score',
        key: 'score',
        width: 130,
        render: (v: number, r: PromReportRecord) => (
          <div>
            <div style={{ color: scoreColor(v), fontWeight: 700, fontSize: 16 }}>
              {v} <span style={{ fontSize: 11, fontWeight: 400 }}>/ 100</span>
            </div>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {r.level}
            </Text>
          </div>
        ),
      },
      {
        title: '风险主机',
        key: 'risk',
        width: 120,
        render: (_: any, r: PromReportRecord) => (
          <Space size={4}>
            <Tag color={r.critHosts > 0 ? 'red' : 'default'}>严重 {r.critHosts}</Tag>
            <Tag color={r.riskHosts - r.critHosts > 0 ? 'orange' : 'default'}>
              关注 {r.riskHosts - r.critHosts}
            </Tag>
          </Space>
        ),
      },
      {
        title: '生成人 / 时间',
        key: 'created',
        width: 160,
        render: (_: any, r: PromReportRecord) => (
          <div style={{ fontSize: 12 }}>
            <div>{r.createdByName || '—'}</div>
            <div style={{ color: '#94a3b8' }}>{dayjs(r.createdAt).format('YYYY-MM-DD HH:mm')}</div>
          </div>
        ),
      },
      {
        title: '操作',
        key: 'op',
        width: 200,
        render: (_: any, r: PromReportRecord) => (
          <Space size={4}>
            <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(r.id)}>
              查看
            </Button>
            <Tooltip title="按归档数据重新导出 Excel（≤5MB）">
              <Button
                size="small"
                icon={<FileExcelOutlined />}
                onClick={async () => {
                  const d = await getPromReport(r.id)
                  download(d)
                }}
              />
            </Tooltip>
            {hasPerm('prom:report:update') && (
              <Tooltip title="重命名">
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setRenameId(r.id)
                    setRenameVal(r.title)
                    setRenameOpen(true)
                  }}
                />
              </Tooltip>
            )}
            {hasPerm('prom:report:delete') && (
              <Tooltip title="删除">
                <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onDelete(r)} />
              </Tooltip>
            )}
          </Space>
        ),
      },
    ],
    [openDetail, download, onDelete, hasPerm],
  )

  /* ---------- 详情 ---------- */
  const th = useMemo(() => thOf(detail?.config), [detail?.config])
  const hs = useMemo(
    () => (detail ? healthScore(detail.rows || [], detail.fleet, th) : null),
    [detail, th],
  )
  const trendOption = useMemo(() => {
    if (!detail || !detail.trend?.length) return null
    return {
      grid: { left: 56, right: 16, top: 34, bottom: 44 },
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { fontSize: 11 } },
      xAxis: {
        type: 'category',
        data: detail.trend.map((p) => dayjs(p.ts * 1000).format('MM-DD HH:mm')),
        axisLabel: { fontSize: 10 },
      },
      yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
      series: [
        {
          name: 'CPU 使用率',
          type: 'line',
          showSymbol: false,
          data: detail.trend.map((p) => p.cpu ?? null),
          lineStyle: { color: '#38bdf8', width: 1.5 },
          areaStyle: { color: 'rgba(56,189,248,0.12)' },
        },
        {
          name: '内存使用率',
          type: 'line',
          showSymbol: false,
          data: detail.trend.map((p) => p.mem ?? null),
          lineStyle: { color: '#a78bfa', width: 1.5 },
          areaStyle: { color: 'rgba(167,139,250,0.12)' },
        },
        {
          name: '磁盘使用率',
          type: 'line',
          showSymbol: false,
          data: detail.trend.map((p) => p.disk ?? null),
          lineStyle: { color: '#34d399', width: 1.5 },
          areaStyle: { color: 'rgba(52,211,153,0.12)' },
        },
      ],
    } as any
  }, [detail])

  const detailColumns = useMemo(
    () => [
      { title: '所属部门', dataIndex: 'department', width: 110, ellipsis: true, render: (v: string) => v || '—' },
      { title: '项目名', dataIndex: 'system', width: 130, ellipsis: true, render: (v: string) => v || '—' },
      { title: '虚拟机IPv4', dataIndex: 'instance', width: 150, ellipsis: true },
      { title: '环境', dataIndex: 'env', width: 90, ellipsis: true, render: (v: string) => v || '—' },
      { title: '业务环境', dataIndex: 'deployserver', width: 110, ellipsis: true, render: (v: string) => v || '—' },
      { title: 'CPU 均值', dataIndex: 'cpuAvg', width: 95, render: (v: number) => fmtPct(v) },
      {
        title: 'CPU 峰值',
        dataIndex: 'cpuMax',
        width: 95,
        render: (v: number) => <Tag color={usageColor(v)} style={{ margin: 0 }}>{fmtPct(v)}</Tag>,
      },
      { title: '内存均值', dataIndex: 'memAvg', width: 95, render: (v: number) => fmtPct(v) },
      {
        title: '内存峰值',
        dataIndex: 'memMax',
        width: 95,
        render: (v: number) => <Tag color={usageColor(v)} style={{ margin: 0 }}>{fmtPct(v)}</Tag>,
      },
      { title: '磁盘均值', dataIndex: 'diskAvg', width: 95, render: (v: number) => fmtPct(v) },
      {
        title: '磁盘峰值',
        dataIndex: 'diskMax',
        width: 95,
        render: (v: number) => <Tag color={usageColor(v)} style={{ margin: 0 }}>{fmtPct(v)}</Tag>,
      },
      {
        title: '风险',
        key: 'risk',
        width: 70,
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
      {!embedded && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <Title level={4} style={{ margin: 0 }}>
            <FileTextOutlined style={{ marginRight: 8 }} />
            报告记录
          </Title>
          <Tag color="purple">v1.7.41</Tag>
          <Space style={{ marginLeft: 'auto' }}>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
          </Space>
        </div>
      )}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="每次在「生成报告」里出报告都会自动归档一条记录"
        description="记录里保存的是报告生成时冻结的数据快照：可随时回看、按同一口径重新导出 Excel（仍受 5MB 上限保护），也可重命名或删除。按项目生成的报告会连同「项目范围」一起冻结，回看时能确认它覆盖了哪些项目。"
      />

      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Select
            allowClear
            style={{ minWidth: 200 }}
            placeholder="全部数据源"
            value={ds}
            onChange={(v) => {
              setDs(v)
              setPage(1)
            }}
            options={dss.map((d) => ({ value: d.id, label: d.name }))}
          />
          <Select
            allowClear
            style={{ width: 130 }}
            placeholder="全部周期"
            value={period}
            onChange={(v) => {
              setPeriod(v)
              setPage(1)
            }}
            options={[
              { value: 'month', label: '月度' },
              { value: 'quarter', label: '季度' },
              { value: 'year', label: '年度' },
            ]}
          />
          <Tooltip
            title={
              ds
                ? '只看包含该项目的报告（匹配生成时冻结的项目范围）'
                : '先选择数据源，才能列出该数据源下的项目'
            }
          >
            <Select
              allowClear
              showSearch
              style={{ width: 220 }}
              placeholder="全部项目"
              disabled={!ds}
              loading={projLoading}
              value={sysFilter}
              onChange={(v) => {
                setSysFilter(v)
                setPage(1)
              }}
              options={projects.map((p) => ({ value: p.name, label: `${p.name}（${p.hosts} 台）` }))}
              optionFilterProp="label"
            />
          </Tooltip>
          <Input.Search
            allowClear
            style={{ width: 260 }}
            placeholder="标题 / 数据源 / 备注关键字"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onSearch={() => setPage(1)}
          />
        </Space>
      </Card>

      <Card size="small">
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={list}
          locale={{ emptyText: <Empty description="还没有报告记录 —— 去「监控报表」生成一份" /> }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => {
              setPage(p)
              setPageSize(ps)
            },
          }}
          scroll={{ x: 1600 }}
        />
      </Card>

      {/* ---------- 详情抽屉 ---------- */}
      <Drawer
        width={1100}
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false)
          // 通知外层把 ?view= 清掉：否则分享出去的链接会「一打开就弹抽屉」
          onCloseView?.()
        }}
        title={detail ? `报告详情 · ${detail.title}` : '报告详情'}
        extra={
          detail && (
            <Button type="primary" icon={<FileExcelOutlined />} onClick={() => download(detail)}>
              导出 Excel
            </Button>
          )
        }
      >
        {detailLoading ? (
          <div style={{ padding: 80, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : !detail ? (
          <Empty description="报告不存在或已删除" />
        ) : (
          <div>
            {/* 报告范围：回看历史报告时，第一个要知道的就是「这份报告覆盖了哪些项目」 */}
            <Alert
              type={(detail.systems || []).length > 0 ? 'info' : 'warning'}
              showIcon
              style={{ marginBottom: 12 }}
              message={
                (detail.systems || []).length > 0
                  ? `报告范围：项目（${detail.systems.length} 个）`
                  : '报告范围：全部项目（不限项目范围）'
              }
              description={
                (detail.systems || []).length > 0 ? (
                  <span>
                    {(detail.systems || []).join('、')}
                    {detail.templateName ? ` · 生成模板：${detail.templateName}` : ''}
                  </span>
                ) : (
                  '该报告生成时未限定项目，统计了数据源下的全部主机'
                )
              }
            />

            {detail.rowsTruncated === 1 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="明细已裁剪"
                description={`该报告共 ${detail.hostCount} 台主机，超过归档上限，明细只保留了水位最高的 ${detail.rows.length} 台；评分与汇总仍按全量计算。`}
              />
            )}

            <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="主机数量" value={detail.hostCount} suffix="台" />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic
                    title="健康评分"
                    value={detail.score}
                    suffix={`/ 100 · ${detail.level}`}
                    valueStyle={{ color: scoreColor(detail.score) }}
                  />
                  {hs && (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      按当前阈值重算：{hs.score} 分（{hs.level}）
                    </Text>
                  )}
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic
                    title="CPU 均值 / 峰值"
                    value={detail.cpuAvg}
                    precision={1}
                    suffix={`% / ${fmtPct(detail.cpuMax)}`}
                    valueStyle={{ color: usageColor(detail.cpuMax) }}
                  />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic
                    title="内存 均值 / 峰值"
                    value={detail.memAvg}
                    precision={1}
                    suffix={`% / ${fmtPct(detail.memMax)}`}
                    valueStyle={{ color: usageColor(detail.memMax) }}
                  />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic
                    title="磁盘 均值 / 峰值"
                    value={detail.diskAvg}
                    precision={1}
                    suffix={`% / ${fmtPct(detail.diskMax)}`}
                    valueStyle={{ color: usageColor(detail.diskMax) }}
                  />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="风险主机" value={detail.riskHosts} suffix="台" />
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    其中严重 {detail.critHosts} 台
                  </Text>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="数据源" value={detail.dsName} />
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {detail.start} ~ {detail.end}
                  </Text>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="生成信息" value={detail.createdByName || '—'} />
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {dayjs(detail.createdAt).format('YYYY-MM-DD HH:mm:ss')}
                  </Text>
                </Card>
              </Col>
            </Row>

            <Card size="small" title="全集群资源趋势" style={{ marginBottom: 12 }}>
              {trendOption ? (
                <ReactECharts option={trendOption} notMerge style={{ height: 280 }} lazyUpdate />
              ) : (
                <Empty description="无趋势数据" style={{ padding: 40 }} />
              )}
            </Card>

            <Card
              size="small"
              title={<span>主机资源明细（{detail.rows?.length || 0} 台）</span>}
            >
              <Table
                rowKey="instance"
                size="small"
                columns={detailColumns}
                dataSource={detail.rows || []}
                pagination={{ pageSize: 20, showSizeChanger: true }}
                scroll={{ x: 1300 }}
              />
            </Card>
          </div>
        )}
      </Drawer>

      {/* ---------- 重命名 ---------- */}
      <Modal
        open={renameOpen}
        title="重命名报告记录"
        okText="保存"
        cancelText="取消"
        onCancel={() => setRenameOpen(false)}
        onOk={submitRename}
        maskClosable={false}
        keyboard
      >
        <Input
          value={renameVal}
          onChange={(e) => setRenameVal(e.target.value)}
          maxLength={64}
          showCount
          placeholder="报告标题"
          onPressEnter={submitRename}
        />
      </Modal>
    </div>
  )
}
