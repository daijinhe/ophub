import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  App,
  Button,
  Card,
  Col,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
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
  EyeOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  FolderOutlined,
  MoreOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
} from '@ant-design/icons'
import {
  createScriptDir,
  createScriptFile,
  deleteScriptEntry,
  getScriptFile,
  listScripts,
  putScriptFile,
  type ScriptDirEntry,
} from '../api/scripts'
import { useAuth } from '../store/AuthContext'

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input

const ROOT_DEFAULT = '/data/jenkins_home/scripts/Java_Start_Stop_SH'

/** 友好的字节数显示 */
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
 * v1.7.24 改造:
 *   - 左侧由「服务目录列表 + 文件列表」两张卡片 → 一棵完整的目录树(antd Tree),
 *     支持任意层级(`高质量发展-测试环境-后端/java-auth-上传包/dits-auth.jar/java-start.sh`
 *     这种 3 级嵌套也按真实结构展开)。
 *   - 编辑器分两态:
 *       view(默认): 文件点开只读展示,顶部「编辑」按钮才进入编辑态;
 *       edit:       TextArea 可编辑,「保存」「取消」按钮。切文件时若有
 *                   dirty(未保存改动)弹确认。
 *
 * v1.7.25 改造:
 *   - 左侧目录树去掉 [+]/[-] 按钮(用户反馈"太丑了"),改成「双击文件夹展开」,
 *     单击只选中文件(进入编辑器);Tree 的 expandAction="doubleClick" + CSS
 *     隐藏 .ant-tree-switcher。
 *
 * 平台获取虚拟机信息一律经 ansible 控制节点 —— 但脚本管理的典型场景是
 * 「Jenkins 与平台同机、脚本就在这台机器上」(v1.7.9 起只支持本机模式)。
 * 「容器能看到的文件系统」由 docker-compose.yml 通过 SCRIPT_HOST_ROOT
 * 把宿主机目录挂进来决定。
 *
 * 写路径强制落在「允许根」之下,由后端 normalizeScriptPath 兜底;
 * 客户端不做严格解析,只把"用户输入"原样下发 —— 后端验证失败会回 400 + 详细原因。
 */
