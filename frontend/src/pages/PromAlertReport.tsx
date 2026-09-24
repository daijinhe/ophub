import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Input,
  Modal,
  Progress,
  Row,
  Segmented,
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
  AlertOutlined,
  CloudDownloadOutlined,
  ReloadOutlined,
  SettingOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import dayjs, { type Dayjs } from 'dayjs'
import {
  exportN9eAlerts,
  getN9eConfig,
  getN9eStats,
  getN9eSyncStatus,
  listN9eDatasources,
  listN9eDepartments,
  listN9eEvents,
  listN9eGroups,
  saveN9eConfig,
  startN9eSync,
  testN9eConfig,
  type N9eAlertEvent,
  type N9eConfig,
  type N9eQueryParams,
  type N9eStats,
  type N9eSyncState,
} from '../api/prometheus'
import { useAuth } from '../store/AuthContext'

const { Title, Text } = Typography

// ============================================================================
// 监控告警报表 —— 夜莺（Nightingale）历史告警
//
// 数据流：夜莺 API --同步--> 本地库 --查询/统计/导出--> 本页
//
// ⚠️ 为什么页面上的「时间范围」改了不会自动重拉夜莺：
//    页面上的查询/统计/导出全部走**本地已同步的数据**（毫秒级）；
//    只有点「同步数据」才会去连夜莺。实测 90 天全量要 94 秒，
//    如果每次改筛选条件都现拉，页面会不可用。
//    所以页面头部会显著提示「本地数据截止时间」，避免把陈旧数据当实时数据看。
//
// ⚠️ 「数据源」下拉的选项来自**本地库 distinct**（不是实时拉夜莺清单）：只列出本地确实
//    有数据的数据源，避免用户选到一个空结果还以为功能坏了。该字段 v1.7.50 才落库，
//    老数据 datasource_id 为 0、不会出现在选项里，需要重新同步一次才会补齐。
// ============================================================================

const RANGE_OPTIONS = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
  { label: '自定义', value: -1 },
]

const SEVERITY_OPTIONS = [
  { label: '严重', value: 3 },
  { label: '警告', value: 2 },
  { label: '提醒', value: 1 },
]

const RECOVER_OPTIONS = [
  { label: '全部', value: -1 },
  { label: '未恢复', value: 0 },
  { label: '已恢复', value: 1 },
]

/** 等级配色：与项目内其他告警视图保持一致（红/橙/蓝） */
function severityColor(v: number): string {
  if (v >= 3) return 'red'
  if (v === 2) return 'orange'
  return 'blue'
}

function severityText(v: number): string {
  if (v >= 3) return '严重'
  if (v === 2) return '警告'
  if (v === 1) return '提醒'
  return `未知(${v})`
}

function fmtTime(ts: number): string {
  if (!ts) return '-'
  return dayjs.unix(ts).format('YYYY-MM-DD HH:mm:ss')
}

/** 秒 → 「1天2小时」 */
function fmtDuration(sec: number): string {
  if (sec < 0) sec = 0
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  return `${m}分${sec % 60}秒`
}

