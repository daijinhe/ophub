import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  CloudDownloadOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SettingOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import {
  getPromScreenConfig,
  promCollectNow,
  promSnapshot,
  savePromScreenConfig,
  type PromCollectStatus,
  type PromMaskRule,
  type PromScreenConfig,
  type PromScreenConfigResp,
} from '../api/prometheus'

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

const SOURCE_CN: Record<string, string> = {
  auto: '自动采集',
  manual: '手动触发',
  restore: '重启恢复',
  realtime: '实时现算',
}

/** 屏蔽规则的指标口径 */
const MASK_METRIC_OPTIONS = [
  { value: 'all', label: '全部指标' },
  { value: 'cpu', label: 'CPU' },
  { value: 'mem', label: '内存' },
  { value: 'disk', label: '磁盘' },
  { value: 'offline', label: '离线（连通性）' },
]
const MASK_METRIC_CN: Record<string, string> = {
  all: '全部指标',
  cpu: 'CPU',
  mem: '内存',
  disk: '磁盘',
  offline: '离线（连通性）',
}

/**
 * Prometheus 监控大屏 · 管理（v1.7.33）
 *
 * 集中管理大屏「展示什么、怎么判、多久采一次」：
 *   - 展示：大屏标题、TOP N、主机列表上限、是否显示离线、趋势窗口、分组维度；
 *   - 判级：CPU / 内存 / 磁盘 的「关注 / 严重」阈值（决定超阈值清单与健康分布）；
 *   - 采集：自动采集开关 + 采集间隔（10 秒 ~ 30 分钟）+ 每个数据源的立即采集。
 */
