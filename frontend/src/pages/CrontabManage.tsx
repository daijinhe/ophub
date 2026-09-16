import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Collapse,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FieldTimeOutlined,
  FileTextOutlined,
  MonitorOutlined,
  PlusOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons'
import {
  CRON_PRESETS,
  createCrontabTask,
  deleteCrontabTask,
  describeCronClient,
  escapeCronPercent,
  getAssetCrontab,
  listCrontabAssets,
  saveCrontabRaw,
  scanCrontabAssets,
  updateCrontabTask,
  validateCronClient,
  type AssetCrontabView,
  type CrontabEntry,
  type CrontabHostOption,
  type CrontabScanItem,
  type CrontabScanStatus,
} from '../api/crontab'
import { useAuth } from '../store/AuthContext'
import { openCenteredWindow } from '../utils/window'

const { Text, Paragraph, Title } = Typography

/** 统一取后端返回的中文错误信息 */
function errMsg(e: any, fallback = '操作失败'): string {
  return e?.response?.data?.msg || e?.message || fallback
}

/** 非任务行类型展示 */
const KIND_META: Record<string, { text: string; color: string }> = {
  task: { text: '任务', color: 'green' },
  disabled: { text: '已禁用', color: 'orange' },
  comment: { text: '注释', color: 'default' },
  env: { text: '环境变量', color: 'blue' },
  blank: { text: '空行', color: 'default' },
}

/** 单机扫描状态展示 */
const SCAN_META: Record<string, { text: string; color: string; badge: 'success' | 'warning' | 'error' | 'default' }> = {
  ok: { text: '正常', color: 'green', badge: 'success' },
  offline: { text: '离线', color: 'default', badge: 'default' },
  denied: { text: '提权失败', color: 'red', badge: 'error' },
  invalid: { text: '信息不全', color: 'red', badge: 'error' },
  error: { text: '读取失败', color: 'red', badge: 'error' },
}

/** 表格行：资产清单 + 扫描结果 */
type HostRow = CrontabHostOption & { scan?: CrontabScanItem }

/**
 * 打开抽屉时，若列表里的扫描结果在此时长内，直接复用不再连目标机；
 * 超过则先用旧数据秒开，再后台静默校准一次。
 */
const DETAIL_FRESH_MS = 30_000

/** 上次手动扫描结果的本地缓存键：进入页面时直接读取，避免每次自动连目标机扫描 */
const SCAN_SNAPSHOT_KEY = 'ophub.crontab.lastScan.v1'

interface ScanSnapshot {
  scannedAt: string
  savedAt: number
  scanMap: Record<number, CrontabScanItem>
}

/**
 * 层级常量。
 *
 * 编辑弹窗 / 原文抽屉 / 删除确认框都是从「定时任务管理」抽屉内部打开的，
 * 而 antd 的 Drawer 与 Modal 默认 zIndex 都是 1000，此时谁后挂载谁在上面 ——
 * 主抽屉是点开后才挂载的，于是把先渲染的弹窗盖住了（实测：编辑窗口被抽屉压住）。
 * 因此嵌套层统一抬到主抽屉之上。
 */
const Z_NESTED = 1200

/**
 * 定时任务管理
 *
 * 两段式：① 扫描全部资产，一眼看清每台虚拟机维护用户（默认 root）有多少定时任务；
 * ② 点开某台机器，直接读写该用户 crontab 做增删改查。
 * 数据源是目标机上 `crontab -l` 的输出，平台不保存任务副本，
 * 所以「看到的」与「机器上真实在跑的」始终一致。
 */