export default function PromAlertReport() {
  const { hasPerm } = useAuth()

  // ---- 筛选条件 ----
  const [days, setDays] = useState<number>(90)
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null)
  const [groupIds, setGroupIds] = useState<number[]>([])
  const [datasourceIds, setDatasourceIds] = useState<number[]>([])
  const [severity, setSeverity] = useState<number | undefined>(undefined)
  const [recovered, setRecovered] = useState<number>(-1)
  const [department, setDepartment] = useState<string | undefined>(undefined)
  const [keyword, setKeyword] = useState('')

  // ---- 数据 ----
  const [stats, setStats] = useState<N9eStats | null>(null)
  const [rows, setRows] = useState<N9eAlertEvent[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  // ---- 同步 ----
  const [syncState, setSyncState] = useState<N9eSyncState | null>(null)
  const [config, setConfig] = useState<N9eConfig | null>(null)
  const [groups, setGroups] = useState<{ groupId: number; groupName: string; n: number }[]>([])
  const [depts, setDepts] = useState<{ value: string; n: number }[]>([])
  const [datasources, setDatasources] = useState<
    { datasourceId: number; datasourceName: string; n: number }[]
  >([])

  // ---- 连接设置弹窗 ----
  const [settingOpen, setSettingOpen] = useState(false)
  const [formBase, setFormBase] = useState('')
  const [formToken, setFormToken] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  const timerRef = useRef<number | null>(null)

  /** 查询/统计/导出共用同一份条件，避免三处口径漂移 */
  const queryParams = useMemo<N9eQueryParams>(() => {
    const p: N9eQueryParams = {}
    if (days === -1 && customRange) {
      p.stime = customRange[0].startOf('day').unix()
      p.etime = customRange[1].endOf('day').unix()
    } else {
      p.days = days > 0 ? days : 90
    }
    if (groupIds.length > 0) p.groupIds = groupIds.join(',')
    if (datasourceIds.length > 0) p.datasourceIds = datasourceIds.join(',')
    if (severity !== undefined) p.severity = severity
    if (recovered >= 0) p.recovered = recovered
    if (department) p.department = department
    if (keyword.trim()) p.keyword = keyword.trim()
    return p
  }, [days, customRange, groupIds, datasourceIds, severity, recovered, department, keyword])

  // ---------- 加载 ----------
  const loadStats = useCallback(async () => {
    try {
      const s = await getN9eStats(queryParams)
      setStats(s)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '统计加载失败')
    }
  }, [queryParams])

  const loadRows = useCallback(
    async (p = page, ps = pageSize) => {
      setLoading(true)
      try {
        const r = await listN9eEvents({ ...queryParams, page: p, pageSize: ps })
        setRows(r.list || [])
        setTotal(r.total || 0)
      } catch (e) {
        message.error(e instanceof Error ? e.message : '查询失败')
      } finally {
        setLoading(false)
      }
    },
    [queryParams, page, pageSize],
  )

  const loadMeta = useCallback(async () => {
    try {
      const [cfg, gs, dp, ds] = await Promise.all([
        getN9eConfig(),
        listN9eGroups(),
        listN9eDepartments(),
        listN9eDatasources(),
      ])
      setConfig(cfg)
      setGroups(gs.list || [])
      setDepts(dp.departments || [])
      setDatasources(ds.list || [])
    } catch {
      // 元数据加载失败不阻塞主流程（例如首次进入还没有任何数据）
    }
  }, [])

  /** 条件变化 → 统计 + 列表都重算，并回到第 1 页 */
  useEffect(() => {
    setPage(1)
    void loadStats()
    void loadRows(1, pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryParams])

  useEffect(() => {
    void loadMeta()
  }, [loadMeta])

  useEffect(() => {
    void loadRows(page, pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize])

  // ---------- 同步进度轮询 ----------
  const pollSync = useCallback(async () => {
    try {
      const r = await getN9eSyncStatus()
      setSyncState(r.state)
      if (r.state.running) {
        if (timerRef.current === null) {
          timerRef.current = window.setInterval(() => {
            void pollSync()
          }, 2000)
        }
      } else {
        if (timerRef.current !== null) {
          window.clearInterval(timerRef.current)
          timerRef.current = null
        }
        if (r.state.phase === '完成') {
          // 同步完成后刷新页面数据
          void loadStats()
          void loadRows(1, pageSize)
          void loadMeta()
        }
      }
    } catch {
      // 轮询失败静默重试，不打扰用户
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadStats, loadRows, loadMeta, pageSize])

  useEffect(() => {
    void pollSync()
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- 操作 ----------
  const doSync = async () => {
    const d = days === -1 && customRange ? customRange[1].diff(customRange[0], 'day') + 1 : days
    const target = d > 90 ? 90 : d
    try {
      const r = await startN9eSync(target)
      if (!r.started) {
        message.warning(r.msg)
      } else {
        message.success(r.msg)
        setSyncState({
          running: true,
          phase: '准备中',
          days: target,
          fetched: 0,
          total: 0,
          chunkIndex: 0,
          chunkTotal: 0,
          startedAt: '',
          finishedAt: '',
          elapsedMs: 0,
          error: '',
        })
        void pollSync()
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '同步启动失败')
    }
  }

  const doExport = async () => {
    setExporting(true)
    try {
      const { blob, filename } = await exportN9eAlerts(queryParams)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      message.success(`已导出 ${total} 条记录`)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const openSetting = () => {
    setFormBase(config?.baseUrl || '')
    setFormToken('')
    setSettingOpen(true)
  }

  const doTest = async () => {
    setTesting(true)
    try {
      const r = await testN9eConfig({ baseUrl: formBase, token: formToken })
      message.success(r.msg)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '连接失败')
    } finally {
      setTesting(false)
    }
  }

  const doSave = async () => {
    setSaving(true)
    try {
      await saveN9eConfig({ baseUrl: formBase, token: formToken || undefined })
      message.success('已保存')
      setSettingOpen(false)
      void loadMeta()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // ---------- 图表 ----------
  const trendOption = useMemo(() => {
    const list = stats?.byDay || []
    return {
      grid: { left: 50, right: 20, top: 30, bottom: 50 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: list.map((d) => d.key),
        axisLabel: { rotate: list.length > 20 ? 45 : 0, fontSize: 10 },
      },
      yAxis: { type: 'value', name: '告警数' },
      series: [
        {
          type: 'line',
          smooth: true,
          showSymbol: false,
          areaStyle: { opacity: 0.15 },
          itemStyle: { color: '#1677ff' },
          data: list.map((d) => d.value),
        },
      ],
    }
  }, [stats])

  const severityOption = useMemo(() => {
    const list = (stats?.bySeverity || []).map((s) => ({
      name: severityText(Number(s.key)),
      value: s.value,
    }))
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0 },
      series: [
        {
          type: 'pie',
          radius: ['45%', '68%'],
          label: { formatter: '{b}\n{c}' },
          data: list.map((s) => ({
            ...s,
            itemStyle: {
              color: s.name === '严重' ? '#cf1322' : s.name === '警告' ? '#fa8c16' : '#1677ff',
            },
          })),
        },
      ],
    }
  }, [stats])

  // ---------- 明细表列 ----------
  const columns = useMemo(
    () => [
      {
        title: '触发时间',
        dataIndex: 'triggerTime',
        width: 165,
        render: (v: number) => fmtTime(v),
      },
      {
        title: '状态',
        dataIndex: 'isRecovered',
        width: 90,
        render: (v: number, r: N9eAlertEvent) =>
          v === 1 ? (
            <Tooltip title={`恢复于 ${fmtTime(r.recoverTime)}`}>
              <Tag color="green">已恢复</Tag>
            </Tooltip>
          ) : (
            <Tooltip title={`已持续 ${fmtDuration(Math.floor(Date.now() / 1000) - r.triggerTime)}`}>
              <Tag color="red">未恢复</Tag>
            </Tooltip>
          ),
      },
      {
        title: '等级',
        dataIndex: 'severity',
        width: 80,
        render: (v: number) => <Tag color={severityColor(v)}>{severityText(v)}</Tag>,
      },
      {
        title: '规则名称',
        dataIndex: 'ruleName',
        ellipsis: true,
        render: (v: string, r: N9eAlertEvent) => (
          <Tooltip title={r.ruleNote || v}>{v || '-'}</Tooltip>
        ),
      },
      {
        title: '目标主机',
        dataIndex: 'targetHost',
        width: 150,
        render: (v: string, r: N9eAlertEvent) => v || r.targetIdent || '-',
      },
      {
        title: '数据源',
        dataIndex: 'datasourceName',
        width: 170,
        ellipsis: true,
        render: (v: string, r: N9eAlertEvent) => v || (r.datasourceId ? `#${r.datasourceId}` : '-'),
      },
      { title: '业务组', dataIndex: 'groupName', width: 160, ellipsis: true },
      { title: '部门', dataIndex: 'department', width: 150, ellipsis: true, render: (v: string) => v || '-' },
      { title: '系统', dataIndex: 'systemName', width: 140, ellipsis: true, render: (v: string) => v || '-' },
      { title: '触发值', dataIndex: 'triggerValue', width: 90, render: (v: string) => v || '-' },
      { title: '通知次数', dataIndex: 'notifyCurNumber', width: 90 },
    ],
    [],
  )

  /** 简单的 TOP 榜（条数 + 占比条） */
  const renderTopList = (list: { key: string; value: number }[], color: string) => {
    const max = list.length > 0 ? list[0].value : 1
    if (list.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无数据" />
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.map((it) => (
          <div key={it.key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <Text ellipsis style={{ maxWidth: '72%' }}>
                {it.key}
              </Text>
              <Text strong>{it.value}</Text>
            </div>
            <Progress
              percent={max > 0 ? Math.round((it.value / max) * 100) : 0}
              showInfo={false}
              size="small"
              strokeColor={color}
            />
          </div>
        ))}
      </div>
    )
  }

  const hasData = (config?.syncedRows || 0) > 0
  const syncing = syncState?.running === true

  return (
    <div style={{ padding: 16 }}>
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          <AlertOutlined style={{ marginRight: 8 }} />
          监控告警报表
        </Title>
        <Tag color="purple">v1.7.50</Tag>
        <Tooltip title="数据来源：夜莺（Nightingale）历史告警">
          <Tag color="geekblue">{config?.baseUrl || '未配置'}</Tag>
        </Tooltip>
        <div style={{ flex: 1 }} />
        <Space>
          {hasPerm('prom:alert:update') && (
            <Button icon={<SettingOutlined />} onClick={openSetting}>
              连接设置
            </Button>
          )}
          {hasPerm('prom:alert:sync') && (
            <Button icon={<SyncOutlined spin={syncing} />} loading={syncing} onClick={doSync}>
              同步数据
            </Button>
          )}
          {hasPerm('prom:alert:export') && (
            <Button
              type="primary"
              icon={<CloudDownloadOutlined />}
              loading={exporting}
              disabled={!hasData || total === 0}
              onClick={doExport}
            >
              导出 Excel
            </Button>
          )}
        </Space>
      </div>

      {/* 数据新鲜度提示 —— 页面上所有查询都基于本地已同步数据，必须说清楚 */}
      <Alert
        type={hasData ? 'info' : 'warning'}
        showIcon
        style={{ marginBottom: 12 }}
        message={
          hasData ? (
            <span>
              本地已缓存 <b>{config?.syncedRows?.toLocaleString()}</b> 条告警，最后同步时间{' '}
              <b>{config?.lastSyncAt || '未知'}</b>；查询与统计基于本地缓存。
              {hasPerm('prom:alert:sync') && '看不到最新告警时请点「同步数据」。'}
            </span>
          ) : (
            <span>
              本地还没有数据。{hasPerm('prom:alert:sync') ? '请先点右上角「同步数据」' : '请联系管理员执行一次同步'}
              —— 90 天全量同步约需 1~2 分钟。
            </span>
          )
        }
      />

      {/* 同步进度 */}
      {syncing && syncState && (
        <Card size="small" style={{ marginBottom: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }} size={4}>
            <Space>
              <Spin size="small" />
              <Text strong>{syncState.phase}</Text>
              <Text type="secondary">
                已拉取 {syncState.fetched.toLocaleString()}
                {syncState.total > 0 ? ` / ${syncState.total.toLocaleString()}` : ''} 条
              </Text>
            </Space>
            <Progress
              percent={
                syncState.total > 0
                  ? Math.min(99, Math.floor((syncState.fetched / syncState.total) * 100))
                  : syncState.chunkTotal > 0
                    ? Math.floor((syncState.chunkIndex / syncState.chunkTotal) * 100)
                    : 0
              }
              status="active"
              size="small"
            />
          </Space>
        </Card>
      )}

      {/* 同步失败 */}
      {!syncing && syncState?.error && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message="上次同步失败" description={syncState.error} />
      )}

      {/* 筛选 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={[12, 8]}>
          <Segmented
            value={days}
            options={RANGE_OPTIONS}
            onChange={(v) => {
              setDays(v as number)
              if (v !== -1) setCustomRange(null)
            }}
          />
          {days === -1 && (
            <DatePicker.RangePicker
              value={customRange}
              onChange={(v) => setCustomRange(v as [Dayjs, Dayjs] | null)}
              disabledDate={(d) => d && d.isAfter(dayjs(), 'day')}
            />
          )}
          <Select
            mode="multiple"
            allowClear
            placeholder="数据源"
            style={{ minWidth: 220 }}
            maxTagCount="responsive"
            value={datasourceIds}
            onChange={setDatasourceIds}
            notFoundContent={
              hasData ? '暂无可选数据源（需重新同步一次以补全该字段）' : '本地无数据，请先同步'
            }
            options={datasources.map((d) => ({
              label: `${d.datasourceName || `#${d.datasourceId}`} (${d.n})`,
              value: d.datasourceId,
            }))}
          />
          <Select
            mode="multiple"
            allowClear
            placeholder="业务组"
            style={{ minWidth: 200 }}
            maxTagCount="responsive"
            value={groupIds}
            onChange={setGroupIds}
            options={groups.map((g) => ({ label: `${g.groupName} (${g.n})`, value: g.groupId }))}
          />
          <Select
            allowClear
            placeholder="告警等级"
            style={{ width: 120 }}
            value={severity}
            onChange={setSeverity}
            options={SEVERITY_OPTIONS}
          />
          <Select
            style={{ width: 110 }}
            value={recovered}
            onChange={setRecovered}
            options={RECOVER_OPTIONS}
          />
          <Select
            allowClear
            showSearch
            placeholder="部门"
            style={{ width: 160 }}
            value={department}
            onChange={setDepartment}
            options={depts.map((d) => ({ label: `${d.value} (${d.n})`, value: d.value }))}
          />
          <Input.Search
            allowClear
            placeholder="规则 / 主机 / 业务组关键字"
            style={{ width: 240 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={() => setKeyword(keyword)}
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              void loadStats()
              void loadRows(page, pageSize)
            }}
          >
            刷新
          </Button>
        </Space>
      </Card>

      {/* 统计概览 */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="告警总数" value={stats?.total || 0} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="未恢复"
              value={stats?.unresolved || 0}
              valueStyle={{ color: (stats?.unresolved || 0) > 0 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="涉及主机" value={stats?.hostCount || 0} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="涉及规则" value={stats?.ruleCount || 0} />
          </Card>
        </Col>
      </Row>

      {/* 图表 */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={16}>
          <Card size="small" title="告警趋势（按天）">
            <ReactECharts
              option={trendOption}
              style={{ height: 240 }}
              notMerge
              lazyUpdate
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small" title="等级分布">
            <ReactECharts option={severityOption} style={{ height: 240 }} notMerge lazyUpdate />
          </Card>
        </Col>
      </Row>

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={8}>
          <Card size="small" title="业务组 TOP10">
            {renderTopList(stats?.byGroup || [], '#1677ff')}
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small" title="告警规则 TOP10">
            {renderTopList(stats?.byRule || [], '#fa8c16')}
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small" title="部门 TOP10">
            {renderTopList(stats?.byDept || [], '#52c41a')}
          </Card>
        </Col>
      </Row>

      {/* 明细 */}
      <Card
        size="small"
        title={`告警明细（${total.toLocaleString()} 条）`}
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            导出 Excel 会导出当前筛选条件下的全部 {total.toLocaleString()} 条
          </Text>
        }
      >
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={rows}
          scroll={{ x: 1620 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: ['20', '50', '100'],
            showTotal: (t) => `共 ${t.toLocaleString()} 条`,
            onChange: (p, ps) => {
              setPage(p)
              setPageSize(ps)
            },
          }}
        />
      </Card>

      {/* 连接设置 */}
      <Modal
        open={settingOpen}
        title="夜莺连接设置"
        onCancel={() => setSettingOpen(false)}
        onOk={doSave}
        confirmLoading={saving}
        okText="保存"
        width={560}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text strong>夜莺地址</Text>
            <Input
              style={{ marginTop: 4 }}
              placeholder="http://n9e.internal.example:9999"
              value={formBase}
              onChange={(e) => setFormBase(e.target.value)}
            />
          </div>
          <div>
            <Text strong>API Token</Text>
            <Input.Password
              style={{ marginTop: 4 }}
              placeholder={config?.hasToken ? `已配置（${config.tokenMask}），留空表示不修改` : '请输入夜莺 API Token'}
              value={formToken}
              onChange={(e) => setFormToken(e.target.value)}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              在夜莺「个人中心 → 密钥管理」生成；平台以请求头 X-User-Token 调用夜莺接口。
            </Text>
          </div>
          <Space>
            <Button loading={testing} onClick={doTest}>
              测试连接
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              测试直接用上面填写的值，不要求先保存
            </Text>
          </Space>
        </Space>
      </Modal>
    </div>
  )
}