export default function JavaScriptManager() {
  const { hasPerm } = useAuth()
  const canManage = hasPerm('script:manage')

  // 自 v1.7.9 起只支持平台本机模式:直接操作后台容器能看到的文件系统。
  const [rootPath, setRootPath] = useState(ROOT_DEFAULT)

  // 左侧目录树(antd Tree 的 DataNode 形态,children 按需加载)
  const [treeData, setTreeData] = useState<DataNode[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  // 目录树刷新计数器 —— 删除/新建后 +1 让 root 重新加载
  const [treeVersion, setTreeVersion] = useState(0)

  // 当前选中的文件(在 view/edit 模式之间共享)
  const [selectedFile, setSelectedFile] = useState<ScriptDirEntry | null>(null)

  // 编辑器状态(view/edit + dirty + 内容)
  const [editor, setEditor] = useEditorState()

  // 新建子目录 / 新建脚本 的目标父目录(默认 = 根)
  const [createDirOpen, setCreateDirOpen] = useState(false)
  const [createDirParent, setCreateDirParent] = useState<string | null>(null)
  const [createFileOpen, setCreateFileOpen] = useState(false)
  const [createFileParent, setCreateFileParent] = useState<string | null>(null)

  // 帮助文档抽屉
  const [helpOpen, setHelpOpen] = useState(false)

  /* ---------- 新建子目录 ---------- */
  const onCreateDir = async (vals: { name: string }) => {
    const parent = createDirParent || rootPath
    try {
      await createScriptDir('local', undefined, rootPath, vals.name, parent)
      message.success('目录已创建:' + vals.name)
      setCreateDirOpen(false)
      // 整树重载（目录最多百余项，代价可忽略）
      setTreeVersion((v) => v + 1)
    } catch (e) {
      message.error('创建失败:' + errMsg(e))
    }
  }

  /* ---------- 新建脚本文件 ---------- */
  const onCreateFile = async (vals: { name: string; content?: string }) => {
    const parent = createFileParent || rootPath
    const fullPath = `${parent.replace(/\/+$/, '')}/${vals.name}`
    try {
      await createScriptFile('local', undefined, fullPath, vals.content || '', rootPath)
      message.success('脚本已创建:' + vals.name)
      setCreateFileOpen(false)
      setTreeVersion((v) => v + 1)
    } catch (e) {
      message.error('创建失败:' + errMsg(e))
    }
  }

  /* ---------- 删除条目(目录/文件 自适应) ---------- */
  const onDelete = async (entry: ScriptDirEntry) => {
    const isDir = entry.isDir
    const confirmText = isDir
      ? `确认删除「${entry.name}」及其下所有内容?此操作不可恢复!`
      : `确认删除脚本「${entry.name}」?此操作不可恢复!`
    Modal.confirm({
      title: '删除确认',
      content: confirmText,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteScriptEntry('local', undefined, entry.path, rootPath)
          message.success('已删除:' + entry.name)
          if (selectedFile?.path === entry.path) {
            setSelectedFile(null)
            setEditor({
              mode: 'view',
              open: false,
              dirty: false,
              loading: false,
              content: '',
              baseline: '',
              filePath: undefined,
            })
          }
          setTreeVersion((v) => v + 1)
        } catch (e) {
          message.error('删除失败:' + errMsg(e))
        }
      },
    })
  }

  /* ---------- 节点操作回调(传给树节点右侧的「…」菜单) ---------- */
  const nodeActs = useMemo<NodeActions | undefined>(
    () =>
      canManage
        ? {
            canManage: true,
            onDelete,
            onCreateDir: (parent: string) => {
              setCreateDirParent(parent)
              setCreateDirOpen(true)
            },
            onCreateFile: (parent: string) => {
              setCreateFileParent(parent)
              setCreateFileOpen(true)
            },
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canManage, rootPath],
  )

  /* ---------- 加载根目录下的顶层节点 ---------- */
  const loadRoot = useCallback(async () => {
    setTreeLoading(true)
    try {
      const r = await listScripts('local', undefined, rootPath)
      const items = (r.items || []).filter((it) => !it.name.startsWith('.'))
      setTreeData(items.map((it) => toDataNode(it, rootPath, nodeActs)))
    } catch (e) {
      message.error('加载脚本目录失败:' + errMsg(e))
      setTreeData([])
    } finally {
      setTreeLoading(false)
    }
  }, [rootPath, nodeActs])

  useEffect(() => {
    loadRoot()
  }, [loadRoot, treeVersion])

  /* ---------- 节点展开时按需加载其子节点 ---------- */
  const onLoadData = useCallback(
    async (node: any) => {
      const path: string = node.path
      try {
        const r = await listScripts('local', undefined, path, rootPath)
        const items = (r.items || []).filter((it) => !it.name.startsWith('.'))
        const children = items.map((it) => toDataNode(it, rootPath, nodeActs))
        setTreeData((orig) => updateChildren(orig, node.key as string, children))
      } catch (e) {
        message.error('加载子目录失败:' + errMsg(e))
        // 即使失败也要把节点变成叶子,免得一直转圈
        setTreeData((orig) =>
          updateChildren(orig, node.key as string, []),
        )
      }
    },
    [rootPath, nodeActs],
  )

  /* ---------- 选中节点(目录:展开/折叠;文件:打开编辑器) ---------- */
  const onTreeSelect = useCallback(
    (_keys: React.Key[], info: any) => {
      const node = info.node as DataNode & {
        entry?: ScriptDirEntry
      }
      if (!node || !node.entry) return
      if (node.entry.isDir) {
        // 目录节点:不打开编辑器,仅展开/折叠(由 Tree 自己处理)
        return
      }
      // 文件节点:打开(view 模式)
      openFile(node.entry)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootPath],
  )

  /* ---------- 打开文件到编辑器(view 模式) ---------- */
  const openFile = useCallback(
    async (f: ScriptDirEntry) => {
      // dirty 检查:当前编辑器里有未保存改动 → 切文件前确认
      if (editor.dirty && editor.filePath && editor.filePath !== f.path) {
        Modal.confirm({
          title: '当前编辑未保存',
          content: `正在编辑「${editor.filePath}」有未保存改动,切换到「${f.path}」会丢失。继续?`,
          okText: '切换并丢弃',
          cancelText: '取消',
          okButtonProps: { danger: true },
          onOk: () => {
            doOpenFile(f)
          },
        })
        return
      }
      doOpenFile(f)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, rootPath],
  )

  const doOpenFile = useCallback(
    async (f: ScriptDirEntry) => {
      setEditor({
        mode: 'view',
        open: true,
        dirty: false,
        loading: true,
        content: '',
        baseline: '',
        filePath: f.path,
      })
      try {
        const r = await getScriptFile('local', undefined, f.path, rootPath)
        setSelectedFile(f)
        setEditor({
          mode: 'view',
          open: true,
          dirty: false,
          loading: false,
          content: r.content,
          baseline: r.content,
          filePath: f.path,
        })
      } catch (e) {
        message.error('打开文件失败:' + errMsg(e))
        setEditor({
          mode: 'view',
          open: false,
          dirty: false,
          loading: false,
          content: '',
          baseline: '',
          filePath: undefined,
        })
        setSelectedFile(null)
      }
    },
    [rootPath, setEditor],
  )

  /* ---------- 「编辑」按钮:view → edit ---------- */
  const enterEdit = useCallback(() => {
    if (!editor.open) return
    setEditor({
      ...editor,
      mode: 'edit',
      baseline: editor.content,
    })
  }, [editor, setEditor])

  /* ---------- 「取消」按钮:edit → view(回退内容) ---------- */
  const cancelEdit = useCallback(() => {
    setEditor({
      ...editor,
      mode: 'view',
      content: editor.baseline ?? editor.content,
      dirty: false,
    })
  }, [editor, setEditor])

  /* ---------- 保存当前编辑 ---------- */
  const saveFile = useCallback(async () => {
    if (!selectedFile || !editor.filePath) return
    if (!editor.dirty) {
      message.info('没有改动')
      return
    }
    try {
      await putScriptFile(
        'local',
        undefined,
        editor.filePath,
        editor.content,
        rootPath,
      )
      message.success('保存成功')
      setEditor({
        ...editor,
        mode: 'view',
        dirty: false,
        baseline: editor.content,
      })
      // 刷新目录树(文件大小/时间会变)
      setTreeVersion((v) => v + 1)
    } catch (e) {
      message.error('保存失败:' + errMsg(e))
    }
  }, [selectedFile, editor, rootPath, setEditor])

  /* ---------- UI 渲染 ---------- */
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          <CodeOutlined style={{ marginRight: 8 }} />
          Java 启停脚本管理
        </Title>
        <Tag color="purple">v1.8.0</Tag>
        <div style={{ flex: 1 }} />
        <Tooltip title="查看使用说明">
          <Button icon={<QuestionCircleOutlined />} onClick={() => setHelpOpen(true)}>
            使用说明
          </Button>
        </Tooltip>
      </div>

      {/* 顶部:脚本根路径 + 操作 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Form layout="inline">
          <Form.Item label="脚本根路径" style={{ minWidth: 420 }}>
            <Input
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder={ROOT_DEFAULT}
              allowClear
            />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button
                icon={<ReloadOutlined />}
                onClick={() => setTreeVersion((v) => v + 1)}
              >
                刷新
              </Button>
              {canManage && (
                <>
                  <Button
                    icon={<FolderAddOutlined />}
                    type="primary"
                    onClick={() => {
                      setCreateDirParent(rootPath)
                      setCreateDirOpen(true)
                    }}
                  >
                    新建目录
                  </Button>
                  <Button
                    icon={<FileAddOutlined />}
                    onClick={() => {
                      setCreateFileParent(rootPath)
                      setCreateFileOpen(true)
                    }}
                  >
                    新建脚本
                  </Button>
                </>
              )}
            </Space>
          </Form.Item>
        </Form>
      </Card>

      <Row gutter={12}>
        {/* 左:目录树(任意层级) */}
        <Col span={7}>
          <Card
            size="small"
            title={
              <span>
                <FolderOutlined /> 目录树({countTreeNodes(treeData)})
              </span>
            }
            bodyStyle={{ padding: 0, height: 'calc(100vh - 280px)', overflow: 'auto' }}
            extra={
              canManage ? (
                <Space size={4}>
                  <Tooltip title="在根下新建">
                    <Button
                      size="small"
                      type="text"
                      icon={<FolderAddOutlined />}
                      onClick={() => {
                        setCreateDirParent(rootPath)
                        setCreateDirOpen(true)
                      }}
                    />
                  </Tooltip>
                </Space>
              ) : null
            }
          >
            {treeLoading && treeData.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center' }}>
                <Spin />
              </div>
            ) : treeData.length === 0 ? (
              <Empty
                description="暂无条目"
                imageStyle={{ height: 80 }}
                style={{ padding: 16 }}
              >
                {canManage && (
                  <Space>
                    <Button
                      type="primary"
                      icon={<FolderAddOutlined />}
                      onClick={() => {
                        setCreateDirParent(rootPath)
                        setCreateDirOpen(true)
                      }}
                    >
                      新建目录
                    </Button>
                    <Button
                      icon={<FileAddOutlined />}
                      onClick={() => {
                        setCreateFileParent(rootPath)
                        setCreateFileOpen(true)
                      }}
                    >
                      新建脚本
                    </Button>
                  </Space>
                )}
              </Empty>
            ) : (
              <ScriptTreeView
                treeData={treeData}
                onLoadData={onLoadData}
                onSelect={onTreeSelect}
                onDelete={canManage ? onDelete : undefined}
                onCreateDir={(parent) => {
                  setCreateDirParent(parent)
                  setCreateDirOpen(true)
                }}
                onCreateFile={(parent) => {
                  setCreateFileParent(parent)
                  setCreateFileOpen(true)
                }}
                canManage={canManage}
              />
            )}
          </Card>
        </Col>

        {/* 右:编辑器(view/edit 两态) */}
        <Col span={17}>
          <Card
            size="small"
            title={
              <span>
                {editor.mode === 'edit' ? <EditOutlined /> : <EyeOutlined />}
                &nbsp;
                {selectedFile ? selectedFile.name : '脚本预览'}
                {selectedFile && (
                  <Tag color="blue" style={{ marginLeft: 8 }}>
                    {selectedFile.path}
                  </Tag>
                )}
              </span>
            }
            bodyStyle={{ padding: 0, height: 'calc(100vh - 280px)', overflow: 'hidden' }}
          >
            <EditorPanel
              file={selectedFile}
              editor={editor}
              canManage={canManage}
              onEnterEdit={enterEdit}
              onCancelEdit={cancelEdit}
              onChange={(v) =>
                setEditor({ ...editor, content: v, dirty: v !== editor.baseline })
              }
              onSave={saveFile}
            />
          </Card>
        </Col>
      </Row>

      {/* 新建目录 */}
      <CreateDirModal
        open={createDirOpen}
        onCancel={() => setCreateDirOpen(false)}
        onSubmit={onCreateDir}
        parentPath={createDirParent}
      />
      {/* 新建脚本 */}
      <CreateFileModal
        open={createFileOpen}
        onCancel={() => setCreateFileOpen(false)}
        onSubmit={onCreateFile}
        parentPath={createFileParent}
      />
      {/* 帮助 */}
      <Drawer
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        title="Java 启停脚本管理 · 使用说明"
        width={560}
      >
        <Paragraph>
          <strong>适用场景:</strong>管理业务服务器上一组 Java
          服务的启停脚本(如 <code>start.sh</code> / <code>stop.sh</code>
          / <code>restart.sh</code>)。
        </Paragraph>
        <Paragraph>
          <strong>目录结构:</strong>
          <pre
            style={{
              background: 'var(--bg-soft)',
              padding: 12,
              borderRadius: 6,
            }}
          >
{`${ROOT_DEFAULT}
├── 高质量发展-测试环境-后端java-auth-上传包/
│   └── dits-auth.jar/                # 与 jar 同名的目录(便于按服务归档)
│       └── java-start.sh
├── 高质量发展-生产环境-后端java-auth-上传包/
│   └── ...
└── ...`}
          </pre>
        </Paragraph>
        <Paragraph>
          <strong>使用流程(v1.8.0+):</strong>
          <ol>
            <li>左侧目录树 <strong>双击文件夹</strong>展开子目录,单击文件名进入只读预览</li>
            <li>
              <strong>悬浮任意节点</strong> → 点右侧「<strong>…</strong>」菜单 →
              可在该目录下「<strong>新建子目录</strong>」「<strong>新建文件</strong>」或删除该节点
              (v1.8.0 起<strong>不再局限于根目录</strong>)
            </li>
            <li>点顶部「<strong>编辑</strong>」按钮 → 进入编辑态</li>
            <li>改完点「保存」回到只读态;不想改了点「取消」回退</li>
            <li>顶部「刷新」或新建/删除会自动同步目录树</li>
          </ol>
        </Paragraph>
        <Paragraph>
          <Text type="secondary">
            ⚠️ 平台跑在容器里时,「本机」= <strong>容器</strong>文件系统。
            要看到主机的脚本目录,必须在 <code>docker-compose.yml</code> 的
            <code>backend.volumes</code> 里把该路径挂进容器(默认挂
            <code>{ROOT_DEFAULT}</code>,可通过 <code>.env</code> 的
            <code>SCRIPT_HOST_ROOT</code> 覆盖)。改完 compose 要{' '}
            <code>docker compose up -d --no-build backend</code>。
          </Text>
        </Paragraph>
        <Paragraph>
          <strong>权限:</strong>
          <ul>
            <li>
              <Tag color="blue">script:view</Tag> 查看目录树、脚本内容
            </li>
            <li>
              <Tag color="purple">script:manage</Tag> 新建 / 修改 / 删除目录与脚本
            </li>
          </ul>
        </Paragraph>
        <Paragraph>
          <strong>备份:</strong>每次保存会先复制到 <code>{`<原文件>.ophub.bak`}</code>;
          如果修改失败,可用 SSH 登录目标机恢复。
        </Paragraph>
      </Drawer>
    </div>
  )
}

