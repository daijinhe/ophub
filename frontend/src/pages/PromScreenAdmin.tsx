import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Radio,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  AlertOutlined,
  AppstoreOutlined,
  BarChartOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  CloudServerOutlined,
  ContainerOutlined,
  DashboardOutlined,
  DeleteOutlined,
  EyeOutlined,
  FireOutlined,
  FundOutlined,
  EyeInvisibleOutlined,
  HddOutlined,
  InfoCircleOutlined,
  PieChartOutlined,
  PlusOutlined,
  ReloadOutlined,
  RiseOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import {
  getPromScreenConfig,
  promCollectNow,
  savePromScreenConfig,
  type PromCollectStatus,
  type PromMaskMode,
  type PromMaskRule,
  type PromRiskLevel,
  type PromScreenConfig,
  type PromScreenConfigResp,
} from '../api/prometheus'
import {
  PROM_PANELS,
  PROM_PANEL_COL_CN,
  PROM_PANEL_GROUP_CN,
  promPanelsFill,
  promPanelsOfCol,
  promPanelsOfGroup,
  type PromPanelCol,
  type PromPanelGroup,
  type PromPanelKey,
} from '../utils/promPanels'

const { Title, Text, Paragraph } = Typography

function errMsg(e: any, fallback = '操作失败'): string {
  return e?.response?.data?.msg || e?.message || fallback
}

/** 采集间隔候选（秒）：从 10 秒到 30 分钟，覆盖「秒级盯屏」到「日常巡检」 */
const INTERVAL_OPTIONS = [
  { value: 10, label: '10 秒' },
  { value: 30, label: '30 秒' },
  { value: 60, label: '1 分钟' },
  { value: 120, label: '2 分钟' },
  { value: 300, label: '5 分钟' },
  { value: 600, label: '10 分钟' },
  { value: 1800, label: '30 分钟' },
]

const GROUP_BY_OPTIONS = [
  { value: 'system', label: '项目名（system）' },
  { value: 'department', label: '所属部门（department）' },
  { value: 'env', label: '环境（env）' },
  { value: 'deployserver', label: '业务环境（deployserver）' },
]

/**
 * 屏蔽规则的指标口径（v1.7.42 起同口径作用于「风险项清单 + 对应指标负载榜」）。
 * 顺序 = 常见程度，`net` 是 v1.7.42 补的 —— 在此之前想屏蔽主机在「网络负载 TOP」上的出现，
 * 只能选「全部指标」，会连带把 CPU / 内存 / 磁盘 三个榜和告警项一起屏蔽掉。
 */
const METRIC_OPTIONS = [
  { value: 'all', label: '全部指标' },
  { value: 'cpu', label: 'CPU' },
  { value: 'mem', label: '内存' },
  { value: 'disk', label: '磁盘' },
  { value: 'net', label: '网络' },
  { value: 'offline', label: '连通性（离线）' },
]

const SOURCE_CN: Record<string, string> = {
  auto: '自动采集',
  manual: '手动触发',
  restore: '重启恢复',
  realtime: '实时现算',
}

/** 面板图标（纯展示，键与 PROM_PANELS 对齐） */
const PANEL_ICON: Record<PromPanelKey, React.ReactNode> = {
  capacity: <ContainerOutlined />,
  kpiTarget: <CloudServerOutlined />,
  kpiOnline: <DashboardOutlined />,
  kpiIssue: <AlertOutlined />,
  kpiDisk: <HddOutlined />,
  kpiProject: <FundOutlined />,
  osDist: <AppstoreOutlined />,
  gauges: <DashboardOutlined />,
  topCpu: <FireOutlined />,
  topMem: <FireOutlined />,
  topDisk: <FireOutlined />,
  topNet: <FireOutlined />,
  hostBars: <BarChartOutlined />,
  healthDist: <PieChartOutlined />,
  trend: <RiseOutlined />,
  alerts: <AlertOutlined />,
  alertLevel: <PieChartOutlined />,
  alertTrend: <RiseOutlined />,
  hostScroll: <CloudServerOutlined />,
  footer: <InfoCircleOutlined />,
}

const TAB_KEYS: PromPanelCol[] = ['left', 'mid', 'right', 'footer']

/** 屏蔽规则行（表格编辑用，_k 是本地稳定 key，不提交给后端） */
type MaskRow = PromMaskRule & { _k: string }
let maskSeq = 0
const nextMaskKey = () => `m${Date.now().toString(36)}${(maskSeq++).toString(36)}`

