import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Spin, Tag, Tooltip } from 'antd'
import {
  AlertOutlined,
  ArrowLeftOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FireOutlined,
  FundOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  InboxOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import dayjs from 'dayjs'
import {
  promOverview,
  listPromDataSources,
  type PromOverview,
  type PromDataSource,
  type PromHostStat,
  type PromTopEntry,
} from '../api/prometheus'

/**
 * Prometheus 监控大屏
 *
 * 与巡检大屏完全同一套布局与视觉语言（深蓝科技风 + 角标面板 + 自适应缩放画布）：
 *   - 设计高度锁 1080，宽度按视口宽高比动态计算，任何比例屏幕无黑边；
 *   - 顶栏：边缘隐藏返回键 + 品牌/时钟居中 + 数据源/全屏/刷新；
 *   - 左栏：容量卡（目标/在线/离线）+ KPI 行 + 资源健康分布饼图；
 *   - 中栏：资源仪表×4 + 负载 TOP5×3 + 各主机使用率柱状图 + 24h 趋势；
 *   - 右栏：实时告警列表（自动滚动）+ 告警等级 + 主机实时资源（自动滚动）；
 *   - 30s 自动刷新（倒计时可见）。
 *
 * 主机展示名与巡检大屏资产展示名同口径：项目名_环境_业务环境_虚拟机IPv4（空段跳过）。
 */
const DESIGN_H = 1080
const MIN_W = 1440
const MAX_W = 2560
const REFRESH_INTERVAL_S = 30

function fitCanvas(vw: number, vh: number) {
  const aspect = vw / vh
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(DESIGN_H * aspect)))
  const scale = Math.min(vh / DESIGN_H, vw / w)
  return { w, scale }
}

function usageColor(v: number) {
  if (v >= 90) return '#ef4444'
  if (v >= 80) return '#f59e0b'
  return '#22c55e'
}

/** 主机展示名：项目名_环境_业务环境_虚拟机IPv4（空段跳过），与巡检大屏资产展示名同口径 */
function hostName(h: Partial<PromHostStat>): string {
  const parts = [h.system, h.env, h.deployserver, h.instance].filter((x) => !!x && String(x).trim() !== '')
  if (parts.length > 1) return parts.join('_')
  return h.hostname || h.instance || '—'
}

const styles = `
@keyframes screenBlink { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.prom-screen-root { font-family: -apple-system, "PingFang SC", "Microsoft Yahei", sans-serif; }
.prom-grid-bg {
  position: absolute; inset: 0; pointer-events: none;
  background-image:
    linear-gradient(rgba(56,189,248,0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(56,189,248,0.05) 1px, transparent 1px);
  background-size: 48px 48px;
}
.prom-panel {
  position: relative; background: linear-gradient(160deg, rgba(15,23,42,0.78), rgba(2,6,23,0.62));
  border: 1px solid rgba(56,189,248,0.22); border-radius: 10px;
  box-shadow: 0 0 24px rgba(56,189,248,0.08) inset, 0 8px 30px rgba(0,0,0,0.4);
  overflow: hidden;
}
.prom-panel::before, .prom-panel::after { content: ''; position: absolute; width: 10px; height: 10px; border-color: #38bdf8; pointer-events: none; }
.prom-panel::before { top: 4px; left: 4px; border-top: 2px solid; border-left: 2px solid; }
.prom-panel::after { bottom: 4px; right: 4px; border-bottom: 2px solid; border-right: 2px solid; }
.prom-title {
  font-size: 13px; letter-spacing: 2px; color: #7dd3fc;
  padding: 8px 12px; border-bottom: 1px solid rgba(56,189,248,0.15);
  display: flex; align-items: center; gap: 6px; text-transform: uppercase; height: 34px;
}
.prom-num { font-variant-numeric: tabular-nums; font-weight: 700; letter-spacing: 1px; }
.prom-blink { animation: screenBlink 1.6s ease-in-out infinite; }
.prom-empty { color: #475569; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; }
.prom-thin { scrollbar-width: thin; }
.prom-thin::-webkit-scrollbar { width: 4px; }
.prom-thin::-webkit-scrollbar-thumb { background: rgba(56,189,248,0.35); border-radius: 2px; }
.prom-thin::-webkit-scrollbar-track { background: transparent; }
.prom-autoscroll { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.prom-autoscroll-track { will-change: transform; }
`

