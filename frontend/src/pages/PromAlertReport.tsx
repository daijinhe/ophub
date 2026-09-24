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
  listN9eEvents,
  listN9eExportColumns,
  listN9eExportTemplates,
  listN9eGroups,
  listN9eRuleProds,
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
// ⚠️ 筛选控件与夜莺「历史告警」页**逐个对齐**（v1.7.52，顺序也一致）：
//
//	夜莺控件            本页控件        查询参数          语义
//	监控类型            监控类型        ruleProds        metric / host / logging，多选
//	数据源              数据源          datasourceIds    多选
//	业务组              业务组          groupIds         ⚠️ 夜莺只支持单值（bgid），故本页也改单选
//	告警级别            告警级别        severity         1=S1 最严重、2=S2、3=S3
//	事件类别            事件类别        recovered        0=触发（未恢复） 1=已恢复
//	模糊搜索规则和标签   规则/标签关键字  keyword          空格分词，**全部命中**（AND）
//
// ⚠️ 关键字搜的是「规则标题 + 事件标签」：主机 IP、部门、系统只存在于标签里，
//    夜莺搜得到（query=203.0.113.207 → 92 条），所以本地也必须搜 tags_json。
//
// ⚠️ 为什么页面上的「时间范围」改了不会自动重拉夜莺：
//    页面上的查询/统计/导出全部走**本地已同步的数据**（毫秒级）；
//    只有点「同步数据」才会去连夜莺。实测 90 天全量要 94 秒，
//    如果每次改筛选条件都现拉，页面会不可用。
//    ⚠️ 由此带来一个必知口径：本地是**快照**，最新告警要等下次同步才进来，
//    所以「最近几分钟刚发生的告警」条数必然少于夜莺 —— 不是算错，是数据时点不同。
//    页面头部会显著提示数据截止时间；超过 30 分钟会主动提示同步。
//
// ⚠️ 下拉选项来源：业务组来自 n9e_busi_groups（**全部**业务组，对齐夜莺的下拉），
//    数据源来自本地库 distinct。业务组清单表是 v1.7.52 才落的，
//    老环境升级后需**重新同步一次**；未同步过时会退化成「只列事件里出现过的业务组」。
// ============================================================================

const RANGE_OPTIONS = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
  { label: '自定义', value: -1 },
]

/**
 * 告警级别选项 —— 与夜莺完全一致：**1 = S1 最严重**。
 *
 * ⚠️ v1.7.49~v1.7.51 这里写反了（严重=3、提醒=1），导致最严重的一级被标成
 * 「提醒」还配了蓝色。依据：夜莺历史告警页硬编码 `<Option value={1}>S1（Critical）</Option>`。
 */
const SEVERITY_OPTIONS = [
  { label: 'S1（严重）', value: 1 },
  { label: 'S2（警告）', value: 2 },
  { label: 'S3（提醒）', value: 3 },
]

/** 事件类别（夜莺 eventType）：0 = Triggered（触发/未恢复）、1 = Recovered（已恢复） */
const RECOVER_OPTIONS = [
  { label: '全部', value: -1 },
  { label: '触发（未恢复）', value: 0 },
  { label: '已恢复', value: 1 },
]

/**
 * 监控类型 value → 夜莺同款显示名（Metric / Host / Log）。
 *
 * ⚠️ 刻意用**模块级常量**而不是页面里的 `prodLabel`：后者闭包了异步加载的 `prodOptions`，
 * 而明细表 `columns` 的 useMemo 依赖是 `[]`，会永久拿到首帧的空清单 ⇒ 列里显示原始
 * `metric` 而筛选框显示 `Metric`，同一页两种写法。
 * 清单外的取值（夜莺还可能出 anomaly/loki/firemap/northstar）原样显示，不丢弃。
 */