/**
 * Prometheus 监控大屏 · 管理（v1.7.33 → v1.7.42）
 *
 * 一个页面管完大屏的「展示什么、放过谁、怎么判、多久采一次」：
 *   ① 展示内容：大屏标题、面板开关（左/中/右/底 逐格可控）、TOP N、主机列表上限、趋势窗口、离线主机；
 *   ② 风险与屏蔽：风险项等级口径（全部/仅严重/仅关注）× 规则模式（黑名单/白名单）+ 规则明细；
 *   ③ 阈值与采集：CPU/内存/磁盘 判级阈值、网络参考带宽、自动采集开关与间隔、各数据源立即采集。
 *
 * ⚠️ 全页只有一个「保存配置」按钮：三个页签的字段**一起提交**。
 * 这是 v1.7.36 的教训 —— 当时屏蔽规则是独立菜单、只提交 masks，保存一次会把标题/间隔/阈值
 * 全部打回默认值（后端为此加了「非零才覆盖」防护，但根因是「一页只提交一页的字段」这个设计）。
 * 现在字段少传依然安全（后端保持原值），但页面上只留一个保存入口，避免用户在不同页签里各自保存。
 *
 * ⚠️ 页签必须 forceRender：antd Tabs 默认懒挂载，没打开过的页签里的 Form.Item 不会注册，
 * 保存时 validateFields() 拿不到那些字段 —— 表现是「阈值校验失效 + 值提交不上去」。
 */