export default function PromScreenAdmin() {
  const [cfg, setCfg] = useState<PromScreenConfig | null>(null)
  const [status, setStatus] = useState<PromCollectStatus[]>([])
  const [nextAt, setNextAt] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [collectingId, setCollectingId] = useState<number | null>(null)
  const [form] = Form.useForm()
  const [tick, setTick] = useState(0)
  // 屏蔽规则（v1.7.35）：本地编辑，点「保存配置」一起提交；保存后立即对快照生效
  const [masks, setMasks] = useState<PromMaskRule[]>([])
  const [hostOpts, setHostOpts] = useState<{ value: string; label: string }[]>([])
  const [newTarget, setNewTarget] = useState('')
  const [newMetric, setNewMetric] = useState<PromMaskRule['metric']>('all')
  const [newNote, setNewNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r: PromScreenConfigResp = await getPromScreenConfig()
      setCfg(r.config)
      setStatus(r.status || [])
      setNextAt(r.nextAt || 0)
      setMasks(r.config.masks || [])
      form.setFieldsValue(r.config)
    } catch (e) {
      message.error('加载大屏配置失败:' + errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [form])

  useEffect(() => {
    load()
  }, [load])

  // 拉一次快照，给「屏蔽规则」的主机下拉提供候选（失败不阻塞配置加载）
  useEffect(() => {
    promSnapshot()
      .then((s) => {
        setHostOpts(
          (s.data?.hosts || []).map((h) => ({
            value: h.instance,
            label: h.instance,
          })),
        )
      })
      .catch(() => undefined)
  }, [])

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
      message.warning('请先修正表单中的错误项')
      return
    }
    setSaving(true)
    try {
      const r = await savePromScreenConfig({
        ...vals,
        autoCollect: vals.autoCollect ? 1 : 0,
        showOffline: vals.showOffline ? 1 : 0,
        masks,
      })
      message.success(r.msg || '已保存')
      setCfg(r.config)
      load()
    } catch (e) {
      message.error('保存失败:' + errMsg(e))
    } finally {
      setSaving(false)
    }
  }, [form, load, masks])

  const addMask = useCallback(() => {
    const t = newTarget.trim()
    if (!t) {
      message.warning('请填写要屏蔽的主机（instance 或名称关键字）')
      return
    }
    if (masks.some((m) => m.target === t && m.metric === newMetric)) {
      message.info('该屏蔽规则已存在')
      return
    }
    setMasks([...masks, { target: t, metric: newMetric, note: newNote.trim() || undefined }])
    setNewTarget('')
    setNewNote('')
  }, [masks, newTarget, newMetric, newNote])

  const removeMask = useCallback(
    (t: string, m: string) => {
      setMasks(masks.filter((x) => !(x.target === t && x.metric === m)))
    },
    [masks],
  )

  const onCollect = useCallback(async (id: number) => {
    setCollectingId(id)
    const started = Date.now()
    try {
      const r = await promCollectNow(id)
      message.success(`${r.msg}：${r.hosts} 台主机，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
      load()
    } catch (e) {
      message.error('采集失败:' + errMsg(e))
    } finally {
      setCollectingId(null)
    }
  }, [load])

  const remainSec = useMemo(() => {
    if (!nextAt) return 0
    return Math.max(0, Math.round((nextAt * 1000 - Date.now()) / 1000))
  }, [nextAt, tick])

  const watched = Form.useWatch('intervalSec', form) ?? cfg?.intervalSec ?? 60
  const watchedAuto = Form.useWatch('autoCollect', form)
  const autoOn = watchedAuto === undefined ? (cfg?.autoCollect === 1) : !!watchedAuto

  const statusColumns = useMemo(
    () => [
      {
        title: '数据源',
        dataIndex: 'name',
        key: 'name',
        width: 200,
        render: (v: string) => <b>{v}</b>,
      },
      {
        title: '状态',
        key: 'state',
        width: 110,
        render: (_: any, r: PromCollectStatus) => {
          if (r.busy) return <Tag color="processing">采集中</Tag>
          if (!r.ready) return <Tag color="default">未采集</Tag>
          return r.msg ? <Tag color="warning">上次失败</Tag> : <Tag color="success">正常</Tag>
        },
      },
      {
        title: '最近采集时间',
        dataIndex: 'generatedAt',
        key: 'generatedAt',
        width: 170,
        render: (v: string) => v || '—',
      },
      {
        title: '耗时',
        dataIndex: 'collectMs',
        key: 'collectMs',
        width: 90,
        render: (v: number) => (v ? `${v} ms` : '—'),
      },
      {
        title: '主机数',
        dataIndex: 'hosts',
        key: 'hosts',
        width: 80,
        render: (v: number, r: PromCollectStatus) => (r.ready ? `${v} 台` : '—'),
      },
      {
        title: '来源',
        dataIndex: 'source',
        key: 'source',
        width: 100,
        render: (v: string) => SOURCE_CN[v] || v || '—',
      },
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
        width: 120,
        render: (_: any, r: PromCollectStatus) => (
          <Button
            size="small"
            icon={<CloudDownloadOutlined />}
            loading={collectingId === r.id}
            onClick={() => onCollect(r.id)}
          >
            立即采集
          </Button>
        ),
      },
    ],
    [collectingId, onCollect],
  )

  const maskColumns = useMemo(
    () => [
      {
        title: '目标（包含匹配）',
        dataIndex: 'target',
        key: 'target',
        render: (v: string, r: PromMaskRule) => (
          <div>
            <div style={{ fontWeight: 600 }}>{v}</div>
            {r.note && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {r.note}
              </Text>
            )}
          </div>
        ),
      },
      {
        title: '屏蔽指标',
        dataIndex: 'metric',
        key: 'metric',
        width: 140,
        render: (v: string) => (
          <Tag color={v === 'all' ? 'red' : 'geekblue'}>{MASK_METRIC_CN[v] || v}</Tag>
        ),
      },
      {
        title: '操作',
        key: 'op',
        width: 70,
        render: (_: any, r: PromMaskRule) => (
          <Tooltip title="删除该规则">
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeMask(r.target, r.metric)}
            />
          </Tooltip>
        ),
      },
    ],
    [removeMask],
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          <SettingOutlined style={{ marginRight: 8 }} />
          监控大屏管理
        </Title>
        <Tag color="purple">v1.7.33</Tag>
        <Space style={{ marginLeft: 'auto' }}>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
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
        message="大屏数据由服务端定期采集后缓存，页面只读缓存快照"
        description={
          <div>
            采集频率可按需要从 <b>10 秒</b> 到 <b>30 分钟</b> 调整；自动采集关闭时，需在大屏页或此处点「立即采集」
            才会刷新数据。{autoOn ? (
              <>当前每 <b>{watched}</b> 秒自动采集一次{remainSec > 0 && <>，下次采集约 <b>{remainSec}</b> 秒后</>}。</>
            ) : (
              <>当前<b>自动采集已关闭</b>，只有手动触发才会更新大屏。</>
            )}
          </div>
        }
      />

      <Row gutter={[12, 12]}>
        <Col xs={24} xl={14}>
          <Card size="small" title={<span><SettingOutlined /> 展示与阈值</span>} loading={loading}>
            {cfg && (
              <Form form={form} layout="vertical" initialValues={cfg} size="middle">
                <Row gutter={12}>
                  <Col xs={24} md={12}>
                    <Form.Item
                      label="大屏标题"
                      name="title"
                      rules={[{ required: true, message: '请填写大屏标题' }]}
                    >
                      <Input placeholder="Prometheus 监控大屏" maxLength={32} showCount />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item label="分组维度（水位排行按哪个维度聚合）" name="groupBy">
                      <Select options={GROUP_BY_OPTIONS} />
                    </Form.Item>
                  </Col>
                </Row>

                <Divider orientation="left" plain style={{ margin: '4px 0 12px' }}>
                  采集频率
                </Divider>
                <Row gutter={12}>
                  <Col xs={24} md={8}>
                    <Form.Item label="开启定期采集" name="autoCollect" valuePropName="checked">
                      <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item
                      label="采集间隔"
                      name="intervalSec"
                      rules={[{ required: true, message: '请选择采集间隔' }]}
                      tooltip="真实 Prometheus 目标数越多，单次采集耗时越长；间隔不要小于单次耗时"
                    >
                      <Select options={INTERVAL_OPTIONS} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item label="趋势窗口（小时）" name="trendHours" tooltip="大屏趋势图回看多久；步长会自动匹配，点数恒定">
                      <InputNumber min={1} max={720} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>

                <Divider orientation="left" plain style={{ margin: '4px 0 12px' }}>
                  资源阈值（%）
                </Divider>
                <Row gutter={12}>
                  <Col xs={12} md={6}>
                    <Form.Item label="CPU 关注" name="cpuWarn" rules={[{ required: true }]}>
                      <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={6}>
                    <Form.Item label="CPU 严重" name="cpuCrit" rules={[{ required: true }]}>
                      <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={6}>
                    <Form.Item label="内存 关注" name="memWarn" rules={[{ required: true }]}>
                      <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={6}>
                    <Form.Item label="内存 严重" name="memCrit" rules={[{ required: true }]}>
                      <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={6}>
                    <Form.Item label="磁盘 关注" name="diskWarn" rules={[{ required: true }]}>
                      <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={6}>
                    <Form.Item label="磁盘 严重" name="diskCrit" rules={[{ required: true }]}>
                      <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col xs={12} md={6}>
                    <Form.Item label="TOP N" name="topN" tooltip="负载排行榜展示多少条">
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
                </Row>
                <Row>
                  <Col xs={24}>
                    <Form.Item label="主机列表展示离线主机" name="showOffline" valuePropName="checked">
                      <Switch checkedChildren="展示" unCheckedChildren="隐藏" />
                    </Form.Item>
                  </Col>
                </Row>
              </Form>
            )}
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card size="small" title={<span><DatabaseOutlined /> 采集状态</span>} style={{ marginBottom: 12 }}>
            <Table
              rowKey="id"
              size="small"
              columns={statusColumns}
              dataSource={status}
              pagination={false}
              locale={{ emptyText: '暂无启用的数据源' }}
            />
          </Card>

          {/* 屏蔽规则（v1.7.35）：命中规则的主机指标不再进大屏「超阈值主机」面板 */}
          <Card
            size="small"
            title={<span><StopOutlined /> 屏蔽规则（超阈值面板）</span>}
            style={{ marginBottom: 12 }}
            extra={<Tag color="red">{masks.length} 条</Tag>}
          >
            <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
              <AutoComplete
                value={newTarget}
                onChange={setNewTarget}
                options={hostOpts}
                placeholder="主机 instance（IP:端口）或名称关键字"
                style={{ width: '46%' }}
                filterOption={(input, option) =>
                  String(option?.value || '').toLowerCase().includes(input.toLowerCase())
                }
              />
              <Select
                value={newMetric}
                onChange={(v) => setNewMetric(v)}
                options={MASK_METRIC_OPTIONS}
                style={{ width: '24%' }}
              />
              <Input
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="备注（可选）"
                style={{ width: '22%' }}
                maxLength={50}
                onPressEnter={addMask}
              />
              <Button type="primary" icon={<PlusOutlined />} onClick={addMask} title="添加屏蔽规则" />
            </Space.Compact>
            <Table
              rowKey={(r) => `${r.target}|${r.metric}`}
              size="small"
              columns={maskColumns}
              dataSource={masks}
              pagination={false}
              locale={{ emptyText: '暂无屏蔽规则 —— 大屏展示全部超阈值主机' }}
            />
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              命中规则的主机指标将从大屏「超阈值主机」面板隐藏（不再计数）。目标支持
              instance（如 <code>198.51.100.31:9100</code>）或展示名关键字（如 和创利OA），
              按「包含」匹配、不区分大小写；点「保存配置」后立即生效。
            </Paragraph>
          </Card>

          <Card size="small" title="当前阈值速查">
            {cfg ? (
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="CPU">
                  <Tag color="orange">≥ {cfg.cpuWarn}% 关注</Tag> <Tag color="red">≥ {cfg.cpuCrit}% 严重</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="内存">
                  <Tag color="orange">≥ {cfg.memWarn}% 关注</Tag> <Tag color="red">≥ {cfg.memCrit}% 严重</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="磁盘">
                  <Tag color="orange">≥ {cfg.diskWarn}% 关注</Tag> <Tag color="red">≥ {cfg.diskCrit}% 严重</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="离线主机">
                  <Tag color="red">一律计为严重（连通性）</Tag>
                </Descriptions.Item>
              </Descriptions>
            ) : (
              <Text type="secondary">加载中…</Text>
            )}
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
              阈值决定大屏「超阈值主机」清单与监控报表的风险判定；保存后下一轮采集生效。
              <br />
              严重阈值若被填成不高于关注阈值，系统会自动上抬 10 个百分点。
            </Paragraph>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