/* ============================================================================
 * 子组件
 * ========================================================================== */

/** 树节点上的操作回调（v1.8.0：任意目录下新建子目录/文件 + 删除） */
interface NodeActions {
  canManage: boolean
  onDelete: (entry: ScriptDirEntry) => void
  onCreateDir: (parent: string) => void
  onCreateFile: (parent: string) => void
}

/** 把后端返回的 ScriptDirEntry 转成 antd Tree 的 DataNode */
function toDataNode(
  it: ScriptDirEntry,
  root: string,
  acts?: NodeActions,
): DataNode & {
  entry: ScriptDirEntry
  path: string
} {
  const path = it.path
  const title = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        padding: '2px 0',
      }}
    >
      {it.isDir ? (
        <FolderOutlined style={{ color: '#f59e0b' }} />
      ) : (
        <FileTextOutlined style={{ color: '#6366f1' }} />
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {it.name}
      </span>
      {!it.isDir && (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {fmtBytes(it.size)}
        </Text>
      )}
      {acts?.canManage && <NodeActionsMenu entry={it} acts={acts} />}
    </div>
  )
  return {
    key: path,
    title,
    isLeaf: !it.isDir,
    path,
    entry: it,
    // 目录节点的 children 留空数组(loadData 触发后填)
    children: it.isDir ? [] : undefined,
  }
}