// ============= LiveClock / NextRefresh =============
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
      <div ref={timeRef} className="prom-num" style={{ fontSize: 17, color: '#e2e8f0', letterSpacing: 1.5 }}>00:00:00</div>
      <div ref={dateRef} style={{ fontSize: 12.5, color: '#7f8ea3', letterSpacing: 1.5, marginTop: 2 }}>--</div>
    </div>
  )
})

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

// ============= AutoScroll（无缝平滑自动滚动，与巡检大屏同款实现） =============
const SCROLL_SPEED = {
  host: 14,  // 主机实时资源：卡片较高，慢一点更从容
  alert: 17, // 告警列表：条目多，略快保证一轮不至于太久
}

const AutoScroll = memo(function AutoScroll({
  children, speed = 26, gap = 0, fade = 12, style,
}: {
  children: React.ReactNode
  speed?: number
  gap?: number
  fade?: number
  style?: React.CSSProperties
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const copyHRef = useRef(0)
  const offsetRef = useRef(0)
  const pausedRef = useRef(false)
  const [running, setRunning] = useState(false)

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

  useEffect(() => {
    if (!running) return
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(80, now - last) / 1000
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
      className="prom-autoscroll"
      onMouseEnter={() => { pausedRef.current = true }}
      onMouseLeave={() => { pausedRef.current = false }}
      style={{ ...style, WebkitMaskImage: mask, maskImage: mask }}
    >
      <div ref={trackRef} className="prom-autoscroll-track">
        <div style={{ display: 'flex', flexDirection: 'column', gap }}>{children}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap }} aria-hidden="true">{children}</div>
      </div>
    </div>
  )
})

// ============= 大屏子组件（与巡检大屏同款） =============
function KpiRow({ icon, label, value, color, sub }: { icon: React.ReactNode; label: string; value: any; color: string; sub?: string }) {
  return (
    <div className="prom-panel" style={{ height: 88, padding: '10px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#94a3b8', fontSize: 11 }}>
        <span style={{ color, fontSize: 13 }}>{icon}</span> {label}
      </div>
      <div className="prom-num" style={{ fontSize: 22, color, marginTop: 2, textShadow: `0 0 10px ${color}55` }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function Gauge({ label, value, color }: { label: string; value: number; color: string }) {
  const v = Math.max(0, Math.min(100, value || 0))
  const c = usageColor(v)
  return (
    <div className="prom-panel" style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ color: '#94a3b8', fontSize: 11 }}>{label}</div>
      <div style={{ position: 'relative', height: 30, marginTop: 4, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="prom-num" style={{ fontSize: 26, color: c, textShadow: `0 0 10px ${c}66`, minWidth: 64 }}>
          {v.toFixed(1)}<span style={{ fontSize: 11, color: '#64748b', marginLeft: 2 }}>%</span>
        </div>
        <div style={{ flex: 1, height: 6, background: 'rgba(148,163,184,0.18)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${v}%`, height: '100%', background: c, boxShadow: `0 0 6px ${c}`, transition: 'width .8s ease' }} />
        </div>
      </div>
    </div>
  )
}

function MiniBar({ label, v }: { label: string; v?: number }) {
  const num = typeof v === 'number' ? v : 0
  const c = usageColor(num)
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 9, color: '#64748b' }}>{label}</div>
      <div style={{ height: 4, background: 'rgba(148,163,184,0.18)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, num)}%`, height: '100%', background: num > 0 ? c : 'transparent', boxShadow: num > 0 ? `0 0 4px ${c}` : 'none' }} />
      </div>
    </div>
  )
}

function HostCard({ h }: { h: PromHostStat }) {
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
          title={hostName(h)}
        >
          {hostName(h)}
        </div>
        <div style={{ fontSize: 9, color: '#64748b' }}>
          {h.department || ''} {h.env ? `· ${h.env}` : ''}
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
          <MiniBar label="CPU" v={h.cpu} />
          <MiniBar label="MEM" v={h.mem} />
          <MiniBar label="DISK" v={h.disk} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
        <Tag color={h.up ? 'success' : 'error'} className={h.up ? '' : 'prom-blink'} style={{ margin: 0, fontSize: 9, lineHeight: '14px', padding: '0 4px' }}>
          {h.up ? '在线' : '离线'}
        </Tag>
      </div>
    </div>
  )
}

function TopList({ rows, metric }: { rows: PromTopEntry[]; metric: string }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="prom-empty" style={{ height: '100%', minHeight: 80, flexDirection: 'column' }}>
        <InboxOutlined style={{ fontSize: 22 }} />
        <span>暂无 {metric} 负载数据</span>
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
          <div className="prom-num" style={{ fontSize: 13, color: usageColor(Number(r.value || 0)), minWidth: 50, textAlign: 'right' }}>
            {Number(r.value || 0).toFixed(1)}%
          </div>
        </div>
      ))}
    </div>
  )
}

