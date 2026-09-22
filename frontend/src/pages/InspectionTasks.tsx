import { useEffect, useMemo, useState } from 'react'
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
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
  Segmented,
  Checkbox,
} from 'antd'
import {
  PlusOutlined,
  PlayCircleOutlined,
  EditOutlined,
  DeleteOutlined,
  EyeOutlined,
  FundOutlined,
  ReloadOutlined,
  DownOutlined,
  UpOutlined,
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
  WeekdayOptions,
  MonthDayOptions,
  scheduleText,
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
  // 采集分类的选中集合（cats）：既有**分类 key**（= 整类全选）也有**单指标 key**（子项级选择），
  // 两种混用直接提交给后端；导出/明细按它裁剪列。
  const [cats, setCats] = useState<string[]>([])
  // 展开状态：哪些分类卡片被展开显示了子项
  const [expandedCats, setExpandedCats] = useState<string[]>([])
  const [categories, setCategories] = useState<any[]>([])
  const [remotes, setRemotes] = useState<any[]>([])
  // 平台采集通道（v1.7.20）：巡检采集与资源校准/中间件捕捉共用同一条通道，
  // 这里把「当前实际生效」展示出来，避免用户以为必须选一个远端控制节点。
  const [runnerMode, setRunnerMode] = useState<{ effective: string; mode: string } | null>(null)
  const [assets, setAssets] = useState<any[]>([])
  const [selectedKeys, setSelectedKeys] = useState<number[]>([])
  // 「按分类」的选择模式：single=任选一个层级；multi=任选多个层级（可跨层混选）
  const [catMode, setCatMode] = useState<'single' | 'multi'>('multi')
  const [form] = Form.useForm()

  const canManage = hasPerm('inspection:manage')
  // 当前选择的调度频率：联动显示对应的参数输入项（间隔 / 时刻 / 星期 / 日期）
  const freqVal = Form.useWatch('freq', form)

  // 当前生效的采集通道（供表单里提示「留空即用这条通道」）
  const effectiveChannelLabel =
    runnerMode?.effective === 'local'
      ? '本机 ansible'
      : runnerMode?.effective === 'remote'
      ? '远端控制节点'
      : runnerMode?.effective === 'none'
      ? '无可用通道'
      : '未获取'

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
    api
      .get('/ansible/mode')
      .then((r) => setRunnerMode(r.data.data))
      .catch(() => setRunnerMode(null))
    api.get('/assets', { params: { size: 300 } }).then((r) => setAssets(r.data.data.list || []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const defaultCats = useMemo(
    () => catalog.categories || catalog.groups.map((g) => g.key),
    [catalog]
  )

  // 分类树 → 扁平 id→名称 映射（列表里把分类 ID 显示成人能看懂的名字）
  const catNameById = useMemo(() => {
    const m = new Map<number, string>()
    const walk = (ns: any[]) =>
      (ns || []).forEach((n: any) => {
        m.set(n.id, n.name)
        if (n.children && n.children.length) walk(n.children)
      })
    walk(categories)
    return m
  }, [categories])

  // ⚠ antd TreeSelect 在 treeCheckStrictly（父子不联动）下，onChange 回传的是
  //   [{ label, value, halfChecked }, ...] 这种对象数组（为了携带半选信息），
  //   而不是纯 value 数组。后端只认纯分类 id 数组，所以：
  //     toCatIds   —— 提交前把对象/数字统一抽成 number[]
  //     toCatValue —— 回填时按模式还原成 TreeSelect 期望的形态（多选=对象数组 / 单选=单个 id）
  const toCatIds = (v: any): number[] =>
    (Array.isArray(v) ? v : v == null ? [] : [v])
      .map((x: any) => (x && typeof x === 'object' ? x.value : x))
      .filter((x: any) => x != null && x !== '')
      .map((x: any) => Number(x))

  const toCatValue = (ids: number[], mode: 'single' | 'multi'): any =>
    mode === 'multi'
      ? ids.map((id) => ({ value: id, label: catNameById.get(id) || `#${id}` }))
      : ids

  // 调度参数缺省值：新建时给一套「拿就能用」的配置；
  // 后端 NormalizeSchedule 会再夹一次合法区间，这里只负责界面初始状态。
  const defaultSchedule = {
    intervalMin: 5,
    intervalHour: 1,
    weekday: 1,
    monthDay: 1,
    runHour: 2,
    runMinute: 0,
  }

  const openCreate = () => {
    setEditing(null)
    const dc = defaultCats
    setCats(dc)
    setCatMode('multi')
    form.resetFields()
    form.setFieldsValue({
      name: '',
      scopeType: 'all',
      categoryIds: [],
      freq: 'manual',
      scheduleEnabled: false,
      metrics: dc,
      allowSimulated: false,
      ...defaultSchedule,
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
    // 分类范围：优先读新的多选字段，回退到历史单选字段
    const catIds = (t.categoryIds && t.categoryIds.length
      ? t.categoryIds
      : t.categoryId
      ? [t.categoryId]
      : []) as number[]
    // 多选/单选只是「界面交互模式」，按已选个数还原；只有一个分类时用单选更直观
    const mode: 'single' | 'multi' = catIds.length > 1 ? 'multi' : 'single'
    setCatMode(mode)
    form.resetFields()
    form.setFieldsValue({
      name: t.name,
      scopeType: t.scopeType,
      categoryIds: toCatValue(catIds, mode),
      assetIds: t.assetIds,
      freq: t.freq,
      intervalMin: t.intervalMin ?? defaultSchedule.intervalMin,
      intervalHour: t.intervalHour ?? defaultSchedule.intervalHour,
      weekday: t.weekday ?? defaultSchedule.weekday,
      monthDay: t.monthDay ?? defaultSchedule.monthDay,
      runHour: t.runHour ?? defaultSchedule.runHour,
      runMinute: t.runMinute ?? defaultSchedule.runMinute,
      scheduleEnabled: t.scheduleEnabled,
      remoteNodeId: t.remoteNodeId,
      allowSimulated: !!t.allowSimulated,
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
    const isCategory = v.scopeType === 'category'
    const catIds = isCategory ? toCatIds(v.categoryIds) : []
    if (isCategory && !catIds.length) {
      message.error('请至少选择一个分类')
      return
    }
    const body = {
      name: v.name,
      scopeType: v.scopeType,
      // 后端统一把分类写进 categoryIds（单选也只是长度为 1 的数组），categoryId 只读不写
      categoryId: null,
      categoryIds: catIds,
      assetIds: v.assetIds || [],
      freq: v.freq,
      intervalMin: v.intervalMin,
      intervalHour: v.intervalHour,
      weekday: v.weekday,
      monthDay: v.monthDay,
      runHour: v.runHour,
      runMinute: v.runMinute,
      scheduleEnabled: v.scheduleEnabled,
      remoteNodeId: v.remoteNodeId || null,
      allowSimulated: !!v.allowSimulated,
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
      render: (s: string, r: InspectionTask) => {
        const o = ScopeOptions.find((x) => x.value === s)
        const catIds =
          r.categoryIds && r.categoryIds.length
            ? r.categoryIds
            : r.categoryId
            ? [r.categoryId]
            : []
        return (
          <Space size={[4, 4]} wrap>
            <Tag color="blue">
              {o?.label || s}
              {s === 'category' && catIds.length > 1 ? `（${catIds.length} 个）` : ''}
            </Tag>
            {s === 'category' &&
              catIds.map((id: number) => (
                <Tag key={id} color="geekblue">
                  {catNameById.get(id) || `#${id}`}
                </Tag>
              ))}
          </Space>
        )
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
      // 直接渲染 scheduleText（与巡检大屏同一口径），而不是只显示频率枚举名，
      // 否则「每隔 5 分钟」和「每天 02:00」在列表里长得一样，看不出具体配置。
      render: (_: string, row: InspectionTask) => (
        <Tag color={row.freq === 'manual' ? undefined : 'purple'}>{scheduleText(row)}</Tag>
      ),
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

  // ---------- 采集分类选择（整类 + 子项级，v1.7.30） ----------
  const metricKeysOf = (g: any): string[] => (g.metrics || []).map((m: any) => m.key)

  /** 该分类是否整类选中：存了组 key，或全部子项都被单独勾上 */
  const isGroupFull = (g: any) =>
    cats.includes(g.key) || metricKeysOf(g).every((k: string) => cats.includes(k))
  /** 该分类是否部分选中（只勾了部分子项） */
  const isGroupPartial = (g: any) =>
    !isGroupFull(g) && metricKeysOf(g).some((k: string) => cats.includes(k))

  /** 点卡片 = 整类勾/去勾。勾时把零散子项归一成组 key，去勾时组 key 和子项全清 */
  const toggleCat = (g: any) => {
    let n: string[]
    if (isGroupFull(g)) {
      n = cats.filter((k) => k !== g.key && !metricKeysOf(g).includes(k))
    } else {
      n = [...cats.filter((k) => !metricKeysOf(g).includes(k)), g.key]
    }
    setCats(n)
    form.setFieldValue('metrics', n)
  }

  /** 勾单个子项：整类 key 存在时先拆散成全部子项再翻转；
   *  全部子项勾齐时归一化回组 key（避免存一长串等价 id） */
  const toggleMetric = (g: any, mk: string) => {
    let n = cats.includes(g.key)
      ? [...cats.filter((k) => k !== g.key), ...metricKeysOf(g)]
      : [...cats]
    n = n.includes(mk) ? n.filter((k) => k !== mk) : [...n, mk]
    if (metricKeysOf(g).every((k: string) => n.includes(k))) {
      n = [...n.filter((k) => !metricKeysOf(g).includes(k)), g.key]
    }
    setCats(n)
    form.setFieldValue('metrics', n)
  }

  const toggleExpand = (key: string) =>
    setExpandedCats((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]))

  // 切换「按分类」的单选/多选：多选切单选时只保留第一个，
  // 否则会出现「界面是单选、值却是多个」的脏状态，提交后与所见不符。
  const switchCatMode = (m: 'single' | 'multi') => {
    setCatMode(m)
    let ids = toCatIds(form.getFieldValue('categoryIds'))
    if (m === 'single') ids = ids.slice(0, 1)
    form.setFieldValue('categoryIds', toCatValue(ids, m))
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
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        marginBottom: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{ fontSize: 13 }}>选择方式</span>
                      <Segmented
                        size="small"
                        value={catMode}
                        onChange={(v) => switchCatMode(v as 'single' | 'multi')}
                        options={[
                          { label: '多选', value: 'multi' },
                          { label: '单选', value: 'single' },
                        ]}
                      />
                      <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                        分类树任意层级都可选，可跨层级多选；选中父级即覆盖其全部子分类的资产
                      </span>
                    </div>
                    <Form.Item
                      name="categoryIds"
                      label="选择分类"
                      rules={[{ required: true, message: '请选择分类' }]}
                    >
                      <TreeSelect
                        multiple={catMode === 'multi'}
                        treeCheckable={catMode === 'multi'}
                        // 父子不联动：勾哪个层级就只提交哪个层级。
                        // 联动（antd 默认）下勾一个父级会连带勾满它全部子孙，多选标签瞬间爆成
                        // 几十个；再反选某个子级又会把父级从值里踢掉 —— 与后端「选父级 = 覆盖
                        // 整棵子树」的口径不一致，反而容易误操作。父子都勾也无所谓，后端做并集去重。
                        treeCheckStrictly={catMode === 'multi'}
                        placeholder={
                          catMode === 'multi'
                            ? '可跨层级选多个分类（自动包含各自全部子分类资产）'
                            : '选择任意层级分类（自动包含其全部子分类资产）'
                        }
                        allowClear
                        showSearch
                        treeNodeFilterProp="title"
                        treeDefaultExpandAll
                        treeData={buildCategoryTree(categories)}
                        style={{ width: '100%' }}
                        maxTagCount="responsive"
                      />
                    </Form.Item>
                  </div>
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

          <Form.Item label="采集分类（点卡片整类勾选；点箭头展开可单独勾选子项）" required>
            <div style={{ display: 'flex', gap: 12, marginBottom: 8, alignItems: 'center' }}>
              <Button size="small" onClick={() => { const all = (catalog.groups || []).map((g: any) => g.key); setExpandedCats([]); setCats(all); form.setFieldValue('metrics', all) }}>
                全选
              </Button>
              <Button size="small" onClick={() => { setCats([]); form.setFieldValue('metrics', []) }}>
                清空
              </Button>
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                只勾部分子项时分类显示 <Tag color="orange" style={{ margin: 0, fontSize: 11 }}>x/N 项</Tag>；全部勾齐自动归并为整类
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {(catalog.groups || []).map((g: any) => {
                const full = isGroupFull(g)
                const partial = isGroupPartial(g)
                const expanded = expandedCats.includes(g.key)
                const selCount = full
                  ? (g.metrics || []).length
                  : metricKeysOf(g).filter((k: string) => cats.includes(k)).length
                return (
                  <div
                    key={g.key}
                    data-cat={g.key}
                    style={{
                      border: `1px solid ${full ? '#38bdf8' : partial ? '#f59e0b' : 'var(--border-soft)'}`,
                      background: full
                        ? 'rgba(56,189,248,0.12)'
                        : partial
                        ? 'rgba(245,158,11,0.08)'
                        : 'transparent',
                      borderRadius: 10,
                      padding: '8px 12px',
                      width: expanded ? '100%' : 220,
                      transition: 'all .15s',
                    }}
                  >
                    {/* 头部：点复选块/标题 = 整类勾选；点箭头 = 展开子项（互不干扰） */}
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                      onClick={() => toggleCat(g)}
                    >
                      <span
                        style={{
                          width: 14,
                          height: 14,
                          flexShrink: 0,
                          borderRadius: 4,
                          border: `1px solid ${full || partial ? '#38bdf8' : '#64748b'}`,
                          background: full ? '#38bdf8' : partial ? 'rgba(56,189,248,0.4)' : 'transparent',
                          position: 'relative',
                        }}
                      >
                        {/* 半选态的短横 */}
                        {partial && (
                          <span
                            style={{
                              position: 'absolute', left: 2, right: 2, top: '50%',
                              height: 2, transform: 'translateY(-1px)', background: '#38bdf8', borderRadius: 1,
                            }}
                          />
                        )}
                      </span>
                      <span style={{ fontWeight: 600, flex: 1 }}>{g.label}</span>
                      <Tag color={full ? 'cyan' : partial ? 'orange' : 'default'} style={{ margin: 0, fontSize: 11 }}>
                        {full ? `${(g.metrics || []).length} 项` : `${selCount}/${(g.metrics || []).length} 项`}
                      </Tag>
                      <span
                        style={{
                          color: 'var(--text-secondary)', fontSize: 11, padding: '0 2px',
                          cursor: 'pointer', flexShrink: 0,
                        }}
                        onClick={(e) => { e.stopPropagation(); toggleExpand(g.key) }}
                        title={expanded ? '收起子项' : '展开子项'}
                      >
                        {expanded ? <UpOutlined /> : <DownOutlined />}
                      </span>
                    </div>
                    {!expanded && (
                      <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 4 }}>
                        {CAT_DESC[g.key] || g.key}
                      </div>
                    )}
                    {expanded && (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                          gap: '4px 12px',
                          marginTop: 8,
                          padding: '8px 10px',
                          background: 'rgba(0,0,0,0.15)',
                          borderRadius: 8,
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {(g.metrics || []).map((m: any) => (
                          <Checkbox
                            key={m.key}
                            checked={full || cats.includes(m.key)}
                            onChange={() => toggleMetric(g, m.key)}
                            style={{ fontSize: 12 }}
                            title={m.note || m.label}
                          >
                            {m.label}
                          </Checkbox>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {cats.length === 0 && (
              <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>请至少选择一个采集分类或子项</div>
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

            {freqVal === 'minute' && (
              <Form.Item
                name="intervalMin"
                label="间隔（分钟）"
                tooltip="每 N 分钟执行一次，范围 1-1440"
                rules={[{ required: true, message: '请输入间隔分钟数' }]}
                style={{ width: 180 }}
              >
                <InputNumber min={1} max={1440} precision={0} style={{ width: '100%' }} addonAfter="分钟" />
              </Form.Item>
            )}

            {freqVal === 'hour' && (
              <>
                <Form.Item
                  name="intervalHour"
                  label="间隔（小时）"
                  tooltip="每 N 小时执行一次，范围 1-72"
                  rules={[{ required: true, message: '请输入间隔小时数' }]}
                  style={{ width: 180 }}
                >
                  <InputNumber min={1} max={72} precision={0} style={{ width: '100%' }} addonAfter="小时" />
                </Form.Item>
                <Form.Item name="runMinute" label="第几分钟" rules={[{ required: true }]} style={{ width: 150 }}>
                  <InputNumber min={0} max={59} precision={0} style={{ width: '100%' }} addonAfter="分" />
                </Form.Item>
              </>
            )}

            {(freqVal === 'day' || freqVal === 'week' || freqVal === 'month') && (
              <>
                <Form.Item name="runHour" label="执行时刻（时）" rules={[{ required: true }]} style={{ width: 160 }}>
                  <InputNumber min={0} max={23} precision={0} style={{ width: '100%' }} addonAfter="点" />
                </Form.Item>
                <Form.Item name="runMinute" label="执行时刻（分）" rules={[{ required: true }]} style={{ width: 160 }}>
                  <InputNumber min={0} max={59} precision={0} style={{ width: '100%' }} addonAfter="分" />
                </Form.Item>
              </>
            )}

            {freqVal === 'week' && (
              <Form.Item
                name="weekday"
                label="星期"
                rules={[{ required: true, message: '请选择星期' }]}
                style={{ width: 140 }}
              >
                <Select options={WeekdayOptions} />
              </Form.Item>
            )}

            {freqVal === 'month' && (
              <Form.Item
                name="monthDay"
                label="日期"
                tooltip="当月天数不足时自动取月末（如 31 号在 2 月落到 28/29 号）"
                rules={[{ required: true, message: '请选择日期' }]}
                style={{ width: 140 }}
              >
                <Select options={MonthDayOptions} />
              </Form.Item>
            )}
          </div>

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="调度说明"
            description="手动执行由你点击「执行」触发。启用定时后支持的频率：每隔 N 分钟 / 每隔 N 小时（指定第几分钟）/ 每天（指定时刻）/ 每周（指定星期 + 时刻）/ 每月（指定日期 + 时刻）/ 每季度 / 每年。调度器每 30 秒检查一次到期任务。"
          />

          <Divider style={{ margin: '8px 0 16px' }} />
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            Ansible 采集配置（可选）
            <Tag
              style={{ marginLeft: 8 }}
              color={
                runnerMode?.effective === 'local'
                  ? 'green'
                  : runnerMode?.effective === 'remote'
                  ? 'blue'
                  : 'red'
              }
            >
              当前生效：{effectiveChannelLabel}
            </Tag>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Form.Item
              name="remoteNodeId"
              label="Ansible 控制节点"
              style={{ width: 320 }}
              extra="留空 = 跟随「Ansible 管理 → 平台采集通道设置」（推荐）"
            >
              <Select
                allowClear
                placeholder={`跟随平台采集通道设置（当前：${effectiveChannelLabel}）`}
                options={remotes.map((r) => ({
                  label: `指定控制节点：${r.name}（${r.host}）`,
                  value: r.id,
                }))}
              />
            </Form.Item>
          </div>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="采集通道统一由「平台采集通道设置」决定"
            description={
              runnerMode?.effective === 'local'
                ? '当前平台走的是「本机 ansible」：巡检会直接用平台所在服务器的 ansible 采集，无需（也无需配置）远端控制节点。目标机的 SSH 用户/密码/端口取自资产管理里该资产的对应字段。'
                : '当前平台走的是「远端控制节点」：巡检会经匹配到的控制节点执行 ansible 采集。如需改为本机 ansible，请到「Ansible 管理 → 平台采集通道设置」切换。'
            }
          />
          <Form.Item
            name="allowSimulated"
            label="采集失败时用模拟数据兜底"
            valuePropName="checked"
            tooltip="仅供演示/离线环境使用。默认关闭：采集失败会记为失败并显示真实原因，不会用假数据冒充真实采集结果。"
            style={{ marginBottom: 0 }}
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
