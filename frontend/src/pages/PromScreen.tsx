// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Spin, Tag, Tooltip } from 'antd'
import {
  ArrowLeftOutlined,
  FundOutlined,
  AlertOutlined,
  CloudServerOutlined,
  HddOutlined,
  DashboardOutlined,
  ReloadOutlined,
  FireOutlined,
  CloudDownloadOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  InboxOutlined,
  DownOutlined,
  LogoutOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import dayjs from 'dayjs'
import {
  promSnapshot,
  promCollectNow,
  listPromDataSources,
  type PromOverview,
  type PromDataSource,
  type PromHostStat,
  type PromTopEntry,
  type PromIssue,
  type PromSnapshotResp,
} from '../api/prometheus'
import { useAuth } from '../store/AuthContext'
import { firstAccessiblePath } from '../utils/perms'
import { promColOn, promPanelOn, promRowsCss } from '../utils/promPanels'

/**
 * Prometheus 监控大屏（v1.7.39：完全复刻「巡检大屏」版面）
 *
 * 版面与数据展示口径逐格对齐 `InspectionScreen.tsx`，只把数据源换成 Prometheus：
 *   - 自适应缩放画布（设计高 1080，宽随视口比例，无黑边）；
 *   - 顶栏：边缘隐藏返回键 + 品牌（图标/中文/英文）时钟居中 + 数据源 / 全屏 / 立即采集 / 刷新；
 *   - 左栏：容量卡（CPU 核数 / 内存 / 存储）→ KPI 行 ×5 → 操作系统分布（环形 + 可换行图例）；
 *   - 中栏：资源仪表 ×4（CPU/内存/磁盘/网络）→ 负载 TOP ×3（超宽屏展开 4 列含网络）
 *           → [各主机 CPU/内存/磁盘/网络 柱状图 | 资源健康分布] → 资源使用率趋势；
 *   - 右栏：实时告警列表 → [告警等级 | 告警趋势] → 主机实时资源（自动滚动）；
 *   - 页脚：采集频率 / 采集时间 / 耗时 / 数据源 / 监控目标 / 超阈值。
 *
 * 与巡检大屏的**唯一**结构性差异（为了「不假装有数据」而刻意保留）：
 *   1. 巡检的「虚拟机运行」「巡检任务/记录」两格，在这里换成 Prometheus 有的口径
 *      （目标在线/离线、项目/部门）；
 *   2. 巡检的「磁盘告警」按告警规则统计，这里按「大屏管理」里配的阈值统计；
 *   3. 告警条目没有「打开终端」入口（Prometheus 的 target 不一定有 CMDB 资产外键）。
 *
 * 数据全部来自服务端定期采集的快照（大屏只读快照，不打爆 Prometheus），
 * 顶栏「立即采集」可手动触发一次并实时同步。
 *
 * 主机展示名：项目名_环境_业务环境（空段跳过，都没有则回退主机名 / IP）。
 */
const DESIGN_H = 1080
const MIN_W = 1440 // 超窄屏保底宽度（再窄就按宽度缩放，保证内容可读）
const MAX_W = 2560 // 超宽屏上限（再宽中间栏会过于稀疏）

function fitCanvas(vw: number, vh: number) {
  const aspect = vw / vh
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(DESIGN_H * aspect)))
  // 竖向永远填满；宽度被 clamp 住时改用宽度缩放（此时竖向留黑边，属于合理降级）
  const scale = Math.min(vh / DESIGN_H, vw / w)
  return { w, scale }
}

function fmtDateTime(d?: string) {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return '—'
  }
}

function usageColor(v: number) {
  if (v >= 90) return '#ef4444'
  if (v >= 80) return '#f59e0b'
  return '#22c55e'
}

/** 主机展示名：项目名_环境_业务环境（空段跳过）；都没有则回退主机名 / IP */
function hostName(h: Partial<PromHostStat>): string {
  const parts = [h.system, h.env, h.deployserver].filter((x) => !!x && String(x).trim() !== '')
  if (parts.length > 0) return parts.join('_')
  return h.hostname || h.instance || '—'
}

/**
 * 把列表均分成 cols 份（保持原顺序），用于「图例放不下时改两列」。
 * cols<=1 时原样返回一份，保证少数类别时与巡检大屏的单列观感完全一致。
 */
function splitEven<T>(list: T[], cols: number): T[][] {
  if (cols <= 1) return [list]
  const out: T[][] = []
  const per = Math.ceil(list.length / cols)
  for (let i = 0; i < list.length; i += per) out.push(list.slice(i, i + per))
  return out
}

// ============= 样式：与巡检大屏**逐字相同**（另起一套 class 前缀只会在将来被改歪） =============
const styles = `
@keyframes screenBlink { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.dash-root { font-family: -apple-system, "PingFang SC", "Microsoft Yahei", sans-serif; }
.dash-grid-bg {
  position: absolute; inset: 0; pointer-events: none;
  background-image:
    linear-gradient(rgba(56,189,248,0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(56,189,248,0.05) 1px, transparent 1px);
  background-size: 48px 48px;
}
.dash-panel {
  position: relative; background: linear-gradient(160deg, rgba(15,23,42,0.78), rgba(2,6,23,0.62));
  border: 1px solid rgba(56,189,248,0.22); border-radius: 10px;
  box-shadow: 0 0 24px rgba(56,189,248,0.08) inset, 0 8px 30px rgba(0,0,0,0.4);
  overflow: hidden;
}
.dash-panel::before, .dash-panel::after { content: ''; position: absolute; width: 10px; height: 10px; border-color: #38bdf8; pointer-events: none; }
.dash-panel::before { top: 4px; left: 4px; border-top: 2px solid; border-left: 2px solid; }
.dash-panel::after { bottom: 4px; right: 4px; border-bottom: 2px solid; border-right: 2px solid; }
.dash-title {
  font-size: 13px; letter-spacing: 2px; color: #7dd3fc;
  padding: 8px 12px; border-bottom: 1px solid rgba(56,189,248,0.15);
  display: flex; align-items: center; gap: 6px; text-transform: uppercase; height: 34px;
}
.dash-num { font-variant-numeric: tabular-nums; font-weight: 700; letter-spacing: 1px; }
.dash-blink { animation: screenBlink 1.6s ease-in-out infinite; }
.dash-empty { color: #475569; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; }

/* ===== 顶栏品牌区（图标 + 中文标题 + 英文副标）=====
   标题/副标与下方时钟、日期共用同一条垂直中轴：
   图标用绝对定位「挂在」文字块左侧，因此不参与文字块的宽度计算 ——
   文字块被父级 flex 居中后，标题文字的中心就正好落在画布中轴上。 */
.dash-brand { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.dash-brand__row { position: relative; display: flex; align-items: center; }
.dash-brand__icon {
  position: absolute; right: 100%; top: 50%; transform: translateY(-50%);
  margin-right: 11px; height: 38px; width: 38px; display: block; flex: 0 0 auto;
  filter: drop-shadow(0 0 10px rgba(59,130,246,0.35));
}
.dash-brand__text { text-align: center; line-height: 1.1; }
.dash-brand__cn {
  font-size: 22px; font-weight: 800; letter-spacing: 3px; white-space: nowrap;
  background: linear-gradient(92deg, #60a5fa 0%, #38bdf8 48%, #818cf8 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 0 7px rgba(56,189,248,0.42));
}
.dash-brand__cn > span { letter-spacing: 3px; margin-right: -3px; } /* 抵消末位字距，居中才精确 */
.dash-brand__en {
  font-size: 9px; font-weight: 500; letter-spacing: 2.2px; color: #5b7290;
  margin-top: 2px; white-space: nowrap;
}
.dash-brand__en > span { letter-spacing: 2.2px; margin-right: -2.2px; }

/* ===== 返回键「边缘隐藏」热区 =====
   默认整颗按钮平移到画布外，被画布 overflow:hidden 裁掉（同时不可命中）；
   鼠标移入左上角热区或按钮获得键盘焦点时才滑入。热区高度 = TOP_H，只覆盖顶栏空白带，
   不会盖住下方任何面板。 */
.dash-edge { position: absolute; left: 0; top: 0; z-index: 40; }
.dash-edge__hint {
  position: absolute; left: 6px; top: 28px; width: 3px; height: 36px; border-radius: 2px;
  background: linear-gradient(180deg, rgba(56,189,248,0.05), rgba(56,189,248,0.5), rgba(56,189,248,0.05));
  transition: opacity .26s ease;
}
/* 自动滚动容器：位移由 AutoScroll 的 rAF 逐帧累加（transform 子像素 + GPU 合成），
   因此不出现原生滚动条、也不会因数据刷新而跳回起点。 */
.dash-autoscroll { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.dash-autoscroll-track { will-change: transform; }
/* 仅在「图例真的放不下」时才出现的细滚动条（OS 家族名长、类别多时兜底） */
.dash-thin { scrollbar-width: thin; }
.dash-thin::-webkit-scrollbar { width: 4px; }
.dash-thin::-webkit-scrollbar-thumb { background: rgba(56,189,248,0.35); border-radius: 2px; }
.dash-thin::-webkit-scrollbar-track { background: transparent; }
`

