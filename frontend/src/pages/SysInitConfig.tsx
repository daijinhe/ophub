import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Alert,
  AutoComplete,
  Button,
  Empty,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CloudServerOutlined,
  PlusOutlined,
  SearchOutlined,
  ReloadOutlined,
  EditOutlined,
  DeleteOutlined,
  SafetyOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  CloudDownloadOutlined,
  ThunderboltOutlined,
  EyeOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import {
  listSysInitCatalog,
  createSysInitCatalog,
  updateSysInitCatalog,
  deleteSysInitCatalog,
  toggleSysInitCatalog,
  syncSysInitCatalog,
  listSysInitPlaybooks,
  checkSysInitPlaybook,
  type SysInitCatalogItem,
  type SysInitCatalogPayload,
} from '../api/deploy'
import { useAuth } from '../store/AuthContext'

const { Text, Paragraph } = Typography

const VAR_MODES: { value: SysInitCatalogPayload['varMode']; label: string; hint: string }[] = [
  { value: 'none', label: '无需变量', hint: '脚本自包含，不向 playbook 透传额外变量' },
  { value: 'os', label: '按操作系统（OS_TYPE）', hint: '向 playbook 传 OS_TYPE=<识别出的操作系统令牌>' },
  { value: 'cpu', label: '按 CPU 架构（CPU_TYPE）', hint: '向 playbook 传 CPU_TYPE=<识别出的 CPU 令牌>' },
  { value: 'static', label: '固定变量', hint: '透传固定参数，如 DISK_DIR=data FORMAT_TYPE=ext4' },
]

const MODE_LABEL: Record<string, { text: string; color: string }> = {
  os: { text: '按 OS', color: 'geekblue' },
  cpu: { text: '按 CPU', color: 'purple' },
  static: { text: '固定变量', color: 'gold' },
  none: { text: '无需变量', color: 'default' },
}

type CheckState = { exists: boolean; fullPath?: string; node?: string; head?: string; err?: string }