export default function CrontabManage() {
  const { message, modal } = App.useApp()
  const { hasPerm } = useAuth()
  const canManage = hasPerm('crontab:manage')

  // ---- 资产清单 & 扫描结果 ----
  const [hosts, setHosts] = useState<CrontabHostOption[]>([])
  const [hostsLoading, setHostsLoading] = useState(false)
  const [scanMap, setScanMap] = useState<Record<number, CrontabScanItem>>({})
  const [scanning, setScanning] = useState(false)
  const [scanIds, setScanIds] = useState<number[]>([])
  const [scannedAt, setScannedAt] = useState('')
  const [keyword, setKeyword] = useState('')
  /** 默认只看「有任务」的机器 —— 扫描后一屏就是要关注的对象，避免大量空机器刷屏 */
  const [viewFilter, setViewFilter] = useState<'all' | 'withTasks' | 'noTasks' | 'error'>('withTasks')

  // ---- 任务管理抽屉（CRUD） ----
  const [drawerId, setDrawerId] = useState<number | null>(null)
  const [detail, setDetail] = useState<AssetCrontabView | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailRefreshing, setDetailRefreshing] = useState(false)
  const [detailErr, setDetailErr] = useState('')
  // ---- 任务编辑 ----
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create')
  const [editing, setEditing] = useState<CrontabEntry | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  // ---- 原文编辑 ----
  const [rawOpen, setRawOpen] = useState(false)
  const [rawText, setRawText] = useState('')
  const [rawSaving, setRawSaving] = useState(false)

  const [busyLine, setBusyLine] = useState<number | null>(null)

  const exprWatch = Form.useWatch('expr', form)
  const cmdWatch = Form.useWatch('command', form)
  const enabledWatch = Form.useWatch('enabled', form)

  // ------------------------------------------------------------------ 数据

  const loadHosts = useCallback(async () => {
    setHostsLoading(true)
    try {
      setHosts(await listCrontabAssets())
    } catch (e) {
      message.error(errMsg(e, '加载资产列表失败'))
    } finally {
      setHostsLoading(false)
    }
  }, [message])

  useEffect(() => {
    loadHosts()
  }, [loadHosts])
  /** 把某台资产的最新详情同步回列表，保证任务数实时一致 */
  const syncScanFromDetail = useCallback((id: number, v: AssetCrontabView) => {
    setScanMap((prev) => ({
      ...prev,
      [id]: { ...v, status: 'ok' as CrontabScanStatus, message: '' },
    }))
  }, [])

  /**
   * 读取抽屉内某台资产的 crontab。
   * @param opts.silent  不显示整块骨架（已有内容在展示，只是后台校准）
   * @param opts.refresh 强制重连目标机取最新（不加时后端会走 15 秒去重缓存）
   */
  const loadDetail = useCallback(
    async (id: number, opts: { silent?: boolean; refresh?: boolean } = {}) => {
      const { silent = false, refresh = false } = opts
      if (silent) setDetailRefreshing(true)
      else setDetailLoading(true)
      setDetailErr('')
      try {
        const v = await getAssetCrontab(id, { refresh })
        setDetail(v)
        setRawText(v.content)
        syncScanFromDetail(id, v)
      } catch (e) {
        setDetailErr(errMsg(e, '读取目标机定时任务失败'))
      } finally {
        setDetailLoading(false)
        setDetailRefreshing(false)
      }
    },
    [syncScanFromDetail],
  )

  /**
   * 在新窗口打开该资产的 Web SSH 终端（自动登录并提权到 root）。
   * 入口与「资产管理」页保持一致，方便一边看定时任务、一边进机器排查。
   */
  const openWebTerminal = (assetId?: number) => {
    if (!assetId) return
    const w = openCenteredWindow(
      `/webterm/${assetId}`,
      '_blank',
      1280,
      860,
      'menubar=no,toolbar=no,location=no,status=no',
    )
    if (!w) message.warning('浏览器拦截了新窗口，请允许本站弹出窗口后重试')
  }

  /** 打开任务管理抽屉：先用列表里已有的扫描结果瞬间出内容，再按需后台校准 */
  const openDrawer = (id: number) => {
    setDrawerId(id)
    setDetailErr('')
    setRawText('')
    const cached = scanMap[id]
    if (cached && cached.status === 'ok' && cached.tasks) {
      // 兜底补齐 host：扫描结果里若缺该字段，抽屉标题会渲染出 undefined
      setDetail({ ...cached, host: cached.host || cached.ip })
      setRawText(cached.content || '')
      setDetailLoading(false)
      // 刚扫过（30 秒内）直接复用，完全不再连目标机；否则后台静默校准
      const fresh = cached.readAtMs ? Date.now() - cached.readAtMs < DETAIL_FRESH_MS : false
      if (!fresh) void loadDetail(id, { silent: true, refresh: true })
      return
    }
    setDetail(null)
    void loadDetail(id, { refresh: true })
  }

  const closeDrawer = () => {
    setDrawerId(null)
    setDetail(null)
    setDetailErr('')
    setDetailRefreshing(false)
  }

  // 从「资产管理」的资产详情点「定时任务管理」跳转过来时（?assetId=xx），
  // 直接打开该机的任务抽屉，省掉「找到这台机器再点开」的一步。
  const [sp, setSp] = useSearchParams()
  const bootOpened = useRef(false)
  useEffect(() => {
    if (bootOpened.current) return
    const id = Number(sp.get('assetId') || 0)
    if (!id) return
    bootOpened.current = true
    openDrawer(id)
    // 参数用掉即清掉，避免刷新 / 回退时重复弹抽屉
    const next = new URLSearchParams(sp)
    next.delete('assetId')
    setSp(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp, setSp])

  /** 扫描（全部 / 指定几台） */
  const runScan = useCallback(
    async (ids?: number[], quiet = false) => {
      const many = !ids || ids.length > 1
      if (many) setScanning(true)
      else setScanIds(ids!)
      try {
        const res = await scanCrontabAssets(ids ? { assetIds: ids } : {})
        setScanMap((prev) => {
          const next = { ...prev }
          for (const it of res.list) next[it.assetId] = it
          return next
        })
        if (many) {
          setScannedAt(res.scannedAt)
          if (!quiet) {
            message.success(
              `扫描完成：${res.scanned} 台资产，${res.taskHostCount} 台有定时任务，共 ${res.taskTotal} 条` +
                (res.errorCount ? `（${res.errorCount} 台异常）` : ''),
              5,
            )
          }
        } else {
          const one = res.list[0]
          if (one?.status === 'ok') message.success(`${one.assetName}：共 ${one.taskCount} 条定时任务`)
          else if (one) message.warning(`${one.assetName}：${one.message || SCAN_META[one.status]?.text}`)
        }
        // 抽屉开着时同步刷新
        if (ids && ids.length === 1 && drawerId === ids[0]) await loadDetail(ids[0], { silent: true })
      } catch (e) {
        message.error(errMsg(e, '扫描定时任务失败'))
      } finally {
        setScanning(false)
        setScanIds([])
      }
    },
    [drawerId, loadDetail, message],
  )

  // 进入页面不再自动扫描：直接读取上次手动扫描保留在本地的快照，
  // 这样每次打开都能看到「上一轮扫描」的结果，无需连目标机。
  // 用户需要时自行点击上方「扫描全部资产」刷新即可。
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SCAN_SNAPSHOT_KEY)
      if (!raw) return
      const snap = JSON.parse(raw) as ScanSnapshot
      if (snap && snap.scanMap && typeof snap.scanMap === 'object') {
        setScanMap(snap.scanMap)
        setScannedAt(snap.scannedAt || '')
      }
    } catch {
      /* 本地快照损坏则忽略，等同首次进入 */
    }
  }, [])

  // 扫描结果（含抽屉内重新读取）更新后，写回本地，供下次打开直接展示。
  useEffect(() => {
    if (!Object.keys(scanMap).length) return
    try {
      localStorage.setItem(
        SCAN_SNAPSHOT_KEY,
        JSON.stringify({ scannedAt, savedAt: Date.now(), scanMap } as ScanSnapshot),
      )
    } catch {
      /* 本地存储不可用时静默降级 */
    }
  }, [scanMap, scannedAt])

  // ------------------------------------------------------------------ 写操作

  /**
   * 写操作失败提示。若失败原因是「远端内容已被改动」，说明手里的 hash 过期了，
   * 给出更可操作的解释（页面会自动刷新到最新内容），避免用户反复重试都失败。
   */
  const reportWriteError = useCallback(
    (e: any) => {
      const msg = errMsg(e)
      if (/已被改动|已被修改|冲突/.test(msg)) {
        message.warning('目标机 crontab 刚被改动过，已自动为你刷新到最新内容，请确认后重试', 6)
      } else {
        message.error(msg)
      }
    },
    [message],
  )

  const openCreate = (preset?: { expr?: string; command?: string }) => {
    setEditorMode('create')
    setEditing(null)
    form.setFieldsValue({
      expr: preset?.expr || '0 1 * * *',
      command: preset?.command || '',
      enabled: true,
    })
    setEditorOpen(true)
  }

  const openEdit = (entry: CrontabEntry) => {
    setEditorMode('edit')
    setEditing(entry)
    form.setFieldsValue({
      expr: entry.expr,
      command: entry.command,
      enabled: entry.enabled,
    })
    setEditorOpen(true)
  }

  const submitTask = async () => {
    if (!drawerId || !detail) return
    let values: any
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    const expr = String(values.expr || '').trim()
    const command = String(values.command || '')
    const enabled = values.enabled !== false
    setSaving(true)
    try {
      const res =
        editorMode === 'edit' && editing
          ? await updateCrontabTask(drawerId, {
              hash: detail.hash,
              lineNo: editing.lineNo,
              oldRaw: editing.raw,
              expr,
              command,
              enabled,
            })
          : await createCrontabTask(drawerId, { hash: detail.hash, expr, command, enabled })
      if (res.changed) {
        message.success(editorMode === 'edit' ? '已保存并同步到目标机' : '已新增并同步到目标机')
      } else {
        message.info('内容无变化，未写入目标机')
      }
      if (res.backup) message.info(`原 crontab 已备份：${res.backup}`, 6)
      setEditorOpen(false)
      await loadDetail(drawerId, { silent: true, refresh: true })
    } catch (e) {
      reportWriteError(e)
      await loadDetail(drawerId, { silent: true, refresh: true })
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async (entry: CrontabEntry) => {
    if (!drawerId || !detail) return
    setBusyLine(entry.lineNo)
    try {
      const res = await deleteCrontabTask(drawerId, {
        hash: detail.hash,
        lineNo: entry.lineNo,
        oldRaw: entry.raw,
      })
      message.success('已从目标机删除该定时任务')
      if (res.backup) message.info(`原 crontab 已备份：${res.backup}`, 6)
    } catch (e) {
      reportWriteError(e)
    } finally {
      setBusyLine(null)
      await loadDetail(drawerId, { silent: true, refresh: true })
    }
  }

  const confirmDelete = (entry: CrontabEntry) => {
    modal.confirm({
      title: '确认删除这条定时任务？',
      width: 580,
      // 确认框是从抽屉里弹出的，必须抬到抽屉之上，否则会被抽屉盖住
      zIndex: Z_NESTED,
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      content: (
        <div style={{ marginTop: 8 }}>
          <Paragraph type="secondary" style={{ marginBottom: 8 }}>
            将在目标机 <Text code>{detail?.host}</Text> 的{' '}
            <Text code>{detail?.source || 'crontab -l'}</Text> 内容中删除第 {entry.lineNo} 行：
          </Paragraph>
          <div className="ct-preview">
            <pre className="ct-pre">{entry.raw}</pre>
          </div>
          <Paragraph type="secondary" style={{ margin: '10px 0 0', fontSize: 12 }}>
            写入前会自动备份原 crontab 到{' '}
            <Text code>~/.ophub_crontab/backup/crontab_&lt;用户&gt;.&lt;时间戳&gt;</Text>，可在目标机上找回。
          </Paragraph>
        </div>
      ),
      onOk: () => doDelete(entry),
    })
  }

  const toggleEnabled = async (entry: CrontabEntry, next: boolean) => {
    if (!drawerId || !detail) return
    setBusyLine(entry.lineNo)
    try {
      await updateCrontabTask(drawerId, {
        hash: detail.hash,
        lineNo: entry.lineNo,
        oldRaw: entry.raw,
        expr: entry.expr || '',
        command: entry.command || '',
        enabled: next,
      })
      message.success(next ? '已启用该任务' : '已禁用该任务（任务行被注释）')
    } catch (e) {
      reportWriteError(e)
    } finally {
      setBusyLine(null)
      await loadDetail(drawerId, { silent: true, refresh: true })
    }
  }

  const saveRaw = async () => {
    if (!drawerId || !detail) return
    setRawSaving(true)
    try {
      const res = await saveCrontabRaw(drawerId, { hash: detail.hash, content: rawText })
      message.success(res.changed ? '原文已保存并同步到目标机' : '内容无变化，未写入目标机')
      if (res.backup) message.info(`原 crontab 已备份：${res.backup}`, 6)
      setRawOpen(false)
      await loadDetail(drawerId, { silent: true, refresh: true })
    } catch (e) {
      reportWriteError(e)
    } finally {
      setRawSaving(false)
    }
  }

  // ------------------------------------------------------------------ 派生

  const rows: HostRow[] = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return hosts
      .map((h) => ({ ...h, scan: scanMap[h.assetId] }))
      .filter((r) => {
        if (kw) {
          const hay = `${r.assetName} ${r.vmName || ''} ${r.ip} ${r.sshHost || ''} ${r.sshUser || ''}`.toLowerCase()
          if (!hay.includes(kw)) return false
        }
        switch (viewFilter) {
          case 'withTasks':
            // 未扫描的行先留着（还没结果就藏起来会让人以为机器丢了），扫到 0 条才隐藏
            return !r.scan ? true : (r.scan.taskCount || 0) > 0
          case 'noTasks':
            return !!r.scan && r.scan.status === 'ok' && r.scan.taskCount === 0
          case 'error':
            return !!r.scan && r.scan.status !== 'ok'
          default:
            return true
        }
      })
  }, [hosts, scanMap, keyword, viewFilter])

  const stats = useMemo(() => {
    const list = Object.values(scanMap)
    return {
      scanned: list.length,
      taskHosts: list.filter((s) => s.status === 'ok' && s.taskCount > 0).length,
      noTaskHosts: list.filter((s) => s.status === 'ok' && s.taskCount === 0).length,
      taskTotal: list.reduce((n, s) => n + (s.status === 'ok' ? s.taskCount : 0), 0),
      errors: list.filter((s) => s.status !== 'ok').length,
      denied: list.filter((s) => s.status === 'denied').length,
    }
  }, [scanMap])

  // ------------------------------------------------------------------ 列定义

  const statusTag = (r: HostRow) => {
    if (!r.scan) {
      return (
        <Tag color="default" style={{ marginInlineEnd: 0 }}>
          未扫描
        </Tag>
      )
    }
    const m = SCAN_META[r.scan.status] || SCAN_META.error
    return (
      <Tooltip title={r.scan.message || undefined}>
        <Tag color={m.color} style={{ marginInlineEnd: 0 }}>
          {m.text}
        </Tag>
      </Tooltip>
    )
  }

  const columns: ColumnsType<HostRow> = [
    {
      title: '状态',
      width: 104,
      align: 'center',
      filters: [
        { text: '正常', value: 'ok' },
        { text: '有任务', value: 'hasTask' },
        { text: '无任务', value: 'empty' },
        { text: '异常', value: 'err' },
      ],
      onFilter: (v, r) => {
        const s = r.scan
        if (v === 'ok') return s?.status === 'ok'
        if (v === 'hasTask') return (s?.taskCount || 0) > 0
        if (v === 'empty') return s?.status === 'ok' && s.taskCount === 0
        return !!s && s.status !== 'ok'
      },
      render: (_, r) => statusTag(r),
    },
    {
      title: (
        <Tooltip title="与 Web 终端会话名一致：项目简称_环境_业务环境_虚拟机IPv4">
          <span>虚拟机</span>
        </Tooltip>
      ),
      render: (_, r) => {
        const addr = r.sshHost || r.ip || ''
        // 主标题＝与 Web 终端会话名同源的展示名；副标题＝连接地址。
        // CMDB「虚拟机名称」（云主机名，可能很长）放进 tooltip，列表保持清爽，
        // 但仍参与搜索（见 rows 的关键字过滤）。
        const vm = (r.vmName || '').trim()
        const tip = vm && vm !== addr && !r.assetName.includes(vm) ? `${vm} · ${addr}` : addr
        return (
          <div style={{ lineHeight: 1.5 }}>
            <div title={tip}>
              <Text strong>{r.assetName || addr || '—'}</Text>
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {addr || '—'}
              {!r.ready && r.reason ? ` · ${r.reason}` : ''}
            </Text>
          </div>
        )
      },
    },
    {
      title: (
        <Tooltip title="crontab 是「按用户」存在的：这里显示读写的是谁的 crontab（默认 root，可由资产「超级管理员用户」覆盖）">
          <span>归属用户</span>
        </Tooltip>
      ),
      width: 150,
      render: (_, r) => {
        const runUser = r.scan?.user || r.runUser || 'root'
        const mode = r.scan?.runMode || r.runMode
        return (
          <Space size={6}>
            <UserOutlined style={{ color: 'var(--text-secondary)' }} />
            <Text strong>{runUser}</Text>
            {mode === 'sudo' && (
              <Tooltip title="SSH 登录用户不是该用户，通过 sudo 提权后执行 crontab -l / crontab">
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                  sudo
                </Tag>
              </Tooltip>
            )}
            {mode === 'direct' && (
              <Tooltip title="SSH 登录用户就是该 crontab 的归属用户，直接执行 crontab">
                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                  直连
                </Tag>
              </Tooltip>
            )}
          </Space>
        )
      },
    },
    {
      title: '定时任务',
      width: 200,
      sorter: (a, b) => (a.scan?.taskCount || 0) - (b.scan?.taskCount || 0),
      defaultSortOrder: undefined,
      render: (_, r) => {
        if (!r.scan || r.scan.status !== 'ok') {
          return (
            <Text type="secondary" style={{ fontSize: 12 }}>
              —
            </Text>
          )
        }
        if (r.scan.taskCount === 0) {
          return (
            <Text type="secondary" style={{ fontSize: 12.5 }}>
              无任务
            </Text>
          )
        }
        return (
          <Space size={8}>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent)' }}>{r.scan.taskCount}</span>
            <Text type="secondary" style={{ fontSize: 12 }}>
              条
            </Text>
            {r.scan.enabledCount > 0 && (
              <Tag color="green" style={{ marginInlineEnd: 0 }}>
                启用 {r.scan.enabledCount}
              </Tag>
            )}
            {r.scan.disabledCount > 0 && (
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                禁用 {r.scan.disabledCount}
              </Tag>
            )}
          </Space>
        )
      },
    },
    {
      title: '最近扫描',
      width: 165,
      render: (_, r) =>
        r.scan?.readAt ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {r.scan.readAt}
          </Text>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Text>
        ),
    },
    {
      title: '操作',
      width: 292,
      align: 'right',
      render: (_, r) => (
        <Space size={4}>
          <Button
            size="small"
            type="primary"
            ghost
            icon={<FieldTimeOutlined />}
            disabled={!r.ready && !r.scan}
            onClick={() => openDrawer(r.assetId)}
          >
            任务管理
          </Button>
          <Tooltip title="在新窗口打开该机器的 Web SSH 终端（自动登录并提权 root）">
            <Button
              size="small"
              icon={<MonitorOutlined />}
              style={{ color: '#38bdf8' }}
              disabled={!(r.sshHost || r.ip)}
              onClick={() => openWebTerminal(r.assetId)}
            >
              Web 终端
            </Button>
          </Tooltip>
          <Tooltip title="只重新扫描这一台">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={scanIds.includes(r.assetId)}
              disabled={!r.ready}
              onClick={() => runScan([r.assetId])}
            />
          </Tooltip>
        </Space>
      ),
    },
  ]

  /** 展开行：该机任务明细（只读快览） */
  const expandedRow = (r: HostRow) => {
    const s = r.scan
    if (!s) {
      return (
        <div style={{ padding: '4px 0' }}>
          <Text type="secondary">尚未扫描。点右侧「任务管理」可直接读取该机，或使用上方「扫描全部资产」批量获取。</Text>
        </div>
      )
    }
    if (s.status !== 'ok') {
      return (
        <Alert
          type={s.status === 'offline' ? 'warning' : 'error'}
          showIcon
          message={SCAN_META[s.status]?.text || '读取失败'}
          description={
            <div>
              <div>{s.message}</div>
              {s.status === 'denied' && (
                <div style={{ marginTop: 6 }}>
                  修复方式：在「资产管理」中打开该资产，填写「超级管理员用户密码」（或为 {s.sshUser || 'SSH 用户'} 配置 NOPASSWD
                  免密 sudo），保存后重新扫描即可。
                </div>
              )}
            </div>
          }
          action={
            <Space size={6}>
              <Button size="small" onClick={() => runScan([r.assetId])}>
                重试
              </Button>
              <Button
                size="small"
                icon={<MonitorOutlined />}
                style={{ color: '#38bdf8' }}
                onClick={() => openWebTerminal(r.assetId)}
              >
                Web 终端
              </Button>
            </Space>
          }
        />
      )
    }
    return (
      <div style={{ padding: '2px 0 6px' }}>
        {s.status === 'ok' && s.noCrontab && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 10 }}
            message={`用户 ${s.user} 目前还没有 crontab`}
            description="该用户在目标机上还没有任何定时任务（crontab -l 报 no crontab）。点「任务管理」新增任务时会自动创建这份 crontab。"
          />
        )}
        <div className="ct-meta" style={{ marginBottom: 10 }}>
          <Space size={20} wrap>
            <span>
              <Text type="secondary">目标机：</Text>
              <Text strong>{s.host || s.ip}</Text>
            </span>
            <span>
              <Text type="secondary">归属用户：</Text>
              <Text strong>{s.user}</Text>
            </span>
            <span>
              <Text type="secondary">读取命令：</Text>
              <Text code style={{ fontSize: 12.5 }}>
                {s.source || 'crontab -l'}
              </Text>
            </span>
            <span>
              <Text type="secondary">任务：</Text>
              <Text strong>{s.taskCount}</Text>
              <Text type="secondary">
                {' '}
                条（启用 {s.enabledCount} · 禁用 {s.disabledCount}）
              </Text>
            </span>
            {s.others?.length > 0 && (
              <span>
                <Text type="secondary">其它内容 </Text>
                <Text strong>{s.others.length}</Text>
                <Text type="secondary"> 行</Text>
              </span>
            )}
          </Space>
        </div>
        {s.tasks.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`用户 ${s.user} 的 crontab 中暂无定时任务`}
            style={{ margin: '8px 0' }}
          />
        ) : (
          <Table
            rowKey={(x) => x.lineNo}
            size="small"
            pagination={false}
            dataSource={s.tasks}
            columns={[
              {
                title: '状态',
                width: 82,
                align: 'center',
                render: (_, x) => (
                  <Tag color={x.enabled ? 'green' : 'orange'} style={{ marginInlineEnd: 0 }}>
                    {x.enabled ? '启用' : '禁用'}
                  </Tag>
                ),
              },
              {
                title: '执行计划',
                width: 230,
                render: (_, x) => (
                  <div className="ct-plan">
                    <code className="ct-code">{x.expr}</code>
                    <div className="ct-plan__desc">{x.describe || '自定义计划'}</div>
                  </div>
                ),
              },
              {
                title: '命令 / 脚本',
                render: (_, x) => <span className="ct-code ct-code--cmd">{x.command}</span>,
              },
              {
                title: '位置',
                width: 82,
                align: 'right',
                render: (_, x) => (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    第 {x.lineNo} 行
                  </Text>
                ),
              },
            ]}
          />
        )}
        <div style={{ marginTop: 10 }}>
          <Space>
            <Button size="small" type="primary" ghost icon={<FieldTimeOutlined />} onClick={() => openDrawer(r.assetId)}>
              打开任务管理（增删改查）
            </Button>
            <Button
              size="small"
              icon={<FileTextOutlined />}
              disabled={!canManage}
              onClick={async () => {
                await openDrawer(r.assetId)
                setRawOpen(true)
              }}
            >
              编辑 crontab 原文
            </Button>
            <Button
              size="small"
              icon={<MonitorOutlined />}
              style={{ color: '#38bdf8' }}
              onClick={() => openWebTerminal(r.assetId)}
            >
              打开 Web 终端
            </Button>
          </Space>
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------------ 抽屉内任务表

  const drawerColumns: ColumnsType<CrontabEntry> = [
    {
      title: '状态',
      width: 78,
      align: 'center',
      render: (_, r) => (
        <Tooltip title={r.enabled ? '点击禁用（注释该任务行）' : '点击启用'}>
          <Switch
            size="small"
            checked={r.enabled}
            loading={busyLine === r.lineNo}
            disabled={!canManage}
            onChange={(v) => toggleEnabled(r, v)}
          />
        </Tooltip>
      ),
    },
    {
      title: '执行计划',
      width: 240,
      render: (_, r) => (
        <div className="ct-plan">
          <code className="ct-code">{r.expr}</code>
          <div className="ct-plan__desc">{r.describe || '自定义计划'}</div>
        </div>
      ),
    },
    {
      title: '命令 / 脚本',
      render: (_, r) => <span className="ct-code ct-code--cmd">{r.command}</span>,
    },
    {
      title: '位置',
      width: 80,
      align: 'right',
      render: (_, r) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          第 {r.lineNo} 行
        </Text>
      ),
    },
    {
      title: '操作',
      width: 190,
      align: 'right',
      render: (_, r) => (
        <Space size={0}>
          <Button size="small" type="link" icon={<EditOutlined />} disabled={!canManage} onClick={() => openEdit(r)}>
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            icon={<CopyOutlined />}
            disabled={!canManage}
            onClick={() => openCreate({ expr: r.expr, command: r.command })}
          >
            复制
          </Button>
          <Button
            size="small"
            type="link"
            danger
            icon={<DeleteOutlined />}
            disabled={!canManage}
            loading={busyLine === r.lineNo}
            onClick={() => confirmDelete(r)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ]

  const exprBad = exprWatch ? validateCronClient(exprWatch) : ''
  const exprDesc = exprWatch && !exprBad ? describeCronClient(exprWatch) : ''
  const previewLine = `${enabledWatch === false ? '#' : ''}${String(exprWatch || '').trim()} ${escapeCronPercent(
    String(cmdWatch || '').trim(),
  )}`

  const drawerHost = hosts.find((h) => h.assetId === drawerId)

  // ------------------------------------------------------------------ 渲染

  return (
    <div style={{ maxWidth: 1560, margin: '0 auto' }}>
      {/* Hero */}
      <div className="mw-hero" style={{ marginBottom: 16 }}>
        <div className="mw-hero__glow" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <FieldTimeOutlined style={{ fontSize: 28, color: 'var(--accent)' }} />
          <div>
            <Title level={4} style={{ margin: 0 }}>
              定时任务
            </Title>
            <Text type="secondary">
              扫描全部资产上的 <Text strong>crontab -l</Text>
              （默认读 root 的 crontab），一眼看清每台虚拟机在跑什么，并直接在线增删改查。
              平台不保存任务副本 —— 看到的即机器上真实在跑的。
              进入页面直接展示<Text strong>上次手动扫描</Text>的结果；需要最新数据请点击「扫描全部资产」。
            </Text>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 26, marginTop: 16, flexWrap: 'wrap' }}>
          {[
            { label: '纳管资产', value: hosts.length, color: 'var(--accent)' },
            { label: '已扫描', value: stats.scanned, color: '#1677ff' },
            { label: '有任务的机器', value: stats.taskHosts, color: '#52c41a' },
            { label: '定时任务总数', value: stats.taskTotal, color: '#722ed1' },
            { label: '异常 / 离线', value: stats.errors, color: stats.errors ? '#ff4d4f' : 'var(--text-secondary)' },
          ].map((it) => (
            <div key={it.label}>
              <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.2, color: it.color }}>{it.value}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{it.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 工具栏 */}
      <div className="mw-cfg-toolbar">
        <Input.Search
          placeholder="搜索虚拟机名称 / IP"
          allowClear
          style={{ width: 260 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Segmented
          value={viewFilter}
          onChange={(v) => setViewFilter(v as any)}
          options={[
            { label: `全部（${hosts.length}）`, value: 'all' },
            { label: `有任务（${stats.taskHosts}）`, value: 'withTasks' },
            { label: `无任务（${stats.noTaskHosts}）`, value: 'noTasks' },
            { label: `异常（${stats.errors}）`, value: 'error' },
          ]}
        />
        <Button
          type="primary"
          icon={<RadarChartOutlined />}
          loading={scanning}
          onClick={() => runScan()}
          disabled={hosts.length === 0}
        >
          扫描全部资产
        </Button>
        <Button icon={<ReloadOutlined />} loading={hostsLoading} onClick={loadHosts}>
          刷新资产列表
        </Button>
        {scannedAt && (
          <Text type="secondary" style={{ marginLeft: 'auto', fontSize: 12 }}>
            最近扫描 {scannedAt}（本地缓存，点「扫描全部资产」刷新）
          </Text>
        )}
      </div>

      {stats.denied > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${stats.denied} 台资产提权失败，无法读取 crontab`}
          description="这些机器需要提权才能以维护用户身份执行 crontab：请在「资产管理」中为对应资产填写「超级管理员用户密码」，或在目标机为 SSH 用户配置 NOPASSWD 免密 sudo，保存后重新扫描。"
        />
      )}

      <Spin spinning={scanning} tip="正在并发扫描所有资产的 crontab，资产较多时可能需要 1～2 分钟…">
        <Table<HostRow>
          rowKey={(r) => r.assetId}
          size="middle"
          loading={hostsLoading}
          columns={columns}
          dataSource={rows}
          expandable={{ expandedRowRender: expandedRow, rowExpandable: () => true }}
          locale={{
            emptyText: (
              <Empty
                description={
                  hosts.length === 0
                    ? '暂无资产，请先到「资产管理」导入资产'
                    : stats.scanned === 0
                      ? '尚未扫描，点击上方「扫描全部资产」获取每台机器的定时任务'
                      : viewFilter === 'withTasks'
                        ? '当前没有扫描到带定时任务的机器（可切到「全部」查看所有纳管资产）'
                        : '没有符合筛选条件的虚拟机'
                }
              />
            ),
          }}
        />
      </Spin>

      {/* 任务管理抽屉 */}
      <Drawer
        title={
          <Space size={10}>
            <FieldTimeOutlined />
            <span>定时任务管理</span>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {detail?.assetName || drawerHost?.assetName || ''}
              {detail ? ` · ${detail.source || 'crontab -l'}` : ''}
            </Text>
            {detail?.runMode === 'sudo' && (
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                sudo 提权
              </Tag>
            )}
          </Space>
        }
        open={drawerId !== null}
        onClose={closeDrawer}
        width={1020}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} loading={detailLoading || detailRefreshing} onClick={() => drawerId && loadDetail(drawerId, { refresh: true })}>
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!detail || !detail.crontabAvailable || !canManage}
              onClick={() => openCreate()}
            >
              新增任务
            </Button>
            <Button
              icon={<FileTextOutlined />}
              disabled={!detail || !canManage}
              onClick={() => setRawOpen(true)}
            >
              编辑原文
            </Button>
            <Tooltip title="在新窗口打开该机器的 Web SSH 终端，方便进去看脚本、查日志">
              <Button
                icon={<MonitorOutlined />}
                style={{ color: '#38bdf8' }}
                disabled={!drawerId}
                onClick={() => openWebTerminal(drawerId || undefined)}
              >
                Web 终端
              </Button>
            </Tooltip>
          </Space>
        }
      >
        <Spin spinning={detailLoading}>
          {detailErr && !detail ? (
            <Alert
              type="error"
              showIcon
              message="读取目标机定时任务失败"
              description={detailErr}
              action={
                <Button size="small" onClick={() => drawerId && loadDetail(drawerId, { refresh: true })}>
                  重试
                </Button>
              }
            />
          ) : detail ? (
            <>
              {detailErr && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 14 }}
                  message="本次校准失败，下面显示的是最近一次读取结果"
                  description={
                    <Space direction="vertical" size={4}>
                      <Text type="secondary" style={{ fontSize: 12.5 }}>
                        {detailErr}
                      </Text>
                      <Button
                        size="small"
                        type="link"
                        style={{ padding: 0, height: 'auto' }}
                        onClick={() => drawerId && loadDetail(drawerId, { refresh: true })}
                      >
                        重新读取
                      </Button>
                    </Space>
                  }
                />
              )}
              {detail.noCrontab && (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 14 }}
                  message={`用户 ${detail.user} 目前还没有 crontab`}
                  description={`目标机执行 ${detail.source || 'crontab -l'} 返回 no crontab，说明这个用户当前没有任何定时任务。点右上角「新增任务」会自动创建这份 crontab。`}
                />
              )}

              <div className="ct-meta" style={{ marginBottom: 14 }}>
                <Space size={20} wrap>
                  <span>
                    <Text type="secondary">目标机：</Text>
                    <Text strong>{detail.host || detail.ip}</Text>
                  </span>
                  <span>
                    <Text type="secondary">归属用户：</Text>
                    <Text strong>{detail.user}</Text>
                    {detail.runMode === 'sudo' && (
                      <Tag color="blue" style={{ marginLeft: 6 }}>
                        sudo 提权
                      </Tag>
                    )}
                  </span>
                  <span>
                    <Text type="secondary">读取命令：</Text>
                    <Text code style={{ fontSize: 12.5 }}>
                      {detail.source || 'crontab -l'}
                    </Text>
                  </span>
                  <span>
                    <Text type="secondary">SSH 用户：</Text>
                    <Text>{detail.sshUser}</Text>
                  </span>
                  <span>
                    <Text type="secondary">任务：</Text>
                    <Text strong>{detail.taskCount}</Text>
                    <Text type="secondary">
                      {' '}
                      条（启用 {detail.enabledCount} · 禁用 {detail.disabledCount}）
                    </Text>
                  </span>
                  <span>
                    <Text type="secondary">读取于 </Text>
                    <Text>{detail.readAt}</Text>
                    {detailRefreshing && (
                      <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                        <Spin size="small" style={{ marginRight: 6 }} />
                        正在校准…
                      </Text>
                    )}
                  </span>
                </Space>
              </div>

              <Table
                rowKey={(r) => r.lineNo}
                size="middle"
                columns={drawerColumns}
                dataSource={detail.tasks}
                pagination={false}
                locale={{
                  emptyText: (
                    <Empty
                      description={`用户 ${detail.user} 的 crontab 中暂无定时任务，点右上角「新增任务」创建`}
                    />
                  ),
                }}
              />

              {detail.others.length > 0 && (
                <Collapse
                  ghost
                  style={{ marginTop: 12 }}
                  items={[
                    {
                      key: 'others',
                      label: (
                        <Text type="secondary" style={{ fontSize: 12.5 }}>
                          其它内容（注释 / 环境变量 / 空行，共 {detail.others.length} 行，平台不做修改）
                        </Text>
                      ),
                      children: (
                        <div className="ct-others">
                          {detail.others.map((o) => (
                            <div key={o.lineNo} className="ct-others__row">
                              <span className="ct-others__no">{o.lineNo}</span>
                              <Tag color={KIND_META[o.kind]?.color} style={{ marginRight: 8, flex: 'none' }}>
                                {KIND_META[o.kind]?.text || o.kind}
                              </Tag>
                              <code className="ct-code ct-code--line">{o.raw || '（空行）'}</code>
                            </div>
                          ))}
                        </div>
                      ),
                    },
                  ]}
                />
              )}
            </>
          ) : null}
        </Spin>
      </Drawer>

      {/* 任务编辑弹窗 */}
      <Modal
        title={editorMode === 'edit' ? `编辑定时任务（目标机第 ${editing?.lineNo} 行）` : '新增定时任务'}
        open={editorOpen}
        onCancel={() => setEditorOpen(false)}
        onOk={submitTask}
        confirmLoading={saving}
        okText={editorMode === 'edit' ? '保存并同步' : '创建并同步'}
        cancelText="取消"
        width={700}
        /* 防误触丢失：仅底部「取消 / 确定」可关闭，点遮罩、按 ESC、点右上角 × 均不响应 */
        maskClosable={false}
        keyboard={false}
        closable={false}
        // 从抽屉内部打开，必须显式抬层级，否则会被后挂载的抽屉压住
        zIndex={Z_NESTED}
        forceRender
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item
            name="expr"
            label="执行计划（cron 表达式）"
            rules={[
              { required: true, message: '请填写 cron 表达式' },
              {
                validator: (_, v) => {
                  const m = validateCronClient(v || '')
                  return m ? Promise.reject(new Error(m)) : Promise.resolve()
                },
              },
            ]}
          >
            <AutoComplete
              options={CRON_PRESETS.map((p) => ({ value: p.expr, label: `${p.label}　　${p.expr}` }))}
              placeholder="分 时 日 月 周，例如 0 2 * * *；也可用 @daily 等宏"
              filterOption={(input, option) =>
                String((option as any)?.label || '')
                  .toLowerCase()
                  .includes(String(input).toLowerCase())
              }
            />
          </Form.Item>

          {exprDesc && (
            <div className="ct-hint ct-hint--ok" style={{ marginTop: -12 }}>
              <ThunderboltOutlined /> 将按「{exprDesc}」执行
            </div>
          )}
          {exprBad && exprWatch && (
            <div className="ct-hint ct-hint--err" style={{ marginTop: -12 }}>
              <ExclamationCircleOutlined /> {exprBad}
            </div>
          )}

          <Form.Item
            name="command"
            label="命令 / 脚本"
            rules={[{ required: true, message: '请填写要执行的命令 / 脚本' }]}
          >
            <Input.TextArea
              rows={4}
              placeholder="/bin/bash /data/scripts/backup.sh >> /var/log/backup.log 2>&1"
              style={{ fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: 12.5 }}
            />
          </Form.Item>

          <Form.Item name="enabled" label="是否启用" valuePropName="checked" initialValue={true} style={{ marginBottom: 14 }}>
            <Switch checkedChildren="启用" unCheckedChildren="禁用" />
          </Form.Item>

          <div className="ct-preview">
            <div className="ct-preview__title">
              <ThunderboltOutlined /> 将写入用户 {detail?.user || 'root'} 的 crontab（{detail?.source || 'crontab -l'}）
            </div>
            <pre className="ct-pre">{previewLine.trim()}</pre>
          </div>
        </Form>
      </Modal>

      {/* 原文编辑抽屉 */}
      <Drawer
        title={`编辑 crontab 原文（${detail?.host || ''} · ${detail?.user || 'root'}）`}
        open={rawOpen}
        onClose={() => setRawOpen(false)}
        width={820}
        // 从抽屉内部打开，层级必须高于主抽屉
        zIndex={Z_NESTED}
        extra={
          <Space>
            <Button onClick={() => setRawText(detail?.content || '')} disabled={!detail}>
              重置为当前内容
            </Button>
            <Button type="primary" icon={<SyncOutlined />} loading={rawSaving} onClick={saveRaw}>
              保存并同步
            </Button>
          </Space>
        }
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="直接编辑整份 crontab（crontab -l 的内容）"
          description="保存时会先用读取时的原文与远端逐字节比对，若期间已被改动会拒绝写入；写入前自动备份原内容。"
        />
        <div className="nx-editor">
          <Input.TextArea value={rawText} onChange={(e) => setRawText(e.target.value)} rows={26} spellCheck={false} />
        </div>
      </Drawer>
    </div>
  )
}