export default function PromScreenAdmin() {
  const [cfg, setCfg] = useState<PromScreenConfig | null>(null)
  const [status, setStatus] = useState<PromCollectStatus[]>([])
  const [nextAt, setNextAt] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [collectingId, setCollectingId] = useState<number | null>(null)
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  // 页签与 URL 同步（v1.7.43）：「被屏蔽目标」页的「屏蔽规则配置」按钮要能直接落到本页的
  // 风险页签（/prom/screen-admin?tab=risk）。非法值一律落回默认页签 —— 否则手改 URL 会
  // 出现「三个页签一个都没选中」的空白 Tabs。
  const [tab, setTab] = useState<string>(() => {
    const t = sp.get('tab')
    return t === 'risk' || t === 'collect' ? t : 'content'
  })
  const switchTab = (k: string) => {
    setTab(k)
    const next = new URLSearchParams(sp)
    if (k === 'content') next.delete('tab')
    else next.set('tab', k)
    setSp(next, { replace: true })
  }
  const [form] = Form.useForm()
  const [tick, setTick] = useState(0)

  // 非表单字段（面板开关 / 规则明细）单独用 state 管，保存时与表单值合并提交
  const [panels, setPanels] = useState<Record<PromPanelKey, boolean>>(() => promPanelsFill(null))
  const [masks, setMasks] = useState<MaskRow[]>([])
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r: PromScreenConfigResp = await getPromScreenConfig()
      setCfg(r.config)
      setStatus(r.status || [])
      setNextAt(r.nextAt || 0)
      form.setFieldsValue(r.config)
      setPanels(promPanelsFill(r.config.panels))
      setMasks((r.config.masks || []).map((m) => ({ ...m, _k: nextMaskKey() })))
      setDirty(false)
    } catch (e) {
      message.error('加载大屏配置失败：' + errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [form])

  useEffect(() => {
    load()
  }, [load])

  // 采集状态每 5 秒自刷新（自动采集开着时能看见时间在动）
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 5000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (tick === 0) return
    getPromScreenConfig()
      .then((r) => {
        setStatus(r.status || [])
        setNextAt(r.nextAt || 0)
      })
      .catch(() => undefined)
  }, [tick])

  const onSave = useCallback(async () => {
    let vals: any
    try {
      vals = await form.validateFields()
    } catch {
      // 校验失败时**自动跳到出错字段所在的页签**：三个页签都可能藏必填项，
      // 不跳的话用户只看到顶部飘一条 warning，却不知道该翻到哪儿改。
      const bad = form.getFieldsError().find((f) => f.errors.length > 0)?.name?.[0] as string | undefined
      if (bad === 'riskLevel' || bad === 'maskMode') setTab('risk')
      else if (bad === 'title' || bad === 'groupBy' || bad === 'topN' || bad === 'hostLimit' || bad === 'trendHours' || bad === 'showOffline') setTab('content')
      else setTab('collect')
      message.warning('请先修正表单中的错误项')
      return
    }
    setSaving(true)
    try {
      // 面板开关只提交「被关掉」的键 —— 与后端「表里没有的键 = 展示」的语义一致，
      // 全部打开时提交 {}，配置 JSON 保持干净。
      const panelOff: Record<string, boolean> = {}
      for (const p of PROM_PANELS) {
        if (!panels[p.key]) panelOff[p.key] = false
      }
      const r = await savePromScreenConfig({
        ...vals,
        autoCollect: vals.autoCollect ? 1 : 0,
        showOffline: vals.showOffline ? 1 : 0,
        panels: panelOff,
        masks: masks
          .map((m) => ({ target: (m.target || '').trim(), metric: m.metric, note: (m.note || '').trim() }))
          .filter((m) => m.target !== ''), // 空 target 后端会丢，这里先过滤掉免得用户以为存上了
      })
      message.success(r.msg || '已保存')
      setCfg(r.config)
      await load()
    } catch (e) {
      message.error('保存失败：' + errMsg(e))
    } finally {
      setSaving(false)
    }
  }, [form, load, masks, panels])

  const onCollect = useCallback(
    async (id: number) => {
      setCollectingId(id)
      const started = Date.now()
      try {
        const r = await promCollectNow(id)
        message.success(`${r.msg}：${r.hosts} 台主机，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
        load()
      } catch (e) {
        message.error('采集失败：' + errMsg(e))
      } finally {
        setCollectingId(null)
      }
    },
    [load],
  )

  const remainSec = useMemo(() => {
    if (!nextAt) return 0
    return Math.max(0, Math.round((nextAt * 1000 - Date.now()) / 1000))
  }, [nextAt, tick])

  const watched = Form.useWatch('intervalSec', form) ?? cfg?.intervalSec ?? 60
  const watchedAuto = Form.useWatch('autoCollect', form)
  const autoOn = watchedAuto === undefined ? cfg?.autoCollect === 1 : !!watchedAuto

  // 风险与屏蔽页签的实时表单值（用于即时提示，不必等保存）
  const watchedRisk = (Form.useWatch('riskLevel', form) as PromRiskLevel) ?? cfg?.riskLevel ?? 'all'
  const watchedMode = (Form.useWatch('maskMode', form) as PromMaskMode) ?? cfg?.maskMode ?? 'blacklist'
  const validMaskCount = masks.filter((m) => (m.target || '').trim() !== '').length
  // 白名单 + 一条规则都没有 = 大屏上一条风险项都不会出现。这在保存前就必须拦住（结果与直觉完全相反）。
  const whitelistEmpty = watchedMode === 'whitelist' && validMaskCount === 0

  const offCount = PROM_PANELS.filter((p) => !panels[p.key]).length

  const statusColumns = useMemo(
    () => [
      { title: '数据源', dataIndex: 'name', key: 'name', width: 180, render: (v: string) => <b>{v}</b> },
      {
        title: '状态',
        key: 'state',
        width: 100,
        render: (_: any, r: PromCollectStatus) => {
          if (r.busy) return <Tag color="processing">采集中</Tag>
          if (!r.ready) return <Tag color="default">未采集</Tag>
          return r.msg ? <Tag color="warning">上次失败</Tag> : <Tag color="success">正常</Tag>
        },
      },
      { title: '最近采集时间', dataIndex: 'generatedAt', key: 'generatedAt', width: 170, render: (v: string) => v || '—' },
      { title: '耗时', dataIndex: 'collectMs', key: 'collectMs', width: 90, render: (v: number) => (v ? `${v} ms` : '—') },
      {
        title: '主机数',
        dataIndex: 'hosts',
        key: 'hosts',
        width: 80,
        render: (v: number, r: PromCollectStatus) => (r.ready ? `${v} 台` : '—'),
      },
      { title: '来源', dataIndex: 'source', key: 'source', width: 100, render: (v: string) => SOURCE_CN[v] || v || '—' },
      {
        title: '说明',
        dataIndex: 'msg',
        key: 'msg',
        ellipsis: true,
        render: (v: string) => (v ? <Text type="danger">{v}</Text> : <Text type="secondary">—</Text>),
      },
      {
        title: '操作',
        key: 'op',
        width: 110,
        render: (_: any, r: PromCollectStatus) => (
          <Button size="small" icon={<CloudDownloadOutlined />} loading={collectingId === r.id} onClick={() => onCollect(r.id)}>
            立即采集
          </Button>
        ),
      },
    ],
    [collectingId, onCollect],
  )

  /* ---------------- 面板开关操作 ---------------- */
  const setPanel = (k: PromPanelKey, v: boolean) => {
    setPanels((cur) => {
      // ⚠️ 不能写成 {...cur, [k]: v}：那会退化成索引签名，TS 丢掉键的联合类型
      const next = { ...cur } as Record<PromPanelKey, boolean>
      next[k] = v
      return next
    })
    setDirty(true)
  }
  const setCol = (col: PromPanelCol, v: boolean) => {
    setPanels((cur) => {
      const next = { ...cur } as Record<PromPanelKey, boolean>
      for (const p of promPanelsOfCol(col)) next[p.key] = v
      return next
    })
    setDirty(true)
  }
  const setGroup = (group: PromPanelGroup, v: boolean) => {
    setPanels((cur) => {
      const next = { ...cur } as Record<PromPanelKey, boolean>
      for (const p of promPanelsOfGroup(group)) next[p.key] = v
      return next
    })
    setDirty(true)
  }
  const setAll = (v: boolean) => {
    setPanels((cur) => {
      const next = { ...cur } as Record<PromPanelKey, boolean>
      for (const p of PROM_PANELS) next[p.key] = v
      return next
    })
    setDirty(true)
  }

  /* ---------------- 屏蔽规则操作 ---------------- */
  const addMask = () => {
    setMasks((cur) => [...cur, { _k: nextMaskKey(), target: '', metric: 'all', note: '' }])
    setDirty(true)
  }
  const patchMask = (k: string, patch: Partial<PromMaskRule>) => {
    setMasks((cur) => cur.map((m) => (m._k === k ? { ...m, ...patch } : m)))
    setDirty(true)
  }
  const delMask = (k: string) => {
    setMasks((cur) => cur.filter((m) => m._k !== k))
    setDirty(true)
  }

  const maskColumns = useMemo(
    () => [
      {
        title: '匹配目标（主机展示名 / IP，包含匹配，不区分大小写）',
        dataIndex: 'target',
        key: 'target',
        render: (_: any, r: MaskRow) => (
          <Input
            size="small"
            value={r.target}
            placeholder="例如：订单系统_生产 或 192.168.10."
            onChange={(e) => patchMask(r._k, { target: e.target.value })}
          />
        ),
      },
      {
        title: '指标',
        dataIndex: 'metric',
        key: 'metric',
        width: 150,
        render: (_: any, r: MaskRow) => (
          <Select
            size="small"
            value={r.metric}
            options={METRIC_OPTIONS}
            style={{ width: '100%' }}
            onChange={(v) => patchMask(r._k, { metric: v })}
          />
        ),
      },
      {
        title: '备注',
        dataIndex: 'note',
        key: 'note',
        width: 240,
        render: (_: any, r: MaskRow) => (
          <Input
            size="small"
            value={r.note}
            placeholder="选填，例如：测试机不上屏"
            onChange={(e) => patchMask(r._k, { note: e.target.value })}
          />
        ),
      },
      {
        title: '操作',
        key: 'op',
        width: 70,
        render: (_: any, r: MaskRow) => (
          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => delMask(r._k)} />
        ),
      },
    ],
    // patchMask / delMask 是稳定的闭包（只用 setState 的函数式更新），无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <Title level={4} style={{ margin: 0 }}>
          <SettingOutlined style={{ marginRight: 8 }} />
          监控大屏管理
        </Title>
        <Tag color="purple">v1.7.44</Tag>
        {dirty && <Tag color="warning">有未保存的修改</Tag>}
        {offCount > 0 && !dirty && <Tag color="default">{offCount} 个面板已关闭</Tag>}
        <Space style={{ marginLeft: 'auto' }}>
          {/* 被屏蔽明细（v1.7.43 起不再单占侧边栏菜单，入口收在这里）：放在**页头**而不是
              「风险与屏蔽」页签里，切到别的页签时也能一键进去看『我到底把什么藏起来了』。 */}
          <Button icon={<EyeInvisibleOutlined />} onClick={() => navigate('/prom/hidden')}>
            被屏蔽明细
          </Button>
          <Button icon={<EyeOutlined />} onClick={() => window.open('/prom/screen', '_blank')}>
            预览大屏
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            重新加载
          </Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={onSave} loading={saving}>
            保存配置
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="这里是大屏的「总开关」：展示哪些面板、放过哪些风险项、按什么阈值判级、多久采一次"
        description={
          <div>
            大屏只读服务端定期采集的快照，改完保存后<b>面板显隐与风险过滤立即生效</b>，阈值 / 间隔下一轮采集生效。
            采集频率可按需要从 <b>10 秒</b> 到 <b>30 分钟</b> 调整；{autoOn ? (
              <>当前每 <b>{watched}</b> 秒自动采集一次{remainSec > 0 && <>，下次采集约 <b>{remainSec}</b> 秒后</>}。</>
            ) : (
              <>当前<b>自动采集已关闭</b>，只有手动触发才会更新大屏。</>
            )}
          </div>
        }
      />

      <Form
        form={form}
        layout="vertical"
        initialValues={cfg || undefined}
        onValuesChange={() => setDirty(true)}
      >
        <Tabs
          activeKey={tab}
          onChange={switchTab}
          items={[
            /* ==================== ① 展示内容 ==================== */
            {
              key: 'content',
              label: (
                <span>
                  <AppstoreOutlined /> 展示内容
                  {offCount > 0 && <Tag style={{ marginLeft: 6 }} color="default">{offCount} 项已隐藏</Tag>}
                </span>
              ),
              forceRender: true,
              children: (
                <>
                  <Card size="small" style={{ marginBottom: 12 }} title="标题与分组">
                    <Row gutter={12}>
                      <Col xs={24} md={12}>
                        <Form.Item label="大屏标题" name="title" rules={[{ required: true, message: '请填写大屏标题' }]}>
                          <Input placeholder="Prometheus 监控大屏" maxLength={32} showCount />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={12}>
                        <Form.Item
                          label="分组维度"
                          name="groupBy"
                          tooltip="「项目水位 TOP」等按维度聚合的口径；关掉相关面板后此项无影响"
                        >
                          <Select options={GROUP_BY_OPTIONS} />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={12}>
                      <Col xs={12} md={6}>
                        <Form.Item label="TOP N" name="topN" tooltip="四个负载榜（CPU / 内存 / 磁盘 / 网络）各展示多少条">
                          <InputNumber min={3} max={20} precision={0} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={6}>
                        <Form.Item
                          label="主机列表上限"
                          name="hostLimit"
                          tooltip="大屏「主机实时资源」最多展示多少台（离线优先、其余按水位降序）"
                        >
                          <InputNumber min={20} max={5000} step={50} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={6}>
                        <Form.Item
                          label="趋势窗口（小时）"
                          name="trendHours"
                          tooltip="大屏趋势图回看多久；步长会自动匹配，点数恒定"
                        >
                          <InputNumber min={1} max={720} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={6}>
                        <Form.Item
                          label="展示离线主机"
                          name="showOffline"
                          valuePropName="checked"
                          tooltip="关闭后离线主机不再出现在「主机实时资源」列表里（风险项里的离线连通性仍会保留）"
                        >
                          <Switch checkedChildren="展示" unCheckedChildren="隐藏" />
                        </Form.Item>
                      </Col>
                    </Row>
                  </Card>

                  <Card
                    size="small"
                    title={<span><AppstoreOutlined /> 面板显示开关</span>}
                    extra={
                      <Space size={4}>
                        <Button size="small" onClick={() => setAll(true)}>
                          全部展开
                        </Button>
                        <Button size="small" onClick={() => setAll(false)}>
                          全部收起
                        </Button>
                      </Space>
                    }
                  >
                    <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>
                      关掉的面板<b>不会再出现在大屏上</b>，同一栏里剩下的面板会自动接管它的高度（不会留空白）。
                      大屏版面为固定 1080 高，关掉越多、剩余面板越高。
                      <br />
                      这里管的是<b>整块榜要不要上屏</b>；榜里显示<b>哪些主机</b>由「风险与屏蔽」的规则按指标决定。
                    </Paragraph>
                    {TAB_KEYS.map((col) => {
                      const list = promPanelsOfCol(col)
                      const onCnt = list.filter((p) => panels[p.key]).length
                      return (
                        <div key={col} style={{ marginBottom: 8 }}>
                          <Divider orientation="left" plain style={{ margin: '4px 0 10px' }}>
                            {PROM_PANEL_COL_CN[col]}
                            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                              {onCnt}/{list.length} 已展示
                            </Text>
                            <Space size={4} style={{ marginLeft: 12 }}>
                              <Button size="small" type="link" onClick={() => setCol(col, true)}>
                                全开
                              </Button>
                              <Button size="small" type="link" onClick={() => setCol(col, false)}>
                                全关
                              </Button>
                            </Space>
                          </Divider>
                          <Row gutter={[12, 8]}>
                            {list.map((p, i) => {
                              // 组的第一项前面插一条组头（带组级全开/全关），让「四个负载榜是一组」看得见
                              const groupStart = !!p.group && p.group !== list[i - 1]?.group
                              const gList = p.group ? promPanelsOfGroup(p.group) : []
                              const gOn = gList.filter((x) => panels[x.key]).length
                              return (
                                <Fragment key={p.key}>
                                  {groupStart && (
                                    <Col span={24}>
                                      <div
                                        data-panel-group={p.group}
                                        style={{
                                          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                                          margin: '2px 0 0', padding: '5px 10px', borderRadius: 6,
                                          background: 'rgba(250,140,22,0.06)',
                                          borderLeft: '3px solid #fa8c16',
                                        }}
                                      >
                                        <FireOutlined style={{ color: '#fa8c16' }} />
                                        <span style={{ fontSize: 12, fontWeight: 600 }}>{PROM_PANEL_GROUP_CN[p.group!]}</span>
                                        <Text type="secondary" style={{ fontSize: 11 }}>
                                          整块开关看这里；榜里显示哪些主机由「风险与屏蔽」的规则按指标决定
                                        </Text>
                                        <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
                                          {gOn}/{gList.length} 已展示
                                        </Text>
                                        <Button size="small" type="link" onClick={() => setGroup(p.group!, true)}>
                                          全开
                                        </Button>
                                        <Button size="small" type="link" onClick={() => setGroup(p.group!, false)}>
                                          全关
                                        </Button>
                                      </div>
                                    </Col>
                                  )}
                                  <Col xs={24} md={12} xxl={8}>
                                    <div
                                      data-panel={p.key}
                                      data-panel-on={panels[p.key] ? '1' : '0'}
                                      style={{
                                        display: 'flex', alignItems: 'center', gap: 8,
                                        padding: '6px 10px', borderRadius: 6,
                                        border: `1px solid ${panels[p.key] ? 'rgba(22,119,255,0.25)' : 'rgba(0,0,0,0.08)'}`,
                                        background: panels[p.key] ? 'rgba(22,119,255,0.04)' : 'rgba(0,0,0,0.02)',
                                      }}
                                    >
                                      <span style={{ fontSize: 14, color: panels[p.key] ? '#1677ff' : '#bfbfbf' }}>
                                        {PANEL_ICON[p.key]}
                                      </span>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 13 }}>{p.label}</div>
                                        <div style={{ fontSize: 11, color: '#8c8c8c', lineHeight: 1.4 }}>{p.desc}</div>
                                      </div>
                                      <Switch size="small" checked={panels[p.key]} onChange={(v) => setPanel(p.key, v)} />
                                    </div>
                                  </Col>
                                </Fragment>
                              )
                            })}
                          </Row>
                        </div>
                      )
                    })}
                    {offCount === PROM_PANELS.length && (
                      <Alert
                        type="warning"
                        showIcon
                        style={{ marginTop: 8 }}
                        message="所有面板都已关闭"
                        description="大屏会显示一句引导文案而不是任何数据。如果只想投屏一小块信息，保留「实时告警列表」等必要面板即可。"
                      />
                    )}
                  </Card>
                </>
              ),
            },

            /* ==================== ② 风险与屏蔽 ==================== */
            {
              key: 'risk',
              label: (
                <span>
                  <SafetyCertificateOutlined /> 风险与屏蔽
                  {validMaskCount > 0 && <Tag style={{ marginLeft: 6 }} color="blue">{validMaskCount} 条规则</Tag>}
                </span>
              ),
              forceRender: true,
              children: (
                <>
                  <Card size="small" style={{ marginBottom: 12 }} title="风险项等级口径">
                    <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>
                      控制「哪一档风险」允许上屏。被排除的项<b>既不进告警清单也不进 KPI 统计</b>，
                      所以大屏上的数字与这里的口径始终一致。
                    </Paragraph>
                    <Form.Item name="riskLevel" style={{ marginBottom: 0 }}>
                      <Radio.Group>
                        <Radio.Button value="all">全部（严重 + 关注）</Radio.Button>
                        <Radio.Button value="crit">仅严重</Radio.Button>
                        <Radio.Button value="warn">仅关注</Radio.Button>
                      </Radio.Group>
                    </Form.Item>
                    <div style={{ marginTop: 8, fontSize: 12, color: '#8c8c8c' }}>
                      {watchedRisk === 'all' && '默认：所有超阈值项与离线项都上屏，信息最全。'}
                      {watchedRisk === 'crit' && '只把「严重」推上大屏；「关注」级项完全隐藏，适合对外投屏时只暴露真问题。'}
                      {watchedRisk === 'warn' && '只看「关注」级项（预警苗头）；「严重」级项会被隐藏 —— 一般用于「黄灯追因」场景。'}
                    </div>
                  </Card>

                  <Card
                    size="small"
                    title="屏蔽规则"
                    extra={
                      <Space size={4}>
                        {/* v1.7.43：屏蔽完必须能「看得见自己屏蔽了什么」，否则等于把风险藏起来没人管 */}
                        <Button size="small" icon={<EyeInvisibleOutlined />} onClick={() => navigate('/prom/hidden')}>
                          被屏蔽明细
                        </Button>
                        <Button size="small" icon={<PlusOutlined />} onClick={addMask}>
                          添加规则
                        </Button>
                        <Button
                          size="small"
                          icon={<DeleteOutlined />}
                          disabled={masks.length === 0}
                          onClick={() => {
                            setMasks([])
                            setDirty(true)
                          }}
                        >
                          清空
                        </Button>
                      </Space>
                    }
                  >
                    <Form.Item name="maskMode" style={{ marginBottom: 12 }}>
                      <Radio.Group>
                        <Radio.Button value="blacklist">黑名单 · 命中即隐藏</Radio.Button>
                        <Radio.Button value="whitelist">白名单 · 只展示命中的</Radio.Button>
                      </Radio.Group>
                    </Form.Item>
                    <div style={{ marginBottom: 12, fontSize: 12, color: '#8c8c8c' }}>
                      {watchedMode === 'blacklist'
                        ? '默认：命中规则的主机（按规则选的指标）不出现在大屏上。适合「个别测试机 / 噪音指标不上屏」。'
                        : '白名单：大屏上只保留命中规则的主机与指标，其余一律不展示。适合「大屏只盯指定几台机器」—— 写一条「全部指标」的规则即可把四个负载榜与告警项一起收窄。'}
                      <br />
                      规则按<b>指标</b>精确生效：选 <Text code>CPU</Text> 就同时管「CPU 告警项」与「CPU 负载 TOP N」；
                      选 <Text code>网络</Text> 只影响网络维度（<Text code>网络</Text> 这档是 v1.7.42 新增的）。
                      选<b>全部指标</b>则该主机在四个负载榜与告警项里都按规则处理。
                      <br />
                      等级口径与规则模式<b>同时生效</b>：先按等级筛，再按规则命中与否决定去留。
                      等级口径只作用于风险项，<b>不筛负载榜</b> —— 榜单是按用量排的，按告警等级筛会把它变成「风险项换个形状」。
                    </div>

                    {whitelistEmpty && (
                      <Alert
                        type="error"
                        showIcon
                        style={{ marginBottom: 12 }}
                        message="白名单模式 + 没有任何规则 = 大屏上的风险项会被全部隐藏"
                        description="至少添加一条规则（比如 target 填一个项目名），否则「实时告警列表」会一直是空的。"
                      />
                    )}

                    {masks.length === 0 ? (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={watchedMode === 'whitelist' ? '白名单模式下必须至少有一条规则' : '暂无规则，黑名单模式下等于「全部放过」'}
                      />
                    ) : (
                      <Table
                        rowKey="_k"
                        size="small"
                        columns={maskColumns}
                        dataSource={masks}
                        pagination={false}
                        scroll={{ x: 720 }}
                      />
                    )}

                    <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
                      匹配方式是<b>包含匹配</b>（不区分大小写）：target 填 <Text code>192.168.10.</Text> 会命中该网段所有主机；
                      填项目名片段（如 <Text code>订单系统</Text>）会命中该项目下所有主机。指标选「全部指标」时包括离线连通性。
                      <br />
                      例：想让某台机器不出现在 CPU 榜上但保留它的磁盘告警 —— 加一条
                      target = 该机器、指标 = <Text code>CPU</Text> 的规则即可，不必用「全部指标」。
                    </Paragraph>
                  </Card>

                  <Alert
                    style={{ marginTop: 12 }}
                    type="success"
                    showIcon
                    icon={<CheckCircleOutlined />}
                    message="保存后立即生效，不必等下一轮采集"
                    description="风险口径、规则模式、规则明细、四个负载榜都用服务端当前快照现场重算，保存即刷新大屏。想确认「到底把什么挡掉了、它们现在什么水位」，去「被屏蔽目标」页看 —— 那里按同一套口径列出全部被隐藏的目标、风险项与榜位。"
                  />
                </>
              ),
            },

            /* ==================== ③ 阈值与采集 ==================== */
            {
              key: 'collect',
              label: (
                <span>
                  <FireOutlined /> 阈值与采集
                </span>
              ),
              forceRender: true,
              children: (
                <>
                  <Row gutter={[12, 12]}>
                    <Col xs={24} xl={14}>
                      <Card size="small" title="采集频率">
                        <Row gutter={12}>
                          <Col xs={24} md={12}>
                            <Form.Item label="开启定期采集" name="autoCollect" valuePropName="checked">
                              <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                            </Form.Item>
                          </Col>
                          <Col xs={24} md={12}>
                            <Form.Item
                              label="采集间隔"
                              name="intervalSec"
                              rules={[{ required: true, message: '请选择采集间隔' }]}
                              tooltip="真实 Prometheus 目标数越多，单次采集耗时越长；间隔不要小于单次耗时"
                            >
                              <Select options={INTERVAL_OPTIONS} />
                            </Form.Item>
                          </Col>
                        </Row>
                      </Card>

                      <Card size="small" title="资源阈值（%）" style={{ marginTop: 12 }}>
                        <Row gutter={12}>
                          <Col xs={12} md={8}>
                            <Form.Item label="CPU 关注" name="cpuWarn" rules={[{ required: true }]}>
                              <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                            </Form.Item>
                          </Col>
                          <Col xs={12} md={8}>
                            <Form.Item label="CPU 严重" name="cpuCrit" rules={[{ required: true }]}>
                              <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                            </Form.Item>
                          </Col>
                          <Col xs={12} md={8}>
                            <Form.Item label="内存 关注" name="memWarn" rules={[{ required: true }]}>
                              <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                            </Form.Item>
                          </Col>
                          <Col xs={12} md={8}>
                            <Form.Item label="内存 严重" name="memCrit" rules={[{ required: true }]}>
                              <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                            </Form.Item>
                          </Col>
                          <Col xs={12} md={8}>
                            <Form.Item label="磁盘 关注" name="diskWarn" rules={[{ required: true }]}>
                              <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                            </Form.Item>
                          </Col>
                          <Col xs={12} md={8}>
                            <Form.Item label="磁盘 严重" name="diskCrit" rules={[{ required: true }]}>
                              <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                            </Form.Item>
                          </Col>
                        </Row>
                        <Alert
                          type="info"
                          showIcon
                          style={{ marginTop: 4 }}
                          message="严重阈值必须高于关注阈值"
                          description="若填成不高于关注阈值，服务端会自动上抬 10 个百分点（否则面板自相矛盾）。"
                        />
                      </Card>

                      <Card size="small" title="网络" style={{ marginTop: 12 }}>
                        <Row gutter={12}>
                          <Col xs={24} md={12}>
                            <Form.Item
                              label="参考带宽（Mbps）"
                              name="netBaseMbps"
                              rules={[{ required: true, message: '请填写参考带宽' }]}
                              tooltip="网络使用率 = 出+入速率 ÷ 带宽。只有极少数主机会上报网卡标称速率（node_network_speed_bytes），其余一律按这个参考带宽折算 —— 不填就算不出网络使用率，大屏的「网络平均」「网络负载 TOP」「NET 小条」会整片空着。按机房最常见的网卡选：1G 填 1000，10G 填 10000。"
                            >
                              <InputNumber min={100} max={100000} step={100} style={{ width: '100%' }} />
                            </Form.Item>
                          </Col>
                        </Row>
                      </Card>
                    </Col>

                    <Col xs={24} xl={10}>
                      <Card size="small" title="采集状态">
                        <Table
                          rowKey="id"
                          size="small"
                          columns={statusColumns}
                          dataSource={status}
                          pagination={false}
                          locale={{ emptyText: '暂无启用的数据源' }}
                        />
                      </Card>

                      <Card size="small" title="当前口径速查" style={{ marginTop: 12 }}>
                        {cfg ? (
                          <Descriptions size="small" column={1} bordered>
                            <Descriptions.Item label="CPU">
                              <Tag color="orange">≥ {cfg.cpuWarn}% 关注</Tag>{' '}
                              <Tag color="red">≥ {cfg.cpuCrit}% 严重</Tag>
                            </Descriptions.Item>
                            <Descriptions.Item label="内存">
                              <Tag color="orange">≥ {cfg.memWarn}% 关注</Tag>{' '}
                              <Tag color="red">≥ {cfg.memCrit}% 严重</Tag>
                            </Descriptions.Item>
                            <Descriptions.Item label="磁盘">
                              <Tag color="orange">≥ {cfg.diskWarn}% 关注</Tag>{' '}
                              <Tag color="red">≥ {cfg.diskCrit}% 严重</Tag>
                            </Descriptions.Item>
                            <Descriptions.Item label="网络">
                              <Tag color="cyan">按参考带宽 {cfg.netBaseMbps ?? 1000} Mbps 折算</Tag>
                            </Descriptions.Item>
                            <Descriptions.Item label="离线主机">
                              <Tag color="red">一律计为严重（连通性）</Tag>
                            </Descriptions.Item>
                            <Descriptions.Item label="风险口径">
                              <Tag color="blue">
                                {cfg.riskLevel === 'crit' ? '仅严重' : cfg.riskLevel === 'warn' ? '仅关注' : '全部'}
                              </Tag>
                              <Tag color="geekblue">
                                {cfg.maskMode === 'whitelist' ? '白名单' : '黑名单'}
                              </Tag>
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {validMaskCount} 条规则
                              </Text>
                            </Descriptions.Item>
                          </Descriptions>
                        ) : (
                          <Text type="secondary">加载中…</Text>
                        )}
                        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
                          阈值决定大屏风险项清单与监控报表的风险判定，保存后<b>下一轮采集</b>生效；
                          屏蔽规则与面板开关作用于风险项 + 四个负载榜，保存<b>立即</b>生效。
                        </Paragraph>
                      </Card>
                    </Col>
                  </Row>
                </>
              ),
            },
          ]}
        />
      </Form>
    </div>
  )
}
