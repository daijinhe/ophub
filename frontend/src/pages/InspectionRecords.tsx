import { useEffect, useState } from 'react'
import {
  Table,
  Button,
  Select,
  DatePicker,
  Tag,
  Space,
  message,
  Drawer,
  Card,
  Segmented,
  Tooltip,
  Progress,
  Empty,
  Descriptions,
  Divider,
  Alert,
  Popconfirm,
} from 'antd'
import {
  FileExcelOutlined,
  EyeOutlined,
  ReloadOutlined,
  DownloadOutlined,
  FundOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import * as XLSX from 'xlsx'
import dayjs from 'dayjs'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  listRecords,
  listTasks,
  getRecord,
  getExport,
  batchDeleteRecords,
  InspectionTask,
} from '../api/inspection'
import { buildQuarterReportXlsx, downloadBlob, fmtBytes } from '../utils/inspectionQuarterReport'

const PeriodMap: Record<string, string> = {
  day: '日报',
  week: '周报',
  month: '月报',
  quarter: '季报',
  year: '年报',
}

function UsageBar({ value, warn, crit }: { value?: number; warn?: number; crit?: number }) {
  const v = value === undefined || value === null ? 0 : Number(value)
  const color = crit && v >= crit ? '#ef4444' : warn && v >= warn ? '#f59e0b' : '#22c55e'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 130 }}>
      <Progress
        percent={Math.round(v)}
        size="small"
        strokeColor={color}
        style={{ width: 100, margin: 0 }}
        format={(p) => `${p}%`}
      />
    </div>
  )
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 14,
        fontWeight: 700,
        color: '#38bdf8',
        letterSpacing: 1,
        margin: '4px 0 10px',
      }}
    >
      {icon}
      {title}
    </div>
  )
}

