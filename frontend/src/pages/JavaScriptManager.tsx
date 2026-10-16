// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

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
import type { MenuProps } from 'antd'
import type { DataNode } from 'antd/es/tree'
import {
  CloudServerOutlined,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
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

/** 树内「正在新建」临时节点的 key */
const DRAFT_KEY = '__ophub_draft__'

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
 *
 * v1.8.1 改造(用户反馈「悬浮 … 按钮太低级」):
 *   - 节点悬浮「…」按钮 → 删除;改为**右键上下文菜单**:
 *       目录:新建子目录 / 新建文件 / 刷新此目录 / 复制路径 / 删除目录
 *       文件:打开 / 复制路径 / 删除文件
 *       树空白处:新建目录 / 新建文件 / 刷新目录树
 *   - 「新建」不再弹 Modal,而是在目标节点下插入一个**树内输入框**(VSCode 风格),
 *     回车确认、Esc 取消、失焦(空则取消,非空则提交)。
 *   - 整树刷新会保留已展开层级(按路径长度逐层回填 children),
 *     否则新建后已展开的目录会被清空。
 */
export default function JavaScriptManager() {
  const { hasPerm } = useAuth()
  const canCreate = hasPerm('script:create')
  const canEdit = hasPerm('script:update')
  const canDelete = hasPerm('script:delete')

  // 自 v1.7.9 起只支持平台本机模式:直接操作后台容器能看到的文件系统。
  const [rootPath, setRootPath] = useState(ROOT_DEFAULT)

  // 左侧目录树(antd Tree 的 DataNode 形态,children 按需加载)
  const [treeData, setTreeData] = useState<DataNode[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  // 目录树刷新计数器 —— 删除/新建后 +1 让树重新加载
  const [treeVersion, setTreeVersion] = useState(0)
  // 展开状态的快照(refreshTree 内部读它,避免把 expandedKeys 列进依赖造成递归刷新)
  const expandedRef = useRef<React.Key[]>([])

  // 当前选中的文件(在 view/edit 模式之间共享)
  const [selectedFile, setSelectedFile] = useState<ScriptDirEntry | null>(null)

  // 编辑器状态(view/edit + dirty + 内容)
  const [editor, setEditor] = useEditorState()

  // 展开的目录 key（= 目录完整路径）。受控：刷新树后要保持展开状态。
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])

  // v1.8.1：就地新建 —— 右键目录 →「新建子目录 / 新建文件」，树内直接出现输入框，
  // 回车确认、Esc 取消（VSCode 风格）。不再用弹窗 + 悬浮「…」按钮。
  // parentKey = null 表示建在根目录。
  const [draft, setDraft] = useState<DraftState | null>(null)
  useEffect(() => {
    expandedRef.current = expandedKeys
  }, [expandedKeys])

  // 帮助文档抽屉
  const [helpOpen, setHelpOpen] = useState(false)

  /* ---------- 复制路径到剪贴板 ---------- */
  const copyText = useCallback(async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        // http 环境 Clipboard API 不可用 → 回退 execCommand
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      message.success('已复制:' + text)
    } catch {
      message.info(text)
    }
  }, [])

  /* ---------- 重新拉取某个目录的子节点(右键「刷新」) ---------- */
  const reloadDir = useCallback(
    async (dirPath: string) => {
      try {
        const r = await listScripts('local', undefined, dirPath, rootPath)
        const items = (r.items || []).filter((it) => !it.name.startsWith('.'))
            setTreeData((orig) =>
              updateChildren(
                orig,
                dirPath,
                items.map((it) => toDataNode(it)),
              ),
            )
      } catch (e) {
        message.error('刷新目录失败:' + errMsg(e))
      }
    },
    [rootPath],
  )

  /* ---------- 整树刷新(保持已展开层级) ---------- */
  const refreshTree = useCallback(async () => {
    setTreeLoading(true)
    try {
      const r = await listScripts('local', undefined, rootPath)
      const items = (r.items || []).filter((it) => !it.name.startsWith('.'))
      let nodes: DataNode[] = items.map((it) => toDataNode(it))
      // 整树重建会冲掉已加载的 children → 按路径从短到长逐层补回,保持展开视图
      const keys = [...expandedRef.current].sort(
        (a, b) => String(a).length - String(b).length,
      )
      for (const k of keys) {
        try {
          const rr = await listScripts('local', undefined, String(k), rootPath)
          const ci = (rr.items || []).filter((it) => !it.name.startsWith('.'))
          nodes = updateChildren(nodes, String(k), ci.map((it) => toDataNode(it)))
        } catch {
          /* 单个目录失败不打断整体刷新 */
        }
      }
      setTreeData(nodes)
    } catch (e) {
      message.error('加载脚本目录失败:' + errMsg(e))
      setTreeData([])
    } finally {
      setTreeLoading(false)
    }
  }, [rootPath])

  /**
   * ---------- 就地新建:在目标目录下插一个输入框(v1.8.1) ----------
   * parentKey = null → 建在根目录;否则先确保该目录已展开且子节点已加载。
   */
  const startDraft = useCallback(
    async (parentPath: string, parentKey: string | null, type: 'dir' | 'file') => {
      if (parentKey) {
        setExpandedKeys((prev) =>
          prev.includes(parentKey) ? prev : [...prev, parentKey],
        )
        const n = findNode(treeData, parentKey)
        if (n && (!n.children || n.children.length === 0)) {
          try {
            const r = await listScripts('local', undefined, parentPath, rootPath)
            const items = (r.items || []).filter((it) => !it.name.startsWith('.'))
            setTreeData((orig) =>
              updateChildren(
                orig,
                parentKey,
                items.map((it) => toDataNode(it)),
              ),
            )
          } catch (e) {
            message.error('读取目录失败:' + errMsg(e))
          }
        }
      }
      setDraft({ parentKey, parentPath, type })
    },
    [treeData, rootPath],
  )

  /** 提交新建(回车 / 失焦) */
  const submitDraft = useCallback(
    async (name: string) => {
      const d = draft
      if (!d) return
      setDraft(null)
      try {
        if (d.type === 'dir') {
          await createScriptDir('local', undefined, rootPath, name, d.parentPath)
        } else {
          const full = `${d.parentPath.replace(/\/+$/, '')}/${name}`
          await createScriptFile('local', undefined, full, '', rootPath)
        }
        message.success((d.type === 'dir' ? '目录已创建: ' : '文件已创建: ') + name)
        if (d.parentKey) {
          setExpandedKeys((prev) =>
            prev.includes(d.parentKey as string)
              ? prev
              : [...prev, d.parentKey as string],
          )
        }
        await refreshTree()
      } catch (e) {
        message.error('创建失败:' + errMsg(e))
      }
    },
    [draft, rootPath, refreshTree],
  )

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

  /* ---------- 右键菜单 / 就地新建 的动作集合 ---------- */
  const nodeActs: NodeActions = useMemo(
    () => ({
      canCreate,
      canDelete,
      onDraft: (parentPath, parentKey, type) => {
        void startDraft(parentPath, parentKey, type)
      },
      onDelete,
      onOpen: (entry) => {
        void openFile(entry)
      },
      onReload: (dirPath) => {
        void reloadDir(dirPath)
      },
      onCopy: (text) => {
        void copyText(text)
      },
      onRefreshAll: () => {
        void refreshTree()
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canCreate, canDelete, startDraft, reloadDir, refreshTree, copyText],
  )

  useEffect(() => {
    refreshTree()
  }, [refreshTree, treeVersion])

  /* ---------- 节点展开时按需加载其子节点 ---------- */
  const onLoadData = useCallback(
    async (node: any) => {
      const path: string = node.path
      try {
        const r = await listScripts('local', undefined, path, rootPath)
        const items = (r.items || []).filter((it) => !it.name.startsWith('.'))
        const children = items.map((it) => toDataNode(it))
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
        <Tag color="purple">v1.8.1</Tag>
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
              {canCreate && (
                <>
                  <Button
                    icon={<FolderAddOutlined />}
                    type="primary"
                    onClick={() => void startDraft(rootPath, null, 'dir')}
                  >
                    新建目录
                  </Button>
                  <Button
                    icon={<FileAddOutlined />}
                    onClick={() => void startDraft(rootPath, null, 'file')}
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
              <Space size={4}>
                {canCreate && (
                  <Tooltip title="在根目录下新建目录">
                    <Button
                      size="small"
                      type="text"
                      icon={<FolderAddOutlined />}
                      onClick={() => void startDraft(rootPath, null, 'dir')}
                    />
                  </Tooltip>
                )}
                <Tooltip title="刷新目录树">
                  <Button
                    size="small"
                    type="text"
                    icon={<ReloadOutlined />}
                    onClick={() => setTreeVersion((v) => v + 1)}
                  />
                </Tooltip>
              </Space>
            }
          >
            {treeLoading && treeData.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center' }}>
                <Spin />
              </div>
            ) : treeData.length === 0 && !draft ? (
              <Empty
                description="暂无条目 —— 右键空白处可新建"
                imageStyle={{ height: 80 }}
                style={{ padding: 16 }}
              >
                {canCreate && (
                  <Space>
                    <Button
                      type="primary"
                      icon={<FolderAddOutlined />}
                      onClick={() => void startDraft(rootPath, null, 'dir')}
                    >
                      新建目录
                    </Button>
                    <Button
                      icon={<FileAddOutlined />}
                      onClick={() => void startDraft(rootPath, null, 'file')}
                    >
                      新建脚本
                    </Button>
                  </Space>
                )}
              </Empty>
            ) : (
              <ScriptTreeView
                treeData={treeData}
                draft={draft}
                acts={nodeActs}
                rootPath={rootPath}
                expandedKeys={expandedKeys}
                onExpand={setExpandedKeys}
                onLoadData={onLoadData}
                onSelect={onTreeSelect}
                onDraftSubmit={submitDraft}
                onDraftCancel={() => setDraft(null)}
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
              canEdit={canEdit}
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

      {/* 新建目录 / 新建文件:v1.8.1 起改为树内就地输入,不再用弹窗 */}
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
          <strong>使用流程(v1.8.1+):</strong>
          <ol>
            <li>左侧目录树 <strong>双击文件夹</strong>展开子目录,单击文件名进入只读预览</li>
            <li>
              <strong>右键任意目录</strong> → 菜单选「<strong>新建子目录</strong>」或
              「<strong>新建文件</strong>」→ 该目录下直接出现输入框:
              填名称后<strong>回车</strong>确认、<strong>Esc</strong> 取消(任意层级都支持)
            </li>
            <li>
              <strong>右键文件</strong> → 打开 / 复制路径 / 删除;
              <strong>右键空白处</strong> → 在根目录下新建目录或脚本、刷新整棵树
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
              <Tag color="purple">script:create</Tag> 新建目录与脚本
            </li>
            <li>
              <Tag color="purple">script:update</Tag> 修改脚本内容
            </li>
            <li>
              <Tag color="purple">script:delete</Tag> 删除目录与脚本
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

/** 树节点的右键菜单 / 就地新建动作集合（v1.8.1） */
interface NodeActions {
  /** 新建子目录 / 新建文件（script:create） */
  canCreate: boolean
  /** 删除目录 / 删除文件（script:delete） */
  canDelete: boolean
  /** 在 parentPath 下就地新建;parentKey = null 表示根目录 */
  onDraft: (parentPath: string, parentKey: string | null, type: 'dir' | 'file') => void
  onDelete: (entry: ScriptDirEntry) => void
  onOpen: (entry: ScriptDirEntry) => void
  onReload: (dirPath: string) => void
  onCopy: (text: string) => void
  onRefreshAll: () => void
}

/** 就地新建状态:在哪个目录下新建、建目录还是文件 */
interface DraftState {
  parentKey: string | null
  parentPath: string
  type: 'dir' | 'file'
}

/** 把后端返回的 ScriptDirEntry 转成 antd Tree 的 DataNode
 *  (title 交给 Tree 的 titleRender 渲染 —— 这样右键菜单永远拿到最新的回调) */
function toDataNode(it: ScriptDirEntry): DataNode & {
  entry: ScriptDirEntry
  path: string
} {
  return {
    key: it.path,
    isLeaf: !it.isDir,
    path: it.path,
    entry: it,
    // 目录节点的 children 留空数组(loadData 触发后填)
    children: it.isDir ? [] : undefined,
  }
}

/** 右键菜单点击后分发 */
function runMenuAction(key: string, e: ScriptDirEntry, acts: NodeActions) {
  switch (key) {
    case 'mkdir':
      acts.onDraft(e.path, e.path, 'dir')
      break
    case 'mkfile':
      acts.onDraft(e.path, e.path, 'file')
      break
    case 'open':
      acts.onOpen(e)
      break
    case 'reload':
      acts.onReload(e.path)
      break
    case 'copy':
      acts.onCopy(e.path)
      break
    case 'del':
      acts.onDelete(e)
      break
  }
}

/** 节点的右键菜单项:目录 → 新建子目录/新建文件/刷新/复制路径/删除;
 *  文件 → 打开/复制路径/删除。
 *  菜单项按最小权限过滤:新建项需 script:create、删除项需 script:delete。 */
function nodeMenuItems(e: ScriptDirEntry, acts: NodeActions): MenuProps['items'] {
  if (e.isDir) {
    return [
      ...(acts.canCreate
        ? [
            { key: 'mkdir', icon: <FolderAddOutlined />, label: '新建子目录' },
            { key: 'mkfile', icon: <FileAddOutlined />, label: '新建文件' },
            { type: 'divider' as const },
          ]
        : []),
      { key: 'reload', icon: <ReloadOutlined />, label: '刷新此目录' },
      { key: 'copy', icon: <CopyOutlined />, label: '复制路径' },
      ...(acts.canDelete
        ? [
            { type: 'divider' as const },
            { key: 'del', icon: <DeleteOutlined />, label: '删除目录', danger: true },
          ]
        : []),
    ]
  }
  return [
    { key: 'open', icon: <EyeOutlined />, label: '打开' },
    { key: 'copy', icon: <CopyOutlined />, label: '复制路径' },
    ...(acts.canDelete
      ? [
          { type: 'divider' as const },
          { key: 'del', icon: <DeleteOutlined />, label: '删除文件', danger: true },
        ]
      : []),
  ]
}

/** 单个节点的标题:外层包 Dropdown(trigger=contextMenu) → 右键该节点弹菜单。
 *  ⚠️ onContextMenu 里 stopPropagation:避免冒泡到树的空白处菜单(否则两个菜单一起弹)。 */
function renderNodeTitle(node: any, acts: NodeActions, expanded: React.Key[]) {
  if (node.key === DRAFT_KEY) return null // 正常走不到:draft 由外层 renderTitle 处理
  const e = node.entry as ScriptDirEntry
  if (!e) return <span>{String(node.key)}</span>
  const isOpen = expanded.includes(node.key)
  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={{
        items: nodeMenuItems(e, acts),
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation()
          runMenuAction(key, e, acts)
        },
      }}
    >
      <div
        className="script-node"
        data-path={e.path}
        onContextMenu={(ev) => ev.stopPropagation()}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          padding: '2px 0',
        }}
      >
        {e.isDir ? (
          isOpen ? (
            <FolderOpenOutlined style={{ color: '#f59e0b' }} />
          ) : (
            <FolderOutlined style={{ color: '#f59e0b' }} />
          )
        ) : (
          <FileTextOutlined style={{ color: '#6366f1' }} />
        )}
        <span
          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {e.name}
        </span>
        {!e.isDir && (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {fmtBytes(e.size)}
          </Text>
        )}
      </div>
    </Dropdown>
  )
}

/** 树内就地新建的输入框:回车确认 / Esc 取消 / 失焦(空则取消、非空则提交) */
function DraftInput(props: {
  type: 'dir' | 'file'
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [v, setV] = useState('')
  const [err, setErr] = useState('')
  // 防止「回车提交 → 卸载 → blur 再提交一次」的重复触发
  const done = useRef(false)
  const submit = () => {
    if (done.current) return
    const name = v.trim()
    if (!name) {
      done.current = true
      props.onCancel()
      return
    }
    if (!/^[\p{L}\p{N}_.-]+$/u.test(name)) {
      setErr('只能包含中文/字母/数字/下划线/中划线/点')
      return
    }
    done.current = true
    props.onSubmit(name)
  }
  const cancel = () => {
    if (done.current) return
    done.current = true
    props.onCancel()
  }
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '1px 0' }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {props.type === 'dir' ? (
        <FolderAddOutlined style={{ color: '#f59e0b' }} />
      ) : (
        <FileAddOutlined style={{ color: '#6366f1' }} />
      )}
      <Input
        size="small"
        autoFocus
        value={v}
        status={err ? 'error' : undefined}
        placeholder={props.type === 'dir' ? '目录名,回车确认' : '文件名,如 start.sh'}
        onChange={(e) => {
          setV(e.target.value)
          if (err) setErr('')
        }}
        onPressEnter={(e) => {
          e.preventDefault()
          e.stopPropagation()
          submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            cancel()
          }
        }}
        onBlur={() => {
          if (!v.trim()) cancel()
          else submit()
        }}
        style={{ width: 190, height: 22, fontSize: 12 }}
      />
      {err && (
        <Text type="danger" style={{ fontSize: 11 }}>
          {err}
        </Text>
      )}
    </span>
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
 * v1.7.25:expandAction="doubleClick" + CSS 隐藏 [+]/[-] 开关(用户要求不要三角按钮)。
 * v1.8.1:去掉节点悬浮「…」按钮,改为——
 *   - 右键任意节点 → 上下文菜单(目录:新建子目录/新建文件/刷新/复制路径/删除;
 *     文件:打开/复制路径/删除)
 *   - 右键树空白处 → 在根目录下新建目录/新建文件、刷新
 *   - 「新建」不再弹窗,而是在目标节点下插入一个输入框(VSCode 风格),
 *     回车确认、Esc 取消。
 */
function ScriptTreeView(props: {
  treeData: DataNode[]
  draft: DraftState | null
  acts: NodeActions
  rootPath: string
  expandedKeys: React.Key[]
  onExpand: (keys: React.Key[]) => void
  onLoadData: (node: any) => Promise<void>
  onSelect: (keys: React.Key[], info: any) => void
  onDraftSubmit: (name: string) => void
  onDraftCancel: () => void
}) {
  const { treeData, draft, acts, rootPath, onDraftSubmit, onDraftCancel } = props

  // 把「正在新建」的临时节点插到目标父节点下
  const displayData = useMemo<DataNode[]>(() => {
    if (!draft) return treeData
    const dn: DataNode & { draftType: 'dir' | 'file'; [k: string]: any } = {
      key: DRAFT_KEY,
      isLeaf: true,
      selectable: false,
      draftType: draft.type,
      onDraftSubmit,
      onDraftCancel,
    }
    if (!draft.parentKey) return [...treeData, dn]
    const hit = findNode(treeData, draft.parentKey)
    // 父节点不在树里(极端情况:刚被删) → 退回根目录
    if (!hit) return [...treeData, dn]
    return insertDraftNode(treeData, draft.parentKey, dn)
  }, [treeData, draft, onDraftSubmit, onDraftCancel])

  // ⚠️ draft 输入框的 props 走闭包,不依赖 Tree 把自定义字段透传给 titleRender
  const renderTitle = useCallback(
    (node: any) => {
      if (node?.key === DRAFT_KEY && draft) {
        return (
          <DraftInput
            type={draft.type}
            onSubmit={onDraftSubmit}
            onCancel={onDraftCancel}
          />
        )
      }
      return renderNodeTitle(node, acts, props.expandedKeys)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [acts, props.expandedKeys, draft, onDraftSubmit, onDraftCancel],
  )

  // 空白处右键菜单(节点上右键会被 stopPropagation 拦掉,不会走到这里)
  const blankItems: MenuProps['items'] = [
    ...(acts.canCreate
      ? [
          { key: 'mkdir', icon: <FolderAddOutlined />, label: '新建目录' },
          { key: 'mkfile', icon: <FileAddOutlined />, label: '新建文件' },
          { type: 'divider' as const },
        ]
      : []),
    { key: 'refresh', icon: <ReloadOutlined />, label: '刷新目录树' },
  ]

  return (
    <>
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
        /* v1.8.1:节点标题给足高度,右键热区更友好 */
        .script-tree-no-switcher .script-node {
          min-height: 24px;
        }
      `}</style>
      <Dropdown
        trigger={['contextMenu']}
        menu={{
          items: blankItems,
          onClick: ({ key }) => {
            if (key === 'mkdir') acts.onDraft(rootPath, null, 'dir')
            else if (key === 'mkfile') acts.onDraft(rootPath, null, 'file')
            else if (key === 'refresh') acts.onRefreshAll()
          },
        }}
      >
        <div style={{ minHeight: 120 }}>
          <Tree
            className="script-tree-no-switcher"
            treeData={displayData}
            expandedKeys={props.expandedKeys}
            onExpand={props.onExpand}
            loadData={props.onLoadData}
            onSelect={props.onSelect}
            titleRender={renderTitle}
            expandAction="doubleClick"
            showLine={{ showLeafIcon: false }}
            blockNode
            style={{ padding: 6 }}
          />
        </div>
      </Dropdown>
    </>
  )
}

/** 在指定父节点下追加一个子节点(draft 输入框用) */
function insertDraftNode(
  nodes: DataNode[],
  parentKey: string,
  dn: DataNode,
): DataNode[] {
  return nodes.map((n) => {
    if (n.key === parentKey) {
      return { ...n, children: [...(n.children || []), dn] }
    }
    if (n.children && n.children.length > 0) {
      return { ...n, children: insertDraftNode(n.children, parentKey, dn) }
    }
    return n
  })
}

/** 按 key 查找节点(用于判断目录子节点是否已加载) */
function findNode(nodes: DataNode[], key: string): DataNode | null {
  for (const n of nodes) {
    if (n.key === key) return n
    if (n.children && n.children.length > 0) {
      const hit = findNode(n.children, key)
      if (hit) return hit
    }
  }
  return null
}

/** 编辑器面板:view / edit 两态 */
function EditorPanel(props: {
  file: ScriptDirEntry | null
  editor: EditorState
  /** 是否有保存文件内容的权限（script:update）；无权限则只读预览 */
  canEdit: boolean
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
        {!isEdit && props.canEdit && (
          <Button
            size="small"
            type="primary"
            icon={<EditOutlined />}
            onClick={props.onEnterEdit}
          >
            编辑
          </Button>
        )}
        {isEdit && props.canEdit && (
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