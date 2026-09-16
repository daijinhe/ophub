import { useEffect, useMemo, useState } from 'react'
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  TreeSelect,
  Switch,
  Tag,
  Space,
  message,
  Popconfirm,
  Card,
  Tooltip,
  Spin,
  Divider,
  Alert,
} from 'antd'
import {
  PlusOutlined,
  PlayCircleOutlined,
  EditOutlined,
  DeleteOutlined,
  EyeOutlined,
  FundOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { useAuth } from '../store/AuthContext'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  batchDeleteTasks,
  runTask,
  listRecords,
  getMetricCatalog,
  FreqOptions,
  ScopeOptions,
  InspectionTask,
  InspectionCatalog,
} from '../api/inspection'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default function InspectionTasks() {
  const { hasPerm } = useAuth()
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<InspectionTask[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<InspectionTask | null>(null)
  const [runningId, setRunningId] = useState<number | null>(null)
  const [catalog, setCatalog] = useState<InspectionCatalog>({ groups: [], metrics: [], categories: [] })
  const [cats, setCats] = useState<string[]>([])
  const [categories, setCategories] = useState<any[]>([])
  const [remotes, setRemotes] = useState<any[]>([])
  const [assets, setAssets] = useState<any[]>([])
  const [selectedKeys, setSelectedKeys] = useState<number[]>([])
  const [form] = Form.useForm()

  const canManage = hasPerm('inspection:manage')

  const load = async () => {
    setLoading(true)
    try {
      const d = await listTasks()
      setTasks(d.list || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    getMetricCatalog().then((m) => setCatalog(m))
    api.get('/categories').then((r) => setCategories(r.data.data || []))
    api.get('/ansible/remotes').then((r) => setRemotes(r.data.data.list || []))
    api.get('/assets', { params: { size: 300 } }).then((r) => setAssets(r.data.data.list || []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const defaultCats = useMemo(
    () => catalog.categories || catalog.groups.map((g) => g.key),
    [catalog]
  )

  const openCreate = () => {
    setEditing(null)
    const dc = defaultCats
    setCats(dc)
    form.resetFields()
    form.setFieldsValue({
      name: '',
      scopeType: 'all',
      freq: 'manual',
      scheduleEnabled: false,
      metrics: dc,
    })
    setOpen(true)
  }

  const openEdit = (t: InspectionTask) => {
    setEditing(t)
    const base = (t.categories && t.categories.length
      ? t.categories
      : t.metrics && t.metrics.length
      ? t.metrics
      : defaultCats) as string[]
    setCats(base)
    form.resetFields()
    form.setFieldsValue({
      name: t.name,
      scopeType: t.scopeType,
      categoryId: t.categoryId,
      assetIds: t.assetIds,
      freq: t.freq,
      scheduleEnabled: t.scheduleEnabled,
      remoteNodeId: t.remoteNodeId,
      metrics: base,
    })
    setOpen(true)
  }

  const submit = async () => {
    const v = await form.validateFields()
    if (!cats.length) {
      message.error('请至少选择一个采集分类')
      return
    }
    const body = {
      name: v.name,
      scopeType: v.scopeType,
      categoryId: v.categoryId || null,
      assetIds: v.assetIds || [],
      freq: v.freq,
      scheduleEnabled: v.scheduleEnabled,
      remoteNodeId: v.remoteNodeId || null,
      metrics: cats,
    }
    if (editing) {
      await updateTask(editing.id, body)
      message.success('已更新任务')
    } else {
      await createTask(body)
      message.success('已创建任务')
    }
    setOpen(false)
    load()
  }

  const remove = async (id: number) => {
    await deleteTask(id)
    message.success('已删除')
    load()
  }

  const batchRemove = async () => {
    if (!selectedKeys.length) return
    try {
      await batchDeleteTasks(selectedKeys)
      message.success(`已删除 ${selectedKeys.length} 个巡检任务及其历史记录`)
      setSelectedKeys([])
      load()
    } catch (e: any) {
      message.error('删除失败：' + (e?.response?.data?.msg || e.message))
    }
  }

  const run = async (id: number) => {
    setRunningId(id)
    try {
      await runTask(id)
      message.success('巡检已启动，正在采集…')
      for (let i = 0; i < 30; i++) {
        await sleep(1000)
        const d = await listRecords({ taskId: id, size: 1 })
        if (d.list && d.list.length) {
          const rec = d.list[0]
          if (rec.status !== 'running') {
            message.success(
              `巡检完成（${rec.status === 'done' ? '全部成功' : rec.status === 'partial' ? '部分成功' : '失败'}）`
            )
            break
          }
        }
      }
    } finally {
      setRunningId(null)
      load()
    }
  }

  const columns = [
    {
      title: '任务名称',
      dataIndex: 'name',
      render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span>,
    },
    {
      title: '巡检范围',
      dataIndex: 'scopeType',
      render: (s: string) => {
        const o = ScopeOptions.find((x) => x.value === s)
        return <Tag color="blue">{o?.label || s}</Tag>
      },
    },
    {
      title: '采集分类',
      dataIndex: 'categories',
      render: (cs: string[], r: any) => {
        const list = cs && cs.length ? cs : r.metrics || []
        return (
          <Space size={[4, 4]} wrap>
            {list.map((c: string) => (
              <Tag key={c} color="cyan">
                {catalog.groups.find((g) => g.key === c)?.label || c}
              </Tag>
            ))}
          </Space>
        )
      },
    },
    {
      title: '调度频率',
      dataIndex: 'freq',
      render: (f: string) => {
        const o = FreqOptions.find((x) => x.value === f)
        return f === 'manual' ? <Tag>手动</Tag> : <Tag color="purple">{o?.label}</Tag>
      },
    },
    {
      title: '定时',
      dataIndex: 'scheduleEnabled',
      render: (e: boolean) =>
        e ? <Tag color="green">已启用</Tag> : <Tag>未启用</Tag>,
    },
    {
      title: '上次运行',
      dataIndex: 'lastRunAt',
      render: (v?: string) =>
        v ? new Date(v).toLocaleString() : <span style={{ color: 'var(--text-secondary)' }}>—</span>,
    },
    {
      title: '下次运行',
      dataIndex: 'nextRunAt',
      render: (v?: string) =>
        v ? new Date(v).toLocaleString() : <span style={{ color: 'var(--text-secondary)' }}>—</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (s: string) =>
        s === 'running' ? (
          <Tag color="processing">运行中</Tag>
        ) : (
          <Tag color="default">空闲</Tag>
        ),
    },
    {
      title: '操作',
      key: 'op',
      render: (_: any, r: InspectionTask) => (
        <Space wrap>
          <Tooltip title="立即巡检">
            <Button
              type="primary"
              ghost
              size="small"
              icon={runningId === r.id ? <Spin size="small" /> : <PlayCircleOutlined />}
              loading={runningId === r.id}
              onClick={() => run(r.id)}
            >
              执行
            </Button>
          </Tooltip>
          <Tooltip title="查看记录">
            <Button
              size="small"
              icon={<EyeOutlined />}
              onClick={() => navigate(`/inspection/records?taskId=${r.id}`)}
            >
              记录
            </Button>
          </Tooltip>
          {canManage && (
            <>
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
              <Popconfirm title="确认删除该任务及其历史记录？" onConfirm={() => remove(r.id)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ]

  const toggleCat = (key: string) => {
    const n = cats.includes(key) ? cats.filter((k) => k !== key) : [...cats, key]
    setCats(n)
    form.setFieldValue('metrics', n)
  }

  // 资产分类树 → TreeSelect treeData（支持任意层级子分类选择）
  const buildCategoryTree = (list: any[]): any[] =>
    (list || []).map((c: any) => ({
      title: c.name,
      value: c.id,
      children: c.children && c.children.length ? buildCategoryTree(c.children) : undefined,
    }))

  const CAT_DESC: Record<string, string> = {
    os: '系统版本 / 架构 / 时区 / NTP / 运行时长',
    cpu: '核心数 / 使用率 / I/O等待 / 负载',
    mem: '内存 / Swap / 缓存 / 可用量',
    disk: '系统盘 / 数据盘 / NAS / inode',
    net: '带宽 / 丢包 / TCP状态 / 监听端口',
    proc: '进程数 / 僵尸进程 / 核心进程存活',
    svc: '中间件纳管与核心服务状态',
    security: '防火墙 / SELinux / SSH 登录安全',
  }

  return (
    <div className="fade-up">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 className="glow-text" style={{ margin: 0, fontSize: 22 }}>
            <FundOutlined style={{ marginRight: 8 }} />
            智能巡检任务
          </h2>
          <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
            通过 Ansible 采集八类服务器资源指标（操作系统 / CPU / 内存 / 磁盘 / 网络 / 进程 / 服务与中间件 / 安全合规），
            支持自定义采集分类、定时巡检与报表导出
          </div>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          {canManage && selectedKeys.length > 0 && (
            <Popconfirm
              title={`确认删除选中的 ${selectedKeys.length} 个巡检任务？`}
              description="将同时删除其历史巡检记录与采集明细，且不可恢复。"
              onConfirm={batchRemove}
            >
              <Button danger icon={<DeleteOutlined />}>
                批量删除（{selectedKeys.length}）
              </Button>
            </Popconfirm>
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={!canManage}>
            新建任务
          </Button>
        </Space>
      </div>

      <Card className="glass" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={tasks}
          rowSelection={
            canManage
              ? {
                  selectedRowKeys: selectedKeys,
                  onChange: (keys: React.Key[]) => setSelectedKeys(keys as number[]),
                }
              : undefined
          }
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
        />
      </Card>

      <Modal
        title={editing ? '编辑巡检任务' : '新建巡检任务'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submit}
        width={720}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="name" label="任务名称" rules={[{ required: true, message: '请输入任务名称' }]}>
            <Input placeholder="例如：生产环境每日资源巡检" />
          </Form.Item>

          <Form.Item name="scopeType" label="巡检范围" rules={[{ required: true }]}>
            <Select options={ScopeOptions} />
          </Form.Item>

          <Form.Item noStyle shouldUpdate={(p, c) => p.scopeType !== c.scopeType}>
            {({ getFieldValue }) => {
              const st = getFieldValue('scopeType')
              if (st === 'category')
                return (
                  <Form.Item name="categoryId" label="选择分类" rules={[{ required: true, message: '请选择分类' }]}>
                    <TreeSelect
                      placeholder="选择任意层级分类（自动包含其全部子分类资产）"
                      allowClear
                      showSearch
                      treeNodeFilterProp="title"
                      treeDefaultExpandAll
                      treeData={buildCategoryTree(categories)}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                )
              if (st === 'selected')
                return (
                  <Form.Item name="assetIds" label="选择资产" rules={[{ required: true, message: '请选择资产' }]}>
                    <Select
                      mode="multiple"
                      placeholder="搜索并选择资产"
                      options={assets.map((a) => ({
                        // 统一用后端派生的 displayName（改资产字段后这里会跟着变）
                        label: `${a.displayName || a.name}（${a.ip || '无IP'}）`,
                        value: a.id,
                      }))}
                      showSearch
                      optionFilterProp="label"
                      maxTagCount="responsive"
                    />
                  </Form.Item>
                )
              return null
            }}
          </Form.Item>

          <Form.Item label="采集分类（可自定义，默认全选八类）" required>
            <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
              <Button size="small" onClick={() => { const all = (catalog.groups || []).map((g: any) => g.key); setCats(all); form.setFieldValue('metrics', all) }}>
                全选
              </Button>
              <Button size="small" onClick={() => { setCats([]); form.setFieldValue('metrics', []) }}>
                清空
              </Button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {(catalog.groups || []).map((g: any) => {
                const checked = cats.includes(g.key)
                return (
                  <div
                    key={g.key}
                    onClick={() => toggleCat(g.key)}
                    style={{
                      cursor: 'pointer',
                      border: `1px solid ${checked ? '#38bdf8' : 'var(--border-soft)'}`,
                      background: checked ? 'rgba(56,189,248,0.12)' : 'transparent',
                      borderRadius: 10,
                      padding: '8px 12px',
                      minWidth: 200,
                      transition: 'all .15s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 4,
                          border: `1px solid ${checked ? '#38bdf8' : '#64748b'}`,
                          background: checked ? '#38bdf8' : 'transparent',
                        }}
                      />
                      <span style={{ fontWeight: 600 }}>{g.label}</span>
                      <Tag color={checked ? 'cyan' : 'default'} style={{ margin: 0, fontSize: 11 }}>
                        {g.metrics.length} 项
                      </Tag>
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 4 }}>
                      {CAT_DESC[g.key] || g.key}
                    </div>
                  </div>
                )
              })}
            </div>
            {cats.length === 0 && (
              <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>请至少选择一个采集分类</div>
            )}
            <Form.Item name="metrics" noStyle>
              <Input type="hidden" />
            </Form.Item>
          </Form.Item>

          <Divider style={{ margin: '8px 0 16px' }} />
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Form.Item name="freq" label="调度频率" rules={[{ required: true }]} style={{ width: 200 }}>
              <Select options={FreqOptions} />
            </Form.Item>
            <Form.Item name="scheduleEnabled" label="启用定时" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="调度说明"
            description="手动执行由你点击「执行」触发；选择日/周/月/季度/年后启用定时，系统将按周期自动巡检并生成记录。"
          />

          <Divider style={{ margin: '8px 0 16px' }} />
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Ansible 采集配置（可选）</div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Form.Item name="remoteNodeId" label="Ansible 控制节点" style={{ width: 320 }}>
              <Select
                allowClear
                placeholder="选择主机清单中的 Ansible 节点（留空则使用模拟采集）"
                options={remotes.map((r) => ({ label: `${r.name}（${r.host}）`, value: r.id }))}
              />
            </Form.Item>
          </div>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 4 }}
            message="节点凭证自动联动"
            description="无需再配置目标机 SSH 用户 / 密码 / 端口：采集时直接使用所选 Ansible 控制节点预配置的 SSH 凭证（默认端口 65181），并自动联动主机清单完成采集。"
          />
        </Form>
      </Modal>
    </div>
  )
}
