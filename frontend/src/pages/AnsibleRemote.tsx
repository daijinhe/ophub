import { useEffect, useMemo, useState } from 'react'
import {
  Card,
  Button,
  Space,
  Table,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Segmented,
  Popconfirm,
  Typography,
  Tabs,
  App,
  Alert,
  Tag,
  Tooltip,
  Drawer,
  Descriptions,
  Empty,
  Collapse,
  Pagination,
  message as antdMessage,
} from 'antd'
import {
  PlusOutlined,
  SaveOutlined,
  DeleteOutlined,
  EditOutlined,
  CodeOutlined,
  TableOutlined,
  CloudServerOutlined,
  ImportOutlined,
  ApiOutlined,
  ReloadOutlined,
  SettingOutlined,
  PlayCircleOutlined,
  InfoCircleOutlined,
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  MinusCircleOutlined,
} from '@ant-design/icons'
import api from '../api/client'
import { useAuth } from '../store/AuthContext'

const { Text, Paragraph } = Typography
const { TextArea } = Input

// ---------- 类型 ----------
interface AnsibleHost {
  ip: string
  vars: Record<string, string>
  comment?: string
}
interface AnsibleGroup {
  name: string
  hosts: AnsibleHost[]
}
interface AnsibleFile {
  groups: AnsibleGroup[]
  rawTop?: string
  rawTail?: string
}
interface CmdbAssetItem {
  id: number
  name: string
  ip: string
  fields: Record<string, any>
}
interface AnsibleRemote {
  id: number
  name: string
  host: string
  port: number
  user: string
  authType: 'password' | 'key'
  hostsPath: string
  description?: string
  networkZone?: string
  status: 'online' | 'offline' | 'unknown'
  lastCheckAt?: string
  lastError?: string
  hasPassword?: boolean
  hasKey?: boolean
  hasBecome?: boolean
}
interface AnsibleInfo {
  ansibleVersion?: string
  configFile?: string
  pythonVersion?: string
  hostsPath?: string
  playbookDirs?: string[]
}

// 主机是否命中关键字（匹配 IP / 备注 / 任意变量名或变量值）
const hostMatches = (h: AnsibleHost, kw: string) => {
  if (!kw) return true
  if (h.ip.toLowerCase().includes(kw)) return true
  if ((h.comment || '').toLowerCase().includes(kw)) return true
  return Object.entries(h.vars || {}).some(
    ([k, v]) => k.toLowerCase().includes(kw) || String(v).toLowerCase().includes(kw),
  )
}

// replaceTpl 用资产字段替换备注模板占位符 {字段名}
const replaceTpl = (tpl: string, fields: Record<string, any>): string => {
  if (!tpl) return ''
  let out = tpl
  Object.entries(fields || {}).forEach(([k, v]) => {
    out = out.split(`{${k}}`).join(String(v ?? ''))
  })
  return out
}

// 根据当前选中节点生成 API 路径
// 本页面只管远端节点 —— 本机 ansible 管理走独立的 /ansible/local 页（见 AnsibleLocal.tsx），
// 后端对应端点 /ansible/remotes/:id/* 与 /ansible/local/* 是完全分开的。
function ep(nodeId: string, sub: string) {
  return `/ansible/remotes/${nodeId}${sub}`
}

