import { useEffect, useMemo, useState } from 'react'
import { Row, Col, Card, Typography, Spin, Select, Empty, Segmented } from 'antd'
import {
  TeamOutlined,
  SafetyCertificateOutlined,
  DatabaseOutlined,
  CloudServerOutlined,
  AppstoreOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from 'recharts'
import api from '../api/client'
import { useAuth } from '../store/AuthContext'
import { useTheme } from '../store/ThemeContext'
import { FieldDefs } from '../api/fields'

// 分析维度候选（取自模板字段，新增维度只需在此追加 label 即可拓展）
const DIM_LABELS = [
  '归属部门',
  '功能类别',
  '操作系统版本',
  '所属网络区域',
  '应用系统名称',
  '项目性质',
  '是否需要国产化',
]
const keyOf = (label: string) => FieldDefs.find((f) => f.label === label)?.key || label

const PALETTE = [
  '#38bdf8', '#818cf8', '#34d399', '#fbbf24', '#f472b6',
  '#22d3ee', '#a78bfa', '#fb7185', '#4ade80', '#facc15',
]

interface Overview {
  total: { users: number; roles: number; categories: number; assets: number }
  trend: { date: string; count: number }[]
}
interface KV {
  value: string
  count: number
}

export default function Dashboard() {
  const { user } = useAuth()
  const { mode } = useTheme()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [group, setGroup] = useState<KV[]>([])
  const [dim, setDim] = useState<string>(DIM_LABELS[0])
  const [loading, setLoading] = useState(true)
  const [loadingGroup, setLoadingGroup] = useState(false)

  const axisColor = mode === 'dark' ? '#94a3b8' : '#64748b'
  const gridColor = mode === 'dark' ? 'rgba(148,163,184,0.14)' : 'rgba(100,116,139,0.12)'

  const tooltipStyle = {
    background: mode === 'dark' ? 'rgba(15,23,42,0.96)' : '#ffffff',
    border: `1px solid ${mode === 'dark' ? 'rgba(148,163,184,0.2)' : '#e3e8f0'}`,
    borderRadius: 10,
    color: mode === 'dark' ? '#e2e8f0' : '#334155',
  }

  const loadOverview = () => {
    setLoading(true)
    api
      .get('/stats/overview')
      .then((r) => setOverview(r.data.data))
      .finally(() => setLoading(false))
  }

  const loadGroup = (d: string) => {
    setLoadingGroup(true)
    api
      .get('/stats/group', { params: { field: keyOf(d), limit: 10 } })
      .then((r) => setGroup(r.data.data || []))
      .catch(() => setGroup([]))
      .finally(() => setLoadingGroup(false))
  }

  useEffect(() => {
    loadOverview()
    loadGroup(dim)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cards = useMemo(() => {
    const t = overview?.total
    return [
      {
        title: '虚拟机资产',
        value: t?.assets ?? 0,
        icon: <DatabaseOutlined />,
        color: '#38bdf8',
        glow: 'rgba(56,189,248,0.18)',
      },
      {
        title: '资产分类',
        value: t?.categories ?? 0,
        icon: <CloudServerOutlined />,
        color: '#34d399',
        glow: 'rgba(52,211,153,0.18)',
      },
      {
        title: '平台用户',
        value: t?.users ?? 0,
        icon: <TeamOutlined />,
        color: '#818cf8',
        glow: 'rgba(129,140,248,0.18)',
      },
      {
        title: '角色数量',
        value: t?.roles ?? 0,
        icon: <SafetyCertificateOutlined />,
        color: '#fbbf24',
        glow: 'rgba(251,191,36,0.18)',
      },
    ]
  }, [overview])

  const totalGroup = group.reduce((s, g) => s + g.count, 0)

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
            欢迎回来，{user?.nickname || user?.username} 👋
          </Typography.Title>
          <Typography.Text type="secondary">
            云枢 OpsHub · 资产与权限总览，数据可随时按维度下钻分析。
          </Typography.Text>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Select
            value={dim}
            onChange={(d) => {
              setDim(d)
              loadGroup(d)
            }}
            style={{ width: 180 }}
            options={DIM_LABELS.map((l) => ({ value: l, label: l }))}
            suffixIcon={<AppstoreOutlined />}
          />
          <span
            className="theme-toggle"
            style={{ width: 38, height: 38 }}
            onClick={loadOverview}
            title="刷新数据"
          >
            <ReloadOutlined />
          </span>
        </div>
      </div>

      <Spin spinning={loading}>
        {/* 指标卡 */}
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          {cards.map((c, i) => (
            <Col xs={24} sm={12} lg={6} key={c.title}>
              <Card className="glass fade-up" style={{ border: 'none', overflow: 'hidden' }} styles={{ body: { padding: 20 } }}>
                <div style={{ position: 'relative' }}>
                  <div
                    style={{
                      position: 'absolute',
                      right: -8,
                      top: -8,
                      width: 96,
                      height: 96,
                      borderRadius: '50%',
                      background: c.glow,
                      filter: 'blur(8px)',
                    }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 6 }}>
                        {c.title}
                      </div>
                      <div
                        className="tabular-nums"
                        style={{ fontSize: 32, fontWeight: 700, color: c.color, lineHeight: 1.1 }}
                      >
                        {c.value}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 24,
                        color: c.color,
                        background: c.glow,
                        padding: 12,
                        borderRadius: 14,
                      }}
                    >
                      {c.icon}
                    </div>
                  </div>
                </div>
              </Card>
            </Col>
          ))}
        </Row>

        {/* 趋势 + 维度分布 */}
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={24} lg={14}>
            <Card
              className="glass"
              title={
                <span style={{ fontWeight: 650 }}>
                  <AppstoreOutlined style={{ color: 'var(--accent)', marginRight: 8 }} />
                  资产增长趋势（近 14 天）
                </span>
              }
              style={{ border: 'none' }}
            >
              <div style={{ height: 320 }}>
                {overview?.trend?.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={overview.trend} margin={{ top: 10, right: 12, left: -16, bottom: 0 }}>
                      <defs>
                        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.55} />
                          <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                      <XAxis dataKey="date" stroke={axisColor} fontSize={12} tickLine={false} />
                      <YAxis stroke={axisColor} fontSize={12} tickLine={false} allowDecimals={false} />
                      <RTooltip contentStyle={tooltipStyle} />
                      <Area
                        type="monotone"
                        dataKey="count"
                        name="新增资产"
                        stroke="#38bdf8"
                        strokeWidth={2.5}
                        fill="url(#areaGrad)"
                        dot={{ r: 3, fill: '#38bdf8' }}
                        activeDot={{ r: 5 }}
                        animationDuration={900}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <Empty description="暂无资产数据" style={{ marginTop: 100 }} />
                )}
              </div>
            </Card>
          </Col>

          <Col xs={24} lg={10}>
            <Card
              className="glass"
              title={
                <span style={{ fontWeight: 650 }}>
                  <AppstoreOutlined style={{ color: 'var(--accent)', marginRight: 8 }} />
                  {dim} 分布
                </span>
              }
              style={{ border: 'none' }}
            >
              <div style={{ height: 320 }}>
                <Spin spinning={loadingGroup}>
                  {group.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={group}
                          dataKey="count"
                          nameKey="value"
                          cx="50%"
                          cy="50%"
                          innerRadius={62}
                          outerRadius={96}
                          paddingAngle={2}
                          animationDuration={800}
                        >
                          {group.map((_, i) => (
                            <Cell key={i} fill={PALETTE[i % PALETTE.length]} stroke="transparent" />
                          ))}
                        </Pie>
                        <RTooltip contentStyle={tooltipStyle} formatter={(v: any, n: any) => [`${v} 台`, n]} />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <Empty description="暂无数据" style={{ marginTop: 100 }} />
                  )}
                </Spin>
              </div>
              {totalGroup > 0 && (
                <div style={{ textAlign: 'center', marginTop: -8 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    共 {totalGroup} 条 · 按 {dim} 聚合
                  </Typography.Text>
                </div>
              )}
            </Card>
          </Col>
        </Row>

        {/* 维度排名（可切换维度） */}
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col span={24}>
            <Card
              className="glass"
              title={
                <span style={{ fontWeight: 650 }}>
                  <AppstoreOutlined style={{ color: 'var(--accent)', marginRight: 8 }} />
                  {dim} · Top 排行
                </span>
              }
              extra={
                <Segmented
                  options={DIM_LABELS.map((l) => ({ label: l, value: l }))}
                  value={dim}
                  onChange={(v) => {
                    setDim(v as string)
                    loadGroup(v as string)
                  }}
                />
              }
              style={{ border: 'none' }}
            >
              <div style={{ height: 340 }}>
                <Spin spinning={loadingGroup}>
                  {group.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={[...group].reverse()}
                        layout="vertical"
                        margin={{ top: 4, right: 24, left: 8, bottom: 4 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} horizontal={false} />
                        <XAxis type="number" stroke={axisColor} fontSize={12} tickLine={false} />
                        <YAxis
                          type="category"
                          dataKey="value"
                          stroke={axisColor}
                          fontSize={12}
                          width={140}
                          tickLine={false}
                        />
                        <RTooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(120,160,220,0.08)' }} />
                        <Bar dataKey="count" name="数量" radius={[0, 8, 8, 0]} animationDuration={800}>
                          {group.slice().reverse().map((_, i) => (
                            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <Empty description="暂无数据" style={{ marginTop: 110 }} />
                  )}
                </Spin>
              </div>
            </Card>
          </Col>
        </Row>
      </Spin>
    </div>
  )
}
