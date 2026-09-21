import { useCallback, useEffect, useState } from 'react'
import {
  App,
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Pagination,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  ApiOutlined,
  CodeOutlined,
  CloudServerOutlined,
  DeleteOutlined,
  FolderAddOutlined,
  ImportOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  TableOutlined,
} from '@ant-design/icons'
import api from '../api/client'

const { Text, Paragraph } = Typography
const { TextArea } = Input

// ---------- 类型 ----------
interface AnsibleHostEntry {
  ip: string
  vars: Record<string, string>
  comment?: string
}
interface AnsibleGroup {
  name: string
  hosts: AnsibleHostEntry[]
}
interface AnsibleFile {
  groups: AnsibleGroup[]
  rawTop?: string
  rawTail?: string
}
interface AnsibleLocalInfo {
  available: boolean
  ansibleVersion?: string
  pythonVersion?: string
  configFile?: string
  hostsPath?: string
  playbookDirs?: string[]
  error?: string
}
interface CmdbAssetItem {
  id: number
  name: string
  ip: string
  fields: Record<string, any>
}

const hostMatches = (h: AnsibleHostEntry, kw: string) => {
  if (!kw) return true
  if (h.ip.toLowerCase().includes(kw)) return true
  if ((h.comment || '').toLowerCase().includes(kw)) return true
  return Object.entries(h.vars || {}).some(
    ([k, v]) => k.toLowerCase().includes(kw) || String(v).toLowerCase().includes(kw),
  )
}

const replaceTpl = (tpl: string, fields: Record<string, any>): string => {
  if (!tpl) return ''
  let out = tpl
  Object.entries(fields || {}).forEach(([k, v]) => {
    out = out.split(`{${k}}`).join(String(v ?? ''))
  })
  return out
}

