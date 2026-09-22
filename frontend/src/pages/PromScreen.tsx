import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Spin, Tag } from 'antd'
import {
  AlertOutlined,
  ArrowLeftOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import ReactECharts from 'echarts-for-react'
import dayjs from 'dayjs'
import { promOverview, type PromOverview, type PromDataSource } from '../api/prometheus'
import { listPromDataSources } from '../api/prometheus'
import { openCenteredWindow } from '../utils/window'

/**
 * Prometheus 监控大屏（v1.8.0）
 *
 * 与巡检大屏同一套视觉语言（深蓝科技风 + 角标面板 + 自适应缩放画布）：
 *   - 设计高度锁 1080，宽度按视口宽高比动态计算，任何比例屏幕无黑边；
 *   - 30s 自动刷新（倒计时可见）；
 *   - 左：资源仪表 + TOP5 负载；中：24h 全集群趋势 + 主机实时网格；
 *   - 右：告警列表 + 数据源信息。
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

const usageColor = (v: number) => (v >= 90 ? '#ef4444' : v >= 80 ? '#f59e0b' : '#22c55e')

const styles = `
@keyframes screenBlink { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.prom-screen-root { font-family: -apple-system, "PingFang SC", "Microsoft Yahei", sans-serif; background: #020617; }
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
  display: flex; align-items: center; gap: 6px; height: 34px;
}
.prom-num { font-variant-numeric: tabular-nums; font-weight: 700; letter-spacing: 1px; }
.prom-blink { animation: screenBlink 1.6s ease-in-out infinite; }
.prom-thin { scrollbar-width: thin; }
.prom-thin::-webkit-scrollbar { width: 4px; }
.prom-thin::-webkit-scrollbar-thumb { background: rgba(56,189,248,0.35); border-radius: 2px; }
`

const LiveClock = memo(function LiveClock() {
  const ref = useRef<HTMLDivElement>(null)
  const dateRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const tick = () => {
      const d = new Date()
      if (ref.current) ref.current.textContent = d.toLocaleTimeString('zh-CN', { hour12: false })
      if (dateRef.current)
        dateRef.current.textContent = `${d.toLocaleDateString('zh-CN')} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]}`
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <div style={{ textAlign: 'center', lineHeight: 1.05 }}>
      <div ref={ref} className="prom-num" style={{ fontSize: 17, color: '#e2e8f0', letterSpacing: 1.5 }}>00:00:00</div>
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
      ref.current.textContent = remain > 0 ? `${remain}s 后刷新` : '正在刷新…'
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [lastAt, intervalS])
  return <div ref={ref} style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>—</div>
})

/** 资源仪表（环形进度） */
const Gauge = memo(function Gauge({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, value || 0))
  const r = 46
  const c = 2 * Math.PI * r
  const color = usageColor(v)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth="9" />
        <circle
          cx="60" cy="60" r={r} fill="none"
          stroke={color} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)}
          transform="rotate(-90 60 60)"
          style={{ transition: 'stroke-dashoffset .8s ease, stroke .8s ease', filter: `drop-shadow(0 0 6px ${color}66)` }}
        />
        <text x="60" y="58" textAnchor="middle" fill="#e2e8f0" fontSize="20" fontWeight="700" className="prom-num">
          {v.toFixed(1)}%
        </text>
        <text x="60" y="78" textAnchor="middle" fill={color} fontSize="10">
          {v >= 90 ? '高危' : v >= 80 ? '偏高' : '正常'}
        </text>
      </svg>
      <div style={{ fontSize: 12, color: '#94a3b8', letterSpacing: 1 }}>{label}</div>
    </div>
  )
})

