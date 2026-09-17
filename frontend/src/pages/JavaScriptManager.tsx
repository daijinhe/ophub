import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Tree,
  Typography,
  message,
} from 'antd'
import type { DataNode } from 'antd/es/tree'
import {
  CloudServerOutlined,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  FileAddOutlined,
  FolderAddOutlined,
  FolderOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  SnippetsOutlined,
} from '@ant-design/icons'
import {
  createScriptDir,
  createScriptFile,
  deleteScriptEntry,
  getScriptFile,
  listScripts,
  putScriptFile,
  type ScriptDirEntry,
  type ScriptSource,
} from '../api/scripts'
import { listCrontabAssets, type CrontabHostOption } from '../api/crontab'
import { useAuth } from '../store/AuthContext'

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input

const ROOT_DEFAULT = '/data/jenkins_home/scripts/Java_Start_Stop_SH'

/** 友好的字节数显示（编辑器右上角 / 列表 size 列） */
function fmtBytes(n: number): string {
  if (!n || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 后端返回字段统一取 message / msg */
function errMsg(e: any, fallback = '操作失败'): string {
  return e?.response?.data?.msg || e?.message || fallback
}

/**
 * Java 启停脚本管理
 *
 * 平台获取虚拟机信息一律经 ansible 控制节点 —— 在 UI 上的体现是「先选资产」。
 * 选完资产 + 确认根路径（默认 /data/jenkins_home/scripts/Java_Start_Stop_SH），
 * 左侧列出所有「服务」（根路径下的子目录，每个目录 = 一个 Java 服务），
 * 中间是该服务下的脚本文件，右侧是文本编辑器。
 *
 * 写路径强制落在「允许根」之下，由后端 normalizeScriptPath 兜底；
 * 客户端不做严格解析，只把"用户输入"原样下发 —— 后端验证失败会回 400 + 详细原因。
 */
export default function JavaScriptManager() {
  const { hasPerm } = useAuth()
  const canManage = hasPerm('script:manage')

  const [hosts, setHosts] = useState<CrontabHostOption[]>([])
  const [hostsLoading, setHostsLoading] = useState(false)
  const [hostId, setHostId] = useState<number | undefined>()
  // 数据落点：平台本机（local，直接读写平台所在机器）还是目标服务器（remote，经 ansible）
  const [source, setSource] = useState<ScriptSource>('remote')
  const [rootPath, setRootPath] = useState(ROOT_DEFAULT)

  // 服务（子目录）树 + 当前选中节点
  const [dirs, setDirs] = useState<ScriptDirEntry[]>([])
  const [dirsLoading, setDirsLoading] = useState(false)
  const [selectedDir, setSelectedDir] = useState<ScriptDirEntry | null>(null)

  // 当前服务下的脚本文件
  const [files, setFiles] = useState<ScriptDirEntry[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [selectedFile, setSelectedFile] = useState<ScriptDirEntry | null>(null)

  // 编辑器状态
  const [editorOpen, setEditorContent] = useEditorState()

  // 抽屉配置：创建服务目录 / 新建脚本
  const [createDirOpen, setCreateDirOpen] = useState(false)
  const [createFileOpen, setCreateFileOpen] = useState(false)

  // 帮助文档抽屉
  const [helpOpen, setHelpOpen] = useState(false)

  /* ---------- 加载主机列表 ---------- */
  const loadHosts = useCallback(async () => {
    setHostsLoading(true)
    try {
      const list = await listCrontabAssets()
      setHosts(list)
      if (!hostId && list.length) {
        setHostId(list[0].assetId)
      }
    } catch (e) {
      message.error('加载主机列表失败：' + errMsg(e))
    } finally {
      setHostsLoading(false)
    }
  }, [hostId])

  useEffect(() => {
    loadHosts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------- 加载服务列表（根目录下子目录） ---------- */
  const loadDirs = useCallback(async () => {
    // 本机模式不需要选主机；远端模式必须先选资产（否则后端无从连接）
    if (source === 'remote' && !hostId) return
    setDirsLoading(true)
    try {
      const r = await listScripts(source, hostId, rootPath)
      setDirs((r.items || []).filter((it) => it.isDir))
    } catch (e) {
      message.error('加载服务列表失败：' + errMsg(e))
      setDirs([])
    } finally {
      setDirsLoading(false)
    }
  }, [source, hostId, rootPath])

  useEffect(() => {
    loadDirs()
  }, [loadDirs])

  /* ---------- 加载选中服务下的文件 ---------- */
  const loadFiles = useCallback(
    async (dir: ScriptDirEntry | null) => {
      if ((source === 'remote' && !hostId) || !dir) {
        setFiles([])
        return
      }
      setFilesLoading(true)
      try {
        const r = await listScripts(source, hostId, dir.path, rootPath)
        // 文件型条目（脚本文件们）
        setFiles((r.items || []).filter((it) => !it.isDir))
      } catch (e) {
        message.error('加载文件列表失败：' + errMsg(e))
        setFiles([])
      } finally {
        setFilesLoading(false)
      }
    },
    [source, hostId, rootPath],
  )

  useEffect(() => {
    if (selectedDir) loadFiles(selectedDir)
  }, [selectedDir, loadFiles])

  /* ---------- 打开文件到编辑器 ---------- */
  const openFile = useCallback(
    async (f: ScriptDirEntry) => {
      if (source === 'remote' && !hostId) return
      try {
        const r = await getScriptFile(source, hostId, f.path, rootPath)
        setSelectedFile(f)
        setEditorContent({ open: true, dirty: false, loading: false, content: r.content })
      } catch (e) {
        message.error('打开文件失败：' + errMsg(e))
      }
    },
    [source, hostId, rootPath],
  )

  /* ---------- 保存当前编辑 ---------- */
  const saveFile = useCallback(async () => {
    if ((source === 'remote' && !hostId) || !selectedFile) return
    if (!editorOpen.dirty) {
      message.info('没有改动')
      return
    }
    try {
      await putScriptFile(
        source,
        hostId,
        selectedFile.path,
        editorOpen.content,
        rootPath,
      )
      message.success('保存成功')
      setEditorContent({ ...editorOpen, dirty: false })
      // 刷新文件列表（大小/时间会变）
      if (selectedDir) loadFiles(selectedDir)
    } catch (e) {
      message.error('保存失败：' + errMsg(e))
    }
  }, [source, hostId, selectedFile, selectedDir, editorOpen, rootPath, loadFiles])

  /* ---------- 新建服务目录 ---------- */
  const onCreateDir = async (vals: { name: string }) => {
    if (source === 'remote' && !hostId) return
    try {
      await createScriptDir(source, hostId, rootPath, vals.name)
      message.success('服务目录已创建：' + vals.name)
      setCreateDirOpen(false)
      loadDirs()
    } catch (e) {
      message.error('创建失败：' + errMsg(e))
    }
  }

  /* ---------- 新建脚本文件 ---------- */
  const onCreateFile = async (vals: { name: string; content?: string }) => {
    if ((source === 'remote' && !hostId) || !selectedDir) {
      message.warning('请先选择左侧一个服务')
      return
    }
    try {
      const fullPath = `${selectedDir.path}/${vals.name}`
      await createScriptFile(source, hostId, fullPath, vals.content || '', rootPath)
      message.success('脚本已创建：' + vals.name)
      setCreateFileOpen(false)
      loadFiles(selectedDir)
    } catch (e) {
      message.error('创建失败：' + errMsg(e))
    }
  }

  /* ---------- 删除条目（服务目录 / 脚本） ---------- */
  const onDelete = async (entry: ScriptDirEntry) => {
    if (source === 'remote' && !hostId) return
    const isDir = entry.isDir
    const confirmText = isDir
      ? `确认删除服务目录「${entry.name}」及其下所有脚本？此操作不可恢复！`
      : `确认删除脚本「${entry.name}」？此操作不可恢复！`
    Modal.confirm({
      title: '删除确认',
      content: confirmText,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteScriptEntry(source, hostId, entry.path, rootPath)
          message.success('已删除：' + entry.name)
          if (isDir) {
            if (selectedDir?.path === entry.path) {
              setSelectedDir(null)
              setSelectedFile(null)
              setEditorContent({ open: false, dirty: false, content: '' })
            }
            loadDirs()
          } else {
            if (selectedFile?.path === entry.path) {
              setSelectedFile(null)
              setEditorContent({ open: false, dirty: false, content: '' })
            }
            if (selectedDir) loadFiles(selectedDir)
          }
        } catch (e) {
          message.error('删除失败：' + errMsg(e))
        }
      },
    })
  }

  /* ---------- UI 渲染 ---------- */
  const hostValue = useMemo(
    () => hosts.map((h) => ({ value: h.assetId, label: h.assetName, vm: h.vmName })),
    [hosts],
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          <CodeOutlined style={{ marginRight: 8 }} />
          Java 启停脚本管理
        </Title>
        <Tag color="purple">v1.6.4</Tag>
        <div style={{ flex: 1 }} />
        <Tooltip title="查看使用说明">
          <Button icon={<QuestionCircleOutlined />} onClick={() => setHelpOpen(true)}>
            使用说明
          </Button>
        </Tooltip>
      </div>

      {/* 顶部：数据源 + 主机 + 根路径 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Form layout="inline">
          <Form.Item label="数据源">
            <Segmented
              value={source}
              onChange={(v) => {
                setSource(v as ScriptSource)
                // 切换落点后路径语义变了，清空选中态避免拿旧机器的路径去操作新落点
                setSelectedDir(null)
                setSelectedFile(null)
                setEditorContent({ open: false, dirty: false, content: '' })
              }}
              options={[
                { label: '目标服务器', value: 'remote', icon: <CloudServerOutlined /> },
                { label: '平台本机', value: 'local', icon: <CodeOutlined /> },
              ]}
            />
          </Form.Item>
          {source === 'remote' && (
            <Form.Item label="目标主机" style={{ minWidth: 280 }}>
              <Select
                showSearch
                loading={hostsLoading}
                value={hostId}
                placeholder="选择资产（脚本所在机器）"
                optionFilterProp="label"
                options={hostValue.map((h) => ({
                  value: h.value,
                  label: h.label + (h.vm ? ` (${h.vm})` : ''),
                }))}
                onChange={(v) => {
                  setHostId(v as number)
                  setSelectedDir(null)
                  setSelectedFile(null)
                  setEditorContent({ open: false, dirty: false, content: '' })
                }}
                style={{ minWidth: 260 }}
              />
            </Form.Item>
          )}
          <Form.Item label="脚本根路径" style={{ minWidth: 420 }}>
            <Input
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder="/data/jenkins_home/scripts/Java_Start_Stop_SH"
              allowClear
            />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button
                icon={<ReloadOutlined />}
                onClick={() => {
                  loadDirs()
                  if (selectedDir) loadFiles(selectedDir)
                }}
                disabled={source === 'remote' && !hostId}
              >
                刷新
              </Button>
              {canManage && (
                <Button
                  icon={<FolderAddOutlined />}
                  type="primary"
                  disabled={source === 'remote' && !hostId}
                  onClick={() => setCreateDirOpen(true)}
                >
                  新建服务
                </Button>
              )}
            </Space>
          </Form.Item>
        </Form>
      </Card>

      {source === 'remote' && !hostId ? (
        <Alert
          type="info"
          showIcon
          message="请先在顶部选择「目标主机」，脚本管理操作都在该机器上执行"
        />
      ) : (
        <Row gutter={12}>
          {/* 左：服务目录 */}
          <Col span={6}>
            <Card
              size="small"
              title={
                <span>
                  <FolderOutlined /> 服务目录（{dirs.length}）
                </span>
              }
              bodyStyle={{ padding: 0, height: 'calc(100vh - 280px)', overflow: 'auto' }}
            >
              {dirsLoading ? (
                <div style={{ padding: 24, textAlign: 'center' }}>
                  <Spin />
                </div>
              ) : dirs.length === 0 ? (
                <Empty
                  description="暂无服务目录"
                  imageStyle={{ height: 80 }}
                  style={{ padding: 16 }}
                >
                  {canManage && (
                    <Button type="primary" onClick={() => setCreateDirOpen(true)}>
                      新建第一个服务
                    </Button>
                  )}
                </Empty>
              ) : (
                <DirectoryList
                  dirs={dirs}
                  selected={selectedDir}
                  onSelect={(d) => setSelectedDir(d)}
                  onDelete={canManage ? (d) => onDelete(d) : undefined}
                />
              )}
            </Card>
          </Col>

          {/* 右：文件 + 编辑器 */}
          <Col span={18}>
            <Card
              size="small"
              title={
                <span>
                  <CloudServerOutlined /> 脚本文件
                  {selectedDir && (
                    <Tag color="blue" style={{ marginLeft: 8 }}>
                      {selectedDir.name}
                    </Tag>
                  )}
                  {selectedFile && (
                    <Tag color="cyan" style={{ marginLeft: 8 }}>
                      {selectedFile.name}
                    </Tag>
                  )}
                </span>
              }
              extra={
                canManage && selectedDir && (
                  <Space>
                    <Button
                      size="small"
                      icon={<FileAddOutlined />}
                      onClick={() => setCreateFileOpen(true)}
                    >
                      新建脚本
                    </Button>
                  </Space>
                )
              }
              bodyStyle={{ padding: 0, height: 'calc(100vh - 280px)', overflow: 'hidden' }}
            >
              {!selectedDir ? (
                <Empty
                  description="请选择左侧的服务目录"
                  style={{ marginTop: 80 }}
                />
              ) : (
                <Row style={{ height: '100%' }}>
                  {/* 服务下的文件列表 */}
                  <Col
                    span={7}
                    style={{
                      height: '100%',
                      borderRight: '1px solid var(--border-soft)',
                      overflow: 'auto',
                    }}
                  >
                    {filesLoading ? (
                      <div style={{ padding: 24, textAlign: 'center' }}>
                        <Spin />
                      </div>
                    ) : files.length === 0 ? (
                      <Empty description="尚无脚本" imageStyle={{ height: 60 }} />
                    ) : (
                      <FileList
                        files={files}
                        selected={selectedFile}
                        onSelect={(f) => openFile(f)}
                        onDelete={canManage ? (f) => onDelete(f) : undefined}
                      />
                    )}
                  </Col>
                  {/* 编辑器 */}
                  <Col span={17} style={{ height: '100%' }}>
                    <EditorPanel
                      file={selectedFile}
                      editor={editorOpen}
                      onChange={(v) => {
                        setEditorContent({ ...editorOpen, content: v, dirty: true })
                      }}
                      onSave={canManage ? saveFile : undefined}
                      canManage={canManage}
                    />
                  </Col>
                </Row>
              )}
            </Card>
          </Col>
        </Row>
      )}

      {/* 新建服务目录 */}
      <CreateDirModal
        open={createDirOpen}
        onCancel={() => setCreateDirOpen(false)}
        onSubmit={onCreateDir}
      />
      {/* 新建脚本文件 */}
      <CreateFileModal
        open={createFileOpen}
        onCancel={() => setCreateFileOpen(false)}
        onSubmit={onCreateFile}
        serviceName={selectedDir?.name}
      />
      {/* 帮助 */}
      <Drawer
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        title="Java 启停脚本管理 · 使用说明"
        width={560}
      >
        <Paragraph>
          <strong>适用场景：</strong>管理业务服务器上一组 Java
          服务的启停脚本（如 <code>start.sh</code> / <code>stop.sh</code>
          / <code>restart.sh</code>）。
        </Paragraph>
        <Paragraph>
          <strong>目录结构：</strong>
          <pre
            style={{
              background: 'var(--bg-soft)',
              padding: 12,
              borderRadius: 6,
            }}
          >
{`${ROOT_DEFAULT}
├── order-service/
│   ├── start.sh
│   ├── stop.sh
│   └── restart.sh
├── payment-service/
│   └── ...
└── ...`}
          </pre>
        </Paragraph>
        <Paragraph>
          <strong>两种数据源（顶部切换）：</strong>
          <ul>
            <li>
              <Tag color="blue">目标服务器</Tag>
              管理<strong>远程机器</strong>上的脚本 —— 经 ansible 控制节点操作，
              所选主机必须是在 CMDB 登记过、控制节点能 SSH 到的资产。
            </li>
            <li>
              <Tag color="green">平台本机</Tag>
              管理<strong>平台自己所在机器</strong>上的脚本 —— 后端直接读写本机文件系统，
              不经 ansible。适合「Jenkins 与平台同机」的场景。
            </li>
          </ul>
          <Text type="secondary">
            ⚠️ 平台跑在 Docker 里时，「平台本机」= <strong>容器</strong>文件系统。
            要管理宿主机的目录，必须在 <code>docker-compose.yml</code> 的
            <code>backend.volumes</code> 里把该路径挂进容器（已默认挂
            <code>{ROOT_DEFAULT}</code>），否则列出来是空的。
          </Text>
        </Paragraph>
        <Paragraph>
          <strong>权限：</strong>
          <ul>
            <li>
              <Tag color="blue">script:view</Tag> 查看服务列表、脚本内容
            </li>
            <li>
              <Tag color="purple">script:manage</Tag> 新建 / 修改 / 删除服务与脚本
            </li>
          </ul>
        </Paragraph>
        <Paragraph>
          <strong>备份：</strong>
          每次保存会先复制到 <code>{`<原文件>.ophub.bak`}</code>
          ；如果修改失败，可用 SSH 登录目标机恢复。
        </Paragraph>
      </Drawer>
    </div>
  )
}

/* ============================================================================
 * 子组件
 * ========================================================================== */

/** 服务目录列表（点击切换 file 列表） */
function DirectoryList(props: {
  dirs: ScriptDirEntry[]
  selected: ScriptDirEntry | null
  onSelect: (d: ScriptDirEntry) => void
  onDelete?: (d: ScriptDirEntry) => void
}) {
  return (
    <div style={{ padding: 4 }}>
      {props.dirs.map((d) => {
        const active = props.selected?.path === d.path
        return (
          <div
            key={d.path}
            onClick={() => props.onSelect(d)}
            style={{
              padding: '8px 12px',
              borderRadius: 4,
              cursor: 'pointer',
              background: active ? 'var(--primary-soft, rgba(99,102,241,0.1))' : undefined,
              borderLeft: active
                ? '3px solid var(--accent, #6366f1)'
                : '3px solid transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <FolderOutlined style={{ marginRight: 8, color: '#f59e0b' }} />
              {d.name}
            </span>
            {props.onDelete && (
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={(e) => {
                  e.stopPropagation()
                  props.onDelete?.(d)
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 脚本文件列表 */
function FileList(props: {
  files: ScriptDirEntry[]
  selected: ScriptDirEntry | null
  onSelect: (f: ScriptDirEntry) => void
  onDelete?: (f: ScriptDirEntry) => void
}) {
  return (
    <div style={{ padding: 4 }}>
      {props.files.map((f) => {
        const active = props.selected?.path === f.path
        return (
          <div
            key={f.path}
            onClick={() => props.onSelect(f)}
            style={{
              padding: '8px 12px',
              borderRadius: 4,
              cursor: 'pointer',
              background: active ? 'var(--primary-soft, rgba(99,102,241,0.1))' : undefined,
              borderLeft: active
                ? '3px solid var(--accent, #6366f1)'
                : '3px solid transparent',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <SnippetsOutlined style={{ marginRight: 8 }} />
              {f.name}
            </span>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {fmtBytes(f.size)}
            </Text>
            {props.onDelete && (
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={(e) => {
                  e.stopPropagation()
                  props.onDelete?.(f)
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 编辑器面板 */
function EditorPanel(props: {
  file: ScriptDirEntry | null
  editor: EditorState
  onChange: (v: string) => void
  onSave?: () => void
  canManage: boolean
}) {
  if (!props.file) {
    return (
      <Empty
        description="选择右侧的脚本以编辑"
        style={{ marginTop: 80 }}
      />
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部信息栏 */}
      <div
        style={{
          padding: '6px 12px',
          borderBottom: '1px solid var(--border-soft)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Text style={{ flex: 1 }} type="secondary">
          <EditOutlined /> {props.file.path} · {fmtBytes(props.file.size)}
        </Text>
        {props.editor.dirty && (
          <Tag color="orange" style={{ margin: 0 }}>
            未保存
          </Tag>
        )}
        {props.canManage && (
          <Button
            size="small"
            type="primary"
            icon={<SaveOutlined />}
            onClick={props.onSave}
            disabled={!props.editor.dirty}
          >
            保存
          </Button>
        )}
      </div>
      <TextArea
        value={props.editor.content}
        onChange={(e) => props.onChange(e.target.value)}
        spellCheck={false}
        disabled={!props.canManage}
        style={{
          flex: 1,
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: 13,
          lineHeight: 1.5,
          border: 'none',
          borderRadius: 0,
          resize: 'none',
        }}
      />
    </div>
  )
}

/** 新建服务目录 */
function CreateDirModal(props: {
  open: boolean
  onCancel: () => void
  onSubmit: (v: { name: string }) => void
}) {
  const [form] = Form.useForm<{ name: string }>()
  useEffect(() => {
    if (props.open) form.resetFields()
  }, [props.open, form])
  return (
    <Modal
      title="新建服务目录"
      open={props.open}
      onCancel={props.onCancel}
      onOk={() => form.submit()}
      okText="创建"
      cancelText="取消"
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={props.onSubmit}>
        <Form.Item
          name="name"
          label="服务名（目录名）"
          rules={[
            { required: true, message: '请填写目录名' },
            {
              pattern: /^[A-Za-z0-9_.-]+$/,
              message: '只能包含字母/数字/下划线/中划线/点',
            },
          ]}
        >
          <Input placeholder="order-service" />
        </Form.Item>
        <Paragraph type="secondary" style={{ marginTop: -8 }}>
          将创建在 <code>{ROOT_DEFAULT}/&lt;服务名&gt;</code> 下
        </Paragraph>
      </Form>
    </Modal>
  )
}

/** 新建脚本文件 */
function CreateFileModal(props: {
  open: boolean
  onCancel: () => void
  onSubmit: (v: { name: string; content?: string }) => void
  serviceName?: string
}) {
  const [form] = Form.useForm<{ name: string; content?: string }>()
  useEffect(() => {
    if (props.open) form.resetFields()
  }, [props.open, form])
  return (
    <Modal
      title={
        props.serviceName ? `在「${props.serviceName}」下新建脚本` : '新建脚本'
      }
      open={props.open}
      onCancel={props.onCancel}
      onOk={() => form.submit()}
      okText="创建"
      cancelText="取消"
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={props.onSubmit}>
        <Form.Item
          name="name"
          label="文件名"
          rules={[
            { required: true, message: '请填写文件名' },
            {
              pattern: /^[A-Za-z0-9_.-]+$/,
              message: '只能包含字母/数字/下划线/中划线/点',
            },
          ]}
        >
          <Input placeholder="start.sh" />
        </Form.Item>
        <Form.Item name="content" label="初始内容（可选）">
          <TextArea
            rows={8}
            placeholder="#!/bin/bash\n# 启动脚本\n..."
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}

/* ============================================================================
 * useEditorState
 *
 * 编辑器状态（content + dirty 标记 + 是否打开）的轻量 store。
 * 用 useState + 一个 setter 工具暴露「全替换」和「部分合并」两个动词，
 * 比把每个字段都写 useState 看起来更整洁。
 * ========================================================================== */
interface EditorState {
  open: boolean
  dirty: boolean
  loading?: boolean
  content: string
}
function useEditorState(): [EditorState, (s: EditorState) => void] {
  return useState<EditorState>({
    open: false,
    dirty: false,
    loading: false,
    content: '',
  })
}

// 防止 Tree 类型 import 报错（暂未使用，保留方便扩展为服务树形展示）
const _dataNode: DataNode = { key: '', title: '' }
void _dataNode
