import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Divider,
  Dropdown,
  Empty,
  Input,
  Modal,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
  type MenuProps,
} from 'antd'
import {
  AlertOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  FileExcelOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import dayjs, { type Dayjs } from 'dayjs'
import {
  createN9eExportTemplate,
  deleteN9eExportTemplate,
  exportN9eAlerts,
  getN9eConfig,
  getN9eStats,
  getN9eSyncStatus,
  listN9eDatasources,
  listN9eDepartments,
  listN9eEvents,
  listN9eExportColumns,
  listN9eExportTemplates,
  listN9eGroups,
  saveN9eConfig,
  startN9eSync,
  testN9eConfig,
  updateN9eExportTemplate,
  type N9eAlertEvent,
  type N9eConfig,
  type N9eExportCol,
  type N9eExportFilter,
  type N9eExportTemplate,
  type N9eExportTemplateInput,
  type N9eQueryParams,
  type N9eStats,
  type N9eSyncState,
  type N9eTimeParams,
} from '../api/prometheus'
import { useAuth } from '../store/AuthContext'

const { Title, Text } = Typography

// ============================================================================
// 监控告警报表 —— 夜莺（Nightingale）历史告警
//
// 数据流：夜莺 API --同步--> 本地库 --查询/统计/导出--> 本页
//
// ⚠️ 为什么页面上的「时间范围」改了不会自动重拉夜莺：
//    页面上的查询/统计/导出全部走**本地已同步的数据**（毫秒级）；
//    只有点「同步数据」才会去连夜莺。实测 90 天全量要 94 秒，
//    如果每次改筛选条件都现拉，页面会不可用。
//    所以页面头部会显著提示「本地数据截止时间」，避免把陈旧数据当实时数据看。
//
// ⚠️ 「数据源」下拉的选项来自**本地库 distinct**（不是实时拉夜莺清单）：只列出本地确实
//    有数据的数据源，避免用户选到一个空结果还以为功能坏了。该字段 v1.7.50 才落库，
//    老数据 datasource_id 为 0、不会出现在选项里，需要重新同步一次才会补齐。
// ============================================================================

const RANGE_OPTIONS = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
  { label: '自定义', value: -1 },
]

const SEVERITY_OPTIONS = [
  { label: '严重', value: 3 },
  { label: '警告', value: 2 },
  { label: '提醒', value: 1 },
]

const RECOVER_OPTIONS = [
  { label: '全部', value: -1 },
  { label: '未恢复', value: 0 },
  { label: '已恢复', value: 1 },
]

// ---------------------------------------------------------------------------
// 导出模板（v1.7.51）
//
// 模板 = 有序的列集合 + 筛选条件 + 时间范围，全局共享。
// ⚠️ 时间范围默认用「近 N 天」而不是绝对区间：模板是要长期复用的，
// 存死区间的话过一个月就永远导出空表。自定义区间才记字面日期。
// ---------------------------------------------------------------------------

/** 模板编辑表单的状态（比后端 filter 多一个 customRange，因为界面用的是 RangePicker） */
type TplFormState = {
  name: string
  remark: string
  timeMode: 'days' | 'custom'
  days: number
  customRange: [Dayjs, Dayjs] | null
  datasourceIds: number[]
  groupIds: number[]
  severity?: number
  recovered: number
  department?: string
  keyword: string
  columns: string[]
}

/** 新建表单的初始值：近 90 天、不限条件、全部列 */
function newTplForm(): TplFormState {
  return {
    name: '',
    remark: '',
    timeMode: 'days',
    days: 90,
    customRange: null,
    datasourceIds: [],
    groupIds: [],
    severity: undefined,
    recovered: -1,
    department: undefined,
    keyword: '',
    columns: [],
  }
}

/** 把模板里存的筛选条件还原成表单状态 */
function tplToForm(t: N9eExportTemplate): TplFormState {
  const f = t.filter
  return {
    name: t.name,
    remark: t.remark || '',
    timeMode: f.timeMode === 'custom' ? 'custom' : 'days',
    days: f.days > 0 ? f.days : 90,
    customRange:
      f.timeMode === 'custom' && f.stime > 0 && f.etime > 0
        ? [dayjs.unix(f.stime), dayjs.unix(f.etime)]
        : null,
    datasourceIds: f.datasourceIds || [],
    groupIds: f.groupIds || [],
    severity: f.severity > 0 ? f.severity : undefined,
    recovered: f.recovered ?? -1,
    department: f.department || undefined,
    keyword: f.keyword || '',
    columns: t.columns || [],
  }
}

/** 把表单状态转成后端要的字段 */
function formToTplInput(f: TplFormState): N9eExportTemplateInput {
  const custom = f.timeMode === 'custom' && f.customRange
  return {
    name: f.name.trim(),
    remark: f.remark.trim(),
    columns: f.columns,
    filter: {
      timeMode: custom ? 'custom' : 'days',
      days: custom ? 90 : f.days,
      stime: custom ? f.customRange![0].startOf('day').unix() : 0,
      etime: custom ? f.customRange![1].endOf('day').unix() : 0,
      datasourceIds: f.datasourceIds,
      groupIds: f.groupIds,
      severity: f.severity || 0,
      recovered: f.recovered,
      department: f.department || '',
      keyword: f.keyword.trim(),
    },
  }
}

