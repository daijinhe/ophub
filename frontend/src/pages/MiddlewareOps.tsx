import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App,
  Badge,
  Button,
  Col,
  Collapse,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudServerOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  HddOutlined,
  HistoryOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  PoweroffOutlined,
  ProfileOutlined,
  ReloadOutlined,
  ReloadOutlined as ReloadIcon,
  RollbackOutlined,
  SaveOutlined,
  SearchOutlined,
  SettingOutlined,
  StopOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import api from '../api/client'
import { MwBrandIcon, MW_BRAND_COLOR } from '../components/MwBrandIcon'
import { useAuth } from '../store/AuthContext'
import {
  checkMwOpsBatch,
  checkMwOpsInstance,
  createMwOpsInstance,
  deleteMwOpsInstance,
  getMwOpsConfig,
  listMwOpsConfigs,
  listMwOpsInstances,
  listMwOpsProfiles,
  mwOpsAction,
  mwOpsKillProcess,
  restoreMwOpsConfig,
  saveMwOpsConfig,
  syncMwOpsFromDeploy,
  updateMwOpsProfile,
  updateMwOpsInstance,
  type MwInstance,
  type MwOpsConfigFile,
  type MwOpsInstanceStats,
  type MwOpsProbe,
  type MwOpsProfile,
} from '../api/mwops'

const { Text, Paragraph } = Typography
const { TextArea } = Input

// ---------------- 展示映射 ----------------

const STATUS_META: Record<string, { text: string; color: string; icon: React.ReactNode }> = {
  running: { text: '运行中', color: 'green', icon: <CheckCircleOutlined /> },
  stopped: { text: '已停止', color: 'default', icon: <StopOutlined /> },
  unknown: { text: '未检测', color: 'orange', icon: <ExclamationCircleOutlined /> },
}

const UNIT_STATE_CN: Record<string, string> = {
  active: '运行中',
  reloading: '重载中',
  activating: '启动中',
  deactivating: '停止中',
  inactive: '未运行',
  failed: '失败',
  dead: '已退出',
}

const MONO: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
}

function fmtTime(v?: string | null) {
  if (!v) return '—'
  return v.replace('T', ' ').slice(0, 19)
}