function AlertItem({ a, nameOf }: { a: PromOverview['alerts'][number]; nameOf: (inst: string) => string }) {
  const crit = (a.severity || '').toLowerCase() === 'critical'
  const lvColor = crit ? '#ef4444' : (a.severity || '').toLowerCase() === 'warning' ? '#f59e0b' : '#38bdf8'
  return (
    <div style={{ padding: '7px 0', borderBottom: '1px dashed rgba(148,163,184,0.18)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span
            className={crit ? 'prom-blink' : ''}
            style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: lvColor,
              boxShadow: crit ? `0 0 8px ${lvColor}` : 'none',
            }}
          />
          <span
            style={{
              fontWeight: 600, color: '#e2e8f0', fontSize: 12,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150,
            }}
            title={nameOf(a.instance)}
          >
            {nameOf(a.instance)}
          </span>
        </div>
        <Tag color={crit ? 'red' : 'orange'} className={crit ? 'prom-blink' : ''} style={{ margin: 0, fontSize: 10 }}>
          {crit ? '严重' : '预警'}
        </Tag>
      </div>
      <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
        <Tag color="geekblue" style={{ margin: 0 }}>{a.alertname || '—'}</Tag>
        <Tag style={{ margin: 0 }}>{a.instance || '—'}</Tag>
      </div>
      {a.description && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{a.description}</div>}
    </div>
  )
}

// ============= ECharts 配置（与巡检大屏同款深色玻璃 tooltip） =============
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

const DIST_COLORS: Record<string, string> = {
  正常: '#22c55e',
  关注: '#38bdf8',
  预警: '#f59e0b',
  严重: '#ef4444',
  离线: '#64748b',
}

function distOption(dist: { low: number; mid: number; high: number; crit: number; none: number }) {
  const hasData = dist.low + dist.mid + dist.high + dist.crit + dist.none > 0
  const slice = (name: string, value: number) => ({
    name, value, itemStyle: { color: DIST_COLORS[name] },
    ...(value > 0 ? {} : { label: { show: false }, labelLine: { show: false } }),
  })
  return {
    backgroundColor: 'transparent',
    tooltip: { ...TOOLTIP_BASE, trigger: 'item', formatter: '{b}<br/>{c} 台（{d}%）' },
    series: [
      {
        type: 'pie',
        radius: ['58%', '86%'],
        center: ['50%', '50%'],
        itemStyle: { borderColor: '#0b1120', borderWidth: 2 },
        label: { show: false },
        labelLine: { show: false },
        data: hasData
          ? [slice('正常', dist.low), slice('关注', dist.mid), slice('预警', dist.high), slice('严重', dist.crit), slice('离线', dist.none)]
          : [{ name: '暂无数据', value: 1, itemStyle: { color: '#334155' } }],
      },
    ],
  }
}

function hostBarsOption(hosts: PromHostStat[], nameOf: (h: Partial<PromHostStat>) => string) {
  const data = (hosts || []).slice(0, 10)
  return {
    backgroundColor: 'transparent',
    grid: { left: 150, right: 18, top: 20, bottom: 30 },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (ps: any[]) => {
        if (!ps || !ps.length) return ''
        const full = nameOf(data[ps[0].dataIndex] || {})
        const rows = ps.map((p) => `${p.marker}${p.seriesName} ${Number(p.value || 0).toFixed(1)}%`).join('<br/>')
        return `<b>${full}</b><br/>${rows}`
      },
    },
    legend: { textStyle: { color: '#94a3b8' }, data: ['CPU', '内存', '磁盘'], top: 0 },
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
      axisLabel: { color: '#94a3b8', fontSize: 10, width: 136, overflow: 'truncate' },
    },
    series: [
      { name: 'CPU', type: 'bar', data: data.map((h) => h.cpu), itemStyle: { color: '#38bdf8' }, barWidth: 6 },
      { name: '内存', type: 'bar', data: data.map((h) => h.mem), itemStyle: { color: '#a78bfa' }, barWidth: 6 },
      { name: '磁盘', type: 'bar', data: data.map((h) => h.disk), itemStyle: { color: '#22d3ee' }, barWidth: 6 },
    ],
  }
}