/** TOP5 单行 */
const TopRow = memo(function TopRow({ idx, e }: { idx: number; e: { instance: string; hostname: string; value: number } }) {
  const name = e.hostname || e.instance
  return (
    <div style={{ padding: '5px 0', borderBottom: '1px dashed rgba(148,163,184,0.15)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <span
          style={{
            width: 18, height: 18, borderRadius: 4, flex: '0 0 auto',
            background: idx < 3 ? 'rgba(239,68,68,0.25)' : 'rgba(148,163,184,0.15)',
            color: idx < 3 ? '#f87171' : '#94a3b8',
            fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700,
          }}
        >
          {idx + 1}
        </span>
        <span style={{ color: '#e2e8f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.instance}>
          {name}
        </span>
        <span className="prom-num" style={{ color: usageColor(e.value), width: 52, textAlign: 'right' }}>
          {e.value.toFixed(1)}%
        </span>
      </div>
      <div style={{ marginTop: 3, height: 3, borderRadius: 2, background: 'rgba(148,163,184,0.12)' }}>
        <div
          style={{
            height: 3, borderRadius: 2, width: `${Math.min(100, e.value)}%`,
            background: usageColor(e.value), transition: 'width .8s ease',
          }}
        />
      </div>
    </div>
  )
})

/** 告警条目 */
const AlertRow = memo(function AlertRow({ a }: { a: PromOverview['alerts'][number] }) {
  const crit = (a.severity || '').toLowerCase() === 'critical'
  return (
    <div style={{ padding: '6px 0', borderBottom: '1px dashed rgba(148,163,184,0.18)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <span style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {a.alertname || '—'}
        </span>
        <Tag color={crit ? 'red' : 'orange'} className={crit ? 'prom-blink' : ''} style={{ margin: 0, fontSize: 10 }}>
          {crit ? '严重' : '预警'}
        </Tag>
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {a.instance || '—'}
      </div>
      {a.description && (
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{a.description}</div>
      )}
    </div>
  )
})

/** 主机实时网格卡片 */
const HostCard = memo(function HostCard({ h }: { h: PromOverview['hosts'][number] }) {
  const name = h.hostname || h.instance
  return (
    <div
      style={{
        border: `1px solid ${h.up ? 'rgba(56,189,248,0.25)' : 'rgba(239,68,68,0.4)'}`,
        borderRadius: 8,
        padding: '8px 10px',
        background: h.up ? 'rgba(15,23,42,0.5)' : 'rgba(239,68,68,0.08)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          className={h.up ? '' : 'prom-blink'}
          style={{ width: 7, height: 7, borderRadius: 4, background: h.up ? '#22c55e' : '#ef4444', boxShadow: `0 0 6px ${h.up ? '#22c55e' : '#ef4444'}` }}
        />
        <span style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.instance}>
          {name}
        </span>
        <span style={{ fontSize: 10, color: h.up ? '#22c55e' : '#ef4444' }}>{h.up ? '在线' : '离线'}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        {[
          { k: 'CPU', v: h.cpu },
          { k: '内存', v: h.mem },
          { k: '磁盘', v: h.disk },
        ].map((m) => (
          <div key={m.k} style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: '#64748b' }}>{m.k}</div>
            <div className="prom-num" style={{ fontSize: 13, color: usageColor(m.v) }}>
              {m.v > 0 ? `${m.v.toFixed(1)}%` : '—'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})

/** 趋势图 */
const TrendChart = memo(function TrendChart({ data }: { data: PromOverview['trend'] }) {
  const option = useMemo(() => {
    return {
      grid: { left: 44, right: 12, top: 30, bottom: 26 },
      tooltip: { trigger: 'axis' },
      legend: { top: 0, right: 0, textStyle: { color: '#7dd3fc', fontSize: 10 }, itemWidth: 12 },
      xAxis: {
        type: 'category',
        data: data.map((p) => dayjs(p.ts * 1000).format('HH:mm')),
        axisLine: { lineStyle: { color: 'rgba(148,163,184,0.3)' } },
        axisLabel: { color: '#64748b', fontSize: 10 },
      },
      yAxis: {
        type: 'value', max: 100,
        axisLabel: { color: '#64748b', fontSize: 10, formatter: '{value}%' },
        splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } },
      },
      series: [
        {
          name: 'CPU',
          type: 'line', smooth: true, showSymbol: false,
          data: data.map((p) => p.cpu ?? null),
          lineStyle: { color: '#38bdf8', width: 1.6 },
          areaStyle: { color: 'rgba(56,189,248,0.15)' },
        },
        {
          name: '内存',
          type: 'line', smooth: true, showSymbol: false,
          data: data.map((p) => p.mem ?? null),
          lineStyle: { color: '#a78bfa', width: 1.6 },
          areaStyle: { color: 'rgba(167,139,250,0.15)' },
        },
      ],
    } as any
  }, [data])
  if (data.length === 0) {
    return <div className="prom-title" style={{ border: 'none' }}>暂无趋势数据</div>
  }
  return <ReactECharts option={option} notMerge style={{ height: '100%' }} lazyUpdate />
})

export default function PromScreen() {
  const [data, setData] = useState<PromOverview | null>(null)
  const [dss, setDss] = useState<PromDataSource[]>([])
  const [ds, setDs] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [lastAt, setLastAt] = useState(Date.now())
  const [scale, setScale] = useState(1)
  const [canvasW, setCanvasW] = useState(1920)
  const [fullscreen, setFullscreen] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  /* ---------- 自适应缩放 ---------- */
  useEffect(() => {
    const fit = () => {
      const { w, scale } = fitCanvas(window.innerWidth, window.innerHeight)
      setScale(scale)
      setCanvasW(w)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
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

  const load = useCallback(async () => {
    try {
      const r = await promOverview(ds)
      setData(r)
      setErr(null)
    } catch (e: any) {
      setErr(e?.response?.data?.msg || e?.message || '查询失败')
    } finally {
      setLoading(false)
      setLastAt(Date.now())
    }
  }, [ds])

  useEffect(() => {
    load()
    const id = window.setInterval(load, REFRESH_INTERVAL_S * 1000)
    return () => window.clearInterval(id)
  }, [load])

  const kpis = useMemo(() => {
    const up = data?.up
    return [
      { label: '监控目标', value: up?.total ?? 0, color: '#38bdf8', icon: <CloudServerOutlined /> },
      { label: '在线', value: up?.online ?? 0, color: '#22c55e', icon: <CloudServerOutlined /> },
      { label: '离线', value: up?.offline ?? 0, color: up && up.offline > 0 ? '#ef4444' : '#475569', icon: <CloudServerOutlined />, blink: (up?.offline ?? 0) > 0 },
      { label: '触发告警', value: data?.alertsTotal ?? 0, color: (data?.alertsTotal ?? 0) > 0 ? '#f59e0b' : '#475569', icon: <AlertOutlined />, blink: (data?.alertsTotal ?? 0) > 0 },
    ]
  }, [data])

  const dsName = useMemo(() => {
    const d = dss.find((x) => x.id === ds)
    return d?.name || '—'
  }, [dss, ds])

  const goHome = () => {
    openCenteredWindow('/', 'prom_screen_back')
  }

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().then(() => setFullscreen(true)).catch(() => {})
    } else {
      document.exitFullscreen?.().then(() => setFullscreen(false)).catch(() => {})
    }
  }

  return (
    <div
      className="prom-screen-root"
      style={{ minHeight: '100vh', overflow: 'hidden', position: 'relative' }}
    >
      <style>{styles}</style>
      <div className="prom-grid-bg" />
      {loading && !data ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#7dd3fc' }}>
          <Spin size="large" />
          <span style={{ marginLeft: 12 }}>正在连接 Prometheus …</span>
        </div>
      ) : (
        <div
          style={{
            width: canvasW,
            height: DESIGN_H,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            position: 'relative',
            margin: '0 auto',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {/* ===== 顶栏 ===== */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56, flex: '0 0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <DashboardOutlined style={{ fontSize: 22, color: '#38bdf8' }} />
              <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: 3, background: 'linear-gradient(92deg,#60a5fa,#38bdf8 48%,#818cf8)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>
                PROMETHEUS 监控大屏
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              {dss.length > 1 && (
                <select
                  value={ds}
                  onChange={(e) => setDs(Number(e.target.value))}
                  style={{ background: 'rgba(15,23,42,0.8)', color: '#7dd3fc', border: '1px solid rgba(56,189,248,0.3)', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
                >
                  {dss.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              )}
              <div style={{ fontSize: 11, color: '#64748b' }}>数据源：{dsName}</div>
              <LiveClock />
              <NextRefresh lastAt={lastAt} intervalS={REFRESH_INTERVAL_S} />
              <ReloadOutlined style={{ color: '#38bdf8', cursor: 'pointer' }} onClick={load} />
              <span
                onClick={toggleFullscreen}
                style={{ color: '#38bdf8', cursor: 'pointer', fontSize: 16 }}
                title={fullscreen ? '退出全屏' : '全屏'}
              >
                {fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              </span>
              <ArrowLeftOutlined style={{ color: '#64748b', cursor: 'pointer' }} onClick={goHome} title="返回平台" />
            </div>
          </div>

          {err ? (
            <div className="prom-panel" style={{ padding: 40, textAlign: 'center', color: '#f87171', fontSize: 14 }}>
              数据加载失败：{err}
              <div style={{ marginTop: 8, color: '#64748b', fontSize: 12 }}>
                请确认数据源配置正确且 Prometheus 可达（「数据源管理」里可一键测试）
              </div>
            </div>
          ) : (
            <>
              {/* ===== KPI 行 ===== */}
              <div style={{ display: 'flex', gap: 12, flex: '0 0 auto' }}>
                {kpis.map((k) => (
                  <div key={k.label} className="prom-panel" style={{ flex: 1, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{ fontSize: 26, color: k.color, opacity: 0.85 }}>{k.icon}</div>
                    <div>
                      <div className={`prom-num ${k.blink ? 'prom-blink' : ''}`} style={{ fontSize: 30, color: k.color, lineHeight: 1 }}>
                        {k.value}
                      </div>
                      <div style={{ fontSize: 12, color: '#7f8ea3', marginTop: 4, letterSpacing: 1 }}>{k.label}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* ===== 主体三栏 ===== */}
              <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
                {/* 左：仪表 + TOP5 */}
                <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
                  <div className="prom-panel" style={{ flex: '0 0 auto' }}>
                    <div className="prom-title">资源均值（在线主机）</div>
                    <div style={{ display: 'flex', justifyContent: 'space-around', padding: '12px 0 14px' }}>
                      <Gauge label="CPU" value={data?.avg.cpu ?? 0} />
                      <Gauge label="内存" value={data?.avg.mem ?? 0} />
                      <Gauge label="磁盘" value={data?.avg.disk ?? 0} />
                    </div>
                  </div>
                  <div className="prom-panel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <div className="prom-title">TOP5 CPU 负载</div>
                    <div className="prom-thin" style={{ flex: 1, overflow: 'auto', padding: '4px 12px 8px' }}>
                      {(data?.top.cpu || []).map((e, i) => (
                        <TopRow key={e.instance} idx={i} e={e} />
                      ))}
                      {(data?.top.cpu?.length || 0) === 0 && (
                        <div style={{ color: '#475569', fontSize: 12, padding: 20, textAlign: 'center' }}>暂无数据（确认 node_exporter 已接入）</div>
                      )}
                    </div>
                  </div>
                  <div className="prom-panel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <div className="prom-title">TOP5 内存占用</div>
                    <div className="prom-thin" style={{ flex: 1, overflow: 'auto', padding: '4px 12px 8px' }}>
                      {(data?.top.mem || []).map((e, i) => (
                        <TopRow key={e.instance} idx={i} e={e} />
                      ))}
                    </div>
                  </div>
                </div>

                {/* 中：趋势 + 主机网格 */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
                  <div className="prom-panel" style={{ height: 280, flex: '0 0 auto' }}>
                    <div className="prom-title">全集群资源趋势（近 24 小时）</div>
                    <div style={{ height: 'calc(100% - 34px)' }}>
                      <TrendChart data={data?.trend || []} />
                    </div>
                  </div>
                  <div className="prom-panel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <div className="prom-title">
                      主机实时资源（{data?.hosts?.length || 0} 台）
                    </div>
                    <div
                      className="prom-thin"
                      style={{ flex: 1, overflow: 'auto', padding: '10px 12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8, alignContent: 'start' }}
                    >
                      {(data?.hosts || []).map((h) => (
                        <HostCard key={h.instance} h={h} />
                      ))}
                      {(data?.hosts?.length || 0) === 0 && (
                        <div style={{ color: '#475569', fontSize: 12, gridColumn: '1/-1', textAlign: 'center', padding: 30 }}>
                          暂无主机数据（确认 node_exporter 已接入 Prometheus）
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* 右：告警 + 磁盘 TOP */}
                <div style={{ width: 300, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
                  <div className="prom-panel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <div className="prom-title">
                      <AlertOutlined /> 活跃告警（{data?.alertsTotal ?? 0}）
                    </div>
                    <div className="prom-thin" style={{ flex: 1, overflow: 'auto', padding: '4px 12px 8px' }}>
                      {(data?.alerts || []).map((a, i) => (
                        <AlertRow key={`${a.alertname}-${a.instance}-${i}`} a={a} />
                      ))}
                      {(data?.alerts?.length || 0) === 0 && (
                        <div style={{ color: '#475569', fontSize: 12, padding: 20, textAlign: 'center' }}>
                          暂无活跃告警
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="prom-panel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <div className="prom-title">TOP5 磁盘占用</div>
                    <div className="prom-thin" style={{ flex: 1, overflow: 'auto', padding: '4px 12px 8px' }}>
                      {(data?.top.disk || []).map((e, i) => (
                        <TopRow key={e.instance} idx={i} e={e} />
                      ))}
                    </div>
                  </div>
                  <div className="prom-panel" style={{ flex: '0 0 auto', padding: '10px 14px', fontSize: 11, color: '#64748b', lineHeight: 1.8 }}>
                    <div>数据源：{dsName}</div>
                    <div>刷新：每 {REFRESH_INTERVAL_S}s · 更新于 {data?.generatedAt || '—'}</div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