/** 节点右侧悬浮操作菜单（点击展开，不触发树选中） */
function NodeActionsMenu({
  entry,
  acts,
}: {
  entry: ScriptDirEntry
  acts: NodeActions
}) {
  const items: { key: string; icon: React.ReactNode; label: string; danger?: boolean }[] = []
  if (entry.isDir) {
    items.push({ key: 'mkdir', icon: <FolderAddOutlined />, label: '新建子目录' })
    items.push({ key: 'mkfile', icon: <FileAddOutlined />, label: '新建文件' })
  }
  items.push({ key: 'del', icon: <DeleteOutlined />, label: '删除', danger: true })
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items,
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation()
          if (key === 'mkdir') acts.onCreateDir(entry.path)
          else if (key === 'mkfile') acts.onCreateFile(entry.path)
          else if (key === 'del') acts.onDelete(entry)
        },
      }}
    >
      <Button
        type="text"
        size="small"
        icon={<MoreOutlined style={{ color: '#94a3b8' }} />}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
        }}
        className="script-node-more"
        data-node-more="1"
      />
    </Dropdown>
  )
}

/** 把某节点下的 children 替换掉(用于 loadData 回填) */
function updateChildren(
  orig: DataNode[],
  key: string,
  children: DataNode[],
): DataNode[] {
  return orig.map((n) => {
    if (n.key === key) {
      return { ...n, children }
    }
    if (n.children && n.children.length > 0) {
      return {
        ...n,
        children: updateChildren(n.children, key, children),
      }
    }
    return n
  })
}