/** 模板条件的一行摘要（模板列表里显示，几个模板的差别一眼能看出来） */
function tplFilterSummary(f: N9eExportFilter, dsName: (id: number) => string): string {
  const parts: string[] = []
  if (f.timeMode === 'custom' && f.stime > 0 && f.etime > 0) {
    parts.push(
      `${dayjs.unix(f.stime).format('YYYY-MM-DD')} ~ ${dayjs.unix(f.etime).format('YYYY-MM-DD')}`,
    )
  } else {
    parts.push(`近 ${f.days || 90} 天`)
  }
  if (f.datasourceIds?.length) parts.push(`数据源：${f.datasourceIds.map(dsName).join('、')}`)
  if (f.groupIds?.length) parts.push(`业务组 ${f.groupIds.length} 个`)
  if (f.severity) parts.push(severityText(f.severity))
  if (f.recovered === 0) parts.push('仅未恢复')
  if (f.recovered === 1) parts.push('仅已恢复')
  if (f.department) parts.push(`部门：${f.department}`)
  if (f.keyword) parts.push(`关键字：${f.keyword}`)
  return parts.join(' · ')
}

/** 等级配色：与项目内其他告警视图保持一致（红/橙/蓝） */
function severityColor(v: number): string {
  if (v >= 3) return 'red'
  if (v === 2) return 'orange'
  return 'blue'
}

function severityText(v: number): string {
  if (v >= 3) return '严重'
  if (v === 2) return '警告'
  if (v === 1) return '提醒'
  return `未知(${v})`
}

function fmtTime(ts: number): string {
  if (!ts) return '-'
  return dayjs.unix(ts).format('YYYY-MM-DD HH:mm:ss')
}

/** 秒 → 「1天2小时」 */
function fmtDuration(sec: number): string {
  if (sec < 0) sec = 0
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  return `${m}分${sec % 60}秒`
}