export default function AnsibleLocal() {
  const { message } = App.useApp()

  // 本机 ansible 环境
  const [info, setInfo] = useState<AnsibleLocalInfo | null>(null)
  const [infoLoading, setInfoLoading] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)

  // hosts 文件
  const [file, setFile] = useState<AnsibleFile | null>(null)
  const [path, setPath] = useState('')
  const [readErr, setReadErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)

  // 分组 / 主机
  const [groupModal, setGroupModal] = useState(false)
  const [hostModal, setHostModal] = useState<{ group: string; idx: number | null } | null>(null)
  const [hostForm] = Form.useForm()
  const [groupForm] = Form.useForm()
  const [hostMode, setHostMode] = useState<'manual' | 'asset'>('manual')
  const [cmdbAssets, setCmdbAssets] = useState<CmdbAssetItem[]>([])

  // 搜索
  const [searchInput, setSearchInput] = useState('')
  const [searchKw, setSearchKw] = useState('')
  const [openKeys, setOpenKeys] = useState<string[]>([])
  const [groupPage, setGroupPage] = useState(1)
  const GROUP_PAGE_SIZE = 20

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

  // 执行命令
  const [execOpen, setExecOpen] = useState(false)
  const [execForm] = Form.useForm()
  const [execOutput, setExecOutput] = useState('')
  const [execRunning, setExecRunning] = useState(false)

  const loadInfo = () => {
    setInfoLoading(true)
    api
      .get('/ansible/local/info')
      .then((r) => setInfo(r.data.data))
      .catch((e) => message.error(e.response?.data?.msg || '获取本机 ansible 信息失败'))
      .finally(() => setInfoLoading(false))
  }

  const load = useCallback(() => {
    setLoading(true)
    setReadErr('')
    api
      .get('/ansible')
      .then((r) => {
        const d = r.data.data
        setFile(d.file)
        setPath(d.path)
        if (d.error) setReadErr(d.error)
        // v1.7.11+ 调试字段：把读到的字节数/行数/解析到的统计打到 console
        // 排查「前端 0 分组但容器内手动 ansible 能列出 403 台」时直接看这里
        if (typeof d._fileBytes === 'number') {
          // eslint-disable-next-line no-console
          console.log('[本机Ansible] hosts 读:', {
            _fileBytes: d._fileBytes,
            _fileLines: d._fileLines,
            _groupCount: d._groupCount,
            _hostCount: d._hostCount,
            path: d.path,
            exists: d.exists,
          })
          // 同时存到一个全局临时变量，方便用户从浏览器开发者工具「Elements → React state」看不到时也能取
          ;(window as any).__localAnsibleDebug__ = d
        }
      })
      .catch((e) => {
        message.error(e.response?.data?.msg || '加载失败')
        setFile({ groups: [] })
        setPath('')
      })
      .finally(() => setLoading(false))
  }, [message])

  useEffect(() => {
    loadInfo()
    load()
  }, [load])

  const onSave = (f: AnsibleFile) => {
    api
      .put('/ansible', { file: f })
      .then(() => {
        message.success('已保存')
        load()
      })
      .catch((e) => message.error(e.response?.data?.msg || '保存失败'))
  }

  const handleTest = () => {
    setTesting(true)
    api
      .post('/ansible/local/test')
      .then((r) => {
        const d = r.data.data
        Modal.info({
          title: '本机 ansible 测试',
          width: 720,
          content: (
            <div>
              <Paragraph>
                <Text strong>hosts 列表：</Text>
                <pre style={{ background: '#0b1020', color: '#b6f5c6', padding: 10, borderRadius: 6, maxHeight: 200, overflow: 'auto', fontSize: 12 }}>
                  {d.hosts || '(空)'}
                </pre>
              </Paragraph>
              <Paragraph>
                <Text strong>ping 输出：</Text>
                <pre style={{ background: '#0b1020', color: '#b6f5c6', padding: 10, borderRadius: 6, maxHeight: 240, overflow: 'auto', fontSize: 12 }}>
                  {d.ping || '(空)'}
                </pre>
              </Paragraph>
              {d.error && <Text type="danger">错误：{d.error}</Text>}
              {d._debug && (
                <Paragraph>
                  <Text strong>调试信息（v1.7.11+）：</Text>
                  <pre style={{ background: '#1a1a1a', color: '#bdbdbd', padding: 10, borderRadius: 6, maxHeight: 200, overflow: 'auto', fontSize: 12 }}>
                    {d._debug}
                  </pre>
                </Paragraph>
              )}
            </div>
          ),
        })
      })
      .catch((e) => message.error(e.response?.data?.msg || '测试失败'))
      .finally(() => setTesting(false))
  }

  const openInfo = () => {
    setInfoOpen(true)
    if (!info) loadInfo()
  }

  // 分组 / 主机操作（与远端一致，简化版）
  const addGroup = (name: string) => {
    if (!name) return
    const f = file ? JSON.parse(JSON.stringify(file)) : { groups: [] }
    if (f.groups.some((g: AnsibleGroup) => g.name === name)) {
      message.warning('分组已存在')
      return
    }
    f.groups.push({ name, hosts: [] })
    onSave(f)
    setGroupModal(false)
    groupForm.resetFields()
  }
  const removeGroup = (name: string) => {
    const f = JSON.parse(JSON.stringify(file)) as AnsibleFile
    f.groups = f.groups.filter((g) => g.name !== name)
    onSave(f)
  }
  const removeHost = (group: string, idx: number) => {
    const f = JSON.parse(JSON.stringify(file)) as AnsibleFile
    const g = f.groups.find((x) => x.name === group)!
    g.hosts.splice(idx, 1)
    onSave(f)
  }

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
      hostForm.setFieldsValue({ port: '22', sshUser: 'root', sshPass: '', becomePass: '' })
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

    if (isEdit) {
      g.hosts[hostModal!.idx!] = { ip: values.ip, comment: values.comment || '', vars: { ...vars } }
      onSave(f)
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
      const ips = String(values.ips || '')
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
    onSave(f)
    setHostModal(null)
  }

  const openRaw = () => {
    api.get('/ansible/raw').then((r) => {
      setRawText(r.data.data.content || '')
      setRawOpen(true)
    })
  }
  const saveRaw = () => {
    api
      .post('/ansible/raw', { content: rawText })
      .then(() => {
        message.success('已保存')
        setRawOpen(false)
        load()
      })
      .catch((e) => message.error(e.response?.data?.msg || '保存失败'))
  }

  const submitImport = (values: any) => {
    const body = {
      group: values.group,
      port: values.port ? String(values.port) : '',
      sshUser: values.sshUser,
      sshPass: values.sshPass,
      becomePass: values.becomePass,
      commentTpl: values.commentTpl,
      categoryId: values.categoryId || null,
    }
    api
      .post('/ansible/import-cmdb', body)
      .then((r) => {
        message.success(`已导入 ${r.data.data.added} 台到分组 [${r.data.data.group}]`)
        setImportOpen(false)
        importForm.resetFields()
        load()
      })
      .catch((e) => message.error(e.response?.data?.msg || '导入失败'))
  }

  const submitExec = (values: any) => {
    setExecRunning(true)
    setExecOutput('执行中...')
    api
      .post('/ansible/local/exec', { command: values.command })
      .then((r) => {
        const out = r.data.data.stdout || ''
        const err = r.data.data.error || ''
        setExecOutput((err ? `[stderr]\n${err}\n` : '') + (out || '(无输出)'))
      })
      .catch((e) => setExecOutput(`请求失败: ${e.response?.data?.msg || e.message}`))
      .finally(() => setExecRunning(false))
  }

  const totalHosts = file ? file.groups.reduce((s, g) => s + g.hosts.length, 0) : 0

  const visibleGroups = (() => {
    const kw = searchKw.trim().toLowerCase()
    if (!kw) return file?.groups || []
    return (file?.groups || [])
      .map((g) => {
        const nameHit = g.name.toLowerCase().includes(kw)
        return nameHit ? g : { ...g, hosts: g.hosts.filter((h) => hostMatches(h, kw)) }
      })
      .filter((g) => g.name.toLowerCase().includes(kw) || g.hosts.length > 0)
  })()

  const searchStats = (() => {
    const kw = searchKw.trim().toLowerCase()
    if (!kw) return null
    return {
      groups: visibleGroups.length,
      hosts: visibleGroups.reduce((s, g) => s + g.hosts.length, 0),
    }
  })()

  const shownGroups = visibleGroups.slice((groupPage - 1) * GROUP_PAGE_SIZE, groupPage * GROUP_PAGE_SIZE)

  useEffect(() => {
    setGroupPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, searchKw])

  useEffect(() => {
    setOpenKeys((prev) => {
      const kw = searchKw.trim().toLowerCase()
      const list = kw ? visibleGroups : file?.groups || []
      if (!list.length) return []
      const valid = prev.filter((k) => list.some((g) => g.name === k))
      if (valid.length) return valid
      return [list[0].name]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, searchKw])

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            本机 Ansible 管理
          </Typography.Title>
          <Space size={6} wrap style={{ marginTop: 4 }}>
            <Text type="secondary">hosts 路径：</Text>
            <Tag color="blue">{path || '(未加载)'}</Tag>
            {info && (
              <>
                <Text type="secondary"> · ansible：</Text>
                <Tag color={info.available ? 'green' : 'red'}>{info.available ? '可用' : '不可用'}</Tag>
              </>
            )}
          </Space>
        </div>
        <Space wrap>
          <Tooltip title="刷新 hosts">
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading} />
          </Tooltip>
          <Button icon={<ApiOutlined />} loading={testing} onClick={handleTest}>
            测试 ansible
          </Button>
          <Button icon={<InfoCircleOutlined />} onClick={openInfo}>
            节点信息
          </Button>
          <Button icon={<PlayCircleOutlined />} onClick={() => setExecOpen(true)}>
            执行命令
          </Button>
        </Space>
      </div>

      {!info?.available && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="本机 ansible 不可用"
          description={
            info?.error ||
            'backend 容器内未安装 ansible 二进制，或 ANSIBLE_HOSTS 路径不可访问。所有 ansible 调用（巡检/中间件/定时任务）将自动 fallback 到远端控制节点。'
          }
        />
      )}

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
            {info?.available && <Tag color="green">v1.7.10 本机模式</Tag>}
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
                    placeholder="搜索 IP / 分组 / 端口 / 用户 / 备注"
                    style={{ width: 300 }}
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                  />
                  {searchStats && <Tag color="geekblue">命中 {searchStats.groups} 组 / {searchStats.hosts} 台</Tag>}
                  <Button icon={<PlusOutlined />} onClick={() => { groupForm.resetFields(); setGroupModal(true) }}>
                    新增分组
                  </Button>
                  <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
                    从 CMDB 导入
                  </Button>
                  <Button icon={<CodeOutlined />} onClick={openRaw}>
                    原始编辑
                  </Button>
                </Space>
                {file && file.groups.length === 0 && (
                  <Card>
                    {readErr ? (
                      <Space direction="vertical" size={6}>
                        <Text type="danger">读取 hosts 失败：{readErr}</Text>
                      </Space>
                    ) : (
                      <Text type="secondary">
                        暂无分组。点击「新增分组」开始，或「从 CMDB 导入」一键生成。
                      </Text>
                    )}
                  </Card>
                )}
                {file && file.groups.length > 0 && searchStats && visibleGroups.length === 0 && (
                  <Card>
                    <Text type="secondary">没有匹配「{searchKw}」的分组或主机。</Text>
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
                            <Button size="small" type="link" icon={<PlusOutlined />} onClick={() => openHost(g.name, null)}>
                              添加主机
                            </Button>
                            <Popconfirm title="确认删除该分组及其所有主机？" onConfirm={() => removeGroup(g.name)}>
                              <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                                删除分组
                              </Button>
                            </Popconfirm>
                          </Space>
                        ),
                        children: (
                          <Table<AnsibleHostEntry>
                            size="small"
                            rowKey={(r) => r.ip + JSON.stringify(r.vars)}
                            dataSource={g.hosts}
                            pagination={{ pageSize: 15, size: 'small', showSizeChanger: false, showTotal: (t) => `共 ${t} 台` }}
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
                                render: (_: any, _row: AnsibleHostEntry, idx: number) => (
                                  <Space>
                                    <Button size="small" type="link" onClick={() => openHost(g.name, idx)}>
                                      编辑
                                    </Button>
                                    <Popconfirm title="删除该主机？" onConfirm={() => removeHost(g.name, idx)}>
                                      <Button size="small" type="link" danger>
                                        删除
                                      </Button>
                                    </Popconfirm>
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
            <Input placeholder="如：互联网-应用服务器" />
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
              <span>
                <Button size="small" type={hostMode === 'manual' ? 'primary' : 'default'} onClick={() => setHostMode('manual')}>
                  手工输入
                </Button>
                <Button size="small" type={hostMode === 'asset' ? 'primary' : 'default'} onClick={() => setHostMode('asset')} style={{ marginLeft: 8 }}>
                  从资产选择
                </Button>
              </span>
            </Form.Item>
          )}
          {hostModal?.idx === null && hostMode === 'manual' ? (
            <Form.Item name="ips" label="主机地址" rules={[{ required: true, message: '请输入至少一个主机地址' }]}>
              <TextArea autoSize={{ minRows: 3, maxRows: 8 }} placeholder={'198.51.100.62\n198.51.100.63'} />
            </Form.Item>
          ) : hostModal?.idx === null && hostMode === 'asset' ? (
            <Form.Item name="assetIds" label="选择资产" rules={[{ required: true, message: '请选择至少一个资产' }]}>
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="label"
                placeholder="可搜索 应用系统名称 / IP"
                options={cmdbAssets.map((a) => ({ label: `${a.name} (${a.ip})`, value: a.id }))}
              />
            </Form.Item>
          ) : (
            <Form.Item name="ip" label="主机地址" rules={[{ required: true, message: '请输入主机地址' }]}>
              <Input placeholder="如：198.51.100.62" />
            </Form.Item>
          )}
          <Form.Item label="SSH 端口" name="port">
            <Input placeholder="22 或 65181" />
          </Form.Item>
          <Form.Item label="SSH 用户" name="sshUser">
            <Input placeholder="root" />
          </Form.Item>
          <Form.Item label="SSH 密码" name="sshPass">
            <Input.Password placeholder="ansible_ssh_pass" />
          </Form.Item>
          <Form.Item label="root 密码" name="becomePass" extra="对应 hosts 里的 ansible_become_pass（提权到 root 用的密码）">
            <Input.Password placeholder="ansible_become_pass" />
          </Form.Item>
          {hostModal?.idx === null ? (
            <Form.Item name="commentTpl" label="备注模板" tooltip="从资产选择时支持 {字段名} 占位">
              <Input placeholder="如：{应用系统名称}" />
            </Form.Item>
          ) : (
            <Form.Item name="comment" label="备注">
              <Input placeholder="如：人才体系建设-测试前端" />
            </Form.Item>
          )}
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
          <Form.Item name="group" label="目标分组名" rules={[{ required: true, message: '请输入分组名' }]}>
            <Input placeholder="如：互联网-应用服务器" />
          </Form.Item>
          <Form.Item name="categoryId" label="限定分类 ID (可选)">
            <Input type="number" placeholder="留空则导入全部资产" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }} wrap>
            <Form.Item name="port" label="SSH 端口" style={{ width: 140 }}>
              <Input placeholder="22" />
            </Form.Item>
            <Form.Item name="sshUser" label="SSH 用户" style={{ width: 140 }}>
              <Input placeholder="root" />
            </Form.Item>
          </Space>
          <Form.Item name="sshPass" label="SSH 密码">
            <Input.Password placeholder="ansible_ssh_pass" />
          </Form.Item>
          <Form.Item name="becomePass" label="root 密码">
            <Input.Password placeholder="ansible_become_pass" />
          </Form.Item>
          <Form.Item name="commentTpl" label="备注模板" tooltip="支持 {字段名} 占位">
            <Input placeholder="{应用系统名称}" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 节点信息 */}
      <Modal
        title="本机 Ansible 信息"
        open={infoOpen}
        onCancel={() => setInfoOpen(false)}
        footer={[<Button key="ok" onClick={() => setInfoOpen(false)}>关闭</Button>]}
        width={620}
      >
        {infoLoading ? (
          <Text type="secondary">探测中...</Text>
        ) : info ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="可用状态">
              {info.available ? <Tag color="green">可用</Tag> : <Tag color="red">不可用</Tag>}
              {info.error && <Text type="danger" style={{ marginLeft: 8 }}>{info.error}</Text>}
            </Descriptions.Item>
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
        title="本机执行 ansible 命令"
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
            message="命令将在 backend 容器内以 root 身份直接执行（不走 SSH）；输出最长保留 64KB。仅允许 ansible 系列命令（ansible / ansible-playbook / ansible-doc / ansible-vault / ansible-inventory / ansible-galaxy）。"
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