function trendOption(trend: PromOverview['trend']) {
  return {
    backgroundColor: 'transparent',
    grid: { left: 50, right: 18, top: 30, bottom: 30 },
    tooltip: { ...TOOLTIP_BASE, trigger: 'axis' },
    legend: { textStyle: { color: '#94a3b8' }, data: ['CPU', '内存'], top: 4 },
    xAxis: {
      type: 'category',
      data: trend.map((p) => dayjs(p.ts * 1000).format('HH:mm')),
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
        data: trend.map((p) => p.cpu ?? null),
        itemStyle: { color: '#38bdf8' },
        areaStyle: { color: 'rgba(56,189,248,0.15)' },
        lineStyle: { width: 2 },
      },
      {
        name: '内存',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: trend.map((p) => p.mem ?? null),
        itemStyle: { color: '#a78bfa' },
        areaStyle: { color: 'rgba(167,139,250,0.12)' },
      },
    ],
  }
}

function alertLevelOption(crit: number, warn: number) {
  const hasData = crit + warn > 0
  return {
    backgroundColor: 'transparent',
    tooltip: { ...TOOLTIP_BASE, trigger: 'item', formatter: '{b}<br/>{c} 条（{d}%）' },
    series: [
      {
        type: 'pie',
        radius: ['58%', '86%'],
        center: ['50%', '50%'],
        itemStyle: { borderColor: '#0b1120', borderWidth: 2 },
        label: { show: false },
        labelLine: { show: false },
        data: hasData
          ? [
              { name: '严重', value: crit, itemStyle: { color: '#ef4444' } },
              { name: '预警', value: warn, itemStyle: { color: '#f59e0b' } },
            ]
          : [{ name: '无告警', value: 1, itemStyle: { color: '#334155' } }],
      },
    ],
  }
}