const RULE_PROD_LABELS: Record<string, string> = {
  metric: 'Metric',
  host: 'Host',
  logging: 'Log',
}
const ruleProdText = (v: string) => RULE_PROD_LABELS[v] || v || '-'

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
  ruleProds: string[]
  severity?: number
  recovered: number
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
    ruleProds: [],
    severity: undefined,
    recovered: -1,
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
    ruleProds: f.ruleProds || [],
    severity: f.severity > 0 ? f.severity : undefined,
    recovered: f.recovered ?? -1,
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
      ruleProds: f.ruleProds,
      severity: f.severity || 0,
      recovered: f.recovered,
      // 部门已不是筛选维度（v1.7.52 对齐夜莺），保留空串以兼容老模板的字段
      department: '',
      keyword: f.keyword.trim(),
    },
  }
}

/** 模板条件的一行摘要（模板列表里显示，几个模板的差别一眼能看出来） */
function tplFilterSummary(
  f: N9eExportFilter,
  dsName: (id: number) => string,
  grpName: (id: number) => string,
  prodLabel: (v: string) => string,
): string {
  const parts: string[] = []
  if (f.timeMode === 'custom' && f.stime > 0 && f.etime > 0) {
    parts.push(
      `${dayjs.unix(f.stime).format('YYYY-MM-DD')} ~ ${dayjs.unix(f.etime).format('YYYY-MM-DD')}`,
    )
  } else {
    parts.push(`近 ${f.days || 90} 天`)
  }
  if (f.ruleProds?.length) parts.push(`监控类型：${f.ruleProds.map(prodLabel).join('、')}`)
  if (f.datasourceIds?.length) parts.push(`数据源：${f.datasourceIds.map(dsName).join('、')}`)
  if (f.groupIds?.length) parts.push(`业务组：${f.groupIds.map(grpName).join('、')}`)
  if (f.severity) parts.push(severityText(f.severity))
  if (f.recovered === 0) parts.push('仅未恢复')
  if (f.recovered === 1) parts.push('仅已恢复')
  if (f.keyword) parts.push(`关键字：${f.keyword}`)
  return parts.join(' · ')
}

/**
 * 等级配色 —— ⚠️ 与夜莺一致：1 = S1 最严重 = 红。
 * v1.7.51 之前判的是 `v >= 3` 才是红，等于把最严重的一级画成蓝色。
 */
function severityColor(v: number): string {
  if (v === 1) return 'red'
  if (v === 2) return 'orange'
  return 'blue'
}

