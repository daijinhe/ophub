// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from 'react'
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  InputNumber,
  Tag,
  Space,
  message,
  Popconfirm,
  Card,
  Tooltip,
  Alert,
  Divider,
  Empty,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  ExperimentOutlined,
  SearchOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useAuth } from '../store/AuthContext'
import {
  listAlertRules,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  getAlertRuleCatalog,
  previewAlertRule,
  MatchTypeOptions,
  MATCH_TYPE_LABEL,
  InspectionAlertRule,
  AlertRuleCatalog,
  ThresholdDef,
  ThresholdOverride,
} from '../api/inspection'

// 阈值覆盖的本地编辑态：null 表示「沿用默认」
type ThrDraft = Record<string, { warn: number | null; crit: number | null }>

const fmtThr = (v: number) => (v > 0 ? String(v) : '—')

export default function InspectionAlertRules() {
  const { hasPerm } = useAuth()

  const [rules, setRules] = useState<InspectionAlertRule[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<InspectionAlertRule | null>(null)
  const [catalog, setCatalog] = useState<AlertRuleCatalog>({
    thresholds: [],
    projects: [],
    systems: [],
    assets: [],
  })
  const [thr, setThr] = useState<ThrDraft>({})
  const [muteAll, setMuteAll] = useState(false)
  const [muteMetrics, setMuteMetrics] = useState<string[]>([])
  const [kw, setKw] = useState('')
  const [preview, setPreview] = useState<{ matched: number; total: number; samples: any[] } | null>(null)
  const [form] = Form.useForm()
  const matchType = ((Form.useWatch('matchType', form) as string) || 'project') as string

  const load = async () => {
    setLoading(true)
    try {
      const d = await listAlertRules()
      setRules(d.list || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    getAlertRuleCatalog().then(setCatalog).catch(() => undefined)
  }, [])

  const thrDefs = catalog.thresholds
  const defByKey = useMemo(() => {
    const m: Record<string, ThresholdDef> = {}
    thrDefs.forEach((d) => (m[d.key] = d))
    return m
  }, [thrDefs])

  const thrRows = useMemo(() => {
    const k = kw.trim().toLowerCase()
    if (!k) return thrDefs
    return thrDefs.filter(
      (d) => d.label.toLowerCase().includes(k) || d.key.toLowerCase().includes(k),
    )
  }, [thrDefs, kw])

  const valueOptions = useMemo(() => {
    if (matchType === 'asset')
      return catalog.assets.map((a) => ({
        label: `${a.name || a.ip}${a.ip ? `（${a.ip}）` : ''}`,
        value: a.id,
      }))
    if (matchType === 'system') return catalog.systems.map((s) => ({ label: s, value: s }))
    return catalog.projects.map((p) => ({ label: p, value: p }))
  }, [matchType, catalog])

  const resetEditor = () => {
    setThr({})
    setMuteAll(false)
    setMuteMetrics([])
    setKw('')
    setPreview(null)
  }

  const openCreate = () => {
    setEditing(null)
    resetEditor()
    form.resetFields()
    form.setFieldsValue({
      name: '',
      enabled: true,
      matchType: 'project',
      matchValues: [],
      priority: 0,
      remark: '',
    })
    setOpen(true)
  }

  const openEdit = (r: InspectionAlertRule) => {
    setEditing(r)
    resetEditor()
    const draft: ThrDraft = {}
    Object.entries(r.thresholds || {}).forEach(([k, v]) => {
      draft[k] = { warn: v.warn ?? null, crit: v.crit ?? null }
    })
    setThr(draft)
    setMuteAll(!!r.muteAll)
    setMuteMetrics(r.muteMetrics || [])
    form.resetFields()
    form.setFieldsValue({
      name: r.name,
      enabled: r.enabled,
      matchType: r.matchType,
      matchValues: r.matchValues || [],
      priority: r.priority ?? 0,
      remark: r.remark || '',
    })
    setOpen(true)
  }

  const setThrField = (key: string, field: 'warn' | 'crit', value: number | null) => {
    setThr((prev) => {
      const cur = prev[key] || { warn: null, crit: null }
      const next = { ...cur, [field]: value }
      const copy = { ...prev }
      if (next.warn === null && next.crit === null) delete copy[key]
      else copy[key] = next
      return copy
    })
  }

  /** 组装提交体：只把「用户真正填了」的阈值写进去，留空的字段交给后端继承默认 */
  const buildThresholds = (): Record<string, ThresholdOverride> => {
    const out: Record<string, ThresholdOverride> = {}
    Object.entries(thr).forEach(([k, v]) => {
      const item: ThresholdOverride = {}
      if (typeof v.warn === 'number') item.warn = v.warn
      if (typeof v.crit === 'number') item.crit = v.crit
      if (item.warn !== undefined || item.crit !== undefined) out[k] = item
    })
    return out
  }

  const buildRuleBody = (v: any) => ({
    name: v.name,
    enabled: !!v.enabled,
    matchType: v.matchType,
    matchValues: v.matchValues || [],
    thresholds: buildThresholds(),
    muteAll,
    muteMetrics,
    priority: typeof v.priority === 'number' ? v.priority : 0,
    remark: v.remark || '',
  })

  const submit = async () => {
    const v = await form.validateFields().catch(() => null)
    if (!v) return
    setSaving(true)
    try {
      const body = buildRuleBody(v)
      if (editing) await updateAlertRule(editing.id, body)
      else await createAlertRule(body)
      message.success(
        editing ? '规则已更新，历史巡检数据已按新规则重算' : '规则已创建并即时生效',
      )
      setOpen(false)
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const doPreview = async () => {
    const v = form.getFieldsValue()
    if (!v.matchType) {
      message.warning('请先选择匹配维度')
      return
    }
    const mv = v.matchValues || []
    if (!mv.length) {
      message.warning('请先选择匹配值')
      return
    }
    try {
      const d = await previewAlertRule({
        name: v.name || '预览',
        enabled: true,
        matchType: v.matchType,
        matchValues: mv,
        thresholds: buildThresholds(),
        muteAll,
        muteMetrics,
        priority: 0,
        remark: '',
      })
      setPreview(d)
    } catch (e: any) {
      message.error(e?.response?.data?.message || '试算失败')
    }
  }

  const remove = async (r: InspectionAlertRule) => {
    await deleteAlertRule(r.id)
    message.success('规则已删除')
    load()
  }

  const columns = [
    {
      title: '规则名称',
      dataIndex: 'name',
      render: (v: string, r: InspectionAlertRule) => (
        <div>
          <div style={{ fontWeight: 600 }}>{v}</div>
          {r.remark && <div style={{ fontSize: 12, color: '#94a3b8' }}>{r.remark}</div>}
        </div>
      ),
    },
    {
      title: '匹配维度',
      dataIndex: 'matchType',
      width: 130,
      render: (v: string) => <Tag color="geekblue">{MATCH_TYPE_LABEL[v] || v}</Tag>,
    },
    {
      title: '匹配值',
      dataIndex: 'matchValues',
      render: (vals: (string | number)[], r: InspectionAlertRule) => {
        const list = vals || []
        if (!list.length) return <span style={{ color: '#94a3b8' }}>—</span>
        const show = list.slice(0, 3)
        const rest = list.length - show.length
        return (
          <Space size={4} wrap>
            {show.map((x) => (
              <Tag key={String(x)} style={{ margin: 0 }}>
                {r.matchType === 'asset'
                  ? catalog.assets.find((a) => a.id === Number(x))?.name || `资产 #${x}`
                  : x}
              </Tag>
            ))}
            {rest > 0 && <Tag style={{ margin: 0 }}>+{rest}</Tag>}
          </Space>
        )
      },
    },
    {
      title: '自定义阈值',
      dataIndex: 'thresholdCount',
      width: 110,
      render: (n: number) =>
        n > 0 ? <Tag color="orange">{n} 项</Tag> : <span style={{ color: '#94a3b8' }}>继承默认</span>,
    },
    {
      title: '告警屏蔽',
      dataIndex: 'muteAll',
      width: 130,
      render: (v: boolean, r: InspectionAlertRule) =>
        v ? (
          <Tag color="red">全部屏蔽</Tag>
        ) : r.mutedCount ? (
          <Tag color="volcano">{r.mutedCount} 项屏蔽</Tag>
        ) : (
          <span style={{ color: '#94a3b8' }}>—</span>
        ),
    },
    { title: '优先级', dataIndex: 'priority', width: 80 },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>),
    },
    {
      title: '操作',
      width: 130,
      render: (_: any, r: InspectionAlertRule) =>
        hasPerm('inspection:alert:update') || hasPerm('inspection:alert:delete') ? (
          <Space>
            {hasPerm('inspection:alert:update') && (
              <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(r)}>
                编辑
              </Button>
            )}
            {hasPerm('inspection:alert:delete') && (
              <Popconfirm title={`确定删除规则「${r.name}」？`} onConfirm={() => remove(r)}>
                <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                  删除
                </Button>
              </Popconfirm>
            )}
          </Space>
        ) : (
          <span style={{ color: '#94a3b8' }}>—</span>
        ),
    },
  ]

  const thrColumns = [
    {
      title: '指标',
      dataIndex: 'label',
      render: (v: string, d: ThresholdDef) => (
        <div>
          <div style={{ fontSize: 13 }}>
            {v}
            {d.unit ? `（${d.unit}）` : ''}
          </div>
          {d.note && <div style={{ fontSize: 11, color: '#94a3b8' }}>{d.note}</div>}
        </div>
      ),
    },
    {
      title: '默认预警',
      width: 88,
      render: (_: any, d: ThresholdDef) => <span style={{ color: '#94a3b8' }}>{fmtThr(d.warn)}</span>,
    },
    {
      title: '默认严重',
      width: 88,
      render: (_: any, d: ThresholdDef) => <span style={{ color: '#94a3b8' }}>{fmtThr(d.crit)}</span>,
    },
    {
      title: '自定义预警',
      width: 118,
      render: (_: any, d: ThresholdDef) => (
        <InputNumber
          size="small"
          style={{ width: '100%' }}
          min={0}
          max={d.kind === 'percent' || d.kind === 'ratio' ? 100 : undefined}
          value={thr[d.key]?.warn ?? null}
          placeholder={fmtThr(d.warn)}
          onChange={(val) => setThrField(d.key, 'warn', typeof val === 'number' ? val : null)}
        />
      ),
    },
    {
      title: '自定义严重',
      width: 118,
      render: (_: any, d: ThresholdDef) => (
        <InputNumber
          size="small"
          style={{ width: '100%' }}
          min={0}
          max={d.kind === 'percent' || d.kind === 'ratio' ? 100 : undefined}
          value={thr[d.key]?.crit ?? null}
          placeholder={fmtThr(d.crit)}
          onChange={(val) => setThrField(d.key, 'crit', typeof val === 'number' ? val : null)}
        />
      ),
    },
    {
      title: '',
      width: 56,
      render: (_: any, d: ThresholdDef) =>
        thr[d.key] ? (
          <Tooltip title="恢复该项默认阈值">
            <Button
              size="small"
              type="text"
              icon={<UndoOutlined />}
              onClick={() =>
                setThr((prev) => {
                  const copy = { ...prev }
                  delete copy[d.key]
                  return copy
                })
              }
            />
          </Tooltip>
        ) : null,
    },
  ]

  return (
    <div>
      <Card
        title={
          <Space>
            <span>巡检告警规则</span>
            <Tag color="blue">按项目 / 应用系统 / 资产自定义</Tag>
          </Space>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load}>
              刷新
            </Button>
            {hasPerm('inspection:alert:create') && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新建规则
              </Button>
            )}
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="阈值留空即继承系统默认；规则保存后立即生效——大屏、巡检记录与导出的告警都会按当前规则重算，无需重跑巡检。"
          description="匹配优先级：多条规则命中同一台资产时，按「优先级」从小到大依次叠加，数值越大越优先（后者覆盖前者）；「屏蔽告警」一旦命中即生效，不会被后续规则反向取消。"
        />
        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns as any}
          dataSource={rules}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                description={
                  <span>
                    还没有告警规则，当前所有指标都使用系统默认阈值
                    <br />
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>
                      例如：给「核心交易系统」单独调高/调低 CPU、内存、磁盘的严重阈值，或直接屏蔽其告警
                    </span>
                  </span>
                }
              />
            ),
          }}
        />
      </Card>

      <Modal
        title={editing ? `编辑规则：${editing.name}` : '新建告警规则'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submit}
        confirmLoading={saving}
        width={980}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 4 }}>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="name"
              label="规则名称"
              rules={[{ required: true, message: '请输入规则名称' }]}
              style={{ width: 260 }}
            >
              <Input placeholder="如：核心交易系统-磁盘阈值放宽" />
            </Form.Item>
            <Form.Item
              name="matchType"
              label="匹配维度"
              rules={[{ required: true }]}
              style={{ width: 170 }}
            >
              <Select
                options={MatchTypeOptions}
                onChange={() => form.setFieldValue('matchValues', [])}
              />
            </Form.Item>
            <Form.Item
              name="matchValues"
              label={`匹配值（${MATCH_TYPE_LABEL[matchType] || ''}）`}
              rules={[{ required: true, message: '请至少选择一个匹配值' }]}
              style={{ flex: 1, minWidth: 320 }}
            >
              <Select
                mode="multiple"
                allowClear
                showSearch
                placeholder={
                  matchType === 'asset'
                    ? '选择资产'
                    : matchType === 'system'
                    ? '选择应用系统名称'
                    : '选择项目简称'
                }
                optionFilterProp="label"
                options={valueOptions as any}
                maxTagCount="responsive"
              />
            </Form.Item>
          </Space>

          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="priority" label="优先级（越大越优先）" style={{ width: 170 }}>
              <InputNumber style={{ width: '100%' }} min={0} max={999} />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="remark" label="备注" style={{ flex: 1, minWidth: 320 }}>
              <Input placeholder="可选，如：数据库机型磁盘水位偏高，阈值放宽至 85%" />
            </Form.Item>
          </Space>

          <Divider style={{ margin: '4px 0 12px' }}>
            告警屏蔽（该范围不再进入实时告警列表与统计）
          </Divider>
          <Space size={16} align="center" wrap style={{ marginBottom: 12 }}>
            <span>
              屏蔽全部告警：
              <Switch checked={muteAll} onChange={setMuteAll} />
            </span>
            <span style={{ minWidth: 420 }}>
              屏蔽指定指标：
              <Select
                mode="multiple"
                allowClear
                showSearch
                style={{ minWidth: 380 }}
                placeholder="不选则不屏蔽"
                optionFilterProp="label"
                disabled={muteAll}
                value={muteMetrics}
                onChange={(v) => setMuteMetrics(v || [])}
                maxTagCount="responsive"
                options={thrDefs.map((d) => ({ label: d.label, value: d.key }))}
              />
            </span>
          </Space>

          <Divider style={{ margin: '4px 0 12px' }}>
            指标阈值（留空 = 继承默认；严重阈值填 0 = 关闭该指标的严重判定）
          </Divider>
          <Space style={{ marginBottom: 8 }} wrap>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索指标"
              style={{ width: 220 }}
              value={kw}
              onChange={(e) => setKw(e.target.value)}
            />
            <Button icon={<ExperimentOutlined />} onClick={doPreview}>
              试算作用范围
            </Button>
            <Button
              icon={<UndoOutlined />}
              disabled={!Object.keys(thr).length}
              onClick={() => setThr({})}
            >
              全部恢复默认
            </Button>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>
              已自定义 {Object.keys(thr).length} 项 / 共 {thrDefs.length} 项
            </span>
          </Space>
          {preview && (
            <Alert
              type={preview.matched > 0 ? 'success' : 'warning'}
              showIcon
              style={{ marginBottom: 8 }}
              message={`按当前匹配条件，共命中 ${preview.matched} / ${preview.total} 台资产`}
              description={
                preview.samples?.length ? (
                  <Space size={4} wrap>
                    {preview.samples.map((s: any) => (
                      <Tag key={s.id} style={{ margin: 0 }}>
                        {s.name || s.ip}
                        {s.project ? `｜${s.project}` : ''}
                      </Tag>
                    ))}
                    {preview.matched > preview.samples.length && (
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>
                        …等 {preview.matched} 台
                      </span>
                    )}
                  </Space>
                ) : (
                  '未命中任何资产，请检查匹配值'
                )
              }
            />
          )}
          <Table
            rowKey="key"
            size="small"
            columns={thrColumns as any}
            dataSource={thrRows}
            pagination={false}
            scroll={{ y: 260 }}
            locale={{ emptyText: <Empty description="没有匹配的指标" /> }}
          />
        </Form>
      </Modal>
    </div>
  )
}