/** 数 tree 里有多少个节点(粗略,用于 Card title 显示计数) */
function countTreeNodes(nodes: DataNode[]): number {
  let n = 0
  for (const x of nodes) {
    n += 1
    if (x.children && x.children.length > 0) {
      n += countTreeNodes(x.children)
    }
  }
  return n
}

/** 目录树
 *
 * v1.7.25 改造(用户反馈"双击文件夹展开,不要 [+] 按钮"):
 *   - expandAction="doubleClick"  →  双击节点才展开,单击只选中
 *   - CSS 隐藏 .ant-tree-switcher  →  彻底去掉左侧 [+]/[-] 三角
 *   - showLine 保留连线(展示层级),只把开关按钮本身抹掉
 */
function ScriptTreeView(props: {
  treeData: DataNode[]
  onLoadData: (node: any) => Promise<void>
  onSelect: (keys: React.Key[], info: any) => void
  onDelete?: (entry: ScriptDirEntry) => void
  onCreateDir: (parent: string) => void
  onCreateFile: (parent: string) => void
  canManage: boolean
}) {
  return (
    <>
      {/* 用 className 精准定位到本组件的 Tree,
          * 把开关按钮折叠掉(只显示文字 + 连线)。 */}
      <style>{`
        .script-tree-no-switcher .ant-tree-switcher {
          width: 0 !important;
          min-width: 0 !important;
          padding: 0 !important;
          visibility: hidden !important;
        }
        .script-tree-no-switcher .ant-tree-switcher__noop {
          display: none !important;
        }
        .script-tree-no-switcher .ant-tree-node-content-wrapper {
          flex: 1;
        }
        /* 节点「…」操作按钮:悬浮才显示(v1.8.0 任意目录下新建/删除) */
        .script-node-more {
          opacity: 0;
          transition: opacity 0.15s ease;
        }
        .ant-tree-node-content-wrapper:hover .script-node-more,
        .script-node-more.ant-dropdown-open {
          opacity: 1;
        }
      `}</style>
      <Tree
        className="script-tree-no-switcher"
        treeData={props.treeData}
        loadData={props.onLoadData}
        onSelect={props.onSelect}
        expandAction="doubleClick"
        showLine={{ showLeafIcon: false }}
        blockNode
        defaultExpandAll={false}
        style={{ padding: 6 }}
      />
    </>
  )
}

