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
  RocketOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  InboxOutlined,
  LogoutOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import { getDashboard } from '../api/inspection'
import { openCenteredWindow } from '../utils/window'
import { useAuth } from '../store/AuthContext'
import { firstAccessiblePath } from '../utils/perms'

// 巡检大屏只展示生产环境数据（资产「环境」字段取值：生产环境 / 测试环境）。
// 如需调整，改这里即可，后端 /inspection/dashboard 已支持 ?env= 过滤。
const DASHBOARD_ENV = '生产环境'

interface Host {
  id: number
  name: string
  ip: string
  zone: string
  env: string
  system: string
  status: string
  osName: string
  osArch: string
  cores: number
  memTotal: number
  diskTotal: number
  cpuUsage: number
  memUsage: number
  diskMax: number
  netUsage: number
  iowait: number
  loadRatio: number
  procDown: number
  procTotal: number
  zombie: number
  fwStatus: string
  sshFail: number
  alertCount: number
  alertCrit: number
  alertWarn: number
  disks: { mount: string; device: string; fstype: string; role: string; usage: number; total_gb: number; used_gb: number }[]
}
interface Dash {
  generatedAt?: string
  // assetTotal = 按当前筛选命中的 CMDB 资产数（分母）；covered = 其中最近一次巡检采到的台数；
  // notCollected = assetTotal - covered（未采集）。afterFilter 为旧字段，等价 covered，仅兼容。
  scope?: { zone: string; env: string; arch: string; totalAssets: number; assetTotal?: number; covered: number; afterFilter: number; notCollected?: number }
  filters?: { zones: { name: string; count: number }[]; envs: { name: string; count: number }[]; archs: { name: string; label: string; count: number }[] }
  kpi?: {
    assetTotal: number
    hostTotal: number
    vmOn: number
    vmOff: number
    taskCount: number
    recordCount: number
    alertCrit: number
    alertWarn: number
    alertInfo: number
    alertAssets: number
    diskWarn: number
    diskCrit: number
  }
  resource?: { avgCpu: number; avgMem: number; avgDisk: number; avgNet: number; totalCores: number; totalMemGb: number; totalDiskGb: number }
  // none = 「未采集」：在 CMDB 资产列表里、但最近一次巡检没有结果的资产（单列一块灰色）
  usageDist?: { low: number; mid: number; high: number; crit: number; none?: number }
  alerts?: { name: string; ip: string; zone: string; env: string; system: string; level: string; category: string; metric: string; value: string; note: string; collectedAt: string; assetId?: number }[]
  alertByCategory?: Record<string, number>
  alertByLevel?: { critical: number; warning: number; info: number }
  alertByLevelDist?: { name: string; value: number; color: string }[]
  hosts?: Host[]
  topLoad?: { cpu: any[]; mem: any[]; disk: any[]; net: any[] }
  trend?: { runAt: string; avgCpu: any; avgMem: any; avgDisk: any; alertTotal: any; status: string }[]
  osDist?: { name: string; value: number }[]
  latestRecord?: { id: number; runAt: string; taskName: string; status: string; durationMs: number; successCount: number; failCount: number }
}

const CAT_LABEL: Record<string, string> = {
  os: '操作系统',
  cpu: 'CPU',
  mem: '内存',
  disk: '磁盘',
  net: '网络',
  proc: '进程',
  svc: '服务',
  security: '安全',
}

// ============= 自适应画布 =============
// 设计高度锁 1080，宽度按视口宽高比动态计算 → 任何比例屏幕都能填满，无黑边
const DESIGN_H = 1080
const MIN_W = 1440 // 超窄屏保底宽度（再窄就按宽度缩放，保证内容可读）
const MAX_W = 2560 // 超宽屏上限（再宽中间栏会过于稀疏）
const REFRESH_INTERVAL_S = 30

/** 按视口计算：画布设计宽度 + 缩放比 */
function fitCanvas(vw: number, vh: number) {
  const aspect = vw / vh
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(DESIGN_H * aspect)))
  // 竖向永远填满；宽度被 clamp 住时改用宽度缩放（此时竖向留黑边，属于合理降级）
  const scale = Math.min(vh / DESIGN_H, vw / w)
  return { w, scale }
}

function fmtTime(d?: string) {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return '—'
  }
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
const CatLabel = (k: string) => CAT_LABEL[k] || k

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
   文字块被父级 flex 居中后，标题文字的中心就正好落在画布中轴上（原来整张 SVG 居中，
   但 SVG 内图形只占左侧 ~70%，视觉重心整体偏左约 40px，看着就是「没对齐」）。 */
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
   默认整颗按钮平移到画布外，被画布 overflow:hidden 裁掉（同时不可命中，无需 pointer-events 处理）；
   鼠标移入左上角热区或按钮获得键盘焦点时才滑入。热区高度 = TOP_H，只覆盖顶栏空白带，
   不会盖住下方任何面板，因此不影响其它交互。热区内两个元素都用绝对定位，落点即 left/top 设计值。 */
.dash-edge { position: absolute; left: 0; top: 0; z-index: 40; }
.dash-edge__hint {
  position: absolute; left: 6px; top: 28px; width: 3px; height: 36px; border-radius: 2px;
  background: linear-gradient(180deg, rgba(56,189,248,0.05), rgba(56,189,248,0.5), rgba(56,189,248,0.05));
  transition: opacity .26s ease;
}
/* 自动滚动容器：位移由 AutoScroll 组件的 rAF 逐帧累加（transform 子像素 + GPU 合成），
   因此不出现原生滚动条、也不会因数据刷新而跳回起点。 */
