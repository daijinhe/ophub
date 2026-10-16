import { useEffect, useRef, useState } from 'react'
import { Button, Spin, Tag, Space, message } from 'antd'
import { ArrowLeftOutlined, DownloadOutlined, PrinterOutlined, FundOutlined } from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import { getRecord } from '../api/inspection'

function esc(v: any): string {
  if (v === null || v === undefined) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function bar(v: number, warn?: number, crit?: number): string {
  const val = Number(v || 0)
  const color = crit && val >= crit ? '#ef4444' : warn && val >= warn ? '#f59e0b' : '#22c55e'
  return `<div style="display:flex;align-items:center;gap:8px">
    <div style="flex:1;height:8px;background:rgba(148,163,184,.18);border-radius:4px;overflow:hidden">
      <div style="width:${Math.min(100, val)}%;height:100%;background:${color};box-shadow:0 0 8px ${color}"></div>
    </div>
    <span style="color:${color};font-weight:600;min-width:44px;text-align:right">${val.toFixed(1)}%</span>
  </div>`
}

function kv(k: string, v: any): string {
  return `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dashed rgba(148,163,184,.12)">
    <span style="color:#94a3b8">${esc(k)}</span><span style="color:#e2e8f0;font-weight:600">${esc(v)}</span></div>`
}

function renderAsset(d: any): string {
  const os = d?.os || {}
  const cpu = d?.cpu || {}
  const mem = d?.mem || {}
  const disk = d?.disk || {}
  const net = d?.net || {}
  const proc = d?.proc || {}
  const sec = d?.security || {}
  const ntp = Number(os.ntp_offset_ms || 0)
  const uptime = Number(os.uptime_days || 0)

  const roleColor: Record<string, string> = { system: '#38bdf8', data: '#22c55e', nas: '#a78bfa' }
  let disks = ''
  ;(disk.disks || []).forEach((x: any) => {
    const c = roleColor[x.role] || '#64748b'
    disks += `<tr>
      <td style="padding:4px 8px;border-bottom:1px solid rgba(148,163,184,.1)">${esc(x.mount)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid rgba(148,163,184,.1)">${esc(x.device)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid rgba(148,163,184,.1)"><span style="color:${c}">${esc(x.role)}</span></td>
      <td style="padding:4px 8px;border-bottom:1px solid rgba(148,163,184,.1)">${esc(x.total_gb)}GB</td>
      <td style="padding:4px 8px;border-bottom:1px solid rgba(148,163,184,.1)">${esc(x.used_gb)}GB</td>
      <td style="padding:4px 8px;border-bottom:1px solid rgba(148,163,184,.1);min-width:120px">${bar(x.usage, x.role === 'data' ? 70 : 75, 80)}</td>
    </tr>`
  })

  let ifaces = ''
  ;(net.interfaces || []).forEach((x: any) => {
    ifaces += `<tr>
      <td style="padding:4px 8px;border-bottom:1px solid rgba(148,163,184,.1)">${esc(x.name)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid rgba(148,163,184,.1)">${esc(x.speed_mbps)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid rgba(148,163,184,.1)">${esc(x.rx_mbps)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid rgba(148,163,184,.1)">${esc(x.tx_mbps)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid rgba(148,163,184,.1);min-width:120px">${bar(x.bandwidth_pct, 70)}</td>
    </tr>`
  })

  let tcp = ''
  Object.entries(net.tcp_states || {}).forEach(([k, v]) => {
    tcp += `<span style="display:inline-block;margin:2px 4px;padding:2px 8px;border:1px solid rgba(148,163,184,.25);border-radius:10px;font-size:12px">${esc(k)}: ${esc(v)}</span>`
  })

  let core = ''
  ;(proc.core || []).forEach((c: any) => {
    const color = c.alive ? '#22c55e' : '#ef4444'
    core += `<span style="display:inline-block;margin:3px 4px;padding:3px 10px;border:1px solid ${color};border-radius:12px;font-size:12px;color:${color}">${esc(c.type)}: ${c.alive ? '运行中 PID ' + esc(c.pid) : '未运行'}</span>`
  })
  if (!proc.core || proc.core.length === 0) core = '<span style="color:#64748b;font-size:12px">无中间件信息</span>'

  let top = ''
  ;(proc.top || []).forEach((t: any) => {
    top += `<tr><td style="padding:3px 8px;border-bottom:1px solid rgba(148,163,184,.1)">${esc(t.name)}</td><td style="padding:3px 8px;border-bottom:1px solid rgba(148,163,184,.1)">${esc(t.pid)}</td><td style="padding:3px 8px;border-bottom:1px solid rgba(148,163,184,.1)">${esc(t.cpu)}</td><td style="padding:3px 8px;border-bottom:1px solid rgba(148,163,184,.1)">${esc(t.mem)}</td></tr>`
  })

  const perCore = (cpu.per_core || [])
    .map((v: number, i: number) => `<span style="display:inline-block;margin:2px 3px;padding:1px 6px;border-radius:8px;font-size:11px;background:${v >= 100 ? 'rgba(239,68,68,.2)' : v >= 70 ? 'rgba(245,158,11,.2)' : 'rgba(34,197,94,.15)'};color:${v >= 100 ? '#ef4444' : v >= 70 ? '#f59e0b' : '#22c55e'}">C${i}:${v}%</span>`)
    .join('')

  return `
  <div style="border:1px solid rgba(56,189,248,.25);border-radius:14px;padding:16px;margin-bottom:18px;background:linear-gradient(160deg,rgba(15,23,42,.6),rgba(2,6,23,.4))">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div style="font-size:16px;font-weight:700;color:#e2e8f0">${esc(d?.assetName || '—')} <span style="color:#64748b;font-weight:400">${esc(d?.ip)}</span></div>
      <span style="font-size:12px;color:${d?.status === 'ok' ? '#22c55e' : '#ef4444'}">${d?.status === 'ok' ? '● 正常' : '● 失败'}</span>
    </div>
    ${
      d?.status !== 'ok'
        ? `<div style="color:#ef4444">${esc(d?.error || '采集失败')}</div>`
        : `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">
      <div>
        <div class="sec">操作系统基础信息</div>
        ${kv('主机名', os.hostname)}
        ${kv('操作系统', [os.name, os.version].filter(Boolean).join(' '))}
        ${kv('系统族', os.family)}
        ${kv('系统架构', os.arch)}
        ${kv('内核版本', os.kernel)}
        ${kv('SELinux', os.selinux)}
        ${kv('时区', os.timezone)}
        ${kv('NTP偏差(ms)', `<span style="color:${Math.abs(ntp) > 1000 ? '#ef4444' : '#22c55e'}">${ntp}</span>`)}
        ${kv('运行时长(天)', `<span style="color:${uptime > 200 ? '#f59e0b' : '#e2e8f0'}">${uptime}</span>`)}
        ${kv('最近启动', os.boot_time)}
      </div>
      <div>
        <div class="sec">CPU 性能指标</div>
        ${kv('CPU型号', cpu.model)}
        ${kv('核心数', cpu.cores)}
        <div style="padding:3px 0"><span style="color:#94a3b8">整体使用率</span><div style="margin-top:3px">${bar(cpu.usage, 70, 85)}</div></div>
        <div style="padding:3px 0"><span style="color:#94a3b8">I/O等待</span><div style="margin-top:3px">${bar(cpu.iowait, 10)}</div></div>
        ${kv('负载(1/5/15m)', [cpu.load1, cpu.load5, cpu.load15].map((x: any) => Number(x || 0).toFixed(2)).join(' / '))}
        <div style="margin-top:4px"><span style="color:#94a3b8;font-size:12px">单核最高 ${cpu.per_core_max ?? '—'}%</span><div style="margin-top:4px">${perCore}</div></div>
      </div>
      <div>
        <div class="sec">内存性能指标</div>
        ${kv('物理内存总量', mem.total_gb + ' GB')}
        ${kv('已用 / 可用', mem.used_gb + ' / ' + mem.available_gb + ' GB')}
        <div style="padding:3px 0"><span style="color:#94a3b8">内存使用率</span><div style="margin-top:3px">${bar(mem.usage, 80, 90)}</div></div>
        ${kv('Swap总量', mem.swap_total_gb + ' GB')}
        <div style="padding:3px 0"><span style="color:#94a3b8">Swap使用率</span><div style="margin-top:3px">${bar(mem.swap_usage, 1, 10)}</div></div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:8px">
      <div style="grid-column:1 / span 3">
        <div class="sec">磁盘与存储（自动识别系统盘 / 数据盘 / NAS）</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="color:#7dd3fc;text-align:left">
            <th style="padding:4px 8px">挂载点</th><th style="padding:4px 8px">设备</th><th style="padding:4px 8px">类型</th>
            <th style="padding:4px 8px">总量</th><th style="padding:4px 8px">已用</th><th style="padding:4px 8px">使用率</th>
          </tr></thead><tbody>${disks}</tbody>
        </table>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:8px">
      <div>
        <div class="sec">网络性能指标</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="color:#7dd3fc;text-align:left">
            <th style="padding:4px 8px">网卡</th><th style="padding:4px 8px">速率</th><th style="padding:4px 8px">收</th><th style="padding:4px 8px">发</th><th style="padding:4px 8px">带宽%</th>
          </tr></thead><tbody>${ifaces}</tbody>
        </table>
        ${kv('丢包率', net.packet_loss_pct + '%')}
        ${kv('TCP重传率', net.tcp_retrans_pct + '%')}
        ${kv('监听端口', net.listen_port_count)}
        ${kv('TCP连接总数', net.conn_total)}
        <div style="margin-top:6px">${tcp}</div>
      </div>
      <div>
        <div class="sec">进程与服务（联动中间件）</div>
        ${kv('总进程数', proc.total)}
        ${kv('纳管中间件数', proc.mw_count)}
        ${kv('僵尸进程', `<span style="color:${(proc.zombie || 0) > 0 ? '#ef4444' : '#22c55e'}">${proc.zombie || 0}</span>`)}
        <div style="margin:6px 0 4px;color:#94a3b8;font-size:12px">核心进程存活</div>
        <div>${core}</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px">
          <thead><tr style="color:#7dd3fc;text-align:left"><th style="padding:3px 8px">进程</th><th style="padding:3px 8px">PID</th><th style="padding:3px 8px">CPU%</th><th style="padding:3px 8px">内存%</th></tr></thead>
          <tbody>${top}</tbody>
        </table>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:8px">
      <div>
        <div class="sec">安全合规</div>
        ${kv('防火墙', sec.firewalld)}
        ${kv('SELinux', sec.selinux)}
        ${kv('root远程登录', sec.root_login ? '允许' : '禁止')}
        ${kv('近24h失败SSH', `<span style="color:${(sec.ssh_fail_24h || 0) >= 20 ? '#ef4444' : '#22c55e'}">${sec.ssh_fail_24h || 0} 次</span>`)}
        ${kv('SSH端口', sec.ssh_port)}
        ${kv('开放端口', Array.isArray(sec.open_ports) ? sec.open_ports.join('、') : sec.open_ports)}
        ${kv('最近SSH登录', sec.last_ssh_login)}
      </div>
      <div>
        <div class="sec">服务与中间件</div>
        ${kv('纳管中间件数', proc.mw_count)}
        ${kv('关键端口监听数', net.listen_port_count)}
        ${kv('TCP连接总数', net.conn_total)}
        ${kv('监听端口详情', Array.isArray(net.listen_ports) ? net.listen_ports.join('、') : net.listen_ports)}
      </div>
    </div>`
    }
  </div>`
}

function renderOverview(results: any[]): string {
  const rows = results.map((r: any) => {
    const d = r.data || {}
    const disks: any[] = d.disk?.disks || []
    const ifaces: any[] = d.net?.interfaces || []
    const diskMax = disks.reduce((m: number, x: any) => Math.max(m, Number(x.usage || 0)), 0)
    const netMax = ifaces.reduce((m: number, x: any) => Math.max(m, Number(x.bandwidth_pct || 0)), 0)
    const alerts: any[] = r.alerts || []
    const crit = alerts.filter((a: any) => a.level === 'critical').length
    return {
      r,
      cpu: Number(d.cpu?.usage || 0),
      mem: Number(d.mem?.usage || 0),
      disk: diskMax,
      net: netMax,
      alerts: alerts.length,
      crit,
      status: r.status,
    }
  })
  // 按严重告警数 → 总告警数 → CPU 降序，便于一眼锁定风险资产
  rows.sort((a, b) => b.crit - a.crit || b.alerts - a.alerts || b.cpu - a.cpu)

  const barCell = (v: number, warn: number, crit: number) =>
    `<td style="padding:6px 8px;min-width:108px">${bar(v, warn, crit)}</td>`
  const statusCell = (s: string) =>
    s === 'ok'
      ? '<td style="padding:6px 8px;color:#22c55e">正常</td>'
      : '<td style="padding:6px 8px;color:#ef4444">失败</td>'
  const alertCell = (a: any) =>
    a.alerts === 0
      ? '<td style="padding:6px 8px;color:#22c55e">0</td>'
      : `<td style="padding:6px 8px;color:${a.crit > 0 ? '#ef4444' : '#f59e0b'};font-weight:600">${a.crit > 0 ? a.crit + '严重/' : ''}${a.alerts}</td>`

  let body = ''
  rows.forEach((x) => {
    body += `<tr style="border-bottom:1px solid rgba(148,163,184,.12)">
      <td style="padding:6px 8px;font-weight:600;color:#e2e8f0">${esc(x.r.assetName || '—')}</td>
      <td style="padding:6px 8px;color:#94a3b8">${esc(x.r.department || '')}</td>
      <td style="padding:6px 8px;color:#94a3b8">${esc(x.r.ip || '')}</td>
      ${statusCell(x.status)}
      ${barCell(x.cpu, 70, 85)}
      ${barCell(x.mem, 80, 90)}
      ${barCell(x.disk, 75, 80)}
      ${barCell(x.net, 70, 0)}
      ${alertCell(x)}
    </tr>`
  })

  return `<div class="panel">
    <h3>资产概览（共 ${rows.length} 台 · 按告警严重度排序）</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="color:#7dd3fc;text-align:left">
        <th style="padding:6px 8px">ERP系统名称</th><th style="padding:6px 8px">归属部门</th><th style="padding:6px 8px">虚拟机IPv4</th><th style="padding:6px 8px">状态</th>
        <th style="padding:6px 8px">CPU</th><th style="padding:6px 8px">内存</th>
        <th style="padding:6px 8px">磁盘</th><th style="padding:6px 8px">网络</th><th style="padding:6px 8px">告警</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`
}

function buildReportHtml(data: any): string {
  const rec = data?.record || {}
  const results: any[] = data?.results || []
  const runAt = rec.runAt ? new Date(rec.runAt).toLocaleString('zh-CN') : '—'
  const generated = new Date().toLocaleString('zh-CN')

  // 汇总
  let ok = 0
  let fail = 0
  let sumCpu = 0
  let sumMem = 0
  let sumDisk = 0
  let cnt = 0
  const alertMap: Record<string, { level: string; items: any[] }> = {}
  results.forEach((r: any) => {
    if (r.status === 'ok') ok++
    else fail++
    const d = r.data || {}
    const flat = (k: string) => {
      // 简单派生
      if (k === 'cpu') return Number(d.cpu?.usage || 0)
      if (k === 'mem') return Number(d.mem?.usage || 0)
      const disks: any[] = d.disk?.disks || []
      let max = 0
      disks.forEach((x) => (max = Math.max(max, Number(x.usage || 0))))
      return max
    }
    if (r.status === 'ok') {
      sumCpu += flat('cpu')
      sumMem += flat('mem')
      sumDisk += flat('disk')
      cnt++
    }
    ;(r.alerts || []).forEach((a: any) => {
      const cat = a.metric || '其他'
      if (!alertMap[cat]) alertMap[cat] = { level: a.level, items: [] }
      alertMap[cat].items.push({ ...a, asset: r.assetName, ip: r.ip })
      if (a.level === 'critical') alertMap[cat].level = 'critical'
    })
  })
  const avgCpu = cnt ? (sumCpu / cnt).toFixed(1) : '0'
  const avgMem = cnt ? (sumMem / cnt).toFixed(1) : '0'
  const avgDisk = cnt ? (sumDisk / cnt).toFixed(1) : '0'
  let alertCount = 0
  Object.values(alertMap).forEach((v) => (alertCount += v.items.length))
  let health = 100 - Number(avgCpu) * 0.3 - Number(avgMem) * 0.3 - Number(avgDisk) * 0.4 - alertCount * 1.5
  health = Math.max(0, Math.min(100, Math.round(health)))
  const healthColor = health >= 85 ? '#22c55e' : health >= 65 ? '#f59e0b' : '#ef4444'

  let alertHtml = ''
  if (alertCount === 0) {
    alertHtml = '<div style="color:#22c55e;padding:10px 0">✓ 本次巡检无告警</div>'
  } else {
    Object.entries(alertMap).forEach(([cat, v]) => {
      const color = v.level === 'critical' ? '#ef4444' : '#f59e0b'
      alertHtml += `<div style="margin-bottom:10px"><div style="color:${color};font-weight:700;margin-bottom:4px">${esc(cat)}（${v.level === 'critical' ? '严重' : '预警'}）</div>`
      v.items.forEach((it: any) => {
        alertHtml += `<div style="font-size:13px;color:#cbd5e1;padding:2px 0">· ${esc(it.asset)}（${esc(it.ip)}） ${esc(it.metric)} ${esc(it.note ? '（' + it.note + '）' : '')}</div>`
      })
      alertHtml += '</div>'
    })
  }

  const assetsHtml = results
    .map((r) => renderAsset({ ...r.data, assetName: r.assetName, ip: r.ip, status: r.status, error: r.error }))
    .join('')

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>智能巡检报告 - ${esc(rec.taskName || '')}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; background:#060b18; color:#e2e8f0; font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; padding:28px 32px 60px; }
  .sec { font-size:13px; font-weight:700; color:#7dd3fc; letter-spacing:1px; margin-bottom:8px; border-left:3px solid #38bdf8; padding-left:8px; }
  .hdr { border:1px solid rgba(56,189,248,.3); border-radius:16px; padding:22px 26px; background:radial-gradient(800px 300px at 0% 0%,rgba(56,189,248,.12),transparent),linear-gradient(160deg,rgba(15,23,42,.7),rgba(2,6,23,.5)); margin-bottom:18px; }
  .title { font-size:26px; font-weight:800; letter-spacing:2px; color:#e2e8f0; }
  .sub { color:#64748b; font-size:12px; letter-spacing:2px; margin-top:4px; }
  .kpis { display:grid; grid-template-columns:repeat(6,1fr); gap:12px; margin:18px 0; }
  .kpi { border:1px solid rgba(56,189,248,.2); border-radius:12px; padding:12px; text-align:center; background:rgba(15,23,42,.5); }
  .kpi .v { font-size:22px; font-weight:700; }
  .kpi .l { font-size:11px; color:#94a3b8; margin-top:4px; }
  .panel { border:1px solid rgba(148,163,184,.18); border-radius:14px; padding:16px 18px; margin-bottom:16px; background:rgba(15,23,42,.4); }
  .panel h3 { margin:0 0 10px; font-size:15px; color:#7dd3fc; }
  @media print { body { background:#fff; color:#111; } .noprint { display:none; } .hdr,.panel,.kpi,.wrap>div { border-color:#ccc!important; background:#fff!important; } }
</style></head>
<body><div class="wrap">
  <div class="noprint" style="text-align:right;color:#64748b;font-size:12px;margin-bottom:8px">本报告由云枢 OpsHub · 智能运维平台自动生成 · ${generated}</div>
  <div class="hdr">
    <div class="title">智能巡检报告</div>
    <div class="sub">INTELLIGENT INSPECTION REPORT</div>
    <div style="margin-top:12px;display:flex;gap:24px;flex-wrap:wrap;font-size:13px;color:#cbd5e1">
      <div>任务：${esc(rec.taskName || '—')}</div>
      <div>执行时间：${runAt}</div>
      <div>资产总数：${rec.totalAssets ?? results.length}</div>
      <div>成功 / 失败：<span style="color:#22c55e">${ok}</span> / <span style="color:#ef4444">${fail}</span></div>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="v" style="color:${healthColor}">${health}</div><div class="l">健康评分</div></div>
    <div class="kpi"><div class="v" style="color:#38bdf8">${avgCpu}%</div><div class="l">平均CPU</div></div>
    <div class="kpi"><div class="v" style="color:#818cf8">${avgMem}%</div><div class="l">平均内存</div></div>
    <div class="kpi"><div class="v" style="color:#22d3ee">${avgDisk}%</div><div class="l">平均磁盘</div></div>
    <div class="kpi"><div class="v" style="color:${alertCount ? '#ef4444' : '#22c55e'}">${alertCount}</div><div class="l">告警项</div></div>
    <div class="kpi"><div class="v" style="color:#22c55e">${ok}</div><div class="l">正常资产</div></div>
  </div>

  <div class="panel">
    <h3>⚠ 告警汇总</h3>
    ${alertHtml}
  </div>

  ${renderOverview(results)}

  <div class="panel">
    <h3>资产巡检详情（八类指标）</h3>
    ${assetsHtml}
  </div>

  <div style="text-align:center;color:#475569;font-size:12px;margin-top:20px;letter-spacing:1px">
    云枢 OpsHub · 智能运维平台 · 巡检系统 v1.6.0 · 采集与展示分离（Ansible 采集 → JSON → 报告）
  </div>
</div></body></html>`
}

export default function InspectionReport() {
  const { id } = useParams()
  const navigate = useNavigate()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loading, setLoading] = useState(true)
  const [html, setHtml] = useState('')
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    getRecord(Number(id))
      .then((d) => {
        setData(d)
        setHtml(buildReportHtml(d))
      })
      .catch(() => message.error('报告加载失败'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const download = () => {
    if (!html) return
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `巡检报告_${data?.record?.taskName || id}_${new Date().toISOString().slice(0, 10)}.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  const print = () => {
    const f = iframeRef.current
    if (f && f.contentWindow) {
      f.contentWindow.focus()
      f.contentWindow.print()
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#060b18',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 50,
      }}
    >
      <div
        className="noprint"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 20px',
          borderBottom: '1px solid rgba(56,189,248,.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FundOutlined style={{ fontSize: 22, color: '#38bdf8' }} />
          <span className="glow-text" style={{ fontSize: 18, fontWeight: 700 }}>
            智能巡检报告
          </span>
        </div>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
            返回
          </Button>
          <Button icon={<PrinterOutlined />} onClick={print}>
            打印 / 导出 PDF
          </Button>
          <Button type="primary" icon={<DownloadOutlined />} onClick={download}>
            下载 HTML
          </Button>
        </Space>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin size="large" tip="生成报告中…" />
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            srcDoc={html}
            title="巡检报告"
            style={{ width: '100%', height: '100%', border: 'none', background: '#060b18' }}
          />
        )}
      </div>
    </div>
  )
}
