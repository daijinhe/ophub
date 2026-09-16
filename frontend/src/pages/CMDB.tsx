import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Card,
  Tree,
  Table,
  Button,
  Space,
  Input,
  Descriptions,
  Modal,
  Form,
  TreeSelect,
  Select,
  Upload,
  App,
  Popconfirm,
  Typography,
  Tag,
  Empty,
  Spin,
  Alert,
  Checkbox,
  Divider,
  Collapse,
  Radio,
  AutoComplete,
  Tooltip,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  CheckOutlined,
  SaveOutlined,
  UploadOutlined,
  DownloadOutlined,
  FileExcelOutlined,
  SearchOutlined,
  NodeIndexOutlined,
  AppstoreOutlined,
  DeleteOutlined,
  SettingOutlined,
  CopyOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  CloseOutlined,
  MonitorOutlined,
  CloudServerOutlined,
  SyncOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  FieldTimeOutlined,
  InteractionOutlined,
  LoadingOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { UploadProps } from 'antd'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api from '../api/client'
import { useAuth } from '../store/AuthContext'
import { openCenteredWindow } from '../utils/window'
import { assetDisplayName } from '../utils/assetName'
import { MwTemplate, MwField, getMwTemplates } from '../api/mw'
import MwTemplateManager from '../components/MwTemplateManager'
import OptionSelect from '../components/OptionSelect'
import AssetCalibrate, { type CalibTarget } from '../components/AssetCalibrate'
import {
  loadCustomOptions,
  saveCustomOptions,
  mergeOptions,
  addCustomOption,
  removeCustomOption,
  type CustomOptionMap,
} from '../api/fieldOptions'
import { getAssetCrontab, setCrontabTaskNote, type AssetCrontabView, type CrontabEntry } from '../api/crontab'
import { mwTypeShort } from '../components/MwCaptureItemCard'
import MiddlewareInfoPanel from '../components/MiddlewareInfoPanel'

interface CatNode {
  id: number
  name: string
  parentId: number | null
  children?: CatNode[]
}
interface Asset {
  id: number
  categoryId: number
  name: string
  ip: string
  fields: Record<string, any>
  /** 后端由 fields 实时派生的统一展示名（项目简称_环境_业务环境_虚拟机IPv4） */
  displayName?: string
  /** 「中间件捕捉」命中的类型（逗号分隔），仅列表响应填充，用于列表「中间件」列 */
  mwTypes?: string
  mwStatus?: string
  mwCapturedAt?: string
  createdAt: string
}
interface FieldDef {
  key: string
  label: string
  group: string
  groups?: string[]
  options?: string[]
  type?: string
  /** 后端下发的隐藏标记：列表/详情/编辑表单/列设置/批量修改中一律不展示 */
  hidden?: boolean
  /** 下拉选项之外允许自定义输入（如下拉底部「输入自定义值」） */
  allowCustom?: boolean
}
interface Schema {
  groups: string[]
  fields: FieldDef[]
  keyColumns: string[]
}
// 中间件实例（fields['中间件信息'] 的元素）
interface MwItem {
  [label: string]: any
  __custom?: Record<string, string>
}

// 模板版本号：更换模板文件时递增，防止浏览器缓存旧文件
// 模板下载缓存戳：模板文件更新后必须递增，否则浏览器/网关会命中旧模板
const TEMPLATE_VER = '20260909b'

const toTreeData = (nodes: CatNode[]): any[] =>
  nodes.map((n) => ({
    key: n.id,
    value: n.id,
    title: n.name,
    children: n.children?.length ? toTreeData(n.children) : undefined,
  }))