export default function SysInitConfig() {
  const { message, modal } = App.useApp()
  const { hasPerm } = useAuth()
  const canManage = hasPerm('deploy:manage')
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<SysInitCatalogItem[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [osTokens, setOsTokens] = useState<string[]>([])
  const [cpuTokens, setCpuTokens] = useState<string[]>([])
  // 控制节点各目录域的根目录（系统初始化 / GaussDB），用于表单前缀与执行预览
  const [dirs, setDirs] = useState<{ system: string; gaussdb: string }>({ system: '', gaussdb: '' })

  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'on' | 'off' | 'custom'>('all')

  // 新增 / 编辑
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<SysInitCatalogItem | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm<SysInitCatalogPayload>()
  const varMode = Form.useWatch('varMode', form)
  const domainWatch = Form.useWatch('domain', form)

  // 控制节点 playbook 清单（新增/编辑时挑选）
  const [pbFiles, setPbFiles] = useState<string[]>([])
  const [pbLoading, setPbLoading] = useState(false)
  const [pbNode, setPbNode] = useState('')

  // 单个 playbook 校验结果
  const [checks, setChecks] = useState<Record<number, CheckState>>({})
  const [checking, setChecking] = useState(false)
  const [peek, setPeek] = useState<{ item: SysInitCatalogItem; state: CheckState } | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    listSysInitCatalog()
      .then((d) => {
        setRows(d.list || [])
        setGroups(d.groups || [])
        setOsTokens(d.osTypes || [])
        setCpuTokens(d.cpuTypes || [])
        setDirs({ system: d.systemInitDir || '', gaussdb: d.gaussdbInitDir || '' })
      })
      .catch(() => message.error('加载系统初始化目录失败'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    const k = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (groupFilter !== 'all' && r.group !== groupFilter) return false
      if (statusFilter === 'on' && !r.enabled) return false
      if (statusFilter === 'off' && r.enabled) return false
      if (statusFilter === 'custom' && !r.custom) return false
      if (!k) return true
      return (
        r.key.toLowerCase().includes(k) ||
        r.label.toLowerCase().includes(k) ||
        r.playbook.toLowerCase().includes(k) ||
        r.desc.toLowerCase().includes(k)
      )
    })
  }, [rows, search, groupFilter, statusFilter])

  const stats = useMemo(() => {
    const on = rows.filter((r) => r.enabled).length
    return {
      total: rows.length,
      on,
      off: rows.length - on,
      custom: rows.filter((r) => r.custom).length,
      groups: new Set(rows.map((r) => r.group)).size,
    }
  }, [rows])

  const openCreate = () => {
    setEditing(null)
    form.setFieldsValue({
      key: '',
      label: '',
      group: groups[0] || '自定义',
      domain: '',
      playbook: '',
      desc: '',
      varMode: 'none',
      varArgs: '',
      osTypes: [],
      cpuTypes: [],
      orderNo: (rows[rows.length - 1]?.orderNo || 0) + 1,
      enabled: true,
    })
    setModalOpen(true)
    loadPlaybooks('')
  }

  const openEdit = (r: SysInitCatalogItem) => {
    setEditing(r)
    form.setFieldsValue({
      key: r.key,
      label: r.label,
      group: r.group,
      domain: r.domain || '',
      playbook: r.playbook,
      desc: r.desc,
      varMode: r.varMode,
      varArgs: r.varArgs,
      osTypes: r.osTypes || [],
      cpuTypes: r.cpuTypes || [],
      orderNo: r.orderNo,
      enabled: r.enabled,
    })
    setModalOpen(true)
    loadPlaybooks(r.domain || '')
  }

  // 按目录域加载控制节点上的可选 playbook（切换「目录域」时重新拉取）
  const loadPlaybooks = (domain: string) => {
    setPbLoading(true)
    listSysInitPlaybooks(domain)
      .then((d) => {
        setPbFiles(d.files || [])
        setPbNode(d.node || '')
      })
      .catch(() => {
        setPbFiles([])
        setPbNode('')
      })
      .finally(() => setPbLoading(false))
  }

  const submit = async () => {
    const v = await form.validateFields()
    setSubmitting(true)
    try {
      if (editing) {
        await updateSysInitCatalog(editing.id, v)
        message.success('已保存，部署向导中即刻生效')
      } else {
        await createSysInitCatalog(v)
        message.success('已新增初始化项，部署向导中即刻生效')
      }
      setModalOpen(false)
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  const remove = (r: SysInitCatalogItem) => {
    modal.confirm({
      title: `删除初始化项「${r.key}」？`,
      icon: <WarningOutlined style={{ color: '#faad14' }} />,
      content: r.custom ? (
        <Paragraph style={{ marginTop: 8 }}>
          这是<b>页面自定义</b>的初始化项，删除后不可恢复（控制节点上的 playbook 文件不受影响）。
        </Paragraph>
      ) : (
        <Paragraph style={{ marginTop: 8 }}>
          这是<b>内置</b>初始化项。删除后将从部署向导中移除，且重启不会自动恢复；
          如需找回，可点工具栏「同步内置目录」并勾选「同时恢复已删除的内置项」。
        </Paragraph>
      ),
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const d = await deleteSysInitCatalog(r.id)
        message.success(d.deleted === 'hard' ? '已删除' : '已删除（内置项已标记删除）')
        load()
      },
    })
  }

  const toggle = async (r: SysInitCatalogItem, enabled: boolean) => {
    try {
      await toggleSysInitCatalog(r.id, enabled)
      setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled } : x)))
      message.success(enabled ? '已启用' : '已停用')
    } catch {
      message.error('操作失败')
    }
  }

  const checkOne = async (r: SysInitCatalogItem) => {
    try {
      const d = await checkSysInitPlaybook(r.playbook, r.domain || '')
      const st: CheckState = { exists: d.exists, fullPath: d.fullPath, node: d.node, head: d.head }
      setChecks((prev) => ({ ...prev, [r.id]: st }))
      return st
    } catch (e: any) {
      const st: CheckState = { exists: false, err: e?.response?.data?.msg || '校验失败' }
      setChecks((prev) => ({ ...prev, [r.id]: st }))
      return st
    }
  }

  const checkAll = async () => {
    setChecking(true)
    let ok = 0
    let bad = 0
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      const st = await checkOne(r)
      if (st.exists) ok += 1
      else bad += 1
    }
    setChecking(false)
    if (bad === 0) message.success(`全部 ${ok} 个 playbook 在控制节点上均存在`)
    else message.warning(`${ok} 个存在，${bad} 个缺失或校验失败（见列表「校验」列）`)
  }

  const doSync = (restore: boolean) => {
    modal.confirm({
      title: restore ? '同步内置目录并恢复已删除的内置项？' : '同步内置目录？',
      content: restore ? (
        <Paragraph style={{ marginTop: 8 }}>
          将重新按控制节点真实脚本登记内置项，并把此前删除的内置项<b>恢复为启用</b>；页面自定义项不受影响。
        </Paragraph>
      ) : (
        <Paragraph style={{ marginTop: 8 }}>将补齐内置项（不覆盖页面上的修改与停用状态）。</Paragraph>
      ),
      okText: '开始同步',
      cancelText: '取消',
      onOk: async () => {
        const d = await syncSysInitCatalog(restore)
        message.success(`同步完成：共 ${d.total} 项，启用 ${d.enabled} 项${d.restored ? `，恢复 ${d.restored} 项` : ''}`)
        load()
      },
    })
  }

  const columns: ColumnsType<SysInitCatalogItem> = [
    {
      title: '排序',
      dataIndex: 'orderNo',
      width: 70,
      align: 'center',
      sorter: (a, b) => a.orderNo - b.orderNo,
      render: (v: number) => <Text type="secondary">{v}</Text>,
    },
    {
      title: '初始化项',
      dataIndex: 'key',
      width: 230,
      render: (v: string, r) => (
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>
            {v}
            {r.custom && (
              <Tag color="cyan" style={{ marginLeft: 6 }}>
                自定义
              </Tag>
            )}
          </div>
          {r.label && r.label !== v && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.label}</div>
          )}
        </div>
      ),
    },
    {
      title: '分组',
      dataIndex: 'group',
      width: 150,
      render: (v: string, r) => (
        <>
          <Tag color="blue">{v || '其他'}</Tag>
          {r.domain === 'gaussdb' && <Tag color="purple">GaussDB</Tag>}
        </>
      ),
    },
    {
      title: 'Playbook（相对所属域根目录）',
      dataIndex: 'playbook',
      render: (v: string, r) => {
        const st = checks[r.id]
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <code className="ct-code">{v}</code>
            {st &&
              (st.exists ? (
                <Tag color="green" icon={<CheckCircleOutlined />}>
                  存在
                </Tag>
              ) : (
                <Tag color="red" icon={<CloseCircleOutlined />}>
                  {st.err ? '校验失败' : '缺失'}
                </Tag>
              ))}
          </div>
        )
      },
    },
    {
      title: '变量契约',
      dataIndex: 'varMode',
      width: 190,
      render: (v: string, r) => {
        const m = MODE_LABEL[v] || MODE_LABEL.none
        return (
          <div>
            <Tag color={m.color}>{m.text}</Tag>
            {r.varMode === 'static' && r.varArgs && (
              <div style={{ marginTop: 4 }}>
                <code className="ct-code ct-code--line">{r.varArgs}</code>
              </div>
            )}
          </div>
        )
      },
    },
    {
      title: '支持环境',
      dataIndex: 'osTypes',
      width: 220,
      render: (_: string[], r) => (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {r.osTypes?.length ? (
            r.osTypes.map((o) => (
              <Tag key={o} style={{ marginRight: 0 }}>
                {o}
              </Tag>
            ))
          ) : (
            <Tag style={{ marginRight: 0 }}>全部 OS</Tag>
          )}
          {r.cpuTypes?.length ? (
            r.cpuTypes.map((c) => (
              <Tag key={c} color="purple" style={{ marginRight: 0 }}>
                {c}
              </Tag>
            ))
          ) : (
            <Tag color="purple" style={{ marginRight: 0 }}>
              全部 CPU
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 90,
      render: (v: boolean, r) => (
        <Switch
          checked={v}
          disabled={!canManage}
          checkedChildren="启用"
          unCheckedChildren="停用"
          onChange={(c) => toggle(r, c)}
        />
      ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 200,
      fixed: 'right',
      render: (_: unknown, r) => (
        <Space size={4}>
          <Tooltip title="校验该 playbook 在控制节点上是否存在">
            <Button
              size="small"
              type="text"
              icon={<SafetyOutlined />}
              onClick={() => checkOne(r)}
            />
          </Tooltip>
          <Tooltip title="查看 playbook 内容（控制节点）">
            <Button
              size="small"
              type="text"
              icon={<EyeOutlined />}
              onClick={async () => {
                const st = checks[r.id] || (await checkOne(r))
                setPeek({ item: r, state: st })
              }}
            />
          </Tooltip>
          {canManage && (
            <>
              <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(r)} />
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => remove(r)}
              />
            </>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div className="mw-cfg-page">
      {/* HERO */}
      <div className="mw-hero glass fade-up" style={{ marginBottom: 18 }}>
        <div className="mw-hero__glow" />
        <div className="mw-hero__mesh" />
        <div className="mw-hero__main">
          <div className="mw-hero__title">
            <CloudServerOutlined /> 系统初始化管理
          </div>
          <div className="mw-hero__desc">
            「应用中间件安装」向导第 01 步的可选项目录：每项对应控制节点系统初始化根目录下的一个 ansible
            playbook。内置项按控制节点真实脚本登记并可随版本同步；页面新增的自定义项会立即出现在部署向导中。
          </div>
        </div>
        <div className="mw-hero__chips">
          <div className="mw-chip">
            <div className="mw-chip__v">{stats.total}</div>
            <div className="mw-chip__l">初始化项</div>
          </div>
          <div className="mw-chip">
            <div className="mw-chip__v">{stats.on}</div>
            <div className="mw-chip__l">已启用</div>
          </div>
          <div className="mw-chip">
            <div className="mw-chip__v">{stats.custom}</div>
            <div className="mw-chip__l">自定义</div>
          </div>
          <div className="mw-chip">
            <div className="mw-chip__v">{stats.groups}</div>
            <div className="mw-chip__l">分组</div>
          </div>
          {canManage && (
            <Button type="primary" size="large" icon={<PlusOutlined />} onClick={openCreate}>
              新增初始化项
            </Button>
          )}
        </div>
      </div>

      {/* TOOLBAR */}
      <div className="mw-cfg-toolbar glass" style={{ flexWrap: 'wrap', gap: 12 }}>
        <Input
          prefix={<SearchOutlined style={{ color: 'var(--text-secondary)' }} />}
          placeholder="搜索 名称 / playbook / 说明"
          allowClear
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 240 }}
        />
        <div className="mw-cfg-filters">
          <span className="mw-cfg-filters__lbl">分组</span>
          <Tag.CheckableTag checked={groupFilter === 'all'} onChange={() => setGroupFilter('all')}>
            全部
          </Tag.CheckableTag>
          {groups.map((g) => (
            <Tag.CheckableTag key={g} checked={groupFilter === g} onChange={() => setGroupFilter(g)}>
              {g}
            </Tag.CheckableTag>
          ))}
        </div>
        <div className="mw-cfg-filters">
          <span className="mw-cfg-filters__lbl">状态</span>
          {(
            [
              { k: 'all', t: '全部' },
              { k: 'on', t: '已启用' },
              { k: 'off', t: '已停用' },
              { k: 'custom', t: '自定义' },
            ] as const
          ).map((f) => (
            <Tag.CheckableTag
              key={f.k}
              checked={statusFilter === f.k}
              onChange={() => setStatusFilter(f.k)}
            >
              {f.t}
            </Tag.CheckableTag>
          ))}
        </div>
        <Space style={{ marginLeft: 'auto' }}>
          <Button icon={<SafetyOutlined />} loading={checking} onClick={checkAll}>
            校验全部
          </Button>
          {canManage && (
            <Button icon={<CloudDownloadOutlined />} onClick={() => doSync(false)}>
              同步内置目录
            </Button>
          )}
          {canManage && (
            <Button icon={<SyncOutlined />} onClick={() => doSync(true)}>
              恢复已删除的内置项
            </Button>
          )}
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => navigate('/deploy')}>
            去部署
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message={
          <span>
            Playbook 根目录：
            <Text code>{dirs.system || '（未配置）'}</Text>
            <Text type="secondary">（系统初始化 SYSTEM_INIT_DIR）· GaussDB 域：</Text>
            <Text code>{dirs.gaussdb || '（未配置）'}</Text>
            <Text type="secondary">（GAUSSDB_INIT_DIR，均可在 docker-compose 环境变量中调整）</Text>
          </span>
        }
        description={
          <span style={{ fontSize: 12.5 }}>
            变量契约：<Tag color="geekblue">OS_TYPE</Tag> 与 <Tag color="purple">CPU_TYPE</Tag> 由平台对<b>每个任务统一透传</b>
            （区域内取值不一致时不下发，改由每台主机变量各自生效）·
            <Tag color="gold">固定变量</Tag> 额外透传固定参数（磁盘挂载、改密码等）·
            <Tag>无需变量</Tag> 脚本自包含。OS/CPU 按资产优先、探测兜底自动识别，无需手选。
          </span>
        }
      />

      {/* TABLE */}
      {loading ? (
        <div className="mw-cfg-loading glass">
          <Spin size="large" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="mw-cfg-empty glass">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              search || groupFilter !== 'all' || statusFilter !== 'all'
                ? '没有匹配的初始化项'
                : '暂无初始化项，点击右上角新增'
            }
          />
          {(search || groupFilter !== 'all' || statusFilter !== 'all') && (
            <Button
              style={{ marginTop: 12 }}
              onClick={() => {
                setSearch('')
                setGroupFilter('all')
                setStatusFilter('all')
              }}
            >
              清除筛选
            </Button>
          )}
        </div>
      ) : (
        <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
          <Table<SysInitCatalogItem>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={filtered}
            pagination={false}
            scroll={{ x: 1180 }}
          />
        </div>
      )}

      {/* 新增 / 编辑 */}
      <Modal
        open={modalOpen}
        title={editing ? `编辑初始化项：${editing.key}` : '新增初始化项'}
        width={720}
        onCancel={() => setModalOpen(false)}
        onOk={submit}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item
              name="key"
              label="选项名称（部署向导中勾选的就是它）"
              rules={[{ required: true, message: '请输入选项名称' }]}
              style={{ flex: 1 }}
            >
              <Input placeholder="如：配置NTP时间同步" />
            </Form.Item>
            <Form.Item name="group" label="分组" style={{ width: 170 }}>
              <AutoComplete
                options={groups.map((g) => ({ value: g }))}
                placeholder="如：基础配置"
                filterOption={(input, opt) => (opt?.value || '').includes(input)}
              />
            </Form.Item>
            <Form.Item
              name="domain"
              label="目录域"
              style={{ width: 150 }}
              tooltip="系统初始化=脚本在 system_init 目录；GaussDB=脚本在 gaussDB_init 目录"
            >
              <Select
                options={[
                  { value: '', label: '系统初始化' },
                  { value: 'gaussdb', label: 'GaussDB' },
                ]}
                onChange={(v: string) => loadPlaybooks(v || '')}
              />
            </Form.Item>
          </div>

          <Form.Item
            name="playbook"
            label="Playbook 路径（相对所属域根目录：系统初始化 system_init / GaussDB gaussDB_init）"
            rules={[
              { required: true, message: '请输入 playbook 相对路径' },
              {
                validator: (_, v: string) => {
                  const s = (v || '').trim()
                  if (!s) return Promise.resolve()
                  if (s.startsWith('/')) return Promise.reject(new Error('请填相对路径，如 yum-config/yum-config.yml'))
                  if (s.includes('..')) return Promise.reject(new Error('路径不允许包含 ..'))
                  return Promise.resolve()
                },
              },
            ]}
          >
            <Input
              placeholder="例如 yum-config/yum-config.yml"
              addonBefore={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {(domainWatch === 'gaussdb' ? dirs.gaussdb : dirs.system) || '/'}
                </Text>
              }
              addonAfter={
                pbLoading ? (
                  <Spin size="small" />
                ) : (
                  <Select
                    variant="borderless"
                    value={undefined}
                    placeholder={`控制节点可选 ${pbFiles.length} 个`}
                    style={{ width: 190 }}
                    popupMatchSelectWidth={false}
                    onChange={(v: string) => form.setFieldValue('playbook', v)}
                    options={pbFiles.map((f) => ({ value: f, label: f }))}
                    disabled={pbFiles.length === 0}
                    notFoundContent={pbNode ? `${pbNode} 不可达或目录为空` : '控制节点不可达'}
                  />
                )
              }
            />
          </Form.Item>

          <Form.Item name="desc" label="说明">
            <Input placeholder="一句话说明这项初始化做什么（展示在向导中）" />
          </Form.Item>

          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="varMode" label="变量契约（决定向 playbook 传什么）" style={{ flex: 1 }}>
              <Select options={VAR_MODES.map((m) => ({ value: m.value, label: m.label }))} />
            </Form.Item>
            <Form.Item name="orderNo" label="排序" style={{ width: 110 }}>
              <InputNumber min={0} max={9999} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked" style={{ width: 90 }}>
              <Switch checkedChildren="是" unCheckedChildren="否" />
            </Form.Item>
          </div>

          <Form.Item name="varArgs" label="固定变量（变量契约选「固定变量」时必填）"
            rules={
              varMode === 'static'
                ? [{ required: true, message: '固定变量模式必须填写参数' }]
                : []
            }
          >
            <Input
              placeholder="例如 DISK_DIR=data FORMAT_TYPE=ext4"
              disabled={varMode !== 'static'}
            />
          </Form.Item>

          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="osTypes" label="支持的操作系统（留空=全部）" style={{ flex: 1 }}>
              <Select
                mode="multiple"
                allowClear
                placeholder="留空表示全部 OS 通用"
                options={osTokens.map((o) => ({ value: o, label: o }))}
              />
            </Form.Item>
            <Form.Item name="cpuTypes" label="支持的 CPU 架构（留空=全部）" style={{ flex: 1 }}>
              <Select
                mode="multiple"
                allowClear
                placeholder="留空表示全部 CPU 通用"
                options={cpuTokens.map((c) => ({ value: c, label: c }))}
              />
            </Form.Item>
          </div>

          {(() => {
            const m = VAR_MODES.find((x) => x.value === (varMode || 'none'))
            const pb = form.getFieldValue('playbook') || '<playbook>'
            const isGauss = domainWatch === 'gaussdb'
            const rootDir =
              (isGauss ? dirs.gaussdb : dirs.system) || (isGauss ? '<GAUSSDB_INIT_DIR>' : '<SYSTEM_INIT_DIR>')
            // 平台对每个任务统一透传 hosts + OS_TYPE / CPU_TYPE（与 Jenkins 的
            // `-e 'hosts=xxx CPU_TYPE=x86_64'` 一致）；「固定变量」再追加任务自身的 VarArgs。
            const args = ['hosts=sysinit_targets', 'OS_TYPE=<自动识别>', 'CPU_TYPE=<自动识别>']
            if (m?.value === 'static') {
              const va = form.getFieldValue('varArgs')
              if (va) args.push(va)
            }
            return (
              <div className="ct-preview">
                <div className="ct-preview__title">
                  <CodeOutlined /> 执行预览
                </div>
                <pre className="ct-pre">{`ansible-playbook ${rootDir}/${pb} -i <临时inventory> -e "${args.join(' ')}"`}</pre>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  {m?.hint}
                </div>
              </div>
            )
          })()}
        </Form>
      </Modal>

      {/* playbook 内容预览 */}
      <Drawer
        open={!!peek}
        onClose={() => setPeek(null)}
        width={680}
        title={
          peek && (
            <span>
              <CodeOutlined /> {peek.item.playbook}
            </span>
          )
        }
      >
        {peek && (
          <>
            <Space wrap style={{ marginBottom: 12 }}>
              {peek.state.exists ? (
                <Tag color="green" icon={<CheckCircleOutlined />}>
                  控制节点存在
                </Tag>
              ) : (
                <Tag color="red" icon={<CloseCircleOutlined />}>
                  不存在 / 无法读取
                </Tag>
              )}
              {peek.state.node && <Tag>{peek.state.node}</Tag>}
            </Space>
            <Paragraph copyable={{ text: peek.state.fullPath }} style={{ fontSize: 12 }}>
              <Text code>{peek.state.fullPath}</Text>
            </Paragraph>
            {peek.state.err && <Alert type="error" showIcon message={peek.state.err} />}
            {peek.state.head ? (
              <div className="ct-preview">
                <div className="ct-preview__title">文件头部（前 60 行）</div>
                <pre className="ct-pre" style={{ maxHeight: 460, overflow: 'auto' }}>
                  {peek.state.head}
                </pre>
              </div>
            ) : (
              !peek.state.err && <Empty description="无内容" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
            <Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
              变量契约：{MODE_LABEL[peek.item.varMode]?.text}。
              {peek.item.varMode === 'static' && `固定变量：${peek.item.varArgs}`}
            </Paragraph>
          </>
        )}
      </Drawer>
    </div>
  )
}
