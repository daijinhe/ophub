// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Divider,
  Empty,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  AlertOutlined,
  BarChartOutlined,
  DeleteOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  FundOutlined,
  HddOutlined,
  HistoryOutlined,
  ProfileOutlined,
  ReloadOutlined,
  SaveOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import dayjs, { type Dayjs } from 'dayjs'
import PromReportRecords from './PromReportRecords'
import PromReportTemplates from './PromReportTemplates'
import {
  createPromReportTemplate,
  deletePromReportTemplate,
  listPromDataSources,
  listPromProjects,
  listPromReportTemplates,
  promGenerateReport,
  updatePromReportTemplate,
  type PromDataSource,
  type PromProject,
  type PromReport,
  type PromReportRow,
  type PromReportTemplate,
} from '../api/prometheus'
// Excel 产出与健康评分抽到公共模块：「报告记录」页回看时要用同一套口径重新导出
import {
  exportPromReportXlsx,
  healthScore,
  isScoped,
  promReportFileName,
  riskLevel,
  scopeTextOf,
  thOf,
} from '../utils/promReportExcel'
import { useAuth } from '../store/AuthContext'

const { Title, Text } = Typography

function errMsg(e: any, fallback = '操作失败'): string {
  return e?.response?.data?.msg || e?.message || fallback
}

type Period = 'month' | 'quarter' | 'year'

const PERIOD_LABEL: Record<Period, string> = {
  month: '月度',
  quarter: '季度',
  year: '年度',
}

function usageColor(v: number): string {
  if (v >= 90) return 'red'
  if (v >= 80) return 'orange'
  return 'green'
}

function fmtPct(v: number | undefined | null): string {
  if (v === undefined || v === null) return '—'
  return `${v.toFixed(1)}%`
}

/**
 * Prometheus 监控报表
 *
 * v1.7.38 起支持**按项目出报告**：每个人负责的项目不同，可以：
 *   1. 选一个或多个项目（多选 / 单选都行）→ 只统计这些项目的主机；
 *   2. 把这套「数据源 + 项目范围 + 周期」存成**报表模板**，下次一键复用；
 *   3. 按模板生成自己的季度报告，报告与归档记录都会写明覆盖了哪些项目。
 *
 * 不选项目 = 不限项目，覆盖数据源下全部主机（与 v1.7.37 及以前口径一致）。
 */