// 收集分类树所有节点 id（默认全展开用）
const collectAllCatIds = (nodes: CatNode[]): number[] => {
  const out: number[] = []
  const walk = (ns: CatNode[]) => {
    for (const n of ns) {
      out.push(n.id)
      if (n.children?.length) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

// 查找目标分类的所有祖先 id（用于自动展开路径）
const findCatAncestorIds = (nodes: CatNode[], target: number, path: number[] = []): number[] | null => {
  for (const n of nodes) {
    if (n.id === target) return path
    if (n.children?.length) {
      const r = findCatAncestorIds(n.children, target, [...path, n.id])
      if (r) return r
    }
  }
  return null
}

// 双击任意字段值即可复制
function CopyVal({ value, children }: { value: any; children?: React.ReactNode }) {
  const { message } = App.useApp()
  const text = value === undefined || value === null ? '' : String(value)
  return (
    <span
      className="copy-val"
      title={text || '双击复制该值'}
      style={{ cursor: 'copy', display: 'inline-block' }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        navigator.clipboard
          .writeText(text)
          .then(() => message.success('已复制'))
          .catch(() => message.warning('复制失败'))
      }}
    >
      {children ?? (text || <span className="empty-val">-</span>)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// 资产详情内嵌的「定时任务信息」分组
//
// 数据源与「定时任务管理」页完全一致：在目标机上执行 `crontab -l` 读维护用户
// （默认 root）的 crontab，平台不存任务副本，因此这里看到的与机器上真实在跑的
// 永远一致。本面板固定三列：执行时间 / 定时任务 / 定时任务用途 ——
// 前两列取自目标机，第三列是平台侧的人工备注（可就地填写保存，不写回机器）；
// 任务的增删改仍统一在「定时任务管理」页完成，避免出现两个写入口。
// ---------------------------------------------------------------------------
const CRONTAB_GROUP = '定时任务信息'

// 既有的 CMDB 分组「中间件和数据库信息」（第 4 组）—— 中间件捕捉信息并入这里，
// 与 CMDB 原有的「中间件」字段（第 7 类，手工维护）同处一组。
const MWDB_GROUP = '中间件和数据库信息'

function CrontabDetailPanel({
  assetId,
  view,
  loading,
  error,
  canEdit,
  onRefresh,
  onManage,
  readOnlyTip,
}: {
  assetId: number
  view: AssetCrontabView | null
  loading: boolean
  error: string
  canEdit: boolean
  onRefresh: () => void
  onManage: () => void
  /** 只读时的说明文案（详情未点「编辑」时与「无权限」是两回事） */
  readOnlyTip?: string
}) {
  const { message } = App.useApp()
  const tasks = view?.tasks || []
  // 「用途」本地草稿：边打字不发请求，回车 / 失焦才提交；
  // savedRef 记录服务端已存值，用于判断「是否真的改了」与失败回滚。
  const [purposes, setPurposes] = useState<Record<string, string>>({})
  const savedRef = useRef<Record<string, string>>({})
  const [savingKey, setSavingKey] = useState('')

  useEffect(() => {
    const m: Record<string, string> = {}
    for (const t of view?.tasks || []) {
      if (t.noteKey) m[t.noteKey] = t.purpose || ''
    }
    savedRef.current = m
    setPurposes(m)
  }, [view])

  /** 提交单条用途；内容没变化时只做本地归一化，不打扰后端 */
  const commitPurpose = async (taskKey: string, raw: string) => {
    const next = (raw || '').trim()
    const prev = savedRef.current[taskKey] ?? ''
    if (next === prev) {
      setPurposes((m) => (m[taskKey] === next ? m : { ...m, [taskKey]: next }))
      return
    }
    setSavingKey(taskKey)
    try {
      const r = await setCrontabTaskNote(assetId, { taskKey, purpose: next })
      savedRef.current = { ...savedRef.current, [taskKey]: r.purpose }
      setPurposes((m) => ({ ...m, [taskKey]: r.purpose }))
      message.success(r.purpose ? '用途已保存' : '用途已清除')
    } catch (e: any) {
      setPurposes((m) => ({ ...m, [taskKey]: prev }))
      message.error(e?.response?.data?.msg || '用途保存失败')
    } finally {
      setSavingKey('')
    }
  }

  /** 用途单元格：有管理权限时即点即改；否则只读展示 */
  const purposeCell = (x: CrontabEntry) => {
    const key = x.noteKey
    if (!canEdit || !key) {
      const v = key ? purposes[key] : ''
      return v ? <span>{v}</span> : <span style={{ color: 'var(--text-secondary)' }}>—</span>
    }
    return (
      <Input
        size="small"
        value={purposes[key] ?? ''}
        placeholder="点击填写用途，回车或失焦保存"
        maxLength={200}
        allowClear
        suffix={savingKey === key ? <LoadingOutlined /> : undefined}
        onChange={(e) => setPurposes((m) => ({ ...m, [key]: e.target.value }))}
        onBlur={(e) => void commitPurpose(key, e.target.value)}
        onPressEnter={() => void commitPurpose(key, purposes[key] ?? '')}
      />
    )
  }

  return (
    <div className="cmdb-ct">
      {/* 概览 + 快捷入口 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 10,
        }}
      >
        <Space size={18} wrap style={{ fontSize: 12.5 }}>
          {view ? (
            <>
              <span>
                <span style={{ color: 'var(--text-secondary)' }}>目标机：</span>
                <b>{view.host || view.ip}</b>
              </span>
              <span>
                <span style={{ color: 'var(--text-secondary)' }}>归属用户：</span>
                <b>{view.user}</b>
                {view.runMode === 'sudo' && (
                  <Tag color="blue" style={{ marginLeft: 6, marginInlineEnd: 0 }}>
                    sudo 提权
                  </Tag>
                )}
              </span>
              <span>
                <span style={{ color: 'var(--text-secondary)' }}>任务：</span>
                <b>{view.taskCount}</b>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {' '}
                  条（启用 {view.enabledCount} · 禁用 {view.disabledCount}）
                </span>
              </span>
              {(view.others?.length || 0) > 0 && (
                <span>
                  <span style={{ color: 'var(--text-secondary)' }}>其它内容 </span>
                  <b>{view.others.length}</b>
                  <span style={{ color: 'var(--text-secondary)' }}> 行（注释 / 环境变量）</span>
                </span>
              )}
              {view.readAt && (
                <span style={{ color: 'var(--text-secondary)' }}>
                  读取于 {view.readAt}
                  {view.cached ? '（平台缓存）' : ''}
                </span>
              )}
            </>
          ) : (
            <span style={{ color: 'var(--text-secondary)' }}>正在读取…</span>
          )}
          {/* 数据源恒定写明。旧口径（/etc/crontab、/etc/cron.d/*、cron.{hourly,...}）已整体删除，
              这里不写清楚，用户会以为平台读的还是系统文件 */}
          <span style={{ color: 'var(--text-secondary)' }}>
            数据源：目标机 crontab -l（读 {view?.user || 'root'} 的 crontab，与「定时任务管理」同源，平台不存任务副本）
          </span>
        </Space>
        <Space size={8}>
          {/* 「刷新」是纯读取，只读模式下也保留，便于就地看目标机最新任务 */}
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
            刷新
          </Button>
          {/* 进入定时任务管理页属于管理动作，必须先点标题栏「编辑」进入编辑模式 */}
          {canEdit && (
            <Button size="small" type="primary" ghost icon={<FieldTimeOutlined />} onClick={onManage}>
              定时任务管理
            </Button>
          )}
        </Space>
      </div>

      {/* 读取中：连目标机要几秒，必须有等待反馈 ——
          否则这一组会先显示「当前没有定时任务」，把「还没读到」误报成「确实没有」 */}
      {loading && !view && (
        <div className="ct-loading">
          <Spin size="small" />
          <span>正在读取目标机的定时任务…</span>
        </div>
      )}

      {error && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message="无法读取该机器的定时任务"
          description={
            <Space direction="vertical" size={4}>
              <span style={{ fontSize: 12.5 }}>{error}</span>
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                可点击右上角「定时任务管理」到列表页重试，或先在「用户密码管理」中补全超级管理员密码。
              </span>
            </Space>
          }
        />
      )}

      {tasks.length > 0 && (
        <Table
          rowKey={(r) => r.lineNo}
          size="small"
          pagination={false}
          dataSource={tasks}
          columns={[
            {
              title: '执行时间',
              width: 230,
              render: (_, x) => (
                <div className="ct-plan">
                  <div className="ct-plan__desc" style={{ marginBottom: 3 }}>
                    {!x.enabled && (
                      <Tag color="orange" style={{ marginInlineEnd: 6 }}>
                        已禁用
                      </Tag>
                    )}
                    {x.describe || '自定义计划'}
                  </div>
                  <code className="ct-code">{x.expr}</code>
                </div>
              ),
            },
            {
              title: '定时任务',
              render: (_, x) => <span className="ct-code ct-code--cmd">{x.command}</span>,
            },
            {
              title: '定时任务用途',
              width: 320,
              render: (_, x) => purposeCell(x),
            },
          ]}
        />
      )}

      {/* crontab 一条任务都没有时的空态：这一组恒定展示，空着也要说清楚，
          并给一个直接去添加的入口，避免被误认为「平台没做这个功能」 */}
      {!error && !loading && tasks.length === 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ margin: '6px 0 2px' }}
          description={
            <span style={{ fontSize: 12.5 }}>
              {view?.noCrontab
                ? `用户 ${view.user} 当前没有定时任务（这台机器上还没有这份 crontab）`
                : `用户 ${view?.user || 'root'} 的 crontab 中当前没有定时任务`}
            </span>
          }
        >
          {canEdit && (
            <Button size="small" type="primary" ghost icon={<FieldTimeOutlined />} onClick={onManage}>
              去定时任务管理添加
            </Button>
          )}
        </Empty>
      )}

      {!canEdit && (
        <div style={{ marginTop: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {readOnlyTip || '当前账号无编辑权限，仅展示。'}
          </span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 中间件捕捉信息（不再独立成组，已并入「中间件和数据库信息」分组，见 MiddlewareInfoPanel）
// ---------------------------------------------------------------------------

export default function CMDB() {
  const { hasPerm } = useAuth()
  const { message, modal } = App.useApp()

  // 资产展示名统一走 utils/assetName.ts 的 assetDisplayName
  // （项目简称_环境_业务环境_虚拟机IPv4），与 Web 终端会话名、定时任务列表同源；
  // 这里不再单独拼一套，否则改了资产字段只有部分页面跟着变。

  const navigate = useNavigate()
  const [sp] = useSearchParams()
  const [cats, setCats] = useState<CatNode[]>([])
  const [selectedCat, setSelectedCat] = useState<number | undefined>(undefined)
  // 树展开受控：默认全展开，选中分类时自动展开到该节点
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [kw, setKw] = useState('')
  const [loading, setLoading] = useState(false)

  const [detail, setDetail] = useState<Asset | null>(null)
  const [detailMax, setDetailMax] = useState(false)
  // 双击打开的详情默认「只读展示」：中间件捕捉与定时任务的管理动作（执行捕捉 / 就地编辑 /
  // 新增删除 / 用途维护）必须先点标题栏「编辑」进入编辑模式，避免只是翻阅详情时误改数据。
  // 编辑模式同时开放「全部资产字段」的就地编辑（含自定义键值），保存时整体 PUT。
  const [detailEditing, setDetailEditing] = useState(false)
  // 中间件面板未保存的本地编辑（退出编辑模式前据此提醒，避免静默丢弃）
  const [mwDirty, setMwDirty] = useState(false)
  // 详情字段草稿：只有用户真正改过的字段才进这里（惰性），保存时覆盖原值后整体 PUT。
  // 好处是不必把 80+ 个字段全量回写，未改动的字段保持服务端原值。
  const [detailDraft, setDetailDraft] = useState<Record<string, string>>({})
  // 资产级自定义字段草稿：null = 未改动（按服务端原值渲染）
  const [detailCustomDraft, setDetailCustomDraft] = useState<
    { k: string; v: string; group: string }[] | null
  >(null)
  const [detailSaving, setDetailSaving] = useState(false)
  // ---- 详情内嵌的「定时任务信息」：直读目标机 crontab（与定时任务管理页同一数据源）----
  const canViewCrontab = hasPerm('crontab:view')
  // 「用途」是平台侧备注，写入走 crontab:manage；只读用户看到的是纯文本
  const canManageCrontab = hasPerm('crontab:manage')
  const [ctView, setCtView] = useState<AssetCrontabView | null>(null)
  const [ctLoading, setCtLoading] = useState(false)
  const [ctErr, setCtErr] = useState('')
  // 目标机连接地址（与后端 crontabSSHInfo 取字段口径一致：虚拟机IPv4 → 虚拟机EIP-IPv4）
  const ctHost = useMemo(() => {
    const f = detail?.fields || {}
    return String(f['虚拟机IPv4'] ?? '').trim() || String(f['虚拟机EIP-IPv4'] ?? '').trim()
  }, [detail])
  // 关闭详情：编辑模式与「未保存」标记要一起复位，否则下次打开会带着上一次的编辑态。
  // 编辑模式下还有未保存的修改时，点遮罩 / ESC / 关闭都要先确认，避免静默丢弃。
  const closeDetail = () => {
    if (detailEditing && detailDirty) {
      modal.confirm({
        title: '还有未保存的修改，确认关闭？',
        icon: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
        width: 480,
        okText: '关闭并丢弃',
        cancelText: '继续编辑',
        content: '「资产字段」「中间件和数据库信息」里有未保存的修改，关闭详情后将丢失。',
        onOk: () => {
          setDetail(null)
          setDetailMax(false)
          setDetailEditing(false)
          setMwDirty(false)
          resetDetailDraft()
        },
      })
      return
    }
    setDetail(null)
    setDetailMax(false)
    setDetailEditing(false)
    setMwDirty(false)
    resetDetailDraft()
  }

  // 标题栏「编辑 / 完成」总开关：编辑模式下可改「全部资产字段」（就地编辑 + 保存），
  // 同时解锁中间件捕捉面板与定时任务面板的管理动作；默认关闭 = 纯展示。
  // 退出时若还有未保存的修改，先确认再退出。
  const toggleDetailEditing = () => {
    if (!detailEditing) {
      setDetailEditing(true)
      return
    }
    if (!detailDirty) {
      setDetailEditing(false)
      resetDetailDraft()
      return
    }
    modal.confirm({
      title: '退出编辑模式？',
      icon: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
      width: 480,
      okText: '退出并丢弃',
      cancelText: '继续编辑',
      content: '「资产字段」或「中间件和数据库信息」里有未保存的修改，退出编辑模式后将丢失。',
      onOk: () => {
        setDetailEditing(false)
        setMwDirty(false)
        resetDetailDraft()
      },
    })
  }

  // 资源校准：SSH 直连目标机采集硬件规格并与导入信息比对
  const [calibTarget, setCalibTarget] = useState<CalibTarget | null>(null)
  // 直接在新窗口打开 Web SSH 终端（自动登录并切换 root）
  const openWebTermWindow = (a: Asset) => {
    const w = openCenteredWindow(
      `/webterm/${a.id}`,
      '_blank',
      1280,
      860,
      'menubar=no,toolbar=no,location=no,status=no',
    )
    if (!w) message.warning('浏览器拦截了新窗口，请允许本站弹出窗口后重试')
  }

  /**
   * 读取某台资产的定时任务（详情内嵌面板用）。
   * @param refresh true = 强制重连目标机取最新；否则后端会复用 15 秒内的读取结果
   */
  const loadDetailCrontab = useCallback(async (id: number, refresh = false) => {
    setCtLoading(true)
    setCtErr('')
    try {
      setCtView(await getAssetCrontab(id, { refresh }))
    } catch (e: any) {
      // 未填连接信息 / 端口不合法 / 网络不通 / 提权失败都如实给出原因：
      // 这一组恒定展示，把消息吞掉会让人以为平台没做这个功能
      setCtErr(e?.response?.data?.msg || e?.message || '读取目标机定时任务失败')
      setCtView(null)
    } finally {
      setCtLoading(false)
    }
  }, [])

  /** 跳转到「定时任务管理」页并直接打开该机的任务抽屉（新窗口，保留资产管理页现场） */
  const openCrontabManage = (id: number) => {
    const w = window.open(`/crontab?assetId=${id}`, '_blank')
    if (!w) message.warning('浏览器拦截了新窗口，请允许本站弹出窗口后重试')
  }

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Asset | null>(null)
  const [copySrc, setCopySrc] = useState<Asset | null>(null)
  const [form] = Form.useForm()
  // 资产级自定义键值对（按分组存放）
  const [customFields, setCustomFields] = useState<{ k: string; v: string; group: string }[]>([])
  // 中间件实例（第7类）
  const [mwList, setMwList] = useState<MwItem[]>([])
  // 中间件类型模板（后端全局共享，含字段与默认值）
  const [mwTemplates, setMwTemplates] = useState<MwTemplate[]>([])
  const [mwManageOpen, setMwManageOpen] = useState(false)

  const [catModal, setCatModal] = useState(false)
  const [catEditing, setCatEditing] = useState<CatNode | null>(null)
  const [catForm] = Form.useForm()

  const [importOpen, setImportOpen] = useState(false)
  const [importCat, setImportCat] = useState<number | undefined>()
  const [importFile, setImportFile] = useState<any>(null)

  const [schema, setSchema] = useState<Schema>({ groups: [], fields: [], keyColumns: [] })
  const [selectedRowKeys, setSelectedRowKeys] = useState<number[]>([])

  // ---- 与「定时任务扫描」联动 ----
  // 把资源列表当前的筛选范围（分类 / 关键字）或勾选的资产，原样带到扫描页作为扫描范围，
  // 保证「列表里看到的这批机器」和「扫描的那批机器」是同一批。
  const goScanCrontab = (useSelected = false) => {
    const p = new URLSearchParams()
    if (useSelected && selectedRowKeys.length) {
      p.set('assetIds', selectedRowKeys.join(','))
    } else {
      if (selectedCat) p.set('categoryId', String(selectedCat))
      if (kw.trim()) p.set('keyword', kw.trim())
    }
    navigate(`/crontab/scan${p.toString() ? '?' + p.toString() : ''}`)
  }

  // 字段下拉的「自定义值」：内置选项来自后端 schema，自定义值存 localStorage 并合并展示
  const [customOpts, setCustomOpts] = useState<CustomOptionMap>(() => loadCustomOptions())
  useEffect(() => {
    saveCustomOptions(customOpts)
  }, [customOpts])
  /** 取某字段合并后的全部可选值（内置 + 自定义） */
  const optionsOf = (key: string) =>
    mergeOptions(schema.fields.find((f) => f.key === key)?.options, customOpts[key])
  const addOption = (key: string, v: string) => setCustomOpts((m) => addCustomOption(m, key, v))
  const removeOption = (key: string, v: string) => setCustomOpts((m) => removeCustomOption(m, key, v))

  // 列表排序：sortField 为字段 key，sortOrder 为 asc/desc；
  // 默认按「环境」升序，让开发/测试/生产/商密环境自然分组。
  // 用户在 antd Table 点列头排序时会被覆盖；点三次「环境」可恢复默认。
  const [sortField, setSortField] = useState('环境')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')

  // 左侧分类树宽度：可拖拽调节，持久化到 localStorage（最小 200，最大不超过 640 且为右侧列表保留空间）
  const MIN_SIDE = 200
  const ABS_MAX_SIDE = 640
  const RESERVE_RIGHT = 520 // 为右侧资产列表预留的最小宽度
  const wrapRef = useRef<HTMLDivElement>(null)
  const maxSide = () => {
    // 优先用页面内容区实际宽度计算上限，避免右栏被挤压；兜底用窗口宽度
    const base = wrapRef.current?.clientWidth || (typeof window === 'undefined' ? 1440 : window.innerWidth)
    return Math.max(MIN_SIDE, Math.min(ABS_MAX_SIDE, base - RESERVE_RIGHT))
  }
  const [sideWidth, setSideWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('cmdb:sideWidth'))
    if (saved && saved >= MIN_SIDE && saved <= ABS_MAX_SIDE) return saved
    return 280
  })
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  // 拖拽调节左侧分类树宽度
  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const max = maxSide()
      const next = Math.min(max, Math.max(MIN_SIDE, d.startW + (e.clientX - d.startX)))
      setSideWidth(next)
    }
    const onUp = () => {
      setResizing(false)
      dragRef.current = null
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [resizing])

  // 宽度变化时持久化
  useEffect(() => {
    localStorage.setItem('cmdb:sideWidth', String(sideWidth))
  }, [sideWidth])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: sideWidth }
    setResizing(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  // 批量添加到 Ansible 主机清单
  const [ansibleOpen, setAnsibleOpen] = useState(false)
  const [ansibleNodes, setAnsibleNodes] = useState<{ id: string; name: string }[]>([])
  const [ansibleNodeId, setAnsibleNodeId] = useState('')
  const [ansibleGroups, setAnsibleGroups] = useState<string[]>([])
  const [ansibleGroupsLoading, setAnsibleGroupsLoading] = useState(false)
  const [ansibleTarget, setAnsibleTarget] = useState({
    group: '',
    credMode: 'asset' as 'asset' | 'manual',
    port: '',
    sshUser: '',
    sshPass: '',
    becomePass: '',
    commentTpl: '',
  })
  const [ansibleSubmitting, setAnsibleSubmitting] = useState(false)
  const [ansibleResult, setAnsibleResult] = useState<{ added: number; skipped: number; group: string } | null>(null)

  // 批量编辑
  const [batchEditOpen, setBatchEditOpen] = useState(false)
  const [batchRows, setBatchRows] = useState<{ key: string; value: string; clear: boolean }[]>([])

  const [visibleCols, setVisibleCols] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('cmdb:visibleCols')
      return saved ? (JSON.parse(saved) as string[]) : []
    } catch {
      return []
    }
  })
  const [colModal, setColModal] = useState(false)
  const [colDraft, setColDraft] = useState<string[]>([])
  const activeCols = visibleCols.length ? visibleCols : schema.keyColumns
  const openColSetting = () => {
    setColDraft(activeCols)
    setColModal(true)
  }
  const saveColSetting = () => {
    setVisibleCols(colDraft.length ? colDraft : schema.keyColumns)
    localStorage.setItem('cmdb:visibleCols', JSON.stringify(colDraft))
    setColModal(false)
  }
  const resetColSetting = () => {
    setVisibleCols([])
    localStorage.removeItem('cmdb:visibleCols')
    setColDraft(schema.keyColumns)
  }

  const treeData = useMemo(() => toTreeData(cats), [cats])
  const labelOf = (key: string) => schema.fields.find((f) => f.key === key)?.label || key
  const schemaKeys = useMemo(() => new Set(schema.fields.map((f) => f.key)), [schema.fields])

  // ---- 详情编辑：资产级自定义字段（服务端原值 / 编辑草稿两态） ----
  // 服务端原值：优先取落库的 __custom，缺失时把「不在 schema 里的键」视为历史自定义字段
  const detailCustomList = useMemo(() => {
    const f = (detail?.fields || {}) as Record<string, any>
    const stored = (f.__custom as { k: string; v: string; group: string }[] | undefined) || []
    const base = stored.length
      ? stored
      : Object.keys(f)
          .filter((k) => !schemaKeys.has(k) && k !== '__custom' && k !== '中间件信息')
          .map((k) => ({ k, v: String(f[k] ?? ''), group: schema.groups[0] || '' }))
    // 兼容旧分组名：不在新分组里的归入第一组
    return base.map((c) => ({
      ...c,
      group: schema.groups.includes(c.group) ? c.group : schema.groups[0] || '',
    }))
  }, [detail, schemaKeys, schema.groups])
  // 编辑中优先渲染草稿（一旦改动就整份接管，避免「改一半」的两态混用）
  const detailCustomRows = detailCustomDraft ?? detailCustomList

  // 字段草稿是否真的偏离了服务端原值（改回原值不算未保存，避免无谓的退出确认）
  const detailFieldsDirty = useMemo(() => {
    if (!detail) return false
    const changed = Object.entries(detailDraft).some(
      ([k, v]) => String(v ?? '') !== String((detail.fields as Record<string, any>)?.[k] ?? ''),
    )
    const customChanged =
      detailCustomDraft !== null && JSON.stringify(detailCustomDraft) !== JSON.stringify(detailCustomList)
    return changed || customChanged
  }, [detail, detailDraft, detailCustomDraft, detailCustomList])
  // 详情里任何未保存的修改（中间件面板 + 资产字段）
  const detailDirty = mwDirty || detailFieldsDirty
  // 复位详情编辑态（关闭详情 / 退出编辑模式时统一走这里，避免草稿带到下一次打开）
  const resetDetailDraft = () => {
    setDetailDraft({})
    setDetailCustomDraft(null)
  }

  /**
   * 保存详情里就地修改的资产字段（含资产级自定义字段）。
   *
   * 只把「改动过的字段」覆盖到原 fields 上再整体 PUT，未改动的字段保持服务端原值，
   * 避免把 80+ 个字段全量回写（也避免并发编辑时互相覆盖未展示字段）。
   */
  const saveDetailFields = async () => {
    if (!detail) return
    setDetailSaving(true)
    try {
      const fields: Record<string, any> = { ...((detail.fields || {}) as Record<string, any>) }
      Object.entries(detailDraft).forEach(([k, v]) => {
        fields[k] = v
      })
      const rows = detailCustomRows.filter((c) => (c.k || '').trim())
      rows.forEach((c) => {
        fields[c.k.trim()] = c.v ?? ''
      })
      // 被删除（或改名）的旧自定义字段要从 fields 里摘掉，否则会以「幽灵字段」留在资产上
      detailCustomList
        .map((c) => c.k)
        .filter(Boolean)
        .forEach((k) => {
          if (!rows.some((r) => r.k.trim() === k)) delete fields[k]
        })
      fields.__custom = rows
      await api.put(`/assets/${detail.id}`, { categoryId: detail.categoryId, fields })
      message.success('已保存')
      resetDetailDraft()
      // 重新拉一次单资产与列表，保证详情里显示的就是落库后的值
      const r = await api.get(`/assets/${detail.id}`)
      setDetail(r.data.data)
      loadAssets()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '保存失败')
    } finally {
      setDetailSaving(false)
    }
  }

  const loadSchema = async () => {
    const r = await api.get('/fields')
    setSchema(r.data.data)
  }
  // 分类树按名称 A-Z 递归排序（中文按拼音），新建分类后自动落到正确位置
  const sortCatNodes = (ns: CatNode[]): CatNode[] =>
    [...ns]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      .map((n) => ({
        ...n,
        children: n.children && n.children.length ? sortCatNodes(n.children) : undefined,
      }))

  const loadCats = async () => {
    const r = await api.get('/categories')
    setCats(sortCatNodes(r.data.data || []))
  }
  const loadAssets = async (p = page, keyword = kw, cat = selectedCat, sf = sortField, so = sortOrder) => {
    setLoading(true)
    try {
      const r = await api.get('/assets', {
        params: {
          page: p,
          size: 12,
          keyword,
          categoryId: cat,
          ...(sf ? { sortField: sf, sortOrder: so } : {}),
        },
      })
      setAssets(r.data.data.list)
      setTotal(r.data.data.total)
      setPage(p)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadSchema()
    loadCats()
    getMwTemplates()
      .then(setMwTemplates)
      .catch(() => {/* 接口异常不影响主流程 */})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    loadAssets(1, kw, selectedCat)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCat])

  // 从「定时任务扫描」跳转过来时：?keyword=xx 直接按其搜索；?assetId=xx 直接打开资产详情
  useEffect(() => {
    const bootAssetId = sp.get('assetId')
    const bootKw = sp.get('keyword')
    if (bootKw) {
      setKw(bootKw)
      loadAssets(1, bootKw, undefined)
    }
    if (bootAssetId) {
      api
        .get(`/assets/${bootAssetId}`)
        .then((r) => setDetail(r.data.data))
        .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 打开资产详情时自动读取该机定时任务（无权限 / 无连接信息则不发请求）。
  // 后端有 15 秒去重缓存，连续开关同一台资产不会反复连目标机。
  useEffect(() => {
    setCtView(null)
    setCtErr('')
    if (!detail || !canViewCrontab) {
      setCtLoading(false)
      return
    }
    // 没填连接地址时不必连目标机，直接把原因交给面板显示
    // （这一组恒定展示，静默不显示会让人以为平台没做这个功能）
    if (!ctHost) {
      setCtErr('该资产未填写「虚拟机IPv4 / 虚拟机EIP-IPv4」，无法连接目标机读取定时任务')
      setCtLoading(false)
      return
    }
    void loadDetailCrontab(detail.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, ctHost, canViewCrontab])

  // 分类树加载完成后默认全展开（保留用户后续的折叠状态）
  useEffect(() => {
    if (cats.length && expandedKeys.length === 0) {
      setExpandedKeys(collectAllCatIds(cats))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cats])

  // 选中分类时自动展开到该节点（包括所有祖先），让高亮可见
  useEffect(() => {
    if (selectedCat == null || !cats.length) return
    const ancestors = findCatAncestorIds(cats, selectedCat) || []
    setExpandedKeys((prev) => {
      const set = new Set(prev as number[])
      ancestors.forEach((id) => set.add(id))
      set.add(selectedCat)
      return Array.from(set)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCat, cats])

  // ---- 分类管理 ----
  const openCatCreate = (parent?: CatNode) => {
    setCatEditing(null)
    catForm.resetFields()
    catForm.setFieldsValue({ parentId: parent?.id })
    setCatModal(true)
  }
  const openCatEdit = (id: number, name: string) => {
    setCatEditing({ id, name, parentId: null })
    catForm.setFieldsValue({ name, parentId: null, sort: 0 })
    setCatModal(true)
  }
  const submitCat = async () => {
    const v = await catForm.validateFields()
    try {
      if (catEditing) await api.put(`/categories/${catEditing.id}`, v)
      else await api.post('/categories', v)
      message.success('已保存')
      setCatModal(false)
      loadCats()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '操作失败')
    }
  }
  const removeCat = async (id: number) => {
    try {
      await api.delete(`/categories/${id}`)
      message.success('已删除')
      loadCats()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '删除失败')
    }
  }

  // ---- 资产表单 ----
  const openAssetCreate = () => {
    setEditing(null)
    setCopySrc(null)
    form.resetFields()
    setCustomFields([])
    setMwList([])
    form.setFieldsValue({ categoryId: selectedCat })
    setFormOpen(true)
  }
  const openAssetEdit = (a: Asset) => {
    setCopySrc(null)
    setEditing(a)
    form.resetFields()
    // 资产级自定义字段
    const stored = (a.fields?.__custom as { k: string; v: string; group: string }[] | undefined) || []
    let cf: { k: string; v: string; group: string }[]
    if (stored.length) {
      cf = stored
    } else {
      const extra = Object.keys(a.fields || {}).filter((k) => !schemaKeys.has(k) && k !== '__custom' && k !== '中间件信息')
      cf = extra.map((k) => ({ k, v: String(a.fields?.[k] ?? ''), group: schema.groups[0] || '' }))
    }
    // 兼容旧分组名：不在新分组里的归入第一组
    cf = cf.map((c) => ({ ...c, group: schema.groups.includes(c.group) ? c.group : schema.groups[0] || '' }))
    setCustomFields(cf)
    // 中间件实例
    const mws = (a.fields?.['中间件信息'] as MwItem[] | undefined) || []
    setMwList(mws)
    form.setFieldsValue({ categoryId: a.categoryId, ...a.fields })
    setFormOpen(true)
  }
  // 复制某条资产：基于该服务器快速新建同项目资产。
  // 保留所属分类、中间件配置、网络/操作系统信息与隐藏字段（用户名/密码等），
  // 仅清空唯一标识字段（虚拟机名称、IPv4、IPv6），避免与源资产冲突。
  const COPY_CLEARED = ['虚拟机名称', '虚拟机IPv4', '虚拟机IPv6']
  const copyAsset = (a: Asset) => {
    setEditing(null)
    setCopySrc(a)
    form.resetFields()
    const fields = { ...(a.fields || {}) }
    COPY_CLEARED.forEach((k) => delete fields[k])
    // 资产级自定义字段（与 openAssetEdit 一致的兜底逻辑）
    const stored = (a.fields?.__custom as { k: string; v: string; group: string }[] | undefined) || []
    let cf: { k: string; v: string; group: string }[]
    if (stored.length) {
      cf = stored
    } else {
      const extra = Object.keys(a.fields || {}).filter(
        (k) => !schemaKeys.has(k) && k !== '__custom' && k !== '中间件信息',
      )
      cf = extra.map((k) => ({ k, v: String(a.fields?.[k] ?? ''), group: schema.groups[0] || '' }))
    }
    cf = cf.map((c) => ({ ...c, group: schema.groups.includes(c.group) ? c.group : schema.groups[0] || '' }))
    // 被清空的标识字段如果在自定义字段里也一并置空
    cf = cf.map((c) => (COPY_CLEARED.includes(c.k) ? { ...c, v: '' } : c))
    setCustomFields(cf)
    // 中间件实例原样带入（同项目服务器通常中间件配置一致）
    const mws = (a.fields?.['中间件信息'] as MwItem[] | undefined) || []
    setMwList(mws)
    form.setFieldsValue({ categoryId: a.categoryId, ...fields })
    setFormOpen(true)
  }
  const addCustom = (group: string) => setCustomFields([...customFields, { k: '', v: '', group }])
  const updateCustom = (idx: number, field: 'k' | 'v', val: string) =>
    setCustomFields(customFields.map((c, i) => (i === idx ? { ...c, [field]: val } : c)))
  const removeCustom = (idx: number) => setCustomFields(customFields.filter((_, i) => i !== idx))

  // 中间件实例操作
  // 根据类型取字段模板（按 label 显示）
  const mwFieldsOf = (type: string): MwField[] => {
    const tpl = mwTemplates.find((t) => t.type === type)
    return tpl ? tpl.fields : []
  }
  // 套用默认值：切换类型时按新模板重新填充默认值，保留实例名称和自定义字段
  const ensureMwDefaults = (mw: MwItem): MwItem => {
    const type = mw['类型'] || 'nginx'
    const next: MwItem = { 类型: type, __custom: mw.__custom || {} }
    const keptName = (mw['实例名称'] || '').trim()
    if (keptName) next['实例名称'] = keptName
    mwFieldsOf(type).forEach((f) => {
      const k = f.label
      if (k === '实例名称' && keptName) return
      next[k] = f.default || ''
    })
    return next
  }
  const defaultMwType = () =>
    mwTemplates.find((t) => t.type === 'nginx')?.type || mwTemplates[0]?.type || 'nginx'
  const addMw = () => setMwList([...mwList, ensureMwDefaults({ 类型: defaultMwType() })])
  const changeMwType = (idx: number, type: string) =>
    setMwList(mwList.map((m, i) => (i === idx ? ensureMwDefaults({ ...m, 类型: type }) : m)))
  const updateMw = (idx: number, label: string, val: any) =>
    setMwList(mwList.map((m, i) => (i === idx ? { ...m, [label]: val } : m)))
  const removeMw = (idx: number) => setMwList(mwList.filter((_, i) => i !== idx))
  const addMwCustom = (idx: number) => {
    const m = mwList[idx]
    const custom = { ...(m.__custom || {}) }
    custom['__new__'] = ''
    setMwList(mwList.map((x, i) => (i === idx ? { ...x, __custom: custom } : x)))
  }
  const updateMwCustomKey = (idx: number, oldK: string, newK: string) => {
    const m = mwList[idx]
    const custom = { ...(m.__custom || {}) }
    if (oldK !== newK && oldK in custom) {
      custom[newK] = custom[oldK]
      delete custom[oldK]
    }
    setMwList(mwList.map((x, i) => (i === idx ? { ...x, __custom: custom } : x)))
  }
  const updateMwCustomVal = (idx: number, k: string, v: string) => {
    const m = mwList[idx]
    setMwList(mwList.map((x, i) => (i === idx ? { ...x, __custom: { ...(m.__custom || {}), [k]: v } } : x)))
  }
  const removeMwCustom = (idx: number, k: string) => {
    const m = mwList[idx]
    const custom = { ...(m.__custom || {}) }
    delete custom[k]
    setMwList(mwList.map((x, i) => (i === idx ? { ...x, __custom: custom } : x)))
  }

  const submitAsset = async () => {
    const v = await form.validateFields()
    const srcFields = (editing || copySrc)?.fields as Record<string, any> | undefined
    const fields: Record<string, any> = {}
    schema.fields.forEach((f) => {
      // hidden 字段（如 用户名/密码）不在表单中，保留源资产存储值，避免保存时被清空。
      // 编辑时取被编辑资产；「复制新建」时取源资产，从而继承同项目服务器的登录凭据。
      if (f.hidden) {
        fields[f.key] = srcFields?.[f.key] ?? ''
      } else {
        fields[f.key] = v[f.key] ?? ''
      }
    })
    customFields.forEach((c) => {
      const k = (c.k || '').trim()
      if (k) fields[k] = c.v ?? ''
    })
    fields.__custom = customFields
    // 中间件：清理空自定义字段
    fields['中间件信息'] = mwList.map((m) => {
      const custom: Record<string, string> = {}
      Object.entries(m.__custom || {}).forEach(([k, val]) => {
        if (k && k !== '__new__' && String(val) !== '') custom[k] = String(val)
      })
      const clean: MwItem = {}
      Object.entries(m).forEach(([k, val]) => {
        if (k !== '__custom' && val !== undefined && val !== null && String(val) !== '') clean[k] = val
      })
      return { ...clean, __custom: custom }
    })
    const payload = { categoryId: v.categoryId, fields }
    const savedId = editing?.id
    try {
      if (editing) await api.put(`/assets/${editing.id}`, payload)
      else await api.post('/assets', payload)
      message.success('已保存')
      setFormOpen(false)
      setEditing(null)
      setCopySrc(null)
      loadAssets()
      // 详情可能正开着同一条资产（从详情里点「完整表单维护」进来）→ 同步刷新，避免显示旧值
      if (detail && savedId && detail.id === savedId) {
        try {
          const r = await api.get(`/assets/${savedId}`)
          setDetail(r.data.data)
        } catch {
          /* 忽略：详情刷新失败不影响列表 */
        }
      }
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '操作失败')
    }
  }
  const removeAsset = async (a: Asset) => {
    try {
      await api.delete(`/assets/${a.id}`)
      message.success('已删除')
      loadAssets()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '删除失败')
    }
  }
  const batchRemove = async () => {
    if (!selectedRowKeys.length) return
    try {
      await api.delete('/assets/batch', { data: { ids: selectedRowKeys } })
      message.success(`已删除 ${selectedRowKeys.length} 条`)
      setSelectedRowKeys([])
      loadAssets()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '批量删除失败')
    }
  }

  // ---- 批量编辑 ----
  const openBatchEdit = () => {
    setBatchRows([{ key: '', value: '', clear: false }])
    setBatchEditOpen(true)
  }
  const updateBatchRow = (i: number, patch: Partial<{ key: string; value: string; clear: boolean }>) =>
    setBatchRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const removeBatchRow = (i: number) => setBatchRows((rows) => rows.filter((_, idx) => idx !== i))
  const addBatchRow = () => setBatchRows((rows) => [...rows, { key: '', value: '', clear: false }])
  // 返回字段定义，并带上「内置 + 自定义」合并后的选项（供下拉渲染使用）
  const fieldMeta = (key: string) => {
    const f = schema.fields.find((x) => x.key === key)
    if (!f) return f
    return { ...f, options: mergeOptions(f.options, customOpts[key]) }
  }
  // 某行可选的字段（排除隐藏字段与其它行已选的）
  const availBatchFields = (i: number) =>
    schema.fields.filter((f) => !f.hidden && !batchRows.some((r, idx) => idx !== i && r.key === f.key))
  const submitBatchEdit = () => {
    const valid = batchRows.filter((r) => r.key && (r.clear || (r.value ?? '') !== ''))
    if (!valid.length) return message.warning('请至少设置一个要修改的字段与值')
    const fields: Record<string, any> = {}
    valid.forEach((r) => {
      fields[r.key] = r.clear ? null : r.value
    })
    Modal.confirm({
      title: `确认批量修改 ${selectedRowKeys.length} 条资产？`,
      width: 560,
      icon: <EditOutlined style={{ color: '#1677ff' }} />,
      okText: '确认修改',
      cancelText: '再想想',
      content: (
        <div style={{ maxHeight: 320, overflowY: 'auto', paddingTop: 4 }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 13 }}>
            以下字段将覆盖到选中的 {selectedRowKeys.length} 条资产（其余字段保持不变）：
          </Typography.Paragraph>
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            {valid.map((r) => {
              const meta = fieldMeta(r.key)
              return (
                <div
                  key={r.key}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '6px 10px',
                    background: 'var(--bg-2, #f5f7fa)',
                    borderRadius: 6,
                    fontSize: 13,
                  }}
                >
                  <span style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{meta?.label || r.key}</span>
                  <span style={{ color: r.clear ? '#ff4d4f' : 'var(--text)' }}>
                    {r.clear ? '置为空（清空）' : String(r.value)}
                  </span>
                </div>
              )
            })}
          </Space>
        </div>
      ),
      onOk: async () => {
        try {
          const r = await api.put('/assets/batch', { ids: selectedRowKeys, fields })
          message.success(`已修改 ${r.data.data?.updated ?? selectedRowKeys.length} 条资产`)
          setBatchEditOpen(false)
          setSelectedRowKeys([])
          loadAssets()
        } catch (e: any) {
          message.error(e?.response?.data?.msg || '批量修改失败')
        }
      },
    })
  }

  // ---- 批量添加到 Ansible 主机清单 ----
  // 本地节点的 API 不带 remotes 前缀（与主机清单页保持一致）
  const epAnsible = (nodeId: string, sub: string) =>
    nodeId === 'local' ? (sub === '/hosts' ? '/ansible' : `/ansible${sub}`) : `/ansible/remotes/${nodeId}${sub}`

  const loadAnsibleNodes = async () => {
    try {
      const r = await api.get('/ansible/remotes')
      const list: { id: number; name: string }[] = r.data.data.list || []
      const nodes = [
        { id: 'local', name: '本地节点（平台内置）' },
        ...list.map((n) => ({ id: String(n.id), name: n.name })),
      ]
      setAnsibleNodes(nodes)
      setAnsibleNodeId((cur) => (cur && nodes.some((n) => n.id === cur) ? cur : nodes[0]?.id || ''))
    } catch {
      setAnsibleNodes([{ id: 'local', name: '本地节点（平台内置）' }])
      setAnsibleNodeId((cur) => cur || 'local')
    }
  }
  const loadAnsibleGroups = async (nodeId: string) => {
    if (!nodeId) return
    setAnsibleGroupsLoading(true)
    try {
      const r = await api.get(epAnsible(nodeId, '/hosts'))
      const groups: { name: string }[] = r.data.data?.file?.groups || []
      setAnsibleGroups(groups.map((g) => g.name).filter(Boolean))
    } catch {
      setAnsibleGroups([])
    } finally {
      setAnsibleGroupsLoading(false)
    }
  }
  const openAnsibleImport = () => {
    setAnsibleResult(null)
    setAnsibleTarget((t) => ({ ...t, group: '' }))
    setAnsibleOpen(true)
    loadAnsibleNodes()
  }
  // 切换节点后拉取该节点已有的分组，便于直接选择
  useEffect(() => {
    if (ansibleOpen && ansibleNodeId) loadAnsibleGroups(ansibleNodeId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ansibleOpen, ansibleNodeId])

  const submitAnsibleImport = async () => {
    const group = ansibleTarget.group.trim()
    if (!group) return message.warning('请填写目标分组名')
    if (!ansibleNodeId) return message.warning('请选择 Ansible 节点')
    const manual = ansibleTarget.credMode === 'manual'
    setAnsibleSubmitting(true)
    try {
      const r = await api.post(epAnsible(ansibleNodeId, '/import-cmdb'), {
        group,
        assetIds: selectedRowKeys,
        useAssetCreds: !manual,
        port: manual ? ansibleTarget.port : '',
        sshUser: manual ? ansibleTarget.sshUser : '',
        sshPass: manual ? ansibleTarget.sshPass : '',
        becomePass: manual ? ansibleTarget.becomePass : '',
        commentTpl: ansibleTarget.commentTpl,
      })
      setAnsibleResult({
        added: r.data.data.added ?? 0,
        skipped: r.data.data.skipped ?? 0,
        group: r.data.data.group,
      })
      message.success(`已添加 ${r.data.data.added} 台到 [${r.data.data.group}]`)
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '添加失败')
    } finally {
      setAnsibleSubmitting(false)
    }
  }

  // ---- 导入 ----
  const doImport = async () => {
    if (!importCat) return message.warning('请选择导入分类')
    if (!importFile) return message.warning('请选择 Excel 文件')
    const fd = new FormData()
    fd.append('categoryId', String(importCat))
    fd.append('file', importFile)
    try {
      const r = await api.post('/assets/import', fd)
      message.success(`成功导入 ${r.data.data.imported} 条`)
      setImportOpen(false)
      setImportFile(null)
      // 导入成功后自动定位到导入分类：左侧分类树高亮 + 右侧列表直接展示该分类资产，
      // 避免用户必须手动点击对应分类才能看到刚导入的数据。
      setSelectedCat(importCat)
      loadAssets(1, kw, importCat)
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '导入失败')
    }
  }

  // ---- 导出 ----
  const doExport = async () => {
    try {
      const r = await api.get('/assets/export', {
        params: {
          categoryId: selectedCat,
          keyword: kw,
          ...(sortField ? { sortField, sortOrder } : {}),
        },
        responseType: 'blob',
      })
      const url = window.URL.createObjectURL(new Blob([r.data]))
      const a = document.createElement('a')
      a.href = url
      a.download = `cmdb_export_${Date.now()}.xlsx`
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (e: any) {
      message.error('导出失败')
    }
  }

  const uploadProps: UploadProps = {
    beforeUpload: (file) => {
      setImportFile(file)
      return false
    },
    maxCount: 1,
    onRemove: () => setImportFile(null),
  }

  // 表格列：自定义展示列（默认取 keyColumns）
  const columns: ColumnsType<Asset> = [
    ...activeCols.filter((k) => schemaKeys.has(k) && !schema.fields.find((f) => f.key === k)?.hidden).map((key) => ({
      title: labelOf(key),
      dataIndex: ['fields', key],
      key,
      ellipsis: true,
      // 交由后端排序（JSONB 字段，数值按数值大小排）
      sorter: true,
      sortOrder: sortField === key ? (sortOrder === 'asc' ? ('ascend' as const) : ('descend' as const)) : null,
      render: (val: any) => val || '-',
    })),
    {
      // 中间件：值来自「中间件捕捉」的落库快照（后端列表响应填充，不是 CMDB 登记字段）。
      // 搜索框里输入 nginx / redis 也能把资产搜出来（后端 keyword 已并上 mw_captures）。
      title: '中间件',
      key: 'mwTypes',
      width: 150,
      render: (_, a) => {
        const types = (a.mwTypes || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
        const tip =
          a.mwStatus === 'failed'
            ? '上次捕捉失败（可在「中间件捕捉」页重试）'
            : a.mwCapturedAt
              ? `捕捉于 ${a.mwCapturedAt}`
              : ''
        if (!types.length) {
          const none = a.mwStatus === 'none'
          return (
            <Tooltip title={none ? '已捕捉：这台机器上未发现目标中间件' : '尚未捕捉（可在「中间件捕捉」页勾选本机捕捉）'}>
              <span style={{ color: 'var(--text-secondary)' }}>{none ? '无' : '—'}</span>
            </Tooltip>
          )
        }
        return (
          <Tooltip title={tip || undefined}>
            <Space size={4} wrap>
              {types.map((t) => (
                <Tag key={t} color="geekblue" style={{ marginInlineEnd: 0 }}>
                  {mwTypeShort(t)}
                </Tag>
              ))}
            </Space>
          </Tooltip>
        )
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 96,
      fixed: 'right',
      render: (_, a) => (
        /* 「编辑」与「资源校准」已收敛到双击打开的详情里（避免同一功能两处入口互相打架），
           列表只保留「复制」这一条与详情无关的动作。 */
        <Space size={0}>
          {hasPerm('cmdb:create') && (
            <Button size="small" type="link" icon={<CopyOutlined />} onClick={() => copyAsset(a)}>
              复制
            </Button>
          )}
        </Space>
      ),
    },
  ]

  const titleRender = (node: any) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        gap: 4,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={node.title}
      >
        {node.title}
      </span>
      {hasPerm('category:manage') && (
        <span
          onClick={(e) => {
            e.stopPropagation()
          }}
          style={{ opacity: 0.6, flex: 'none' }}
        >
          <EditOutlined
            style={{ fontSize: 12 }}
            onClick={(e) => {
              e.stopPropagation()
              openCatEdit(Number(node.key), node.title as string)
            }}
          />
          <DeleteOutlined
            style={{ fontSize: 12, marginLeft: 6 }}
            onClick={(e) => {
              e.stopPropagation()
              removeCat(Number(node.key))
            }}
          />
        </span>
      )}
    </div>
  )

  // 字段是否属于某展示分组（hidden 字段不在任何展示/编辑/列设置中显示）
  const inGroup = (f: FieldDef, g: string) =>
    !f.hidden && (f.groups?.length ? f.groups.includes(g) : f.group === g)

  // ---- 中间件渲染（详情） ----
  const renderMiddlewareDetail = (mws?: MwItem[]) => {
    if (!mws || !mws.length) return <span className="empty-val">无</span>
    return (
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        {mws.map((mw, i) => {
          const type = mw['类型'] || mw.type || '中间件'
          const name = mw['实例名称'] || mw['名称'] || mw.name || ''
          const custom = mw.__custom || {}
          const fields = mwFieldsOf(type)
          return (
            <Card
              key={i}
              size="small"
              className="cmdb-mw-card"
              title={
                <span className="cmdb-mw-title">
                  <Tag color="#475569" style={{ marginRight: 6 }}>{type}</Tag>
                  {name && <span className="cmdb-mw-name">{name}</span>}
                </span>
              }
            >
              <Descriptions bordered column={3} size="small" className="cmdb-desc">
                {fields.map((mf) => {
                  if (mf.dependsOn && String(mw[mf.dependsOn.field]) !== mf.dependsOn.value) return null
                  const val = mw[mf.label] ?? (mf.key ? mw[mf.key] : undefined)
                  if (val === undefined || val === null || String(val) === '') return null
                  return (
                    <Descriptions.Item key={mf.label} label={mf.label}>
                      <CopyVal value={val}>{String(val)}</CopyVal>
                    </Descriptions.Item>
                  )
                })}
                {Object.entries(custom).map(([k, v]) => (
                  <Descriptions.Item key={'c' + k} label={k}>
                    <CopyVal value={v}>{String(v)}</CopyVal>
                  </Descriptions.Item>
                ))}
              </Descriptions>
            </Card>
          )
        })}
      </Space>
    )
  }

  return (
    <div ref={wrapRef} style={{ display: 'flex', alignItems: 'stretch' }}>
      {/* 左侧分类树（宽度可拖拽调节） */}
      <Card
        className="glass"
        style={{ width: sideWidth, flex: `0 0 ${sideWidth}px`, border: 'none', minWidth: 0 }}
        title={
          <Space>
            <AppstoreOutlined />
            资产分类
          </Space>
        }
        extra={
          hasPerm('category:manage') && (
            <Button size="small" icon={<PlusOutlined />} onClick={() => openCatCreate()} />
          )
        }
      >
        <Tree
          treeData={treeData}
          selectedKeys={selectedCat ? [selectedCat] : []}
          expandedKeys={expandedKeys}
          onExpand={(keys) => setExpandedKeys(keys as React.Key[])}
          onSelect={(keys) => setSelectedCat(keys.length ? Number(keys[0]) : undefined)}
          titleRender={titleRender}
          blockNode
        />
      </Card>

      {/* 拖拽手柄：左右拖动调节分类树宽度，双击恢复默认 280 */}
      <div
        className={'cmdb-resizer' + (resizing ? ' is-active' : '')}
        onMouseDown={startResize}
        onDoubleClick={() => setSideWidth(280)}
        title="拖拽调节宽度，双击恢复默认"
        role="separator"
        aria-orientation="vertical"
      />

      {/* 右侧资产列表 */}
      <Card
        className="glass"
        style={{ flex: 1, border: 'none', minWidth: 0, marginLeft: 4 }}
        title={
          <Space>
            <NodeIndexOutlined />
            <span>资产列表</span>
            <Tag color="blue">{total}</Tag>
          </Space>
        }
        extra={
          <Space wrap>
            <Input
              allowClear
              placeholder="搜索任意字段"
              prefix={<SearchOutlined />}
              style={{ width: 200 }}
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              onPressEnter={() => loadAssets(1, kw, selectedCat)}
            />
            <Button onClick={() => loadAssets(1, kw, selectedCat)}>查询</Button>
            {hasPerm('cmdb:create') && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openAssetCreate}>
                新建资产
              </Button>
            )}
            {hasPerm('cmdb:import') && (
              <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
                导入
              </Button>
            )}
            <Button
              icon={<FileExcelOutlined />}
              href={`/cmdb_template.xlsx?v=${TEMPLATE_VER}`}
              download="平台录入模板.xlsx"
            >
              下载模板
            </Button>
            {hasPerm('cmdb:export') && (
              <Button icon={<DownloadOutlined />} onClick={doExport}>
                导出
              </Button>
            )}
            <Button icon={<SettingOutlined />} onClick={openColSetting}>
              列设置
            </Button>
            {hasPerm('crontab:view') && (
              <Tooltip title="按当前筛选范围扫描这批机器的 crontab（只读，不会修改目标机）">
                <Button icon={<RadarChartOutlined />} onClick={() => goScanCrontab(false)}>
                  扫描定时任务
                </Button>
              </Tooltip>
            )}
          </Space>
        }
      >
        <Spin spinning={loading}>
          {selectedRowKeys.length > 0 && (
            <div
              className="cmdb-batchbar"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
                padding: '10px 14px',
                marginBottom: 12,
                borderRadius: 8,
                border: '1px solid var(--border, #e3e8ef)',
                background: 'var(--bg-2, #f5f8ff)',
              }}
            >
              <Space size={8}>
                <Tag
                  color="blue"
                  style={{ margin: 0, fontSize: 13, padding: '2px 10px', borderRadius: 12 }}
                >
                  已选 {selectedRowKeys.length} 项
                </Tag>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  可对这些资产批量编辑或删除
                </Typography.Text>
              </Space>
              <Space size={8} wrap>
                {hasPerm('cmdb:update') && (
                  <Button type="primary" icon={<EditOutlined />} onClick={openBatchEdit}>
                    批量编辑
                  </Button>
                )}
                {hasPerm('cmdb:delete') && (
                  <Popconfirm
                    title={`确认删除选中的 ${selectedRowKeys.length} 条资产？`}
                    onConfirm={batchRemove}
                  >
                    <Button danger icon={<DeleteOutlined />}>
                      批量删除
                    </Button>
                  </Popconfirm>
                )}
                {hasPerm('cmdb:create') && selectedRowKeys.length === 1 && (
                  <Button
                    icon={<CopyOutlined />}
                    onClick={() => {
                      const one = assets.find((x) => x.id === selectedRowKeys[0])
                      if (one) copyAsset(one)
                    }}
                  >
                    复制选中
                  </Button>
                )}
                {hasPerm('ansible:manage') && (
                  <Button icon={<CloudServerOutlined />} onClick={openAnsibleImport}>
                    添加到主机清单
                  </Button>
                )}
                {hasPerm('crontab:view') && (
                  <Tooltip title="扫描所选资产的定时任务（只读，不会修改目标机）">
                    <Button icon={<RadarChartOutlined />} onClick={() => goScanCrontab(true)}>
                      扫描定时任务
                    </Button>
                  </Tooltip>
                )}
                <Button icon={<CloseOutlined />} onClick={() => setSelectedRowKeys([])}>
                  取消选择
                </Button>
              </Space>
            </div>
          )}
          <Table
            rowKey="id"
            columns={columns}
            dataSource={assets}
            rowSelection={{
              selectedRowKeys,
              onChange: (keys) => setSelectedRowKeys(keys as number[]),
            }}
            pagination={{
              current: page,
              total,
              pageSize: 12,
              onChange: (p) => loadAssets(p, kw, selectedCat, sortField, sortOrder),
            }}
            scroll={{ x: 'max-content' }}
            onChange={(_pagination, _filters, sorter) => {
              const s = Array.isArray(sorter) ? sorter[0] : sorter
              const field = (s?.columnKey as string) || ''
              const order: 'asc' | 'desc' | '' =
                s?.order === 'ascend' ? 'asc' : s?.order === 'descend' ? 'desc' : ''
              setSortField(order ? field : '')
              if (order) setSortOrder(order)
              loadAssets(1, kw, selectedCat, order ? field : '', order || 'asc')
            }}
            onRow={(record) => ({
              // 双击行 = 只读查看详情，必须从「非编辑态」开始，避免沿用上一次的编辑模式与字段草稿
              onDoubleClick: () => {
                setDetail(record)
                setDetailEditing(false)
                setMwDirty(false)
                resetDetailDraft()
              },
              className: 'asset-row',
            })}
            locale={{ emptyText: <Empty description="双击行可查看全部字段" /> }}
          />
        </Spin>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            提示：点击列头可排序（数值列按数值大小排）；双击任意一行打开资产详情（按 8 类分组展示，点标题栏「编辑」可就地修改全部字段，并可执行资源校准 / 中间件捕捉）；双击任意字段值即可复制；点「复制」可基于该服务器快速新建同项目资产（自动带入中间件与登录凭据，仅清空名称/IP）；勾选多条后「添加到主机清单」可一键写入 Ansible。
          </Typography.Text>
      </Card>

      {/* 详情弹窗（双击行打开，按 8 类分组展示） */}
      <Modal
        title={
          detail ? (
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span className="cmdb-modal-title">
                <NodeIndexOutlined style={{ color: 'var(--text-secondary)', marginRight: 6 }} />
                资产详情
                <span style={{ fontWeight: 650, marginLeft: 6, color: 'var(--text)' }}>
                  {assetDisplayName(detail)}
                </span>
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {/* 编辑总开关：资产全部字段 + 中间件捕捉 + 定时任务管理都挂在它下面，
                    双击行打开的详情默认只读展示。三种权限任一即可进入（各自的可操作范围在面板内再判）。 */}
                {(hasPerm('cmdb:update') || hasPerm('mwcapture:manage') || hasPerm('crontab:manage')) && (
                  <Button
                    type={detailEditing ? 'primary' : 'text'}
                    size="small"
                    icon={detailEditing ? <CheckOutlined /> : <EditOutlined />}
                    onClick={toggleDetailEditing}
                    title={
                      detailEditing
                        ? '退出编辑模式（未保存的修改会丢失）'
                        : '进入编辑模式：可修改资产全部字段，并执行中间件捕捉 / 就地编辑、定时任务的用途维护与新增删除'
                    }
                    style={detailEditing ? { marginInlineEnd: 4 } : { color: '#1677ff' }}
                  >
                    {detailEditing ? '完成' : '编辑'}
                  </Button>
                )}
                {hasPerm('cmdb:update') && (
                  <Button
                    type="text"
                    size="small"
                    icon={<SyncOutlined />}
                    onClick={() =>
                      detail &&
                      setCalibTarget({
                        id: detail.id,
                        name: assetDisplayName(detail),
                        ip: detail.ip || String(detail.fields?.['虚拟机IPv4'] || ''),
                      })
                    }
                    title="SSH 读取该服务器的操作系统 / CPU / 内存 / 磁盘，与导入信息对比后同步"
                    style={{ color: '#22c55e' }}
                  >
                    资源校准
                  </Button>
                )}
                <Button
                  type="text"
                  size="small"
                  icon={<MonitorOutlined />}
                  onClick={() => detail && openWebTermWindow(detail)}
                  title="在新窗口打开 SSH 终端（自动登录并切换 root）"
                  style={{ color: '#38bdf8' }}
                >
                  Web 终端
                </Button>
                <Button
                  type="text"
                  size="small"
                  icon={detailMax ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                  onClick={() => setDetailMax((v) => !v)}
                  title={detailMax ? '还原窗口' : '放大窗口'}
                />
                <Button
                  type="text"
                  size="small"
                  icon={<CloseOutlined />}
                  onClick={closeDetail}
                  title="关闭"
                />
              </span>
            </span>
          ) : ''
        }
        open={!!detail}
        onCancel={closeDetail}
        footer={null}
        width={detailMax ? 'calc(100vw - 24px)' : 1320}
        /* className 供端到端脚本精确定位（详情与「编辑资产」弹窗可能同屏叠加） */
        className="asset-detail-modal"
        style={detailMax ? { top: 12, maxWidth: '100vw' } : undefined}
        centered={!detailMax}
        closable={false}
        destroyOnClose
      >
        {detail && (() => {
          // 资产级自定义字段：编辑中优先渲染草稿（组件级 detailCustomRows），否则按服务端原值。
          // 分组归位 / 兼容旧分组名的逻辑已收敛到 detailCustomList 这一个地方。
          const customList = detailCustomRows
          // 分组展示顺序：在第 4 组「中间件和数据库信息」之后插入虚拟分组「定时任务信息」，
          // 其余分组依次顺延。中间件捕捉信息已并入「中间件和数据库信息」组（见下方）。
          const groupNames = [...schema.groups]
          groupNames.splice(Math.min(4, groupNames.length), 0, CRONTAB_GROUP)

          // 这一组恒定展示（用户要求：没有任务也要能看到，便于就地判断 + 直接去添加）：
          // 有任务 = 表格；没任务 = 空态提示；读失败 = 原因 + 重试；无权限 = 整组不出现。
          const ctReady = ctView && ctView.assetId === detail.id ? ctView : null
          const ctTasks = ctReady?.tasks || []
          const ctTotal = ctTasks.length
          // 读取失败（未填连接信息 / 网络不通 / 提权失败）时保留原因，便于就地排查
          const ctError = ctTasks.length === 0 ? ctErr : ''

          const canViewMw = hasPerm('mwcapture:view')
          const canManageMw = hasPerm('mwcapture:manage')
          // 资产字段就地编辑依赖 cmdb:update（没有该权限时只读展示，与列表按钮口径一致）
          const canEditAsset = hasPerm('cmdb:update')

          const panels: { key: string; count: string; node: React.ReactNode }[] = []
          for (const g of groupNames) {
            if (g === CRONTAB_GROUP) {
              if (!canViewCrontab) continue
              panels.push({
                key: g,
                count: ctError ? '读取失败' : ctTotal > 0 ? `${ctTotal} 条` : '暂无任务',
                node: (
                  <CrontabDetailPanel
                    /* 编辑模式切换时重挂载，退出编辑后重新按只读口径渲染 */
                    key={detailEditing ? 'ct-edit' : 'ct-readonly'}
                    assetId={detail.id}
                    view={ctView}
                    loading={ctLoading}
                    error={ctError}
                    canEdit={canManageCrontab && detailEditing}
                    readOnlyTip={
                      canManageCrontab
                        ? '只读展示：点标题栏「编辑」后可维护任务用途 / 进入定时任务管理。'
                        : undefined
                    }
                    onRefresh={() => loadDetailCrontab(detail.id, true)}
                    onManage={() => openCrontabManage(detail.id)}
                  />
                ),
              })
              continue
            }
            const fcount = schema.fields.filter((f) => inGroup(f, g)).length
            const ccount = customList.filter((c) => c.group === g && c.k).length
            const descNode = (
              <Descriptions bordered column={g === '用户密码管理' ? 4 : 3} size="small" className="cmdb-desc">
                {schema.fields
                  .filter((f) => inGroup(f, g))
                  .map((f) => {
                    if (f.type === 'middleware') {
                      // 「中间件信息」是一个可增删实例 / 带自定义字段的复合列表，就地编辑需要
                      // 一整套实例编辑器；这里给出通往「完整表单」的入口，避免详情里只读却无处可改。
                      return (
                        <Descriptions.Item label={f.label} key={f.key} span={3}>
                          {renderMiddlewareDetail(detail.fields?.[f.key] as MwItem[] | undefined)}
                          {detailEditing && canEditAsset ? (
                            <div style={{ marginTop: 8 }}>
                              <Button
                                size="small"
                                icon={<EditOutlined />}
                                onClick={() => openAssetEdit(detail)}
                              >
                                完整表单维护（增删中间件实例 / 自定义字段）
                              </Button>
                            </div>
                          ) : null}
                        </Descriptions.Item>
                      )
                    }
                    // 编辑模式：草稿优先（草稿里只有被改过的字段，未改的仍取服务端原值）
                    const val = f.key in detailDraft ? detailDraft[f.key] : detail.fields?.[f.key]
                    return (
                      <Descriptions.Item label={f.label} key={f.key} span={1}>
                        {detailEditing && canEditAsset ? (
                          f.options && f.options.length ? (
                            f.allowCustom ? (
                              /* 下拉 + 自定义输入（与「编辑资产」弹窗同一套选项来源） */
                              <span data-field={f.key} style={{ display: 'block' }}>
                                <OptionSelect
                                  value={val === undefined || val === null ? '' : String(val)}
                                  placeholder={`请选择或输入${f.label}`}
                                  options={optionsOf(f.key)}
                                  removable={customOpts[f.key] || []}
                                  onAddOption={(v) => addOption(f.key, v)}
                                  onRemoveOption={(v) => removeOption(f.key, v)}
                                  onChange={(v) => setDetailDraft((p) => ({ ...p, [f.key]: v }))}
                                  style={{ width: '100%' }}
                                />
                              </span>
                            ) : (
                              <Select
                                allowClear
                                data-field={f.key}
                                value={val === undefined || val === null || val === '' ? undefined : String(val)}
                                placeholder={`请选择${f.label}`}
                                options={f.options.map((o: string) => ({ label: o, value: o }))}
                                onChange={(v) => setDetailDraft((p) => ({ ...p, [f.key]: v ?? '' }))}
                                style={{ width: '100%' }}
                              />
                            )
                          ) : (
                            <Input
                              data-field={f.key}
                              value={val === undefined || val === null ? '' : String(val)}
                              placeholder={f.label}
                              onChange={(e) => setDetailDraft((p) => ({ ...p, [f.key]: e.target.value }))}
                            />
                          )
                        ) : (
                          <CopyVal value={val}>{String(val ?? '')}</CopyVal>
                        )}
                      </Descriptions.Item>
                    )
                  })}
                {/* 资产级自定义字段：编辑模式下可就地改值 / 删除（ci 是原数组下标，改值不会串行） */}
                {customList
                  .map((c, ci) => ({ c, ci }))
                  .filter(({ c }) => c.group === g && c.k)
                  .map(({ c, ci }) => (
                    <Descriptions.Item label={c.k} key={'c_' + ci + '_' + c.k} span={1}>
                      {detailEditing && canEditAsset ? (
                        <Space.Compact style={{ width: '100%' }}>
                          <Input
                            value={c.v}
                            placeholder={c.k}
                            onChange={(e) =>
                              setDetailCustomDraft(
                                customList.map((x, xi) => (xi === ci ? { ...x, v: e.target.value } : x)),
                              )
                            }
                          />
                          <Button
                            danger
                            icon={<DeleteOutlined />}
                            title="删除该自定义字段"
                            onClick={() => setDetailCustomDraft(customList.filter((_, xi) => xi !== ci))}
                          />
                        </Space.Compact>
                      ) : (
                        <CopyVal value={c.v}>{c.v}</CopyVal>
                      )}
                    </Descriptions.Item>
                  ))}
                {detailEditing && canEditAsset ? (
                  <Descriptions.Item label="自定义字段" key={'c_add_' + g} span={3}>
                    <Button
                      type="dashed"
                      size="small"
                      icon={<PlusOutlined />}
                      onClick={() =>
                        setDetailCustomDraft([
                          ...customList,
                          { k: `新字段${customList.length + 1}`, v: '', group: g },
                        ])
                      }
                    >
                      在「{g}」中添加自定义字段
                    </Button>
                  </Descriptions.Item>
                ) : null}
              </Descriptions>
            )
            // 「中间件和数据库信息」组：在既有 schema 字段（含原「中间件」第 7 类）下方，
            // 追加「中间件捕捉」区块（捕捉 + 就地编辑 + 自定义字段），三者同处一组。
            const node =
              g === MWDB_GROUP && canViewMw ? (
                <div>
                  {descNode}
                  <div style={{ marginTop: 14 }}>
                    <MiddlewareInfoPanel
                      /* 编辑模式切换时整体重挂载：退出编辑要重新拉一次服务端数据，
                         否则会继续显示「改了但没保存」的本地值 */
                      key={detailEditing ? 'mw-edit' : 'mw-readonly'}
                      assetId={detail.id}
                      canManage={canManageMw && detailEditing}
                      onDirtyChange={setMwDirty}
                      readOnlyTip={
                        canManageMw
                          ? '只读展示：点标题栏「编辑」后可执行捕捉 / 就地修改。'
                          : undefined
                      }
                      onChanged={() => void loadAssets()}
                    />
                  </div>
                </div>
              ) : (
                descNode
              )
            panels.push({
              key: g,
              count: `${fcount + ccount} 项`,
              node,
            })
          }

          return (
            <div style={detailMax ? { maxHeight: 'calc(100vh - 150px)', overflow: 'auto' } : { maxHeight: 640, overflow: 'auto' }}>
              <div className="cmdb-detail-tip">
                <CopyOutlined style={{ color: 'var(--text-secondary)' }} />
                <span>双击任意字段值即可复制</span>
              </div>
              {detailEditing ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 10 }}
                  message="编辑模式已开启"
                  description={
                    <span>
                      {canEditAsset
                        ? '所有资产字段（含自定义字段）均可就地修改；「中间件和数据库信息」与「定时任务信息」也可操作（执行捕捉 / 就地编辑 / 用途维护 / 新增删除）。字段改完点右侧「保存字段」落库，中间件与定时任务各自有自己的保存入口。'
                        : '当前账号无资产字段更新权限，字段仍为只读；「中间件和数据库信息」与「定时任务信息」可操作。'}
                    </span>
                  }
                  action={
                    canEditAsset ? (
                      <Button
                        type="primary"
                        size="small"
                        icon={<SaveOutlined />}
                        loading={detailSaving}
                        disabled={!detailFieldsDirty}
                        onClick={saveDetailFields}
                        title="保存资产字段与自定义字段的修改"
                      >
                        保存字段
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                (hasPerm('cmdb:update') || hasPerm('mwcapture:manage') || hasPerm('crontab:manage')) && (
                  <div className="cmdb-detail-tip" style={{ marginBottom: 10 }}>
                    <span>
                      当前为只读展示。需要修改资产字段、执行中间件捕捉或维护定时任务时，点标题栏「编辑」进入编辑模式。
                    </span>
                  </div>
                )
              )}
              <Collapse
                className="cmdb-collapse"
                /* 定时任务组现在恒定存在，不再靠 key 变化触发重挂载；
                   defaultActiveKey 会让它和其它组一样默认展开 */
                key="cmdb-groups"
                defaultActiveKey={groupNames}
                items={panels.map((pn, gi) => ({
                  key: pn.key,
                  label: (
                    <span className="cmdb-group-head">
                      <span className="cmdb-group-badge">{String(gi + 1).padStart(2, '0')}</span>
                      <span className="cmdb-group-name">{pn.key}</span>
                      <span className="cmdb-group-count">{pn.count}</span>
                    </span>
                  ),
                  children: pn.node,
                }))}
              />
            </div>
          )
        })()}
      </Modal>

      {/* 自定义展示列设置 */}
      <Modal
        title="自定义展示列"
        open={colModal}
        onOk={saveColSetting}
        onCancel={() => setColModal(false)}
        okText="保存"
        cancelText="取消"
        width={720}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`已选 ${colDraft.length} 列 · 默认展示 ${schema.keyColumns.length} 列（应用系统名称、虚拟机IPv4 等）`}
        />
        <Space wrap style={{ marginBottom: 12 }}>
          <Button size="small" onClick={() => setColDraft(schema.fields.filter((f) => !f.hidden).map((f) => f.key))}>
            全选
          </Button>
          <Button size="small" onClick={() => setColDraft([])}>
            清空
          </Button>
          <Button size="small" onClick={resetColSetting}>
            恢复默认
          </Button>
        </Space>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {schema.groups.map((g) => (
            <div key={g} style={{ marginBottom: 8 }}>
              <Divider orientation="left" style={{ margin: '8px 0' }}>
                {g}
              </Divider>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                {schema.fields
                  .filter((f) => inGroup(f, g))
                  .map((f) => (
                    <Checkbox
                      key={f.key}
                      checked={colDraft.includes(f.key)}
                      onChange={(e) => {
                        const k = f.key
                        setColDraft((prev) =>
                          e.target.checked ? [...prev, k] : prev.filter((x) => x !== k),
                        )
                      }}
                      style={{ width: 170 }}
                    >
                      {f.label}
                    </Checkbox>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </Modal>

      {/* 资产新建/编辑（详情里点「完整表单维护」会叠在详情弹窗之上，故抬到 1200） */}
      <Modal
        title={editing ? '编辑资产' : '新建资产'}
        open={formOpen}
        onOk={submitAsset}
        onCancel={() => setFormOpen(false)}
        width={860}
        zIndex={1200}
        /* className 供端到端脚本精确定位（详情弹窗可能同时开着） */
        className="asset-edit-modal"
        /* 防误触丢失：仅底部「取消 / 确定」可关闭，点遮罩、按 ESC、点右上角 × 均不响应 */
        maskClosable={false}
        keyboard={false}
        closable={false}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="categoryId" label="所属分类" rules={[{ required: true, message: '请选择分类' }]}>
            <TreeSelect
              treeData={treeData}
              placeholder="选择部门 / 项目分类"
              treeDefaultExpandAll
              allowClear
            />
          </Form.Item>
          <div style={{ maxHeight: 520, overflow: 'auto', paddingRight: 8 }}>
            {schema.groups.map((g, gi) => {
              const gf = schema.fields.filter((f) => inGroup(f, g))
              if (!gf.length) return null
              return (
                <div key={g} style={{ marginBottom: 16 }}>
                  <span className="cmdb-form-group">
                    <span className="cmdb-group-badge" style={{ width: 22, height: 22, fontSize: 11, borderRadius: 7 }}>
                      {String(gi + 1).padStart(2, '0')}
                    </span>
                    <span style={{ fontWeight: 650, fontSize: 14.5, letterSpacing: 0.4, color: 'var(--text-strong)' }}>
                      {g}
                    </span>
                  </span>
                  {gf.some((f) => f.type === 'middleware') ? (
                    <div style={{ marginTop: 8 }}>
                      {/* 中间件动态实例 */}
                      {mwList.map((mw, mi) => {
                        const type = mw['类型'] || ''
                        return (
                          <Card
                            key={mi}
                            size="small"
                            style={{ marginBottom: 12 }}
                            title={
                              <Space>
                                <span>中间件 {mi + 1}</span>
                                <Select
                                  value={type}
                                  onChange={(v) => changeMwType(mi, v)}
                                  style={{ width: 160 }}
                                  options={mwTemplates.map((t) => ({ label: t.type, value: t.type }))}
                                  placeholder="类型"
                                />
                              </Space>
                            }
                            extra={
                              <Popconfirm title="删除该中间件？" onConfirm={() => removeMw(mi)}>
                                <Button size="small" type="link" danger icon={<DeleteOutlined />} />
                              </Popconfirm>
                            }
                          >
                            {(() => {
                              const fields = mwFieldsOf(type)
                              const base = fields.filter((f) => !f.dependsOn)
                              const cond = fields.filter(
                                (f) => f.dependsOn && String(mw[f.dependsOn.field]) === f.dependsOn.value,
                              )
                              const labelNode = (text: string) => (
                                <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>
                                  {text}
                                </span>
                              )
                              const renderField = (mf: MwField) => (
                                <Form.Item
                                  key={mi + '_' + mf.label}
                                  label={labelNode(mf.label)}
                                  style={{ marginBottom: 8 }}
                                >
                                  {mf.options && mf.options.length ? (
                                    <Select
                                      value={mw[mf.label]}
                                      onChange={(v) => updateMw(mi, mf.label, v)}
                                      options={mf.options.map((o) => ({ label: o, value: o }))}
                                      allowClear
                                      placeholder={`请选择${mf.label}`}
                                    />
                                  ) : (
                                    <Input
                                      value={mw[mf.label] ?? ''}
                                      onChange={(e) => updateMw(mi, mf.label, e.target.value)}
                                      placeholder={mf.label}
                                    />
                                  )}
                                </Form.Item>
                              )
                              return (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  {base.length > 0 && (
                                    <>
                                      <div
                                        style={{
                                          fontSize: 12,
                                          color: 'var(--text-secondary)',
                                          fontWeight: 600,
                                          margin: '4px 0 2px',
                                        }}
                                      >
                                        基础配置
                                      </div>
                                      <div
                                        style={{
                                          display: 'grid',
                                          gridTemplateColumns: 'repeat(2, 1fr)',
                                          gap: '0 16px',
                                        }}
                                      >
                                        {base.map(renderField)}
                                      </div>
                                    </>
                                  )}
                                  {cond.length > 0 && (
                                    <>
                                      <Divider style={{ margin: '8px 0 4px' }} plain>
                                        证书信息
                                      </Divider>
                                      <div
                                        style={{
                                          display: 'grid',
                                          gridTemplateColumns: 'repeat(2, 1fr)',
                                          gap: '0 16px',
                                        }}
                                      >
                                        {cond.map(renderField)}
                                      </div>
                                    </>
                                  )}
                                </div>
                              )
                            })()}
                            {/* 中间件自定义字段 */}
                            <Divider style={{ margin: '4px 0 8px' }} plain>
                              自定义字段
                            </Divider>
                            {Object.entries(mw.__custom || {}).map(([k, val]) => (
                              <Space key={k} align="baseline" style={{ display: 'flex', marginBottom: 6 }}>
                                <Input
                                  placeholder="字段名"
                                  style={{ width: 220 }}
                                  value={k === '__new__' ? '' : k}
                                  onChange={(e) => updateMwCustomKey(mi, k, e.target.value)}
                                />
                                <Input
                                  placeholder="字段值"
                                  style={{ width: 260 }}
                                  value={String(val ?? '')}
                                  onChange={(e) => updateMwCustomVal(mi, k, e.target.value)}
                                />
                                {k !== '__new__' && (
                                  <DeleteOutlined
                                    onClick={() => removeMwCustom(mi, k)}
                                    style={{ color: '#ff4d4f' }}
                                  />
                                )}
                              </Space>
                            ))}
                            <Button
                              type="dashed"
                              size="small"
                              icon={<PlusOutlined />}
                              onClick={() => addMwCustom(mi)}
                            >
                              添加自定义字段
                            </Button>
                          </Card>
                        )
                      })}
                      {hasPerm('cmdb:update') && (
                        <Button
                          icon={<SettingOutlined />}
                          onClick={() => setMwManageOpen(true)}
                          style={{ marginTop: 4, marginRight: 8 }}
                        >
                          中间件类型管理
                        </Button>
                      )}
                      <Button type="dashed" icon={<PlusOutlined />} onClick={addMw} style={{ marginTop: 4 }}>
                        添加中间件
                      </Button>
                    </div>
                  ) : (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gap: '0 12px',
                        marginTop: 8,
                      }}
                    >
                      {gf.map((f) =>
                        f.options && f.options.length ? (
                          <Form.Item key={f.key} name={f.key} label={f.label} style={{ marginBottom: 12 }}>
                            {f.allowCustom ? (
                              // 既保留下拉选择，又允许在下拉底部输入自定义值（自定义值持久化在浏览器本地）
                              <OptionSelect
                                placeholder={`请选择或输入${f.label}`}
                                options={optionsOf(f.key)}
                                removable={customOpts[f.key] || []}
                                onAddOption={(v) => addOption(f.key, v)}
                                onRemoveOption={(v) => removeOption(f.key, v)}
                              />
                            ) : (
                              <Select
                                placeholder={`请选择${f.label}`}
                                options={f.options.map((o: string) => ({ label: o, value: o }))}
                                allowClear
                              />
                            )}
                          </Form.Item>
                        ) : (
                          <Form.Item key={f.key} name={f.key} label={f.label} style={{ marginBottom: 12 }}>
                            <Input placeholder={f.label} />
                          </Form.Item>
                        ),
                      )}
                    </div>
                  )}
                  {/* 该分组内的自定义键值对 */}
                  {customFields.map((cf, i) =>
                    cf.group !== g ? null : (
                      <Space key={i} align="baseline" style={{ display: 'flex', marginBottom: 8 }}>
                        <Input
                          placeholder="字段名（如：机房位置）"
                          style={{ width: 240 }}
                          value={cf.k}
                          onChange={(e) => updateCustom(i, 'k', e.target.value)}
                        />
                        <Input
                          placeholder="字段值"
                          style={{ width: 300 }}
                          value={cf.v}
                          onChange={(e) => updateCustom(i, 'v', e.target.value)}
                        />
                        <DeleteOutlined onClick={() => removeCustom(i)} style={{ color: '#ff4d4f' }} />
                      </Space>
                    ),
                  )}
                  <Button
                    type="dashed"
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={() => addCustom(g)}
                    style={{ marginTop: 4 }}
                  >
                    在「{g}」中添加自定义字段
                  </Button>
                </div>
              )
            })}
          </div>
        </Form>
      </Modal>

      {/* 分类新建/编辑 */}
      <Modal
        title={catEditing ? '编辑分类' : '新建分类'}
        open={catModal}
        onOk={submitCat}
        onCancel={() => setCatModal(false)}
        /* 防误触丢失：仅底部「取消 / 确定」可关闭 */
        maskClosable={false}
        keyboard={false}
        closable={false}
        destroyOnClose
      >
        <Form form={catForm} layout="vertical">
          <Form.Item name="name" label="分类名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：技术部 / 政务运营项目" />
          </Form.Item>
          <Form.Item name="parentId" label="上级分类">
            <TreeSelect
              treeData={treeData}
              placeholder="不选择则为顶级分类"
              treeDefaultExpandAll
              allowClear
            />
          </Form.Item>
          <Form.Item name="sort" label="排序">
            <Input type="number" defaultValue={0} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 导入 */}
      <Modal
        title="从平台录入模板导入"
        open={importOpen}
        onOk={doImport}
        onCancel={() => setImportOpen(false)}
        /* 防误触丢失：仅底部「取消 / 确定」可关闭（避免已选文件与分类被误触清空） */
        maskClosable={false}
        keyboard={false}
        closable={false}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          请选择导入到的分类（部门 / 项目），并上传与「平台录入模板」表头一致
          的 Excel 文件。相同「虚拟机 IPv4」将自动更新。
        </Typography.Paragraph>
        <Form layout="vertical">
          <Form.Item label="导入分类" required>
            <TreeSelect
              treeData={treeData}
              value={importCat}
              onChange={setImportCat}
              placeholder="选择部门 / 项目分类"
              treeDefaultExpandAll
              allowClear
            />
          </Form.Item>
          <Form.Item label="Excel 文件">
            <Upload {...uploadProps} fileList={importFile ? [importFile as any] : []}>
              <Button icon={<UploadOutlined />}>选择文件</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>

      {/* 中间件类型管理 */}
      <MwTemplateManager
        open={mwManageOpen}
        onClose={() => setMwManageOpen(false)}
        templates={mwTemplates}
        onSaved={setMwTemplates}
      />

      {/* 批量编辑 */}
      <Modal
        title={`批量编辑（已选 ${selectedRowKeys.length} 项）`}
        open={batchEditOpen}
        onOk={submitBatchEdit}
        onCancel={() => setBatchEditOpen(false)}
        okText="确认修改"
        cancelText="取消"
        width={720}
        /* 防误触丢失：仅底部「取消 / 确认修改」可关闭 */
        maskClosable={false}
        keyboard={false}
        closable={false}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="为选中的资产统一设置字段值；未填写/未勾选的行不生效，其余字段保持不变。"
        />
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          {batchRows.map((r, i) => {
            const meta = fieldMeta(r.key)
            const opts = availBatchFields(i)
            return (
              <Card key={i} size="small" style={{ background: 'var(--bg-2, #fafafa)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <Form.Item label="字段" style={{ marginBottom: 0, minWidth: 220 }}>
                    <Select
                      placeholder="选择要修改的字段"
                      value={r.key || undefined}
                      onChange={(v) => updateBatchRow(i, { key: v, value: '', clear: false })}
                      showSearch
                      optionFilterProp="label"
                      options={opts.map((f) => ({ label: f.label, value: f.key }))}
                      style={{ width: 220 }}
                    />
                  </Form.Item>
                  {r.key && (
                    <Form.Item label="新值" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
                      {meta?.options && meta.options.length ? (
                        <OptionSelect
                          placeholder="请选择或输入自定义值"
                          value={r.clear ? '' : r.value}
                          options={meta.options}
                          onChange={(v) => updateBatchRow(i, { value: v })}
                          disabled={r.clear}
                          removable={customOpts[r.key] || []}
                          onAddOption={(v) => addOption(r.key, v)}
                          onRemoveOption={(v) => removeOption(r.key, v)}
                          style={{ width: '100%' }}
                        />
                      ) : (
                        <Input
                          placeholder={r.clear ? '将清空该字段' : '输入新值'}
                          value={r.value}
                          disabled={r.clear}
                          onChange={(e) => updateBatchRow(i, { value: e.target.value })}
                        />
                      )}
                    </Form.Item>
                  )}
                  <Form.Item label=" " style={{ marginBottom: 0 }}>
                    <Space>
                      <Checkbox
                        checked={r.clear}
                        onChange={(e) => updateBatchRow(i, { clear: e.target.checked })}
                      >
                        置空
                      </Checkbox>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => removeBatchRow(i)}
                      />
                    </Space>
                  </Form.Item>
                </div>
              </Card>
            )
          })}
        </Space>
        <Button
          type="dashed"
          icon={<PlusOutlined />}
          onClick={addBatchRow}
          style={{ marginTop: 12 }}
          block
        >
          添加字段
        </Button>
      </Modal>

      {/* 批量添加到 Ansible 主机清单 */}
      <Modal
        title={`添加到主机清单（已选 ${selectedRowKeys.length} 台）`}
        open={ansibleOpen}
        onOk={submitAnsibleImport}
        onCancel={() => setAnsibleOpen(false)}
        okText="确认添加"
        cancelText="取消"
        confirmLoading={ansibleSubmitting}
        width={620}
        /* 防误触丢失：仅底部「取消 / 确认添加」可关闭 */
        maskClosable={false}
        keyboard={false}
        closable={false}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message="把选中资产的 IPv4 写入所选 Ansible 节点的 hosts 清单"
          description="已存在于该分组的主机、以及未填写 IPv4 的资产会自动跳过。"
        />
        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>目标节点</div>
            <Select
              value={ansibleNodeId || undefined}
              onChange={setAnsibleNodeId}
              options={ansibleNodes.map((n) => ({ label: n.name, value: n.id }))}
              placeholder="选择 Ansible 节点"
              style={{ width: '100%' }}
            />
          </div>

          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>目标分组</div>
            <AutoComplete
              value={ansibleTarget.group || undefined}
              onChange={(v) => setAnsibleTarget({ ...ansibleTarget, group: v })}
              options={ansibleGroups.map((g) => ({ label: g, value: g }))}
              placeholder="选择已有分组，或直接输入新分组名"
              style={{ width: '100%' }}
              allowClear
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              该节点已有分组：{ansibleGroups.length ? ansibleGroups.join('、') : '（无，将新建分组）'}
            </Typography.Text>
          </div>

          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>SSH 凭据</div>
            <Radio.Group
              value={ansibleTarget.credMode}
              onChange={(e) => setAnsibleTarget({ ...ansibleTarget, credMode: e.target.value })}
              style={{ marginBottom: 8 }}
            >
              <Radio value="asset">使用资产自带凭据</Radio>
              <Radio value="manual">统一指定</Radio>
            </Radio.Group>
            {ansibleTarget.credMode === 'asset' ? (
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                按每台资产读取 CMDB 字段：SSH端口 / 用户名 / 密码 / 超级管理员用户密码；字段为空的项不写入。
              </Typography.Text>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Input
                  placeholder="SSH 端口"
                  value={ansibleTarget.port}
                  onChange={(e) => setAnsibleTarget({ ...ansibleTarget, port: e.target.value })}
                />
                <Input
                  placeholder="SSH 用户"
                  value={ansibleTarget.sshUser}
                  onChange={(e) => setAnsibleTarget({ ...ansibleTarget, sshUser: e.target.value })}
                />
                <Input.Password
                  placeholder="SSH 密码"
                  value={ansibleTarget.sshPass}
                  onChange={(e) => setAnsibleTarget({ ...ansibleTarget, sshPass: e.target.value })}
                />
                <Input.Password
                  placeholder="sudo 密码"
                  value={ansibleTarget.becomePass}
                  onChange={(e) => setAnsibleTarget({ ...ansibleTarget, becomePass: e.target.value })}
                />
              </div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>备注模板（可选）</div>
            <Input
              placeholder="如：{应用系统名称} {归属部门}"
              value={ansibleTarget.commentTpl}
              onChange={(e) => setAnsibleTarget({ ...ansibleTarget, commentTpl: e.target.value })}
            />
          </div>
        </div>

        {ansibleResult && (
          <Alert
            type={ansibleResult.added > 0 ? 'success' : 'warning'}
            showIcon
            style={{ marginTop: 14 }}
            message={`分组 [${ansibleResult.group}]：新增 ${ansibleResult.added} 台，跳过 ${ansibleResult.skipped} 台`}
            description="跳过原因：主机已存在于该分组，或该资产未填写 IPv4。"
          />
        )}
      </Modal>

      {/* 资源校准弹窗（列表操作列 / 详情标题栏均可打开） */}
      <AssetCalibrate
        target={calibTarget}
        open={!!calibTarget}
        onClose={() => setCalibTarget(null)}
        onSynced={async () => {
          await loadAssets()
          // 详情弹窗若开着，同步刷新，避免仍显示旧值
          if (detail) {
            try {
              const r = await api.get(`/assets/${detail.id}`)
              setDetail(r.data.data)
            } catch {
              /* 忽略：详情刷新失败不影响列表 */
            }
          }
        }}
      />
    </div>
  )
}