.dash-autoscroll { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.dash-autoscroll-track { will-change: transform; }
/* 仅在「图例真的放不下」时才出现的细滚动条（OS 原值名称长、类别多时兜底） */
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
  // 时钟/日期：与上方标题共用同一条垂直中轴（父级 .dash-brand 为 align-items:center），
  // 字号按「大屏远看要读得清」调大了一档（时间 13→17、日期 10→12.5），
  // 数值用 .dash-num 的等宽数字，秒跳动时不会左右抖。
  return (
    <div style={{ textAlign: 'center', lineHeight: 1.05 }}>
      <div ref={timeRef} className="dash-num dash-brand__time" style={{ fontSize: 17, color: '#e2e8f0', letterSpacing: 1.5 }}>
        00:00:00
      </div>
      <div ref={dateRef} className="dash-brand__date" style={{ fontSize: 12.5, color: '#7f8ea3', letterSpacing: 1.5, marginTop: 2 }}>--</div>
    </div>
  )
})

// ============= 子组件：NextRefresh（独立 setInterval，真正倒计时） =============
const NextRefresh = memo(function NextRefresh({ lastAt, intervalS }: { lastAt: number; intervalS: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const tick = () => {
      if (!ref.current) return
      const remain = Math.max(0, intervalS - Math.floor((Date.now() - lastAt) / 1000))
      ref.current.textContent = remain > 0 ? `下次预计 ${remain}s 后` : '正在刷新…'
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [lastAt, intervalS])
  return <div ref={ref} style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>—</div>
})

// ============= 子组件：AlertItem（点击直接打开 Web 终端，便于找问题） =============
// onOpen 接受完整 webtermUrl（后端 IP 反查后的真实路径），避免前端硬拼 /webterm/{assetId}
// 时仍可能命中悬挂外键导致「加载资产信息失败」。
const AlertItem = memo(function AlertItem({ a, onOpen, canTerm }: { a: any; onOpen: (url: string, name: string) => void; canTerm: boolean }) {
  const lvColor = a.level === 'critical' ? '#ef4444' : a.level === 'warning' ? '#f59e0b' : '#38bdf8'
  // 后端 webtermUrl 已经做过 IP 反查；旧字段 assetId 兜底仍保留，但通常走 webtermUrl 分支
  const webtermUrl: string = a.webtermUrl || (a.assetId ? `/webterm/${a.assetId}` : '')
  // 终端为高敏感操作（可 su - root 拿到目标机最高权限）：仅管理员可见 / 可点击。
  // 只读等非管理员角色即使有 webtermUrl 也不显示入口、不可点击。
  const canOpen = !!webtermUrl && canTerm
  return (
    <div style={{ padding: '7px 0', borderBottom: '1px dashed rgba(148,163,184,0.18)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span
            className={a.level === 'critical' ? 'dash-blink' : ''}
            style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: lvColor,
              boxShadow: a.level === 'critical' ? `0 0 8px ${lvColor}` : 'none',
            }}
          />
          <span
            onClick={() => canOpen && onOpen(webtermUrl, a.name || a.ip)}
            style={{
              fontWeight: 600, color: '#e2e8f0', fontSize: 12, cursor: canOpen ? 'pointer' : 'default',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130,
              borderBottom: canOpen ? `1px dotted ${lvColor}` : 'none',
            }}
            title={canOpen ? `点击进入 ${a.name || a.ip} 的 Web 终端` : a.name || a.ip}
          >
            {a.name || a.ip || '—'}
          </span>
          <span style={{ color: '#64748b', fontSize: 10 }}>{a.ip}</span>
        </div>
        <Tag color={a.level === 'critical' ? 'red' : a.level === 'warning' ? 'orange' : 'blue'} className={a.level === 'critical' ? 'dash-blink' : ''} style={{ margin: 0, fontSize: 10 }}>
          {a.level === 'critical' ? '严重' : a.level === 'warning' ? '预警' : '提示'}
        </Tag>
      </div>
      <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
        <Tag color="geekblue" style={{ margin: 0 }}>{CatLabel(a.category || '')}</Tag>
        <Tag color="purple" style={{ margin: 0 }}>{a.metric} = {a.value}</Tag>
        {a.zone && <Tag style={{ margin: 0 }}>{a.zone}</Tag>}
        {a.env && <Tag color="cyan" style={{ margin: 0 }}>{a.env}</Tag>}
        {canOpen ? (
          <span
            onClick={() => onOpen(webtermUrl, a.name || a.ip)}
            style={{ fontSize: 11, color: '#38bdf8', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 2 }}
          >
            <RocketOutlined /> 打开终端
          </span>
        ) : null}
      </div>
      {a.note && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{a.note}</div>}
    </div>
  )
})

// ============= 子组件：AutoScroll（无缝平滑自动滚动） =============
// 观感目标：恒定线速度、无跳变、无抖动。
// 做法：内容渲染两份（上下紧贴、无间隙），用 rAF 逐帧累加位移并整体 translate3d；
//       位移达到「一份内容」高度时减去该高度 → 视觉上无限循环，接缝处完全吻合。
// 为什么不用 CSS animation：大屏每 30s 刷新会重渲，CSS 动画会被重置回起点（跳变）；
//       且固定 duration 会让「内容多就飞快、内容少几乎不动」。rAF 的位移量存在 ref 里，跨重渲连续。
// 内容不足一屏时自动不滚，避免原地微抖。
const SCROLL_SPEED = {
  host: 14,   // 主机实时资源：卡片较高，慢一点更从容
  top: 10,    // TOP5：仅 5 行，低速避免一闪而过
  alert: 17,  // 告警列表：条目多，略快保证一轮不至于太久
}

const AutoScroll = memo(function AutoScroll({
  children, speed = 26, gap = 0, fade = 12, style,
}: {
  children: React.ReactNode
  speed?: number            // px/s（恒定线速度，与内容多少无关）
  gap?: number              // 同一份内容内的元素间距
  fade?: number             // 上下渐隐高度（px），0 = 不渐隐
  style?: React.CSSProperties
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const copyHRef = useRef(0)      // 一份内容的高度
  const offsetRef = useRef(0)     // 当前已滚动位移
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

export default function InspectionScreen() {
  const { isAdmin, hasPerm, logout } = useAuth()
  // 「只看大屏」账号（仅授予 inspection:screen）：除大屏外没有任何可访问页面，
  // 此时不提供「返回主界面」（回去也只会被弹回大屏），改为提供「退出登录」，
  // 否则这类账号进到大屏后无法登出。
  const onlyScreen = firstAccessiblePath(hasPerm) === '/inspection/screen'
  const [data, setData] = useState<Dash | null>(null)
  const [loading, setLoading] = useState(false)
  const [canvas, setCanvas] = useState(() => fitCanvas(window.innerWidth, window.innerHeight))
  const [isFull, setIsFull] = useState(false)
  // 返回键默认藏在画布外，鼠标移到左上角热区（或按钮键盘聚焦）才滑入
  const [backShown, setBackShown] = useState(false)
  const [lastLoadAt, setLastLoadAt] = useState<number>(Date.now())
  const timer = useRef<number>()
  const loadingRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const load = () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    getDashboard({ env: DASHBOARD_ENV })
      .then((d) => {
        setData(d as Dash)
        setLastLoadAt(Date.now())
      })
      .catch(() => undefined)
      .finally(() => {
        loadingRef.current = false
        setLoading(false)
      })
  }

  // 自适应：窗口尺寸 / 进入退出全屏时重算画布
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

  // 大屏巡检属分钟级场景，30s 刷新一次
  useEffect(() => {
    load()
    timer.current = window.setInterval(load, REFRESH_INTERVAL_S * 1000)
    return () => window.clearInterval(timer.current)
  }, [])

  // 浏览器原生全屏切换
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

  const openTerm = (url: string, name: string) => {
    if (!isAdmin) return // 终端仅管理员可打开，前端二次防御（后端 /api/ws/ssh 也强制 admin）
    if (!url) return
    // 从 url 里抽 id 作为 window.name（不同会话用不同 name，避免复用同一个窗口）
    const id = url.split('/').pop() || name || 'asset'
    const w = openCenteredWindow(
      url,
      `webterm-${id}`,
      1280,
      860,
      'menubar=no,toolbar=no,location=no,status=no',
    )
    if (!w) {
      console.warn(`[大屏] 浏览器拦截了新窗口: ${id} ${name}`)
    }
  }

  // ============ 缓存 echarts option（必须在条件 return 之前，保持 hook 顺序） ============
  const osOpt = useMemo(() => osDistOption(data?.osDist || []), [data?.osDist])
  const barsOpt = useMemo(() => hostBarsOption(data?.hosts || []), [data?.hosts])
  const distOpt = useMemo(() => distOption(data?.usageDist || { low: 0, mid: 0, high: 0, crit: 0, none: 0 }), [data?.usageDist])
  const lvOpt = useMemo(() => alertLevelOption(data?.alertByLevelDist || []), [data?.alertByLevelDist])
  const lvTotal = useMemo(() => (data?.alertByLevelDist || []).reduce((s, x) => s + x.value, 0), [data?.alertByLevelDist])
  const osTotal = useMemo(() => (data?.osDist || []).reduce((s, x) => s + x.value, 0), [data?.osDist])
  const trOpt = useMemo(() => alertTrendOption(data?.trend || []), [data?.trend])
  const trendOpt = useMemo(() => trendOption(data?.trend || []), [data?.trend])

  if (!data) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#060b18' }}>
        <Spin size="large" tip="加载巡检数据中…" />
      </div>
    )
  }

  // === 画布内可用尺寸（设计稿基准 1920×1080） ===
  // 顶栏 92 + 主体 920 + 页脚 36 = 1048，剩 32 = 上下各 16 内边距
  const TOP_H = 92
  const FOOT_H = 36
  const BODY_H = DESIGN_H - TOP_H - FOOT_H
  const BODY_PAD = 16
  // 真正超宽屏（21:9 / 32:9）才展开为 4 列含网络；常规 16:9 用 3 列更宽松
  const TOP_COLS = canvas.w >= 2000 ? 4 : 3

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed', inset: 0, overflow: 'hidden',
        background: '#04060b',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <style>{styles}</style>

      {/* 设计稿画布：高度锁 1080，宽度随视口比例，等比缩放填满屏幕 */}
      <div
        data-testid="dash-canvas"
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
            热区高度只占顶栏 TOP_H、宽度 150，正好落在左上角空白带里，不覆盖任何面板，
            因此下方所有面板的悬停/点击都不受影响；按钮落点在热区内部，指针从热区移到按钮上
            不会触发 mouseleave（按钮是热区后代），不存在「够不到」的缝隙。 */}
        <div
          className="dash-edge"
          style={{ width: 150, height: TOP_H }}
          onMouseEnter={() => setBackShown(true)}
          onMouseLeave={() => setBackShown(false)}
        >
          {/* 极淡的提示条：否则按钮完全不可见、没人知道这里能点（不需要可随时删掉这一行） */}
          <div className="dash-edge__hint" style={{ opacity: backShown ? 0 : 0.8 }} />
          {/* 这里刻意不用 antd Tooltip：鼠标一进热区按钮就滑到指针下，antd 提示会立刻弹出、
              用浅色卡片盖住左上角 KPI 面板，在大屏上属于纯干扰。
              改用原生 title（悬停约 1s 才出、不抢镜）+ aria-label（读屏可读）。 */}
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
              // 绝对定位（而非热区里的 flex 兄弟）：落点就是 left/top 的值本身，
              // 不会被前面的提示条挤出偏移；否则按钮会从设计值 x=24 漂到 x=33。
              position: 'absolute', left: 24, top: 18,
              height: 56, width: 56, borderRadius: 10,
              // 纯图标按钮（按要求去掉「返回主界面」文字）：与右侧「全屏」同款方形深色玻璃片，
              // 返回属「导航」不是主操作，不能和右侧「刷新数据」那种亮色主按钮抢视觉；
              // 语义由 title / aria-label 承载，图标本身足够自明。
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
          {/* 左簇：留空占位。
              返回键已移出网格、改为「左上角边缘隐藏」（见下方 .dash-edge 热区），
              所以这里保留一个空 div 撑住 1fr 列，否则中簇会被挤到左列、失去居中。 */}
          <div />

          {/* 中簇：品牌（图标 + 中文标题 + 英文副标）+ 时钟/日期，绝对居中 */}
          <div className="dash-brand">
            <div className="dash-brand__row">
              {/* 图标：绝对定位挂在文字块左侧，不参与文字块宽度 → 标题文字中心 = 画布中轴 */}
              <img className="dash-brand__icon" src="/inspection-logo-icon.svg" alt="" aria-hidden="true" />
              <div className="dash-brand__text">
                {/* 内层 span 用负 margin 抵消末位字距，让「视觉中心」而不是「盒子中心」对齐中轴 */}
                <div className="dash-brand__cn"><span>云枢 OpsHub</span></div>
                <div className="dash-brand__en"><span>XIANGYUN VM INSPECTION PLATFORM</span></div>
              </div>
            </div>
            <LiveClock />
          </div>

          {/* 右簇：最近巡检 + 刷新数据 + 全屏（刷新最右） */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
            <div
              style={{
                height: 56, padding: '0 14px', borderRadius: 10,
                border: '1px solid rgba(56,189,248,0.3)',
                background: 'rgba(15,23,42,0.7)', color: '#e2e8f0',
                lineHeight: 1.15, minWidth: 168,
                display: 'flex', flexDirection: 'column', justifyContent: 'center',
              }}
            >
              <div style={{ fontSize: 10, color: '#64748b', letterSpacing: 2 }}>最近巡检</div>
              <div className="dash-num" style={{ fontSize: 14, color: '#e2e8f0', marginTop: 2 }}>
                {data.latestRecord?.runAt
                  ? new Date(data.latestRecord.runAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                  : '—'}
              </div>
              <NextRefresh lastAt={lastLoadAt} intervalS={REFRESH_INTERVAL_S} />
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
            <button
              onClick={load}
              title="手动刷新"
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

        {/* ============= 主体三栏（列宽按比例自适应，列缝全高对齐） ============= */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'clamp(260px, 17%, 420px) 1fr clamp(290px, 19%, 460px)',
            gap: 12,
            padding: `0 ${BODY_PAD}px`,
            height: BODY_H,
            alignItems: 'stretch',
          }}
        >
          {/* ===== 左栏 L1 集群总览（grid rows，5 KPI 固定高 + OS 占满） ===== */}
          <div style={{ display: 'grid', gridTemplateRows: '96px 88px 88px 88px 88px 88px 1fr', gap: 10, minHeight: 0 }}>
            {/* 容量卡：三列等分 */}
            <div className="dash-panel" style={{ height: 96, padding: '0 14px', display: 'flex', alignItems: 'center' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div style={{ color: '#94a3b8', fontSize: 10, letterSpacing: 1 }}>CPU 核数</div>
                <div className="dash-num" style={{ fontSize: 24, color: '#38bdf8', textShadow: '0 0 12px rgba(56,189,248,0.4)' }}>
                  {Math.round(data.resource?.totalCores || 0)}<span style={{ fontSize: 11, color: '#64748b', marginLeft: 3 }}>核</span>
                </div>
              </div>
              <div style={{ width: 1, height: 50, background: 'rgba(56,189,248,0.15)' }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: 12 }}>
                <div style={{ color: '#94a3b8', fontSize: 10, letterSpacing: 1 }}>内存</div>
                <div className="dash-num" style={{ fontSize: 24, color: '#a78bfa', textShadow: '0 0 12px rgba(167,139,250,0.4)' }}>
                  {data.resource?.totalMemGb?.toFixed(0) || 0}<span style={{ fontSize: 11, color: '#64748b', marginLeft: 3 }}>GB</span>
                </div>
              </div>
              <div style={{ width: 1, height: 50, background: 'rgba(56,189,248,0.15)' }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: 12 }}>
                <div style={{ color: '#94a3b8', fontSize: 10, letterSpacing: 1 }}>存储</div>
                <div className="dash-num" style={{ fontSize: 24, color: '#22d3ee', textShadow: '0 0 12px rgba(34,211,238,0.4)' }}>
                  {data.resource?.totalDiskGb?.toFixed(0) || 0}<span style={{ fontSize: 11, color: '#64748b', marginLeft: 3 }}>GB</span>
                </div>
              </div>
            </div>

            <KpiRow icon={<CloudServerOutlined />} color="#38bdf8" label="资产 / 主机" value={`${data.kpi?.assetTotal || 0} / ${data.kpi?.hostTotal || 0}`} sub={`已采集 ${data.scope?.covered || 0} · 未采集 ${data.scope?.notCollected || 0}`} />
            <KpiRow icon={<DashboardOutlined />} color="#22c55e" label="虚拟机运行" value={`${data.kpi?.vmOn || 0} / ${data.kpi?.vmOff || 0}`} sub={`运行 / 关停 · 未采集 ${data.scope?.notCollected || 0}`} />
            <KpiRow icon={<AlertOutlined />} color={data.kpi?.alertCrit ? '#ef4444' : '#f59e0b'} label="告警项 / 资产" value={`${(data.kpi?.alertCrit || 0) + (data.kpi?.alertWarn || 0) + (data.kpi?.alertInfo || 0)} / ${data.kpi?.alertAssets || 0}`} sub={`严重 ${data.kpi?.alertCrit || 0} · 预警 ${data.kpi?.alertWarn || 0} · 提示 ${data.kpi?.alertInfo || 0}`} />
            <KpiRow icon={<HddOutlined />} color={data.kpi?.diskCrit ? '#ef4444' : data.kpi?.diskWarn ? '#f59e0b' : '#22c55e'} label="磁盘告警" value={`${data.kpi?.diskWarn || 0} / ${data.kpi?.diskCrit || 0}`} sub="预警 / 严重（按告警规则）" />
            <KpiRow icon={<FundOutlined />} color="#818cf8" label="巡检任务 / 记录" value={`${data.kpi?.taskCount || 0} / ${data.kpi?.recordCount || 0}`} sub="总任务 / 总记录" />

            {/* OS 分布饼图：图 + 可换行图例（类别名是 CMDB 原值，很长） */}
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
              {/* 自绘图例：名称原样展示、允许折行、绝不省略 —— 与资源列表逐字一致。
                  右下 18px 内边距是为了避开面板右下角的 10×10 装饰角标（::after 内缩 4px）：
                  实测 10/8 时最后一个数值会横向压进角标盒 3.3px、纵向压进 5.3px，肉眼就是「1 挤在角标上」。 */}
              <div
                className="dash-thin"
                style={{
                  flex: '0 1 auto', maxHeight: '48%', overflowY: 'auto',
                  padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: 3,
                }}
              >
                {(data.osDist || []).length === 0 ? (
                  <div style={{ fontSize: 11, color: '#475569', textAlign: 'center', padding: '2px 0' }}>暂无数据</div>
                ) : (
                  (data.osDist || []).map((x, i) => {
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
                  })
                )}
              </div>
            </div>
          </div>

          {/* ===== 中栏 L3 资源详情（grid rows：4 行严格等高） ===== */}
          <div style={{ display: 'grid', gridTemplateRows: '86px 196px 1fr 230px', gap: 10, minHeight: 0 }}>
            {/* Gauge ×4 一行 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, height: 86 }}>
              <Gauge label="CPU 平均" value={data.resource?.avgCpu || 0} color="#38bdf8" />
              <Gauge label="内存平均" value={data.resource?.avgMem || 0} color="#a78bfa" />
              <Gauge label="磁盘平均" value={data.resource?.avgDisk || 0} color="#22d3ee" />
              <Gauge label="网络平均" value={data.resource?.avgNet || 0} color="#fbbf24" />
            </div>

            {/* 负载 TOP5：宽屏自动展开为 4 列（含网络），窄屏 3 列 */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${TOP_COLS}, 1fr)`,
                gap: 10, height: 196,
              }}
            >
              {[
                { title: 'CPU 负载 TOP5', rows: data.topLoad?.cpu || [] },
                { title: '内存负载 TOP5', rows: data.topLoad?.mem || [] },
                { title: '磁盘负载 TOP5', rows: data.topLoad?.disk || [] },
                { title: '网络负载 TOP5', rows: data.topLoad?.net || [] },
              ]
                .slice(0, TOP_COLS)
                .map((it) => (
                  <div className="dash-panel" key={it.title} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                    <div className="dash-title"><FireOutlined /> {it.title}</div>
                    <AutoScroll speed={SCROLL_SPEED.top} fade={10}>
                      <TopList rows={it.rows} metric={it.title.slice(0, 2) === 'CP' ? 'cpu' : it.title.slice(0, 2) === '内存' ? 'mem' : it.title.slice(0, 2) === '磁盘' ? 'disk' : 'net'} />
                    </AutoScroll>
                  </div>
                ))}
            </div>

            {/* 主机柱状图 + 资源健康分布 */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, flex: 1, minHeight: 0 }}>
              <div className="dash-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                <div className="dash-title"><DashboardOutlined /> 各主机 CPU/内存/磁盘/网络 实时使用率</div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <ReactECharts option={barsOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                </div>
              </div>
              <div className="dash-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                <div className="dash-title"><DashboardOutlined /> 资源健康分布</div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <ReactECharts option={distOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                </div>
              </div>
            </div>

            {/* 趋势图：固定高 230 */}
            <div className="dash-panel" style={{ height: 230, display: 'flex', flexDirection: 'column' }}>
              <div className="dash-title"><FundOutlined /> 资源使用率趋势（最近 14 次巡检）</div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <ReactECharts option={trendOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
              </div>
            </div>
          </div>

          {/* ===== 右栏 L2 告警区（grid rows：告警列表占满 + 固定两块） ===== */}
          <div style={{ display: 'grid', gridTemplateRows: '1fr 190px 240px', gap: 10, minHeight: 0 }}>
            {/* 告警列表 */}
            <div className="dash-panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
              <div className="dash-title">
                <AlertOutlined /> 实时告警列表
                <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8', textTransform: 'none' }}>
                  严重 {data.kpi?.alertCrit || 0} · 预警 {data.kpi?.alertWarn || 0}
                </span>
              </div>
              {(data.alerts || []).length === 0 ? (
                <div className="dash-empty" style={{ flex: 1, minHeight: 0, flexDirection: 'column', gap: 8 }}>
                  <InboxOutlined style={{ fontSize: 32, color: '#22c55e' }} />
                  <span style={{ color: '#22c55e' }}>当前无告警 · 系统运行平稳</span>
                </div>
              ) : (
                <AutoScroll speed={SCROLL_SPEED.alert} fade={14} style={{ padding: '6px 12px' }}>
                  {(data.alerts || []).map((a: any, i: number) => (
                    <AlertItem key={`${a.assetId || a.ip || i}-${i}`} a={a} onOpen={openTerm} canTerm={isAdmin} />
                  ))}
                </AutoScroll>
              )}
            </div>

            {/* 告警等级 + 告警趋势 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, height: 190 }}>
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
                {/* 自绘图例：flexWrap 可换行 → 面板再窄也不会「显示不全」（原生 legend 放不下会变 scroll，一滚照样看不全） */}
                <div
                  style={{
                    display: 'flex', flexWrap: 'wrap', justifyContent: 'center',
                    gap: '2px 12px', padding: '0 8px 7px', fontSize: 11,
                  }}
                >
                  {(data.alertByLevelDist || []).map((x) => (
                    <span key={x.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#94a3b8' }}>
                      <i style={{ width: 8, height: 8, borderRadius: 2, background: x.color, display: 'inline-block' }} />
                      {x.name}
                      <b className="dash-num" style={{ color: x.value > 0 ? x.color : '#475569' }}>{x.value}</b>
                    </span>
                  ))}
                </div>
              </div>
              <div className="dash-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                <div className="dash-title"><AlertOutlined /> 告警趋势</div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <ReactECharts option={trOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                </div>
              </div>
            </div>

            {/* 主机实时资源（自动滚动，单列） */}
            <div className="dash-panel" style={{ height: 240, display: 'flex', flexDirection: 'column' }}>
              <div className="dash-title"><CloudServerOutlined /> 主机实时资源（自动滚动）</div>
              {(data.hosts || []).length === 0 ? (
                <div className="dash-empty" style={{ flex: 1, minHeight: 0, flexDirection: 'column', gap: 8 }}>
                  <InboxOutlined style={{ fontSize: 24 }} />
                  <span>暂无主机数据</span>
                </div>
              ) : (
                <AutoScroll speed={SCROLL_SPEED.host} gap={6} fade={14} style={{ padding: '8px 10px' }}>
                  {(data.hosts || []).map((h: any, i: number) => (
                    <HostCard key={i} h={h} />
                  ))}
                </AutoScroll>
              )}
            </div>
          </div>
        </div>

        {/* ============= 页脚（高 36，全平台元信息一致） ============= */}
        <div
          style={{
            height: FOOT_H,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#64748b', fontSize: 11, letterSpacing: 1,
            borderTop: '1px solid rgba(56,189,248,0.08)',
            background: 'linear-gradient(0deg, rgba(2,6,23,0.6), transparent)',
          }}
        >
          数据每 {REFRESH_INTERVAL_S} 秒自动刷新 · 最近巡检：
          <span style={{ color: '#94a3b8', margin: '0 4px' }}>{fmtDateTime(data.latestRecord?.runAt)}</span>
          · 任务：
          <span style={{ color: '#94a3b8', margin: '0 4px' }}>{data.latestRecord?.taskName || '—'}</span>
          · 耗时：
          <span style={{ color: '#94a3b8', margin: '0 4px' }}>{data.latestRecord?.durationMs ? `${Math.round(data.latestRecord.durationMs / 1000)}s` : '—'}</span>
          · 成功/失败：
          <span style={{ color: '#94a3b8', margin: '0 4px' }}>{data.latestRecord?.successCount || 0} / {data.latestRecord?.failCount || 0}</span>
          {data.generatedAt && (
            <>
              · 生成时间：
              <span style={{ color: '#94a3b8', margin: '0 4px' }}>{fmtTime(data.generatedAt)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ====== 小组件 ======
function KpiRow({ icon, label, value, color, sub }: { icon: React.ReactNode; label: string; value: any; color: string; sub?: string }) {
  return (
    <div className="dash-panel" style={{ height: 88, padding: '10px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
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
  const c = usageColor(value)
  return (
    <div className="dash-panel" style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ color: '#94a3b8', fontSize: 11 }}>{label} 使用率</div>
      <div style={{ position: 'relative', height: 30, marginTop: 4, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="dash-num" style={{ fontSize: 26, color: c, textShadow: `0 0 10px ${c}66`, minWidth: 64 }}>
          {value}<span style={{ fontSize: 11, color: '#64748b', marginLeft: 2 }}>%</span>
        </div>
        <div style={{ flex: 1, height: 6, background: 'rgba(148,163,184,0.18)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${Math.min(100, value)}%`, height: '100%', background: c, boxShadow: `0 0 6px ${c}` }} />
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