/** 编辑器面板:view / edit 两态 */
function EditorPanel(props: {
  file: ScriptDirEntry | null
  editor: EditorState
  canManage: boolean
  onEnterEdit: () => void
  onCancelEdit: () => void
  onChange: (v: string) => void
  onSave: () => void
}) {
  if (!props.file) {
    return (
      <Empty
        description="选择左侧目录树里的脚本以预览"
        style={{ marginTop: 80 }}
      />
    )
  }
  if (props.editor.loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin />
      </div>
    )
  }

  const isEdit = props.editor.mode === 'edit'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部信息栏 + 操作 */}
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
          {props.file.path} · {fmtBytes(props.file.size)}
        </Text>
        {isEdit && (
          <Tag color="orange" style={{ margin: 0 }}>
            编辑中{props.editor.dirty ? ' · 有改动' : ''}
          </Tag>
        )}
        {!isEdit && props.canManage && (
          <Button
            size="small"
            type="primary"
            icon={<EditOutlined />}
            onClick={props.onEnterEdit}
          >
            编辑
          </Button>
        )}
        {isEdit && props.canManage && (
          <Space size={4}>
            <Button size="small" onClick={props.onCancelEdit}>
              取消
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<SaveOutlined />}
              onClick={props.onSave}
              disabled={!props.editor.dirty}
            >
              保存
            </Button>
          </Space>
        )}
      </div>

      {/* 内容区 */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {isEdit ? (
          <TextArea
            value={props.editor.content}
            onChange={(e) => props.onChange(e.target.value)}
            spellCheck={false}
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
        ) : (
          <pre
            style={{
              flex: 1,
              margin: 0,
              padding: '12px 16px',
              overflow: 'auto',
              background: 'var(--bg-soft)',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              fontSize: 13,
              lineHeight: 1.5,
              whiteSpace: 'pre',
            }}
          >
            {props.editor.content || '(空文件)'}
          </pre>
        )}
      </div>
    </div>
  )
}