// ============= 主组件 =============
export default function PromScreen() {
  const [data, setData] = useState<PromOverview | null>(null)
  const [dss, setDss] = useState<PromDataSource[]>([])
  const [ds, setDs] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [lastAt, setLastAt] = useState<number>(Date.now())
  const [canvas, setCanvas] = useState(() => fitCanvas(window.innerWidth, window.innerHeight))
  const [isFull, setIsFull] = useState(false)
  const [backShown, setBackShown] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number>()
  // 数据源代际守卫：大数据源（上千 target）查询可能十几秒，期间用户切走数据源时，
  // 迟到的旧响应必须丢弃，否则会把新数据源的面板覆盖回旧数据
  const dsRef = useRef(ds)
  dsRef.current = ds

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

  const load = () => {
    const target = dsRef.current
    setLoading(true)
    promOverview(target)
      .then((r) => {
        if (dsRef.current !== target) return // 已切走 → 丢弃过期响应
        setData(r)
        setErr(null)
        setLastAt(Date.now())
      })
      .catch((e: any) => {
        if (dsRef.current !== target) return
        setErr(e?.response?.data?.msg || e?.message || '查询失败')
      })
      .finally(() => {
        if (dsRef.current === target) setLoading(false)
      })
  }

  useEffect(() => {
    if (ds === undefined && dss.length > 0) return
    load()
    timer.current = window.setInterval(load, REFRESH_INTERVAL_S * 1000)
    return () => window.clearInterval(timer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds, dss.length])

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

  const goHome = () => {
    if (window.history.length > 1) history.back()
    else window.location.href = '/'
  }

  /* ---------- 派生数据（必须在条件 return 之前，保持 hook 顺序） ---------- */
  const hostMap = useMemo(() => {
    const m = new Map<string, PromHostStat>()
    ;(data?.hosts || []).forEach((h) => m.set(h.instance, h))
    return m
  }, [data?.hosts])
  const nameOf = useMemo(() => {
    return (inst: string) => {
      const h = hostMap.get(inst)
      if (h) return hostName(h)
      return inst || '—'
    }
  }, [hostMap])

  const alertCrit = useMemo(
    () => (data?.alerts || []).filter((a) => (a.severity || '').toLowerCase() === 'critical').length,
    [data?.alerts],
  )
  const alertWarn = useMemo(() => (data?.alertsTotal || 0) - alertCrit, [data?.alertsTotal, alertCrit])
  const alertInstances = useMemo(
    () => new Set((data?.alerts || []).map((a) => a.instance)).size,
    [data?.alerts],
  )

  const distOpt = useMemo(
    () => distOption(data?.usageDist || { low: 0, mid: 0, high: 0, crit: 0, none: 0 }),
    [data?.usageDist],
  )
  const barsOpt = useMemo(
    () =>
      hostBarsOption(
        (data?.hosts || []).filter((h) => h.up).sort((a, b) => Math.max(b.cpu, b.mem, b.disk) - Math.max(a.cpu, a.mem, a.disk)),
        hostName,
      ),
    [data?.hosts],
  )
  const trendOpt = useMemo(() => trendOption(data?.trend || []), [data?.trend])
  const lvOpt = useMemo(() => alertLevelOption(alertCrit, alertWarn), [alertCrit, alertWarn])

  const dsName = useMemo(() => dss.find((x) => x.id === ds)?.name || '—', [dss, ds])
  const distTotal = useMemo(() => {
    const d = data?.usageDist
    return d ? d.low + d.mid + d.high + d.crit + d.none : 0
  }, [data?.usageDist])

  const up = data?.up
  const onlineRate = up && up.total > 0 ? ((up.online / up.total) * 100).toFixed(1) : '0.0'
  const avg = data?.avg
  const overall = avg ? Math.round((avg.cpu + avg.mem + avg.disk) / 3) : 0

  // === 画布内可用尺寸（与巡检大屏一致：顶栏 92 + 主体 + 页脚 36） ===
  const TOP_H = 92
  const FOOT_H = 36
  const BODY_H = DESIGN_H - TOP_H - FOOT_H
  const BODY_PAD = 16

  return (
    <div
      ref={containerRef}
      className="prom-screen-root"
      style={{
        position: 'fixed', inset: 0, overflow: 'hidden',
        background: '#04060b',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <style>{styles}</style>

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
        <div className="prom-grid-bg" />

        {/* ============= 左上角「边缘隐藏」返回键（与巡检大屏同款） ============= */}
        <div
          style={{ position: 'absolute', left: 0, top: 0, zIndex: 40, width: 150, height: TOP_H }}
          onMouseEnter={() => setBackShown(true)}
          onMouseLeave={() => setBackShown(false)}
        >
          <button
            title="返回主界面"
            onClick={goHome}
            onFocus={() => setBackShown(true)}
            onBlur={() => setBackShown(false)}
            aria-label="返回主界面"
            style={{
              position: 'absolute', left: 24, top: 18,
              height: 56, width: 56, borderRadius: 10,
              background: 'rgba(15,23,42,0.7)',
              border: '1px solid rgba(56,189,248,0.3)',
              color: '#7dd3fc', cursor: 'pointer', padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18,
              transform: backShown ? 'translateX(0)' : 'translateX(calc(-100% - 24px))',
              opacity: backShown ? 1 : 0,
              transition: 'transform .26s cubic-bezier(.22,.61,.36,1), opacity .22s ease, border-color .2s, color .2s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#38bdf8'; e.currentTarget.style.color = '#38bdf8' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(56,189,248,0.3)'; e.currentTarget.style.color = '#7dd3fc' }}
          >
            <ArrowLeftOutlined />
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
          <div />
          {/* 中簇：品牌 + 时钟 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <DashboardOutlined
                style={{
                  position: 'absolute', right: '100%', top: '50%', transform: 'translateY(-50%)',
                  marginRight: 11, fontSize: 30, color: '#38bdf8',
                  filter: 'drop-shadow(0 0 10px rgba(59,130,246,0.35))',
                }}
              />
              <div style={{ textAlign: 'center', lineHeight: 1.1 }}>
                <div
                  style={{
                    fontSize: 22, fontWeight: 800, letterSpacing: 3, whiteSpace: 'nowrap',
                    background: 'linear-gradient(92deg, #60a5fa 0%, #38bdf8 48%, #818cf8 100%)',
                    WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
                    filter: 'drop-shadow(0 0 7px rgba(56,189,248,0.42))',
                  }}
                >
                  Prometheus 监控大屏
                </div>
                <div style={{ fontSize: 9, fontWeight: 500, letterSpacing: 2.2, color: '#5b7290', marginTop: 2, whiteSpace: 'nowrap' }}>
                  PROMETHEUS MONITORING PLATFORM
                </div>
              </div>
            </div>
            <LiveClock />
          </div>

          {/* 右簇：数据源切换 + 数据源信息 + 全屏 + 刷新 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
            {dss.length > 1 && (
              <select
                value={ds}
                onChange={(e) => setDs(Number(e.target.value))}
                title="切换数据源"
                style={{
                  height: 32, background: 'rgba(15,23,42,0.8)', color: '#7dd3fc',
                  border: '1px solid rgba(56,189,248,0.3)', borderRadius: 6,
                  padding: '0 8px', fontSize: 12, maxWidth: 200,
                }}
              >
                {dss.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
            <div
              style={{
                height: 56, padding: '0 14px', borderRadius: 10,
                border: '1px solid rgba(56,189,248,0.3)',
                background: 'rgba(15,23,42,0.7)', color: '#e2e8f0',
                lineHeight: 1.15, minWidth: 168, maxWidth: 260,
                display: 'flex', flexDirection: 'column', justifyContent: 'center',
              }}
            >
              <div style={{ fontSize: 10, color: '#64748b', letterSpacing: 2 }}>数据源</div>
              <div
                className="prom-num"
                style={{ fontSize: 14, color: '#e2e8f0', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={dsName}
              >
                {dsName}
              </div>
              <NextRefresh lastAt={lastAt} intervalS={REFRESH_INTERVAL_S} />
            </div>
            <Tooltip title={isFull ? '退出全屏' : '进入全屏'}>
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

        {/* ============= 主体 ============= */}
        {err ? (
          <div className="prom-panel" style={{ margin: `0 ${BODY_PAD}px`, padding: 60, textAlign: 'center', color: '#f87171', fontSize: 14 }}>
            数据加载失败：{err}
            <div style={{ marginTop: 8, color: '#64748b', fontSize: 12 }}>
              请确认数据源配置正确且 Prometheus 可达（「数据源管理」里可一键测试）
            </div>
          </div>
        ) : !data ? (
          <div style={{ height: BODY_H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7dd3fc' }}>
            <Spin size="large" />
            <span style={{ marginLeft: 12 }}>正在连接 Prometheus …</span>
          </div>
        ) : (
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
            {/* ===== 左栏：容量卡 + KPI + 资源健康分布 ===== */}
            <div style={{ display: 'grid', gridTemplateRows: '96px 88px 88px 88px 88px 88px 1fr', gap: 10, minHeight: 0 }}>
              {/* 容量卡：三列等分（目标 / 在线 / 离线） */}
              <div className="prom-panel" style={{ height: 96, padding: '0 14px', display: 'flex', alignItems: 'center' }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                  <div style={{ color: '#94a3b8', fontSize: 10, letterSpacing: 1 }}>监控目标</div>
                  <div className="prom-num" style={{ fontSize: 24, color: '#38bdf8', textShadow: '0 0 12px rgba(56,189,248,0.4)' }}>
                    {up?.total ?? 0}<span style={{ fontSize: 11, color: '#64748b', marginLeft: 3 }}>台</span>
                  </div>
                </div>
                <div style={{ width: 1, height: 50, background: 'rgba(56,189,248,0.15)' }} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: 12 }}>
                  <div style={{ color: '#94a3b8', fontSize: 10, letterSpacing: 1 }}>在线</div>
                  <div className="prom-num" style={{ fontSize: 24, color: '#22c55e', textShadow: '0 0 12px rgba(34,197,94,0.4)' }}>
                    {up?.online ?? 0}<span style={{ fontSize: 11, color: '#64748b', marginLeft: 3 }}>台</span>
                  </div>
                </div>
                <div style={{ width: 1, height: 50, background: 'rgba(56,189,248,0.15)' }} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: 12 }}>
                  <div style={{ color: '#94a3b8', fontSize: 10, letterSpacing: 1 }}>离线</div>
                  <div
                    className={`prom-num ${(up?.offline ?? 0) > 0 ? 'prom-blink' : ''}`}
                    style={{ fontSize: 24, color: (up?.offline ?? 0) > 0 ? '#ef4444' : '#64748b', textShadow: (up?.offline ?? 0) > 0 ? '0 0 12px rgba(239,68,68,0.4)' : 'none' }}
                  >
                    {up?.offline ?? 0}<span style={{ fontSize: 11, color: '#64748b', marginLeft: 3 }}>台</span>
                  </div>
                </div>
              </div>

              <KpiRow
                icon={<CloudServerOutlined />}
                color="#38bdf8"
                label="在线率"
                value={`${onlineRate}%`}
                sub={`在线 ${up?.online ?? 0} · 离线 ${up?.offline ?? 0}`}
              />
              <KpiRow
                icon={<AlertOutlined />}
                color={alertCrit ? '#ef4444' : alertWarn ? '#f59e0b' : '#22c55e'}
                label="告警项 / 实例"
                value={`${data.alertsTotal} / ${alertInstances}`}
                sub={`严重 ${alertCrit} · 预警 ${alertWarn}`}
              />
              <KpiRow
                icon={<FireOutlined />}
                color={data.usageDist.crit ? '#ef4444' : data.usageDist.high ? '#f59e0b' : '#22c55e'}
                label="高水位主机"
                value={`${data.usageDist.high + data.usageDist.crit}`}
                sub={`峰值 ≥90%：${data.usageDist.high + data.usageDist.crit} 台 · ≥80%：${data.usageDist.mid} 台`}
              />
              <KpiRow
                icon={<FundOutlined />}
                color="#818cf8"
                label="综合资源水位"
                value={`${overall}%`}
                sub={`CPU ${avg?.cpu ?? 0}% · 内存 ${avg?.mem ?? 0}% · 磁盘 ${avg?.disk ?? 0}%`}
              />
              <KpiRow
                icon={<DatabaseOutlined />}
                color="#38bdf8"
                label="数据更新"
                value={data.generatedAt ? data.generatedAt.slice(11) : '—'}
                sub={`采集时间 ${data.generatedAt || '—'}`}
              />

              {/* 资源健康分布饼图 */}
              <div className="prom-panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
                <div className="prom-title"><DashboardOutlined /> 资源健康分布</div>
                <div style={{ flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
                  <ReactECharts option={distOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                  <div
                    style={{
                      position: 'absolute', inset: 0, pointerEvents: 'none',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <div className="prom-num" style={{ fontSize: 20, lineHeight: 1, color: distTotal > 0 ? '#e2e8f0' : '#475569' }}>
                      {distTotal}
                    </div>
                    <div style={{ fontSize: 9, color: '#64748b', letterSpacing: 1, marginTop: 3 }}>台</div>
                  </div>
                </div>
                <div
                  className="prom-thin"
                  style={{
                    flex: '0 1 auto', maxHeight: '48%', overflowY: 'auto',
                    padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: 3,
                  }}
                >
                  {[
                    { name: '正常', v: data.usageDist.low, color: DIST_COLORS['正常'] },
                    { name: '关注', v: data.usageDist.mid, color: DIST_COLORS['关注'] },
                    { name: '预警', v: data.usageDist.high, color: DIST_COLORS['预警'] },
                    { name: '严重', v: data.usageDist.crit, color: DIST_COLORS['严重'] },
                    { name: '离线', v: data.usageDist.none, color: DIST_COLORS['离线'] },
                  ].map((x) => (
                    <div key={x.name} title={`${x.name} · ${x.v} 台`} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11 }}>
                      <i style={{ width: 8, height: 8, borderRadius: 2, flex: '0 0 auto', alignSelf: 'center', background: x.color }} />
                      <span style={{ flex: '1 1 auto', minWidth: 0, color: '#cbd5e1', lineHeight: 1.3 }}>{x.name}</span>
                      <b className="prom-num" style={{ flex: '0 0 auto', color: '#e2e8f0' }}>{x.v}</b>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ===== 中栏：仪表×4 + TOP5×3 + 主机柱状图 + 趋势 ===== */}
            <div style={{ display: 'grid', gridTemplateRows: '86px 196px 1fr 230px', gap: 10, minHeight: 0 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, height: 86 }}>
                <Gauge label="CPU 平均使用率" value={avg?.cpu || 0} color="#38bdf8" />
                <Gauge label="内存平均使用率" value={avg?.mem || 0} color="#a78bfa" />
                <Gauge label="磁盘平均使用率" value={avg?.disk || 0} color="#22d3ee" />
                <Gauge label="目标在线率" value={Number(onlineRate)} color="#34d399" />
              </div>

              {/* 负载 TOP5 ×3 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, height: 196 }}>
                {[
                  { title: 'CPU 负载 TOP5', rows: data.top?.cpu || [], metric: 'CPU' },
                  { title: '内存负载 TOP5', rows: data.top?.mem || [], metric: '内存' },
                  { title: '磁盘负载 TOP5', rows: data.top?.disk || [], metric: '磁盘' },
                ].map((it) => (
                  <div className="prom-panel" key={it.title} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                    <div className="prom-title"><FireOutlined /> {it.title}</div>
                    <AutoScroll speed={SCROLL_SPEED.host} fade={10}>
                      <TopList rows={it.rows} metric={it.metric} />
                    </AutoScroll>
                  </div>
                ))}
              </div>

              {/* 各主机实时使用率柱状图 */}
              <div className="prom-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                <div className="prom-title"><DashboardOutlined /> 各主机 CPU/内存/磁盘 实时使用率</div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <ReactECharts option={barsOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                </div>
              </div>

              {/* 24h 趋势 */}
              <div className="prom-panel" style={{ height: 230, display: 'flex', flexDirection: 'column' }}>
                <div className="prom-title"><FundOutlined /> 资源使用率趋势（近 24 小时）</div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <ReactECharts option={trendOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                </div>
              </div>
            </div>

            {/* ===== 右栏：告警列表 + 告警等级 + 主机实时资源 ===== */}
            <div style={{ display: 'grid', gridTemplateRows: '1fr 190px 240px', gap: 10, minHeight: 0 }}>
              {/* 告警列表（自动滚动） */}
              <div className="prom-panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
                <div className="prom-title">
                  <AlertOutlined /> 实时告警列表
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8', textTransform: 'none' }}>
                    严重 {alertCrit} · 预警 {alertWarn}
                  </span>
                </div>
                {(data.alerts || []).length === 0 ? (
                  <div className="prom-empty" style={{ flex: 1, minHeight: 0, flexDirection: 'column', gap: 8 }}>
                    <InboxOutlined style={{ fontSize: 32, color: '#22c55e' }} />
                    <span style={{ color: '#22c55e' }}>当前无告警 · 系统运行平稳</span>
                  </div>
                ) : (
                  <AutoScroll speed={SCROLL_SPEED.alert} fade={14} style={{ padding: '6px 12px' }}>
                    {data.alerts.map((a, i) => (
                      <AlertItem key={`${a.alertname}-${a.instance}-${i}`} a={a} nameOf={nameOf} />
                    ))}
                  </AutoScroll>
                )}
              </div>

              {/* 告警等级 */}
              <div className="prom-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                <div className="prom-title"><AlertOutlined /> 告警等级</div>
                <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                  <ReactECharts option={lvOpt} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
                  <div
                    style={{
                      position: 'absolute', inset: 0, pointerEvents: 'none',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <div className="prom-num" style={{ fontSize: 20, lineHeight: 1, color: data.alertsTotal > 0 ? '#e2e8f0' : '#475569' }}>
                      {data.alertsTotal}
                    </div>
                    <div style={{ fontSize: 9, color: '#64748b', letterSpacing: 1, marginTop: 3 }}>告警项</div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '2px 12px', padding: '0 8px 7px', fontSize: 11 }}>
                  {[
                    { name: '严重', v: alertCrit, color: '#ef4444' },
                    { name: '预警', v: alertWarn, color: '#f59e0b' },
                  ].map((x) => (
                    <span key={x.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#94a3b8' }}>
                      <i style={{ width: 8, height: 8, borderRadius: 2, background: x.color, display: 'inline-block' }} />
                      {x.name}
                      <b className="prom-num" style={{ color: x.v > 0 ? x.color : '#475569' }}>{x.v}</b>
                    </span>
                  ))}
                </div>
              </div>

              {/* 主机实时资源（自动滚动） */}
              <div className="prom-panel" style={{ height: 240, display: 'flex', flexDirection: 'column' }}>
                <div className="prom-title"><CloudServerOutlined /> 主机实时资源（自动滚动）</div>
                {(data.hosts || []).length === 0 ? (
                  <div className="prom-empty" style={{ flex: 1, minHeight: 0, flexDirection: 'column', gap: 8 }}>
                    <InboxOutlined style={{ fontSize: 24 }} />
                    <span>暂无主机数据</span>
                  </div>
                ) : (
                  <AutoScroll speed={SCROLL_SPEED.host} gap={6} fade={14} style={{ padding: '8px 10px' }}>
                    {data.hosts.map((h, i) => (
                      <HostCard key={`${h.instance}-${i}`} h={h} />
                    ))}
                  </AutoScroll>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ============= 页脚（高 36，与巡检大屏一致） ============= */}
        <div
          style={{
            height: FOOT_H,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#64748b', fontSize: 11, letterSpacing: 1,
            borderTop: '1px solid rgba(56,189,248,0.08)',
            background: 'linear-gradient(0deg, rgba(2,6,23,0.6), transparent)',
          }}
        >
          数据每 {REFRESH_INTERVAL_S} 秒自动刷新
          {data?.generatedAt && (
            <>
              · 采集时间：<span style={{ color: '#94a3b8', margin: '0 4px' }}>{data.generatedAt}</span>
            </>
          )}
          · 数据源：<span style={{ color: '#94a3b8', margin: '0 4px' }}>{dsName}</span>
          · 监控目标：<span style={{ color: '#94a3b8', margin: '0 4px' }}>{up?.total ?? 0} 台（在线 {up?.online ?? 0} / 离线 {up?.offline ?? 0}）</span>
          · 告警：<span style={{ color: '#94a3b8', margin: '0 4px' }}>{data?.alertsTotal ?? 0} 条</span>
        </div>
      </div>
    </div>
  )
}