function ResultDetail({ result }: { result: any }) {
  const d = result.data || {}
  const os = d.os || {}
  const cpu = d.cpu || {}
  const mem = d.mem || {}
  const disk = d.disk || {}
  const net = d.net || {}
  const proc = d.proc || {}
  const sec = d.security || {}
  const alerts = result.alerts || []

  const ntp = Number(os.ntp_offset_ms || 0)
  const uptime = Number(os.uptime_days || 0)
  const roleColor: Record<string, string> = { system: 'blue', data: 'green', nas: 'purple' }

  return (
    <div>
      {alerts.length > 0 && (
        <Card size="small" style={{ marginBottom: 12, borderColor: 'rgba(239,68,68,0.4)' }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: '#ef4444' }}>⚠ 告警项（{alerts.length}）</div>
          <Space wrap>
            {alerts.map((a: any, i: number) => (
              <Tag key={i} color={a.level === 'critical' ? 'red' : 'orange'}>
                {a.metric}
                {a.note ? `（${a.note}）` : ''}
              </Tag>
            ))}
          </Space>
        </Card>
      )}

      {/* 操作系统 */}
      <SectionTitle icon={<FundOutlined />} title="操作系统基础信息" />
      <Descriptions bordered column={3} size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label="主机名">{os.hostname || '—'}</Descriptions.Item>
        <Descriptions.Item label="操作系统">
          {[os.name, os.version].filter(Boolean).join(' ') || '—'}
        </Descriptions.Item>
        <Descriptions.Item label="系统架构">{os.arch || '—'}</Descriptions.Item>
        <Descriptions.Item label="系统族">{os.family || '—'}</Descriptions.Item>
        <Descriptions.Item label="内核版本">{os.kernel || '—'}</Descriptions.Item>
        <Descriptions.Item label="时区">{os.timezone || '—'}</Descriptions.Item>
        <Descriptions.Item label="SELinux">{os.selinux || '—'}</Descriptions.Item>
        <Descriptions.Item label="最近启动">{os.boot_time || '—'}</Descriptions.Item>
        <Descriptions.Item label="NTP偏差(ms)">
          <span style={{ color: Math.abs(ntp) > 1000 ? '#ef4444' : undefined }}>{ntp}</span>
        </Descriptions.Item>
        <Descriptions.Item label="运行时长(天)">
          <span style={{ color: uptime > 200 ? '#f59e0b' : undefined }}>{uptime}</span>
        </Descriptions.Item>
      </Descriptions>

      {/* CPU */}
      <SectionTitle icon={<FundOutlined />} title="CPU 性能指标" />
      <Descriptions bordered column={3} size="small" style={{ marginBottom: 8 }}>
        <Descriptions.Item label="CPU型号" span={3}>
          {cpu.model || '—'}
        </Descriptions.Item>
        <Descriptions.Item label="核心数">{cpu.cores ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="整体使用率">
          <UsageBar value={cpu.usage} warn={70} crit={85} />
        </Descriptions.Item>
        <Descriptions.Item label="I/O等待">
          <UsageBar value={cpu.iowait} warn={10} />
        </Descriptions.Item>
        <Descriptions.Item label="负载(1/5/15m)">
          {[cpu.load1, cpu.load5, cpu.load15].map((x) => Number(x || 0).toFixed(2)).join(' / ')}
        </Descriptions.Item>
        <Descriptions.Item label="单核最高" span={2}>
          <UsageBar value={cpu.per_core_max} warn={100} />
        </Descriptions.Item>
      </Descriptions>
      {Array.isArray(cpu.per_core) && cpu.per_core.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
            各核心使用率
          </div>
          <Space wrap size={[6, 6]}>
            {cpu.per_core.map((v: number, i: number) => (
              <Tooltip key={i} title={`核心${i}: ${v}%`}>
                <Tag color={v >= 100 ? 'red' : v >= 70 ? 'orange' : 'default'}>C{i}: {v}%</Tag>
              </Tooltip>
            ))}
          </Space>
        </div>
      )}

      {/* 内存 */}
      <SectionTitle icon={<FundOutlined />} title="内存性能指标" />
      <Descriptions bordered column={3} size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label="物理内存总量">{mem.total_gb ?? '—'} GB</Descriptions.Item>
        <Descriptions.Item label="已用 / 可用">
          {mem.used_gb ?? '—'} / {mem.available_gb ?? '—'} GB
        </Descriptions.Item>
        <Descriptions.Item label="内存使用率">
          <UsageBar value={mem.usage} warn={80} crit={90} />
        </Descriptions.Item>
        <Descriptions.Item label="Swap总量">{mem.swap_total_gb ?? '—'} GB</Descriptions.Item>
        <Descriptions.Item label="Swap已用">{mem.swap_used_gb ?? '—'} GB</Descriptions.Item>
        <Descriptions.Item label="Swap使用率">
          <UsageBar value={mem.swap_usage} warn={1} crit={10} />
        </Descriptions.Item>
      </Descriptions>

      {/* 磁盘 */}
      <SectionTitle icon={<FundOutlined />} title="磁盘与存储" />
      <Table
        size="small"
        style={{ marginBottom: 16 }}
        pagination={false}
        dataSource={(disk.disks || []).map((x: any, i: number) => ({ ...x, _i: i }))}
        columns={[
          { title: '挂载点', dataIndex: 'mount' },
          { title: '设备', dataIndex: 'device' },
          { title: '文件系统', dataIndex: 'fstype' },
          {
            title: '类型',
            dataIndex: 'role',
            render: (r: string) => <Tag color={roleColor[r] || 'default'}>{r}</Tag>,
          },
          { title: '总量(GB)', dataIndex: 'total_gb' },
          { title: '已用(GB)', dataIndex: 'used_gb' },
          {
            title: '使用率',
            dataIndex: 'usage',
            render: (v: number) => <UsageBar value={v} warn={v >= 70 ? 70 : 75} crit={80} />,
          },
        ]}
      />

      {/* 网络 */}
      <SectionTitle icon={<FundOutlined />} title="网络性能指标" />
      <Table
        size="small"
        style={{ marginBottom: 8 }}
        pagination={false}
        dataSource={(net.interfaces || []).map((x: any, i: number) => ({ ...x, _i: i }))}
        columns={[
          { title: '网卡', dataIndex: 'name' },
          { title: '速率(Mbps)', dataIndex: 'speed_mbps' },
          { title: '接收', render: (_: any, r: any) => `${r.rx_mbps} Mbps` },
          { title: '发送', render: (_: any, r: any) => `${r.tx_mbps} Mbps` },
          {
            title: '带宽使用率',
            dataIndex: 'bandwidth_pct',
            render: (v: number) => <UsageBar value={v} warn={70} />,
          },
        ]}
      />
      <Descriptions bordered column={4} size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label="丢包率">
          <UsageBar value={net.packet_loss_pct} warn={0.1} />
        </Descriptions.Item>
        <Descriptions.Item label="TCP重传率">
          <UsageBar value={net.tcp_retrans_pct} warn={1} />
        </Descriptions.Item>
        <Descriptions.Item label="监听端口数">{net.listen_port_count ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="TCP连接总数">{net.conn_total ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="TCP状态" span={4}>
          <Space wrap size={[4, 4]}>
            {Object.entries(net.tcp_states || {}).map(([k, v]) => (
              <Tag key={k} color={k === 'TIME_WAIT' ? 'orange' : 'default'}>
                {k}: {String(v)}
              </Tag>
            ))}
          </Space>
        </Descriptions.Item>
      </Descriptions>

      {/* 进程与服务 */}
      <SectionTitle icon={<FundOutlined />} title="进程与服务" />
      <Descriptions bordered column={3} size="small" style={{ marginBottom: 8 }}>
        <Descriptions.Item label="总进程数">{proc.total ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="僵尸进程">
          <span style={{ color: (proc.zombie || 0) > 0 ? '#ef4444' : undefined }}>{proc.zombie ?? 0}</span>
        </Descriptions.Item>
        <Descriptions.Item label="纳管中间件数">{proc.mw_count ?? 0}</Descriptions.Item>
        <Descriptions.Item label="核心进程数">{Array.isArray(proc.core) ? proc.core.length : 0}</Descriptions.Item>
        <Descriptions.Item label="核心进程未运行">
          <span style={{ color: (proc.core || []).filter((c: any) => !c.alive).length > 0 ? '#ef4444' : undefined }}>
            {(proc.core || []).filter((c: any) => !c.alive).length}
          </span>
        </Descriptions.Item>
      </Descriptions>
      <div style={{ fontSize: 13, fontWeight: 600, margin: '8px 0 6px' }}>核心进程存活（联动资源清单中间件信息）</div>
      <Space wrap style={{ marginBottom: 12 }}>
        {(proc.core || []).map((c: any, i: number) => (
          <Tag key={i} color={c.alive ? 'green' : 'red'}>
            {c.type}：{c.alive ? `运行中(PID ${c.pid})` : '未运行'}
          </Tag>
        ))}
        {(!proc.core || proc.core.length === 0) && <span style={{ color: 'var(--text-secondary)' }}>无中间件信息</span>}
      </Space>
      {Array.isArray(proc.top) && proc.top.length > 0 && (
        <Table
          size="small"
          pagination={false}
          title={() => '资源占用 Top 进程'}
          dataSource={proc.top.map((x: any, i: number) => ({ ...x, _i: i }))}
          columns={[
            { title: '进程', dataIndex: 'name' },
            { title: 'PID', dataIndex: 'pid' },
            { title: 'CPU%', dataIndex: 'cpu' },
            { title: '内存%', dataIndex: 'mem' },
          ]}
        />
      )}

      {/* 安全合规 */}
      <SectionTitle icon={<FundOutlined />} title="安全合规" />
      <Descriptions bordered column={3} size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label="防火墙状态">{sec.firewalld || '—'}</Descriptions.Item>
        <Descriptions.Item label="SELinux">{sec.selinux || '—'}</Descriptions.Item>
        <Descriptions.Item label="root远程登录">
          {sec.root_login === undefined ? '—' : sec.root_login ? '允许' : '禁止'}
        </Descriptions.Item>
        <Descriptions.Item label="近24h失败SSH登录">
          <span style={{ color: (sec.ssh_fail_24h || 0) >= 20 ? '#ef4444' : undefined }}>
            {sec.ssh_fail_24h ?? 0} 次
          </span>
        </Descriptions.Item>
        <Descriptions.Item label="SSH端口">{sec.ssh_port ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="开放端口">
          {Array.isArray(sec.open_ports) ? sec.open_ports.join('、') : sec.open_ports || '—'}
        </Descriptions.Item>
        <Descriptions.Item label="最近SSH登录">{sec.last_ssh_login || '—'}</Descriptions.Item>
      </Descriptions>
    </div>
  )
}

export default function InspectionRecords() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [records, setRecords] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [tasks, setTasks] = useState<InspectionTask[]>([])
  const [taskId, setTaskId] = useState<number | undefined>(
    params.get('taskId') ? Number(params.get('taskId')) : undefined
  )
  const [period, setPeriod] = useState<string>('week')
  const [refDate, setRefDate] = useState<string>(new Date().toISOString().slice(0, 10))
  const [detail, setDetail] = useState<any>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [drill, setDrill] = useState<any>(null)
  const [exporting, setExporting] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<number[]>([])

  // 季度报告(v1.7.26 起独立卡片)
  const [quarterYear, setQuarterYear] = useState<number>(new Date().getFullYear())
  const [quarter, setQuarter] = useState<1 | 2 | 3 | 4>(((new Date().getMonth()) / 3 | 0) + 1 as 1 | 2 | 3 | 4)
  const [quarterGenerating, setQuarterGenerating] = useState(false)
  const [quarterReport, setQuarterReport] = useState<{
    filename: string
    sizeMB: number
    sizeBytes: number
    degraded: boolean
    droppedSheets: string[]
    compactedNotes: string[]
    stats: { totalResults: number; totalAlerts: number; totalRecords: number; quarterStart: string; quarterEnd: string }
  } | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const d = await listRecords({ taskId, size: 50 })
      setRecords(d.list || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    listTasks().then((d) => setTasks(d.list || []))
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  const batchRemove = async () => {
    if (!selectedKeys.length) return
    try {
      await batchDeleteRecords(selectedKeys)
      message.success(`已删除 ${selectedKeys.length} 条巡检记录`)
      setSelectedKeys([])
      load()
    } catch (e: any) {
      message.error('删除失败：' + (e?.response?.data?.msg || e.message))
    }
  }

  const statusTag = (s: string) => {
    const map: Record<string, { c: string; t: string }> = {
      done: { c: 'success', t: '完成' },
      partial: { c: 'warning', t: '部分成功' },
      failed: { c: 'error', t: '失败' },
      running: { c: 'processing', t: '运行中' },
    }
    const m = map[s] || { c: 'default', t: s }
    return <Tag color={m.c}>{m.t}</Tag>
  }

  const sourceTag = (s: string) => {
    const map: Record<string, string> = {
      ansible: 'Ansible 采集',
      ssh: 'SSH 采集',
      simulated: '模拟数据',
    }
    return (
      <Tag color={s === 'ansible' ? 'cyan' : s === 'ssh' ? 'blue' : 'default'}>
        {map[s] || s}
      </Tag>
    )
  }

  const openDetail = async (id: number) => {
    const d = await getRecord(id)
    setDetail(d)
    setDetailOpen(true)
  }

  /**
   * 季度报告独立导出(v1.7.26+):
   *   1. 调 utils/inspectionQuarterReport.buildQuarterReportXlsx
   *      —— 它内部已经做了 5MB 硬上限 + sheet 降级
   *   2. 拿到 Blob 后立即触发浏览器下载
   *   3. 把"是否降级、丢了哪些 sheet、字节数"塞回卡片右下角的状态条
   *      方便用户决定是否改条件重出
   */
  const generateQuarterReport = async () => {
    setQuarterGenerating(true)
    try {
      const r = await buildQuarterReportXlsx({
        year: quarterYear,
        quarter,
        taskId,
        maxMB: 5,
      })
      downloadBlob(r.blob, r.filename)
      setQuarterReport({
        filename: r.filename,
        sizeMB: r.sizeMB,
        sizeBytes: r.sizeBytes,
        degraded: r.degraded,
        droppedSheets: r.droppedSheets,
        compactedNotes: r.compactedNotes,
        stats: {
          totalResults: r.stats.totalResults,
          totalAlerts: r.stats.totalAlerts,
          totalRecords: r.stats.totalRecords,
          quarterStart: r.stats.quarterStart,
          quarterEnd: r.stats.quarterEnd,
        },
      })
      if (r.droppedSheets.length > 0) {
        message.warning(
          `已生成 ${fmtBytes(r.sizeBytes)} —— 为保 ≤5MB 丢掉了 Sheet: ${r.droppedSheets.join('、')}。如需完整内容请缩小范围（如指定任务）。`
        )
      } else if (r.degraded) {
        message.info(`已生成 ${fmtBytes(r.sizeBytes)} —— 为保 ≤5MB，资产明细/告警明细已按季度聚合（6 个 Sheet 都在）`)
      } else {
        message.success(`已生成 ${fmtBytes(r.sizeBytes)}（${r.stats.totalResults} 个采集 · ${r.stats.totalAlerts} 个告警）`)
      }
    } catch (e: any) {
      message.error('季度报告生成失败：' + (e?.response?.data?.msg || e?.message || '未知错误'))
    } finally {
      setQuarterGenerating(false)
    }
  }

  const exportXlsx = async (p: string, ref: string, recordId?: number) => {
    setExporting(true)
    try {
      const d = await getExport(p, ref, taskId, recordId)
      const rows: any[] = (d.rows || []).slice()
      // 排序：失败资产优先，其次有告警资产优先 —— 打开报表先看到风险项
      rows.sort((a: any, b: any) => {
        const sf = (a['状态'] === '失败' ? 0 : 1) - (b['状态'] === '失败' ? 0 : 1)
        if (sf !== 0) return sf
        return (a['告警项'] ? 1 : 0) - (b['告警项'] ? 1 : 0)
      })

      // 导出列顺序：核心标识最前 → 操作系统 → CPU → 内存 → 磁盘 → 网络 → 进程/服务/安全 → 尾部基础列
      const EXPORT_COL_ORDER: string[] = [
        'ERP系统名称', '归属部门', '虚拟机IPv4', '运行时长(天)', '状态',
        '操作系统', '系统版本', 'CPU类型', '内核版本', 'SELinux状态', 'NTP偏差(ms)',
        'CPU核心数', 'CPU整体使用率', 'I/O等待', '单核最高使用率', '负载率(load1/核心数)', '系统负载(1m)', '系统负载(5m)', '系统负载(15m)',
        '物理内存总量', '内存已用', '可用内存', '内存使用率', 'Swap总量', 'Swap已用', 'Swap使用率',
        '系统盘使用率', '系统盘inode使用率', '系统盘容量', '数据盘最高使用率', '数据盘最高inode使用率', '数据盘数量', 'NAS最高使用率',
        '网卡带宽最高使用率', '丢包率', 'TCP重传率', 'TCP ESTABLISHED', 'TCP TIME_WAIT', 'TCP SYN_RECV', 'TCP CLOSE_WAIT', '监听端口数', 'TCP连接总数',
        '总进程数', '僵尸进程数',
        '纳管中间件数', '关键端口监听数',
        '防火墙状态', 'SELinux', 'root远程登录', '近24h失败SSH登录', '开放端口数',
        '巡检时间', '任务名称', '采集来源', '告警项',
      ]
      // 从导出中移除的列
      const DROP_COLS = new Set([
        '主机名', '时区', '最近启动时间', '核心进程总数', '核心进程未运行数', 'CPU型号', '系统架构',
        '系统族', '缓存/缓冲',
      ])
      const orderedRows = rows.map((r: any) => {
        const o: any = {}
        for (const col of EXPORT_COL_ORDER) {
          if (col === 'CPU类型') {
            // 系统架构 → CPU类型：值取 CPU 型号（缺省回落架构）
            const v = r['CPU型号'] ?? r['系统架构']
            if (v !== undefined && v !== null && v !== '') o[col] = v
            continue
          }
          if (col in r) o[col] = r[col]
        }
        for (const k of Object.keys(r)) {
          if (!(k in o) && !DROP_COLS.has(k)) o[k] = r[k]
        }
        return o
      })

      const ws1 = XLSX.utils.json_to_sheet(orderedRows)
      const headers = Object.keys(orderedRows[0] || {})
      ws1['!cols'] = headers.map((h) => ({
        wch:
          h === 'ERP系统名称'
            ? 26
            : h === '虚拟机IPv4'
            ? 16
            : h === '告警项'
            ? 46
            : h === '巡检时间'
            ? 18
            : h === '操作系统' || h === '内核版本' || h === 'CPU类型' || h === '归属部门'
            ? 18
            : 14,
      }))
      ws1['!freeze'] = { xSplit: 0, ySplit: 1 } // 冻结表头

      // 告警明细列顺序：ERP系统名称 / 归属部门 / 虚拟机IPv4 / 分类 / 指标 / 级别 / 数值 / 说明 / 开发人员（最后一列）
      const ALERT_COL_ORDER = ['ERP系统名称', '归属部门', '虚拟机IPv4', '分类', '指标', '级别', '数值', '说明', '开发人员']
      const orderedAlerts = (d.alerts || []).map((a: any) => {
        const o: any = {}
        for (const col of ALERT_COL_ORDER) if (col in a) o[col] = a[col]
        for (const k of Object.keys(a)) if (!(k in o)) o[k] = a[k]
        return o
      })
      const ws3 = XLSX.utils.json_to_sheet(orderedAlerts)
      const aHeaders = Object.keys((orderedAlerts && orderedAlerts[0]) || {})
      ws3['!cols'] = aHeaders.map((h) => ({ wch: h === '说明' ? 46 : h === '开发人员' ? 18 : 16 }))
      ws3['!freeze'] = { xSplit: 0, ySplit: 1 }

      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws1, '巡检明细')
      XLSX.utils.book_append_sheet(wb, ws3, '告警明细')
      XLSX.writeFile(wb, recordId ? `巡检单条导出_记录${recordId}_${ref}.xlsx` : `巡检报表_${PeriodMap[p] || p}_${ref}.xlsx`)
      message.success(recordId ? `已导出该记录（${rows.length} 个资产）` : '已导出 Excel（含告警明细，表头已冻结）')
    } catch (e: any) {
      message.error('导出失败：' + (e?.response?.data?.msg || e.message))
    } finally {
      setExporting(false)
    }
  }

  const columns = [
    { title: '巡检时间', dataIndex: 'runAt', render: (v: string) => new Date(v).toLocaleString() },
    { title: '任务', dataIndex: 'taskName' },
    { title: '状态', dataIndex: 'status', render: statusTag },
    { title: '资产总数', dataIndex: 'totalAssets' },
    {
      title: '成功 / 失败',
      key: 'sf',
      render: (_: any, r: any) => (
        <span>
          <span style={{ color: '#22c55e' }}>{r.successCount}</span> /{' '}
          <span style={{ color: '#ef4444' }}>{r.failCount}</span>
        </span>
      ),
    },
    { title: '来源', dataIndex: 'source', render: sourceTag },
    { title: '耗时', dataIndex: 'durationMs', render: (v: number) => `${v} ms` },
    {
      title: '操作',
      key: 'op',
      render: (_: any, r: any) => (
        <Space wrap>
          <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(r.id)}>
            详情
          </Button>
          <Button size="small" icon={<FundOutlined />} onClick={() => navigate(`/inspection/report/${r.id}`)}>
            报告
          </Button>
          <Tooltip title="单独导出该记录">
            <Button size="small" icon={<DownloadOutlined />} loading={exporting} onClick={() => exportXlsx('all', new Date().toISOString().slice(0, 10), r.id)}>
              导出
            </Button>
          </Tooltip>
        </Space>
      ),
    },
  ]

  return (
    <div className="fade-up">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 className="glow-text" style={{ margin: 0, fontSize: 22 }}>
            <FileExcelOutlined style={{ marginRight: 8 }} />
            巡检记录与报表
          </h2>
          <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
            查看历史巡检运行，按日 / 周 / 月 / 季度 / 年导出巡检明细与告警明细，并可生成 HTML 巡检报告
          </div>
        </div>
      </div>

      {/* ============ 季度报告（独立卡片，v1.7.26+） ============ */}
      <Card
        className="glass"
        style={{
          marginBottom: 16,
          borderColor: 'rgba(56, 189, 248, 0.45)',
          background: 'linear-gradient(160deg, rgba(56,189,248,0.08), rgba(2,6,23,0.4))',
        }}
        title={
          <Space>
            <FundOutlined style={{ color: '#38bdf8' }} />
            <span style={{ fontWeight: 700, color: '#38bdf8' }}>季度报告导出</span>
            <Tag color="cyan">xlsx · 5MB 硬上限</Tag>
          </Space>
        }
        extra={
          <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
            6 个 Sheet：概览 / 各次运行 / 资产明细 / 告警明细 / 资产趋势 / 按天趋势
          </span>
        }
      >
        <Space wrap align="center">
          <span style={{ color: 'var(--text-secondary)' }}>年份：</span>
          <Select
            value={quarterYear}
            onChange={(v) => setQuarterYear(v)}
            style={{ width: 110 }}
            options={Array.from({ length: 5 }, (_, i) => {
              const y = new Date().getFullYear() - i
              return { label: `${y} 年`, value: y }
            })}
          />
          <span style={{ color: 'var(--text-secondary)', marginLeft: 8 }}>季度：</span>
          <Segmented
            value={quarter}
            onChange={(v) => setQuarter(v as 1 | 2 | 3 | 4)}
            options={[
              { label: 'Q1(1-3月)', value: 1 },
              { label: 'Q2(4-6月)', value: 2 },
              { label: 'Q3(7-9月)', value: 3 },
              { label: 'Q4(10-12月)', value: 4 },
            ]}
          />
          <span style={{ color: 'var(--text-secondary)', marginLeft: 8 }}>任务：</span>
          <Select
            allowClear
            placeholder="全部任务"
            style={{ width: 220 }}
            value={taskId}
            onChange={(v) => setTaskId(v)}
            options={tasks.map((t) => ({ label: t.name, value: t.id }))}
          />
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            loading={quarterGenerating}
            onClick={generateQuarterReport}
          >
            生成季度报告 xlsx
          </Button>
        </Space>
        {quarterReport && (
          <Alert
            style={{ marginTop: 12 }}
            type={quarterReport.degraded ? 'warning' : 'success'}
            showIcon
            message={
              <Space wrap>
                <span>
                  <strong>{quarterReport.filename}</strong>
                </span>
                <Tag color={quarterReport.degraded ? 'orange' : 'green'}>
                  {fmtBytes(quarterReport.sizeBytes)}
                  {' '}
                  {quarterReport.sizeMB <= 5 ? '✓ 在 5MB 内' : '⚠ 超 5MB'}
                </Tag>
                <span style={{ color: 'var(--text-secondary)' }}>
                  季度 {quarterReport.stats.quarterStart} ~ {quarterReport.stats.quarterEnd} · 采集 {quarterReport.stats.totalResults} 条 · 运行 {quarterReport.stats.totalRecords} 次 · 告警 {quarterReport.stats.totalAlerts} 条
                </span>
                {quarterReport.degraded && !quarterReport.droppedSheets.length && (
                  <Tooltip title={quarterReport.compactedNotes.join('；')}>
                    <Tag color="blue">已压缩: 资产明细/告警明细按季度聚合（6 个 Sheet 都在）</Tag>
                  </Tooltip>
                )}
                {quarterReport.droppedSheets.length > 0 && (
                  <Tooltip title="为保证 ≤ 5MB，自动丢掉了部分 Sheet；如需完整数据请缩小筛选范围（如指定任务）。">
                    <Tag color="orange">已降级: 丢 {quarterReport.droppedSheets.join('、')}</Tag>
                  </Tooltip>
                )}
              </Space>
            }
          />
        )}
      </Card>

      <Card className="glass" style={{ marginBottom: 16 }}>
        <Space wrap align="center">
          <span style={{ color: 'var(--text-secondary)' }}>按任务筛选：</span>
          <Select
            allowClear
            placeholder="全部任务"
            style={{ width: 220 }}
            value={taskId}
            onChange={(v) => setTaskId(v)}
            options={tasks.map((t) => ({ label: t.name, value: t.id }))}
          />
          <span style={{ color: 'var(--text-secondary)', marginLeft: 12 }}>导出周期：</span>
          <Segmented
            value={period}
            onChange={(v) => setPeriod(v as string)}
            options={[
              { label: '日报', value: 'day' },
              { label: '周报', value: 'week' },
              { label: '月报', value: 'month' },
              { label: '季报', value: 'quarter' },
              { label: '年报', value: 'year' },
            ]}
          />
          <DatePicker
            value={refDate ? dayjs(refDate) : undefined}
            onChange={(_, d) => d && setRefDate(Array.isArray(d) ? d[0] : d)}
            allowClear={false}
          />
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            loading={exporting}
            onClick={() => exportXlsx(period, refDate)}
          >
            导出{PeriodMap[period]}（截至所选日）
          </Button>
        </Space>
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {Object.entries(PeriodMap).map(([p, label]) => (
            <Tooltip key={p} title={`一键导出最近一个${label}（截至今天）`}>
              <Button size="small" onClick={() => exportXlsx(p, new Date().toISOString().slice(0, 10))}>
                快速导出{label}
              </Button>
            </Tooltip>
          ))}
        </div>
        <Divider style={{ margin: '12px 0 10px' }} />
        <Space wrap align="center">
          <span style={{ color: 'var(--text-secondary)' }}>列表操作：</span>
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          {selectedKeys.length > 0 && (
            <Popconfirm
              title={`确认删除选中的 ${selectedKeys.length} 条巡检记录？`}
              description="将同时删除对应的采集明细，且不可恢复。"
              onConfirm={batchRemove}
            >
              <Button danger icon={<DeleteOutlined />}>
                批量删除（{selectedKeys.length}）
              </Button>
            </Popconfirm>
          )}
        </Space>
      </Card>

      <Card className="glass" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={records}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: (keys: React.Key[]) => setSelectedKeys(keys as number[]),
          }}
          pagination={{ pageSize: 12, hideOnSinglePage: true }}
        />
      </Card>

      <Drawer title="巡检明细" width={1000} open={detailOpen} onClose={() => setDetailOpen(false)}>
        {detail ? (
          <div>
            <Space wrap style={{ marginBottom: 12 }}>
              {statusTag(detail.record.status)}
              {sourceTag(detail.record.source)}
              <span style={{ color: 'var(--text-secondary)' }}>
                资产 {detail.record.totalAssets} · 成功 {detail.record.successCount} · 失败{' '}
                {detail.record.failCount}
              </span>
              <Button size="small" type="link" icon={<FundOutlined />} onClick={() => navigate(`/inspection/report/${detail.record.id}`)}>
                打开完整报告
              </Button>
            </Space>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="资产概览"
              description="以下为本次巡检全部资产的指标概览，逐台点击「详情」可下钻查看六类完整明细。"
            />
            {detail.results && detail.results.length > 0 ? (
              <Table
                rowKey="id"
                size="small"
                pagination={{ pageSize: 20, showSizeChanger: true, hideOnSinglePage: true }}
                scroll={{ x: 1180 }}
                onRow={(r: any) => ({ onClick: () => setDrill(r), style: { cursor: 'pointer' } })}
                dataSource={detail.results.map((r: any) => {
                  const d = r.data || {}
                  const disks: any[] = d.disk?.disks || []
                  const ifaces: any[] = d.net?.interfaces || []
                  const diskMax = disks.reduce((m: number, x: any) => Math.max(m, Number(x.usage || 0)), 0)
                  const netMax = ifaces.reduce((m: number, x: any) => Math.max(m, Number(x.bandwidth_pct || 0)), 0)
                  const alerts: any[] = r.alerts || []
                  const crit = alerts.filter((a: any) => a.level === 'critical').length
                  return {
                    ...r,
                    _cpu: Number(d.cpu?.usage || 0),
                    _mem: Number(d.mem?.usage || 0),
                    _disk: diskMax,
                    _net: netMax,
                    _alerts: alerts.length,
                    _crit: crit,
                  }
                })}
                columns={[
                  {
                    title: 'ERP系统名称',
                    dataIndex: 'assetName',
                    fixed: 'left',
                    width: 220,
                    render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span>,
                  },
                  { title: '归属部门', dataIndex: 'department', width: 140 },
                  { title: '虚拟机IPv4', dataIndex: 'ip', width: 130 },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    width: 80,
                    render: (s: string) =>
                      s === 'ok' ? <Tag color="success">正常</Tag> : <Tag color="error">失败</Tag>,
                  },
                  { title: 'CPU', dataIndex: '_cpu', width: 130, render: (v: number) => <UsageBar value={v} warn={70} crit={85} /> },
                  { title: '内存', dataIndex: '_mem', width: 130, render: (v: number) => <UsageBar value={v} warn={80} crit={90} /> },
                  { title: '磁盘', dataIndex: '_disk', width: 130, render: (v: number) => <UsageBar value={v} warn={75} crit={80} /> },
                  { title: '网络', dataIndex: '_net', width: 130, render: (v: number) => <UsageBar value={v} warn={70} /> },
                  {
                    title: '告警',
                    dataIndex: '_alerts',
                    width: 100,
                    render: (v: number, r: any) =>
                      v ? (
                        <Tag color={r._crit > 0 ? 'red' : 'orange'}>
                          {r._crit > 0 ? `${r._crit}严重/${v}` : `${v}`}
                        </Tag>
                      ) : (
                        <Tag color="green">0</Tag>
                      ),
                  },
                  {
                    title: '操作',
                    key: 'op',
                    fixed: 'right',
                    width: 90,
                    render: (_: any, r: any) => (
                      <Button size="small" onClick={(e) => { e.stopPropagation(); setDrill(r) }}>
                        详情
                      </Button>
                    ),
                  },
                ]}
              />
            ) : (
              <Empty />
            )}
          </div>
        ) : (
          <Empty />
        )}
      </Drawer>

      <Drawer
        title={drill ? `${drill.assetName}（${drill.ip}）${drill.department ? ` · ${drill.department}` : ''} · 八类明细` : '资产明细'}
        width={920}
        open={!!drill}
        onClose={() => setDrill(null)}
      >
        {drill ? (
          drill.status === 'ok' ? (
            <ResultDetail result={drill} />
          ) : (
            <span style={{ color: '#ef4444' }}>{drill.error || '采集失败'}</span>
          )
        ) : null}
      </Drawer>
    </div>
  )
}