function PromReportGenerate({
  onOpenArchived,
  onArchived,
  onTemplatesChanged,
  tplReq,
  reloadSeq = 0,
}: {
  /** 点归档提示里的「查看」→ 由外层切到「报告记录」页签并带上 ?view= */
  onOpenArchived?: (id: number) => void
  /** 本次生成已归档（写入「报告记录」）→ 通知外层让报告记录页签重拉，否则切过去看不到刚生成的那条 */
  onArchived?: () => void
  /** 本页「另存为模板」建/改/删了模板 → 通知外层让「报表模板」页签重拉 */
  onTemplatesChanged?: () => void
  /**
   * 外层（报表模板页签）带着模板跳过来。用「请求序号」而不是裸 id：
   * 同一个模板被点第二次也要能再次生效，裸 id 相同的话 effect 不会触发。
   */
  tplReq?: { id: number; seq: number } | null
  /**
   * 模板列表的刷新信号。三个页签都是 forceRender，本组件只挂载一次，
   * 「报表模板」页签里新建 / 改名 / 删除模板后这里收不到任何通知 ——
   * 症状就是「刚建的模板在下拉里找不到，刷新浏览器才有」。
   * 外层每次模板集合可能变化就把这个序号 +1，这里据此重新拉取。
   */
  reloadSeq?: number
} = {}) {
  const { hasPerm } = useAuth()
  const [dss, setDss] = useState<PromDataSource[]>([])
  const [ds, setDs] = useState<number | null>(null)
  const [period, setPeriod] = useState<Period>('month')
  const [ref, setRef] = useState<Dayjs | null>(dayjs())
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<PromReport | null>(null)
  // 归档结果（v1.7.36）：生成即写入「报告记录」
  const [archivedId, setArchivedId] = useState<number | null>(null)

  /* ---------- 项目范围（v1.7.38） ---------- */
  const [projects, setProjects] = useState<PromProject[]>([])
  const [projLoading, setProjLoading] = useState(false)
  const [systems, setSystems] = useState<string[]>([])
  const [projMeta, setProjMeta] = useState<{ targets: number; unlabeled: number; dsName: string } | null>(null)

  /* ---------- 报表模板（v1.7.38） ---------- */
  const [templates, setTemplates] = useState<PromReportTemplate[]>([])
  const [myUid, setMyUid] = useState<number>(0)
  const [templateId, setTemplateId] = useState<number | undefined>(undefined)
  // 选了模板后又改了范围 = 不再是那个模板的口径，生成时不再挂模板名（避免归档记录张冠李戴）
  const [tplDirty, setTplDirty] = useState(false)
  const [tplModal, setTplModal] = useState<{ open: boolean; mode: 'create' | 'overwrite'; id?: number }>({
    open: false,
    mode: 'create',
  })
  const [tplForm, setTplForm] = useState<{ name: string; remark: string; shared: boolean }>({
    name: '',
    remark: '',
    shared: false,
  })
  const [tplSaving, setTplSaving] = useState(false)

  // 深链：从「报表模板」页点「生成报告」带过来的 ?template=<id>。
  // 必须在挂载时**同步**读出来：数据源初始化要据此让位 —— 否则「默认选第一个数据源」
  // 会和模板的数据源互相覆盖，最终用哪个取决于两个请求谁先返回（随机踩坑）。
  //
  // 注意这里是 useRef(...).current 而不是 useMemo：参数要被清理掉（见下面的 effect），
  // 若值继续从 searchParams 派生，清理动作会让它变成 0，于是下面那个
  // `[deepLinkTpl]` 依赖的数据源初始化 effect 二次执行、把模板的数据源覆盖回第一个 ——
  // 表面症状是「从模板进来，数据源却不对」。所以**只在首次渲染读一次并固化**。
  const [sp, setSp] = useSearchParams()
  const deepLinkTpl = useRef(Number(sp.get('template') || 0)).current
  const deepLinkApplied = useRef(false)
  const deepLinkCleaned = useRef(false)

  // 参数用掉即清：否则刷新 / 回退会再次套用模板，把用户手动改过的选择静默覆盖回去。
  useEffect(() => {
    if (deepLinkCleaned.current || !deepLinkTpl) return
    deepLinkCleaned.current = true
    const next = new URLSearchParams(sp)
    next.delete('template')
    setSp(next, { replace: true })
  }, [deepLinkTpl, sp, setSp])

  useEffect(() => {
    listPromDataSources()
      .then((r) => {
        const usable = (r.list || []).filter((x) => x.enabled === 1)
        setDss(usable)
        if (usable.length > 0 && deepLinkTpl === 0) setDs(usable[0].id)
      })
      .catch((e) => message.error('加载数据源失败:' + errMsg(e)))
  }, [deepLinkTpl])

  const loadTemplates = useCallback(async () => {
    try {
      const r = await listPromReportTemplates()
      const list = r.list || []
      setTemplates(list)
      setMyUid(r.uid || 0)
      // 选中的模板可能已被删除（在「报表模板」页签删的，本组件此前不知情）→ 清掉选中。
      // 不清的话 Select 找不到对应 option 会退化成显示一个裸数字 id，比空着更让人困惑。
      setTemplateId((cur) => (cur && !list.some((t) => t.id === cur) ? undefined : cur))
    } catch (e) {
      // 模板加载失败不该挡住出报告：只是没有模板可选用。
      // 这里**不动** templateId —— 加载失败不等于模板被删，清掉会让用户白丢选择。
      message.warning('加载报表模板失败:' + errMsg(e))
      setTemplates([])
    }
  }, [])

  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  // 「报表模板」页签里增删改模板后重新拉取（reloadSeq 由外层递增）。
  // 只在序号真的变化时才请求，挂载首帧不重复打一次（首次由上面的 effect 负责）。
  const lastReloadSeq = useRef(reloadSeq)
  useEffect(() => {
    if (reloadSeq === lastReloadSeq.current) return
    lastReloadSeq.current = reloadSeq
    loadTemplates()
  }, [reloadSeq, loadTemplates])

  /** 拉当前数据源的项目清单（项目范围的唯一来源，避免手输项目名写错） */
  const loadProjects = useCallback(async (dsId: number | null) => {
    if (!dsId) {
      setProjects([])
      setProjMeta(null)
      return
    }
    setProjLoading(true)
    try {
      const r = await listPromProjects(dsId)
      setProjects(r.list || [])
      setProjMeta({ targets: r.targets || 0, unlabeled: r.unlabeled || 0, dsName: r.dsName || '' })
    } catch (e) {
      message.error('加载项目清单失败:' + errMsg(e))
      setProjects([])
      setProjMeta(null)
    } finally {
      setProjLoading(false)
    }
  }, [])

  useEffect(() => {
    loadProjects(ds)
  }, [ds, loadProjects])

  // 切数据源时清空已选项目：项目名是按数据源的 target 来的，跨源沿用会静默查出 0 台
  const onDsChange = useCallback(
    (v: number) => {
      setDs(v)
      setSystems([])
      setTemplateId(undefined)
      setTplDirty(false)
      setReport(null)
      setArchivedId(null)
    },
    [],
  )

  const curTemplate = useMemo(
    () => templates.find((t) => t.id === templateId),
    [templates, templateId],
  )

  /** 套用模板：数据源 / 周期 / 项目范围一起带出来 */
  const applyTemplate = useCallback(
    (id: number | undefined) => {
      setTemplateId(id)
      setTplDirty(false)
      if (!id) return
      const t = templates.find((x) => x.id === id)
      if (!t) return
      setDs(t.dsId)
      setPeriod(t.period)
      setSystems(t.systems || [])
      setReport(null)
      setArchivedId(null)
    },
    [templates],
  )

  // 模板列表到位后套用深链模板（套用会一并设置数据源 / 周期 / 项目范围）。
  // 只套一次：之后模板列表刷新（如另存为后重新加载）不该覆盖用户当前的调整。
  useEffect(() => {
    if (deepLinkApplied.current || !deepLinkTpl || templates.length === 0) return
    deepLinkApplied.current = true
    if (templates.some((t) => t.id === deepLinkTpl)) {
      applyTemplate(deepLinkTpl)
    } else {
      message.warning('链接里的报表模板不存在或已被删除')
    }
  }, [deepLinkTpl, templates, applyTemplate])

  // 页内「报表模板」页签点「生成报告」→ 就地套用该模板（不开新标签页）。
  // 同样要等模板列表到位，否则找不到模板会被误报成「已删除」。
  const lastTplSeq = useRef(0)
  useEffect(() => {
    if (!tplReq || tplReq.seq === lastTplSeq.current || templates.length === 0) return
    lastTplSeq.current = tplReq.seq
    if (templates.some((t) => t.id === tplReq.id)) {
      applyTemplate(tplReq.id)
      message.success('已套用该模板的项目范围与周期')
    } else {
      message.warning('该报表模板不存在或已被删除')
    }
  }, [tplReq, templates, applyTemplate])

  // 已选项目在当前数据源里已不存在的（项目改名 / target 下线）——必须提示，
  // 否则用户以为报告覆盖了 5 个项目，实际只统计到 3 个
  const missingSystems = useMemo(() => {
    if (systems.length === 0 || projects.length === 0) return []
    const set = new Set(projects.map((p) => p.name))
    return systems.filter((s) => !set.has(s))
  }, [systems, projects])

  const selectedHosts = useMemo(() => {
    if (systems.length === 0) return projMeta?.targets ?? 0
    const m = new Map(projects.map((p) => [p.name, p.hosts]))
    return systems.reduce((a, s) => a + (m.get(s) || 0), 0)
  }, [systems, projects, projMeta])

  const projectOptions = useMemo(
    () =>
      projects.map((p) => ({
        value: p.name,
        label: `${p.name}（${p.hosts} 台${p.offline > 0 ? ` · 离线 ${p.offline}` : ''}）`,
      })),
    [projects],
  )

  const markDirty = useCallback(() => {
    if (templateId) setTplDirty(true)
  }, [templateId])

  const generate = useCallback(async () => {
    if (!ds) {
      message.warning('请先选择数据源')
      return
    }
    if (systems.length > 0 && selectedHosts === 0) {
      message.warning('所选项目在当前数据源里没有采集到任何主机，请检查项目选择或数据源')
    }
    setLoading(true)
    setArchivedId(null)
    try {
      // systems 每次都**显式**传（空数组=全集群口径）：
      // 不传的话后端会沿用模板范围，与页面上看到的选择不一致
      const r = await promGenerateReport(
        ds,
        period,
        ref ? ref.format('YYYY-MM-DD') : undefined,
        undefined,
        systems,
        tplDirty ? undefined : templateId,
      )
      const rep = r.report
      setReport(rep)
      if (r.id) {
        setArchivedId(r.id)
        // 让「报告记录」页签重拉：它是独立挂载的，不通知就看不到这条新归档
        onArchived?.()
      }
      if (!rep.rows || rep.rows.length === 0) {
        // 后端会给出「没数据」的具体原因（是没接 node_exporter，还是项目没 target）
        message.warning(
          rep.hint ||
            `${PERIOD_LABEL[period]}窗口内没有采到任何主机数据（确认 node_exporter 已接入且 Prometheus 有历史数据）`,
        )
      } else if (r.id) {
        const scopeTip = rep.systems?.length ? ` · ${rep.systems.length} 个项目` : ''
        message.success(
          `已生成 ${rep.periodCN} 报告：${rep.hostCount} 台主机${scopeTip}，并归档到「报告记录」#${r.id}`,
        )
      } else {
        message.success(`已生成 ${rep.periodCN} 报告：${rep.hostCount} 台主机`)
      }
      if (r.msg && !r.id) message.warning(r.msg)
    } catch (e) {
      message.error(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [ds, period, ref, systems, templateId, tplDirty, selectedHosts, onArchived])

  const refPicker = useMemo(() => {
    if (period === 'month') return <DatePicker picker="month" value={ref} onChange={setRef} allowClear={false} />
    if (period === 'quarter') return <DatePicker picker="quarter" value={ref} onChange={setRef} allowClear={false} />
    return <DatePicker picker="year" value={ref} onChange={setRef} allowClear={false} />
  }, [period, ref])

  /* ---------- 模板保存 ---------- */
  const openSaveAsNew = useCallback(() => {
    if (!ds) {
      message.warning('请先选择数据源')
      return
    }
    if (systems.length === 0) {
      message.warning('请先选择要纳入模板的项目（模板必须包含至少一个项目）')
      return
    }
    const base = curTemplate?.name ? `${curTemplate.name}-副本` : `${projects[0]?.name || '监控'}报告模板`
    setTplForm({ name: base, remark: curTemplate?.remark || '', shared: curTemplate?.shared === 1 })
    setTplModal({ open: true, mode: 'create' })
  }, [ds, systems, curTemplate, projects])

  const openOverwrite = useCallback(() => {
    if (!curTemplate) return
    setTplForm({ name: curTemplate.name, remark: curTemplate.remark || '', shared: curTemplate.shared === 1 })
    setTplModal({ open: true, mode: 'overwrite', id: curTemplate.id })
  }, [curTemplate])

  const submitTemplate = useCallback(async () => {
    const name = tplForm.name.trim()
    if (!name) {
      message.warning('请填写模板名称')
      return
    }
    if (!ds) {
      message.warning('请先选择数据源')
      return
    }
    if (systems.length === 0) {
      message.warning('模板必须包含至少一个项目')
      return
    }
    setTplSaving(true)
    try {
      const body = {
        name,
        dsId: ds,
        period,
        systems,
        remark: tplForm.remark.trim(),
        shared: tplForm.shared ? 1 : 0,
      }
      if (tplModal.mode === 'overwrite' && tplModal.id) {
        const r = await updatePromReportTemplate(tplModal.id, body)
        message.success(`模板「${r.template.name}」已更新`)
        setTplModal({ open: false, mode: 'create' })
        await loadTemplates()
        setTplDirty(false)
      } else {
        const r = await createPromReportTemplate(body)
        message.success(`模板「${r.template.name}」已创建`)
        setTplModal({ open: false, mode: 'create' })
        await loadTemplates()
        setTemplateId(r.template.id)
        setTplDirty(false)
      }
      // 通知外层「报表模板」页签重拉（本页自己那份已在上面的 loadTemplates 里刷新）。
      // 外层的版本号同时也会回到本组件再拉一次，多一个轻量 GET，换的是两个页签永远一致 ——
      // 反之（只刷自己不通知）就是用户反馈的「刚建的模板在模板页 / 下拉里找不到」。
      onTemplatesChanged?.()
    } catch (e) {
      message.error(errMsg(e))
    } finally {
      setTplSaving(false)
    }
  }, [tplForm, ds, period, systems, tplModal, loadTemplates, onTemplatesChanged])

  const removeTemplate = useCallback(() => {
    if (!curTemplate) return
    Modal.confirm({
      title: '删除报表模板',
      content: `确认删除模板「${curTemplate.name}」？已归档的历史报告不受影响，但模板本身无法恢复。`,
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deletePromReportTemplate(curTemplate.id)
          message.success('模板已删除')
          setTemplateId(undefined)
          setTplDirty(false)
          await loadTemplates()
          // 同样通知「报表模板」页签：它那份列表里还留着刚删掉的这条
          onTemplatesChanged?.()
        } catch (e) {
          message.error(errMsg(e))
        }
      },
    })
  }, [curTemplate, loadTemplates, onTemplatesChanged])

  /* ---------- 图表 ---------- */
  const barOption = useMemo(() => {
    if (!report || !report.rows.length) return null
    const rows = report.rows.slice(0, 15)
    const names = rows.map((r) => r.hostname || r.instance)
    return {
      grid: { left: 56, right: 16, top: 40, bottom: 90 },
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { fontSize: 11 } },
      xAxis: {
        type: 'category',
        data: names,
        axisLabel: { rotate: 40, fontSize: 10, interval: 0 },
      },
      yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
      series: [
        {
          name: 'CPU 均值',
          type: 'bar',
          stack: 'x',
          data: rows.map((r) => r.cpuAvg),
          itemStyle: { color: '#38bdf8' },
        },
        {
          name: 'CPU 峰值',
          type: 'bar',
          data: rows.map((r) => r.cpuMax),
          itemStyle: { color: '#0ea5e9' },
        },
        {
          name: '内存均值',
          type: 'bar',
          data: rows.map((r) => r.memAvg),
          itemStyle: { color: '#a78bfa' },
        },
        {
          name: '内存峰值',
          type: 'bar',
          data: rows.map((r) => r.memMax),
          itemStyle: { color: '#8b5cf6' },
        },
        {
          name: '磁盘均值',
          type: 'bar',
          data: rows.map((r) => r.diskAvg),
          itemStyle: { color: '#34d399' },
        },
        {
          name: '磁盘峰值',
          type: 'bar',
          data: rows.map((r) => r.diskMax),
          itemStyle: { color: '#10b981' },
        },
      ],
    } as any
  }, [report])

  const trendOption = useMemo(() => {
    if (!report || !report.trend.length) return null
    const scopeCN = isScoped(report) ? '所选项目' : '全集群'
    return {
      grid: { left: 56, right: 16, top: 34, bottom: 44 },
      tooltip: { trigger: 'axis' },
      legend: { top: 0, textStyle: { fontSize: 11 } },
      xAxis: {
        type: 'category',
        data: report.trend.map((p) => dayjs(p.ts * 1000).format('MM-DD HH:mm')),
        axisLabel: { fontSize: 10 },
      },
      yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
      series: [
        {
          name: `CPU 使用率（${scopeCN}均值）`,
          type: 'line',
          showSymbol: false,
          data: report.trend.map((p) => p.cpu ?? null),
          lineStyle: { color: '#38bdf8', width: 1.5 },
          areaStyle: { color: 'rgba(56,189,248,0.12)' },
        },
        {
          name: `内存使用率（${scopeCN}均值）`,
          type: 'line',
          showSymbol: false,
          data: report.trend.map((p) => p.mem ?? null),
          lineStyle: { color: '#a78bfa', width: 1.5 },
          areaStyle: { color: 'rgba(167,139,250,0.12)' },
        },
        {
          name: `磁盘使用率（${scopeCN}均值）`,
          type: 'line',
          showSymbol: false,
          data: report.trend.map((p) => p.disk ?? null),
          lineStyle: { color: '#34d399', width: 1.5 },
          areaStyle: { color: 'rgba(52,211,153,0.12)' },
        },
      ],
    } as any
  }, [report])

  /* ---------- 导出 Excel：实测字节 + 逐级降级，保证 ≤5MB ---------- */
  const exportXlsx = useCallback(() => {
    if (!report) return
    const dsName = dss.find((x) => x.id === ds)?.name || '—'
    try {
      const file = promReportFileName({
        period: report.period,
        periodCN: report.periodCN,
        start: report.start,
        templateName: curTemplate?.name,
      })
      const r = exportPromReportXlsx(report, dsName, file)
      if (r.ok) {
        message.success(`导出成功（${(r.bytes / 1024 / 1024).toFixed(2)}MB）${r.tip ? ' · ' + r.tip : ''}`)
      } else {
        message.error('报告数据过大，已尝试全部降级策略仍超过 5MB，请缩小周期或联系管理员')
      }
    } catch (e: any) {
      message.error('导出失败:' + (e?.message || e))
    }
  }, [report, ds, dss, curTemplate])

  /* ---------- 明细表（列顺序与导出 Excel 完全一致） ---------- */
  const th = useMemo(() => thOf(report?.config), [report?.config])
  const hs = useMemo(
    () => (report ? healthScore(report.rows, report.fleet, th) : null),
    [report, th],
  )
  const columns = useMemo(
    () => [
      { title: '所属部门', dataIndex: 'department', width: 110, ellipsis: true, render: (v: string) => v || '—' },
      { title: '项目名', dataIndex: 'system', width: 130, ellipsis: true, render: (v: string) => v || '—' },
      { title: '虚拟机IPv4', dataIndex: 'instance', width: 160, ellipsis: true },
      { title: '环境', dataIndex: 'env', width: 100, ellipsis: true, render: (v: string) => v || '—' },
      { title: '业务环境', dataIndex: 'deployserver', width: 120, ellipsis: true, render: (v: string) => v || '—' },
      {
        title: 'CPU 均值',
        dataIndex: 'cpuAvg',
        width: 100,
        render: (v: number) => fmtPct(v),
      },
      {
        title: 'CPU 峰值',
        dataIndex: 'cpuMax',
        width: 100,
        render: (v: number) => <Tag color={usageColor(v)} style={{ margin: 0 }}>{fmtPct(v)}</Tag>,
      },
      { title: '内存均值', dataIndex: 'memAvg', width: 100, render: (v: number) => fmtPct(v) },
      {
        title: '内存峰值',
        dataIndex: 'memMax',
        width: 100,
        render: (v: number) => <Tag color={usageColor(v)} style={{ margin: 0 }}>{fmtPct(v)}</Tag>,
      },
      { title: '磁盘均值', dataIndex: 'diskAvg', width: 100, render: (v: number) => fmtPct(v) },
      {
        title: '磁盘峰值',
        dataIndex: 'diskMax',
        width: 100,
        render: (v: number) => <Tag color={usageColor(v)} style={{ margin: 0 }}>{fmtPct(v)}</Tag>,
      },
      {
        title: '风险',
        key: 'risk',
        width: 80,
        render: (_: any, r: PromReportRow) => {
          const lv = riskLevel(r, th)
          return (
            <Tag color={lv === '高' ? 'red' : lv === '中' ? 'orange' : 'green'} style={{ margin: 0 }}>
              {lv}
            </Tag>
          )
        },
      },
    ],
    [th],
  )

  return (
    <div>
      {archivedId && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          message={`本次报告已归档为「报告记录 #${archivedId}」`}
          description="可在「报告记录」页签里随时回看这份报告并重新导出 Excel —— 数据是生成时冻结的快照，不会随后续采集变化。"
          action={
            <Button
              size="small"
              onClick={() => {
                if (onOpenArchived) onOpenArchived(archivedId)
                else window.open(`/prom/report-records?view=${archivedId}`, '_blank')
              }}
            >
              查看
            </Button>
          }
        />
      )}

      {/* 生成条件：模板 + 数据源 + 周期 + 项目范围 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Row gutter={[8, 8]} align="middle">
          <Col>
            <Select
              style={{ minWidth: 240 }}
              placeholder="选择报表模板（可选）"
              allowClear
              value={templateId}
              onChange={(v) => applyTemplate(v)}
              options={templates.map((t) => ({
                value: t.id,
                // 别人的共享模板标出创建人 —— 否则列表里几个同名模板根本分不清哪个是自己的
                label: `${t.name}（${t.systems?.length || 0} 个项目 · ${PERIOD_LABEL[t.period]}${
                  t.ownerId === myUid ? '' : ` · ${t.ownerName || '他人'}`
                }）`,
              }))}
            />
          </Col>
          {hasPerm('prom:report:create') && (
            <Col>
              <Tooltip title="把当前的数据源 / 项目范围 / 周期存成模板，下次一键复用">
                <Button icon={<SaveOutlined />} onClick={openSaveAsNew}>
                  另存为模板
                </Button>
              </Tooltip>
            </Col>
          )}
          {curTemplate && hasPerm('prom:report:update') && (
            <Col>
              <Tooltip title={curTemplate.canEdit ? '用当前设置覆盖该模板' : '只有创建人可修改该模板'}>
                <Button disabled={!curTemplate.canEdit} onClick={openOverwrite}>
                  更新模板
                </Button>
              </Tooltip>
            </Col>
          )}
          {curTemplate && hasPerm('prom:report:delete') && (
            <Col>
              <Button danger disabled={!curTemplate.canEdit} icon={<DeleteOutlined />} onClick={removeTemplate}>
                删除模板
              </Button>
            </Col>
          )}
        </Row>

        <Divider style={{ margin: '10px 0' }} />

        <Row gutter={[8, 8]} align="middle">
          <Col>
            <Select
              style={{ minWidth: 200 }}
              placeholder="选择数据源"
              value={ds}
              onChange={onDsChange}
              options={dss.map((d) => ({ value: d.id, label: `${d.name}（${d.url}）` }))}
            />
          </Col>
          <Col>
            <Select
              style={{ width: 110 }}
              value={period}
              onChange={(v) => {
                setPeriod(v)
                markDirty()
              }}
              options={(Object.keys(PERIOD_LABEL) as Period[]).map((p) => ({
                value: p,
                label: PERIOD_LABEL[p],
              }))}
            />
          </Col>
          <Col>{refPicker}</Col>
          <Col>
            <Space>
              {hasPerm('prom:report:create') && (
                <Button type="primary" icon={<FundOutlined />} loading={loading} onClick={generate}>
                  生成报告
                </Button>
              )}
              <Button icon={<FileExcelOutlined />} disabled={!report} onClick={exportXlsx}>
                导出 Excel
              </Button>
            </Space>
          </Col>
        </Row>

        <Divider style={{ margin: '10px 0' }} />

        {/* 项目范围 */}
        <Row gutter={[8, 8]} align="middle">
          <Col flex="auto">
            <Select
              mode="multiple"
              allowClear
              style={{ width: '100%' }}
              placeholder="选择项目（可多选；不选 = 统计数据源下全部主机）"
              value={systems}
              onChange={(v) => {
                setSystems(v)
                markDirty()
              }}
              options={projectOptions}
              optionFilterProp="label"
              maxTagCount="responsive"
              loading={projLoading}
              notFoundContent={projLoading ? <Spin size="small" /> : '该数据源下没有带 system 标签的采集目标'}
            />
          </Col>
          <Col>
            <Space>
              <Checkbox
                checked={systems.length > 0 && systems.length === projects.length}
                indeterminate={systems.length > 0 && systems.length < projects.length}
                disabled={projects.length === 0}
                onChange={(e) => {
                  setSystems(e.target.checked ? projects.map((p) => p.name) : [])
                  markDirty()
                }}
              >
                全选
              </Checkbox>
              <Button
                size="small"
                disabled={systems.length === 0}
                onClick={() => {
                  setSystems([])
                  markDirty()
                }}
              >
                清空
              </Button>
              <Tooltip title="重新从 Prometheus 拉取项目清单（新建/改名项目后点这里）">
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={projLoading}
                  onClick={() => loadProjects(ds)}
                />
              </Tooltip>
            </Space>
          </Col>
        </Row>

        <div style={{ marginTop: 8, fontSize: 12, color: '#64748b' }}>
          {systems.length === 0 ? (
            <span>
              <Tag color="default">全部项目</Tag>
              不限项目：本次报告将统计数据源下全部主机
              {projMeta ? `（共 ${projMeta.targets} 台采集目标）` : ''}
            </span>
          ) : (
            <span>
              <Tag color="blue">已选 {systems.length} 个项目</Tag>
              覆盖 {selectedHosts} 台主机
              {projMeta ? ` / 数据源共 ${projMeta.targets} 台采集目标` : ''}
              {tplDirty && (
                <Tag color="orange" style={{ marginLeft: 8 }}>
                  已基于模板修改，生成时不再关联「{curTemplate?.name}」
                </Tag>
              )}
            </span>
          )}
        </div>

        {missingSystems.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 8 }}
            message={`有 ${missingSystems.length} 个已选项目在当前数据源里找不到：${missingSystems.join('、')}`}
            description="这些项目将被统计为 0 台主机。可能是项目已改名、target 已下线，或模板来自另一个数据源 —— 请重新选择。"
          />
        )}

        {projMeta && projMeta.unlabeled > 0 && (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 8 }}
            message={`数据源里有 ${projMeta.unlabeled} 台主机的采集目标没有 system 标签`}
            description="这类主机不属于任何项目，按项目出报告时不会被包含在内；如需纳入，请在 Prometheus 的 target 上补 system 标签。"
          />
        )}
      </Card>

      {loading ? (
        <Card size="small">
          <div style={{ padding: 64, textAlign: 'center' }}>
            <Spin tip="正在聚合历史数据（区间越长耗时越久）…" />
          </div>
        </Card>
      ) : !report ? (
        <Card size="small">
          <Empty
            description={
              systems.length > 0
                ? `已选 ${systems.length} 个项目，选好周期后点击「生成报告」`
                : '选择数据源与周期后点击「生成报告」（要只看自己的项目，先在上方选项目或套用模板）'
            }
            style={{ padding: 60 }}
          />
        </Card>
      ) : (
        <>
          {/* 报告范围 */}
          <Alert
            type={isScoped(report) ? 'info' : 'warning'}
            showIcon
            style={{ marginBottom: 12 }}
            message={`报告范围：${scopeTextOf(report)}`}
            description={
              isScoped(report)
                ? `本报告只统计上述项目的主机（${report.hostCount} 台），不含数据源内其他项目。${
                    report.scopeTargets > report.hostCount
                      ? `其中 ${report.scopeTargets - report.hostCount} 个采集目标在窗口内没有 node_exporter 数据，未计入。`
                      : ''
                  }`
                : '未限定项目：统计了数据源下的全部主机。若要按自己负责的项目出报告，请在上方选择项目或套用模板。'
            }
          />

          {/* KPI */}
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic title="主机数量" value={report.hostCount} suffix="台" />
              </Card>
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic
                  title="CPU 均值 / 峰值"
                  value={report.fleet.cpuAvg}
                  precision={1}
                  suffix={`% / ${fmtPct(report.fleet.cpuMax)}`}
                  valueStyle={{ color: usageColor(report.fleet.cpuMax) }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic
                  title="内存 均值 / 峰值"
                  value={report.fleet.memAvg}
                  precision={1}
                  suffix={`% / ${fmtPct(report.fleet.memMax)}`}
                  valueStyle={{ color: usageColor(report.fleet.memMax) }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic
                  title="磁盘 均值 / 峰值"
                  value={report.fleet.diskAvg}
                  precision={1}
                  suffix={`% / ${fmtPct(report.fleet.diskMax)}`}
                  valueStyle={{ color: usageColor(report.fleet.diskMax) }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic
                  title="峰值风险主机"
                  value={report.fleet.alertHit}
                  suffix="台"
                  prefix={<AlertOutlined />}
                  valueStyle={{ color: report.fleet.alertHit > 0 ? '#ef4444' : undefined }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic
                  title="健康评分"
                  value={hs?.score ?? 0}
                  suffix={`/ 100 · ${hs?.level ?? '—'}`}
                  valueStyle={{
                    color:
                      (hs?.score ?? 0) >= 80 ? '#16a34a' : (hs?.score ?? 0) >= 60 ? '#d97706' : '#dc2626',
                  }}
                />
                <Text type="secondary" style={{ fontSize: 11 }}>
                  资源水位 + 风险主机占比综合评定
                </Text>
              </Card>
            </Col>
            <Col xs={12} md={6} lg={4}>
              <Card size="small">
                <Statistic title="报告周期" value={report.periodCN} prefix={<ThunderboltOutlined />} />
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {report.start} ~ {report.end} · {report.points} 个采样点
                </Text>
              </Card>
            </Col>
          </Row>

          {/* 趋势 + 对比 */}
          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col xs={24} lg={12}>
              <Card size="small" title={isScoped(report) ? '所选项目资源趋势' : '全集群资源趋势'}>
                {trendOption ? (
                  <ReactECharts option={trendOption} notMerge style={{ height: 320 }} lazyUpdate />
                ) : (
                  <Empty description="无趋势数据" style={{ padding: 40 }} />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" title="主机资源对比（TOP15，按 CPU 峰值）">
                {barOption ? (
                  <ReactECharts option={barOption} notMerge style={{ height: 320 }} lazyUpdate />
                ) : (
                  <Empty description="无主机数据" style={{ padding: 40 }} />
                )}
              </Card>
            </Col>
          </Row>

          {/* 明细 */}
          <Card
            size="small"
            title={
              <span>
                <HddOutlined /> 主机资源明细（{report.hostCount} 台）
              </span>
            }
          >
            <Table
              rowKey="instance"
              size="small"
              columns={columns}
              dataSource={report.rows}
              pagination={{ pageSize: 20, showSizeChanger: true }}
              scroll={{ x: 1300 }}
            />
          </Card>
        </>
      )}

      {/* ---------- 保存模板 ---------- */}
      <Modal
        open={tplModal.open}
        title={tplModal.mode === 'overwrite' ? `更新模板「${tplForm.name}」` : '另存为报表模板'}
        okText="保存"
        cancelText="取消"
        confirmLoading={tplSaving}
        onCancel={() => setTplModal({ open: false, mode: 'create' })}
        onOk={submitTemplate}
        maskClosable={false}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={{ marginBottom: 4, fontSize: 12, color: '#64748b' }}>模板名称</div>
            <Input
              value={tplForm.name}
              onChange={(e) => setTplForm({ ...tplForm, name: e.target.value })}
              maxLength={64}
              showCount
              placeholder="例如：某项目季度报告"
              onPressEnter={submitTemplate}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, fontSize: 12, color: '#64748b' }}>备注（可选）</div>
            <Input.TextArea
              value={tplForm.remark}
              onChange={(e) => setTplForm({ ...tplForm, remark: e.target.value })}
              maxLength={255}
              rows={2}
              placeholder="例如：每季度末出给部门汇报用"
            />
          </div>
          <div style={{ fontSize: 12, color: '#334155', background: '#f8fafc', padding: 10, borderRadius: 6 }}>
            <div>
              数据源：<b>{dss.find((x) => x.id === ds)?.name || '—'}</b>
            </div>
            <div>
              周期：<b>{PERIOD_LABEL[period]}</b>
            </div>
            <div>
              项目范围：<b>{systems.length} 个</b> —— {systems.join('、') || '（未选择）'}
            </div>
            <div style={{ marginTop: 4, color: '#94a3b8' }}>
              共覆盖 {selectedHosts} 台主机（按当前采集目标数）
            </div>
          </div>
          <Checkbox
            checked={tplForm.shared}
            onChange={(e) => setTplForm({ ...tplForm, shared: e.target.checked })}
          >
            共享给其他人使用（别人只能用它生成报告，不能修改或删除）
          </Checkbox>
          <Text type="secondary" style={{ fontSize: 12 }}>
            不勾选时模板仅自己可见。模板只保存「口径」，不保存报告数据；改模板不影响已归档的历史报告。
          </Text>
        </div>
      </Modal>
    </div>
  )
}

/**
 * Prometheus 监控报表（v1.7.38 建模板/记录 → v1.7.41 合并成三个页签）
 *
 * 原来「监控报表 / 报表模板 / 报告记录」是三个并列菜单，用户抱怨「太乱了」：
 * 它们本来就是同一条工作流的三步（定口径 → 出报告 → 回看历史），
 * 拆成三个菜单后每次都要在菜单里来回跳，模板点「生成报告」还得开新标签页。
 * 现在合成一页三页签，菜单只留一个「监控报表」。
 *
 * ⚠️ 三个页签都 forceRender：一是让深链（?view= / ?template=）在首次渲染就能落到目标页签，
 * 二是切页签保留各自状态（筛选条件、已生成的报告）—— 用户不会因为去看了眼模板就丢掉手上的报告。
 *
 * 兼容旧链接：
 *   - `/prom/report?template=<id>` 仍按老逻辑套用模板（由「生成报告」页签自己解析）；
 *   - `/prom/report?view=<id>` 打开「报告记录」并弹出对应详情抽屉；
 *   - `/prom/report-templates`、`/prom/report-records` 在路由层重定向到本页对应页签。
 */
export default function PromReportPage() {
  const [sp, setSp] = useSearchParams()
  const [tab, setTab] = useState<string>(() => {
    if (sp.get('view')) return 'records'
    const t = sp.get('tab')
    if (t === 'templates' || t === 'records') return t
    return 'generate'
  })
  const [tplReq, setTplReq] = useState<{ id: number; seq: number } | null>(null)
  // 模板集合的版本号。三个页签都 forceRender（同时挂载且不再重挂），
  // 「报表模板」页签改了模板后必须显式告诉「生成报告」页签重新拉取，
  // 否则下拉里永远看不到刚建/刚改名的模板 —— 只能刷新浏览器。
  const [tplSeq, setTplSeq] = useState(0)
  // 归档记录的版本号：同理，「生成报告」页归档后要让「报告记录」页签重拉
  const [recSeq, setRecSeq] = useState(0)
  // 用 useCallback 固定引用：否则子组件里依赖这两个回调用 useCallback 的
  // generate / submit 每次渲染都被重建（虽无功能问题，但没必要）
  const bumpTplSeq = useCallback(() => setTplSeq((n) => n + 1), [])
  const bumpRecSeq = useCallback(() => setRecSeq((n) => n + 1), [])

  // 深链 ?view=<id>：取出来交给「报告记录」页签打开详情抽屉
  const viewId = useMemo(() => {
    const n = Number(sp.get('view') || 0)
    return n > 0 ? n : null
  }, [sp])

  const clearView = useCallback(() => {
    // 抽屉关掉就把参数清掉：否则分享出去的链接「一打开就弹抽屉」
    setSp(
      (cur) => {
        const next = new URLSearchParams(cur)
        next.delete('view')
        return next
      },
      { replace: true },
    )
  }, [setSp])

  const openArchived = useCallback(
    (id: number) => {
      setTab('records')
      setSp(
        (cur) => {
          const next = new URLSearchParams(cur)
          next.set('view', String(id))
          return next
        },
        { replace: true },
      )
    },
    [setSp],
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <Title level={4} style={{ margin: 0 }}>
          <BarChartOutlined style={{ marginRight: 8 }} />
          Prometheus 监控报表
        </Title>
        <Tag color="purple">v1.7.48</Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>
          定口径（模板）→ 出报告 → 回看历史，都在这一页
        </Text>
      </div>

      <Tabs
        activeKey={tab}
        onChange={(k) => {
          setTab(k)
          // 切到「生成报告」/「报告记录」时顺手重拉一次做兜底：正常路径由「报表模板」
          // 页增删改（onChanged）与生成归档（onArchived）通知，但模板/记录也可能在
          // 别的标签页或别人那里变过。这两个接口都是轻量 GET，重拉无副作用。
          if (k === 'generate' || k === 'templates') bumpTplSeq()
          if (k === 'records') bumpRecSeq()
          // 页签写回 URL：刷新 / 分享链接能落到同一个页签。
          // 离开「报告记录」时顺手清掉 view —— 否则再切回来会莫名其妙弹出上次的抽屉。
          setSp(
            (cur) => {
              const next = new URLSearchParams(cur)
              next.set('tab', k)
              if (k !== 'records') next.delete('view')
              return next
            },
            { replace: true },
          )
        }}
        items={[
          {
            key: 'generate',
            label: (
              <span>
                <BarChartOutlined /> 生成报告
              </span>
            ),
            forceRender: true,
            children: (
              <PromReportGenerate
                tplReq={tplReq}
                reloadSeq={tplSeq}
                onArchived={bumpRecSeq}
                onTemplatesChanged={bumpTplSeq}
                onOpenArchived={openArchived}
              />
            ),
          },
          {
            key: 'templates',
            label: (
              <span>
                <ProfileOutlined /> 报表模板
              </span>
            ),
            forceRender: true,
            children: (
              <PromReportTemplates
                embedded
                // 双向：本页增删改 → 通知生成页重拉；生成页「另存为模板」→ 本页重拉
                onChanged={bumpTplSeq}
                reloadSeq={tplSeq}
                onUse={(t) => {
                  // 就地切到「生成报告」并套用模板 —— 不再开新标签页
                  setTplReq({ id: t.id, seq: Date.now() })
                  setTab('generate')
                }}
              />
            ),
          },
          {
            key: 'records',
            label: (
              <span>
                <HistoryOutlined /> 报告记录
              </span>
            ),
            forceRender: true,
            children: <PromReportRecords embedded viewId={viewId} reloadSeq={recSeq} onCloseView={clearView} />,
          },
        ]}
      />
    </div>
  )
}