export default function PromAlertReport() {
  const { hasPerm } = useAuth()

  // ---- 筛选条件 ----
  const [days, setDays] = useState<number>(90)
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null)
  const [groupIds, setGroupIds] = useState<number[]>([])
  const [datasourceIds, setDatasourceIds] = useState<number[]>([])
  const [severity, setSeverity] = useState<number | undefined>(undefined)
  const [recovered, setRecovered] = useState<number>(-1)
  const [department, setDepartment] = useState<string | undefined>(undefined)
  const [keyword, setKeyword] = useState('')

  // ---- 数据 ----
  const [stats, setStats] = useState<N9eStats | null>(null)
  const [rows, setRows] = useState<N9eAlertEvent[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  // ---- 同步 ----
  const [syncState, setSyncState] = useState<N9eSyncState | null>(null)
  const [config, setConfig] = useState<N9eConfig | null>(null)
  const [groups, setGroups] = useState<{ groupId: number; groupName: string; n: number }[]>([])
  const [depts, setDepts] = useState<{ value: string; n: number }[]>([])
  const [datasources, setDatasources] = useState<
    { datasourceId: number; datasourceName: string; n: number }[]
  >([])

  // ---- 导出模板 ----
  const [templates, setTemplates] = useState<N9eExportTemplate[]>([])
  const [tplLoading, setTplLoading] = useState(false)
  const [tplMgrOpen, setTplMgrOpen] = useState(false)
  const [tplFormOpen, setTplFormOpen] = useState(false)
  const [tplEditing, setTplEditing] = useState<N9eExportTemplate | null>(null)
  const [tplSaving, setTplSaving] = useState(false)
  const [tplForm, setTplForm] = useState<TplFormState>(newTplForm)
  /** 可选列清单来自后端（列定义的单一事实源），前端不硬编码列名 */
  const [exportCols, setExportCols] = useState<N9eExportCol[]>([])
  const [colPickOpen, setColPickOpen] = useState(false)
  const [pickedCols, setPickedCols] = useState<string[]>([])
  /** 当前列表/统计是否由某个模板带出来的（仅用于页面提示，不影响查询） */
  const [activeTplName, setActiveTplName] = useState('')

  // ---- 连接设置弹窗 ----
  const [settingOpen, setSettingOpen] = useState(false)
  const [formBase, setFormBase] = useState('')
  const [formToken, setFormToken] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  const timerRef = useRef<number | null>(null)

  /** 查询/统计/导出共用同一份条件，避免三处口径漂移 */
  const queryParams = useMemo<N9eQueryParams>(() => {
    const p: N9eQueryParams = {}
    if (days === -1 && customRange) {
      p.stime = customRange[0].startOf('day').unix()
      p.etime = customRange[1].endOf('day').unix()
    } else {
      p.days = days > 0 ? days : 90
    }
    if (groupIds.length > 0) p.groupIds = groupIds.join(',')
    if (datasourceIds.length > 0) p.datasourceIds = datasourceIds.join(',')
    if (severity !== undefined) p.severity = severity
    if (recovered >= 0) p.recovered = recovered
    if (department) p.department = department
    if (keyword.trim()) p.keyword = keyword.trim()
    return p
  }, [days, customRange, groupIds, datasourceIds, severity, recovered, department, keyword])

  // ---------- 加载 ----------
  const loadStats = useCallback(async () => {
    try {
      const s = await getN9eStats(queryParams)
      setStats(s)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '统计加载失败')
    }
  }, [queryParams])

  const loadRows = useCallback(
    async (p = page, ps = pageSize) => {
      setLoading(true)
      try {
        const r = await listN9eEvents({ ...queryParams, page: p, pageSize: ps })
        setRows(r.list || [])
        setTotal(r.total || 0)
      } catch (e) {
        message.error(e instanceof Error ? e.message : '查询失败')
      } finally {
        setLoading(false)
      }
    },
    [queryParams, page, pageSize],
  )

  /** 下拉选项的时间范围：只取时间三字段，其他筛选变化时不必重拉下拉 */
  const timeParams = useMemo<N9eTimeParams>(
    () => ({ days: queryParams.days, stime: queryParams.stime, etime: queryParams.etime }),
    [queryParams.days, queryParams.stime, queryParams.etime],
  )

  /** 与时间范围无关的元数据：连接配置 + 可选导出列 */
  const loadMeta = useCallback(async () => {
    try {
      const [cfg, ecl] = await Promise.all([getN9eConfig(), listN9eExportColumns()])
      setConfig(cfg)
      setExportCols(ecl.list || [])
    } catch {
      // 元数据加载失败不阻塞主流程（例如首次进入还没有任何数据）
    }
  }, [])

  /**
   * 三个下拉的选项与条数。
   * ⚠️ 依赖时间范围：条数是按同一时间窗统计的，否则下拉里写「(95674)」、
   * 点进去总数却是 95669，用户只会认为报表算错了。
   */
  const loadOptions = useCallback(async () => {
    try {
      const [gs, dp, ds] = await Promise.all([
        listN9eGroups(timeParams),
        listN9eDepartments(timeParams),
        listN9eDatasources(timeParams),
      ])
      setGroups(gs.list || [])
      setDepts(dp.departments || [])
      setDatasources(ds.list || [])
    } catch {
      // 下拉加载失败不阻塞主流程
    }
  }, [timeParams])

  const loadTemplates = useCallback(async () => {
    setTplLoading(true)
    try {
      const r = await listN9eExportTemplates()
      setTemplates(r.list || [])
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出模板加载失败')
    } finally {
      setTplLoading(false)
    }
  }, [])

  /** 条件变化 → 统计 + 列表都重算，并回到第 1 页 */
  useEffect(() => {
    setPage(1)
    void loadStats()
    void loadRows(1, pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryParams])

  useEffect(() => {
    void loadMeta()
    void loadTemplates()
  }, [loadMeta, loadTemplates])

  /** 时间范围变了就重算下拉里的条数（保证与统计卡片同口径） */
  useEffect(() => {
    void loadOptions()
  }, [loadOptions])

  useEffect(() => {
    void loadRows(page, pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize])

  // ---------- 同步进度轮询 ----------
  const pollSync = useCallback(async () => {
    try {
      const r = await getN9eSyncStatus()
      setSyncState(r.state)
      if (r.state.running) {
        if (timerRef.current === null) {
          timerRef.current = window.setInterval(() => {
            void pollSync()
          }, 2000)
        }
      } else {
        if (timerRef.current !== null) {
          window.clearInterval(timerRef.current)
          timerRef.current = null
        }
        if (r.state.phase === '完成') {
          // 同步完成后刷新页面数据（含下拉条数：同步后各数据源的条数会变）
          void loadStats()
          void loadRows(1, pageSize)
          void loadMeta()
          void loadOptions()
          void loadTemplates()
        }
      }
    } catch {
      // 轮询失败静默重试，不打扰用户
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadStats, loadRows, loadMeta, loadOptions, loadTemplates, pageSize])

  useEffect(() => {
    void pollSync()
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- 操作 ----------
  const doSync = async () => {
    const d = days === -1 && customRange ? customRange[1].diff(customRange[0], 'day') + 1 : days
    const target = d > 90 ? 90 : d
    try {
      const r = await startN9eSync(target)
      if (!r.started) {
        message.warning(r.msg)
      } else {
        message.success(r.msg)
        setSyncState({
          running: true,
          phase: '准备中',
          days: target,
          fetched: 0,
          total: 0,
          chunkIndex: 0,
          chunkTotal: 0,
          startedAt: '',
          finishedAt: '',
          elapsedMs: 0,
          error: '',
        })
        void pollSync()
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '同步启动失败')
    }
  }

  /** 触发浏览器下载（导出结果在内存里，服务端不落盘） */
  const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  /**
   * 导出。
   * - 传 tplId：按模板导出，**后端以模板为准**（列 + 筛选 + 时间范围），文件名带模板名。
   *   即使页面上还留着别的筛选条件也不影响 —— 这样「按模板导出」才是可复现的。
   * - 传 cols：按当前页面条件导出，但只取指定列。
   */
  const doExport = async (opt?: { tplId?: number; cols?: string; tplName?: string }) => {
    // 模板导出不走这条判断：页面上可能是空的，但模板自己的条件未必没数据
    if (!opt?.tplId && (!hasData || total === 0)) {
      message.warning('当前筛选条件下没有数据可导出（可先点「同步数据」）')
      return
    }
    setExporting(true)
    try {
      const { blob, filename } = await exportN9eAlerts({ ...queryParams, ...opt })
      saveBlob(blob, filename)
      message.success(
        opt?.tplName
          ? `已按模板「${opt.tplName}」导出`
          : `已导出当前筛选条件下的 ${total.toLocaleString()} 条记录`,
      )
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  // ---------- 导出模板 ----------
  /** 把模板的条件应用到页面，让用户看到模板到底筛了什么（所见即所得） */
  const applyTemplate = (t: N9eExportTemplate) => {
    const f = t.filter
    if (f.timeMode === 'custom' && f.stime > 0 && f.etime > 0) {
      setDays(-1)
      setCustomRange([dayjs.unix(f.stime), dayjs.unix(f.etime)])
    } else {
      setDays(f.days > 0 ? f.days : 90)
      setCustomRange(null)
    }
    setDatasourceIds(f.datasourceIds || [])
    setGroupIds(f.groupIds || [])
    setSeverity(f.severity > 0 ? f.severity : undefined)
    setRecovered(f.recovered ?? -1)
    setDepartment(f.department || undefined)
    setKeyword(f.keyword || '')
    setActiveTplName(t.name)
  }

  /** 按模板导出：先把条件下到页面（看得见口径），再带 tplId 导出 */
  const exportByTemplate = async (t: N9eExportTemplate) => {
    applyTemplate(t)
    setTplMgrOpen(false)
    await doExport({ tplId: t.id, tplName: t.name })
  }

  const openTplMgr = () => {
    setTplMgrOpen(true)
    void loadTemplates()
  }

  /** fromCurrent = 把页面当前的筛选条件直接带进新模板（最常用：调好了存一份） */
  const openTplCreate = (fromCurrent = false) => {
    const f = newTplForm()
    if (fromCurrent) {
      f.timeMode = days === -1 && customRange ? 'custom' : 'days'
      f.days = days > 0 ? days : 90
      f.customRange = days === -1 ? customRange : null
      f.datasourceIds = datasourceIds
      f.groupIds = groupIds
      f.severity = severity
      f.recovered = recovered
      f.department = department
      f.keyword = keyword
    }
    setTplEditing(null)
    setTplForm(f)
    setTplFormOpen(true)
  }

  const openTplEdit = (t: N9eExportTemplate) => {
    setTplEditing(t)
    setTplForm(tplToForm(t))
    setTplFormOpen(true)
  }

  /** 另存为副本：改口径时不动别人的模板 */
  const copyTpl = (t: N9eExportTemplate) => {
    const f = tplToForm(t)
    f.name = `${t.name} 副本`
    setTplEditing(null)
    setTplForm(f)
    setTplFormOpen(true)
  }

  const saveTpl = async () => {
    const body = formToTplInput(tplForm)
    if (!body.name) {
      message.warning('请填写模板名称')
      return
    }
    if (body.filter.timeMode === 'custom' && (!body.filter.stime || !body.filter.etime)) {
      message.warning('请选择自定义时间范围')
      return
    }
    setTplSaving(true)
    try {
      if (tplEditing) {
        await updateN9eExportTemplate(tplEditing.id, body)
        message.success('模板已更新')
      } else {
        await createN9eExportTemplate(body)
        message.success('模板已创建')
      }
      setTplFormOpen(false)
      await loadTemplates()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setTplSaving(false)
    }
  }

  const removeTpl = (t: N9eExportTemplate) => {
    Modal.confirm({
      title: '删除导出模板',
      content: `确定删除模板「${t.name}」吗？删除后不可恢复（创建人：${t.ownerName || '未知'}）。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteN9eExportTemplate(t.id)
          message.success('模板已删除')
          await loadTemplates()
        } catch (e) {
          message.error(e instanceof Error ? e.message : '删除失败')
          throw e
        }
      },
    })
  }

  const openColPick = () => {
    // 默认勾满后端返回的全部列（= 现有导出行为），用户按需取消
    setPickedCols(exportCols.map((c) => c.key))
    setColPickOpen(true)
  }

  const doExportPicked = async () => {
    if (pickedCols.length === 0) {
      message.warning('请至少选择一列')
      return
    }
    setColPickOpen(false)
    await doExport({ cols: pickedCols.join(',') })
  }

  /** 导出下拉菜单：直接导出 / 自选列 / 按模板导出 / 管理模板 */
  const exportMenuItems: MenuProps['items'] = [
    { key: 'current', icon: <FileExcelOutlined />, label: '按当前条件导出（全部列）' },
    { key: 'pick', icon: <SettingOutlined />, label: '自选列导出…' },
    ...(templates.length > 0
      ? [
          { type: 'divider' as const },
          {
            key: 'tpl-group',
            type: 'group' as const,
            label: '按模板导出',
            children: templates.map((t) => ({
              key: `tpl-${t.id}`,
              icon: <FileExcelOutlined />,
              label: t.name,
            })),
          },
        ]
      : []),
    { type: 'divider' as const },
    { key: 'mgr', icon: <PlusOutlined />, label: '新建 / 管理导出模板…' },
  ]

  /** 数据源 id → 名称（模板摘要里显示用；库里可能已没有这个数据源，退化成 #id） */
  const dsName = (id: number) => {
    const d = datasources.find((x) => x.datasourceId === id)
    return d?.datasourceName || `#${id}`
  }

  const onExportMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'current') void doExport()
    else if (key === 'pick') openColPick()
    else if (key === 'mgr') openTplMgr()
    else if (key.startsWith('tpl-')) {
      const t = templates.find((x) => `tpl-${x.id}` === key)
      if (t) void exportByTemplate(t)
    }
  }

  const openSetting = () => {
    setFormBase(config?.baseUrl || '')
    setFormToken('')
    setSettingOpen(true)
  }

  const doTest = async () => {
    setTesting(true)
    try {
      const r = await testN9eConfig({ baseUrl: formBase, token: formToken })
      message.success(r.msg)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '连接失败')
    } finally {
      setTesting(false)
    }
  }

  const doSave = async () => {
    setSaving(true)
    try {
      await saveN9eConfig({ baseUrl: formBase, token: formToken || undefined })
      message.success('已保存')
      setSettingOpen(false)
      void loadMeta()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // ---------- 图表 ----------
  const trendOption = useMemo(() => {
    const list = stats?.byDay || []
    return {
      grid: { left: 50, right: 20, top: 30, bottom: 50 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: list.map((d) => d.key),
        axisLabel: { rotate: list.length > 20 ? 45 : 0, fontSize: 10 },
      },
      yAxis: { type: 'value', name: '告警数' },
      series: [
        {
          type: 'line',
          smooth: true,
          showSymbol: false,
          areaStyle: { opacity: 0.15 },
          itemStyle: { color: '#1677ff' },
          data: list.map((d) => d.value),
        },
      ],
    }
  }, [stats])

  const severityOption = useMemo(() => {
    const list = (stats?.bySeverity || []).map((s) => ({
      name: severityText(Number(s.key)),
      value: s.value,
    }))
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0 },
      series: [
        {
          type: 'pie',
          radius: ['45%', '68%'],
          label: { formatter: '{b}\n{c}' },
          data: list.map((s) => ({
            ...s,
            itemStyle: {
              color: s.name === '严重' ? '#cf1322' : s.name === '警告' ? '#fa8c16' : '#1677ff',
            },
          })),
        },
      ],
    }
  }, [stats])

  // ---------- 明细表列 ----------
  const columns = useMemo(
    () => [
      {
        title: '触发时间',
        dataIndex: 'triggerTime',
        width: 165,
        render: (v: number) => fmtTime(v),
      },
      {
        title: '状态',
        dataIndex: 'isRecovered',
        width: 90,
        render: (v: number, r: N9eAlertEvent) =>
          v === 1 ? (
            <Tooltip title={`恢复于 ${fmtTime(r.recoverTime)}`}>
              <Tag color="green">已恢复</Tag>
            </Tooltip>
          ) : (
            <Tooltip title={`已持续 ${fmtDuration(Math.floor(Date.now() / 1000) - r.triggerTime)}`}>
              <Tag color="red">未恢复</Tag>
            </Tooltip>
          ),
      },
      {
        title: '等级',
        dataIndex: 'severity',
        width: 80,
        render: (v: number) => <Tag color={severityColor(v)}>{severityText(v)}</Tag>,
      },
      {
        title: '规则名称',
        dataIndex: 'ruleName',
        ellipsis: true,
        render: (v: string, r: N9eAlertEvent) => (
          <Tooltip title={r.ruleNote || v}>{v || '-'}</Tooltip>
        ),
      },
      {
        title: '目标主机',
        dataIndex: 'targetHost',
        width: 150,
        render: (v: string, r: N9eAlertEvent) => v || r.targetIdent || '-',
      },
      {
        title: '数据源',
        dataIndex: 'datasourceName',
        width: 170,
        ellipsis: true,
        render: (v: string, r: N9eAlertEvent) => v || (r.datasourceId ? `#${r.datasourceId}` : '-'),
      },
      { title: '业务组', dataIndex: 'groupName', width: 160, ellipsis: true },
      { title: '部门', dataIndex: 'department', width: 150, ellipsis: true, render: (v: string) => v || '-' },
      { title: '系统', dataIndex: 'systemName', width: 140, ellipsis: true, render: (v: string) => v || '-' },
      { title: '触发值', dataIndex: 'triggerValue', width: 90, render: (v: string) => v || '-' },
      { title: '通知次数', dataIndex: 'notifyCurNumber', width: 90 },
    ],
    [],
  )

  /** 简单的 TOP 榜（条数 + 占比条） */
  const renderTopList = (list: { key: string; value: number }[], color: string) => {
    const max = list.length > 0 ? list[0].value : 1
    if (list.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无数据" />
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.map((it) => (
          <div key={it.key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <Text ellipsis style={{ maxWidth: '72%' }}>
                {it.key}
              </Text>
              <Text strong>{it.value}</Text>
            </div>
            <Progress
              percent={max > 0 ? Math.round((it.value / max) * 100) : 0}
              showInfo={false}
              size="small"
              strokeColor={color}
            />
          </div>
        ))}
      </div>
    )
  }

  const hasData = (config?.syncedRows || 0) > 0
  const syncing = syncState?.running === true

  return (
    <div style={{ padding: 16 }}>
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          <AlertOutlined style={{ marginRight: 8 }} />
          监控告警报表
        </Title>
        <Tag color="purple">v1.7.51</Tag>
        <Tooltip title="数据来源：夜莺（Nightingale）历史告警">
          <Tag color="geekblue">{config?.baseUrl || '未配置'}</Tag>
        </Tooltip>
        <div style={{ flex: 1 }} />
        <Space>
          {hasPerm('prom:alert:update') && (
            <Button icon={<SettingOutlined />} onClick={openSetting}>
              连接设置
            </Button>
          )}
          {hasPerm('prom:alert:sync') && (
            <Button icon={<SyncOutlined spin={syncing} />} loading={syncing} onClick={doSync}>
              同步数据
            </Button>
          )}
          {hasPerm('prom:alert:export') && (
            // ⚠️ 刻意不做 disabled={total === 0}：那会把「新建/管理模板」一起禁掉，
            //    而「本地没数据时先把模板建好」是正常用法。无数据改为点击时提示。
            <Dropdown.Button
              type="primary"
              icon={<DownOutlined />}
              loading={exporting}
              onClick={() => void doExport()}
              menu={{ items: exportMenuItems, onClick: onExportMenuClick }}
            >
              <CloudDownloadOutlined /> 导出 Excel
            </Dropdown.Button>
          )}
        </Space>
      </div>

      {/* 数据新鲜度提示 —— 页面上所有查询都基于本地已同步数据，必须说清楚 */}
      <Alert
        type={hasData ? 'info' : 'warning'}
        showIcon
        style={{ marginBottom: 12 }}
        message={
          hasData ? (
            <span>
              本地已缓存 <b>{config?.syncedRows?.toLocaleString()}</b> 条告警，最后同步时间{' '}
              <b>{config?.lastSyncAt || '未知'}</b>；查询与统计基于本地缓存。
              {hasPerm('prom:alert:sync') && '看不到最新告警时请点「同步数据」。'}
            </span>
          ) : (
            <span>
              本地还没有数据。{hasPerm('prom:alert:sync') ? '请先点右上角「同步数据」' : '请联系管理员执行一次同步'}
              —— 90 天全量同步约需 1~2 分钟。
            </span>
          )
        }
      />

      {/* 同步进度 */}
      {syncing && syncState && (
        <Card size="small" style={{ marginBottom: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }} size={4}>
            <Space>
              <Spin size="small" />
              <Text strong>{syncState.phase}</Text>
              <Text type="secondary">
                已拉取 {syncState.fetched.toLocaleString()}
                {syncState.total > 0 ? ` / ${syncState.total.toLocaleString()}` : ''} 条
              </Text>
            </Space>
            <Progress
              percent={
                syncState.total > 0
                  ? Math.min(99, Math.floor((syncState.fetched / syncState.total) * 100))
                  : syncState.chunkTotal > 0
                    ? Math.floor((syncState.chunkIndex / syncState.chunkTotal) * 100)
                    : 0
              }
              status="active"
              size="small"
            />
          </Space>
        </Card>
      )}

      {/* 同步失败 */}
      {!syncing && syncState?.error && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message="上次同步失败" description={syncState.error} />
      )}

      {/* 筛选 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={[12, 8]}>
          <Segmented
            value={days}
            options={RANGE_OPTIONS}
            onChange={(v) => {
              setDays(v as number)
              if (v !== -1) setCustomRange(null)
            }}
          />
          {days === -1 && (
            <DatePicker.RangePicker
              value={customRange}
              onChange={(v) => setCustomRange(v as [Dayjs, Dayjs] | null)}
              disabledDate={(d) => d && d.isAfter(dayjs(), 'day')}
            />
          )}
          <Select
            mode="multiple"
            allowClear
            placeholder="数据源"
            style={{ minWidth: 220 }}
            maxTagCount="responsive"
            value={datasourceIds}
            onChange={setDatasourceIds}
            notFoundContent={
              hasData ? '暂无可选数据源（需重新同步一次以补全该字段）' : '本地无数据，请先同步'
            }
            options={datasources.map((d) => ({
              label: `${d.datasourceName || `#${d.datasourceId}`} (${d.n})`,
              value: d.datasourceId,
            }))}
          />
          <Select
            mode="multiple"
            allowClear
            placeholder="业务组"
            style={{ minWidth: 200 }}
            maxTagCount="responsive"
            value={groupIds}
            onChange={setGroupIds}
            options={groups.map((g) => ({ label: `${g.groupName} (${g.n})`, value: g.groupId }))}
          />
          <Select
            allowClear
            placeholder="告警等级"
            style={{ width: 120 }}
            value={severity}
            onChange={setSeverity}
            options={SEVERITY_OPTIONS}
          />
          <Select
            style={{ width: 110 }}
            value={recovered}
            onChange={setRecovered}
            options={RECOVER_OPTIONS}
          />
          <Select
            allowClear
            showSearch
            placeholder="部门"
            style={{ width: 160 }}
            value={department}
            onChange={setDepartment}
            options={depts.map((d) => ({ label: `${d.value} (${d.n})`, value: d.value }))}
          />
          <Input.Search
            allowClear
            placeholder="规则 / 主机 / 业务组关键字"
            style={{ width: 240 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={() => setKeyword(keyword)}
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              void loadStats()
              void loadRows(page, pageSize)
            }}
          >
            刷新
          </Button>
          {hasPerm('prom:alert:export') && (
            <Button icon={<PlusOutlined />} onClick={() => openTplCreate(true)}>
              存为模板
            </Button>
          )}
          {activeTplName && (
            <Tag color="blue" closable onClose={() => setActiveTplName('')}>
              当前条件来自模板：{activeTplName}
            </Tag>
          )}
        </Space>
      </Card>

      {/* 统计概览 */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="告警总数" value={stats?.total || 0} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="未恢复"
              value={stats?.unresolved || 0}
              valueStyle={{ color: (stats?.unresolved || 0) > 0 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="涉及主机" value={stats?.hostCount || 0} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="涉及规则" value={stats?.ruleCount || 0} />
          </Card>
        </Col>
      </Row>

      {/* 图表 */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={16}>
          <Card size="small" title="告警趋势（按天）">
            <ReactECharts
              option={trendOption}
              style={{ height: 240 }}
              notMerge
              lazyUpdate
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small" title="等级分布">
            <ReactECharts option={severityOption} style={{ height: 240 }} notMerge lazyUpdate />
          </Card>
        </Col>
      </Row>

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={8}>
          <Card size="small" title="业务组 TOP10">
            {renderTopList(stats?.byGroup || [], '#1677ff')}
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small" title="告警规则 TOP10">
            {renderTopList(stats?.byRule || [], '#fa8c16')}
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small" title="部门 TOP10">
            {renderTopList(stats?.byDept || [], '#52c41a')}
          </Card>
        </Col>
      </Row>

      {/* 明细 */}
      <Card
        size="small"
        title={`告警明细（${total.toLocaleString()} 条）`}
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            导出 Excel 会导出当前筛选条件下的全部 {total.toLocaleString()} 条
          </Text>
        }
      >
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={rows}
          scroll={{ x: 1620 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: ['20', '50', '100'],
            showTotal: (t) => `共 ${t.toLocaleString()} 条`,
            onChange: (p, ps) => {
              setPage(p)
              setPageSize(ps)
            },
          }}
        />
      </Card>

      {/* 连接设置 */}
      <Modal
        open={settingOpen}
        title="夜莺连接设置"
        onCancel={() => setSettingOpen(false)}
        onOk={doSave}
        confirmLoading={saving}
        okText="保存"
        width={560}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text strong>夜莺地址</Text>
            <Input
              style={{ marginTop: 4 }}
              placeholder="http://n9e.internal.example:9999"
              value={formBase}
              onChange={(e) => setFormBase(e.target.value)}
            />
          </div>
          <div>
            <Text strong>API Token</Text>
            <Input.Password
              style={{ marginTop: 4 }}
              placeholder={config?.hasToken ? `已配置（${config.tokenMask}），留空表示不修改` : '请输入夜莺 API Token'}
              value={formToken}
              onChange={(e) => setFormToken(e.target.value)}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              在夜莺「个人中心 → 密钥管理」生成；平台以请求头 X-User-Token 调用夜莺接口。
            </Text>
          </div>
          <Space>
            <Button loading={testing} onClick={doTest}>
              测试连接
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              测试直接用上面填写的值，不要求先保存
            </Text>
          </Space>
        </Space>
      </Modal>

      {/* 导出模板管理 */}
      <Modal
        open={tplMgrOpen}
        title="导出模板"
        onCancel={() => setTplMgrOpen(false)}
        footer={null}
        width={960}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="模板全局共享：所有人都能看到和使用。点「导出」会先把模板的条件应用到页面上，再按模板导出，文件名带模板名。"
        />
        <Space style={{ marginBottom: 12 }} wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openTplCreate(true)}>
            用当前筛选条件新建
          </Button>
          <Button icon={<PlusOutlined />} onClick={() => openTplCreate(false)}>
            新建空白模板
          </Button>
          <Button
            icon={<ReloadOutlined />}
            loading={tplLoading}
            onClick={() => void loadTemplates()}
          >
            刷新
          </Button>
        </Space>
        <Table
          rowKey="id"
          size="small"
          loading={tplLoading}
          dataSource={templates}
          pagination={false}
          locale={{ emptyText: <Empty description="还没有导出模板，点上面「新建」开始" /> }}
          columns={[
            {
              title: '模板名称',
              dataIndex: 'name',
              width: 220,
              render: (v: string, r: N9eExportTemplate) => (
                <>
                  <div>
                    <Text strong>{v}</Text>
                  </div>
                  {r.remark && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {r.remark}
                    </Text>
                  )}
                </>
              ),
            },
            {
              title: '数据范围',
              key: 'range',
              render: (_: unknown, r: N9eExportTemplate) => (
                <Text style={{ fontSize: 12 }}>{tplFilterSummary(r.filter, dsName)}</Text>
              ),
            },
            {
              title: '列数',
              dataIndex: 'colCount',
              width: 80,
              render: (v: number) => <Tag>{v} 列</Tag>,
            },
            { title: '创建人', dataIndex: 'ownerName', width: 100 },
            {
              title: '更新时间',
              dataIndex: 'updatedAt',
              width: 150,
              render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
            },
            {
              title: '操作',
              key: 'op',
              width: 230,
              render: (_: unknown, r: N9eExportTemplate) => (
                <Space size={2}>
                  <Button
                    type="link"
                    size="small"
                    icon={<FileExcelOutlined />}
                    onClick={() => void exportByTemplate(r)}
                  >
                    导出
                  </Button>
                  <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openTplEdit(r)}>
                    编辑
                  </Button>
                  <Button type="link" size="small" icon={<CopyOutlined />} onClick={() => copyTpl(r)}>
                    副本
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removeTpl(r)}
                  >
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Modal>

      {/* 模板新建 / 编辑 */}
      <Modal
        open={tplFormOpen}
        title={tplEditing ? `编辑模板：${tplEditing.name}` : '新建导出模板'}
        onCancel={() => setTplFormOpen(false)}
        onOk={saveTpl}
        confirmLoading={tplSaving}
        okText="保存"
        width={780}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={14}>
          <div>
            <Text strong>模板名称</Text>
            <Input
              style={{ marginTop: 4 }}
              maxLength={64}
              placeholder="例如：运维日常巡检告警"
              value={tplForm.name}
              onChange={(e) => setTplForm({ ...tplForm, name: e.target.value })}
            />
          </div>
          <div>
            <Text strong>说明（可选）</Text>
            <Input.TextArea
              style={{ marginTop: 4 }}
              rows={2}
              maxLength={255}
              placeholder="这份报表给谁看、关注什么"
              value={tplForm.remark}
              onChange={(e) => setTplForm({ ...tplForm, remark: e.target.value })}
            />
          </div>
          <div>
            <Text strong>时间范围</Text>
            <div style={{ marginTop: 4 }}>
              <Space wrap>
                <Segmented
                  value={tplForm.timeMode === 'custom' ? -1 : tplForm.days}
                  options={RANGE_OPTIONS}
                  onChange={(v) => {
                    const n = v as number
                    if (n === -1) setTplForm({ ...tplForm, timeMode: 'custom', customRange: null })
                    else setTplForm({ ...tplForm, timeMode: 'days', days: n, customRange: null })
                  }}
                />
                {tplForm.timeMode === 'custom' && (
                  <DatePicker.RangePicker
                    value={tplForm.customRange}
                    onChange={(v) =>
                      setTplForm({ ...tplForm, customRange: v as [Dayjs, Dayjs] | null })
                    }
                    disabledDate={(d) => d && d.isAfter(dayjs(), 'day')}
                  />
                )}
              </Space>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  建议用「近 N 天」：模板要长期复用，写死的日期过一段时间就会滑出本地保留的 90
                  天窗口，那时导出会是空表。
                </Text>
              </div>
            </div>
          </div>
          <div>
            <Text strong>筛选条件</Text>
            <Space wrap style={{ marginTop: 4 }}>
              <Select
                mode="multiple"
                allowClear
                placeholder="数据源"
                style={{ minWidth: 200 }}
                maxTagCount="responsive"
                value={tplForm.datasourceIds}
                onChange={(v) => setTplForm({ ...tplForm, datasourceIds: v })}
                options={datasources.map((d) => ({
                  label: `${d.datasourceName || `#${d.datasourceId}`} (${d.n})`,
                  value: d.datasourceId,
                }))}
              />
              <Select
                mode="multiple"
                allowClear
                placeholder="业务组"
                style={{ minWidth: 180 }}
                maxTagCount="responsive"
                value={tplForm.groupIds}
                onChange={(v) => setTplForm({ ...tplForm, groupIds: v })}
                options={groups.map((g) => ({ label: g.groupName, value: g.groupId }))}
              />
              <Select
                allowClear
                placeholder="告警等级"
                style={{ width: 120 }}
                value={tplForm.severity}
                onChange={(v) => setTplForm({ ...tplForm, severity: v })}
                options={SEVERITY_OPTIONS}
              />
              <Select
                style={{ width: 110 }}
                value={tplForm.recovered}
                onChange={(v) => setTplForm({ ...tplForm, recovered: v })}
                options={RECOVER_OPTIONS}
              />
              <Select
                allowClear
                showSearch
                placeholder="部门"
                style={{ width: 150 }}
                value={tplForm.department}
                onChange={(v) => setTplForm({ ...tplForm, department: v })}
                options={depts.map((d) => ({ label: d.value, value: d.value }))}
              />
              <Input
                allowClear
                placeholder="规则 / 主机 / 业务组关键字"
                style={{ width: 240 }}
                value={tplForm.keyword}
                onChange={(e) => setTplForm({ ...tplForm, keyword: e.target.value })}
              />
            </Space>
          </div>
          <div>
            <Text strong>导出列（顺序即 Excel 的列顺序）</Text>
            <div style={{ marginTop: 6 }}>
              <ColPicker
                all={exportCols}
                value={tplForm.columns}
                onChange={(v) => setTplForm({ ...tplForm, columns: v })}
              />
            </div>
          </div>
        </Space>
      </Modal>

      {/* 自选列导出 */}
      <Modal
        open={colPickOpen}
        title="自选列导出"
        onCancel={() => setColPickOpen(false)}
        onOk={doExportPicked}
        okText="开始导出"
        confirmLoading={exporting}
        width={720}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`按当前筛选条件导出 ${total.toLocaleString()} 条，只包含你勾选的列。想长期复用这套列，可点筛选区的「存为模板」。`}
        />
        <ColPicker all={exportCols} value={pickedCols} onChange={setPickedCols} />
      </Modal>
    </div>
  )
}

/**
 * 列选择器：勾选 + 排序。
 *
 * ⚠️ Checkbox.Group 回调里的数组顺序是「options 的声明顺序」，不能拿来表达用户想要的列顺序，
 * 所以这里只用它判断「哪些被勾上了」，真正的顺序以外部 value 为准逐项增删 ——
 * 否则用户辛苦调好的顺序会在下一次勾选时被打回原样。
 */
function ColPicker({
  all,
  value,
  onChange,
}: {
  all: N9eExportCol[]
  value: string[]
  onChange: (v: string[]) => void
}) {
  const labelOf = (k: string) => all.find((c) => c.key === k)?.label || k

  const onCheck = (checked: string[]) => {
    const kept = value.filter((k) => checked.includes(k))
    const added = all.map((c) => c.key).filter((k) => checked.includes(k) && !value.includes(k))
    onChange([...kept, ...added])
  }

  const move = (i: number, delta: number) => {
    const j = i + delta
    if (j < 0 || j >= value.length) return
    const next = [...value]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div>
      <Checkbox.Group value={value} onChange={(v) => onCheck(v as string[])}>
        <Space wrap size={[12, 6]}>
          {all.map((c) => (
            <Checkbox key={c.key} value={c.key}>
              {c.label}
            </Checkbox>
          ))}
        </Space>
      </Checkbox.Group>
      <Divider style={{ margin: '10px 0' }} />
      <Text type="secondary" style={{ fontSize: 12 }}>
        导出顺序（用 ↑ ↓ 调整）：
      </Text>
      <div style={{ marginTop: 6 }}>
        {value.length === 0 ? (
          <Text type="secondary">未勾选任何列（等于导出全部列）</Text>
        ) : (
          value.map((k, i) => (
            <Tag
              key={k}
              style={{ marginBottom: 4 }}
              closable
              onClose={() => onChange(value.filter((x) => x !== k))}
            >
              <span style={{ marginRight: 4 }}>
                {i + 1}. {labelOf(k)}
              </span>
              <a
                onClick={() => move(i, -1)}
                style={{ opacity: i === 0 ? 0.3 : 1, cursor: i === 0 ? 'default' : 'pointer' }}
              >
                <ArrowUpOutlined />
              </a>
              <a
                onClick={() => move(i, 1)}
                style={{
                  marginLeft: 6,
                  opacity: i === value.length - 1 ? 0.3 : 1,
                  cursor: i === value.length - 1 ? 'default' : 'pointer',
                }}
              >
                <ArrowDownOutlined />
              </a>
            </Tag>
          ))
        )}
      </div>
    </div>
  )
}
