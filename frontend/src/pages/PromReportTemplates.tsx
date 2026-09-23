import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FundOutlined,
  PlusOutlined,
  ProfileOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  createPromReportTemplate,
  deletePromReportTemplate,
  listPromDataSources,
  listPromProjects,
  listPromReportTemplates,
  updatePromReportTemplate,
  type PromDataSource,
  type PromProject,
  type PromReportTemplate,
} from '../api/prometheus'
import { useAuth } from '../store/AuthContext'

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

/**
 * Prometheus 监控 · 报表模板（v1.7.38）
 *
 * 模板 = 「数据源 + 项目范围 + 默认周期」的可复用口径。
 * 每个人负责的项目不同，各自建自己的模板，出报告时按模板一键带出范围。
 *
 * 权限：建模板人人都行（prom:view），改 / 删只能动自己的（或 prom:manage 管理员）；
 * 别人共享的模板只能「用」和「复制成自己的」。
 */
export default function PromReportTemplates({
  embedded = false,
  onUse,
  onChanged,
  reloadSeq = 0,
}: {
  /** 嵌在「监控报表」页签里时置 true：不渲染页面级标题栏（标题由外层 Tabs 承载） */
  embedded?: boolean
  /**
   * 点「使用」时的回调。嵌入在监控报表里时由外层切换到「生成报告」页签并带上模板参数，
   * 而不是新开一个浏览器标签页 —— 同一页里来回跳转比开一堆标签更好用。
   */
  onUse?: (t: PromReportTemplate) => void
  /**
   * 模板集合发生变化（新建 / 保存 / 删除）后回调。
   * 本页签与「生成报告」页签各自独立拉取模板清单（三个页签 forceRender，只挂载一次），
   * 不通知的话，刚建的模板在生成页的下拉里就找不到 —— 用户得刷新浏览器。
   */
  onChanged?: () => void
  /**
   * 列表刷新信号（onChanged 的另一半）：在「生成报告」页点「另存为模板」建的模板，
   * 本页签同样收不到通知，要靠外层递增这个序号触发重拉。
   */
  reloadSeq?: number
} = {}) {
  const { hasPerm } = useAuth()
  const [dss, setDss] = useState<PromDataSource[]>([])
  const [list, setList] = useState<PromReportTemplate[]>([])
  const [myUid, setMyUid] = useState(0)
  const [loading, setLoading] = useState(false)

  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<{
    name: string
    dsId: number | null
    period: Period
    systems: string[]
    remark: string
    shared: boolean
  }>({ name: '', dsId: null, period: 'quarter', systems: [], remark: '', shared: false })

  const [projects, setProjects] = useState<PromProject[]>([])
  const [projLoading, setProjLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await listPromReportTemplates()
      setList(r.list || [])
      setMyUid(r.uid || 0)
    } catch (e) {
      message.error('加载报表模板失败:' + errMsg(e))
      setList([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    listPromDataSources()
      .then((r) => setDss((r.list || []).filter((x) => x.enabled === 1)))
      .catch(() => undefined)
    load()
  }, [load])

  // 外层通知模板集合变了（典型：在「生成报告」页点了「另存为模板」）时重拉。
  // 用 ref 记住上次处理的序号，避免 load 重建时重复打请求。
  const lastReloadSeq = useRef(reloadSeq)
  useEffect(() => {
    if (reloadSeq === lastReloadSeq.current) return
    lastReloadSeq.current = reloadSeq
    load()
  }, [reloadSeq, load])

  /** 表单里的数据源变了就重拉项目清单（项目名是 per-数据源 的） */
  const loadFormProjects = useCallback(async (dsId: number | null) => {
    if (!dsId) {
      setProjects([])
      return
    }
    setProjLoading(true)
    try {
      const r = await listPromProjects(dsId)
      setProjects(r.list || [])
    } catch (e) {
      message.error('加载项目清单失败:' + errMsg(e))
      setProjects([])
    } finally {
      setProjLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) loadFormProjects(form.dsId)
  }, [open, form.dsId, loadFormProjects])

  const projectOptions = useMemo(
    () => projects.map((p) => ({ value: p.name, label: `${p.name}（${p.hosts} 台）` })),
    [projects],
  )

  const openCreate = useCallback(
    (seed?: PromReportTemplate) => {
      setEditId(null)
      setForm({
        name: seed ? `${seed.name}-副本` : '',
        dsId: seed?.dsId ?? dss[0]?.id ?? null,
        period: seed?.period ?? 'quarter',
        systems: seed?.systems ?? [],
        remark: seed?.remark ?? '',
        shared: false, // 复制来的模板默认私有：共享是创建人的显式决定
      })
      setOpen(true)
    },
    [dss],
  )

  const openEdit = useCallback((t: PromReportTemplate) => {
    setEditId(t.id)
    setForm({
      name: t.name,
      dsId: t.dsId,
      period: t.period,
      systems: t.systems || [],
      remark: t.remark || '',
      shared: t.shared === 1,
    })
    setOpen(true)
  }, [])

  const submit = useCallback(async () => {
    const name = form.name.trim()
    if (!name) {
      message.warning('请填写模板名称')
      return
    }
    if (!form.dsId) {
      message.warning('请选择数据源')
      return
    }
    if (form.systems.length === 0) {
      message.warning('请至少选择一个项目')
      return
    }
    setSaving(true)
    try {
      const body = {
        name,
        dsId: form.dsId,
        period: form.period,
        systems: form.systems,
        remark: form.remark.trim(),
        shared: form.shared ? 1 : 0,
      }
      if (editId) {
        await updatePromReportTemplate(editId, body)
        message.success('模板已保存')
      } else {
        await createPromReportTemplate(body)
        message.success('模板已创建，可到「监控报表」里套用它生成报告')
      }
      setOpen(false)
      load()
      // 通知外层（「生成报告」页签）重新拉模板清单，否则它那份缓存里没有刚建的模板
      onChanged?.()
    } catch (e) {
      message.error(errMsg(e))
    } finally {
      setSaving(false)
    }
  }, [form, editId, load, onChanged])

  const onDelete = useCallback(
    (t: PromReportTemplate) => {
      Modal.confirm({
        title: '删除报表模板',
        content: `确认删除模板「${t.name}」？已归档的历史报告不受影响，但模板本身无法恢复。`,
        okText: '确认删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          try {
            await deletePromReportTemplate(t.id)
            message.success('模板已删除')
            load()
            // 同上：删除也要让外层的下拉立刻少掉这一项
            onChanged?.()
          } catch (e) {
            message.error(errMsg(e))
          }
        },
      })
    },
    [load, onChanged],
  )

  const columns = useMemo(
    () => [
      {
        title: '模板名称',
        dataIndex: 'name',
        key: 'name',
        ellipsis: true,
        render: (v: string, r: PromReportTemplate) => (
          <div>
            <Space size={6}>
              <span style={{ fontWeight: 600 }}>{v}</span>
              {r.shared === 1 && <Tag color="cyan">已共享</Tag>}
              {r.ownerId !== myUid && <Tag>他人创建</Tag>}
            </Space>
            {r.remark && (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {r.remark}
                </Text>
              </div>
            )}
          </div>
        ),
      },
      {
        title: '项目范围',
        key: 'scope',
        width: 320,
        render: (_: any, r: PromReportTemplate) => {
          const sys = r.systems || []
          return (
            <div>
              <Tag color="blue">{sys.length} 个项目</Tag>
              <Tooltip title={sys.join('、')}>
                <Text style={{ fontSize: 12 }} ellipsis>
                  {sys.slice(0, 3).join('、')}
                  {sys.length > 3 ? ` 等 ${sys.length} 个` : ''}
                </Text>
              </Tooltip>
            </div>
          )
        },
      },
      {
        title: '周期',
        dataIndex: 'period',
        key: 'period',
        width: 90,
        render: (v: Period) => <Tag color="blue">{PERIOD_LABEL[v] || v}</Tag>,
      },
      {
        title: '数据源',
        dataIndex: 'dsName',
        key: 'dsName',
        width: 160,
        ellipsis: true,
      },
      {
        title: '创建人',
        key: 'owner',
        width: 130,
        render: (_: any, r: PromReportTemplate) => (
          <div style={{ fontSize: 12 }}>
            <div>{r.ownerName || '—'}</div>
            <div style={{ color: '#94a3b8' }}>{dayjs(r.updatedAt).format('YYYY-MM-DD HH:mm')}</div>
          </div>
        ),
      },
      {
        title: '操作',
        key: 'op',
        width: 240,
        render: (_: any, r: PromReportTemplate) => (
          <Space size={4}>
            {/* 语义就是「生成报告」（跳转到生成报告并套用本模板），与生成报告按钮同码 prom:report:create */}
            {hasPerm('prom:report:create') && (
              <Tooltip title="带着模板的数据源 / 项目范围 / 周期跳到「生成报告」">
                <Button
                  type="primary"
                  size="small"
                  icon={<FundOutlined />}
                  onClick={() => {
                    // 嵌在监控报表里 → 就地切到「生成报告」页签（同一页内跳转，不开新标签）；
                    // 独立路由访问时保持原行为：新标签打开监控报表并带上模板。
                    if (onUse) onUse(r)
                    else window.open(`/prom/report?template=${r.id}`, '_blank')
                  }}
                >
                  生成报告
                </Button>
              </Tooltip>
            )}
            {r.canEdit && hasPerm('prom:report:update') && (
              <Tooltip title="修改">
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
              </Tooltip>
            )}
            {hasPerm('prom:report:create') && (
              <Tooltip title="复制成自己的模板（共享模板不能直接改，复制后再调整）">
                <Button size="small" icon={<CopyOutlined />} onClick={() => openCreate(r)} />
              </Tooltip>
            )}
            {r.canEdit && hasPerm('prom:report:delete') && (
              <Tooltip title="删除">
                <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onDelete(r)} />
              </Tooltip>
            )}
          </Space>
        ),
      },
    ],
    [openEdit, openCreate, onDelete, myUid, onUse, hasPerm],
  )

  // 按 ownerId 判断「我的」，不能用 canEdit：管理员对所有人的模板都能改，
  // 用 canEdit 会把别人的模板也算成自己的
  const mineCount = list.filter((t) => t.ownerId === myUid).length

  return (
    <div>
      {!embedded && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <Title level={4} style={{ margin: 0 }}>
            <ProfileOutlined style={{ marginRight: 8 }} />
            报表模板
          </Title>
          <Tag color="purple">v1.7.41</Tag>
          <Space style={{ marginLeft: 'auto' }}>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
            {hasPerm('prom:report:create') && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
                新建模板
              </Button>
            )}
          </Space>
        </div>
      )}

      {embedded && (
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <Space style={{ marginLeft: 'auto' }}>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
            {hasPerm('prom:report:create') && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
                新建模板
              </Button>
            )}
          </Space>
        </div>
      )}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="模板 = 数据源 + 项目范围 + 周期，用来固定「我负责的这些项目」的报告口径"
        description="每个人负责的项目不同，各自建自己的模板即可：在「生成报告」里选好项目后点「另存为模板」，或在这里直接新建。模板只保存口径、不保存报告数据，改模板不影响已归档的历史报告。"
      />

      <Card size="small">
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={list}
          locale={{
            emptyText: (
              <Empty description="还没有报表模板 —— 点右上角「新建模板」，或在「监控报表」里选好项目后另存为模板" />
            ),
          }}
          pagination={false}
          scroll={{ x: 1100 }}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: '#94a3b8' }}>
          共 {list.length} 个模板，其中 {mineCount} 个由你创建
        </div>
      </Card>

      <Modal
        open={open}
        title={editId ? '修改报表模板' : '新建报表模板'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        onOk={submit}
        maskClosable={false}
        width={620}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={{ marginBottom: 4, fontSize: 12, color: '#64748b' }}>模板名称</div>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={64}
              showCount
              placeholder="例如：某项目季度报告"
            />
          </div>

          <Space style={{ display: 'flex' }} align="start">
            <div style={{ flex: 1 }}>
              <div style={{ marginBottom: 4, fontSize: 12, color: '#64748b' }}>数据源</div>
              <Select
                style={{ width: '100%' }}
                value={form.dsId ?? undefined}
                placeholder="选择数据源"
                onChange={(v) => setForm({ ...form, dsId: v, systems: [] })}
                options={dss.map((d) => ({ value: d.id, label: d.name }))}
              />
            </div>
            <div style={{ width: 130 }}>
              <div style={{ marginBottom: 4, fontSize: 12, color: '#64748b' }}>默认周期</div>
              <Select
                style={{ width: '100%' }}
                value={form.period}
                onChange={(v) => setForm({ ...form, period: v })}
                options={(Object.keys(PERIOD_LABEL) as Period[]).map((p) => ({
                  value: p,
                  label: PERIOD_LABEL[p],
                }))}
              />
            </div>
          </Space>

          <div>
            <div style={{ marginBottom: 4, fontSize: 12, color: '#64748b' }}>
              项目范围（可多选；单选即「只看一个项目」）
            </div>
            <Select
              mode="multiple"
              allowClear
              style={{ width: '100%' }}
              placeholder="选择这个模板负责的项目"
              value={form.systems}
              onChange={(v) => setForm({ ...form, systems: v })}
              options={projectOptions}
              optionFilterProp="label"
              maxTagCount="responsive"
              loading={projLoading}
              notFoundContent={projLoading ? '加载中…' : '该数据源下没有带 system 标签的采集目标'}
            />
            <div style={{ marginTop: 4, fontSize: 12, color: '#94a3b8' }}>
              共 {projects.length} 个项目可选
              {form.systems.length > 0 ? ` · 已选 ${form.systems.length} 个` : ''}
            </div>
          </div>

          <div>
            <div style={{ marginBottom: 4, fontSize: 12, color: '#64748b' }}>备注（可选）</div>
            <Input.TextArea
              value={form.remark}
              onChange={(e) => setForm({ ...form, remark: e.target.value })}
              maxLength={255}
              rows={2}
              placeholder="例如：每季度末出给部门汇报用"
            />
          </div>

          <Checkbox
            checked={form.shared}
            onChange={(e) => setForm({ ...form, shared: e.target.checked })}
          >
            共享给其他人使用（别人只能用它生成报告，不能修改或删除）
          </Checkbox>
        </div>
      </Modal>
    </div>
  )
}