export default function Ansible() {
  const { hasPerm } = useAuth()
  const { message, modal } = App.useApp()

  // 远端节点的 hosts 文件是「整体保存」（PUT /ansible/remotes/:id/hosts），后端按 ansible:remote:update
  // 收口，因此分组/主机的新增与删除也走 update；从 CMDB 导入是独立端点，后端单独用 ansible:remote:create。

  // 节点
  const [nodes, setNodes] = useState<AnsibleRemote[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string>('')
  const [nodeManageOpen, setNodeManageOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [info, setInfo] = useState<AnsibleInfo | null>(null)
  const [infoLoading, setInfoLoading] = useState(false)
  const [testing, setTesting] = useState(false)

  // 当前节点的 hosts
  const [file, setFile] = useState<AnsibleFile | null>(null)
  const [path, setPath] = useState('')
  const [readErr, setReadErr] = useState('')
  const [loading, setLoading] = useState(false)

  // 分组 / 主机弹窗
  const [groupModal, setGroupModal] = useState(false)
  const [hostModal, setHostModal] = useState<{ group: string; idx: number | null } | null>(null)
  const [hostForm] = Form.useForm()
  const [groupForm] = Form.useForm()
  const [hostMode, setHostMode] = useState<'manual' | 'asset'>('manual')
  const [cmdbAssets, setCmdbAssets] = useState<CmdbAssetItem[]>([])

  // 搜索（任意字段匹配）与折叠状态
  const [searchInput, setSearchInput] = useState('')
  const [searchKw, setSearchKw] = useState('')
  const [openKeys, setOpenKeys] = useState<string[]>([])
  // 分组分页：分组很多时一次最多渲染 GROUP_PAGE_SIZE 个，避免 DOM 爆炸
  const [groupPage, setGroupPage] = useState(1)
  const GROUP_PAGE_SIZE = 20

  // 搜索防抖：停止输入 250ms 后才执行过滤渲染，避免每敲一个字符就整页重渲染
  useEffect(() => {
    const t = setTimeout(() => setSearchKw(searchInput.trim()), 250)
    return () => clearTimeout(t)
  }, [searchInput])

  // 原始编辑
  const [rawOpen, setRawOpen] = useState(false)
  const [rawText, setRawText] = useState('')

  // 从 CMDB 导入
  const [importOpen, setImportOpen] = useState(false)
  const [importForm] = Form.useForm()

  // 节点编辑表单
  const [nodeForm] = Form.useForm()
  const [nodeModal, setNodeModal] = useState<{ mode: 'create' | 'edit'; node?: AnsibleRemote } | null>(null)

  // 执行命令
  const [execOpen, setExecOpen] = useState(false)
  const [execForm] = Form.useForm()
  const [execOutput, setExecOutput] = useState('')
  const [execRunning, setExecRunning] = useState(false)

  // 当前选中节点（本地为 null）
  const selectedNode = useMemo(
    () => (selectedNodeId ? nodes.find((n) => String(n.id) === selectedNodeId) || null : null),
    [nodes, selectedNodeId],
  )

  // ----- 节点相关 -----
  const loadNodes = () => {
    api
      .get('/ansible/remotes')
      .then((r) => {
        const list: AnsibleRemote[] = r.data.data.list || []
        setNodes(list)
        // 当前没有选中或选中已失效时，自动选中第一个节点
        setSelectedNodeId((cur) => {
          if (!cur || !list.some((n) => String(n.id) === cur)) {
            return list.length ? String(list[0].id) : ''
          }
          return cur
        })
      })
      .catch(() => setNodes([]))
  }
  useEffect(loadNodes, [])

  const load = () => {
    if (!selectedNodeId) {
      // 未选择节点：清空视图，不发请求
      setFile({ groups: [] })
      setPath('')
      setReadErr('')
      setLoading(false)
      return
    }
    setLoading(true)
    setReadErr('')
    api
      .get(ep(selectedNodeId, '/hosts'))
      .then((r) => {
        const d = r.data.data
        setFile(d.file)
        setPath(d.path)
        if (d.error) setReadErr(d.error)
      })
      .catch((e) => {
        message.error(e.response?.data?.msg || '加载失败')
        setFile({ groups: [] })
        setPath('')
      })
      .finally(() => setLoading(false))
  }
  useEffect(load, [selectedNodeId])

  const save = (f: AnsibleFile) => {
    api
      .put(ep(selectedNodeId, '/hosts'), { file: f })
      .then(() => {
        message.success('已保存')
        load()
      })
      .catch((e) => message.error(e.response?.data?.msg || '保存失败'))
  }

  const handleTest = () => {
    if (!selectedNodeId) {
      antdMessage.info('请先选择节点')
      return
    }
    setTesting(true)
    api
      .post(`/ansible/remotes/${selectedNodeId}/test`)
      .then((r) => {
        message.success('连接成功')
        Modal.info({
          title: '连接成功',
          width: 640,
          content: (
            <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>
              {r.data.data.output}
            </pre>
          ),
        })
        loadNodes()
      })
      .catch((e) => {
        message.error(e.response?.data?.msg || '连接失败')
        loadNodes()
      })
      .finally(() => setTesting(false))
  }

  const openInfo = () => {
    if (!selectedNodeId) {
      antdMessage.info('请先选择节点')
      return
    }
    setInfoOpen(true)
    setInfoLoading(true)
    api
      .get(`/ansible/remotes/${selectedNodeId}/info`)
      .then((r) => setInfo(r.data.data))
      .catch((e) => {
        message.error(e.response?.data?.msg || '获取失败')
        setInfoOpen(false)
      })
      .finally(() => setInfoLoading(false))
  }

  // ----- 分组操作 -----
  const addGroup = (name: string) => {
    if (!name) return
    const f = file ? JSON.parse(JSON.stringify(file)) : { groups: [] }
    if (f.groups.some((g: AnsibleGroup) => g.name === name)) {
      message.warning('分组已存在')
      return
    }
    f.groups.push({ name, hosts: [] })
    save(f)
    setGroupModal(false)
    groupForm.resetFields()
  }
  const removeGroup = (name: string) => {
    const f = JSON.parse(JSON.stringify(file)) as AnsibleFile
    f.groups = f.groups.filter((g) => g.name !== name)
    save(f)
  }
  const removeHost = (group: string, idx: number) => {
    const f = JSON.parse(JSON.stringify(file)) as AnsibleFile
    const g = f.groups.find((x) => x.name === group)!
    g.hosts.splice(idx, 1)
    save(f)
  }

  // ----- 主机操作 -----
  const openHost = (group: string, idx: number | null) => {
    setHostModal({ group, idx })
    if (idx !== null) {
      const h = file!.groups.find((g) => g.name === group)!.hosts[idx]
      hostForm.setFieldsValue({
        ip: h.ip,
        comment: h.comment,
        port: h.vars['ansible_ssh_port'] || '',
        sshUser: h.vars['ansible_ssh_user'] || '',
        sshPass: h.vars['ansible_ssh_pass'] || '',
        becomePass: h.vars['ansible_become_pass'] || '',
      })
      setHostMode('manual')
    } else {
      hostForm.resetFields()
      hostForm.setFieldsValue({
        port: '65181',
        sshUser: 'centos',
        sshPass: '',
        becomePass: '',
      })
      setHostMode('manual')
      api
        .get('/ansible/cmdb-assets')
        .then((r) => setCmdbAssets(r.data.data.assets || []))
        .catch(() => setCmdbAssets([]))
    }
  }
  const submitHost = (values: any) => {
    const f = JSON.parse(JSON.stringify(file)) as AnsibleFile
    const g = f.groups.find((x) => x.name === hostModal!.group)!
    const isEdit = hostModal!.idx !== null
    const vars: Record<string, string> = {}
    if (values.port) vars['ansible_ssh_port'] = String(values.port)
    if (values.sshUser) vars['ansible_ssh_user'] = values.sshUser
    if (values.sshPass) vars['ansible_ssh_pass'] = values.sshPass
    if (values.becomePass) vars['ansible_become_pass'] = values.becomePass

    // 编辑模式：直接替换该索引的主机（修复旧逻辑误走“新增”导致无法编辑的问题）
    if (isEdit) {
      g.hosts[hostModal!.idx!] = { ip: values.ip, comment: values.comment || '', vars: { ...vars } }
      save(f)
      message.success('已更新')
      setHostModal(null)
      return
    }

    let addrs: { ip: string; comment: string }[] = []
    if (hostMode === 'asset') {
      const ids: number[] = values.assetIds || []
      addrs = ids
        .map((id: number) => {
          const a = cmdbAssets.find((x) => x.id === id)
          return { ip: a?.ip || '', comment: replaceTpl(values.commentTpl || '', a?.fields || {}) }
        })
        .filter((x) => x.ip)
    } else {
      const raw = values.ips || ''
      const ips = String(raw)
        .split(/[\n,，\s]+/)
        .map((s: string) => s.trim())
        .filter(Boolean)
      addrs = ips.map((ip: string) => ({ ip, comment: values.commentTpl || '' }))
    }

    const existing = new Set(g.hosts.map((h) => h.ip))
    let added = 0
    for (const a of addrs) {
      if (existing.has(a.ip)) continue
      g.hosts.push({ ip: a.ip, comment: a.comment, vars: { ...vars } })
      existing.add(a.ip)
      added++
    }
    if (added === 0) {
      message.warning('没有新增主机（可能已存在或地址为空）')
      return
    }
    message.success(`已添加 ${added} 台主机`)
    save(f)
    setHostModal(null)
  }

  // ----- 原始编辑 -----
  const openRaw = () => {
    api.get(ep(selectedNodeId, '/hosts/raw')).then((r) => {
      setRawText(r.data.data.content || '')
      setRawOpen(true)
    })
  }
  const saveRaw = () => {
    api
      .post(ep(selectedNodeId, '/hosts/raw'), { content: rawText })
      .then(() => {
        message.success('已保存')
        setRawOpen(false)
        load()
      })
      .catch((e) => message.error(e.response?.data?.msg || '保存失败'))
  }

  // ----- 从 CMDB 导入 -----
  const submitImport = (values: any) => {
    const payload = {
      group: values.group,
      port: values.port ? String(values.port) : '',
      sshUser: values.sshUser,
      sshPass: values.sshPass,
      becomePass: values.becomePass,
      commentTpl: values.commentTpl,
      categoryId: values.categoryId || null,
    }
    api
      .post(ep(selectedNodeId, '/import-cmdb'), payload)
      .then((r) => {
        message.success(`已导入 ${r.data.data.added} 台到分组 [${r.data.data.group}]`)
        setImportOpen(false)
        importForm.resetFields()
        load()
      })
      .catch((e) => message.error(e.response?.data?.msg || '导入失败'))
  }

  // ----- 节点管理 -----
  const openNodeModal = (mode: 'create' | 'edit', node?: AnsibleRemote) => {
    setNodeModal({ mode, node })
    if (mode === 'edit' && node) {
      api.get(`/ansible/remotes/${node.id}`).then((r) => {
        const d = r.data.data
        nodeForm.setFieldsValue({
          name: d.name,
          host: d.host,
          port: d.port,
          user: d.user,
          authType: d.authType,
          hostsPath: d.hostsPath,
          networkZone: d.networkZone || undefined,
          description: d.description,
          password: '',
          privateKey: '',
          becomePass: '',
        })
      })
    } else {
      nodeForm.resetFields()
      nodeForm.setFieldsValue({ port: 65181, user: 'centos', authType: 'password', hostsPath: '/etc/ansible/hosts' })
    }
  }
  const submitNode = (values: any) => {
    const payload = { ...values, port: Number(values.port) || 22 }
    const promise =
      nodeModal?.mode === 'edit' && nodeModal.node
        ? api.put(`/ansible/remotes/${nodeModal.node.id}`, payload)
        : api.post('/ansible/remotes', payload)
    promise
      .then(() => {
        message.success('已保存')
        setNodeModal(null)
        loadNodes()
      })
      .catch((e) => message.error(e.response?.data?.msg || '保存失败'))
  }
  const removeNode = (n: AnsibleRemote) => {
    api
      .delete(`/ansible/remotes/${n.id}`)
      .then(() => {
        message.success('已删除')
        loadNodes()
      })
      .catch((e) => message.error(e.response?.data?.msg || '删除失败'))
  }
  const quickTest = (n: AnsibleRemote) => {
    api
      .post(`/ansible/remotes/${n.id}/test`)
      .then((r) => {
        message.success(`[${n.name}] 连接成功`)
        Modal.info({
          title: `[${n.name}] 连接成功`,
          width: 640,
          content: (
            <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>
              {r.data.data.output}
            </pre>
          ),
        })
        loadNodes()
      })
      .catch((e) => {
        message.error(`[${n.name}] ${e.response?.data?.msg || '连接失败'}`)
        loadNodes()
      })
  }

  // ----- 执行命令 -----
  const submitExec = (values: any) => {
    setExecRunning(true)
    setExecOutput('执行中...')
    api
      .post(`/ansible/remotes/${selectedNodeId}/exec`, { command: values.command })
      .then((r) => {
        const out = r.data.data.stdout || ''
        const err = r.data.data.error || ''
        setExecOutput((err ? `[stderr]\n${err}\n` : '') + (out || '(无输出)'))
      })
      .catch((e) => {
        setExecOutput(`请求失败: ${e.response?.data?.msg || e.message}`)
      })
      .finally(() => setExecRunning(false))
  }

  const totalHosts = useMemo(
    () => (file ? file.groups.reduce((s, g) => s + g.hosts.length, 0) : 0),
    [file],
  )

  // 搜索过滤后的分组视图（以分组为单位展示，保留分组内增删改查能力）：
  // 分组名命中 → 整组保留；否则只保留命中的主机；两者都不命中则剔除
  const visibleGroups = useMemo(() => {
    const kw = searchKw.trim().toLowerCase()
    if (!kw) return file?.groups || []
    return (file?.groups || [])
      .map((g) => {
        const nameHit = g.name.toLowerCase().includes(kw)
        return nameHit ? g : { ...g, hosts: g.hosts.filter((h) => hostMatches(h, kw)) }
      })
      .filter((g) => g.name.toLowerCase().includes(kw) || g.hosts.length > 0)
  }, [file, searchKw])

  // 命中统计（搜索态）
  const searchStats = useMemo(() => {
    const kw = searchKw.trim().toLowerCase()
    if (!kw) return null
    const hosts = visibleGroups.reduce((s, g) => s + g.hosts.length, 0)
    return { groups: visibleGroups.length, hosts }
  }, [searchKw, visibleGroups])

  // 当前页要展示的分组（分页切片）
  const shownGroups = useMemo(() => {
    const start = (groupPage - 1) * GROUP_PAGE_SIZE
    return visibleGroups.slice(start, start + GROUP_PAGE_SIZE)
  }, [visibleGroups, groupPage, GROUP_PAGE_SIZE])

  // 文件/搜索词变化时：重置分组分页到第 1 页
  useEffect(() => {
    setGroupPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, searchKw])

  // 展开状态：搜索时默认只展开第一个命中分组（避免全部展开导致卡顿），其余按需点开；
  // 非搜索时默认展开第一个分组；用户手动展开的保留
  useEffect(() => {
    setOpenKeys((prev) => {
      const kw = searchKw.trim().toLowerCase()
      const list = kw ? visibleGroups : file?.groups || []
      if (!list.length) return []
      // 仅当当前展开集为空、或包含已不存在的分组名时才重置为第一个
      const valid = prev.filter((k) => list.some((g) => g.name === k))
      if (valid.length) return valid
      return [list[0].name]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, searchKw])

  const statusIcon = (s?: string) => {
    if (s === 'online') return <CheckCircleTwoTone twoToneColor="#52c41a" />
    if (s === 'offline') return <CloseCircleTwoTone twoToneColor="#ff4d4f" />
    return <MinusCircleOutlined style={{ color: '#999' }} />
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            远端 Ansible 管理
          </Typography.Title>
          <Space size={6} wrap style={{ marginTop: 4 }}>
            <Text type="secondary">当前节点：</Text>
            {!selectedNodeId ? (
              <Tag>未选择节点</Tag>
            ) : (
              <Tag color="purple" icon={statusIcon(selectedNode?.status)}>
                {selectedNode?.name || '未知'}
                {selectedNode?.status === 'online' && ' · online'}
                {selectedNode?.status === 'offline' && ' · offline'}
                {(!selectedNode?.status || selectedNode?.status === 'unknown') && ' · unknown'}
              </Tag>
            )}
            {selectedNode && (
              <Text type="secondary">
                {selectedNode.user}@{selectedNode.host}:{selectedNode.port}
              </Text>
            )}
          </Space>
        </div>
        <Space wrap>
          <Select
            value={selectedNodeId}
            onChange={setSelectedNodeId}
            style={{ minWidth: 220 }}
            placeholder="选择节点"
            options={nodes.map((n) => ({
              value: String(n.id),
              label: (
                <span>
                  {statusIcon(n.status)} {n.name} <Text type="secondary" style={{ fontSize: 12 }}>({n.host})</Text>
                </span>
              ),
            }))}
          />
          <Tooltip title="刷新当前节点的 hosts">
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading} />
          </Tooltip>
          {hasPerm('ansible:remote:exec') && (
            <Button icon={<ApiOutlined />} loading={testing} disabled={!selectedNodeId} onClick={handleTest}>
              测试连接
            </Button>
          )}
          <Button icon={<InfoCircleOutlined />} disabled={!selectedNodeId} onClick={openInfo}>
            节点信息
          </Button>
          {/* 连通性测试与执行命令都是「执行」语义 → ansible:remote:exec
              （后端 /ansible/remotes/:id/exec 另有 admin 角色要求） */}
          {hasPerm('ansible:remote:exec') && (
            <Button icon={<PlayCircleOutlined />} disabled={!selectedNodeId} onClick={() => setExecOpen(true)}>
              执行命令
            </Button>
          )}
          <Button icon={<SettingOutlined />} onClick={() => setNodeManageOpen(true)}>
            节点管理
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={
          <Space wrap>
            <span>hosts 路径：</span>
            <Tag color="blue">{path || '(未加载)'}</Tag>
            <span>共</span>
            <strong>{file?.groups.length || 0}</strong>
            <span>个分组，</span>
            <strong>{totalHosts}</strong>
            <span>台主机</span>
          </Space>
        }
      />

      <Tabs
        defaultActiveKey="groups"
        items={[
          {
            key: 'groups',
            label: (
              <span>
                <TableOutlined /> 分组视图
              </span>
            ),
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={16}>
                <Space wrap>
                  <Input.Search
                    allowClear
                    placeholder="搜索 IP / 分组 / 端口 / 用户 / 密码 / 备注"
                    style={{ width: 300 }}
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                  />
                  {searchStats && <Tag color="geekblue">命中 {searchStats.groups} 组 / {searchStats.hosts} 台</Tag>}
                  {/* hosts 写操作按后端收口：整体保存 PUT /hosts 与原始编辑 POST /hosts/raw 用 ansible:remote:update，
                      从 CMDB 导入是独立端点 POST /import-cmdb，后端用的是 ansible:remote:create */}
                  {hasPerm('ansible:remote:update') && (
                    <Button icon={<PlusOutlined />} onClick={() => { groupForm.resetFields(); setGroupModal(true) }}>
                      新增分组
                    </Button>
                  )}
                  {hasPerm('ansible:remote:create') && (
                    <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
                      从 CMDB 导入
                    </Button>
                  )}
                  {hasPerm('ansible:remote:update') && (
                    <Button icon={<CodeOutlined />} onClick={openRaw}>
                      原始编辑
                    </Button>
                  )}
                </Space>
                {file && file.groups.length === 0 && (
                  <Card>
                    {readErr ? (
                      <Space direction="vertical" size={6}>
                        <Text type="danger">读取 hosts 失败：{readErr}</Text>
                        <Text type="secondary">
                          可能原因与处理：① sudo 密码错误——sudo 默认问的是「当前 SSH 用户」的密码（通常与 SSH 密码相同），而不是 root 的密码；
                          ② 该用户未配 sudo 提权——可到「节点管理」编辑节点，将 hosts 路径改为该用户能直接读的路径（如 ~/ansible/hosts），或由运维在服务器上配置 NOPASSWD sudo；
                          ③ hosts 文件路径不对——点「节点管理」编辑节点，调整「hosts 路径」。
                        </Text>
                      </Space>
                    ) : nodes.length === 0 ? (
                      <Space direction="vertical" size={4}>
                        <Text type="secondary">还没有注册任何远程节点。要管理你服务器上的 ansible hosts：</Text>
                        <Text>
                          ① 点右上角「节点管理」→「新增节点」，填写服务器信息（SSH 主机、端口、用户、SSH 密码、sudo 密码）→ 保存后点「测试连接」确认在线；
                        </Text>
                        <Text>
                          ② 保存后本页面会自动切换到该节点，即可查看 / 增删改查它的分组与主机。
                        </Text>
                      </Space>
                    ) : (
                      <Text type="secondary">
                        当前节点暂无分组。若要管理其他服务器，请从顶部节点下拉切换；或点击「新增分组」开始。
                      </Text>
                    )}
                  </Card>
                )}
                {file && file.groups.length > 0 && searchStats && visibleGroups.length === 0 && (
                  <Card>
                    <Text type="secondary">没有匹配「{searchKw}」的分组或主机，试试其他关键字（IP / 分组名 / 端口 / 用户 / 备注）。</Text>
                  </Card>
                )}
                {file && file.groups.length > 0 && visibleGroups.length > 0 && (
                  <>
                    {visibleGroups.length > GROUP_PAGE_SIZE && (
                      <Pagination
                        current={groupPage}
                        pageSize={GROUP_PAGE_SIZE}
                        total={visibleGroups.length}
                        showSizeChanger={false}
                        showTotal={(t) => `共 ${t} 组`}
                        onChange={setGroupPage}
                        size="small"
                      />
                    )}
                    <Collapse
                      activeKey={openKeys}
                      onChange={(keys) => setOpenKeys(keys as string[])}
                      items={shownGroups.map((g) => ({
                      key: g.name,
                      label: (
                        <Space>
                          <CloudServerOutlined />
                          <Text strong>[{g.name}]</Text>
                          <Tag>{g.hosts.length} 台</Tag>
                        </Space>
                      ),
                      extra: (
                        <Space onClick={(e) => e.stopPropagation()}>
                          {hasPerm('ansible:remote:update') && (
                            <Button size="small" type="link" icon={<PlusOutlined />} onClick={() => openHost(g.name, null)}>
                              添加主机
                            </Button>
                          )}
                          {hasPerm('ansible:remote:update') && (
                            <Popconfirm title="确认删除该分组及其所有主机？" onConfirm={() => removeGroup(g.name)}>
                              <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                                删除分组
                              </Button>
                            </Popconfirm>
                          )}
                        </Space>
                      ),
                      children: (
                        <Table<AnsibleHost>
                          size="small"
                          rowKey={(r) => r.ip + JSON.stringify(r.vars)}
                          dataSource={g.hosts}
                          pagination={{
                            pageSize: 15,
                            size: 'small',
                            showSizeChanger: false,
                            showTotal: (t) => `共 ${t} 台`,
                          }}
                          columns={[
                            { title: '主机/IP', dataIndex: 'ip', width: 160, render: (v) => <Text code>{v}</Text> },
                            {
                              title: '连接变量',
                              dataIndex: 'vars',
                              render: (vars: Record<string, string>) =>
                                Object.entries(vars).map(([k, v]) => (
                                  <Tag key={k} style={{ marginBottom: 4 }}>
                                    {k}={v}
                                  </Tag>
                                )),
                            },
                            { title: '备注', dataIndex: 'comment', render: (v) => v || '-' },
                            {
                              title: '操作',
                              width: 120,
                              render: (_: any, _row: AnsibleHost, idx: number) => (
                                <Space>
                                  {hasPerm('ansible:remote:update') && (
                                    <Button size="small" type="link" onClick={() => openHost(g.name, idx)}>
                                      编辑
                                    </Button>
                                  )}
                                  {hasPerm('ansible:remote:update') && (
                                    <Popconfirm title="删除该主机？" onConfirm={() => removeHost(g.name, idx)}>
                                      <Button size="small" type="link" danger>
                                        删除
                                      </Button>
                                    </Popconfirm>
                                  )}
                                </Space>
                              ),
                            },
                          ]}
                        />
                      ),
                    }))}
                  />
                  </>
                )}
              </Space>
            ),
          },
        ]}
      />

      {/* 分组新增 */}
      <Modal title="新增分组" open={groupModal} onCancel={() => setGroupModal(false)} onOk={() => groupForm.submit()}>
        <Form form={groupForm} onFinish={(v) => addGroup(v.name)}>
          <Form.Item name="name" label="分组名" rules={[{ required: true, message: '请输入分组名' }]}>
            <Input placeholder="如：人才体系建设-测试前端" />
          </Form.Item>
          <Text type="secondary">将生成 [分组名] 段，可手动添加或从 CMDB 导入主机。</Text>
        </Form>
      </Modal>

      {/* 主机添加/编辑 */}
      <Modal
        title={hostModal?.idx === null ? '添加主机' : '编辑主机'}
        open={!!hostModal}
        onCancel={() => setHostModal(null)}
        onOk={() => hostForm.submit()}
        width={620}
      >
        <Form form={hostForm} layout="vertical" onFinish={submitHost}>
          {hostModal?.idx === null && (
            <Form.Item label="来源">
              <Segmented
                value={hostMode}
                onChange={(v) => setHostMode(v as 'manual' | 'asset')}
                options={[
                  { label: '手工输入', value: 'manual' },
                  { label: '从资产选择', value: 'asset' },
                ]}
              />
            </Form.Item>
          )}

          {hostModal?.idx === null && hostMode === 'manual' ? (
            <Form.Item
              name="ips"
              label="主机地址 (每行一个 IP / 域名，或用逗号、空格分隔)"
              rules={[{ required: true, message: '请输入至少一个主机地址' }]}
            >
              <TextArea
                autoSize={{ minRows: 3, maxRows: 8 }}
                placeholder={'198.51.100.62\n198.51.100.63\nweb.example.com'}
              />
            </Form.Item>
          ) : hostModal?.idx === null && hostMode === 'asset' ? (
            <Form.Item
              name="assetIds"
              label="选择资产（取其「虚拟机IPv4」作为主机地址）"
              rules={[{ required: true, message: '请选择至少一个资产' }]}
            >
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="label"
                placeholder="可搜索 应用系统名称 / IP"
                options={cmdbAssets.map((a) => ({ label: `${a.name} (${a.ip})`, value: a.id }))}
              />
            </Form.Item>
          ) : (
            <Form.Item name="ip" label="主机地址 (IP / 域名)" rules={[{ required: true, message: '请输入主机地址' }]}>
              <Input placeholder="如：198.51.100.62" />
            </Form.Item>
          )}

          <Form.Item label="SSH 端口" name="port">
            <Input placeholder="22 或 65181" />
          </Form.Item>
          <Form.Item label="SSH 用户" name="sshUser">
            <Input placeholder="centos" />
          </Form.Item>
          <Form.Item label="SSH 密码" name="sshPass">
            <Input.Password placeholder="ansible_ssh_pass" />
          </Form.Item>
          <Form.Item label="root 密码" name="becomePass" extra="对应 hosts 里的 ansible_become_pass（提权到 root 用的密码）">
            <Input.Password placeholder="ansible_become_pass" />
          </Form.Item>

          {hostModal?.idx === null ? (
            <Form.Item
              name="commentTpl"
              label="备注模板"
              tooltip="本次添加的所有主机共用；从资产选择时支持 {字段名} 占位，如 {应用系统名称}"
            >
              <Input placeholder="如：{应用系统名称} 或 固定备注文本" />
            </Form.Item>
          ) : (
            <Form.Item name="comment" label="备注 (#注释)">
              <Input placeholder="如：人才体系建设-测试前端" />
            </Form.Item>
          )}

          <Alert
            type="info"
            showIcon
            message="SSH 端口、用户、密码、root 密码对本次添加的所有主机统一生效（密码明文写入 hosts 文件，符合 ansible 标准）。"
          />
        </Form>
      </Modal>

      {/* 原始编辑 */}
      <Modal
        title="原始 hosts 编辑"
        open={rawOpen}
        onCancel={() => setRawOpen(false)}
        onOk={saveRaw}
        width={760}
        okText="保存"
      >
        <TextArea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          autoSize={{ minRows: 18, maxRows: 30 }}
          style={{ fontFamily: 'monospace', fontSize: 13 }}
        />
      </Modal>

      {/* 从 CMDB 导入 */}
      <Modal
        title="从 CMDB 资产导入"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => importForm.submit()}
        width={620}
      >
        <Form form={importForm} layout="vertical" onFinish={submitImport} initialValues={{ commentTpl: '{应用系统名称}' }}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="将以资产「虚拟机IPv4」作为主机地址写入目标分组；已存在的 IP 自动跳过。"
          />
          <Form.Item name="group" label="目标分组名" rules={[{ required: true, message: '请输入分组名' }]}>
            <Input placeholder="如：人才体系建设-测试前端" />
          </Form.Item>
          <Form.Item name="categoryId" label="限定分类 ID (可选)">
            <Input type="number" placeholder="留空则导入全部资产" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }} wrap>
            <Form.Item name="port" label="SSH 端口" style={{ width: 140 }}>
              <Input placeholder="22 / 65181" />
            </Form.Item>
            <Form.Item name="sshUser" label="SSH 用户" style={{ width: 140 }}>
              <Input placeholder="centos" />
            </Form.Item>
          </Space>
          <Form.Item name="sshPass" label="SSH 密码">
            <Input.Password placeholder="ansible_ssh_pass" />
          </Form.Item>
          <Form.Item name="becomePass" label="root 密码">
            <Input.Password placeholder="ansible_become_pass" />
          </Form.Item>
          <Form.Item name="commentTpl" label="备注模板" tooltip="支持 {字段名} 占位，如 {应用系统名称}">
            <Input placeholder="{应用系统名称}" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 节点管理 */}
      <Drawer
        title="Ansible 节点管理"
        placement="right"
        width={780}
        open={nodeManageOpen}
        onClose={() => setNodeManageOpen(false)}
        extra={
          hasPerm('ansible:remote:create') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openNodeModal('create')}>
              新增节点
            </Button>
          )
        }
      >
        <Paragraph type="secondary">
          注册你的 ansible 服务器，通过 SSH 连接后即可在本平台管理其 hosts 文件与执行 ansible 命令。
        </Paragraph>
        {nodes.length === 0 ? (
          <Empty description="还没有注册的远程节点" />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {nodes.map((n) => (
              <Card
                key={n.id}
                size="small"
                title={
                  <Space>
                    {statusIcon(n.status)}
                    <Text strong>{n.name}</Text>
                    <Tag color={n.status === 'online' ? 'green' : n.status === 'offline' ? 'red' : 'default'}>
                      {n.status || 'unknown'}
                    </Tag>
                  </Space>
                }
                extra={
                  <Space>
                    {hasPerm('ansible:remote:exec') && (
                      <Button size="small" icon={<ApiOutlined />} onClick={() => quickTest(n)}>
                        测试
                      </Button>
                    )}
                    {hasPerm('ansible:remote:update') && (
                      <Button size="small" icon={<EditOutlined />} onClick={() => openNodeModal('edit', n)}>
                        编辑
                      </Button>
                    )}
                    {hasPerm('ansible:remote:delete') && (
                      <Popconfirm title="确认删除该节点？" onConfirm={() => removeNode(n)}>
                        <Button size="small" danger icon={<DeleteOutlined />}>
                          删除
                        </Button>
                      </Popconfirm>
                    )}
                  </Space>
                }
              >
                <Descriptions size="small" column={2}>
                  <Descriptions.Item label="SSH">{n.user}@{n.host}:{n.port}</Descriptions.Item>
                  <Descriptions.Item label="认证">
                    {n.authType}
                      {n.hasPassword && <Tag color="blue" style={{ marginLeft: 4 }}>密码</Tag>}
                      {n.hasKey && <Tag color="purple" style={{ marginLeft: 4 }}>密钥</Tag>}
                      {n.hasBecome && <Tag color="orange" style={{ marginLeft: 4 }}>sudo</Tag>}
                  </Descriptions.Item>
                  <Descriptions.Item label="hosts 路径" span={2}>
                    <Text code>{n.hostsPath}</Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="网络区域" span={2}>
                    {n.networkZone ? (
                      <Tag color="geekblue">{n.networkZone}</Tag>
                    ) : (
                      <Text type="secondary">未绑定（不参与区域自动分配）</Text>
                    )}
                  </Descriptions.Item>
                  {n.description && (
                    <Descriptions.Item label="备注" span={2}>{n.description}</Descriptions.Item>
                  )}
                  {n.lastError && (
                    <Descriptions.Item label="最近错误" span={2}>
                      <Text type="danger" style={{ fontSize: 12 }}>{n.lastError}</Text>
                    </Descriptions.Item>
                  )}
                  {n.lastCheckAt && (
                    <Descriptions.Item label="最近检测" span={2}>
                      <Text type="secondary" style={{ fontSize: 12 }}>{n.lastCheckAt}</Text>
                    </Descriptions.Item>
                  )}
                </Descriptions>
              </Card>
            ))}
          </Space>
        )}
      </Drawer>

      {/* 节点编辑/新增 */}
      <Modal
        title={nodeModal?.mode === 'edit' ? '编辑节点' : '新增节点'}
        open={!!nodeModal}
        onCancel={() => setNodeModal(null)}
        onOk={() => nodeForm.submit()}
        width={620}
      >
        <Form form={nodeForm} layout="vertical" onFinish={submitNode}>
          <Form.Item name="name" label="节点名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：ansible-01 / 生产Ansible机" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }} wrap>
            <Form.Item name="host" label="SSH 主机" style={{ width: 280 }} rules={[{ required: true }]}>
              <Input placeholder="1.2.3.4 或 ansible.example.com" />
            </Form.Item>
            <Form.Item name="port" label="SSH 端口" style={{ width: 120 }} rules={[{ required: true }]}>
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="user" label="SSH 用户" style={{ width: 160 }} rules={[{ required: true }]}>
              <Input placeholder="centos" />
            </Form.Item>
          </Space>
          <Form.Item name="authType" label="认证方式">
            <Segmented
              options={[
                { label: '密码', value: 'password' },
                { label: '私钥', value: 'key' },
              ]}
            />
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {() => (
              <Form.Item name="password" label="SSH 密码" extra="若已配置过密码且不修改，请留空。">
                <Input.Password placeholder="留空表示不修改 / 不使用密码" autoComplete="new-password" />
              </Form.Item>
            )}
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {() => (
              <Form.Item name="privateKey" label="SSH 私钥 (PEM)" extra="若已配置过私钥且不修改，请留空。">
                <TextArea autoSize={{ minRows: 4, maxRows: 10 }} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..." style={{ fontFamily: 'monospace', fontSize: 12 }} />
              </Form.Item>
            )}
          </Form.Item>
          <Form.Item
            name="becomePass"
            label="sudo 密码"
            extra={
              <span>
                读取/写入 /etc/ansible/hosts 通常需要 root 权限。重要：<b>sudo 问的是「当前 SSH 用户（centos）」自己的密码</b>，<b>不是 root 的密码</b>（这跟你手动 <code>su - root</code> 不一样）。
                若该用户已配 NOPASSWD sudo 可留空；否则一般填 <b>与 SSH 密码相同</b> 的值；若 sudoers 使用 targetpw/rootpw 再填 root 密码。
              </span>
            }
          >
            <Input.Password placeholder="通常与 SSH 密码相同" autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="hostsPath"
            label="hosts 文件路径"
            rules={[{ required: true }]}
            extra="默认 /etc/ansible/hosts；可改为自定义路径。"
          >
            <Input placeholder="/etc/ansible/hosts" />
          </Form.Item>
          <Form.Item
            name="networkZone"
            label="所属网络区域"
            extra="用于「中间件安装」按资产所属网络区域自动匹配执行节点（如 互联网 / 政务外网）。不填则不作为区域控制节点。"
          >
            <Select
              allowClear
              placeholder="选择该控制节点服务的网络区域"
              options={[
                { value: '互联网', label: '互联网' },
                { value: '政务外网', label: '政务外网' },
              ]}
            />
          </Form.Item>
          <Form.Item name="description" label="备注">
            <TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="可选描述" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 节点信息 */}
      <Modal
        title={`节点信息 · ${selectedNode?.name || ''}`}
        open={infoOpen}
        onCancel={() => setInfoOpen(false)}
        footer={[<Button key="ok" onClick={() => setInfoOpen(false)}>关闭</Button>]}
        width={620}
      >
        {infoLoading ? (
          <Text type="secondary">探测中...</Text>
        ) : info ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="Ansible 版本">
              <Text code>{info.ansibleVersion || '-'}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="Python 版本">
              <Text code>{info.pythonVersion || '-'}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="配置文件">
              <Text code>{info.configFile || '-'}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="hosts 路径">
              <Text code>{info.hostsPath || '-'}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="Playbook 目录">
              {info.playbookDirs && info.playbookDirs.length > 0 ? (
                <Space wrap>
                  {info.playbookDirs.map((p) => (
                    <Tag key={p} color="blue">{p}</Tag>
                  ))}
                </Space>
              ) : (
                <Text type="secondary">未探测到</Text>
              )}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Empty />
        )}
      </Modal>

      {/* 执行命令 */}
      <Modal
        title={`执行命令 · ${selectedNode?.name || ''}`}
        open={execOpen}
        onCancel={() => setExecOpen(false)}
        onOk={() => execForm.submit()}
        okText="执行"
        cancelText="关闭"
        width={760}
        confirmLoading={execRunning}
      >
        <Form form={execForm} layout="vertical" onFinish={submitExec}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="命令将在远端 SSH 会话中执行；输出最长保留 64KB。建议先用 ansible --version / ansible all -m ping 等无副作用命令。"
          />
          <Form.Item name="command" label="命令" rules={[{ required: true }]}>
            <TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="ansible all -m ping" style={{ fontFamily: 'monospace' }} />
          </Form.Item>
        </Form>
        {execOutput && (
          <pre style={{ background: '#0b1020', color: '#b6f5c6', padding: 12, borderRadius: 6, maxHeight: 360, overflow: 'auto', fontSize: 12 }}>
            {execOutput}
          </pre>
        )}
      </Modal>
    </div>
  )
}