function fmtSize(n: number) {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function parsePaths(json: string): string[] {
  try {
    const v = JSON.parse(json || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** 品牌图标块 */
function BrandBadge({ type, size = 16 }: { type: string; size?: number }) {
  const color = MW_BRAND_COLOR[type] || '#64748b'
  return (
    <span
      style={{
        width: size + 12,
        height: size + 12,
        borderRadius: 8,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: color,
        flex: 'none',
      }}
    >
      <MwBrandIcon type={type} size={size} color="#fff" />
    </span>
  )
}

export default function MiddlewareOps() {
  const { message, modal } = App.useApp()
  const { hasPerm } = useAuth()

  const [profiles, setProfiles] = useState<MwOpsProfile[]>([])
  const [instances, setInstances] = useState<MwInstance[]>([])
  const [stats, setStats] = useState<MwOpsInstanceStats | null>(null)
  const [byType, setByType] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)

  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [keyword, setKeyword] = useState('')
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([])

  const [busyId, setBusyId] = useState<number | null>(null)
  const [batchLoading, setBatchLoading] = useState(false)
  const [syncLoading, setSyncLoading] = useState(false)

  // 实例新建 / 编辑
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<MwInstance | null>(null)
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [assetOptions, setAssetOptions] = useState<any[]>([])
  const [assetLoading, setAssetLoading] = useState(false)
  const [mode, setMode] = useState<'asset' | 'manual'>('asset')

  // 详情抽屉
  const [detail, setDetail] = useState<{ open: boolean; inst: MwInstance | null; probe: MwOpsProbe | null; loading: boolean }>(
    { open: false, inst: null, probe: null, loading: false },
  )

  // 配置抽屉
  const [cfg, setCfg] = useState<{
    open: boolean
    inst: MwInstance | null
    loading: boolean
    files: MwOpsConfigFile[]
    activePath: string
    content: string
    draft: string
    loadingFile: boolean
    saving: boolean
    valid: boolean | null
    validateOutput: string
    reloadCmd: string
    testCmd: string
  }>({
    open: false,
    inst: null,
    loading: false,
    files: [],
    activePath: '',
    content: '',
    draft: '',
    loadingFile: false,
    saving: false,
    valid: null,
    validateOutput: '',
    reloadCmd: '',
    testCmd: '',
  })

  // 类型档案编辑
  const [profOpen, setProfOpen] = useState(false)
  const [profType, setProfType] = useState<string>('')
  const [profSaving, setProfSaving] = useState(false)
  const [profForm] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string> = {}
      if (typeFilter !== 'all') params.mwType = typeFilter
      if (statusFilter !== 'all') params.status = statusFilter
      if (keyword.trim()) params.keyword = keyword.trim()
      const d = await listMwOpsInstances(params)
      setInstances(d.list || [])
      setStats(d.stats || null)
      setByType(d.byType || {})
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [typeFilter, statusFilter, keyword, message])

  const loadProfiles = useCallback(async () => {
    try {
      const d = await listMwOpsProfiles()
      setProfiles(d.list || [])
    } catch {
      /* 类型档案加载失败不阻断主流程 */
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    loadProfiles()
  }, [loadProfiles])

  const profMap = useMemo(() => {
    const m: Record<string, MwOpsProfile> = {}
    profiles.forEach((p) => (m[p.type] = p))
    return m
  }, [profiles])

  const profLabel = (t: string) => profMap[t]?.label || t

  // ---------------- 资产选择 ----------------

  const searchAssets = useCallback(async (kw: string) => {
    setAssetLoading(true)
    try {
      const r = await api.get('/assets', { params: { page: 1, size: 50, keyword: kw } })
      setAssetOptions(r.data.data.list || [])
    } catch {
      /* ignore */
    } finally {
      setAssetLoading(false)
    }
  }, [])

  const openCreate = () => {
    setEditing(null)
    setMode('asset')
    form.resetFields()
    form.setFieldsValue({
      mwType: profiles[0]?.type,
      enabled: true,
      sshPort: '22',
      adminUser: 'root',
    })
    searchAssets('')
    setFormOpen(true)
  }

  const openEdit = (inst: MwInstance) => {
    setEditing(inst)
    setMode(inst.assetId > 0 ? 'asset' : 'manual')
    form.resetFields()
    form.setFieldsValue({
      mwType: inst.mwType,
      assetId: inst.assetId || undefined,
      host: inst.host,
      zone: inst.zone,
      port: inst.port,
      installPath: inst.installPath,
      processPattern: inst.processPattern,
      unit: inst.unit,
      cmdStart: inst.cmdStart,
      cmdStop: inst.cmdStop,
      cmdRestart: inst.cmdRestart,
      cmdReload: inst.cmdReload,
      configPathsText: parsePaths(inst.configPaths).join('\n'),
      version: inst.version,
      remark: inst.remark,
      enabled: inst.enabled,
      // 连接字段：用户名 / 端口 / 提权用户由后端返回（密码类不返回，留空即保持原值）
      sshPort: inst.sshPort || '22',
      sshUser: inst.sshUser || '',
      adminUser: inst.adminUser || 'root',
    })
    if (inst.assetId > 0) searchAssets('')
    setFormOpen(true)
  }

  const submitForm = async () => {
    let v: any
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    const payload: any = {
      mwType: v.mwType,
      version: v.version || '',
      port: v.port ? String(v.port) : '',
      installPath: v.installPath || '',
      processPattern: v.processPattern || '',
      unit: v.unit || '',
      cmdStart: v.cmdStart || '',
      cmdStop: v.cmdStop || '',
      cmdRestart: v.cmdRestart || '',
      cmdReload: v.cmdReload || '',
      configPaths: String(v.configPathsText || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      remark: v.remark || '',
      enabled: !!v.enabled,
    }
    if (mode === 'asset') {
      payload.assetId = v.assetId
      payload.host = ''
      payload.zone = ''
    } else {
      payload.assetId = 0
      payload.host = v.host
      payload.zone = v.zone || ''
      payload.sshPort = v.sshPort ? String(v.sshPort) : '22'
      payload.sshUser = v.sshUser
      payload.sshPass = v.sshPass || ''
      payload.adminUser = v.adminUser || 'root'
      payload.adminPass = v.adminPass || ''
      if (!editing && !payload.sshPass) {
        message.error('手动纳管必须填写 SSH 密码')
        return
      }
    }
    setSubmitting(true)
    try {
      if (editing) {
        await updateMwOpsInstance(editing.id, payload)
        message.success('已保存')
      } else {
        await createMwOpsInstance(payload)
        message.success('已新增实例，建议立即执行一次「检测」补全实测信息')
      }
      setFormOpen(false)
      load()
      loadProfiles()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '操作失败')
    } finally {
      setSubmitting(false)
    }
  }

  // ---------------- 检测 / 动作 ----------------

  const doCheck = async (inst: MwInstance) => {
    setBusyId(inst.id)
    try {
      const r = await checkMwOpsInstance(inst.id)
      if (r.ok) message.success(`${inst.assetName || inst.host}：${r.instance?.statusText || '检测完成'}`)
      else message.warning(`检测失败：${r.error || ''}`)
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '检测失败')
    } finally {
      setBusyId(null)
    }
  }

  const doBatchCheck = async () => {
    const ids = selectedKeys.map((k) => Number(k))
    setBatchLoading(true)
    try {
      const r = await checkMwOpsBatch(ids.length ? ids : undefined)
      message.success(
        `检测完成：共 ${r.checked} 个，运行中 ${r.running}，未运行 ${r.stopped}，失败 ${r.failed}` +
          (r.failures?.length ? `（首个失败：${r.failures[0]}）` : ''),
      )
      setSelectedKeys([])
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '批量检测失败')
    } finally {
      setBatchLoading(false)
    }
  }

  const doAction = async (inst: MwInstance, action: 'start' | 'stop' | 'restart' | 'reload') => {
    const needConfirm = action === 'stop' || action === 'restart'
    const run = async () => {
      setBusyId(inst.id)
      try {
        const r = await mwOpsAction(inst.id, action, needConfirm)
        message.success(`${profLabel(inst.mwType)} ${action === 'start' ? '启动' : action === 'stop' ? '停止' : action === 'restart' ? '重启' : '重载'}命令已执行（${r.cmd || '-'}）`)
        // 回显远端输出，便于确认
        if (r.output) {
          modal.info({
            title: '执行输出',
            width: 720,
            content: <pre className="mo-pre">{`$ ${r.cmd}\n${r.output}`}</pre>,
          })
        }
        load()
      } catch (e: any) {
        const data = e?.response?.data
        const out = data?.data?.output
        message.error(data?.msg || '执行失败')
        if (out) {
          modal.error({
            title: '执行失败',
            width: 720,
            content: <pre className="mo-pre">{`$ ${data?.data?.cmd || ''}\n${out}`}</pre>,
          })
        }
      } finally {
        setBusyId(null)
      }
    }
    if (needConfirm) {
      modal.confirm({
        title: `确认${action === 'stop' ? '停止' : '重启'} ${profLabel(inst.mwType)}？`,
        icon: <WarningOutlined style={{ color: 'var(--warn)' }} />,
        content: (
          <div>
            <div>
              目标：<b>{inst.assetName || inst.host}</b>（{inst.host}）
            </div>
            <div style={{ marginTop: 6, color: 'var(--text-secondary)' }}>
              该操作会中断当前正在处理的服务，请确认已评估影响。
            </div>
          </div>
        ),
        okText: action === 'stop' ? '确认停止' : '确认重启',
        okButtonProps: { danger: true },
        onOk: run,
      })
      return
    }
    run()
  }

  const openDetail = async (inst: MwInstance) => {
    setDetail({ open: true, inst, probe: null, loading: true })
    try {
      const r = await checkMwOpsInstance(inst.id)
      setDetail({ open: true, inst: r.instance || inst, probe: r.probe, loading: false })
      if (!r.ok) message.warning(r.error || '探测失败')
      load()
    } catch (e: any) {
      setDetail({ open: true, inst, probe: null, loading: false })
      message.error(e?.response?.data?.msg || '探测失败')
    }
  }

  const killProc = (inst: MwInstance, pid: number, args: string, signal: '15' | '9') => {
    const doKill = async () => {
      try {
        await mwOpsKillProcess(inst.id, pid, signal)
        message.success(`已向 PID ${pid} 发送 ${signal === '9' ? 'SIGKILL(9) 强制结束' : 'SIGTERM(15) 优雅结束'}`)
        openDetail(inst)
      } catch (e: any) {
        message.error(e?.response?.data?.msg || '操作失败')
      }
    }
    modal.confirm({
      title: signal === '9' ? `确认强制结束进程 PID ${pid}？` : `确认结束进程 PID ${pid}？`,
      icon: <WarningOutlined style={{ color: 'var(--danger)' }} />,
      width: 560,
      content: (
        <div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 6, ...MONO }}>{args}</div>
          <div>
            {signal === '9'
              ? 'SIGKILL 无法被进程捕获，将立即终止，可能丢失未落盘数据。'
              : 'SIGTERM 请求进程优雅退出（推荐先试这个）。'}
          </div>
        </div>
      ),
      okText: signal === '9' ? '强制结束' : '优雅结束',
      okButtonProps: { danger: true },
      onOk: doKill,
    })
  }

  // ---------------- 配置管理 ----------------

  const openConfig = async (inst: MwInstance) => {
    setCfg({
      open: true,
      inst,
      loading: true,
      files: [],
      activePath: '',
      content: '',
      draft: '',
      loadingFile: false,
      saving: false,
      valid: null,
      validateOutput: '',
      reloadCmd: '',
      testCmd: '',
    })
    try {
      const d = await listMwOpsConfigs(inst.id)
      const first = (d.list || []).find((f) => f.exists) || (d.list || [])[0]
      setCfg((s) => ({ ...s, loading: false, files: d.list || [], reloadCmd: d.reloadCmd, testCmd: d.testCmd }))
      if (first) loadConfigFile(inst, first.path)
    } catch (e: any) {
      setCfg((s) => ({ ...s, loading: false }))
      message.error(e?.response?.data?.msg || '读取配置文件列表失败')
    }
  }

  const loadConfigFile = async (inst: MwInstance, path: string) => {
    setCfg((s) => ({ ...s, loadingFile: true, activePath: path, valid: null, validateOutput: '' }))
    try {
      const d = await getMwOpsConfig(inst.id, path)
      setCfg((s) => ({ ...s, loadingFile: false, content: d.content, draft: d.content, testCmd: d.testCmd, reloadCmd: d.reloadCmd }))
    } catch (e: any) {
      setCfg((s) => ({ ...s, loadingFile: false, content: '', draft: '' }))
      message.error(e?.response?.data?.msg || '读取失败')
    }
  }

  const refreshCfgFiles = async (inst: MwInstance) => {
    try {
      const d = await listMwOpsConfigs(inst.id)
      setCfg((s) => ({ ...s, files: d.list || [] }))
    } catch {
      /* ignore */
    }
  }

  const submitCfg = async (test: boolean, reload: boolean) => {
    const inst = cfg.inst
    if (!inst || !cfg.activePath) return
    setCfg((s) => ({ ...s, saving: true }))
    try {
      const r = await saveMwOpsConfig(inst.id, { path: cfg.activePath, content: cfg.draft, test, reload })
      setCfg((s) => ({
        ...s,
        saving: false,
        content: cfg.draft,
        valid: r.valid ?? null,
        validateOutput: r.validateOutput || r.reloadOutput || '',
        files: r.files || s.files,
      }))
      if (r.valid === false) {
        message.error('已写入目标机，但配置校验未通过，请修正后重新保存（也可用「还原备份」回滚）')
      } else if (r.reloaded === false) {
        message.warning(`已保存，但重载失败：${r.reloadError || ''}`)
      } else {
        message.success(reload ? '已保存、校验通过并完成重载' : '已保存到目标机')
      }
      load()
    } catch (e: any) {
      setCfg((s) => ({ ...s, saving: false }))
      message.error(e?.response?.data?.msg || '保存失败')
    }
  }

  const doRestore = async () => {
    const inst = cfg.inst
    if (!inst || !cfg.activePath) return
    setCfg((s) => ({ ...s, saving: true }))
    try {
      const r = await restoreMwOpsConfig(inst.id, { path: cfg.activePath, test: true, reload: true })
      setCfg((s) => ({
        ...s,
        saving: false,
        valid: r.valid ?? null,
        validateOutput: r.validateOutput || r.reloadOutput || '',
        files: r.files || s.files,
      }))
      message.success('已从备份还原并重新校验')
      const d = await getMwOpsConfig(inst.id, cfg.activePath)
      setCfg((s) => ({ ...s, content: d.content, draft: d.content }))
      load()
    } catch (e: any) {
      setCfg((s) => ({ ...s, saving: false }))
      message.error(e?.response?.data?.msg || '还原失败')
    }
  }

  // ---------------- 类型档案 ----------------

  const openProfile = (type: string) => {
    const p = profMap[type]
    if (!p) return
    setProfType(type)
    profForm.setFieldsValue({
      label: p.label,
      processPattern: p.processPattern,
      unitsText: (p.units || []).join('\n'),
      defaultPathsText: (p.defaultPaths || []).join('\n'),
      defaultPort: p.defaultPort,
      configPathsText: (p.configPaths || []).join('\n'),
      configTestCmd: p.configTestCmd,
      versionCmd: p.versionCmd,
      cmdStart: p.cmdStart,
      cmdStop: p.cmdStop,
      cmdRestart: p.cmdRestart,
      cmdReload: p.cmdReload,
      desc: p.desc,
      enabled: p.enabled,
    })
    setProfOpen(true)
  }

  const submitProfile = async () => {
    let v: any
    try {
      v = await profForm.validateFields()
    } catch {
      return
    }
    setProfSaving(true)
    try {
      await updateMwOpsProfile(profType, {
        label: v.label,
        processPattern: v.processPattern,
        units: String(v.unitsText || '')
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
        defaultPaths: String(v.defaultPathsText || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        defaultPort: v.defaultPort || '',
        configPaths: String(v.configPathsText || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        configTestCmd: v.configTestCmd || '',
        versionCmd: v.versionCmd || '',
        cmdStart: v.cmdStart || '',
        cmdStop: v.cmdStop || '',
        cmdRestart: v.cmdRestart || '',
        cmdReload: v.cmdReload || '',
        desc: v.desc || '',
        enabled: !!v.enabled,
      })
      message.success('类型档案已保存（仅对新检测/新动作生效）')
      setProfOpen(false)
      loadProfiles()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '保存失败')
    } finally {
      setProfSaving(false)
    }
  }

  // ---------------- 表格 ----------------

  const columns: ColumnsType<MwInstance> = [
    {
      title: '实例',
      dataIndex: 'assetName',
      key: 'name',
      width: 260,
      render: (_, r) => (
        <Space>
          <BrandBadge type={r.mwType} />
          <div style={{ lineHeight: 1.35 }}>
            <div style={{ fontWeight: 600, color: 'var(--text-strong)' }}>
              {r.assetName || r.host}
              {!r.enabled && (
                <Tag style={{ marginLeft: 6 }} color="default">
                  已停用
                </Tag>
              )}
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {r.mwType === 'jdk' ? 'Java 进程' : profLabel(r.mwType)} · {r.host}
              {r.zone ? ` · ${r.zone}` : ''}
            </Text>
          </div>
        </Space>
      ),
    },
    {
      title: '类型 / 版本',
      key: 'type',
      width: 150,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Tag color={MW_BRAND_COLOR[r.mwType] ? undefined : 'blue'} style={{ borderColor: 'transparent', background: `${MW_BRAND_COLOR[r.mwType] || '#64748b'}1a`, color: MW_BRAND_COLOR[r.mwType] || 'inherit' }}>
            {profLabel(r.mwType)}
          </Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {r.version || '版本未探测'}
          </Text>
        </Space>
      ),
    },
    {
      title: '安装路径 / 端口',
      key: 'path',
      width: 240,
      render: (_, r) => (
        <div style={{ lineHeight: 1.4 }}>
          <div style={{ ...MONO, wordBreak: 'break-all' }}>{r.installPath || '—'}</div>
          {r.port && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              端口 {r.port}
            </Text>
          )}
        </div>
      ),
    },
    {
      title: '运行状态',
      key: 'status',
      width: 240,
      render: (_, r) => {
        const m = STATUS_META[r.status] || STATUS_META.unknown
        return (
          <Tooltip title={r.lastError || r.statusText}>
            <Space direction="vertical" size={0}>
              <Badge status={r.status === 'running' ? 'success' : r.status === 'stopped' ? 'default' : 'warning'} text={m.text} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {r.statusText || '—'}
              </Text>
            </Space>
          </Tooltip>
        )
      },
    },
    {
      title: '最近检测',
      dataIndex: 'lastCheckAt',
      key: 'lastCheckAt',
      width: 160,
      render: (v) => <Text type="secondary">{fmtTime(v)}</Text>,
    },
    {
      title: '操作',
      key: 'op',
      width: 300,
      fixed: 'right',
      render: (_, r) => {
        const running = r.status === 'running'
        return (
          <Space size={4} wrap>
            {/* 单个「检测」与「批量检测」同属检测动作，按 mwops:exec 收口 */}
            {hasPerm('mwops:exec') && (
              <Button size="small" icon={<SyncOutlined />} loading={busyId === r.id} onClick={() => doCheck(r)}>
                检测
              </Button>
            )}
            {hasPerm('mwops:exec') &&
              (running ? (
                <Button size="small" danger icon={<PoweroffOutlined />} onClick={() => doAction(r, 'stop')}>
                  停止
                </Button>
              ) : (
                <Button size="small" type="primary" ghost icon={<PlayCircleOutlined />} onClick={() => doAction(r, 'start')}>
                  启动
                </Button>
              ))}
            {hasPerm('mwops:exec') && (
              <Button size="small" icon={<ReloadIcon />} onClick={() => doAction(r, 'restart')}>
                重启
              </Button>
            )}
            <Button size="small" icon={<FileTextOutlined />} onClick={() => openConfig(r)}>
              配置
            </Button>
            <Dropdown
              menu={{
                items: [
                  { key: 'detail', icon: <ProfileOutlined />, label: '进程 / 状态详情' },
                  ...(hasPerm('mwops:exec')
                    ? [{ key: 'reload', icon: <ThunderboltOutlined />, label: '重载配置' }]
                    : []),
                  ...(hasPerm('mwops:update')
                    ? [
                        { key: 'profile', icon: <SettingOutlined />, label: '类型档案' },
                        { type: 'divider' as const },
                        { key: 'edit', icon: <EditOutlined />, label: '编辑实例' },
                      ]
                    : []),
                  ...(hasPerm('mwops:delete')
                    ? [{ key: 'delete', icon: <DeleteOutlined />, label: '删除纳管', danger: true }]
                    : []),
                ],
                onClick: ({ key }) => {
                  if (key === 'detail') openDetail(r)
                  else if (key === 'reload') doAction(r, 'reload')
                  else if (key === 'profile') openProfile(r.mwType)
                  else if (key === 'edit') openEdit(r)
                  else if (key === 'delete') {
                    modal.confirm({
                      title: '确认删除该纳管记录？',
                      content: '仅删除平台记录，目标机上的进程与文件不会做任何改动。',
                      okButtonProps: { danger: true },
                      onOk: async () => {
                        await deleteMwOpsInstance(r.id)
                        message.success('已删除纳管记录')
                        load()
                        loadProfiles()
                      },
                    })
                  }
                },
              }}
            >
              <Button size="small" icon={<MoreOutlined />} />
            </Dropdown>
          </Space>
        )
      },
    },
  ]

  const typeTabs = useMemo(() => {
    const items = profiles.map((p) => ({
      key: p.type,
      label: (
        <Space size={8}>
          <BrandBadge type={p.type} size={14} />
          <span>{p.label}</span>
          <Badge
            count={byType[p.type] || 0}
            showZero
            style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--accent)', boxShadow: 'none', fontWeight: 600 }}
          />
        </Space>
      ),
    }))
    return [{ key: 'all', label: <Space size={8}><HddOutlined />全部</Space> }, ...items]
  }, [profiles, byType])

  const dirty = cfg.draft !== cfg.content

  return (
    <div className="mo-page">
      {/* 概览 */}
      <Row gutter={[12, 12]} className="mw-section">
        {[
          { k: 'total', label: '纳管实例', value: stats?.total ?? 0, color: 'var(--accent)', icon: <HddOutlined /> },
          { k: 'running', label: '运行中', value: stats?.running ?? 0, color: 'var(--ok)', icon: <CheckCircleOutlined /> },
          { k: 'stopped', label: '已停止', value: stats?.stopped ?? 0, color: 'var(--text-secondary)', icon: <StopOutlined /> },
          { k: 'unknown', label: '未检测', value: stats?.unknown ?? 0, color: 'var(--warn)', icon: <ExclamationCircleOutlined /> },
        ].map((c) => (
          <Col xs={12} md={6} key={c.k}>
            <div className="glass mw-stat mo-stat">
              <span className="mo-stat__icon" style={{ color: c.color }}>
                {c.icon}
              </span>
              <div>
                <div className="mw-stat__n" style={{ color: c.color }}>
                  {c.value}
                </div>
                <div className="mw-stat__l">{c.label}</div>
              </div>
            </div>
          </Col>
        ))}
      </Row>

      {/* 实例列表 */}
      <section className="mw-section">
        <div className="mw-section-title">
          <span className="mw-section-idx">
            <ApiOutlined />
          </span>
          <span className="mw-section-h">中间件实例</span>
          <span className="mw-section-d">
            远程查看进程是否存活、启停重启、在线管理配置文件；数据来自部署记录或手动纳管
          </span>
        </div>

        <div className="glass mw-panel">
          <Space wrap style={{ marginBottom: 12 }}>
            {/* 同步以「从部署记录导入/新增纳管实例」为主，mwops 无 :sync 动作码，按语义最接近的 mwops:create 收口 */}
            {hasPerm('mwops:create') && (
              <Button
                type="primary"
                icon={<HistoryOutlined />}
                loading={syncLoading}
                onClick={async () => {
                  setSyncLoading(true)
                  try {
                    const r = await syncMwOpsFromDeploy()
                    message.success(
                      `已从部署记录同步：新增 ${r.created}，更新 ${r.updated}，跳过 ${r.skipped}，失败 ${r.failed}（扫描 ${r.jobCount} 条成功记录）`,
                    )
                    load()
                    loadProfiles()
                  } catch (e: any) {
                    message.error(e?.response?.data?.msg || '同步失败')
                  } finally {
                    setSyncLoading(false)
                  }
                }}
              >
                从部署记录同步
              </Button>
            )}
            {hasPerm('mwops:exec') && (
              <Button icon={<SyncOutlined />} loading={batchLoading} onClick={doBatchCheck}>
                {selectedKeys.length ? `检测选中 ${selectedKeys.length} 个` : '批量检测全部'}
              </Button>
            )}
            {hasPerm('mwops:create') && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新增实例
              </Button>
            )}
            <Input.Search
              allowClear
              placeholder="关键字（实例名 / IP / 路径 / 备注）"
              style={{ width: 240 }}
              prefix={<SearchOutlined />}
              onSearch={(v) => setKeyword(v)}
              onChange={(e) => !e.target.value && setKeyword('')}
            />
            <Select
              value={statusFilter}
              style={{ width: 140 }}
              onChange={setStatusFilter}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'running', label: '运行中' },
                { value: 'stopped', label: '已停止' },
                { value: 'unknown', label: '未检测' },
              ]}
            />
            <Button icon={<ReloadOutlined />} onClick={() => load()}>
              刷新
            </Button>
          </Space>

          <Tabs
            activeKey={typeFilter}
            onChange={(k) => setTypeFilter(k)}
            items={typeTabs.map((t) => ({ key: t.key, label: t.label }))}
            style={{ marginBottom: 4 }}
          />

          <Table
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={instances}
            columns={columns}
            scroll={{ x: 1300 }}
            rowSelection={{ selectedRowKeys: selectedKeys, onChange: (keys) => setSelectedKeys(keys) }}
            pagination={{ pageSize: 15, showSizeChanger: true, showTotal: (t) => `共 ${t} 个实例` }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <span>
                      还没有纳管的中间件实例
                      <br />
                      <Text type="secondary">点击「从部署记录同步」自动登记已部署的中间件，或「新增实例」手动纳管</Text>
                    </span>
                  }
                />
              ),
            }}
          />
        </div>
      </section>

      {/* 实例详情 */}
      <Drawer
        title={
          detail.inst ? (
            <Space>
              <BrandBadge type={detail.inst.mwType} />
              {detail.inst.assetName || detail.inst.host}
              <Tag>{detail.inst.host}</Tag>
            </Space>
          ) : (
            '实例详情'
          )
        }
        width={860}
        open={detail.open}
        onClose={() => setDetail((s) => ({ ...s, open: false }))}
        loading={detail.loading}
      >
        {detail.inst && (
          <>
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="类型">{profLabel(detail.inst.mwType)}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Badge
                  status={detail.inst.status === 'running' ? 'success' : detail.inst.status === 'stopped' ? 'default' : 'warning'}
                  text={STATUS_META[detail.inst.status]?.text || detail.inst.status}
                />
              </Descriptions.Item>
              <Descriptions.Item label="版本">{detail.inst.version || '—'}</Descriptions.Item>
              <Descriptions.Item label="端口">{detail.inst.port || '—'}</Descriptions.Item>
              <Descriptions.Item label="安装路径" span={2}>
                <span style={MONO}>{detail.inst.installPath || '—'}</span>
              </Descriptions.Item>
              <Descriptions.Item label="网络区域">{detail.inst.zone || '—'}</Descriptions.Item>
              <Descriptions.Item label="来源">
                {detail.inst.source === 'deploy' ? `部署记录 #${detail.inst.deployJobId}` : '手动纳管'}
              </Descriptions.Item>
              <Descriptions.Item label="最近检测">{fmtTime(detail.inst.lastCheckAt)}</Descriptions.Item>
              <Descriptions.Item label="检测摘要">{detail.inst.statusText || '—'}</Descriptions.Item>
            </Descriptions>

            {detail.inst.lastError && (
              <Alert type="error" showIcon style={{ marginBottom: 14 }} message="最近一次检测失败" description={detail.inst.lastError} />
            )}

            <Paragraph strong style={{ marginBottom: 6 }}>
              运行进程（{detail.probe?.procs?.length || 0}）
            </Paragraph>
            <Table
              rowKey="pid"
              size="small"
              pagination={false}
              dataSource={detail.probe?.procs || []}
              locale={{ emptyText: '未匹配到进程' }}
              columns={[
                { title: 'PID', dataIndex: 'pid', width: 80 },
                { title: '用户', dataIndex: 'user', width: 90 },
                { title: '运行时长', dataIndex: 'elapsed', width: 100 },
                { title: 'CPU%', dataIndex: 'cpu', width: 70 },
                { title: 'MEM%', dataIndex: 'mem', width: 70 },
                { title: '启动命令', dataIndex: 'args', render: (v) => <span style={MONO}>{v}</span> },
                ...(hasPerm('mwops:exec')
                  ? [
                      {
                        title: '操作',
                        key: 'op',
                        width: 150,
                        render: (_: any, p: any) => (
                          <Space size={4}>
                            <Button size="small" danger onClick={() => killProc(detail.inst!, p.pid, p.args, '15')}>
                              结束
                            </Button>
                            <Button size="small" type="link" danger onClick={() => killProc(detail.inst!, p.pid, p.args, '9')}>
                              强制
                            </Button>
                          </Space>
                        ),
                      },
                    ]
                  : []),
              ]}
            />

            <Paragraph strong style={{ margin: '16px 0 6px' }}>
              监听端口（{detail.probe?.ports?.length || 0}）
            </Paragraph>
            <Table
              rowKey={(r) => `${r.addr}-${r.pid}`}
              size="small"
              pagination={false}
              dataSource={detail.probe?.ports || []}
              locale={{ emptyText: '未获取到监听端口（可能需要 root 权限）' }}
              columns={[
                { title: '监听地址', dataIndex: 'addr', width: 220, render: (v) => <span style={MONO}>{v}</span> },
                { title: 'PID', dataIndex: 'pid', width: 90 },
                { title: '进程', dataIndex: 'proc', render: (v) => <span style={MONO}>{v || '—'}</span> },
              ]}
            />

            <Paragraph strong style={{ margin: '16px 0 6px' }}>
              systemd 单元（{detail.probe?.units?.length || 0}）
            </Paragraph>
            <Table
              rowKey="name"
              size="small"
              pagination={false}
              dataSource={detail.probe?.units || []}
              locale={{ emptyText: '目标机无 systemd 或未登记同名单元（将走命令模板启停）' }}
              columns={[
                { title: '单元', dataIndex: 'name' },
                {
                  title: '状态',
                  dataIndex: 'state',
                  width: 120,
                  render: (v) => <Tag color={v === 'active' ? 'green' : v === 'failed' ? 'red' : 'default'}>{UNIT_STATE_CN[v] || v}</Tag>,
                },
              ]}
            />

            <Collapse
              ghost
              style={{ marginTop: 12 }}
              items={[
                {
                  key: 'raw',
                  label: '探测原始输出（排查用）',
                  children: <pre className="mo-pre">{detail.probe?.raw || '（无输出）'}</pre>,
                },
                {
                  key: 'discovered',
                  label: '本次发现的安装目录 / 版本',
                  children: (
                    <div style={{ ...MONO }}>
                      <div>安装目录候选命中：{detail.probe?.dirs?.join('、') || '无'}</div>
                      <div>版本输出：{detail.probe?.verRaw || '无'}</div>
                      <div>执行方式：{detail.probe?.via === 'sudo' ? 'sudo 提权' : '当前 SSH 用户'}</div>
                    </div>
                  ),
                },
              ]}
            />
          </>
        )}
      </Drawer>

      {/* 配置管理 */}
      <Drawer
        title={
          cfg.inst ? (
            <Space>
              <FileTextOutlined />
              配置管理 · {profLabel(cfg.inst.mwType)}
              <Tag>{cfg.inst.assetName || cfg.inst.host}</Tag>
            </Space>
          ) : (
            '配置管理'
          )
        }
        width={1100}
        open={cfg.open}
        onClose={() => setCfg((s) => ({ ...s, open: false }))}
        loading={cfg.loading}
      >
        {cfg.inst && (
          <Row gutter={14}>
            <Col span={8}>
              <List
                size="small"
                header={
                  <Space>
                    <Text strong>配置文件</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      共 {cfg.files.length} 个
                    </Text>
                  </Space>
                }
                dataSource={cfg.files}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该实例未配置任何配置文件路径" /> }}
                renderItem={(f) => (
                  <List.Item
                    style={{
                      cursor: 'pointer',
                      background: cfg.activePath === f.path ? 'var(--accent-soft)' : undefined,
                      borderRadius: 8,
                      padding: '8px 10px',
                    }}
                    onClick={() => loadConfigFile(cfg.inst!, f.path)}
                  >
                    <div style={{ width: '100%' }}>
                      <div style={{ ...MONO, wordBreak: 'break-all' }}>{f.path}</div>
                      <Space size={4} style={{ marginTop: 4 }} wrap>
                        {f.exists ? <Tag color="green">存在</Tag> : <Tag>缺失</Tag>}
                        {f.exists && <Tag>{fmtSize(f.size)}</Tag>}
                        {f.backup && <Tag color="blue">有备份</Tag>}
                      </Space>
                    </div>
                  </List.Item>
                )}
              />
              <div style={{ marginTop: 10 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  候选路径来自「类型档案」，可通过实例或类型档案的「配置文件路径」调整（支持 {`{path}`} 占位与 *.conf 通配）。
                </Text>
              </div>
            </Col>
            <Col span={16}>
              {!cfg.activePath ? (
                <Empty style={{ marginTop: 60 }} image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择左侧配置文件" />
              ) : (
                <>
                  <Space style={{ marginBottom: 8 }} wrap>
                    <Text style={MONO} strong>
                      {cfg.activePath}
                    </Text>
                    {dirty && <Tag color="orange">已修改未保存</Tag>}
                  </Space>
                  <TextArea
                    value={cfg.draft}
                    onChange={(e) => setCfg((s) => ({ ...s, draft: e.target.value }))}
                    style={MONO}
                    autoSize={{ minRows: 18, maxRows: 30 }}
                    disabled={cfg.loadingFile}
                    placeholder={cfg.loadingFile ? '读取中…' : '（文件为空或不存在）'}
                  />
                  <Space style={{ marginTop: 10 }} wrap>
                    {hasPerm('mwops:update') && (
                      <Button
                        type="primary"
                        icon={<SaveOutlined />}
                        loading={cfg.saving}
                        disabled={cfg.loadingFile}
                        onClick={() => submitCfg(true, false)}
                      >
                        保存并校验
                      </Button>
                    )}
                    {/* 「保存 · 校验 · 重载」以保存为主题动作（重载是保存的附带效果），按 mwops:update 收口 */}
                    {hasPerm('mwops:update') && (
                      <Button
                        icon={<ThunderboltOutlined />}
                        loading={cfg.saving}
                        disabled={cfg.loadingFile}
                        onClick={() => submitCfg(true, true)}
                      >
                        保存 · 校验 · 重载
                      </Button>
                    )}
                    {hasPerm('mwops:update') && (
                      <Button
                        icon={<SaveOutlined />}
                        loading={cfg.saving}
                        disabled={cfg.loadingFile}
                        onClick={() => submitCfg(false, false)}
                      >
                        仅保存
                      </Button>
                    )}
                    <Button icon={<RollbackOutlined />} disabled={cfg.loadingFile} onClick={() => loadConfigFile(cfg.inst!, cfg.activePath)}>
                      放弃修改
                    </Button>
                    {hasPerm('mwops:update') && (
                      <Popconfirm
                        title="确认从备份还原？"
                        description={`将用 ${cfg.activePath}.ophub.bak 覆盖当前文件并重新校验。`}
                        onConfirm={doRestore}
                        okButtonProps={{ danger: true }}
                      >
                        <Button danger icon={<HistoryOutlined />} loading={cfg.saving}>
                          还原备份
                        </Button>
                      </Popconfirm>
                    )}
                    <Button
                      icon={<SyncOutlined />}
                      onClick={() => refreshCfgFiles(cfg.inst!)}
                    >
                      刷新文件状态
                    </Button>
                  </Space>

                  <div style={{ marginTop: 10 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      校验命令：{cfg.testCmd || '（该类型未配置校验命令）'} ｜ 重载命令：
                      {cfg.reloadCmd || '（该类型不支持热加载，改完请用「重启」）'}
                    </Text>
                  </div>

                  {cfg.valid === false && (
                    <Alert
                      type="error"
                      showIcon
                      style={{ marginTop: 10 }}
                      message="配置校验未通过（内容已写入目标机）"
                      description={<pre className="mo-pre">{cfg.validateOutput || '（无输出）'}</pre>}
                    />
                  )}
                  {cfg.valid === true && cfg.validateOutput && (
                    <Alert type="success" showIcon style={{ marginTop: 10 }} message="校验通过" description={<pre className="mo-pre">{cfg.validateOutput}</pre>} />
                  )}
                </>
              )}
            </Col>
          </Row>
        )}
      </Drawer>

      {/* 新增 / 编辑实例 */}
      <Modal
        title={editing ? '编辑中间件实例' : '新增中间件实例'}
        open={formOpen}
        width={720}
        onCancel={() => setFormOpen(false)}
        onOk={submitForm}
        confirmLoading={submitting}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item label="归属方式">
            <Segmented
              value={mode}
              onChange={(v) => setMode(v as 'asset' | 'manual')}
              options={[
                { value: 'asset', label: '从资产中选择', icon: <CloudServerOutlined /> },
                { value: 'manual', label: '手动填写连接信息', icon: <ApiOutlined /> },
              ]}
            />
          </Form.Item>

          {mode === 'asset' ? (
            <Form.Item name="assetId" label="目标资产 *" rules={[{ required: true, message: '请选择资产' }]}>
              <Select
                showSearch
                filterOption={false}
                placeholder="按名称 / IP 搜索资产"
                loading={assetLoading}
                onSearch={searchAssets}
                options={assetOptions.map((a) => ({
                  value: a.id,
                  label: `${a.displayName || a.name}（${a.ip || '无IP'}）`,
                }))}
              />
            </Form.Item>
          ) : (
            <>
              <Row gutter={12}>
                <Col span={8}>
                  <Form.Item name="host" label="目标机 IP *" rules={[{ required: true, message: '请输入 IP' }]}>
                    <Input placeholder="platform.internal.example" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="sshPort" label="SSH 端口">
                    <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="22" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="zone" label="网络区域">
                    <Input placeholder="如 互联网 / 政务外网" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={8}>
                  <Form.Item
                    name="sshUser"
                    label={editing ? 'SSH 用户名（留空保持原值）' : 'SSH 用户名 *'}
                    rules={editing ? [] : [{ required: true, message: '请输入 SSH 用户名' }]}
                  >
                    <Input placeholder="centos" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="sshPass" label={editing ? 'SSH 密码（留空保持原值）' : 'SSH 密码 *'}>
                    <Input.Password placeholder="登录密码" autoComplete="new-password" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="adminUser" label="提权用户">
                    <Input placeholder="root" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="adminPass" label={editing ? '提权密码（留空保持原值）' : '提权密码'}>
                    <Input.Password placeholder="sudo 密码，留空则用实测/免密" autoComplete="new-password" />
                  </Form.Item>
                </Col>
              </Row>
            </>
          )}

          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="mwType" label="中间件类型 *" rules={[{ required: true, message: '请选择类型' }]}>
                <Select
                  onChange={(t: string) => {
                    const p = profMap[t]
                    if (p && !form.getFieldValue('port')) form.setFieldValue('port', p.defaultPort)
                  }}
                  options={profiles.map((p) => ({ value: p.type, label: p.label }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="version" label="版本号">
                <Input placeholder="留空则由检测自动识别" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="port" label="端口">
                <Input placeholder="如 8089 / 17000" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="installPath"
            label="安装路径"
            tooltip="留空时按类型档案的「常见安装路径」自动发现并回填（如 /opt/servers/nginx）"
          >
            <Input placeholder="留空自动发现" />
          </Form.Item>

          <Collapse
            ghost
            items={[
              {
                key: 'adv',
                label: '高级：覆盖类型档案（进程匹配 / 服务单元 / 启停命令 / 配置文件）',
                children: (
                  <>
                    <Row gutter={12}>
                      <Col span={12}>
                        <Form.Item name="processPattern" label="进程匹配关键字（pgrep -f）" tooltip="留空继承类型档案，如 nginx: master">
                          <Input placeholder="继承类型档案" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="unit" label="systemd 服务单元" tooltip="填写后优先用 systemctl 管理">
                          <Input placeholder="如 nginx.service（留空自动探测）" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={12}>
                      <Col span={12}>
                        <Form.Item name="cmdStart" label="启动命令" tooltip="占位符：{path} {sbin} {conf} {port} {pid} {unit}">
                          <Input placeholder="继承类型档案" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="cmdStop" label="停止命令">
                          <Input placeholder="继承类型档案" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="cmdRestart" label="重启命令">
                          <Input placeholder="继承类型档案" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="cmdReload" label="重载命令">
                          <Input placeholder="继承类型档案" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item
                      name="configPathsText"
                      label="配置文件路径（每行一个）"
                      tooltip="留空继承类型档案；支持 {path} 占位与 *.conf 通配"
                    >
                      <TextArea autoSize={{ minRows: 3, maxRows: 8 }} style={MONO} placeholder="{path}/conf/nginx.conf" />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />

          <Row gutter={12}>
            <Col span={16}>
              <Form.Item name="remark" label="备注">
                <Input placeholder="用途 / 负责人等" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="enabled" label="纳入批量检测" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* 类型档案 */}
      <Modal
        title={`类型档案 · ${profLabel(profType)}`}
        open={profOpen}
        width={760}
        onCancel={() => setProfOpen(false)}
        onOk={submitProfile}
        confirmLoading={profSaving}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="现场路径 / 单元名与默认不一致时在此调整"
          description="类型档案是「按类型」的默认能力；单个实例可在编辑实例时覆盖。命令占位符：{path} {sbin} {conf} {port} {pid} {unit}"
        />
        <Form form={profForm} layout="vertical">
          <Row gutter={12}>
            <Col span={10}>
              <Form.Item name="label" label="展示名">
                <Input />
              </Form.Item>
            </Col>
            <Col span={7}>
              <Form.Item name="defaultPort" label="默认端口">
                <Input />
              </Form.Item>
            </Col>
            <Col span={7}>
              <Form.Item name="enabled" label="启用" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="processPattern" label="进程匹配关键字（pgrep -f）">
                <Input placeholder="nginx: master" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="unitsText" label="systemd 单元名（每行/逗号一个）">
                <TextArea autoSize={{ minRows: 2, maxRows: 4 }} style={MONO} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="defaultPathsText" label="常见安装路径（每行一个，用于自动发现）">
                <TextArea autoSize={{ minRows: 2, maxRows: 5 }} style={MONO} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="configPathsText" label="配置文件候选（每行一个，支持 {path} 与 *）">
                <TextArea autoSize={{ minRows: 2, maxRows: 5 }} style={MONO} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="configTestCmd" label="配置校验命令">
                <Input placeholder="{sbin}/nginx -t" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="versionCmd" label="版本探测命令">
                <Input placeholder="{sbin}/nginx -v 2>&1" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="cmdStart" label="启动命令">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="cmdStop" label="停止命令">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="cmdRestart" label="重启命令">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="cmdReload" label="重载命令">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="desc" label="说明">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