function severityText(v: number): string {
  if (v === 1) return '严重'
  if (v === 2) return '警告'
  if (v === 3) return '提醒'
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

  // ---- 筛选条件（顺序与夜莺历史告警页一致）----
  const [days, setDays] = useState<number>(90)
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null)
  /** 监控类型（夜莺 rule_prods）：metric / host / logging */
  const [ruleProds, setRuleProds] = useState<string[]>([])
  const [datasourceIds, setDatasourceIds] = useState<number[]>([])
  /**
   * 业务组。⚠️ 夜莺的 bgid 只接受**单值**（传多个逗号会 400），所以这里也是单选，
   * 保证「平台筛出来的」与「夜莺筛出来的」完全可比。
   */
  const [groupIds, setGroupIds] = useState<number[]>([])
  const [severity, setSeverity] = useState<number | undefined>(undefined)
  const [recovered, setRecovered] = useState<number>(-1)
  const [keyword, setKeyword] = useState('')
  /**
   * 真正参与查询的关键字（防抖 300ms 后同步）。
   *
   * ⚠️ 直接用输入框的值会让**每敲一个字符**都发起一次统计 + 一次列表查询，
   * 而带关键字的统计要在 90 天 25 万行上做 ILIKE 扫描（实测一次约 300ms）——
   * 输入「政务一体化重点系统」就是 20 次全表扫描。
   * 且并发响应乱序时，先到的「筛后结果」会被后到的「全量结果」覆盖，
   * 界面数字与筛选条件不一致（配合下面的序号守卫一起解决）。
   */
  const [kwApplied, setKwApplied] = useState('')

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
  const [prodOptions, setProdOptions] = useState<{ value: string; label: string; n: number }[]>([])
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
  /** 查询序号（防竞态：只接受最新一次请求的响应，见 loadStats / loadRows 注释） */
  const statsSeqRef = useRef(0)
  const rowsSeqRef = useRef(0)
  const optsSeqRef = useRef(0)

  /** 关键字防抖：清空立即生效，否则 300ms 后再查 */
  useEffect(() => {
    if (keyword === '') {
      setKwApplied('')
      return
    }
    const t = window.setTimeout(() => setKwApplied(keyword), 300)
    return () => window.clearTimeout(t)
  }, [keyword])

  /** 查询/统计/导出共用同一份条件，避免三处口径漂移 */
  const queryParams = useMemo<N9eQueryParams>(() => {
    const p: N9eQueryParams = {}
    if (days === -1 && customRange) {
      p.stime = customRange[0].startOf('day').unix()
      p.etime = customRange[1].endOf('day').unix()
    } else {
      p.days = days > 0 ? days : 90
    }
    if (ruleProds.length > 0) p.ruleProds = ruleProds.join(',')
    if (datasourceIds.length > 0) p.datasourceIds = datasourceIds.join(',')
    if (groupIds.length > 0) p.groupIds = groupIds.join(',')
    if (severity !== undefined) p.severity = severity
    if (recovered >= 0) p.recovered = recovered
    if (kwApplied.trim()) p.keyword = kwApplied.trim()
    return p
  }, [days, customRange, ruleProds, datasourceIds, groupIds, severity, recovered, kwApplied])

  // ---------- 加载 ----------
  const loadStats = useCallback(async () => {
    const seq = ++statsSeqRef.current
    try {
      const s = await getN9eStats(queryParams)
      // ⚠️ 竞态防护：旧请求可能比新请求**后**返回（全量统计比带关键字的统计慢得多），
      //    不加序号就会出现「先显示筛后的 24 条、又被 2 秒后到的 25 万覆盖回去」。
      if (seq !== statsSeqRef.current) return
      setStats(s)
    } catch (e) {
      if (seq !== statsSeqRef.current) return
      message.error(e instanceof Error ? e.message : '统计加载失败')
    }
  }, [queryParams])

  const loadRows = useCallback(
    async (p = page, ps = pageSize) => {
      const seq = ++rowsSeqRef.current
      setLoading(true)
      try {
        const r = await listN9eEvents({ ...queryParams, page: p, pageSize: ps })
        if (seq !== rowsSeqRef.current) return
        setRows(r.list || [])
        setTotal(r.total || 0)
      } catch (e) {
        if (seq !== rowsSeqRef.current) return
        message.error(e instanceof Error ? e.message : '查询失败')
      } finally {
        if (seq === rowsSeqRef.current) setLoading(false)
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
   * 三个下拉的选项与条数（监控类型 / 数据源 / 业务组）。
   * ⚠️ 依赖时间范围：条数是按同一时间窗统计的，否则下拉里写「(95674)」、
   * 点进去总数却是 95669，用户只会认为报表算错了。
   */
  const loadOptions = useCallback(async () => {
    const seq = ++optsSeqRef.current
    try {
      const [ps, ds, gs] = await Promise.all([
        listN9eRuleProds(timeParams),
        listN9eDatasources(timeParams),
        listN9eGroups(timeParams),
      ])
      if (seq !== optsSeqRef.current) return
      setProdOptions(ps.list || [])
      setDatasources(ds.list || [])
      setGroups(gs.list || [])
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

  /**
   * 本地数据的陈旧度（分钟）—— 页面上所有数字都来自本地快照，
   * 「最近 N 小时」这种窗口下必然少于夜莺实时数据（实测：3 天内差 26 条）。
   * 所以必须把「截止时间」摆在明面上，超过阈值就提示/自动补一次。
   *
   * ⚠️ `lastSyncAt` 是**带时区偏移的 RFC3339**（后端容器 UTC），dayjs 会按偏移解析成
   * 正确的时间点，`diff` 出来的分钟数才是真的。若后端哪天退回输出裸时间串（无偏移），
   * 这里会被当成本地时间、凭空多出 8 小时 ⇒ 陈旧度永远超标、每次打开都自动同步一遍。
   */
  const staleMinutes = useMemo(() => {
    if (!config?.lastSyncAt) return null
    const t = dayjs(config.lastSyncAt)
    return t.isValid() ? dayjs().diff(t, 'minute') : null
  }, [config?.lastSyncAt])

  /** 超过这个分钟数就认为数据「不新鲜」，提示并自动同步 */
  const STALE_MINUTES = 30

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

  /**
   * 数据过期就自动补一次（只触发一次，避免轮询回来反复触发）。
   *
   * 为什么需要它：本页是夜莺的**本地快照**，不同步就永远比夜莺少最近这段时间的告警 ——
   * 用户拿「近 1 小时 / 近 3 天」跟夜莺对比时必然对不上。
   * 只对有同步权限的人触发，且正在同步时不重复启动；同步进度条会照常显示。
   */
  const autoSyncFired = useRef(false)
  useEffect(() => {
    if (autoSyncFired.current) return
    if (!config) return
    if ((config.syncedRows || 0) <= 0) return
    if (!hasPerm('prom:alert:sync')) return
    if (syncState?.running) return
    if (staleMinutes === null || staleMinutes <= STALE_MINUTES) return
    autoSyncFired.current = true
    message.info(`本地数据已 ${staleMinutes} 分钟未更新，正在自动同步最新告警…`)
    void doSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, staleMinutes, syncState?.running])

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
    setRuleProds(f.ruleProds || [])
    setDatasourceIds(f.datasourceIds || [])
    setGroupIds(f.groupIds || [])
    setSeverity(f.severity > 0 ? f.severity : undefined)
    setRecovered(f.recovered ?? -1)
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
      f.ruleProds = ruleProds
      f.datasourceIds = datasourceIds
      f.groupIds = groupIds
      f.severity = severity
      f.recovered = recovered
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

  /** 业务组 id → 名称（模板摘要用） */
  const grpName = (id: number) => groups.find((g) => g.groupId === id)?.groupName || `#${id}`

  /** 监控类型 value → 显示名（模板摘要用） */
  const prodLabel = (v: string) => prodOptions.find((p) => p.value === v)?.label || v

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
              // 1 = S1 最严重（红），与夜莺一致
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
        title: '监控类型',
        dataIndex: 'ruleProd',
        width: 100,
        render: (v: string) => ruleProdText(v),
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
        <Tag color="purple">v1.7.53</Tag>
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
        type={!hasData ? 'warning' : staleMinutes !== null && staleMinutes > STALE_MINUTES ? 'warning' : 'info'}
        showIcon
        style={{ marginBottom: 12 }}
        message={
          hasData ? (
            <span>
              本地已缓存 <b>{config?.syncedRows?.toLocaleString()}</b> 条告警，数据截止于{' '}
              {/*
                ⚠️ 后端返回的是**带时区偏移的 RFC3339**（后端容器是 UTC），
                必须交给 dayjs 解析后再格式化成本地时间 —— 直接原样渲染会显示 UTC，
                用户看到的「截止时间」就比实际早 8 小时。
              */}
              <b>
                {config?.lastSyncAt
                  ? dayjs(config.lastSyncAt).format('YYYY-MM-DD HH:mm:ss')
                  : '未知'}
              </b>
              {staleMinutes !== null && `（${staleMinutes} 分钟前）`}；查询、统计与导出都基于这份本地快照。
              {(staleMinutes === null || staleMinutes > STALE_MINUTES) &&
                '⚠️ 本地是快照、不是实时流：刚才新产生的告警还没同步进来，所以「最近几小时」的条数会比夜莺少。'}
            </span>
          ) : (
            <span>
              本地还没有数据。{hasPerm('prom:alert:sync') ? '请先点右上角「同步数据」' : '请联系管理员执行一次同步'}
              —— 90 天全量同步约需 1~2 分钟。
            </span>
          )
        }
        action={
          hasData && hasPerm('prom:alert:sync') && !syncing ? (
            <Button size="small" icon={<SyncOutlined />} onClick={doSync}>
              立即同步
            </Button>
          ) : null
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
          {/* 监控类型（夜莺 rule_prods）：固定 Metric / Host / Log，允许 0 条也列出来 */}
          <Select
            mode="multiple"
            allowClear
            placeholder="监控类型"
            style={{ minWidth: 170 }}
            maxTagCount="responsive"
            value={ruleProds}
            onChange={setRuleProds}
            options={prodOptions.map((p) => ({
              label: p.n > 0 ? `${p.label} (${p.n})` : p.label,
              value: p.value,
            }))}
          />
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
          {/* 业务组 —— ⚠️ 夜莺的 bgid 只支持单值，这里也是单选，保证两边筛出来完全可比 */}
          {/*
            ⚠️ zIndex 必须**低于 Modal 默认的 1000**。
            浮层（Tooltip/Popover 默认 1070）一旦高于 Modal，就会**拦掉弹窗里同坐标控件的点击** ——
            实测：悬停过「业务组」后打开「导出模板」弹窗，这个 tooltip 停在那儿不消失，
            弹窗里那一行的「导出」按钮就永远点不动（浏览器报 "…tooltip-inner intercepts pointer events"）。
            提示类浮层本就不该盖在弹窗上，压到 900（仍在普通内容之上、弹窗遮罩之下）最省事。
          */}
          <Tooltip title="与夜莺一致：业务组只能选一个" zIndex={900}>
            <Select
              allowClear
              showSearch
              placeholder="业务组"
              style={{ minWidth: 190 }}
              optionFilterProp="label"
              value={groupIds[0]}
              onChange={(v) => setGroupIds(v === undefined ? [] : [v])}
              notFoundContent={
                hasData
                  ? '暂无业务组（需重新同步一次以补全清单）'
                  : '本地无数据，请先同步'
              }
              options={groups.map((g) => ({
                label: g.n > 0 ? `${g.groupName} (${g.n})` : g.groupName,
                value: g.groupId,
              }))}
            />
          </Tooltip>
          <Select
            allowClear
            placeholder="告警级别"
            style={{ width: 130 }}
            value={severity}
            onChange={setSeverity}
            options={SEVERITY_OPTIONS}
          />
          <Select
            style={{ width: 140 }}
            value={recovered}
            onChange={setRecovered}
            options={RECOVER_OPTIONS}
          />
          <Input.Search
            allowClear
            placeholder="模糊搜索规则和标签（多个关键字用空格分隔）"
            style={{ width: 300 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={() => setKwApplied(keyword)}
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
                <Text style={{ fontSize: 12 }}>
                  {tplFilterSummary(r.filter, dsName, grpName, prodLabel)}
                </Text>
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
                placeholder="监控类型"
                style={{ minWidth: 170 }}
                maxTagCount="responsive"
                value={tplForm.ruleProds}
                onChange={(v) => setTplForm({ ...tplForm, ruleProds: v })}
                options={prodOptions.map((p) => ({ label: p.label, value: p.value }))}
              />
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
              {/* 与夜莺一致：业务组单选 */}
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="业务组"
                style={{ minWidth: 180 }}
                value={tplForm.groupIds[0]}
                onChange={(v) =>
                  setTplForm({ ...tplForm, groupIds: v === undefined ? [] : [v] })
                }
                options={groups.map((g) => ({ label: g.groupName, value: g.groupId }))}
              />
              <Select
                allowClear
                placeholder="告警级别"
                style={{ width: 130 }}
                value={tplForm.severity}
                onChange={(v) => setTplForm({ ...tplForm, severity: v })}
                options={SEVERITY_OPTIONS}
              />
              <Select
                style={{ width: 140 }}
                value={tplForm.recovered}
                onChange={(v) => setTplForm({ ...tplForm, recovered: v })}
                options={RECOVER_OPTIONS}
              />
              <Input
                allowClear
                placeholder="模糊搜索规则和标签（空格分隔多个关键字）"
                style={{ width: 300 }}
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