// ============= 子组件：LiveClock（独立 setInterval，避免整组件每秒重渲） =============
const LiveClock = memo(function LiveClock() {
  const timeRef = useRef<HTMLDivElement>(null)
  const dateRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const tick = () => {
      const d = new Date()
      if (timeRef.current) timeRef.current.textContent = d.toLocaleTimeString('zh-CN', { hour12: false })
      if (dateRef.current)
        dateRef.current.textContent = `${d.toLocaleDateString('zh-CN')} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]}`
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <div style={{ textAlign: 'center', lineHeight: 1.05 }}>
      <div ref={timeRef} className="dash-num" style={{ fontSize: 17, color: '#e2e8f0', letterSpacing: 1.5 }}>
        00:00:00
      </div>
      <div ref={dateRef} style={{ fontSize: 12.5, color: '#7f8ea3', letterSpacing: 1.5, marginTop: 2 }}>--</div>
    </div>
  )
})

// ============= 子组件：NextRefresh（独立 setInterval，真正倒计时） =============
// 巡检大屏按「固定间隔」倒计时；监控大屏的采集是服务端排程的，所以以后端下发的
// nextAt（unix 秒）为准 —— 手改采集间隔或刚点过「立即采集」时都算得准，
// 没有 nextAt（老快照）才退化成「间隔 - 已过时间」。
const NextRefresh = memo(function NextRefresh({
  nextAt,
  lastAt,
  intervalS,
}: {
  nextAt: number
  lastAt: number
  intervalS: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const tick = () => {
      if (!ref.current) return
      const remain = nextAt > 0
        ? Math.max(0, Math.round((nextAt * 1000 - Date.now()) / 1000))
        : Math.max(0, intervalS - Math.floor((Date.now() - lastAt) / 1000))
      ref.current.textContent = remain > 0 ? `下次采集 ${remain}s 后` : '正在采集…'
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [nextAt, lastAt, intervalS])
  return <div ref={ref} style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>—</div>
})

// ============= 子组件：AutoScroll（无缝平滑自动滚动） =============
// 观感目标：恒定线速度、无跳变、无抖动。
// 做法：内容渲染两份（上下紧贴、无间隙），用 rAF 逐帧累加位移并整体 translate3d；
//       位移达到「一份内容」高度时减去该高度 → 视觉上无限循环，接缝处完全吻合。
// 为什么不用 CSS animation：大屏每 N 秒刷新会重渲，CSS 动画会被重置回起点（跳变）；
//       且固定 duration 会让「内容多就飞快、内容少几乎不动」。rAF 的位移量存在 ref 里，跨重渲连续。
// 内容不足一屏时自动不滚，避免原地微抖。
const SCROLL_SPEED = {
  host: 14, // 主机实时资源：卡片较高，慢一点更从容
  top: 10, // TOP N：仅几行，低速避免一闪而过
  alert: 17, // 告警列表：条目多，略快保证一轮不至于太久
}

const AutoScroll = memo(function AutoScroll({
  children, speed = 26, gap = 0, fade = 12, style,
}: {
  children: React.ReactNode
  speed?: number // px/s（恒定线速度，与内容多少无关）
  gap?: number // 同一份内容内的元素间距
  fade?: number // 上下渐隐高度（px），0 = 不渐隐
  style?: React.CSSProperties
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const copyHRef = useRef(0) // 一份内容的高度
  const offsetRef = useRef(0) // 当前已滚动位移
  const pausedRef = useRef(false) // 悬停暂停，方便看清某一条
  const [running, setRunning] = useState(false)

  // 测量一份内容高度；内容增删（刷新）或容器尺寸变化时重算
  useEffect(() => {
    const wrap = wrapRef.current
    const track = trackRef.current
    if (!wrap || !track) return
    const measure = () => {
      const copy = track.firstElementChild as HTMLElement | null
      const h = copy ? copy.offsetHeight : 0
      copyHRef.current = h
      const need = h > wrap.clientHeight + 2
      setRunning(need)
      if (!need) {
        offsetRef.current = 0
        track.style.transform = 'translate3d(0, 0, 0)'
      } else if (offsetRef.current >= h) {
        offsetRef.current %= h
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    const mo = new MutationObserver(measure)
    mo.observe(track, { childList: true, subtree: true })
    return () => { ro.disconnect(); mo.disconnect() }
  }, [])

  // rAF 推进位移。依赖 [running, speed] 而非 children → 数据刷新不打断滚动
  useEffect(() => {
    if (!running) return
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(80, now - last) / 1000 // 掉帧时限幅：宁可慢一点，也不跳一段
      last = now
      const track = trackRef.current
      const h = copyHRef.current
      if (!track || h <= 0 || pausedRef.current) return
      let off = offsetRef.current + speed * dt
      if (off >= h) off -= h
      offsetRef.current = off
      track.style.transform = `translate3d(0, ${-off}px, 0)`
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [running, speed])

  const mask = fade > 0
    ? `linear-gradient(180deg, transparent 0, #000 ${fade}px, #000 calc(100% - ${fade}px), transparent 100%)`
    : undefined

  return (
    <div
      ref={wrapRef}
      className="dash-autoscroll"
      onMouseEnter={() => { pausedRef.current = true }}
      onMouseLeave={() => { pausedRef.current = false }}
      style={{ ...style, WebkitMaskImage: mask, maskImage: mask }}
    >
      <div ref={trackRef} className="dash-autoscroll-track">
        <div style={{ display: 'flex', flexDirection: 'column', gap }}>{children}</div>
        {/* 第二份内容只用于无缝衔接，对读屏隐藏 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap }} aria-hidden="true">{children}</div>
      </div>
    </div>
  )
})

export default function PromScreen() {
  const { hasPerm, logout, routePerms } = useAuth()
  // 「只看大屏」账号（仅授予 prom:screen）：除大屏外没有任何可访问页面，
  // 此时不提供「返回主界面」（回去也只会被弹回大屏），改为提供「退出登录」。
  // ⚠️ firstAccessiblePath 会优先排除大屏类（newTab）页面，所以只有大屏权限时
  // 它仍会回落到本页 —— 这个判断在 v1.7.46 之后语义不变。
  const onlyScreen = firstAccessiblePath(hasPerm, routePerms) === '/prom/screen'

  const [snap, setSnap] = useState<PromSnapshotResp | null>(null)
  const [dss, setDss] = useState<PromDataSource[]>([])
  const [ds, setDs] = useState<number | undefined>(undefined)
  const [dsOpen, setDsOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [collecting, setCollecting] = useState(false)
  const [lastAt, setLastAt] = useState<number>(Date.now())
  const [canvas, setCanvas] = useState(() => fitCanvas(window.innerWidth, window.innerHeight))
  const [isFull, setIsFull] = useState(false)
  const [backShown, setBackShown] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number>()
  // 数据源代际守卫：大数据源（上千 target）采集可能十几秒，期间用户切走数据源时，
  // 迟到的旧响应必须丢弃，否则会把新数据源的面板覆盖回旧数据
  const dsRef = useRef(ds)
  dsRef.current = ds
  const collectingRef = useRef(false)

  /* ---------- 自适应缩放 ---------- */
  const fit = useRef<() => void>(() => {})
  fit.current = () => setCanvas(fitCanvas(window.innerWidth, window.innerHeight))
  useEffect(() => {
    const onFit = () => fit.current()
    onFit()
    window.addEventListener('resize', onFit)
    document.addEventListener('fullscreenchange', onFit)
    return () => {
      window.removeEventListener('resize', onFit)
      document.removeEventListener('fullscreenchange', onFit)
    }
  }, [])

  /* ---------- 加载数据源（默认取第一个启用的） ---------- */
  useEffect(() => {
    listPromDataSources()
      .then((r) => {
        const usable = (r.list || []).filter((x) => x.enabled === 1)
        setDss(usable)
        if (usable.length > 0) setDs(usable[0].id)
      })
      .catch(() => setDss([]))
  }, [])

  /* ---------- 读快照（不查 Prometheus，毫秒级返回） ---------- */
  const load = () => {
    const target = dsRef.current
    promSnapshot(target)
      .then((r) => {
        if (dsRef.current !== target) return // 已切走 → 丢弃过期响应
        setSnap(r)
        // 采集失败时保留上一次快照，只在顶栏提示错误
        setErr(r.ready ? null : (r.msg || null))
        if (r.ready) setLastAt(Date.now())
      })
      .catch((e: any) => {
        if (dsRef.current !== target) return
        setErr(e?.response?.data?.msg || e?.message || '读取采集快照失败')
      })
      .finally(() => {
        if (dsRef.current === target) setLoading(false)
      })
  }

  /* ---------- 手动触发一次采集（同步等待，采完立即同步到大屏） ---------- */
  const collectNow = () => {
    if (collectingRef.current) return
    collectingRef.current = true
    setCollecting(true)
    promCollectNow(dsRef.current)
      .then(() => {
        setErr(null)
        load()
      })
      .catch((e: any) => {
        setErr(e?.response?.data?.msg || e?.message || '手动采集失败')
      })
      .finally(() => {
        collectingRef.current = false
        setCollecting(false)
      })
  }

  // 轮询间隔跟随采集间隔：最快 3s、最慢 30s（间隔长时不必空转，靠 nextAt 倒计时提示）
  const pollMs = useMemo(() => {
    const iv = snap?.config?.intervalSec || 30
    return Math.min(30000, Math.max(3000, Math.round((iv * 1000) / 2)))
  }, [snap?.config?.intervalSec])

  useEffect(() => {
    if (ds === undefined && dss.length > 0) return
    load()
    timer.current = window.setInterval(load, pollMs)
    return () => window.clearInterval(timer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds, dss.length, pollMs])

  const toggleFull = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.().then(() => setIsFull(true)).catch(() => undefined)
    } else {
      document.exitFullscreen?.().then(() => setIsFull(false)).catch(() => undefined)
    }
  }
  useEffect(() => {
    const onChange = () => setIsFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  /* ---------- 派生数据（必须在条件 return 之前，保持 hook 顺序） ---------- */
  const data: PromOverview | null = snap?.data || null
  const cfg = snap?.config
  const issues = useMemo<PromIssue[]>(() => data?.issues || [], [data])
  const issueStat = data?.issueStat || { crit: 0, warn: 0, hosts: 0 }
  const trendHours = cfg?.trendHours || 24
  const diskWarn = issueStat.byMetric?.disk?.warn ?? 0
  const diskCrit = issueStat.byMetric?.disk?.crit ?? 0

  // 每台主机的超阈值条数（主机实时资源卡片右侧的小标签用）
  const issueByInst = useMemo(() => {
    const m = new Map<string, { crit: number; warn: number }>()
    issues.forEach((it) => {
      const cur = m.get(it.instance) || { crit: 0, warn: 0 }
      if (it.level === 'crit') cur.crit++
      else cur.warn++
      m.set(it.instance, cur)
    })
    return m
  }, [issues])

  const osDist = useMemo(() => data?.osDist || [], [data?.osDist])
  const osOpt = useMemo(() => osDistOption(osDist), [osDist])
  const osTotal = useMemo(() => osDist.reduce((s, x) => s + x.value, 0), [osDist])

  const usageDist = data?.usageDist || { low: 0, mid: 0, high: 0, crit: 0, none: 0 }
  const distOpt = useMemo(() => distOption(usageDist), [usageDist])
  const distTotal = useMemo(
    () => usageDist.low + usageDist.mid + usageDist.high + usageDist.crit + usageDist.none,
    [usageDist],
  )

  const avg = data?.avg
  const trendOpt = useMemo(() => trendOption(data?.trend || []), [data?.trend])
  const altTrendOpt = useMemo(() => alertTrendOption(data?.alertTrend || []), [data?.alertTrend])

  // 告警等级分布（与巡检大屏 alertByLevelDist 同构：name / value / color）
  const lvList = useMemo(
    () => [
      { name: '严重', value: issueStat.crit, color: '#ef4444' },
      { name: '关注', value: issueStat.warn, color: '#f59e0b' },
    ],
    [issueStat.crit, issueStat.warn],
  )
  const lvOpt = useMemo(() => alertLevelOption(lvList), [lvList])
  const lvTotal = issueStat.crit + issueStat.warn

  const barsOpt = useMemo(
    () => hostBarsOption(data?.hosts || []),
    [data?.hosts],
  )

  const dsName = useMemo(() => dss.find((x) => x.id === ds)?.name || '—', [dss, ds])
  const up = data?.up
  const cap = data?.capacity

  // === 画布内可用尺寸（设计稿基准 1920×1080） ===
  // 顶栏 92 + 主体 920 + 页脚 36 = 1048，剩 32 = 上下各 16 内边距
  const TOP_H = 92
  const FOOT_H = 36
  const BODY_H = DESIGN_H - TOP_H - FOOT_H
  const BODY_PAD = 16
  const TOP_N = cfg?.topN ?? 5

  /* ---------- 内容控制（v1.7.41）：面板开关 → 行模板 / 整栏显隐 ---------- */
  // 面板可见性：缺省 = 展示。关掉的面板不渲染，同一栏里其余面板自动接管它的高度。
  const on = (k: Parameters<typeof promPanelOn>[1]) => promPanelOn(cfg?.panels, k)

  // 风险项是否被「等级口径」收窄（≠ 全部）。KPI / 空清单文案要据此解释「为什么数字变小了」——
  // 否则运维会以为漏统计了，反过来把阈值调错。
  const riskControlled = cfg?.riskLevel === 'crit' || cfg?.riskLevel === 'warn'

  // 有屏蔽规则时，空榜要能解释「是没数据，还是被规则挡了」—— 否则用户会当成采集故障。
  const topFiltered = (cfg?.masks?.length || 0) > 0

  // 四个负载榜各自独立开关（v1.7.42）：只渲染开着的，剩下的按等分自动占满整行宽度
  // （不再有「常规屏只显示前 3 个」的隐藏规则 —— 那种「第 4 个去哪了」的疑问正是这次要消掉的）。
  const TOP_ITEMS = [
    { key: 'topCpu' as const, metric: 'cpu' as const, title: `CPU 负载 TOP${TOP_N}`, rows: data?.top?.cpu || [] },
    { key: 'topMem' as const, metric: 'mem' as const, title: `内存负载 TOP${TOP_N}`, rows: data?.top?.mem || [] },
    { key: 'topDisk' as const, metric: 'disk' as const, title: `磁盘负载 TOP${TOP_N}`, rows: data?.top?.disk || [] },
    { key: 'topNet' as const, metric: 'net' as const, title: `网络负载 TOP${TOP_N}`, rows: data?.top?.net || [] },
  ].filter((it) => on(it.key))
  const TOP_ANY = TOP_ITEMS.length > 0

  // 左栏 7 格：整体占满的是「操作系统分布」，其余按设计稿固定高。
  const LEFT_ROWS = promRowsCss([
    { on: on('capacity'), h: '96px' },
    { on: on('kpiTarget'), h: '88px' },
    { on: on('kpiOnline'), h: '88px' },
    { on: on('kpiIssue'), h: '88px' },
    { on: on('kpiDisk'), h: '88px' },
    { on: on('kpiProject'), h: '88px' },
    { on: on('osDist'), h: 'FR' },
  ])
  // 中栏：「各主机实时使用率」与「资源健康分布」**同一行并排**，
  // 所以按「行」而不是「面板」来算模板 —— 只剩一个时它就独占整行。
  const MID_SPLIT = on('hostBars') || on('healthDist')
  const MID_ROWS = promRowsCss([
    { on: on('gauges'), h: '86px' },
    { on: TOP_ANY, h: '196px' }, // 四个负载榜占同一行（行高固定，榜数不影响行高）
    { on: MID_SPLIT, h: 'FR' },
    { on: on('trend'), h: '230px' },
  ])
  // 右栏：「告警等级」与「告警趋势」同样同一行并排。
  const RIGHT_SPLIT = on('alertLevel') || on('alertTrend')
  const RIGHT_ROWS = promRowsCss([
    { on: on('alerts'), h: 'FR' },
    { on: RIGHT_SPLIT, h: '190px' },
    { on: on('hostScroll'), h: '240px' },
  ])

  const LEFT_ON = promColOn(cfg?.panels, 'left')
  const MID_ON = promColOn(cfg?.panels, 'mid')
  const RIGHT_ON = promColOn(cfg?.panels, 'right')
  const BODY_EMPTY = !LEFT_ON && !MID_ON && !RIGHT_ON
  const FOOT_ON = on('footer')

  // 页面栅格：整栏面板全关时把该栏摘掉，剩余栏位自动占满 —— 否则会留下一整条空白栏。
  // 中栏（1fr）被关掉时，左右两栏从「设计固定宽」改成 minmax 平分，避免只占中间一小块。
  const bodyTracks = (() => {
    const all = [
      { key: 'left', on: LEFT_ON, fixed: 'clamp(260px, 17%, 420px)', min: 260 },
      { key: 'mid', on: MID_ON, fixed: '1fr', min: 0 },
      { key: 'right', on: RIGHT_ON, fixed: 'clamp(290px, 19%, 460px)', min: 290 },
    ].filter((c) => c.on)
    if (all.length === 0) return ''
    if (all.length === 1) return '1fr'
    return all
      .map((c) => {
        if (c.key === 'mid') return '1fr'
        return MID_ON ? c.fixed : `minmax(${c.min}px, 1fr)`
      })
      .join(' ')
  })()

  if (!snap && loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#060b18' }}>
        <Spin size="large" tip="加载监控数据中…" />
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="dash-root"
      style={{
        position: 'fixed', inset: 0, overflow: 'hidden',
        background: '#04060b',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <style>{styles}</style>

      {/* 设计稿画布：高度锁 1080，宽度随视口比例，等比缩放填满屏幕 */}
      <div
        data-testid="prom-canvas"
        style={{
          width: canvas.w, height: DESIGN_H, flex: '0 0 auto',
          transform: `scale(${canvas.scale})`, transformOrigin: 'center center',
          background:
            'radial-gradient(1200px 700px at 10% -10%, rgba(56,189,248,0.12), transparent 55%), radial-gradient(1000px 700px at 100% 0%, rgba(129,140,248,0.12), transparent 55%), radial-gradient(900px 700px at 50% 120%, rgba(14,165,233,0.08), transparent 55%), #06080f',
          color: '#e2e8f0',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div className="dash-grid-bg" />

        {/* ============= 左上角「边缘隐藏」返回键 =============
            默认整颗按钮平移到画布外（transform 负位移 + 画布 overflow:hidden 裁掉），
            鼠标移入这块顶栏空白热区（或按钮被 Tab 聚焦）才滑入。
            热区高度只占顶栏 TOP_H、宽度 150，正好落在左上角空白带里，不覆盖任何面板。 */}
        <div
          className="dash-edge"
          style={{ width: 150, height: TOP_H }}
          onMouseEnter={() => setBackShown(true)}
          onMouseLeave={() => setBackShown(false)}
        >
          {/* 极淡的提示条：否则按钮完全不可见、没人知道这里能点 */}
          <div className="dash-edge__hint" style={{ opacity: backShown ? 0 : 0.8 }} />
          {/* 这里刻意不用 antd Tooltip：鼠标一进热区按钮就滑到指针下，antd 提示会立刻弹出、
              用浅色卡片盖住左上角 KPI 面板，在大屏上属于纯干扰。
              改用原生 title（悬停约 1s 才出）+ aria-label（读屏可读）。 */}
          <button
            title={onlyScreen ? '退出登录' : '返回主界面'}
            onClick={() => {
              if (onlyScreen) { logout(); return }
              if (window.history.length > 1) history.back()
              else window.location.href = '/'
            }}
            onFocus={() => setBackShown(true)}
            onBlur={() => setBackShown(false)}
            aria-label={onlyScreen ? '退出登录' : '返回主界面'}
            style={{
              position: 'absolute', left: 24, top: 18,
              height: 56, width: 56, borderRadius: 10,
              background: 'rgba(15,23,42,0.7)',
              border: '1px solid rgba(56,189,248,0.3)',
              color: '#7dd3fc', cursor: 'pointer', padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18,
              // 藏着时 left 24 + 自身 56 必须一起推出画布，否则会露出 24px 一条边
              transform: backShown ? 'translateX(0)' : 'translateX(calc(-100% - 24px))',
              opacity: backShown ? 1 : 0,
              transition: 'transform .26s cubic-bezier(.22,.61,.36,1), opacity .22s ease, border-color .2s, color .2s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#38bdf8'; e.currentTarget.style.color = '#38bdf8' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(56,189,248,0.3)'; e.currentTarget.style.color = '#7dd3fc' }}
          >
            {onlyScreen ? <LogoutOutlined /> : <ArrowLeftOutlined />}
          </button>
        </div>

        {/* ============= 顶栏（高 92，1fr auto 1fr 三簇严格等高对齐） ============= */}
        <div
          style={{
            height: TOP_H,
            display: 'grid', gridTemplateColumns: '1fr auto 1fr',
            alignItems: 'center', gap: 16,
            padding: `0 ${BODY_PAD + 8}px`,
          }}
        >
          {/* 左簇：留空占位（返回键在左上角边缘隐藏，不占网格列） */}
          <div />

          {/* 中簇：品牌（图标 + 中文标题 + 英文副标）+ 时钟/日期，绝对居中 */}
          <div className="dash-brand">
            <div className="dash-brand__row">
              {/* 图标：绝对定位挂在文字块左侧，不参与文字块宽度 → 标题文字中心 = 画布中轴 */}
              <img className="dash-brand__icon" src="/prom-logo-icon.svg" alt="" aria-hidden="true" />
              <div className="dash-brand__text">
                <div className="dash-brand__cn"><span>{cfg?.title || 'Prometheus 监控平台'}</span></div>
                <div className="dash-brand__en"><span>PROMETHEUS MONITORING PLATFORM</span></div>
              </div>
            </div>
            <LiveClock />
          </div>

          {/* 右簇：数据源 / 全屏 / 立即采集 / 刷新数据（刷新最右） */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
            {/* 数据源卡：与巡检大屏「最近巡检」卡完全同一套规格（高 56 / 深色玻璃 / 圆角 10）。
                多个数据源时把名称做成自绘下拉 —— 原生 <select> 在深色大屏上必然是一块白色控件，
                而且它撑不出「标签 + 值 + 倒计时」三行结构。 */}
            <div
              style={{ position: 'relative' }}
              onMouseLeave={() => setDsOpen(false)}
            >
              <div
                style={{
                  height: 56, padding: '0 14px', borderRadius: 10,
                  border: '1px solid rgba(56,189,248,0.3)',
                  background: 'rgba(15,23,42,0.7)', color: '#e2e8f0',
                  lineHeight: 1.15, minWidth: 168, maxWidth: 230,
                  display: 'flex', flexDirection: 'column', justifyContent: 'center',
                }}
              >
                <div style={{ fontSize: 10, color: '#64748b', letterSpacing: 2 }}>数据源</div>
                {dss.length > 1 ? (
                  <div
                    onClick={() => setDsOpen((o) => !o)}
                    title="切换数据源"
                    style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, cursor: 'pointer' }}
                  >
                    <span
                      className="dash-num"
                      style={{ fontSize: 14, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {dsName}
                    </span>
                    <DownOutlined
                      style={{ fontSize: 10, color: '#7dd3fc', flex: '0 0 auto', transform: dsOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}
                    />
                  </div>
                ) : (
                  <div
                    className="dash-num"
                    style={{ fontSize: 14, color: '#e2e8f0', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={dsName}
                  >
                    {dsName}
                  </div>
                )}
                <NextRefresh nextAt={snap?.nextAt || 0} lastAt={lastAt} intervalS={cfg?.intervalSec || 30} />
              </div>
              {dsOpen && dss.length > 1 && (
                <div
                  style={{
                    position: 'absolute', right: 0, top: 62, minWidth: 200, zIndex: 70,
                    padding: 4, borderRadius: 10,
                    border: '1px solid rgba(56,189,248,0.35)',
                    background: 'rgba(2,6,23,0.97)',
                    boxShadow: '0 12px 34px rgba(0,0,0,.6)',
                  }}
                >
                  {dss.map((d) => (
                    <div
                      key={d.id}
                      onClick={() => { setDs(d.id); setDsOpen(false) }}
                      style={{
                        padding: '7px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                        color: d.id === ds ? '#7dd3fc' : '#cbd5e1',
                        background: d.id === ds ? 'rgba(56,189,248,0.14)' : 'transparent',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                      onMouseEnter={(e) => { if (d.id !== ds) e.currentTarget.style.background = 'rgba(148,163,184,0.12)' }}
                      onMouseLeave={(e) => { if (d.id !== ds) e.currentTarget.style.background = 'transparent' }}
                    >
                      {d.name}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Tooltip title={isFull ? '退出全屏' : '进入全屏 (F)'}>
              <div
                onClick={toggleFull}
                style={{
                  cursor: 'pointer', height: 56, width: 48, borderRadius: 10,
                  border: '1px solid rgba(56,189,248,0.3)',
                  background: 'rgba(15,23,42,0.7)', color: '#7dd3fc',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 16,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#38bdf8'; e.currentTarget.style.color = '#38bdf8' }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(56,189,248,0.3)'; e.currentTarget.style.color = '#7dd3fc' }}
              >
                {isFull ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              </div>
            </Tooltip>

            {/* 立即采集：Prometheus 专有动作（巡检大屏没有），保留但用同一套深色玻璃规格，
                只把描边/文字调成青色系以示「写操作」，不再用绿色块抢「刷新数据」的视觉 */}
            <button
              onClick={collectNow}
              disabled={collecting}
              title="立即向 Prometheus 采集一次并同步到大屏"
              style={{
                height: 56, padding: '0 14px', borderRadius: 10,
                background: 'rgba(15,23,42,0.7)',
                border: '1px solid rgba(52,211,153,0.4)',
                color: collecting ? '#64748b' : '#6ee7b7',
                cursor: collecting ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600,
              }}
              onMouseEnter={(e) => { if (!collecting) { e.currentTarget.style.borderColor = '#34d399'; e.currentTarget.style.color = '#34d399' } }}
              onMouseLeave={(e) => { if (!collecting) { e.currentTarget.style.borderColor = 'rgba(52,211,153,0.4)'; e.currentTarget.style.color = '#6ee7b7' } }}
            >
              <CloudDownloadOutlined spin={collecting} /> {collecting ? '采集中…' : '立即采集'}
            </button>

            <button
              onClick={load}
              title="重新读取服务端最新采集快照"
              style={{
                height: 56, padding: '0 16px', borderRadius: 10,
                background: 'linear-gradient(180deg, rgba(56,189,248,0.18), rgba(56,189,248,0.06))',
                border: '1px solid rgba(56,189,248,0.45)',
                color: '#7dd3fc', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600,
                boxShadow: '0 0 16px rgba(56,189,248,0.18) inset',
              }}
            >
              <ReloadOutlined spin={loading} /> 刷新数据
            </button>
          </div>
        </div>

        {/* ============= 主体 ============= */}
        {!data ? (
          err ? (
            <div className="dash-panel" style={{ margin: `0 ${BODY_PAD}px`, height: BODY_H - 32, padding: 60, textAlign: 'center', color: '#f87171', fontSize: 14 }}>
              数据采集失败：{err}
              <div style={{ marginTop: 8, color: '#64748b', fontSize: 12 }}>
                若持续失败，请到「数据源管理」做一次连通性测试，或在「大屏管理」里核对采集间隔
              </div>
            </div>
          ) : (
            <div style={{ height: BODY_H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7dd3fc' }}>
              <Spin size="large" />
              <span style={{ marginLeft: 12 }}>
                {snap?.collecting ? '正在采集 Prometheus 数据（目标较多时约需十几秒）…' : '正在连接 Prometheus …'}
              </span>
            </div>
          )
        ) : BODY_EMPTY ? (
          /* 所有面板都被关掉：给一句明确指引，而不是留一块纯黑 —— 投屏上纯黑看着像大屏坏了 */
          <div style={{ height: BODY_H, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="dash-panel" style={{ padding: '30px 44px', textAlign: 'center', maxWidth: 600 }}>
              <div style={{ fontSize: 15, color: '#e2e8f0', marginBottom: 10 }}>当前大屏没有显示任何面板</div>
              <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.9 }}>
                左 / 中 / 右三栏的面板都在「大屏管理」里被关闭了。
                <br />
                {hasPerm('prom:screen:config:view') ? (
                  <a href="/prom/screen-admin" style={{ color: '#38bdf8' }}>
                    前往「大屏管理 → 展示内容」重新勾选需要展示的面板
                  </a>
                ) : (
                  <>请联系管理员在「大屏管理 → 展示内容」里重新勾选需要展示的面板</>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: bodyTracks,
              gap: 12,
              padding: `0 ${BODY_PAD}px`,
              height: BODY_H,
              alignItems: 'stretch',
            }}
          >
            {/* ===== 左栏 集群总览（面板可关；关掉后同一栏里其余面板自动补位，不留空白） ===== */}
            {LEFT_ON && (
            <div style={{ display: 'grid', gridTemplateRows: LEFT_ROWS, gap: 10, minHeight: 0 }}>
              {/* 容量卡：三列等分（CPU 核数 / 内存 / 存储） */}
              {on('capacity') && (
              <div className="dash-panel" style={{ height: '100%', minHeight: 96, padding: '0 14px', display: 'flex', alignItems: 'center' }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                  <div style={{ color: '#94a3b8', fontSize: 10, letterSpacing: 1 }}>CPU 核数</div>
                  <div className="dash-num" style={{ fontSize: 24, color: '#38bdf8', textShadow: '0 0 12px rgba(56,189,248,0.4)' }}>
                    {Math.round(cap?.cores || 0)}<span style={{ fontSize: 11, color: '#64748b', marginLeft: 3 }}>核</span>
                  </div>
                </div>
                <div style={{ width: 1, height: 50, background: 'rgba(56,189,248,0.15)' }} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: 12 }}>
                  <div style={{ color: '#94a3b8', fontSize: 10, letterSpacing: 1 }}>内存</div>
                  <div className="dash-num" style={{ fontSize: 24, color: '#a78bfa', textShadow: '0 0 12px rgba(167,139,250,0.4)' }}>
                    {Math.round(cap?.memGb || 0)}<span style={{ fontSize: 11, color: '#64748b', marginLeft: 3 }}>GB</span>
                  </div>
                </div>
                <div style={{ width: 1, height: 50, background: 'rgba(56,189,248,0.15)' }} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: 12 }}>
                  <div style={{ color: '#94a3b8', fontSize: 10, letterSpacing: 1 }}>存储</div>
                  <div className="dash-num" style={{ fontSize: 24, color: '#22d3ee', textShadow: '0 0 12px rgba(34,211,238,0.4)' }}>
                    {Math.round(cap?.diskGb || 0)}<span style={{ fontSize: 11, color: '#64748b', marginLeft: 3 }}>GB</span>
                  </div>
                </div>
              </div>
              )}

              {/* 监控目标 / 主机（≈ 巡检的「资产 / 主机」） */}
              {on('kpiTarget') && (
              <KpiRow
                icon={<CloudServerOutlined />}
                color="#38bdf8"
                label="监控目标 / 主机"
                value={`${up?.total || 0} / ${up?.hosts || 0}`}
                sub={`已采集 ${up?.hosts || 0} · 未采集 ${Math.max(0, (up?.total || 0) - (up?.hosts || 0))}`}
              />
              )}
              {/* 目标在线 / 离线（≈ 巡检的「虚拟机运行」） */}
              {on('kpiOnline') && (
              <KpiRow
                icon={<DashboardOutlined />}
                color={up?.offline ? '#f59e0b' : '#22c55e'}
                label="目标在线 / 离线"
                value={`${up?.online || 0} / ${up?.offline || 0}`}
                sub={`在线率 ${up && up.total > 0 ? ((up.online / up.total) * 100).toFixed(1) : '0.0'}% · 目标 ${up?.total || 0} 台`}
              />
              )}
              {/* 告警项 / 主机（≈ 巡检的「告警项 / 资产」，阈值自算） */}
              {on('kpiIssue') && (
              <KpiRow
                icon={<AlertOutlined />}
                color={issueStat.crit ? '#ef4444' : issueStat.warn ? '#f59e0b' : '#22c55e'}
                label="告警项 / 主机"
                value={`${issueStat.crit + issueStat.warn} / ${issueStat.hosts}`}
                // 风险口径被收窄（只看严重/只看关注）时，这里的数字会小于「全部超阈值」，
                // 不加说明会被当成「漏统计了」——在副标题里把当前口径点出来。
                sub={
                  riskControlled
                    ? `${cfg?.riskLevel === 'crit' ? '仅统计严重项' : '仅统计关注项'} · 已按大屏内容策略过滤`
                    : `严重 ${issueStat.crit} · 关注 ${issueStat.warn}（阈值在大屏管理里调）`
                }
              />
              )}
              {/* 磁盘告警（≈ 巡检的「磁盘告警」；用 byMetric 取数，不受 issues 100 条截断影响） */}
              {on('kpiDisk') && (
              <KpiRow
                icon={<HddOutlined />}
                color={diskCrit ? '#ef4444' : diskWarn ? '#f59e0b' : '#22c55e'}
                label="磁盘告警"
                value={`${diskWarn} / ${diskCrit}`}
                sub="预警 / 严重（按大屏阈值）"
              />
              )}
              {/* 项目 / 部门（≈ 巡检的「巡检任务 / 记录」） */}
              {on('kpiProject') && (
              <KpiRow
                icon={<FundOutlined />}
                color="#818cf8"
                label="项目 / 部门"
                value={`${data.projects || 0} / ${data.depts || 0}`}
                sub="按 target label 去重"
              />
              )}

              {/* 操作系统分布：环形图 + 自绘可换行图例（家族名较长，交给图例承载） */}
              {on('osDist') && (
              <div className="dash-panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
                <div className="dash-title"><DashboardOutlined /> 操作系统分布</div>
                <div style={{ flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
                  <ReactECharts option={osOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                  {/* 圆心总数：填补空心，且不会被任何边界裁切 */}
                  <div
                    style={{
                      position: 'absolute', inset: 0, pointerEvents: 'none',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <div className="dash-num" style={{ fontSize: 20, lineHeight: 1, color: osTotal > 0 ? '#e2e8f0' : '#475569' }}>
                      {osTotal}
                    </div>
                    <div style={{ fontSize: 9, color: '#64748b', letterSpacing: 1, marginTop: 3 }}>台</div>
                  </div>
                </div>
                {/* 自绘图例：名称原样展示、允许折行、绝不省略。
                    右下 18px 内边距是为了避开面板右下角的 10×10 装饰角标（::after 内缩 4px）。
                    与巡检大屏的唯一差异：OS 家族只有 14 类但**每类名字短**，单列在 1920 屏上
                    放不下第 9 条、会退化成滚动条（投屏上等于看不见）——所以条目多于 8 个时
                    改成两列，条目本身仍是「色块 + 名称 + 台数」的原样式，观感不变。 */}
                <div
                  className="dash-thin"
                  style={{
                    flex: '0 1 auto', maxHeight: '52%', overflowY: 'auto',
                    padding: '0 18px 18px', display: 'flex', flexDirection: 'row', gap: 10,
                  }}
                >
                  {osDist.length === 0 ? (
                    <div style={{ fontSize: 11, color: '#475569', textAlign: 'center', padding: '2px 0', flex: 1 }}>暂无数据</div>
                  ) : (
                    splitEven(osDist, osDist.length > 8 ? 2 : 1).map((col, ci) => (
                      <div key={ci} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {col.map((x) => {
                          const i = osDist.indexOf(x)
                          const pct = osTotal > 0 ? Math.round((x.value / osTotal) * 100) : 0
                          return (
                            <div
                              key={x.name}
                              title={`${x.name} · ${x.value} 台（${pct}%）`}
                              style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11 }}
                            >
                              <i style={{ width: 8, height: 8, borderRadius: 2, flex: '0 0 auto', alignSelf: 'center', background: OS_COLORS[i % OS_COLORS.length] }} />
                              <span style={{ flex: '1 1 auto', minWidth: 0, color: '#cbd5e1', lineHeight: 1.3, wordBreak: 'break-word' }}>{x.name}</span>
                              <b className="dash-num" style={{ flex: '0 0 auto', color: '#e2e8f0' }}>{x.value}</b>
                            </div>
                          )
                        })}
                      </div>
                    ))
                  )}
                </div>
              </div>
              )}
            </div>
            )}

            {/* ===== 中栏 资源详情（面板可关，关掉后剩余行自动补位） ===== */}
            {MID_ON && (
            <div style={{ display: 'grid', gridTemplateRows: MID_ROWS, gap: 10, minHeight: 0 }}>
              {/* Gauge ×4 一行 */}
              {on('gauges') && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, height: 86 }}>
                <Gauge label="CPU 平均" value={avg?.cpu || 0} color="#38bdf8" />
                <Gauge label="内存平均" value={avg?.mem || 0} color="#a78bfa" />
                <Gauge label="磁盘平均" value={avg?.disk || 0} color="#22d3ee" />
                {/* 网络平均：按参考带宽算百分比（网卡上报标称速率的主机极少） */}
                <Gauge label="网络平均" value={avg?.net || 0} color="#fbbf24" />
              </div>
              )}

              {/* 负载 TOP N：四个榜各自可关（v1.7.42），关掉后同行剩下的自动分宽 */}
              {TOP_ANY && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${TOP_ITEMS.length}, 1fr)`,
                  gap: 10, height: 196,
                }}
              >
                {TOP_ITEMS.map((it) => (
                  <div
                    className="dash-panel"
                    key={it.key}
                    data-panel={it.key}
                    style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
                  >
                    <div className="dash-title"><FireOutlined /> {it.title}</div>
                    <AutoScroll speed={SCROLL_SPEED.top} fade={10}>
                      <TopList rows={it.rows} metric={it.metric} filtered={topFiltered} />
                    </AutoScroll>
                  </div>
                ))}
              </div>
              )}

              {/* 各主机柱状图 + 资源健康分布（同一行并排；关掉其中一个时另一个独占整行） */}
              {MID_SPLIT && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: on('hostBars') && on('healthDist') ? '2fr 1fr' : '1fr',
                  gap: 10, flex: 1, minHeight: 0,
                }}
              >
                {on('hostBars') && (
                <div className="dash-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                  <div className="dash-title"><DashboardOutlined /> 各主机 CPU/内存/磁盘/网络 实时使用率</div>
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <ReactECharts option={barsOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                  </div>
                </div>
                )}
                {on('healthDist') && (
                <div className="dash-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                  <div className="dash-title"><DashboardOutlined /> 资源健康分布</div>
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <ReactECharts option={distOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                  </div>
                </div>
                )}
              </div>
              )}

              {/* 趋势图：设计高 230，成为最后一个可见行时自动占满剩余高度 */}
              {on('trend') && (
              <div className="dash-panel" style={{ height: '100%', minHeight: 230, display: 'flex', flexDirection: 'column' }}>
                <div className="dash-title"><FundOutlined /> 资源使用率趋势（近 {trendHours} 小时）</div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <ReactECharts option={trendOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                </div>
              </div>
              )}
            </div>
            )}

            {/* ===== 右栏 告警区（面板可关，关掉后剩余面板自动补位） ===== */}
            {RIGHT_ON && (
            <div style={{ display: 'grid', gridTemplateRows: RIGHT_ROWS, gap: 10, minHeight: 0 }}>
              {/* 告警列表（阈值自算，替代原先恒空的 Prometheus ALERTS） */}
              {on('alerts') && (
              <div className="dash-panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
                <div className="dash-title">
                  <AlertOutlined /> 实时告警列表
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8', textTransform: 'none' }}>
                    严重 {issueStat.crit} · 关注 {issueStat.warn}
                  </span>
                </div>
                {issues.length === 0 ? (
                  <div className="dash-empty" style={{ flex: 1, minHeight: 0, flexDirection: 'column', gap: 8 }}>
                    <InboxOutlined style={{ fontSize: 32, color: '#22c55e' }} />
                    <span style={{ color: '#22c55e' }}>
                      {riskControlled ? '当前策略下没有需要展示的风险项' : '当前无告警 · 系统运行平稳'}
                    </span>
                    {riskControlled && (
                      <span style={{ fontSize: 11, color: '#64748b' }}>
                        已按「{cfg?.riskLevel === 'crit' ? '仅严重' : '仅关注'}」口径过滤
                        {cfg?.maskMode === 'whitelist' ? ' + 白名单' : ''}，可在「大屏管理」调整
                      </span>
                    )}
                  </div>
                ) : (
                  <AutoScroll speed={SCROLL_SPEED.alert} fade={14} style={{ padding: '6px 12px' }}>
                    {issues.map((it, i) => (
                      <AlertItem key={`${it.instance}-${it.metric}-${i}`} it={it} />
                    ))}
                  </AutoScroll>
                )}
              </div>
              )}

              {/* 告警等级 + 告警趋势（同一行并排；关掉其中一个时另一个独占整行） */}
              {RIGHT_SPLIT && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: on('alertLevel') && on('alertTrend') ? '1fr 1fr' : '1fr',
                  gap: 10, height: 190,
                }}
              >
                {on('alertLevel') && (
                <div className="dash-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                  <div className="dash-title"><AlertOutlined /> 告警等级</div>
                  <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                    <ReactECharts option={lvOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                    {/* 圆心总数：填补空心，比外置标签更省地方，也不会被任何边界裁切 */}
                    <div
                      style={{
                        position: 'absolute', inset: 0, pointerEvents: 'none',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      <div className="dash-num" style={{ fontSize: 20, lineHeight: 1, color: lvTotal > 0 ? '#e2e8f0' : '#475569' }}>
                        {lvTotal}
                      </div>
                      <div style={{ fontSize: 9, color: '#64748b', letterSpacing: 1, marginTop: 3 }}>告警项</div>
                    </div>
                  </div>
                  {/* 自绘图例：flexWrap 可换行 → 面板再窄也不会「显示不全」 */}
                  <div
                    style={{
                      display: 'flex', flexWrap: 'wrap', justifyContent: 'center',
                      gap: '2px 12px', padding: '0 8px 7px', fontSize: 11,
                    }}
                  >
                    {lvList.map((x) => (
                      <span key={x.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#94a3b8' }}>
                        <i style={{ width: 8, height: 8, borderRadius: 2, background: x.color, display: 'inline-block' }} />
                        {x.name}
                        <b className="dash-num" style={{ color: x.value > 0 ? x.color : '#475569' }}>{x.value}</b>
                      </span>
                    ))}
                  </div>
                </div>
                )}
                {on('alertTrend') && (
                <div className="dash-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                  <div className="dash-title"><AlertOutlined /> 告警趋势</div>
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <ReactECharts option={altTrendOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                  </div>
                </div>
                )}
              </div>
              )}

              {/* 主机实时资源（自动滚动，单列） */}
              {on('hostScroll') && (
              <div className="dash-panel" style={{ height: '100%', minHeight: 240, display: 'flex', flexDirection: 'column' }}>
                <div className="dash-title"><CloudServerOutlined /> 主机实时资源（自动滚动）</div>
                {(data.hosts || []).length === 0 ? (
                  <div className="dash-empty" style={{ flex: 1, minHeight: 0, flexDirection: 'column', gap: 8 }}>
                    <InboxOutlined style={{ fontSize: 24 }} />
                    <span>暂无主机数据</span>
                  </div>
                ) : (
                  <AutoScroll speed={SCROLL_SPEED.host} gap={6} fade={14} style={{ padding: '8px 10px' }}>
                    {data.hosts.map((h, i) => {
                      const c = issueByInst.get(h.instance)
                      return <HostCard key={`${h.instance}-${i}`} h={h} crit={c?.crit || 0} warn={c?.warn || 0} />
                    })}
                  </AutoScroll>
                )}
              </div>
              )}
            </div>
            )}
          </div>
        )}

        {/* ============= 页脚（高 36，全平台元信息一致；可在「大屏管理 → 展示内容」关掉） ============= */}
        {FOOT_ON && (
        <div
          style={{
            height: FOOT_H,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#64748b', fontSize: 11, letterSpacing: 1,
            borderTop: '1px solid rgba(56,189,248,0.08)',
            background: 'linear-gradient(0deg, rgba(2,6,23,0.6), transparent)',
          }}
        >
          数据每 {cfg?.intervalSec ?? 30} 秒采集一次（{cfg?.autoCollect === 1 ? '自动采集已开启' : '自动采集已关闭，需手动触发'}）
          · 采集时间：
          <span style={{ color: '#94a3b8', margin: '0 4px' }}>{fmtDateTime(data?.generatedAt)}</span>
          {data?.collectMs ? (
            <>
              · 耗时：
              <span style={{ color: '#94a3b8', margin: '0 4px' }}>{Math.round(data.collectMs / 1000) || '<1'}s</span>
            </>
          ) : null}
          · 数据源：
          <span style={{ color: '#94a3b8', margin: '0 4px' }}>{dsName}</span>
          · 监控目标：
          <span style={{ color: '#94a3b8', margin: '0 4px' }}>
            {up?.total || 0} 台（在线 {up?.online || 0} / 离线 {up?.offline || 0}（其中 {Math.max(0, (up?.total || 0) - (up?.hosts || 0))} 台未采集到资源））
          </span>
          · 超阈值：
          <span style={{ color: issueStat.crit > 0 ? '#f87171' : '#94a3b8', margin: '0 4px' }}>
            严重 {issueStat.crit} · 关注 {issueStat.warn}
          </span>
        </div>
        )}
      </div>
    </div>
  )
}

// ====== 小组件 ======
function KpiRow({ icon, label, value, color, sub }: { icon: React.ReactNode; label: string; value: any; color: string; sub?: string }) {
  return (
    // height:'100%' + minHeight:88 —— 关掉「操作系统分布」之类的同行面板后，
    // KPI 卡会被 grid 拉伸去补位，固定 height:88 会变成「卡片间空出一条缝」。
    <div className="dash-panel" style={{ height: '100%', minHeight: 88, padding: '10px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#94a3b8', fontSize: 11 }}>
        <span style={{ color, fontSize: 13 }}>{icon}</span> {label}
      </div>
      <div className="dash-num" style={{ fontSize: 22, color, marginTop: 2, textShadow: `0 0 10px ${color}55` }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function Gauge({ label, value, color }: { label: string; value: number; color: string }) {
  const v = Number(value || 0)
  const c = usageColor(v)
  return (
    <div className="dash-panel" style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ color: '#94a3b8', fontSize: 11 }}>{label} 使用率</div>
      <div style={{ position: 'relative', height: 30, marginTop: 4, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="dash-num" style={{ fontSize: 26, color: c, textShadow: `0 0 10px ${c}66`, minWidth: 64 }}>
          {v.toFixed(1)}<span style={{ fontSize: 11, color: '#64748b', marginLeft: 2 }}>%</span>
        </div>
        <div style={{ flex: 1, height: 6, background: 'rgba(148,163,184,0.18)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${Math.min(100, v)}%`, height: '100%', background: c, boxShadow: `0 0 6px ${c}` }} />
        </div>
      </div>
    </div>
  )
}

function MiniBar({ label, v }: { label: string; v?: number }) {
  const num = typeof v === 'number' ? v : Number(v || 0)
  const c = usageColor(num)
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 9, color: '#64748b' }}>{label}</div>
      <div style={{ height: 4, background: 'rgba(148,163,184,0.18)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, num)}%`, height: '100%', background: c, boxShadow: `0 0 4px ${c}` }} />
      </div>
    </div>
  )
}

function HostCard({ h, crit, warn }: { h: PromHostStat; crit: number; warn: number }) {
  return (
    <div
      style={{
        height: 52, display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', borderRadius: 8,
        background: h.up ? 'rgba(148,163,184,0.06)' : 'rgba(239,68,68,0.08)',
        border: h.up ? '1px solid rgba(148,163,184,0.12)' : '1px solid rgba(239,68,68,0.4)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{ fontSize: 12, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={`${hostName(h)} · ${h.instance}`}
        >
          {hostName(h)}
        </div>
        {/* 副行与巡检大屏同位：发行版原文（node_os_info）+ IP，而不是部门 */}
        <div style={{ fontSize: 9, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {h.osName || h.osFamily || '—'} {h.instance ? `· ${h.instance}` : ''}
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
          <MiniBar label="CPU" v={h.cpu} />
          <MiniBar label="MEM" v={h.mem} />
          <MiniBar label="DISK" v={h.disk} />
          {/* 网络：按参考带宽算百分比（网卡上报标称速率的主机极少，缺了就按配置带宽） */}
          <MiniBar label="NET" v={h.net} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
        {crit > 0 && <Tag color="red" className="dash-blink" style={{ margin: 0, fontSize: 9, lineHeight: '14px', padding: '0 4px' }}>严重 {crit}</Tag>}
        {warn > 0 && <Tag color="orange" style={{ margin: 0, fontSize: 9, lineHeight: '14px', padding: '0 4px' }}>关注 {warn}</Tag>}
        <Tag
          color={h.up ? 'success' : 'error'}
          className={h.up ? '' : 'dash-blink'}
          style={{ margin: 0, fontSize: 9, lineHeight: '14px', padding: '0 4px' }}
        >
          {h.up ? '在线' : '离线'}
        </Tag>
      </div>
    </div>
  )
}

function TopList({
  rows,
  metric,
  filtered,
}: {
  rows: PromTopEntry[]
  metric: 'cpu' | 'mem' | 'disk' | 'net'
  /** 是否配了屏蔽规则 —— 配了的话空榜要说明「可能是被规则挡掉了」，别让运维当成采集故障 */
  filtered?: boolean
}) {
  if (!rows || rows.length === 0) {
    return (
      <div className="dash-empty" style={{ height: '100%', minHeight: 80, flexDirection: 'column' }}>
        <InboxOutlined style={{ fontSize: 22 }} />
        <span>暂无 {metric.toUpperCase()} 负载数据</span>
        {filtered && <span style={{ fontSize: 10, color: '#f59e0b' }}>已按「屏蔽规则」过滤</span>}
      </div>
    )
  }
  return (
    <div style={{ padding: '4px 10px' }}>
      {rows.map((r, i) => (
        <div
          key={`${r.instance}-${i}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '5px 0',
            borderBottom: '1px dashed rgba(148,163,184,0.12)',
          }}
        >
          <span style={{ color: '#38bdf8', fontSize: 12, fontWeight: 700, width: 14 }}>{i + 1}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{ fontSize: 12, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              title={hostName(r)}
            >
              {hostName(r)}
            </div>
            <div style={{ fontSize: 10, color: '#64748b' }}>
              {r.instance} {r.department ? `· ${r.department}` : ''}
            </div>
          </div>
          <div style={{ width: 80, height: 5, background: 'rgba(148,163,184,0.18)', borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.min(100, Number(r.value || 0))}%`,
                height: '100%',
                background: usageColor(Number(r.value || 0)),
                boxShadow: `0 0 6px ${usageColor(Number(r.value || 0))}`,
              }}
            />
          </div>
          <div className="dash-num" style={{ fontSize: 13, color: usageColor(Number(r.value || 0)), minWidth: 50, textAlign: 'right' }}>
            {Number(r.value || 0).toFixed(1)}%
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 告警条目（阈值派生，替代原先恒空的 Prometheus ALERTS）。
 * 结构与巡检大屏的 AlertItem 逐格对应：圆点 + 名称 + IP + 右侧等级标签，
 * 第二行是「指标 / 指标=值 / 部门 / 环境」标签组。
 * 唯一删掉的是「打开终端」—— Prometheus 的 target 不一定对应 CMDB 资产，没有 webtermUrl。
 */
function AlertItem({ it }: { it: PromIssue }) {
  const crit = it.level === 'crit'
  const lvColor = crit ? '#ef4444' : '#f59e0b'
  return (
    <div style={{ padding: '7px 0', borderBottom: '1px dashed rgba(148,163,184,0.18)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span
            className={crit ? 'dash-blink' : ''}
            style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: lvColor,
              boxShadow: crit ? `0 0 8px ${lvColor}` : 'none', flex: '0 0 auto',
            }}
          />
          <span
            style={{
              fontWeight: 600, color: '#e2e8f0', fontSize: 12,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130,
            }}
            title={`${it.name || it.instance} · ${it.instance}`}
          >
            {it.name || it.instance}
          </span>
          <span style={{ color: '#64748b', fontSize: 10 }}>{it.instance}</span>
        </div>
        <Tag
          color={crit ? 'red' : 'orange'}
          className={crit ? 'dash-blink' : ''}
          style={{ margin: 0, fontSize: 10, flex: '0 0 auto' }}
        >
          {it.levelCN}
        </Tag>
      </div>
      <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
        <Tag color="geekblue" style={{ margin: 0 }}>{it.metricCN}</Tag>
        <Tag color="purple" style={{ margin: 0 }}>
          {it.metric === 'offline' ? '连通性 = 失联' : `${it.metricCN} = ${Number(it.value || 0).toFixed(1)}%`}
        </Tag>
        {it.department && <Tag style={{ margin: 0 }}>{it.department}</Tag>}
        {it.env && <Tag color="cyan" style={{ margin: 0 }}>{it.env}</Tag>}
      </div>
    </div>
  )
}

// ====== ECharts 配置 ======
// 大屏所有 tooltip 的统一基线。默认值（浅色底 + 位置不受限 + white-space:nowrap）在窄面板里必然出问题：
// 类别名较长时提示框会一路横移到面板左边界之外，被 .dash-panel 的 overflow:hidden 切掉半截。
// 三个约束一起上才彻底解决：
//   ① confine:true  → 位置锁在图表容器内，永不出界；
//   ② 深色玻璃底    → 与整屏深色风格一致（默认白底在深色大屏上非常刺眼）；
//   ③ 允许换行 + 限宽 → 长名称折行显示完整，而不是把框撑到容器之外。
const TOOLTIP_BASE = {
  confine: true,
  backgroundColor: 'rgba(15,23,42,0.96)',
  borderColor: 'rgba(56,189,248,0.45)',
  borderWidth: 1,
  padding: [7, 11],
  textStyle: { color: '#e2e8f0', fontSize: 12, lineHeight: 18 },
  extraCssText:
    'max-width:262px;white-space:normal;word-break:break-word;border-radius:8px;box-shadow:0 8px 26px rgba(0,0,0,.55);',
}

// 前 7 色与巡检大屏完全一致（家族数 ≤7 时观感与巡检大屏等同）；
// 后面 7 色是补的 —— OS 家族实测有 14 类，只有 7 色会让第 1/8、2/9… 撞色，
// 环形图上看不出是两个类别，图例色块也失去指引作用。
const OS_COLORS = [
  '#38bdf8', '#a78bfa', '#22d3ee', '#fbbf24', '#34d399', '#f472b6', '#94a3b8',
  '#f97316', '#4ade80', '#e879f9', '#60a5fa', '#facc15', '#2dd4bf', '#fb7185',
]

// 类别名是 OS 家族名（最长约 "RHEL/CentOS 8"、"华为 HCE"）。实测在 ~290px 宽的面板里：
// 外置标签会被 overflow:hidden 截断，原生 legend 一条就占满一行、退化成翻页。
// 因此一律不外置标签、也不用原生 legend，名称与台数交给面板下方自绘的可换行图例。
function osDistOption(list: { name: string; value: number }[]) {
  const hasData = list.length > 0
  return {
    backgroundColor: 'transparent',
    // 占位切片（暂无数据）不参与 tooltip，否则会报出一个不存在的「1 台」
    tooltip: hasData ? { ...TOOLTIP_BASE, trigger: 'item', formatter: '{b}<br/>{c} 台（{d}%）' } : { show: false },
    series: [
      {
        type: 'pie',
        radius: ['58%', '86%'],
        center: ['50%', '50%'],
        itemStyle: { borderColor: '#0b1120', borderWidth: 2 },
        label: { show: false },
        labelLine: { show: false },
        data: hasData
          ? list.map((x, i) => ({ name: x.name, value: x.value, itemStyle: { color: OS_COLORS[i % OS_COLORS.length] } }))
          : [{ name: '暂无数据', value: 1, itemStyle: { color: '#334155' } }],
      },
    ],
  }
}

// 资源健康分布。口径与巡检大屏同构：
//   正常 / 关注 / 预警 / 严重 按主机 max(CPU,内存,磁盘) 分档，
//   最后一档巡检叫「未采集」（在 CMDB 里但这次没采到），监控这边叫「离线」
//   （!up 或一个资源值都没采到）—— 都是「不该算进正常、也不能丢台数」的那一批。
function distOption(dist: { low: number; mid: number; high: number; crit: number; none?: number }) {
  const none = dist.none || 0
  const hasData = (dist.low + dist.mid + dist.high + dist.crit + none) > 0
  // 0 值的类别只作为 legend 占位（保持图例固定、不跳动），
  // 但必须显式关掉标签与引线：0 值扇形根本不存在，ECharts 仍会画标签+引线。
  const slice = (name: string, value: number, color: string) => ({
    name, value, itemStyle: { color },
    ...(value > 0 ? {} : { label: { show: false }, labelLine: { show: false } }),
  })
  return {
    backgroundColor: 'transparent',
    tooltip: { ...TOOLTIP_BASE, trigger: 'item' },
    legend: { textStyle: { color: '#94a3b8' }, bottom: 0, type: 'scroll' },
    series: [
      {
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '45%'],
        itemStyle: { borderColor: '#0b1120', borderWidth: 2 },
        label: { color: '#cbd5e1', formatter: '{b}\n{d}%' },
        data: hasData ? [
          slice('正常', dist.low, '#22c55e'),
          slice('关注', dist.mid, '#38bdf8'),
          slice('预警', dist.high, '#f59e0b'),
          slice('严重', dist.crit, '#ef4444'),
          slice('离线', none, '#64748b'),
        ] : [{ name: '暂无数据', value: 1, itemStyle: { color: '#334155' } }],
      },
    ],
  }
}

function trendOption(trend: { ts: number; cpu?: number | null; mem?: number | null; disk?: number | null }[]) {
  return {
    backgroundColor: 'transparent',
    grid: { left: 50, right: 18, top: 30, bottom: 30 },
    tooltip: { ...TOOLTIP_BASE, trigger: 'axis' },
    legend: { textStyle: { color: '#94a3b8' }, data: ['CPU', '内存', '磁盘'], top: 4 },
    xAxis: {
      type: 'category',
      data: trend.map((t) => dayjs(t.ts * 1000).format('HH:mm')),
      axisLine: { lineStyle: { color: 'rgba(148,163,184,0.3)' } },
      axisLabel: { color: '#94a3b8', fontSize: 10, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      max: 100,
      axisLabel: { color: '#94a3b8', formatter: '{value}%' },
      splitLine: { lineStyle: { color: 'rgba(148,163,184,0.1)' } },
    },
    series: [
      {
        name: 'CPU',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: trend.map((t) => (t.cpu == null ? null : Number(t.cpu))),
        itemStyle: { color: '#38bdf8' },
        areaStyle: { color: 'rgba(56,189,248,0.15)' },
        lineStyle: { width: 2 },
      },
      {
        name: '内存',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: trend.map((t) => (t.mem == null ? null : Number(t.mem))),
        itemStyle: { color: '#a78bfa' },
        areaStyle: { color: 'rgba(167,139,250,0.12)' },
      },
      {
        name: '磁盘',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: trend.map((t) => (t.disk == null ? null : Number(t.disk))),
        itemStyle: { color: '#22d3ee' },
      },
    ],
  }
}

function hostBarsOption(hosts: PromHostStat[]) {
  // 只取水位最高的 10 台，否则上千台主机会把 Y 轴挤成一片糊
  const data = (hosts || [])
    .filter((h) => h.up)
    .slice()
    .sort((a, b) => Math.max(b.cpu, b.mem, b.disk, b.net) - Math.max(a.cpu, a.mem, a.disk, a.net))
    .slice(0, 10)
  return {
    backgroundColor: 'transparent',
    // 主机展示名可能是「项目简称_环境_业务环境」这类较长组合，
    // 左侧留够宽度并用 truncate 截断，避免挤压绘图区；tooltip 仍显示完整名称
    grid: { left: 132, right: 18, top: 20, bottom: 30 },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (ps: any[]) => {
        if (!ps || !ps.length) return ''
        const full = hostName(data[ps[0].dataIndex] || {})
        const rows = ps.map((p) => `${p.marker}${p.seriesName} ${Number(p.value || 0).toFixed(1)}%`).join('<br/>')
        return `<b>${full}</b><br/>${rows}`
      },
    },
    legend: { textStyle: { color: '#94a3b8' }, data: ['CPU', '内存', '磁盘', '网络'], top: 0 },
    xAxis: {
      type: 'value',
      max: 100,
      axisLabel: { color: '#94a3b8', formatter: '{value}%' },
      splitLine: { lineStyle: { color: 'rgba(148,163,184,0.1)' } },
    },
    yAxis: {
      type: 'category',
      data: data.map((h) => hostName(h)),
      axisLine: { lineStyle: { color: 'rgba(148,163,184,0.3)' } },
      axisLabel: { color: '#94a3b8', fontSize: 10, width: 118, overflow: 'truncate' },
    },
    series: [
      { name: 'CPU', type: 'bar', data: data.map((h) => h.cpu), itemStyle: { color: '#38bdf8' }, barWidth: 5 },
      { name: '内存', type: 'bar', data: data.map((h) => h.mem), itemStyle: { color: '#a78bfa' }, barWidth: 5 },
      { name: '磁盘', type: 'bar', data: data.map((h) => h.disk), itemStyle: { color: '#22d3ee' }, barWidth: 5 },
      { name: '网络', type: 'bar', data: data.map((h) => h.net), itemStyle: { color: '#fbbf24' }, barWidth: 5 },
    ],
  }
}

function alertLevelOption(list: { name: string; value: number; color: string }[]) {
  return {
    backgroundColor: 'transparent',
    tooltip: { ...TOOLTIP_BASE, trigger: 'item' },
    // 该面板实测只有 ~150×150（右栏 190px 行高 / 两列均分），外置标签+引线会顶出面板被
    // overflow:hidden 裁掉，也会压住底部图例；这个宽度也放不下带数值的原生图例。
    // 因此一律不外置标签，数值交给下方自绘的可换行图例承载，圆环只负责比例。
    series: [
      {
        type: 'pie',
        radius: ['58%', '86%'],
        center: ['50%', '50%'],
        itemStyle: { borderColor: '#0b1120', borderWidth: 2 },
        label: { show: false },
        labelLine: { show: false },
        data: list.some((x) => x.value > 0)
          ? list.map((x) => ({ name: x.name, value: x.value, itemStyle: { color: x.color } }))
          : [{ name: '无告警', value: 1, itemStyle: { color: '#334155' } }],
      },
    ],
  }
}

function alertTrendOption(points: { ts: number; crit: number; warn: number }[]) {
  const series = (points || []).map((p) => ({
    label: dayjs(p.ts * 1000).format('HH:mm'),
    crit: p.crit,
    warn: p.warn,
  }))
  return {
    backgroundColor: 'transparent',
    // containLabel:true → 左右留白由「轴标签实测宽度」决定，面板随视口比例变化也不会压刻度。
    grid: { left: 2, right: 8, top: 34, bottom: 2, containLabel: true },
    tooltip: { ...TOOLTIP_BASE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    // 图例独占顶部一条带（6~22px），绘图区从 34px 起 —— 图例与柱子、与最高刻度都有净空。
    legend: {
      textStyle: { color: '#94a3b8', fontSize: 11 },
      data: ['严重', '关注'],
      top: 6,
      itemWidth: 12,
      itemHeight: 8,
      itemGap: 14,
      icon: 'roundRect',
    },
    xAxis: {
      type: 'category',
      data: series.map((s) => s.label),
      axisLine: { lineStyle: { color: 'rgba(148,163,184,0.3)' } },
      axisTick: { show: false },
      // hideOverlap：窄面板里时刻标签会互相压字，交给 ECharts 自动抽样
      axisLabel: { color: '#94a3b8', fontSize: 9, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#94a3b8', fontSize: 10 },
      splitLine: { lineStyle: { color: 'rgba(148,163,184,0.1)' } },
    },
    series: [
      {
        name: '严重',
        type: 'bar',
        stack: 'a',
        data: series.map((s) => s.crit),
        itemStyle: { color: '#ef4444' },
        // 柱子按类目宽度的比例走：面板从 156px 拉伸到 225px 时柱距同步变宽
        barWidth: '38%',
        barMaxWidth: 16,
      },
      {
        name: '关注',
        type: 'bar',
        stack: 'a',
        data: series.map((s) => s.warn),
        itemStyle: { color: '#f59e0b' },
        barWidth: '38%',
        barMaxWidth: 16,
      },
    ],
  }
}