function HostCard({ h }: { h: any }) {
  return (
    <div
      style={{
        height: 52, display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', borderRadius: 8,
        background: 'rgba(148,163,184,0.06)', border: '1px solid rgba(148,163,184,0.12)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{ fontSize: 12, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={h.name || h.ip}
        >
          {h.name || h.ip}
        </div>
        <div style={{ fontSize: 9, color: '#64748b' }}>
          {h.osName || ''} {h.osArch ? `· ${h.osArch}` : ''}
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
          <MiniBar label="CPU" v={h.cpuUsage} />
          <MiniBar label="MEM" v={h.memUsage} />
          <MiniBar label="DISK" v={h.diskMax} />
          <MiniBar label="NET" v={h.netUsage} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
        {h.alertCrit > 0 && <Tag color="red" className="dash-blink" style={{ margin: 0, fontSize: 9, lineHeight: '14px', padding: '0 4px' }}>严重 {h.alertCrit}</Tag>}
        {h.alertWarn > 0 && <Tag color="orange" style={{ margin: 0, fontSize: 9, lineHeight: '14px', padding: '0 4px' }}>预警 {h.alertWarn}</Tag>}
        <Tag color={h.status === 'ok' ? 'success' : 'error'} style={{ margin: 0, fontSize: 9, lineHeight: '14px', padding: '0 4px' }}>
          {h.status === 'ok' ? '正常' : '失败'}
        </Tag>
      </div>
    </div>
  )
}

function TopList({ rows, metric }: { rows: any[]; metric: 'cpu' | 'mem' | 'disk' | 'net' }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="dash-empty" style={{ height: '100%', minHeight: 80, flexDirection: 'column' }}>
        <InboxOutlined style={{ fontSize: 22 }} />
        <span>暂无 {metric.toUpperCase()} 负载数据</span>
      </div>
    )
  }
  return (
    <div style={{ padding: '4px 10px' }}>
      {rows.map((r, i) => (
        <div
          key={i}
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
              title={r.name || r.ip}
            >
              {r.name || r.ip}
            </div>
            <div style={{ fontSize: 10, color: '#64748b' }}>
              {r.ip} {r.zone ? `· ${r.zone}` : ''} {r.cores ? `· ${r.cores} 核` : ''}
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

// ====== ECharts 配置 ======
// 大屏所有 tooltip 的统一基线。之前用 ECharts 默认值（浅色底 + 位置不受限 + white-space:nowrap），
// 在窄面板里必然出问题：OS 类别名是 CMDB 原值（"AlmaLinux 8.9 (Midnight Oncilla)"，约 32 字符），
// 提示框会一路横移到面板左边界之外，被 .dash-panel 的 overflow:hidden 切掉半截（只剩 "…Oncilla)"）。
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

const OS_COLORS = ['#38bdf8', '#a78bfa', '#22d3ee', '#fbbf24', '#34d399', '#f472b6', '#94a3b8']
// 类别名是 CMDB 资源列表「操作系统版本」字段的**原值**（如 "Huawei Cloud EulerOS 2.0 (aarch64)"，
// 约 32 字符）。实测在 288px 宽的面板里：外置标签被 overflow:hidden 截成「AlmaLinux 8...」，
// 原生 legend 一条就占满一行、退化成「1/3」翻页（等于一次只看得到一类）。
// 因此这里一律不外置标签、也不用原生 legend，名称与台数交给面板下方自绘的可换行图例。
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
function distOption(dist: { low: number; mid: number; high: number; crit: number; none?: number }) {
  const none = dist.none || 0
  const hasData = (dist.low + dist.mid + dist.high + dist.crit + none) > 0
  // 0 值的类别只作为 legend 占位（保持图例固定、不跳动），
  // 但必须显式关掉标签与引线：0 值扇形根本不存在，ECharts 仍会画标签+引线，
  // 实测「正常 0%」「严重 0%」的引线横穿画面压住「未采集」，很乱。
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
          // 「未采集」= 在资产列表里但这次巡检没采到 → 单独一块灰，既不丢台数也不冒充正常
          slice('未采集', none, '#64748b'),
        ] : [{ name: '暂无数据', value: 1, itemStyle: { color: '#334155' } }],
      },
    ],
  }
}
function trendOption(trend: any[]) {
  return {
    backgroundColor: 'transparent',
    grid: { left: 50, right: 18, top: 30, bottom: 30 },
    tooltip: { ...TOOLTIP_BASE, trigger: 'axis' },
    legend: { textStyle: { color: '#94a3b8' }, data: ['CPU', '内存', '磁盘'], top: 4 },
    xAxis: {
      type: 'category',
      data: trend.map((t) => t.runAt),
      axisLine: { lineStyle: { color: 'rgba(148,163,184,0.3)' } },
      axisLabel: { color: '#94a3b8', fontSize: 10 },
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
        data: trend.map((t) => Number(t.avgCpu) || 0),
        itemStyle: { color: '#38bdf8' },
        areaStyle: { color: 'rgba(56,189,248,0.15)' },
        lineStyle: { width: 2 },
      },
      {
        name: '内存',
        type: 'line',
        smooth: true,
        data: trend.map((t) => Number(t.avgMem) || 0),
        itemStyle: { color: '#a78bfa' },
        areaStyle: { color: 'rgba(167,139,250,0.12)' },
      },
      {
        name: '磁盘',
        type: 'line',
        smooth: true,
        data: trend.map((t) => Number(t.avgDisk) || 0),
        itemStyle: { color: '#22d3ee' },
      },
    ],
  }
}
function hostBarsOption(hosts: Host[]) {
  const data = (hosts || []).slice(0, 10) // 防止太多
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
        const full = data[ps[0].dataIndex]?.name || data[ps[0].dataIndex]?.ip || '—'
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
      data: data.map((h) => h.name || h.ip || '—'),
      axisLine: { lineStyle: { color: 'rgba(148,163,184,0.3)' } },
      axisLabel: { color: '#94a3b8', fontSize: 10, width: 118, overflow: 'truncate' },
    },
    series: [
      { name: 'CPU', type: 'bar', data: data.map((h) => h.cpuUsage), itemStyle: { color: '#38bdf8' }, barWidth: 5 },
      { name: '内存', type: 'bar', data: data.map((h) => h.memUsage), itemStyle: { color: '#a78bfa' }, barWidth: 5 },
      { name: '磁盘', type: 'bar', data: data.map((h) => h.diskMax), itemStyle: { color: '#22d3ee' }, barWidth: 5 },
      { name: '网络', type: 'bar', data: data.map((h) => h.netUsage), itemStyle: { color: '#fbbf24' }, barWidth: 5 },
    ],
  }
}
function alertLevelOption(list: { name: string; value: number; color: string }[]) {
  return {
    backgroundColor: 'transparent',
    tooltip: { ...TOOLTIP_BASE, trigger: 'item' },
    // 该面板实测只有 ~150×150（右栏 190px 行高 / 两列均分），外置标签+引线往上会顶出
    // 面板被 overflow:hidden 裁掉（「严重 7」缺失）、往下会压住底部图例（「预警 31」叠字），
    // 而这个宽度也放不下带数值的原生图例（3 项会超出 → scroll 一滚就又「显示不全」）。
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
function alertTrendOption(trend: any[]) {
  const series = trend.map((t) => {
    let crit = 0
    let warn = 0
    if (t.alertTotal && typeof t.alertTotal === 'object') {
      Object.entries(t.alertTotal as Record<string, number>).forEach(([k, v]) => {
        if (k === 'cpu' || k === 'os' || k === 'security') crit += v
        else warn += v
      })
    }
    return { runAt: t.runAt, crit, warn }
  })
  return {
    backgroundColor: 'transparent',
    // containLabel:true → 左右留白由「轴标签实测宽度」决定。原来写死 left:38 / right:12，
    // 而面板宽度是随视口比例变化的（实测 156 / 174 / 225px 三档），写死的边距在窄档会把
    // 「60」这种高位刻度压到面板外，在宽档又显得内容偏左。
    grid: { left: 2, right: 8, top: 34, bottom: 2, containLabel: true },
    tooltip: { ...TOOLTIP_BASE, trigger: 'axis', axisPointer: { type: 'shadow' } },
    // 图例独占顶部一条带：原来 legend.top=0 与 grid.top=20 互相叠压，
    // 窄面板里最高的柱子正好顶到图例下沿，看着像「柱子被图例切掉 / 图例压在图上」。
    // 现在图例占 6~22px、绘图区从 34px 起，图例与柱子、与最高刻度都留出净空；
    // 色块缩到 12×8 后两个条目合计约 90px，156px 窄面板里也不与 y 轴刻度抢位。
    legend: {
      textStyle: { color: '#94a3b8', fontSize: 11 },
      data: ['严重', '预警'],
      top: 6,
      itemWidth: 12,
      itemHeight: 8,
      itemGap: 14,
      icon: 'roundRect',
    },
    xAxis: {
      type: 'category',
      data: series.map((s) => s.runAt),
      axisLine: { lineStyle: { color: 'rgba(148,163,184,0.3)' } },
      axisTick: { show: false },
      // hideOverlap：窄面板里时刻标签会互相压字，交给 ECharts 自动抽样（而不是硬挤成糊）
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
        // 柱子按类目宽度的比例走：面板从 156px 拉伸到 225px 时柱距同步变宽，
        // 不会出现「固定 12px 柱在一大片空白里显得又细又孤」的失调感
        barWidth: '38%',
        barMaxWidth: 16,
      },
      {
        name: '预警',
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
