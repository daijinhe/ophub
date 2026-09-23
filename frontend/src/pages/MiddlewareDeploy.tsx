import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Card,
  Row,
  Col,
  Select,
  TreeSelect,
  Input,
  Button,
  Table,
  Tag,
  Switch,
  Modal,
  Form,
  Input as AInput,
  InputNumber,
  Typography,
  Space,
  Alert,
  Empty,
  Tooltip,
  Checkbox,
  App,
  Spin,
  Divider,
  Steps,
  Progress,
  Segmented,
} from 'antd'
import {
  DeploymentUnitOutlined,
  CloudServerOutlined,
  SafetyCertificateOutlined,
  SafetyOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  PlusOutlined,
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  ApiOutlined,
  FileTextOutlined,
  CodeOutlined,
  ThunderboltOutlined,
  DatabaseOutlined,
  Html5Outlined,
  AppstoreOutlined,
  SettingOutlined,
  AimOutlined,
  RocketOutlined,
  CheckCircleFilled,
  NodeIndexOutlined,
  ApartmentOutlined,
  WarningOutlined,
  ClusterOutlined,
  PartitionOutlined,
  CloseOutlined,
  EditOutlined,
  HistoryOutlined,
} from '@ant-design/icons'
import api from '../api/client'
import {
  getDeployCatalog,
  detectTargets,
  listDeployCerts,
  createDeployCert,
  deleteDeployCert,
  deployRun,
  getDeployJob,
  sysinitOptions,
  createSysInit,
  getSysInitJob,
  detectSysInitEnv,
  type MiddlewareDef,
  type DeployTarget,
  type DeployCert,
  type DeployJob,
  type RemoteNode,
  type SysInitOptions,
  type SysInitTaskOption,
  type SysInitEnvZone,
  type SysInitEnvTarget,
  type ManualTargetPayload,
} from '../api/deploy'
import { MwBrandIcon, MW_BRAND_COLOR } from '../components/MwBrandIcon'
import { useAuth } from '../store/AuthContext'

const { Title, Paragraph, Text } = Typography

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
  createdAt?: string
  updatedAt?: string
}

// 已选中间件项：每项各自携带版本 / 部署模式 / 证书配置
export interface MwItem {
  type: string
  version: string
  mode: string
  hasCert: boolean
  certId?: number
  certName: string
}

// 手动输入的目标条目（不走资产管理）：在向导第 03 步「手动输入」模式下添加。
// id 用负数（与资产 id 互斥）：-Date.now()-i，前端用负 id 判定手动目标。
interface ManualEntry {
  id: number
  ip: string
  port: string
  user: string
  pass: string
  become: string
  becomePass: string
  zone: string
  osType: string
  cpuType: string
  remark?: string
}

// OS/CPU 令牌必须与控制节点脚本文件名中的令牌一致（与 MiddlewareConfig 同步）
const MANUAL_OS_TYPES = [
  'centos7',
  'almalinux8.9',
  'almalinux8.10',
  'openEuler20.03',
  'openEuler22.03',
  'hce2.0',
  'kylinV10',
]
const MANUAL_CPU_TYPES = ['x86_64', 'aarch64']

const toTreeData = (nodes: CatNode[]): any[] =>
  nodes.map((n) => ({
    key: n.id,
    value: n.id,
    title: n.name,
    children: n.children?.length ? toTreeData(n.children) : undefined,
  }))