/** 新建目录(任意父目录) */
function CreateDirModal(props: {
  open: boolean
  onCancel: () => void
  onSubmit: (v: { name: string }) => void
  parentPath: string | null
}) {
  const [form] = Form.useForm<{ name: string }>()
  useEffect(() => {
    if (props.open) form.resetFields()
  }, [props.open, form])
  const parent = props.parentPath || ROOT_DEFAULT
  return (
    <Modal
      title="新建目录"
      open={props.open}
      onCancel={props.onCancel}
      onOk={() => form.submit()}
      okText="创建"
      cancelText="取消"
      destroyOnClose
    >
      <Paragraph type="secondary">
        将创建在 <code>{parent}/&lt;目录名&gt;</code> 下
      </Paragraph>
      <Form form={form} layout="vertical" onFinish={props.onSubmit}>
        <Form.Item
          name="name"
          label="目录名"
          rules={[
            { required: true, message: '请填写目录名' },
            {
              pattern: /^[\p{L}\p{N}_.-]+$/u,
              message: '只能包含字母/数字/下划线/中划线/点(支持中文)',
            },
          ]}
        >
          <Input placeholder="order-service 或 中文服务名" autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  )
}

/** 新建脚本文件(任意父目录) */
function CreateFileModal(props: {
  open: boolean
  onCancel: () => void
  onSubmit: (v: { name: string; content?: string }) => void
  parentPath: string | null
}) {
  const [form] = Form.useForm<{ name: string; content?: string }>()
  useEffect(() => {
    if (props.open) form.resetFields()
  }, [props.open, form])
  const parent = props.parentPath || ROOT_DEFAULT
  return (
    <Modal
      title={`在「${parent}」下新建脚本`}
      open={props.open}
      onCancel={props.onCancel}
      onOk={() => form.submit()}
      okText="创建"
      cancelText="取消"
      destroyOnClose
      width={640}
    >
      <Form form={form} layout="vertical" onFinish={props.onSubmit}>
        <Form.Item
          name="name"
          label="文件名"
          rules={[
            { required: true, message: '请填写文件名' },
            {
              pattern: /^[\p{L}\p{N}_.-]+$/u,
              message: '只能包含字母/数字/下划线/中划线/点(支持中文)',
            },
          ]}
        >
          <Input placeholder="start.sh" />
        </Form.Item>
        <Form.Item name="content" label="初始内容(可选)">
          <TextArea
            rows={8}
            placeholder="#!/bin/bash&#10;# 启动脚本&#10;..."
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}

/* ============================================================================
 * useEditorState —— 编辑器状态
 *
 *  v1.7.24 改造:加 mode 字段(view/edit 两态);
 *  baseline 是「进入编辑模式时的内容快照」,cancel 时回退;
 *  filePath 用于切换文件时判断 dirty。
 * ========================================================================== */
interface EditorState {
  mode: 'view' | 'edit'
  open: boolean
  dirty: boolean
  loading?: boolean
  content: string
  baseline?: string
  filePath?: string
}
function useEditorState(): [EditorState, (s: EditorState) => void] {
  return useState<EditorState>({
    mode: 'view',
    open: false,
    dirty: false,
    loading: false,
    content: '',
    baseline: '',
  })
}