// 时间格式化：2026-09-10 15:30
const fmtTime = (s?: string) => {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`
}

// 中间件品牌色（与 MwBrandIcon.MW_BRAND_COLOR 保持一致）
const MW_COLOR: Record<string, string> = MW_BRAND_COLOR

// 中间件一句话描述（产品卡片副标题）
const MW_DESC: Record<string, string> = {
  nginx: '高性能 Web 服务器 / 反向代理 1.28.3',
  jdk: 'Java 运行环境 JDK 8u481（X86 / ARM）',
  redis: 'Redis 5.0.14 单机缓存（端口 17000）',
  mysql: '关系型数据库服务（暂无离线脚本）',
  php: 'PHP-FPM 运行环境（7.2.34 / 7.4.33）',
  宝兰德bws310: '国产企业级应用服务器 BWS310',
}

// 系统初始化分组由后端目录（SysInitCatalog）驱动，见 initGrouped（按 group 聚合，保持目录顺序）。
// 目录可在「系统初始化管理」页面自定义增删，新增项会自动出现在本向导。

export default function MiddlewareDeploy() {
  const { hasPerm } = useAuth()
  const { message } = App.useApp()

  // 按钮权限码按后端端点收口：向导里的「部署对象」（已选中间件、手动目标）增删改 → deploy:create/update/delete；
  // 上传证书走 POST /deploy/certs，后端按 cert:create 收口，故单独用 cert:create。

  // 目录 / 注册中心
  const [catalog, setCatalog] = useState<MiddlewareDef[]>([])
  const [deployBase, setDeployBase] = useState('')
  const [loading, setLoading] = useState(true)

  // 主中间件（可选；为空表示不安装任何中间件，仅执行系统初始化）
  // 已选中间件列表：每项各自携带版本 / 部署模式 / 证书配置（首个为主中间件）
  const [mwItems, setMwItems] = useState<MwItem[]>([])
  // 当前正在配置（点击卡片后展开配置面板）的中间件项
  const [editing, setEditing] = useState<MwItem | null>(null)

  // 控制节点（Ansible 节点，仅用于按网络区域自动分配展示）
  const [remotes, setRemotes] = useState<RemoteNode[]>([])

  // 分类与资产选择
  const [cats, setCats] = useState<CatNode[]>([])
  const [cat, setCat] = useState<number | undefined>()
  const [catConfirmed, setCatConfirmed] = useState(false)
  const [kw, setKw] = useState('')
  const [assets, setAssets] = useState<Asset[]>([])
  const [assetTotal, setAssetTotal] = useState(0)
  const [activeProject, setActiveProject] = useState<number | undefined>()
  const [assetPage, setAssetPage] = useState(1)
  const [assetLoading, setAssetLoading] = useState(false)
  // 资产视图：recent = 最近导入（默认，无需选分类）；category = 按资产分类定位
  const [assetView, setAssetView] = useState<'recent' | 'category'>('recent')

  // 已选目标（跨分类/分页保留）
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [selectedMap, setSelectedMap] = useState<Record<number, Asset>>({})
  const [detection, setDetection] = useState<Record<number, DeployTarget>>({})
  const [detecting, setDetecting] = useState(false)

  // 部署配置（证书库 + 角色拓扑；版本/模式随 mwItems 每项保存）
  const [certs, setCerts] = useState<DeployCert[]>([])
  const [certModal, setCertModal] = useState(false)
  const [certSubmitting, setCertSubmitting] = useState(false)

  // 部署模式角色映射（roles 模式）
  const [topology, setTopology] = useState<Record<number, string>>({})

  // 任务
  const [job, setJob] = useState<DeployJob | null>(null)
  const [running, setRunning] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const logEndRef = useRef<HTMLDivElement | null>(null)
  const pollRef = useRef<number | null>(null)

  // 系统初始化（部署第一步，可跳过）
  const [initOptions, setInitOptions] = useState<SysInitOptions | null>(null)
  const [initTasks, setInitTasks] = useState<string[]>([])
  // 初始化环境自动识别结果（资产优先 → 后台探测）
  const [initEnv, setInitEnv] = useState<{ targets: SysInitEnvTarget[]; zones: SysInitEnvZone[]; unsupported: string[] } | null>(null)
  const [initDetecting, setInitDetecting] = useState(false)
  const [phase, setPhase] = useState<'none' | 'init' | 'deploy'>('none')
  // Ansible 接入方式：platform=平台自建临时 inventory（默认）；group=复用 Jenkins 的 ansible_host_manager.py 组
  const [invMode, setInvMode] = useState<'platform' | 'group'>('platform')

  // 服务器来源：asset=从资产管理中选（默认）；manual=手动输入（不走资产管理，走相同部署链路）
  const [targetSource, setTargetSource] = useState<'asset' | 'manual'>('asset')
  // 手动输入条目（id 负数）；selectedMap/selectedIds/detection/topology 同步复用
  const [manualEntries, setManualEntries] = useState<ManualEntry[]>([])
  const [manualModalOpen, setManualModalOpen] = useState(false)
  const [manualForm] = Form.useForm<ManualEntry>()

  // ---- 从已选中间件列表派生（首个=主中间件，其余=附加组件）----
  const mainItem = mwItems[0]
  const mainMw = mainItem?.type || ''
  const extraMw = useMemo(() => mwItems.slice(1).map((i) => i.type), [mwItems])
  const version = mainItem?.version || ''
  const mode = mainItem?.mode || ''
  const hasCert = !!mainItem?.hasCert
  const certId = mainItem?.certId
  const certName = mainItem?.certName || ''

  const mainDef = useMemo(() => catalog.find((m) => m.type === mainMw), [catalog, mainMw])
  const modeDef = useMemo(() => mainDef?.modes?.find((m) => m.key === mode), [mainDef, mode])
  const treeData = useMemo(() => toTreeData(cats), [cats])

  const mwItemByType = useMemo(() => {
    const m: Record<string, MwItem> = {}
    mwItems.forEach((i) => (m[i.type] = i))
    return m
  }, [mwItems])

  // 在分类树中按 id 查找节点（递归子节点）
  const findCat = (nodes: CatNode[], id?: number): CatNode | undefined => {
    if (id == null) return undefined
    for (const n of nodes) {
      if (n.id === id) return n
      if (n.children) {
        const f = findCat(n.children, id)
        if (f) return f
      }
    }
    return undefined
  }

  // 当前所选分类（部门）下的「业务项目」（子分类）
  const childProjects = useMemo(() => {
    if (!catConfirmed || cat == null) return []
    const node = findCat(cats, cat)
    return node?.children || []
  }, [catConfirmed, cat, cats])

  const supportedCount = useMemo(
    () => selectedIds.filter((id) => detection[id]?.supported).length,
    [selectedIds, detection],
  )

  const selectedTargets = useMemo(
    () => selectedIds.map((id) => selectedMap[id]).filter(Boolean),
    [selectedIds, selectedMap],
  )

  // 执行节点按「网络区域」映射
  const nodeByZone = useMemo(() => {
    const m: Record<string, RemoteNode> = {}
    remotes.forEach((r) => {
      if (r.networkZone) m[r.networkZone] = r
    })
    return m
  }, [remotes])

  // 节点自动分配：按所选目标的「所属网络区域」分组，匹配控制节点
  const { zoneGroups, missingZone, missingNodeZones } = useMemo(() => {
    const groups: Record<string, DeployTarget[]> = {}
    const mz: string[] = []
    const mnz = new Set<string>()
    selectedTargets.forEach((t) => {
      const d = detection[t.id]
      const zone = d?.networkZone || ''
      if (!zone) {
        mz.push(t.name)
        return
      }
      if (!nodeByZone[zone]) mnz.add(zone)
      ;(groups[zone] ||= []).push(d as DeployTarget)
    })
    return { zoneGroups: groups, missingZone: mz, missingNodeZones: Array.from(mnz) }
  }, [selectedTargets, detection, nodeByZone])

  const nodesResolved = missingZone.length === 0 && missingNodeZones.length === 0

  // 当前流程步骤（公有云向导式进度）
  const current = useMemo(() => {
    if (selectedIds.length && nodesResolved) return 4
    if (selectedIds.length && Object.keys(detection).length) return 3
    if (selectedIds.length) return 2
    if (mainMw) return 1
    return 0
  }, [mainMw, selectedIds, detection, nodesResolved])

  // 是否可点击「开始」：初始化与中间件至少选其一，且节点已正确分配；选了中间件还需有可部署目标
  const hasMwNow = !!mainMw
  const canStart =
    (initTasks.length > 0 || hasMwNow) &&
    nodesResolved &&
    (!hasMwNow || supportedCount > 0)

  // 初始化加载
  useEffect(() => {
    ;(async () => {
      try {
        const [catR, remR] = await Promise.all([
          api.get('/categories'),
          api.get('/ansible/remotes'),
        ])
        setCats(catR.data.data || [])
        setRemotes(
          (remR.data.data?.list || []).map((r: any) => ({
            id: r.id,
            name: r.name,
            host: r.host,
            networkZone: r.networkZone || '',
            status: r.status,
            description: r.description,
          })),
        )
        const c = await getDeployCatalog()
        setCatalog(c.middlewares)
        setDeployBase(c.deployBase)
        const cs = await listDeployCerts()
        setCerts(cs)
        sysinitOptions()
          .then(setInitOptions)
          .catch(() => {})
      } catch {
        message.error('加载部署数据失败')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // 资产查询（按项目/分类定位，关键字检索；不再以环境/业务环境作为筛选条件）
  const loadAssets = async (p = 1, keyword = kw, category?: number) => {
    setAssetLoading(true)
    try {
      const r = await api.get('/assets', {
        params: {
          page: p,
          size: 10,
          keyword,
          categoryId: category,
        },
      })
      setAssets(r.data.data.list || [])
      setAssetTotal(r.data.data.total || 0)
      setAssetPage(p)
    } finally {
      setAssetLoading(false)
    }
  }

  // 最近导入：按 id 倒序取最新资产（不受分类树限制），便于新导入资产后快速选机安装
  const loadRecentAssets = async (p = 1, keyword = kw) => {
    setAssetLoading(true)
    try {
      const r = await api.get('/assets', {
        params: {
          page: p,
          size: 10,
          keyword,
          sortField: 'id',
          sortOrder: 'desc',
        },
      })
      setAssets(r.data.data.list || [])
      setAssetTotal(r.data.data.total || 0)
      setAssetPage(p)
    } finally {
      setAssetLoading(false)
    }
  }

  // 切换资产视图（最近导入 / 按分类）
  const switchAssetView = (v: 'recent' | 'category') => {
    setAssetView(v)
    setAssetPage(1)
    if (v === 'recent') {
      setCatConfirmed(false)
      setActiveProject(undefined)
      loadRecentAssets(1, kw)
    } else {
      setAssets([])
      setAssetTotal(0)
    }
  }

  // 首次进入即展示「最近导入」资产清单（新导入资产后可直接勾选安装中间件）
  useEffect(() => {
    loadRecentAssets(1, '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 确认分类后仅展示「业务项目」列表，不直接展开全部服务器
  const confirmCat = () => {
    setCatConfirmed(true)
    const node = findCat(cats, cat)
    const kids = node?.children || []
    if (kids.length === 0 && cat != null) {
      // 所选分类已是叶子项目，直接加载其服务器
      setActiveProject(cat)
      loadAssets(1, kw, cat)
    } else {
      setActiveProject(undefined)
      setAssets([])
      setAssetTotal(0)
      setAssetPage(1)
    }
  }

  // 选择具体业务项目后，展示该项目下服务器（含 IP / 环境 / 业务环境 / 用途）
  const selectProject = (pid: number) => {
    setActiveProject(pid)
    loadAssets(1, kw, pid)
  }

  // 选中变化 → 识别 OS/CPU
  // 资产目标（id>0）走后端 detectTargets；手动目标（id<0）的检测结果在添加时已合成，
  // 这里只刷新资产部分，避免后端查不到负 id 报错。
  useEffect(() => {
    if (selectedIds.length === 0) {
      setDetection({})
      return
    }
    const assetIds = selectedIds.filter((id) => id > 0)
    let cancelled = false
    setDetecting(true)
    if (assetIds.length === 0) {
      // 全部是手动目标：保留现有 detection（手动条目已合成）并结束
      setDetecting(false)
      return
    }
    detectTargets(assetIds, mainMw)
      .then((ts) => {
        if (cancelled) return
        const map: Record<number, DeployTarget> = {}
        ts.forEach((t) => (map[t.id] = t))
        // 合并：保留手动目标的合成 detection；资产目标用最新值覆盖
        setDetection((prev) => {
          const next = { ...prev }
          Object.keys(next).forEach((k) => {
            const id = Number(k)
            if (id > 0) delete next[id]
          })
          Object.assign(next, map)
          return next
        })
      })
      .catch(() => message.error('识别目标失败'))
      .finally(() => !cancelled && setDetecting(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds.join(','), mainMw])

  // 任务轮询：由 startDeploy 中的 pollJob 统一管理（初始化阶段 + 部署阶段）

  // 日志面板自动滚动到底部
  useEffect(() => {
    if (logOpen && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logOpen, job?.output])

  const onRowSelect = (keys: number[], rows: Asset[]) => {
    const map = { ...selectedMap }
    rows.forEach((r) => (map[r.id] = r))
    const set = new Set(keys)
    Object.keys(map).forEach((k) => {
      if (!set.has(Number(k))) delete map[Number(k)]
    })
    setSelectedMap(map)
    setSelectedIds(keys)
  }

  // 系统初始化环境自动识别（仅当选了初始化项时）：资产优先 → 后台探测
  useEffect(() => {
    if (initTasks.length === 0 || selectedIds.length === 0) {
      setInitEnv(null)
      return
    }
    const assetIds = selectedIds.filter((id) => id > 0)
    // 手动目标按其表单字段（osType/cpuType/zone）合成 SysInitEnvTarget
    const manualTargets: SysInitEnvTarget[] = selectedIds
      .filter((id) => id < 0)
      .map((id) => {
        const e = manualEntries.find((x) => x.id === id)
        // 在移除等边界情况下 e 可能不存在，视为不支持
        if (!e) {
          return {
            id,
            name: String(id),
            ip: '',
            zone: '',
            osType: '',
            cpuType: '',
            osSource: 'unknown' as const,
            cpuSource: 'unknown' as const,
          }
        }
        return {
          id,
          name: e.ip,
          ip: e.ip,
          zone: e.zone,
          osType: e.osType,
          cpuType: e.cpuType,
          osSource: 'asset' as const, // 用户显式指定
          cpuSource: 'asset' as const,
        }
      })
    let cancelled = false
    setInitDetecting(true)
    const finish = (zoneRes: { targets: SysInitEnvTarget[]; zones: SysInitEnvZone[]; unsupported: string[] } | null) => {
      if (cancelled) return
      if (!zoneRes) {
        setInitEnv(null)
      } else {
        setInitEnv({
          targets: [...zoneRes.targets, ...manualTargets],
          zones: zoneRes.zones,
          unsupported: zoneRes.unsupported,
        })
      }
    }
    if (assetIds.length === 0) {
      // 全部手动：按区域聚合为 zones
      const byZone: Record<string, SysInitEnvZone> = {}
      manualTargets.forEach((t) => {
        if (!t.zone) return
        const cur = byZone[t.zone] || {
          zone: t.zone,
          osType: t.osType,
          cpuType: t.cpuType,
          osSource: t.osSource,
          cpuSource: t.cpuSource,
        }
        // 区域内 mixed 时 osType/cpuType 不聚合（与后端语义一致）
        if (cur.osType && cur.osType !== t.osType) cur.osType = ''
        if (cur.cpuType && cur.cpuType !== t.cpuType) cur.cpuType = ''
        byZone[t.zone] = cur
      })
      finish({
        targets: manualTargets,
        zones: Object.values(byZone),
        unsupported: manualTargets.filter((t) => !t.zone).map((t) => `${t.name}(缺网络区域)`),
      })
      setInitDetecting(false)
      return
    }
    detectSysInitEnv(assetIds)
      .then((r) => finish(r))
      .catch(() => finish(null))
      .finally(() => {
        if (!cancelled) setInitDetecting(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initTasks.join(','), selectedIds.join(','), manualEntries.length])

  const srcTag = (s: string) => {
    switch (s) {
      case 'asset':
        return <Tag color="green">资产</Tag>
      case 'detected':
        return <Tag color="blue">探测</Tag>
      default:
        return <Tag>未知</Tag>
    }
  }

  const zoneCount = Object.keys(zoneGroups).filter((z) => nodeByZone[z]).length

  // 通用任务轮询：终态时 resolve 返回最终 job
  const pollJob = (
    id: number,
    fetcher: (id: number) => Promise<any>,
    onUpdate: (j: any) => void,
  ): Promise<any> =>
    new Promise((resolve) => {
      const tick = async () => {
        try {
          const j = await fetcher(id)
          onUpdate(j)
          if (j.status !== 'running' && j.status !== 'pending') {
            if (pollRef.current) window.clearInterval(pollRef.current)
            pollRef.current = null
            resolve(j)
          }
        } catch {
          if (pollRef.current) window.clearInterval(pollRef.current)
          pollRef.current = null
          resolve(null)
        }
      }
      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = window.setInterval(tick, 1500)
      tick()
    })

  // 提交：先执行系统初始化（若勾选），再部署中间件（若选择）
  // 系统初始化与中间件均为可选项，可仅执行其一或两者皆选
  const startDeploy = async () => {
    const hasInit = initTasks.length > 0
    const hasMw = !!mainMw
    if (!hasInit && !hasMw) {
      message.warning('请选择要执行的内容：系统初始化项，和/或要安装的中间件')
      return
    }
    // 节点分配校验（系统初始化与中间件部署都依赖按网络区域自动分配执行节点）
    if (missingZone.length > 0) {
      message.error('部分服务器未填写「所属网络区域」，无法分配执行节点，请先在资产管理列表录入')
      return
    }
    if (missingNodeZones.length > 0) {
      message.error(`网络区域「${missingNodeZones.join('、')}」未配置执行节点，请在 Ansible 节点管理添加`)
      return
    }

    let supported: number[] = []
    if (hasMw) {
      if (!mainDef || !mainDef.ready) {
        message.error('请选择已就绪的中间件')
        return
      }
      if (!version) {
        message.error('请选择版本')
        return
      }
      supported = selectedIds.filter((id) => detection[id]?.supported)
      if (supported.length === 0) {
        message.error('没有可用的目标服务器（请确认操作系统/CPU 已被离线包支持）')
        return
      }
      // 部署模式校验（集群需满足节点数；角色模式需为每台指定角色且满足最小主/哨兵数）
      if (modeDef) {
        if (!mode) {
          message.error('请选择部署模式')
          return
        }
        if (modeDef.topology === 'cluster') {
          if (supported.length !== modeDef.nodeCount) {
            message.error(`集群模式需选择 ${modeDef.nodeCount} 台服务器，当前已选 ${supported.length} 台可部署节点`)
            return
          }
        }
        if (modeDef.topology === 'roles') {
          const withRole = supported.filter((id) => topology[id])
          if (withRole.length !== supported.length) {
            message.error('请为每台节点指定部署角色')
            return
          }
          const masterCnt = supported.filter((id) => topology[id] === 'master').length
          const sentinelCnt = supported.filter((id) => topology[id] === 'sentinel').length
          if (masterCnt < 1) {
            message.error('至少需要 1 个 master 节点')
            return
          }
          if (sentinelCnt < 3) {
            message.error('哨兵模式至少需要 3 个 sentinel 节点（保证 quorum）')
            return
          }
        }
      }
      // 逐项校验证书：每个开启了证书的中间件都必须绑定一张证书
      const missingCert = mwItems.find((it) => it.hasCert && !it.certId)
      if (missingCert) {
        const md = catalog.find((m) => m.type === missingCert.type)
        message.error(`${md?.label || missingCert.type} 已开启证书，请选择或上传证书`)
        return
      }
    }

    setRunning(true)
    setLogOpen(true)

    // 拆分资产 id 与手动输入条目，便于两个阶段都正确下发
    const assetIdList = selectedIds.filter((id) => id > 0)
    const manualTopology: Record<string, string> = {}
    const manualTargets: ManualTargetPayload[] = manualEntries.map((e) => {
      // roles 模式：把「id -> role」改写为「IP -> role」（后端按 IP 查 ManualTopology）
      const role = topology[e.id]
      if (role) manualTopology[e.ip] = role
      return {
        id: e.id,
        name: e.ip,
        ip: e.ip,
        osType: e.osType,
        cpuType: e.cpuType,
        port: e.port,
        user: e.user,
        pass: e.pass,
        become: e.become,
        becomePass: e.becomePass,
        zone: e.zone,
      }
    })

    // 第一步（可选）：系统初始化
    if (hasInit) {
      try {
        setPhase('init')
        const res = await createSysInit({
          tasks: initTasks,
          assetIds: assetIdList,
          manualTargets,
          osType: '',
          cpuType: '',
          inventoryMode: invMode,
        })
        message.success('系统初始化任务已下发，执行中…')
        const ok = await pollJob(res.id, getSysInitJob, (j) =>
          setJob({ id: res.id, status: j.status, output: j.output } as DeployJob),
        )
        if (!ok || ok.status === 'failed') {
          setRunning(false)
          setPhase('none')
          message.error('系统初始化失败，已终止后续操作：' + (ok?.errorMsg || ''))
          return
        }
        message.success('系统初始化完成' + (hasMw ? '，继续部署中间件…' : ''))
      } catch (e: any) {
        setRunning(false)
        setPhase('none')
        message.error(e?.response?.data?.msg || '初始化下发失败')
        return
      }
    }

    // 第二步（可选）：中间件部署
    if (hasMw) {
      setPhase('deploy')
      try {
        // asset topology 仅保留资产 id 部分（手动 id 由 manualTopology 处理）
        const assetTopology: Record<number, string> = {}
        if (modeDef?.topology === 'roles') {
          assetIdList.forEach((id) => {
            const r = topology[id]
            if (r) assetTopology[id] = r
          })
        }
        const r = await deployRun({
          middleware: mainMw,
          version,
          mode: mode || undefined,
          topology: modeDef?.topology === 'roles' ? assetTopology : undefined,
          hasCert,
          certId,
          certName: hasCert ? certName : '',
          assetIds: supported.filter((id) => id > 0),
          manualTargets: manualTargets.filter((m) =>
            supported.some((id) => id === m.id),
          ),
          manualTopology: modeDef?.topology === 'roles' ? manualTopology : undefined,
          extraMw,
          // 每个中间件各自的版本/模式/证书配置（后端优先使用）
          items: mwItems.map((it) => ({
            middleware: it.type,
            version: it.version,
            mode: it.mode,
            hasCert: it.hasCert,
            certId: it.hasCert ? it.certId : undefined,
            certName: it.hasCert ? it.certName : '',
          })),
          inventoryMode: invMode,
        })
        const dj = await pollJob(r.jobId, getDeployJob, setJob)
        setRunning(false)
        setPhase('none')
        if (dj?.status === 'success') message.success('部署完成')
        else message.error('部署失败，请查看输出')
      } catch (e: any) {
        setRunning(false)
        setPhase('none')
        message.error(e?.response?.data?.msg || '下发失败')
      }
    } else {
      setRunning(false)
      setPhase('none')
      if (!hasInit) message.success('已完成')
    }
  }

  // 证书提交
  const [certForm] = Form.useForm()
  const submitCert = async () => {
    const v = await certForm.validateFields()
    setCertSubmitting(true)
    try {
      await createDeployCert(v)
      message.success('证书已保存')
      setCertModal(false)
      certForm.resetFields()
      const cs = await listDeployCerts()
      setCerts(cs)
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '保存失败')
    } finally {
      setCertSubmitting(false)
    }
  }

  // 打开某中间件的配置面板（已在列表中的则回填其现有配置，便于修改）
  const openConfig = (m: MiddlewareDef) => {
    if (!m.ready) {
      message.warning(`${m.label} 离线包尚未就绪，请将安装包放到控制节点后启用`)
      return
    }
    const exist = mwItemByType[m.type]
    if (exist) {
      setEditing({ ...exist })
      return
    }
    setEditing({
      type: m.type,
      version: m.versions[0] || '',
      mode: m.modes?.[0]?.key || '',
      hasCert: false,
      certId: undefined,
      certName: '',
    })
  }

  // 确认添加 / 保存修改：写入已选列表（保持原有顺序，新项追加在末尾）
  const confirmConfig = () => {
    if (!editing) return
    const def = catalog.find((m) => m.type === editing.type)
    if (def?.versions?.length && !editing.version) {
      message.warning('请选择版本')
      return
    }
    if (def?.modes?.length && !editing.mode) {
      message.warning('请选择部署模式')
      return
    }
    if (editing.hasCert && !editing.certId) {
      message.warning('已开启证书，请选择证书')
      return
    }
    setMwItems((prev) => {
      const idx = prev.findIndex((i) => i.type === editing.type)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...editing }
        return next
      }
      return [...prev, { ...editing }]
    })
    message.success(
      `${def?.label || editing.type} 已${mwItemByType[editing.type] ? '更新' : '添加'}`,
    )
    setEditing(null)
  }

  // 从已选列表移除
  const removeMw = (type: string) => {
    setMwItems((prev) => prev.filter((i) => i.type !== type))
    setEditing((e) => (e?.type === type ? null : e))
    setTopology({})
  }

  // 为手动条目生成负 id：与资产 id 互斥；同毫秒多次添加用 -1, -2 区分
  const manualSeqRef = useRef(0)
  // 把手动条目同步进 selectedIds/selectedMap/detection（与资产走同一管线：04 识别、05 节点分配、06 角色）
  const syncManualIntoSelection = (entries: ManualEntry[]) => {
    const map = { ...selectedMap }
    const det = { ...detection }
    const ids: number[] = []
    const topo = { ...topology }
    entries.forEach((e) => {
      map[e.id] = {
        id: e.id,
        categoryId: 0,
        name: e.ip,
        ip: e.ip,
        displayName: e.ip,
        fields: {
          SSH端口: e.port,
          用户名: e.user,
          密码: e.pass,
          超级管理员用户: e.become,
          超级管理员用户密码: e.becomePass,
          所属网络区域: e.zone,
          操作系统版本: e.osType,
          CPU类型: e.cpuType,
          用途: e.remark || '',
        },
        createdAt: '',
        updatedAt: '',
      }
      det[e.id] = {
        id: e.id,
        name: e.ip,
        ip: e.ip,
        osRaw: e.osType,
        cpuRaw: e.cpuType,
        osType: e.osType,
        cpuType: e.cpuType,
        networkZone: e.zone,
        // OS/CPU/zone 在表单内已限定为合法令牌，离线包存在性由后端 GetPkg 校验
        supported: true,
        reason: '',
        hasCertField: false,
      }
      ids.push(e.id)
      // 清除该 id 的旧 topology 残留（用户重填时不会带到新目标）
      delete topo[e.id]
    })
    // 把所有手动 id 加入 selectedIds；selectedIds 中已有的资产 id 保留
    const existingAssetIds = selectedIds.filter((id) => id > 0)
    setSelectedMap(map)
    setDetection(det)
    setTopology(topo)
    setSelectedIds([...existingAssetIds, ...ids])
  }

  // 打开手动输入弹窗（每次重置表单）
  const openManualModal = () => {
    manualForm.resetFields()
    setManualModalOpen(true)
  }

  // 提交手动条目：IP 字段支持一次录入多台（逗号 / 空格 / 换行 / 分号分隔），
  // 除 IP 外其余字段本批共用。每台 IP 生成一条 ManualEntry。
  const submitManual = async () => {
    let v: ManualEntry
    try {
      v = await manualForm.validateFields()
    } catch {
      return
    }
    // 解析多 IP
    const rawIps = String(v.ip || '')
      .split(/[\s,;，；]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (rawIps.length === 0) {
      message.error('请输入至少一个 IP')
      return
    }
    // 批次内去重
    const seen = new Set<string>()
    const uniqueIps: string[] = []
    for (const ip of rawIps) {
      if (seen.has(ip)) continue
      seen.add(ip)
      uniqueIps.push(ip)
    }
    // 与已选（资产 / 手动）冲突检测
    const conflicts: string[] = []
    for (const ip of uniqueIps) {
      const dupAsset = Object.values(selectedMap).some((a) => a && a.ip === ip && a.id > 0)
      const dupManual = manualEntries.some((e) => e.ip === ip)
      if (dupAsset || dupManual) conflicts.push(ip)
    }
    if (conflicts.length) {
      message.error(`IP ${conflicts.join('、')} 已在当前选中列表中（资产或手动），请勿重复添加`)
      return
    }
    // 每台 IP 生成一条条目；负 id 互斥（批次内用 idx 区分）
    manualSeqRef.current += uniqueIps.length
    const base = Date.now()
    const newEntries: ManualEntry[] = uniqueIps.map((ip, idx) => ({
      id: -1 * (base + idx),
      ip,
      port: v.port != null && v.port !== '' ? String(v.port) : '65181',
      user: v.user || 'centos',
      pass: v.pass,
      become: v.become || 'root',
      becomePass: v.becomePass,
      zone: v.zone,
      osType: v.osType,
      cpuType: v.cpuType,
      remark: v.remark || '',
    }))
    const next = [...manualEntries, ...newEntries]
    setManualEntries(next)
    syncManualIntoSelection(next)
    setManualModalOpen(false)
    manualForm.resetFields()
    message.success(
      uniqueIps.length === 1
        ? `已添加手动目标：${uniqueIps[0]}`
        : `已添加 ${uniqueIps.length} 台手动目标：${uniqueIps.join('、')}`,
    )
  }

  // 删除一条手动条目
  const removeManual = (id: number) => {
    const next = manualEntries.filter((e) => e.id !== id)
    setManualEntries(next)
    // 从 selectedIds/selectedMap/detection/topology 中清除
    setSelectedIds((ids) => ids.filter((i) => i !== id))
    setSelectedMap((m) => {
      const c = { ...m }
      delete c[id]
      return c
    })
    setDetection((d) => {
      const c = { ...d }
      delete c[id]
      return c
    })
    setTopology((t) => {
      const c = { ...t }
      delete c[id]
      return c
    })
  }

  // 设为主中间件（主项决定版本/模式/证书等向导校验）
  const setAsMain = (type: string) => {
    setMwItems((prev) => {
      const idx = prev.findIndex((i) => i.type === type)
      if (idx <= 0) return prev
      const next = [...prev]
      const [it] = next.splice(idx, 1)
      return [it, ...next]
    })
    setTopology({})
  }

  const toggleInit = (key: string, checked: boolean) => {
    setInitTasks((prev) =>
      checked ? [...new Set([...prev, key])] : prev.filter((k) => k !== key),
    )
  }

  // 系统初始化项按目录分组聚合（组顺序 = 目录首次出现顺序）
  const initGrouped = useMemo(() => {
    const out: { title: string; tasks: SysInitTaskOption[] }[] = []
    for (const t of initOptions?.tasks || []) {
      const title = t.group || '其他'
      let g = out.find((x) => x.title === title)
      if (!g) {
        g = { title, tasks: [] }
        out.push(g)
      }
      g.tasks.push(t)
    }
    return out
  }, [initOptions])

  const targetColumns = useMemo(() => {
    const base: any[] = [
      {
      title: '名称',
      dataIndex: 'displayName',
      key: 'displayName',
      // 统一展示名（后端由 fields 派生），资产改字段后这里会跟着变
      render: (v: string, r: Asset) => v || r.name,
    },
      {
        title: 'IP',
        dataIndex: 'ip',
        key: 'ip',
        render: (ip: string) => ip || <Text type="danger">无</Text>,
      },
      {
        title: '网络区域',
        key: 'zone',
        render: (_: any, r: Asset) => {
          const z = detection[r.id]?.networkZone
          return z ? (
            <Tag color="geekblue">{z}</Tag>
          ) : (
            <Tag color="warning">未填写</Tag>
          )
        },
      },
      {
        title: '操作系统',
        key: 'os',
        render: (_: any, r: Asset) => {
          const d = detection[r.id]
          return (
            <Space direction="vertical" size={0}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {d?.osRaw || r.fields?.['操作系统版本'] || '-'}
              </Text>
              <Tag color={d?.osType ? 'blue' : 'default'}>{d?.osType || '未识别'}</Tag>
            </Space>
          )
        },
      },
      {
        title: 'CPU',
        key: 'cpu',
        render: (_: any, r: Asset) => {
          const d = detection[r.id]
          return (
            <Space direction="vertical" size={0}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {d?.cpuRaw || r.fields?.['CPU类型'] || '-'}
              </Text>
              <Tag color={d?.cpuType ? 'geekblue' : 'default'}>{d?.cpuType || '未识别'}</Tag>
            </Space>
          )
        },
      },
      {
        title: '状态',
        key: 'status',
        render: (_: any, r: Asset) => {
          const d = detection[r.id]
          if (!d) return <Spin size="small" />
          if (d.supported)
            return (
              <Tag icon={<CheckCircleTwoTone twoToneColor="#16a34a" />} color="success">
                可部署
              </Tag>
            )
          return (
            <Tooltip title={d.reason}>
              <Tag icon={<CloseCircleTwoTone twoToneColor="#dc2626" />} color="error">
                不支持
              </Tag>
            </Tooltip>
          )
        },
      },
    ]
    if (modeDef?.topology === 'roles') {
      base.push({
        title: '角色',
        key: 'role',
        render: (_: any, r: Asset) => (
          <Select
            size="small"
            style={{ width: 140 }}
            placeholder="选择角色"
            value={topology[r.id] || undefined}
            onChange={(v) => setTopology((t) => ({ ...t, [r.id]: v }))}
            options={(modeDef.roles || []).map((role) => ({ value: role, label: role }))}
          />
        ),
      })
    }
    return base
  }, [detection, modeDef, topology])

  const assetColumns = [
    {
      title: '名称',
      dataIndex: 'displayName',
      key: 'displayName',
      // 统一展示名（后端由 fields 派生），资产改字段后这里会跟着变
      render: (v: string, r: Asset) => v || r.name,
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      key: 'ip',
      render: (ip: string) => ip || <Text type="danger">无</Text>,
    },
    {
      title: '环境',
      key: 'env',
      render: (_: any, r: Asset) =>
        r.fields?.['环境'] ? (
          <Tag color="blue">{r.fields['环境']}</Tag>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '业务环境',
      key: 'be',
      render: (_: any, r: Asset) =>
        r.fields?.['业务环境'] ? (
          <Tag color="geekblue">{r.fields['业务环境']}</Tag>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '用途',
      key: 'usage',
      render: (_: any, r: Asset) => r.fields?.['用途'] || <Text type="secondary">—</Text>,
    },
    {
      title: '网络区域',
      key: 'zone',
      render: (_: any, r: Asset) =>
        r.fields?.['所属网络区域'] ? (
          <Tag color="geekblue">{r.fields['所属网络区域']}</Tag>
        ) : (
          <Text type="warning">未填写</Text>
        ),
    },
    {
      title: '导入时间',
      key: 'createdAt',
      width: 160,
      render: (_: any, r: Asset) =>
        r.createdAt ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {fmtTime(r.createdAt)}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
  ]

  const stepItems = [
    { title: '系统初始化', icon: <ThunderboltOutlined /> },
    { title: '选择部署中间件', icon: <AppstoreOutlined /> },
    { title: '选择服务器', icon: <CloudServerOutlined /> },
    { title: '目标识别', icon: <AimOutlined /> },
    { title: '节点分配', icon: <NodeIndexOutlined /> },
    { title: '执行部署', icon: <RocketOutlined /> },
  ]

  const readyCount = catalog.filter((c) => c.ready).length

  return (
    <div className="mw-root">
      {/* ===== Hero 头部 ===== */}
      <div className="mw-hero glass fade-up">
        <div className="mw-hero__glow" />
        <div className="mw-hero__mesh" />
        <div className="mw-hero__main">
          <div className="mw-hero__title">
            <ApiOutlined />
            应用中间件安装
          </div>
          <div className="mw-hero__desc">
            离线环境一键部署：选择中间件与服务器，系统自动识别操作系统 / CPU 架构，并依据资产「所属网络区域」
            智能匹配对应的 Ansible 控制节点执行离线安装。全流程向导式引导，像公有云控制台一样简单。
          </div>
        </div>
        <div className="mw-hero__chips">
          <div className="mw-chip">
            <div className="mw-chip__v">{catalog.length}</div>
            <div className="mw-chip__l">已接入中间件</div>
          </div>
          <div className="mw-chip">
            <div className="mw-chip__v">{readyCount}</div>
            <div className="mw-chip__l">离线包就绪</div>
          </div>
          <div className="mw-chip">
            <div className="mw-chip__v" style={{ fontSize: 17 }}>
              私有化
            </div>
            <div className="mw-chip__l">离线部署</div>
          </div>
        </div>
      </div>

      {/* ===== 流程步骤条 ===== */}
      <div className="mw-step-wrap glass">
        <Steps current={current} items={stepItems} responsive />
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : (
        <>
          {/* ===== 01 系统初始化 ===== */}
          <section className="mw-section">
            <div className="mw-section-title">
              <span className="mw-section-idx">01</span>
              <span className="mw-section-h">系统初始化</span>
              <span className="mw-section-d">
                部署中间件前可先对目标服务器执行标准化初始化（可跳过，无需初始化则留空即可）
              </span>
            </div>
            <div className="glass mw-panel">
              {initOptions && (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="Playbook 根目录"
                  description={
                    <span>
                      控制节点路径：<Text code>{initOptions.systemInitDir}</Text>（可在 docker-compose 环境变量{' '}
                      <Text code>SYSTEM_INIT_DIR</Text> 中调整）
                    </span>
                  }
                />
              )}
              <Paragraph type="secondary" style={{ marginBottom: 12 }}>
                勾选需要执行的初始化项：已选{' '}
                <Text strong style={{ color: 'var(--accent)' }}>
                  {initTasks.length}
                </Text>{' '}
                项。这些操作将在最后「执行部署」步骤中对所选服务器依次执行。
              </Paragraph>
              {initTasks.length > 0 &&
                (initDetecting ? (
                  <Space style={{ marginBottom: 12 }}>
                    <Spin size="small" />
                    <Text type="secondary">正在识别操作系统 / CPU…</Text>
                  </Space>
                ) : initEnv && initEnv.zones.length > 0 ? (
                  <div className="si-env" style={{ marginBottom: 12 }}>
                    {initEnv.zones.map((z) => (
                      <div className="si-env__row" key={z.zone}>
                        <Tag color="geekblue">{z.zone}</Tag>
                        <span className="si-env__kv">
                          OS: <b>{z.osType || '—'}</b> {srcTag(z.osSource)}
                        </span>
                        <span className="si-env__kv">
                          CPU: <b>{z.cpuType || '—'}</b> {srcTag(z.cpuSource)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null)}
              <div className="si-opt">
                {initGrouped.length === 0 && (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无可用初始化项，可在「系统初始化管理」中添加"
                  />
                )}
                {initGrouped.map((g) => (
                  <div key={g.title} className="si-opt__group">
                    <div className="si-opt__gtitle">
                      <PartitionOutlined /> {g.title}
                    </div>
                    {g.tasks.map((t) => {
                      const key = t.key
                      const checked = initTasks.includes(key)
                      return (
                        <label key={key} className={'si-opt__item' + (checked ? ' is-on' : '')}>
                          <Checkbox checked={checked} onChange={(e) => toggleInit(key, e.target.checked)} />
                          <div className="si-opt__meta">
                            <div className="si-opt__name">
                              {key}
                              {t.custom && (
                                <Tag color="cyan" style={{ marginLeft: 6 }}>
                                  自定义
                                </Tag>
                              )}
                            </div>
                            {t.desc && <div className="si-opt__desc">{t.desc}</div>}
                            <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {t.osTypes?.length ? (
                                t.osTypes.map((o) => (
                                  <Tag key={o} style={{ marginRight: 0 }}>
                                    {o}
                                  </Tag>
                                ))
                              ) : (
                                <Tag style={{ marginRight: 0 }}>全部 OS</Tag>
                              )}
                              {t.cpuTypes?.length ? (
                                t.cpuTypes.map((c) => (
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
                          </div>
                        </label>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ===== 02 选择部署中间件 ===== */}
          <section className="mw-section">
            <div className="mw-section-title">
              <span className="mw-section-idx">02</span>
              <span className="mw-section-h">选择部署中间件</span>
              <span className="mw-section-d">
                点击中间件 → 选择版本/模式/证书 → 确认添加；可重复操作添加多个（单选或多选）
              </span>
            </div>
            <div className="glass mw-panel">
              <div className="mw-grid">
                {catalog.map((m) => {
                  const picked = mwItemByType[m.type]
                  const active = !!picked
                  const isMain = mainMw === m.type
                  const color = MW_COLOR[m.type] || '#64748b'
                  const pickedModeLabel = m.modes?.find((x) => x.key === picked?.mode)?.label
                  const editingThis = editing?.type === m.type
                  return (
                    <div
                      key={m.type}
                      className={`mw-product ${active ? 'mw-product--active' : ''} ${
                        isMain ? 'mw-product--main' : ''
                      } ${editingThis ? 'mw-product--editing' : ''} ${
                        m.ready ? '' : 'mw-product--disabled'
                      }`}
                      onClick={() => openConfig(m)}
                    >
                      {active && <CheckCircleFilled className="mw-product__check" />}
                      {isMain && (
                        <div className="mw-product__corner">
                          <span className="mw-product__extra-tag">主</span>
                        </div>
                      )}
                      <div className="mw-product__badge" style={{ background: color }}>
                        <MwBrandIcon type={m.type} size={32} color="#fff" />
                      </div>
                      <div className="mw-product__name">{m.label}</div>
                      <div className="mw-product__desc">{MW_DESC[m.type] || '—'}</div>
                      <div className="mw-product__desc" style={{ fontSize: 11, opacity: 0.75 }}>
                        {m.installPath ? `${m.installPath}` : ''}
                        {m.installPath && m.defaultPort ? ' · ' : ''}
                        {m.defaultPort ? `端口 ${m.defaultPort}` : ''}
                      </div>
                      {active ? (
                        <div className="mw-product__picked">
                          <Tag color="blue" style={{ marginRight: 0 }}>
                            {picked.version || '默认版本'}
                          </Tag>
                          {pickedModeLabel && <Tag style={{ marginRight: 0 }}>{pickedModeLabel}</Tag>}
                          {picked.hasCert && (
                            <Tag color="geekblue" style={{ marginRight: 0 }}>
                              SSL
                            </Tag>
                          )}
                        </div>
                      ) : (
                        <div className="mw-product__meta">
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {m.versions.length ? m.versions.join(' / ') : '暂无版本'}
                          </Text>
                          {m.ready ? (
                            <Tag color="success" style={{ marginRight: 0 }}>
                              就绪
                            </Tag>
                          ) : (
                            <Tag style={{ marginRight: 0 }}>未就绪</Tag>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="mw-deploybase">
                部署基目录（控制节点）：<Text code>{deployBase}</Text>
              </div>

              {/* 配置面板：点击卡片后展开，确认后可继续点击下一个中间件 */}
              {editing &&
                (() => {
                  const def = catalog.find((m) => m.type === editing.type)
                  const existed = !!mwItemByType[editing.type]
                  const editorModes = def?.modes || []
                  return (
                    <div className="mw-config-panel">
                      <div className="mw-config-panel__head">
                        <div className="mw-config-panel__title">
                          <span
                            className="mw-config-panel__badge"
                            style={{ background: MW_COLOR[editing.type] || '#64748b' }}
                          >
                            <MwBrandIcon type={editing.type} size={18} color="#fff" />
                          </span>
                          配置 {def?.label || editing.type}
                          {def?.installPath && (
                            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                              {def.installPath}
                              {def.defaultPort ? ` · 端口 ${def.defaultPort}` : ''}
                            </Text>
                          )}
                        </div>
                        <Button
                          size="small"
                          type="text"
                          icon={<CloseOutlined />}
                          onClick={() => setEditing(null)}
                        />
                      </div>
                      <div className="mw-settings-row">
                        <div className="mw-settings-col">
                          <Text strong style={{ display: 'block', marginBottom: 6 }}>
                            版本
                          </Text>
                          <Select
                            style={{ width: '100%' }}
                            value={editing.version || undefined}
                            onChange={(v) => setEditing({ ...editing, version: v })}
                            placeholder="选择版本"
                            options={(def?.versions || []).map((v) => ({ value: v, label: v }))}
                            disabled={!def?.versions.length}
                          />
                        </div>
                        {editorModes.length > 0 && (
                          <div className="mw-settings-col">
                            <Text strong style={{ display: 'block', marginBottom: 6 }}>
                              部署模式
                            </Text>
                            <Select
                              style={{ width: '100%' }}
                              value={editing.mode || undefined}
                              onChange={(v) => setEditing({ ...editing, mode: v })}
                              placeholder="选择部署模式"
                              options={editorModes.map((md) => ({ value: md.key, label: md.label }))}
                            />
                          </div>
                        )}
                        {def?.needCert && (
                          <div className="mw-settings-col mw-settings-col--cert">
                            <Space style={{ marginBottom: 6 }} align="center">
                              <Text strong>是否使用证书（SSL）</Text>
                              <Switch
                                checked={editing.hasCert}
                                onChange={(v) => setEditing({ ...editing, hasCert: v })}
                              />
                            </Space>
                            {def?.certDir && (
                              <div
                                style={{
                                  color: 'var(--text-muted)',
                                  fontSize: 12,
                                  marginBottom: 6,
                                }}
                              >
                                启用后平台把 CRT/KEY 下发到 {def.certDir}，SSL 由安装脚本自行配置
                              </div>
                            )}
                            {editing.hasCert && (
                              <Space style={{ width: '100%' }} wrap>
                                <Select
                                  style={{ minWidth: 220 }}
                                  placeholder="选择证书"
                                  value={editing.certId}
                                  onChange={(v) => {
                                    const c = certs.find((x) => x.id === v)
                                    setEditing({
                                      ...editing,
                                      certId: v,
                                      certName: c?.name || '',
                                    })
                                  }}
                                  options={certs.map((c) => {
                                    const st = c.status || 'unknown'
                                    const color =
                                      st === 'expired'
                                        ? '#ef4444'
                                        : st === 'expiring'
                                        ? '#f59e0b'
                                        : st === 'valid'
                                        ? '#16a34a'
                                        : '#94a3b8'
                                    const left =
                                      c.daysLeft != null && c.daysLeft >= 0
                                        ? `剩 ${c.daysLeft} 天`
                                        : c.daysLeft != null
                                        ? `已过期 ${Math.abs(c.daysLeft)} 天`
                                        : '未解析'
                                    return {
                                      value: c.id,
                                      disabled: st === 'expired',
                                      label: (
                                        <span
                                          style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 8,
                                          }}
                                        >
                                          <span style={{ fontWeight: 600 }}>{c.name}</span>
                                          {c.domain && (
                                            <span
                                              style={{ color: 'var(--text-muted)', fontSize: 12 }}
                                            >
                                              {c.domain}
                                            </span>
                                          )}
                                          <span style={{ color, fontSize: 12 }}>· {left}</span>
                                        </span>
                                      ),
                                    }
                                  })}
                                />
                                {hasPerm('cert:create') && (
                                  <Button icon={<PlusOutlined />} onClick={() => setCertModal(true)}>
                                    上传新证书
                                  </Button>
                                )}
                              </Space>
                            )}
                          </div>
                        )}
                      </div>
                      <Space style={{ marginTop: 16 }} wrap>
                        {/* 首次加入已选清单＝新增部署对象（create）；修改已有项＝update */}
                        {hasPerm(existed ? 'deploy:update' : 'deploy:create') && (
                          <Button type="primary" icon={<CheckCircleFilled />} onClick={confirmConfig}>
                            {existed ? '保存修改' : '确认添加'}
                          </Button>
                        )}
                        <Button onClick={() => setEditing(null)}>取消</Button>
                        {existed && hasPerm('deploy:delete') && (
                          <Button danger onClick={() => removeMw(editing.type)}>
                            移除该中间件
                          </Button>
                        )}
                      </Space>
                    </div>
                  )
                })()}

              {/* 已选中间件清单 */}
              {mwItems.length > 0 && (
                <div className="mw-selected">
                  <div className="mw-selected__title">
                    已选中间件 <Tag color="blue">{mwItems.length}</Tag>
                    <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                      按顺序安装；首个为主中间件，决定版本 / 模式 / 证书校验
                    </Text>
                  </div>
                  <div className="mw-selected__list">
                    {mwItems.map((it, idx) => {
                      const def = catalog.find((m) => m.type === it.type)
                      const itModeLabel = def?.modes?.find((x) => x.key === it.mode)?.label
                      return (
                        <div key={it.type} className="mw-selected__item">
                          <span className="mw-selected__idx">{idx + 1}</span>
                          <span
                            className="mw-selected__badge"
                            style={{ background: MW_COLOR[it.type] || '#64748b' }}
                          >
                            <MwBrandIcon type={it.type} size={16} color="#fff" />
                          </span>
                          <span className="mw-selected__name">{def?.label || it.type}</span>
                          <Tag color="blue">{it.version || '默认'}</Tag>
                          {itModeLabel && <Tag>{itModeLabel}</Tag>}
                          {it.hasCert && (
                            <Tag color="geekblue">SSL{it.certName ? ` · ${it.certName}` : ''}</Tag>
                          )}
                          {idx === 0 ? (
                            <Tag color="gold" style={{ marginRight: 0 }}>
                              主
                            </Tag>
                          ) : (
                            // 「设为主」调整的是部署对象顺序（主项决定版本/模式/证书校验），按更新语义用 deploy:update
                            hasPerm('deploy:update') && (
                              <Button size="small" type="link" onClick={() => setAsMain(it.type)}>
                                设为主
                              </Button>
                            )
                          )}
                          <span className="mw-selected__spacer" />
                          {hasPerm('deploy:update') && (
                            <Button
                              size="small"
                              type="link"
                              icon={<EditOutlined />}
                              onClick={() => def && openConfig(def)}
                            >
                              修改
                            </Button>
                          )}
                          {hasPerm('deploy:delete') && (
                            <Button
                              size="small"
                              type="link"
                              danger
                              onClick={() => removeMw(it.type)}
                            >
                              移除
                            </Button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
                中间件为可选项：点击上方卡片逐个配置并确认，可单选或多选；全部不选时将仅执行系统初始化。
              </Paragraph>
            </div>
          </section>

          {/* ===== 03 选择服务器 ===== */}
          <section className="mw-section">
            <div className="mw-section-title">
              <span className="mw-section-idx">03</span>
              <span className="mw-section-h">选择服务器</span>
              <span className="mw-section-d">
                从资产管理中勾选服务器，或手动录入临时目标（不走资产管理）；两种方式可混合使用
              </span>
            </div>
            <div className="glass mw-panel">
              {/* 服务器来源：从资产 / /手动输入 */}
              <Space wrap style={{ marginBottom: 16 }}>
                <Segmented
                  value={targetSource}
                  onChange={(v) => setTargetSource(v as 'asset' | 'manual')}
                  options={[
                    { value: 'asset', label: '从资产中选择', icon: <DatabaseOutlined /> },
                    { value: 'manual', label: '手动输入', icon: <EditOutlined /> },
                  ]}
                />
                {(selectedIds.some((id) => id > 0) || manualEntries.length > 0) && (
                  <Tag color="cyan" style={{ marginLeft: 4 }}>
                    当前共选 {selectedIds.filter((id) => id > 0).length} 台资产
                    {manualEntries.length > 0
                      ? ` · ${manualEntries.length} 台手动`
                      : ''}
                  </Tag>
                )}
              </Space>

              {targetSource === 'asset' ? (
                <>
                  <Space wrap style={{ marginBottom: 16 }}>
                    <Segmented
                      value={assetView}
                      onChange={(v) => switchAssetView(v as 'recent' | 'category')}
                      options={[
                        { value: 'recent', label: '最近导入', icon: <HistoryOutlined /> },
                        { value: 'category', label: '按分类选择', icon: <ApartmentOutlined /> },
                      ]}
                    />
                    {assetView === 'category' && (
                      <>
                        <TreeSelect
                          style={{ width: 240 }}
                          placeholder="选择资产分类（部门）"
                          allowClear
                          treeDefaultExpandAll
                          value={cat}
                          treeData={treeData}
                          onChange={(v) => {
                            setCat(v as number | undefined)
                            setCatConfirmed(false)
                            setActiveProject(undefined)
                            setAssets([])
                            setAssetTotal(0)
                          }}
                        />
                        <Button type="primary" icon={<CloudServerOutlined />} onClick={confirmCat}>
                          确认分类
                        </Button>
                      </>
                    )}
                    <Input.Search
                      placeholder="关键字（名称 / IP）"
                      allowClear
                      style={{ width: 200 }}
                      onSearch={(v) => {
                        setKw(v)
                        if (assetView === 'recent') loadRecentAssets(1, v)
                        else if (catConfirmed) loadAssets(1, v, activeProject ?? cat)
                      }}
                      onChange={(e) => setKw(e.target.value)}
                    />
                    <Button
                      icon={<ReloadOutlined />}
                      onClick={() =>
                        assetView === 'recent'
                          ? loadRecentAssets(1, kw)
                          : catConfirmed && loadAssets(assetPage, kw, activeProject ?? cat)
                      }
                    >
                      刷新
                    </Button>
                  </Space>

                  {assetView === 'recent' ? (
                    <>
                      <div className="mw-projects-title">
                        <HistoryOutlined /> 最近导入的资产
                        <Tag style={{ marginLeft: 8 }}>最新优先</Tag>
                        <Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
                          共 {assetTotal} 条
                        </Text>
                      </div>
                      <Table
                        rowKey="id"
                        size="small"
                        loading={assetLoading}
                        dataSource={assets}
                        columns={assetColumns}
                        pagination={{
                          current: assetPage,
                          total: assetTotal,
                          pageSize: 10,
                          onChange: (p) => loadRecentAssets(p, kw),
                        }}
                        rowSelection={{
                          selectedRowKeys: selectedIds,
                          onChange: (keys, rows) => onRowSelect(keys as number[], rows as Asset[]),
                        }}
                      />
                    </>
                  ) : !catConfirmed ? (
                    <Empty
                      style={{ padding: '40px 0' }}
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="请先选择资产分类（部门），再点击「确认分类」"
                    />
                  ) : childProjects.length > 0 ? (
                    <>
                      <div className="mw-projects-title">
                        选择业务项目
                        <Tag style={{ marginLeft: 8 }}>{childProjects.length}</Tag>
                      </div>
                      <div className="mw-projects">
                        {childProjects.map((p) => (
                          <div
                            key={p.id}
                            className={`mw-project ${activeProject === p.id ? 'mw-project--active' : ''}`}
                            onClick={() => selectProject(p.id)}
                          >
                            <ApartmentOutlined className="mw-project__icon" />
                            <span className="mw-project__name">{p.name}</span>
                            {activeProject === p.id && <CheckCircleFilled className="mw-project__check" />}
                          </div>
                        ))}
                      </div>
                      {activeProject == null ? (
                        <Empty
                          className="mw-proj-empty"
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="请选择上方业务项目，查看其下服务器"
                        />
                      ) : (
                        <Table
                          rowKey="id"
                          size="small"
                          loading={assetLoading}
                          dataSource={assets}
                          columns={assetColumns}
                          style={{ marginTop: 14 }}
                          pagination={{
                            current: assetPage,
                            total: assetTotal,
                            pageSize: 10,
                            onChange: (p) => loadAssets(p, kw, activeProject),
                          }}
                          rowSelection={{
                            selectedRowKeys: selectedIds,
                            onChange: (keys, rows) => onRowSelect(keys as number[], rows as Asset[]),
                          }}
                        />
                      )}
                    </>
                  ) : (
                    <Table
                      rowKey="id"
                      size="small"
                      loading={assetLoading}
                      dataSource={assets}
                      columns={assetColumns}
                      pagination={{
                        current: assetPage,
                        total: assetTotal,
                        pageSize: 10,
                        onChange: (p) => loadAssets(p, kw, cat),
                      }}
                      rowSelection={{
                        selectedRowKeys: selectedIds,
                        onChange: (keys, rows) => onRowSelect(keys as number[], rows as Asset[]),
                      }}
                    />
                  )}
                </>
              ) : (
                <>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="手动输入适用于临时新增、资产未登记或测试场景：填写 IP/SSH/OS/CPU/网络区域后即可加入本次部署。"
                    description={
                      <span>
                        手动目标与资产目标共用同一部署链路（SSH / 离线包 / 节点分配）；手动目标不写入资产管理表。
                        网络区域必须与「Ansible 节点管理」中登记的区域一致才能正确分发。
                      </span>
                    }
                  />
                  <Space wrap style={{ marginBottom: 12 }}>
                    {hasPerm('deploy:create') && (
                      <Button type="primary" icon={<PlusOutlined />} onClick={openManualModal}>
                        添加手动目标
                      </Button>
                    )}
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      已添加 {manualEntries.length} 台手动目标
                    </Text>
                  </Space>
                  {manualEntries.length === 0 ? (
                    <Empty
                      style={{ padding: '30px 0' }}
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="点击「添加手动目标」录入临时服务器"
                    />
                  ) : (
                    <Table
                      rowKey="id"
                      size="small"
                      dataSource={manualEntries}
                      pagination={false}
                      columns={[
                        { title: 'IP', dataIndex: 'ip', key: 'ip' },
                        {
                          title: 'SSH',
                          key: 'ssh',
                          render: (_: any, r: ManualEntry) => (
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {r.user}@:{r.port}
                            </Text>
                          ),
                        },
                        { title: '网络区域', dataIndex: 'zone', key: 'zone', render: (v: string) => <Tag color="geekblue">{v}</Tag> },
                        { title: '操作系统', dataIndex: 'osType', key: 'osType', render: (v: string) => <Tag color="blue">{v}</Tag> },
                        { title: 'CPU', dataIndex: 'cpuType', key: 'cpuType', render: (v: string) => <Tag color="purple">{v}</Tag> },
                        {
                          title: '备注',
                          dataIndex: 'remark',
                          key: 'remark',
                          render: (v?: string) => v || <Text type="secondary">—</Text>,
                        },
                        {
                          title: '操作',
                          key: 'op',
                          width: 80,
                          render: (_: any, r: ManualEntry) => (
                            hasPerm('deploy:delete') && (
                              <Button size="small" type="link" danger onClick={() => removeManual(r.id)}>
                                移除
                              </Button>
                            )
                          ),
                        },
                      ]}
                    />
                  )}
                </>
              )}
            </div>
          </section>

          {/* ===== 04 目标识别结果 ===== */}
          <section className="mw-section">
            <div className="mw-section-title">
              <span className="mw-section-idx">04</span>
              <span className="mw-section-h">目标识别结果</span>
              <span className="mw-section-d">系统自动识别操作系统 / CPU，校验离线包兼容性</span>
            </div>
            <div className="glass mw-panel">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 12,
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                {detecting ? (
                  <Space>
                    <Spin size="small" />
                    <Text type="secondary">正在识别目标环境…</Text>
                  </Space>
                ) : (
                  <Text type="secondary">
                    已选 <b style={{ color: 'var(--accent)' }}>{selectedIds.length}</b> 台 · 可部署{' '}
                    <b style={{ color: '#16a34a' }}>{supportedCount}</b> 台
                  </Text>
                )}
              </div>
              {selectedTargets.length === 0 ? (
                <Empty style={{ padding: '30px 0' }} description="请先在上方选择服务器" />
              ) : (
                <>
                  {modeDef?.topology === 'roles' && (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="请为每台节点指定角色：哨兵模式建议至少 1 个 master、3 个 sentinel（保证 quorum）。"
                    />
                  )}
                  {modeDef?.topology === 'cluster' && (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={`集群模式将自动分配 ${modeDef.replicas} 个从库，请选择共 ${modeDef.nodeCount} 台服务器。`}
                    />
                  )}
                  <Table
                    rowKey="id"
                    size="small"
                    dataSource={selectedTargets}
                    columns={targetColumns}
                    pagination={false}
                  />
                </>
              )}
            </div>
          </section>

          {/* ===== 05 执行节点分配（按所属网络区域自动） ===== */}
          <section className="mw-section">
            <div className="mw-section-title">
              <span className="mw-section-idx">05</span>
              <span className="mw-section-h">执行节点分配</span>
              <span className="mw-section-d">系统依据资产「所属网络区域」自动匹配 Ansible 控制节点</span>
            </div>
            <div className="glass mw-panel">
              {selectedTargets.length === 0 ? (
                <Empty
                  className="mw-node-empty"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="选择服务器后，将自动按网络区域分配执行节点"
                />
              ) : detecting ? (
                <div className="mw-node-empty">
                  <Spin size="small" /> <Text type="secondary">正在计算节点分配…</Text>
                </div>
              ) : (
                <>
                  <div className="mw-nodes">
                    {Object.keys(zoneGroups).map((zone) => {
                      const list = zoneGroups[zone]
                      const node = nodeByZone[zone]
                      return (
                        <div className="mw-node-row" key={zone}>
                          <div className="mw-node-zone">
                            <Tag
                              icon={<ApartmentOutlined />}
                              color="geekblue"
                              style={{ fontSize: 13, padding: '2px 10px' }}
                            >
                              {zone}
                            </Tag>
                            <span className="mw-node-count">{list.length} 台服务器</span>
                          </div>
                          <div className="mw-node-arrow">→</div>
                          <div className="mw-node-target">
                            {node ? (
                              <span className="mw-node-chip">
                                <span className="mw-node-dot" />
                                <ClusterOutlined />
                                {node.name}
                                <span className="mw-node-host">{node.host}</span>
                              </span>
                            ) : (
                              <span className="mw-node-chip mw-node-chip--err">
                                <WarningOutlined /> 未配置执行节点
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                    {missingZone.length > 0 && (
                      <div className="mw-node-row">
                        <div className="mw-node-zone">
                          <Tag color="warning" style={{ fontSize: 13, padding: '2px 10px' }}>
                            未填写网络区域
                          </Tag>
                          <span className="mw-node-count">{missingZone.length} 台服务器</span>
                        </div>
                        <div className="mw-node-arrow">→</div>
                        <div className="mw-node-target">
                          <span className="mw-node-chip mw-node-chip--err">
                            <WarningOutlined /> 无法分配
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  {!nodesResolved && (
                    <Alert
                      className="mw-node-warn"
                      type="warning"
                      showIcon
                      icon={<WarningOutlined />}
                      message="存在无法分配执行节点的服务器"
                      description={
                        <div style={{ fontSize: 13 }}>
                          {missingZone.length > 0 && (
                            <div>
                              以下服务器未填写「所属网络区域」，请先在
                              <Text strong> 资产管理 </Text>
                              录入服务器信息（含所属网络区域）：
                              <Text code>{missingZone.join('、')}</Text>
                            </div>
                          )}
                          {missingNodeZones.length > 0 && (
                            <div style={{ marginTop: missingZone.length ? 6 : 0 }}>
                              网络区域
                              <Text code>{missingNodeZones.join('、')}</Text>
                              未配置执行节点，请在
                              <Text strong> Ansible 节点管理 </Text>
                              添加该区域的 Ansible 控制节点。
                            </div>
                          )}
                        </div>
                      }
                    />
                  )}
                  {nodesResolved && (
                    <Alert
                      className="mw-node-warn"
                      type="success"
                      showIcon
                      message={`已为 ${zoneCount} 个网络区域自动分配执行节点，可安全部署`}
                    />
                  )}
                </>
              )}
            </div>
          </section>

          {/* ===== 06 部署概览 + 操作 ===== */}
          <section className="mw-section">
            <div className="mw-section-title">
              <span className="mw-section-idx">06</span>
              <span className="mw-section-h">执行部署</span>
              <span className="mw-section-d">确认配置后一键执行系统初始化与中间件部署</span>
            </div>

            <div className="glass mw-summary">
              <div className="mw-summary__grid">
                <div className="mw-sum-item">
                  <div className="mw-sum-item__l">中间件</div>
                  <div className="mw-sum-item__v">
                    <span
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        background: MW_COLOR[mainMw] || '#64748b',
                        color: '#fff',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                      }}
                    >
                      {mainMw ? (
                        <MwBrandIcon type={mainMw} size={16} color="#fff" />
                      ) : (
                        (mainDef?.label || mainMw || '—').slice(0, 1)
                      )}
                    </span>
                    {mainMw ? (mainDef?.label || mainMw) : <Text type="secondary">不安装</Text>}
                  </div>
                </div>
                <div className="mw-sum-item">
                  <div className="mw-sum-item__l">版本</div>
                  <div className="mw-sum-item__v">{version || '—'}</div>
                </div>
                <div className="mw-sum-item">
                  <div className="mw-sum-item__l">部署模式</div>
                  <div className="mw-sum-item__v">{modeDef?.label || '单机（默认）'}</div>
                </div>
                <div className="mw-sum-item">
                  <div className="mw-sum-item__l">目标服务器</div>
                  <div className="mw-sum-item__v">
                    {supportedCount} 台可部署 / 共 {selectedIds.length} 台
                  </div>
                </div>
                <div className="mw-sum-item">
                  <div className="mw-sum-item__l">执行节点</div>
                  <div className="mw-sum-item__v">
                    <NodeIndexOutlined /> {nodesResolved ? `${zoneCount} 个区域自动分配` : '待分配'}
                  </div>
                </div>
                <div className="mw-sum-item">
                  <div className="mw-sum-item__l">Ansible 接入</div>
                  <div className="mw-sum-item__v">
                    <Tooltip title="平台自建 inventory：平台在控制节点写临时 inventory 执行；复用 Jenkins 组：先跑 ansible_host_manager.py 建组再执行，等价原 Jenkins pipeline。仅自包含 playbook 类型（系统初始化/GaussDB/Redis）支持组模式。">
                      <Select
                        size="small"
                        value={invMode}
                        onChange={(v) => setInvMode(v)}
                        style={{ minWidth: 190 }}
                        options={[
                          { value: 'platform', label: '平台自建 inventory' },
                          { value: 'group', label: '复用 Jenkins 组' },
                        ]}
                      />
                    </Tooltip>
                  </div>
                </div>
                <div className="mw-sum-item">
                  <div className="mw-sum-item__l">证书</div>
                  <div className="mw-sum-item__v">
                    {(() => {
                      const withCert = mwItems.filter((it) => it.hasCert)
                      if (!withCert.length) return '不使用'
                      return withCert
                        .map((it) => {
                          const md = catalog.find((m) => m.type === it.type)
                          const nm = it.certName || (it.certId ? '已选证书' : '待选择')
                          return `${md?.label || it.type} · ${nm}`
                        })
                        .join('；')
                    })()}
                  </div>
                </div>
              </div>
            </div>

            <div className="glass mw-action-bar">
              <div className="mw-action-bar__text">
                {mainMw ? (
                  <>
                    即将部署 <b>{mainDef?.label || mainMw}</b> · 版本 <b>{version || '—'}</b> ·{' '}
                    <b>{supportedCount}</b> 台服务器
                    {modeDef ? ` · ${modeDef.label}` : ''}
                    {mwItems.some((it) => it.hasCert)
                      ? ` · ${mwItems.filter((it) => it.hasCert).length} 项含证书`
                      : ''}
                  </>
                ) : (
                  <>仅执行系统初始化（不安装中间件）</>
                )}
                {initTasks.length > 0 ? ` · 系统初始化 ${initTasks.length} 项` : ' · 不执行初始化'}
                {nodesResolved ? ` · ${zoneCount} 个区域自动分配节点` : ' · 节点待分配'}
              </div>
              <Space wrap>
                {job && (
                  <Button icon={<ReloadOutlined />} onClick={() => { setJob(null); setRunning(false); setPhase('none') }}>
                    重置
                  </Button>
                )}
                {job && (
                  <Button icon={<FileTextOutlined />} onClick={() => setLogOpen(true)}>
                    查看执行日志
                  </Button>
                )}
                {/* 一次点击可能同时下发「系统初始化 + 中间件部署」：只跑初始化（未选中间件）时按
                    sysinit:exec 判断，含中间件部署时按 deploy:exec 判断 */}
                {(mainMw ? hasPerm('deploy:exec') : hasPerm('sysinit:exec')) && (
                  <Button
                    type="primary"
                    size="large"
                    icon={<PlayCircleOutlined />}
                    loading={running}
                    disabled={!canStart}
                    onClick={startDeploy}
                  >
                    {!mainMw
                      ? '开始初始化'
                      : initTasks.length > 0
                      ? '开始部署（含系统初始化）'
                      : '开始部署'}
                  </Button>
                )}
              </Space>
            </div>
              {(mainMw && !mainDef?.ready) && (
                <div style={{ marginTop: 10 }}>
                  <Text type="warning">当前中间件离线包未就绪</Text>
                </div>
              )}
            {!nodesResolved && supportedCount > 0 && (
              <div style={{ marginTop: 10 }}>
                <Text type="warning">
                  部分服务器无法分配执行节点，请先完善资产管理中的「所属网络区域」或在 Ansible 节点管理补充对应区域控制节点。
                </Text>
              </div>
            )}
          </section>
        </>
      )}

      {/* 手动输入目标弹窗：用于在第 03 步录入不走资产管理的临时服务器 */}
      <Modal
        title={
          <Space>
            <CloudServerOutlined style={{ color: 'var(--accent)' }} />
            添加手动目标
          </Space>
        }
        open={manualModalOpen}
        onCancel={() => setManualModalOpen(false)}
        onOk={submitManual}
        okText="添加"
        cancelText="取消"
        destroyOnClose
        width={680}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="带 * 项必填。网络区域必须与「Ansible 节点管理」中已登记的区域一致，否则无法自动分配执行节点。"
        />
        <Form
          form={manualForm}
          layout="vertical"
          initialValues={{ port: '65181', user: 'centos', become: 'root', osType: 'centos7', cpuType: 'x86_64' }}
        >
          <Row gutter={12}>
            <Col span={24}>
              <Form.Item
                name="ip"
                label="IP / 多 IP *"
                tooltip="支持一次录入多台：逗号、空格、换行或分号分隔；除 IP 外其余字段本批共用"
                rules={[
                  { required: true, message: '请输入至少一个 IP' },
                  {
                    validator: (_, value) => {
                      const ips = String(value || '')
                        .split(/[\s,;，；]+/)
                        .map((s) => s.trim())
                        .filter(Boolean)
                      if (ips.length === 0) return Promise.reject(new Error('请输入至少一个 IP'))
                      const bad = ips.filter((ip) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
                      if (bad.length) return Promise.reject(new Error(`IP 格式不正确：${bad.join('、')}`))
                      return Promise.resolve()
                    },
                  },
                ]}
              >
                <AInput.TextArea
                  rows={3}
                  placeholder={'platform.internal.example\n198.51.100.167\n198.51.100.168'}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="port" label="SSH 端口" tooltip="默认 65181，可修改">
                <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="65181" />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item
                name="zone"
                label="所属网络区域 *"
                rules={[{ required: true, message: '请选择或输入网络区域' }]}
                tooltip="建议选择「Ansible 节点管理」中已登记的区域；自定义值无法匹配控制节点"
              >
                <Select
                  allowClear
                  showSearch
                  placeholder="如 互联网 / 政务外网"
                  mode="tags"
                  maxCount={1}
                  options={Array.from(
                    new Set([
                      // 已登记的控制节点区域（建议值）
                      ...remotes.map((r) => r.networkZone).filter(Boolean),
                      // 业务上常见的区域值，方便用户复用
                      '互联网',
                      '政务外网',
                    ]),
                  ).map((z) => ({ value: z, label: z }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item
                name="osType"
                label="操作系统版本 *"
                rules={[{ required: true, message: '请选择操作系统版本' }]}
              >
                <Select
                  showSearch
                  placeholder="选择 OS 令牌"
                  options={MANUAL_OS_TYPES.map((o) => ({ value: o, label: o }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="cpuType"
                label="CPU 类型 *"
                rules={[{ required: true, message: '请选择 CPU 类型' }]}
              >
                <Select
                  showSearch
                  placeholder="选择 CPU 令牌"
                  options={MANUAL_CPU_TYPES.map((c) => ({ value: c, label: c }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="remark" label="备注">
                <AInput placeholder="可选" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="user"
                label="SSH 用户名 *"
                rules={[{ required: true, message: '请输入 SSH 用户名' }]}
              >
                <AInput placeholder="如 root / centos" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="pass"
                label="SSH 密码 *"
                rules={[{ required: true, message: '请输入 SSH 密码' }]}
              >
                <Input.Password placeholder="平台 SSH 登录所用密码" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="become" label="提权用户" tooltip="默认 root">
                <AInput placeholder="root" />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item
                name="becomePass"
                label="提权密码（sudo 密码）*"
                rules={[{ required: true, message: '请输入提权密码' }]}
                tooltip="sudo 校验的是 SSH 用户的密码；如不清楚，部署时平台会先实测再下发"
              >
                <Input.Password placeholder="sudo 提权所用密码" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* 证书上传弹窗 */}
      <Modal
        title={
          <Space>
            <SafetyCertificateOutlined style={{ color: 'var(--accent)' }} />
            上传证书
          </Space>
        }
        open={certModal}
        onCancel={() => setCertModal(false)}
        onOk={submitCert}
        confirmLoading={certSubmitting}
        destroyOnClose
      >
        <Form form={certForm} layout="vertical">
          <Form.Item
            name="name"
            label="证书名称（用于 vhost，如 example.com）"
            rules={[{ required: true, message: '请输入证书名称' }]}
          >
            <AInput placeholder="example.com" />
          </Form.Item>
          <Form.Item name="domain" label="关联域名">
            <AInput placeholder="可选" />
          </Form.Item>
          <Form.Item
            name="crtContent"
            label="证书 CRT（PEM）"
            rules={[{ required: true, message: '请粘贴证书内容' }]}
          >
            <Input.TextArea rows={5} placeholder="-----BEGIN CERTIFICATE-----" />
          </Form.Item>
          <Form.Item
            name="keyContent"
            label="私钥 KEY（PEM）"
            rules={[{ required: true, message: '请粘贴私钥内容' }]}
          >
            <Input.TextArea rows={5} placeholder="-----BEGIN PRIVATE KEY-----" />
          </Form.Item>
          <Form.Item name="caContent" label="CA 链（可选）">
            <Input.TextArea rows={3} placeholder="可选" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <AInput placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 执行日志弹窗（实时输出） */}
      <Modal
        title={
          <Space>
            <FileTextOutlined />
            执行日志
            {job && phase === 'init' && <Tag color="purple">系统初始化</Tag>}
            {job && phase === 'deploy' && <Tag color="blue">中间件部署</Tag>}
            {job && (
              <Tag
                color={
                  job.status === 'running'
                    ? 'processing'
                    : job.status === 'success'
                    ? 'success'
                    : job.status === 'failed'
                    ? 'error'
                    : 'default'
                }
              >
                {job.status === 'running'
                  ? '执行中'
                  : job.status === 'success'
                  ? '成功'
                  : job.status === 'failed'
                  ? '失败'
                  : '等待中'}
              </Tag>
            )}
          </Space>
        }
        open={logOpen}
        onCancel={() => setLogOpen(false)}
        footer={[
          <Button key="close" onClick={() => setLogOpen(false)}>
            {running ? '后台运行' : '关闭'}
          </Button>,
        ]}
        width={820}
        destroyOnClose
      >
        <div
          style={{
            background: '#0b1120',
            color: '#e2e8f0',
            borderRadius: 10,
            padding: 16,
            height: 460,
            overflow: 'auto',
            fontSize: 13,
            fontFamily: "'SF Mono','Roboto Mono',Menlo,Consolas,monospace",
            whiteSpace: 'pre-wrap',
            lineHeight: 1.6,
          }}
        >
          {job ? (job.output || job.errorMsg || '（暂无输出，请稍候…）') : '（无任务）'}
          <div ref={logEndRef} />
        </div>
        {running && (
          <div style={{ marginTop: 8 }}>
            <Progress percent={99} status="active" showInfo={false} />
            <Spin size="small" /> <Text type="secondary">正在实时采集执行日志…</Text>
          </div>
        )}
      </Modal>
    </div>
  )
}
