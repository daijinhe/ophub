// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  AlertOutlined,
  CloudServerOutlined,
  EyeInvisibleOutlined,
  ReloadOutlined,
  SettingOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import {
  listPromDataSources,
  promCollectNow,
  promHidden,
  promSnapshot,
  type PromDataSource,
  type PromHideReason,
  type PromHiddenHost,
  type PromHiddenIssue,
  type PromHiddenRank,
  type PromHiddenResp,
  type PromIssue,
} from '../api/prometheus'
import { useAuth } from '../store/AuthContext'

/**
 * 被屏蔽目标明细（v1.7.43）
 *
 * 为什么需要这一页：屏蔽规则 / 等级口径 / 清单上限 都是让大屏「更干净」的手段，
 * 但它们都会让真实存在的风险**从屏幕上消失**。没有审计视图的话，「屏蔽」等于「假装它不存在」。
 * 这一页回答两个问题：
 *   ① 现在到底屏蔽了谁（哪台主机、哪个维度、因为哪条规则）；
 *   ② 这些目标当前指标是多少（屏蔽不等于不存在，水位该看还得看）。
 *
 * ⚠️ 口径由后端 `handler_prom_masked.go` 一处收口：**被屏蔽 = 同一套阈值算出的全集 − 大屏实际展示的**。
 * 前端不要自己按规则字符串去匹配主机 —— 那会和「大屏到底展示了什么」逐渐对不上（大小写、
 * 「全部指标」这类通配、白名单取反…全是坑），页面上就会出现「大屏明明有、这里却说被屏蔽了」。
 */

const { Title, Text } = Typography

function errMsg(e: any, fallback = '加载失败'): string {
  return e?.response?.data?.msg || e?.message || fallback
}

function fmtPct(v: number | undefined | null): string {
  if (v === undefined || v === null) return '—'
  return `${v.toFixed(1)}%`
}

/**
 * 水位判级用**大屏配置里的阈值**，不写死 80/90/95 ——
 * 这样「这里标红」和「大屏上会出现告警」永远是同一件事，运维不会两边对着看成两套标准。
 */
function waterTag(v: number, warn: number, crit: number) {
  if (crit > 0 && v >= crit) return { color: 'red', text: fmtPct(v) }
  if (warn > 0 && v >= warn) return { color: 'orange', text: fmtPct(v) }
  return { color: 'green', text: fmtPct(v) }
}

function Water({ v, warn, crit }: { v: number; warn: number; crit: number }) {
  const t = waterTag(v, warn, crit)
  return (
    <Tag color={t.color} style={{ margin: 0 }}>
      {t.text}
    </Tag>
  )
}

const REASON_COLOR: Record<PromHideReason, string> = {
  mask: 'red',
  notwhite: 'magenta',
  risk: 'gold',
  truncate: 'default',
}

/** 规则的指标 key → 中文。⚠️ 别直接把 key 打到界面上：「× cpu」看着像漏翻译的 bug。 */
const METRIC_CN: Record<string, string> = {
  all: '全部指标',
  cpu: 'CPU',
  mem: '内存',
  disk: '磁盘',
  net: '网络',
  offline: '连通性',
}

const REFRESH_MS = 30_000

export default function PromHidden() {
  const { hasPerm } = useAuth()
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const dsParam = Number(sp.get('ds')) || undefined

  const [dss, setDss] = useState<PromDataSource[]>([])
  const [data, setData] = useState<PromHiddenResp | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [collecting, setCollecting] = useState(false)
  const [auto, setAuto] = useState(true)
  const [reason, setReason] = useState<'all' | PromHideReason>('all')
  const [host, setHost] = useState<PromHiddenHost | null>(null)
  const [snapIssues, setSnapIssues] = useState<PromIssue[] | null>(null)

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        setData(await promHidden(dsParam))
        setErr('')
      } catch (e: any) {
        setErr(errMsg(e))
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [dsParam],
  )

  useEffect(() => {
    load()
  }, [load])

  // 自动刷新：默认开。数据本身来自服务端快照，刷新的只是「当前水位」，
  // 所以轮询很便宜（读内存，不查 Prometheus）。
  useEffect(() => {
    if (!auto) return
    const t = window.setInterval(() => load(true), REFRESH_MS)
    return () => window.clearInterval(t)
  }, [auto, load])

  useEffect(() => {
    listPromDataSources()
      .then((r) => setDss((r.list || []).filter((d) => d.enabled === 1)))
      .catch(() => {})
  }, [])

  const collect = async () => {
    setCollecting(true)
    try {
      const r = await promCollectNow(dsParam)
      message.success(`采集完成：${r.hosts} 台主机，耗时 ${r.collectMs} ms`)
      await load(true)
    } catch (e: any) {
      message.error(errMsg(e, '采集失败'))
    } finally {
      setCollecting(false)
    }
  }

  /** 打开主机详情，并顺带取一次快照清单 —— 才能把「这个目标**没被屏蔽**的报警」也列出来 */
  const openHost = async (h: PromHiddenHost) => {
    setHost(h)
    setSnapIssues(null)
    try {
      const s = await promSnapshot(dsParam)
      setSnapIssues(s.data?.issues || [])
    } catch {
      setSnapIssues([])
    }
  }

  const c = data?.counts
  const th = data?.thresholds
  const topN = data?.topN ?? 5

  const filteredIssues = useMemo(
    () => (data?.issues || []).filter((x) => reason === 'all' || x.reason === reason),
    [data, reason],
  )

  /** 该主机的全部超阈值项：本页的「被隐藏」+ 快照里的「仍在大屏上」，合并去重（同指标只可能有一条） */
  const hostIssues = useMemo(() => {
    if (!host) return [] as { it: PromIssue; hidden: boolean; reasonCN?: string }[]
    const out: { it: PromIssue; hidden: boolean; reasonCN?: string }[] = []
    const seen = new Set<string>()
    for (const it of data?.issues || []) {
      if (it.instance !== host.instance) continue
      seen.add(it.metric)
      out.push({ it, hidden: true, reasonCN: it.reasonCN })
    }
    for (const it of snapIssues || []) {
      if (it.instance !== host.instance || seen.has(it.metric)) continue
      out.push({ it, hidden: false })
    }
    return out.sort((a, b) => (a.it.level === b.it.level ? b.it.value - a.it.value : a.it.level === 'crit' ? -1 : 1))
  }, [host, data, snapIssues])

  const thText = (metric: string) => {
    if (metric === 'offline') return '—'
    const pair =
      metric === 'cpu'
        ? [th?.cpuWarn, th?.cpuCrit]
        : metric === 'mem'
          ? [th?.memWarn, th?.memCrit]
          : [th?.diskWarn, th?.diskCrit]
    return `${pair[0] ?? 0}% / ${pair[1] ?? 0}%`
  }

  const instanceCell = (name: string, instance: string) => (
    <Space direction="vertical" size={0} style={{ lineHeight: 1.5 }}>
      <span>{name}</span>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {instance}
      </Text>
    </Space>
  )

  /* --------------------------- 被屏蔽主机（目标维度） --------------------------- */
  const hostColumns: ColumnsType<PromHiddenHost> = [
    {
      title: '目标',
      dataIndex: 'name',
      width: 240,
      fixed: 'left',
      render: (_v, r) => (
        <Space direction="vertical" size={0} style={{ lineHeight: 1.5 }}>
          <a onClick={() => openHost(r)}>{r.name}</a>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {r.instance}
          </Text>
        </Space>
      ),
    },
    { title: '部门', dataIndex: 'department', width: 130, render: (v: string) => v || '—' },
    {
      title: '被屏蔽维度',
      dataIndex: 'dimsCN',
      width: 210,
      render: (_v, r) => (
        <>
          {(r.dimsCN || []).map((d) => (
            <Tag key={d} color="red" style={{ marginBottom: 2 }}>
              {d}
            </Tag>
          ))}
        </>
      ),
    },
    {
      title: 'CPU',
      dataIndex: 'cpu',
      width: 90,
      render: (v: number) => <Water v={v} warn={th?.cpuWarn || 0} crit={th?.cpuCrit || 0} />,
    },
    {
      title: '内存',
      dataIndex: 'mem',
      width: 90,
      render: (v: number) => <Water v={v} warn={th?.memWarn || 0} crit={th?.memCrit || 0} />,
    },
    {
      title: '磁盘',
      dataIndex: 'disk',
      width: 90,
      render: (v: number) => <Water v={v} warn={th?.diskWarn || 0} crit={th?.diskCrit || 0} />,
    },
    {
      title: '网络',
      dataIndex: 'net',
      width: 90,
      render: (v: number) => <Water v={v} warn={0} crit={0} />,
    },
    {
      title: '状态',
      dataIndex: 'risk',
      width: 100,
      render: (_v, r) =>
        r.up ? (
          <Tag color={r.risk === 'crit' ? 'red' : r.risk === 'warn' ? 'orange' : 'green'} style={{ margin: 0 }}>
            {r.riskCN}
          </Tag>
        ) : (
          <Tag color="red" style={{ margin: 0 }}>
            离线
          </Tag>
        ),
    },
    {
      title: '原因',
      dataIndex: 'reasonCN',
      width: 130,
      render: (v: string, r) => (
        <Tag color={REASON_COLOR[r.reason] || 'default'} style={{ margin: 0 }}>
          {v}
        </Tag>
      ),
    },
    {
      title: '触发规则',
      dataIndex: 'rules',
      width: 280,
      render: (v: string[]) =>
        v && v.length ? (
          <Space direction="vertical" size={0}>
            {v.map((x) => (
              <Text key={x} style={{ fontSize: 12 }}>
                {x}
              </Text>
            ))}
          </Space>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Text>
        ),
    },
  ]

  /* --------------------------- 被隐藏的风险项（条目维度） --------------------------- */
  const issueColumns: ColumnsType<PromHiddenIssue> = [
    {
      title: '等级',
      dataIndex: 'level',
      width: 80,
      fixed: 'left',
      render: (v: string, r) => <Tag color={v === 'crit' ? 'red' : 'orange'}>{r.levelCN}</Tag>,
    },
    {
      title: '目标',
      dataIndex: 'name',
      width: 240,
      render: (_v, r) => instanceCell(r.name, r.instance),
    },
    { title: '指标', dataIndex: 'metricCN', width: 90 },
    {
      title: '当前值',
      dataIndex: 'value',
      width: 100,
      render: (v: number, r) =>
        r.metric === 'offline' ? (
          <Tag color="red" style={{ margin: 0 }}>
            离线
          </Tag>
        ) : (
          <Water
            v={v}
            warn={r.metric === 'cpu' ? th?.cpuWarn || 0 : r.metric === 'mem' ? th?.memWarn || 0 : th?.diskWarn || 0}
            crit={r.metric === 'cpu' ? th?.cpuCrit || 0 : r.metric === 'mem' ? th?.memCrit || 0 : th?.diskCrit || 0}
          />
        ),
    },
    {
      title: '阈值（关注/严重）',
      width: 130,
      render: (_v, r) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {thText(r.metric)}
        </Text>
      ),
    },
    {
      title: '原因',
      dataIndex: 'reasonCN',
      width: 130,
      render: (v: string, r) => (
        <Tag color={REASON_COLOR[r.reason] || 'default'} style={{ margin: 0 }}>
          {v}
        </Tag>
      ),
    },
    {
      title: '命中规则',
      width: 240,
      render: (_v, r) => (
        <Space direction="vertical" size={0} style={{ lineHeight: 1.5 }}>
          <Text style={{ fontSize: 12 }}>
            包含「{r.ruleTarget}」× {METRIC_CN[r.ruleMetric || 'all'] || r.ruleMetric}
          </Text>
          {r.note && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              备注：{r.note}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '该主机当前水位',
      width: 300,
      render: (_v, r) => {
        const dims: [string, number, number, number][] = [
          ['CPU', r.hostCpu, th?.cpuWarn || 0, th?.cpuCrit || 0],
          ['内存', r.hostMem, th?.memWarn || 0, th?.memCrit || 0],
          ['磁盘', r.hostDisk, th?.diskWarn || 0, th?.diskCrit || 0],
          ['网络', r.hostNet, 0, 0],
        ]
        return (
          <Space size={4} wrap>
            {dims.map(([label, v, w, ct]) => (
              <span key={label} style={{ fontSize: 12 }}>
                <Text type="secondary">{label} </Text>
                <Water v={v} warn={w} crit={ct} />
              </span>
            ))}
          </Space>
        )
      },
    },
  ]

  /* --------------------------- 被屏蔽的榜位 --------------------------- */
  const rankColumns: ColumnsType<PromHiddenRank> = [
    {
      title: '指标',
      dataIndex: 'metricCN',
      width: 90,
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: '原本名次',
      dataIndex: 'wouldRank',
      width: 110,
      sorter: (a, b) => a.wouldRank - b.wouldRank,
      render: (v: number) => (
        <Tooltip title={`不屏蔽的话它是第 ${v} 名（TOP ${topN} 内的榜位）`}>
          <Tag color="red" style={{ margin: 0 }}>
            第 {v} 名
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '目标',
      dataIndex: 'name',
      width: 240,
      render: (_v, r) => instanceCell(r.name, r.instance),
    },
    {
      title: '当前值',
      dataIndex: 'value',
      width: 100,
      render: (v: number) => <Water v={v} warn={0} crit={0} />,
    },
    {
      title: '原因',
      dataIndex: 'reasonCN',
      width: 130,
      render: (v: string, r) => (
        <Tag color={REASON_COLOR[r.reason] || 'default'} style={{ margin: 0 }}>
          {v}
        </Tag>
      ),
    },
    {
      title: '命中规则',
      width: 260,
      render: (_v, r) =>
        r.ruleTarget ? (
          <Text style={{ fontSize: 12 }}>
            包含「{r.ruleTarget}」
            {r.note ? `（${r.note}）` : ''}
          </Text>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Text>
        ),
    },
  ]

  /* --------------------------- 渲染 --------------------------- */
  const ready = !!data?.ready

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <Title level={4} style={{ margin: 0 }}>
          <EyeInvisibleOutlined style={{ marginRight: 8 }} />
          被屏蔽目标
        </Title>
        <Tag color="purple">v1.7.44</Tag>
        {ready && data && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {data.dsName} · 快照 {data.generatedAt} · 采集耗时 {data.collectMs} ms
          </Text>
        )}
        <Space style={{ marginLeft: 'auto' }} wrap>
          {dss.length > 1 && (
            <Select
              size="small"
              style={{ width: 180 }}
              value={dsParam ?? dss[0].id}
              onChange={(v) => {
                const next = new URLSearchParams(sp)
                next.set('ds', String(v))
                setSp(next, { replace: true })
              }}
              options={dss.map((d) => ({ value: d.id, label: d.name }))}
            />
          )}
          <Tooltip title={`每 ${REFRESH_MS / 1000} 秒刷新一次当前水位（读服务端快照，不查 Prometheus）`}>
            <Switch size="small" checked={auto} onChange={setAuto} checkedChildren="自动刷新" unCheckedChildren="暂停刷新" />
          </Tooltip>
          {/* 本页是只读审计视图，唯一的「写」动作就是这个「立即采集」：
              它走 POST /prom/collect（后端 any-of: prom:screen / prom:screen:config:update），
              故按后端实际收口码 prom:screen:config:update 显隐；其余按钮均为只读展示，不加条件。 */}
          {hasPerm('prom:screen:config:update') && (
            <Button size="small" icon={<SyncOutlined />} loading={collecting} onClick={collect}>
              立即采集
            </Button>
          )}
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => load()}>
            刷新
          </Button>
          <Tooltip title="回到大屏管理 → 风险与屏蔽（屏蔽规则、等级口径、白名单都在那里配）">
            <Button
              size="small"
              type="primary"
              ghost
              icon={<SettingOutlined />}
              onClick={() => navigate('/prom/screen-admin?tab=risk')}
            >
              返回大屏管理
            </Button>
          </Tooltip>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="这里是大屏的「审计视图」：大屏上看不到的目标、风险项、榜位都在这里，并附上它们当前的实时指标"
        description={
          <>
            屏蔽不等于不存在 —— 被屏蔽的目标仍然在真实报警，只是没有投在屏幕上。
            「被屏蔽」的判定与大屏<b>同一套代码口径</b>（同一份阈值、同一份规则、同一个清单上限），
            所以这里显示的不会被屏蔽的和这里列出的不会重复、也不会漏。
            <br />
            本页入口在<b>大屏管理 → 风险与屏蔽 → 「被屏蔽明细」</b>（不再单占侧边栏菜单）。
            {data && (
              <>
                <br />
                当前策略：{data.maskMode === 'whitelist' ? '白名单 · 只展示命中的' : '黑名单 · 命中即隐藏'} · 等级口径{' '}
                {data.riskLevel === 'all' ? '全部' : data.riskLevel === 'crit' ? '仅严重' : '仅关注'} · TOP {data.topN} ·{' '}
                屏蔽规则 {data.masks.length} 条
              </>
            )}
          </>
        }
      />

      {err && <Alert type="error" showIcon style={{ marginBottom: 12 }} message="加载失败" description={err} />}
      {data?.msg && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="最近一次采集有问题" description={data.msg} />
      )}
      {data?.notices.map((n, i) => (
        <Alert key={i} type={n.level} showIcon style={{ marginBottom: 8 }} message={n.text} />
      ))}

      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="被屏蔽的目标"
              value={c?.hiddenHosts ?? 0}
              suffix={<span style={{ fontSize: 13, color: '#8c8c8c' }}>/ {c?.fleetHosts ?? 0} 台</span>}
              valueStyle={{ color: (c?.hiddenHosts ?? 0) > 0 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="被隐藏的风险项"
              value={c?.issueHidden ?? 0}
              suffix={<span style={{ fontSize: 13, color: '#8c8c8c' }}>/ {c?.issueTotal ?? 0} 条超阈值</span>}
              valueStyle={{ color: (c?.issueHidden ?? 0) > 0 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="被屏蔽的榜位"
              value={c?.rankSlots ?? 0}
              suffix={<span style={{ fontSize: 13, color: '#8c8c8c' }}>个</span>}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              其中 规则屏蔽 {c?.maskedIssues ?? 0} 项 · 等级收窄 {c?.riskIssues ?? 0} 项 · 超出上限 {c?.truncIssues ?? 0} 项
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="大屏实际展示的风险项"
              value={c?.issueShown ?? 0}
              suffix={<span style={{ fontSize: 13, color: '#8c8c8c' }}>条</span>}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              另有 {c?.rankBeyond ?? 0} 台被屏蔽但名次在 TOP {topN} 之外
            </Text>
          </Card>
        </Col>
      </Row>

      {!ready ? (
        <Card size="small">
          <Empty
            description={
              data?.collecting ? '该数据源首次采集进行中，稍后刷新即可' : '该数据源还没有采集到快照，算不出被屏蔽项'
            }
          >
            {hasPerm('prom:screen:config:update') && (
              <Button type="primary" icon={<SyncOutlined />} loading={collecting} onClick={collect}>
                立即采集
              </Button>
            )}
          </Empty>
        </Card>
      ) : (
        <>
          <Card
            size="small"
            title={
              <span>
                <CloudServerOutlined /> 被屏蔽的目标（{data?.hosts.length ?? 0}）
              </span>
            }
            extra={
              <Text type="secondary" style={{ fontSize: 12 }}>
                点目标名可看它当前的完整报警情况
              </Text>
            }
            style={{ marginBottom: 12 }}
          >
            <div data-e2e="hidden-hosts">
              {(data?.hosts.length ?? 0) === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="当前没有目标被屏蔽 —— 大屏上看到的就是全部"
                />
              ) : (
                <Table
                  rowKey="instance"
                  size="small"
                  loading={loading}
                  columns={hostColumns}
                  dataSource={data?.hosts || []}
                  pagination={{ pageSize: 20, showSizeChanger: true, size: 'small' }}
                  scroll={{ x: 1500 }}
                />
              )}
            </div>
          </Card>

          <Card
            size="small"
            title={
              <span>
                <AlertOutlined /> 被隐藏的风险项（{data?.issues.length ?? 0}）
              </span>
            }
            extra={
              <Space size={4}>
                <Segmented
                  size="small"
                  value={reason}
                  onChange={(v) => setReason(v as any)}
                  options={[
                    { label: `全部 ${data?.issues.length ?? 0}`, value: 'all' },
                    { label: `规则屏蔽 ${c?.maskedIssues ?? 0}`, value: 'mask' },
                    { label: `白名单外`, value: 'notwhite' },
                    { label: `等级收窄 ${c?.riskIssues ?? 0}`, value: 'risk' },
                    { label: `超出上限 ${c?.truncIssues ?? 0}`, value: 'truncate' },
                  ]}
                />
              </Space>
            }
            style={{ marginBottom: 12 }}
          >
            <div data-e2e="hidden-issues">
              {filteredIssues.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    (data?.issues.length ?? 0) === 0
                      ? '没有风险项被隐藏 —— 所有超阈值项都上了大屏'
                      : '当前筛选条件下没有记录'
                  }
                />
              ) : (
                <Table
                  rowKey={(r) => `${r.instance}|${r.metric}`}
                  size="small"
                  loading={loading}
                  columns={issueColumns}
                  dataSource={filteredIssues}
                  pagination={{ pageSize: 20, showSizeChanger: true, size: 'small' }}
                  scroll={{ x: 1500 }}
                />
              )}
            </div>
          </Card>

          <Card
            size="small"
            title={
              <span>
                <AlertOutlined /> 被屏蔽的榜位（{data?.ranks.length ?? 0}）
              </span>
            }
            style={{ marginBottom: 12 }}
          >
            <div data-e2e="hidden-ranks">
              {(data?.ranks.length ?? 0) === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="四个负载榜没有被屏蔽掉的名次"
                />
              ) : (
                <Table
                  rowKey={(r) => `${r.metric}|${r.instance}`}
                  size="small"
                  loading={loading}
                  columns={rankColumns}
                  dataSource={data?.ranks || []}
                  pagination={false}
                  scroll={{ x: 1000 }}
                />
              )}
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              这里只列「本来能上屏（名次在 TOP {topN} 内）、因为规则被挡掉」的名次；
              名次更靠后的被屏蔽主机不逐个列出（见上方提示计数）。
            </Text>
          </Card>
        </>
      )}

      {/* ---------------- 主机详情抽屉：这个目标当前到底在报警什么 ---------------- */}
      <Drawer
        width={860}
        open={!!host}
        onClose={() => setHost(null)}
        title={host ? `被屏蔽目标：${host.name}` : ''}
        destroyOnClose
      >
        {host && (
          <>
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 12 }}>
              <Descriptions.Item label="实例">{host.instance}</Descriptions.Item>
              <Descriptions.Item label="主机名">{host.hostname || '—'}</Descriptions.Item>
              <Descriptions.Item label="项目">{host.system || '—'}</Descriptions.Item>
              <Descriptions.Item label="部门">{host.department || '—'}</Descriptions.Item>
              <Descriptions.Item label="环境">{host.env || '—'}</Descriptions.Item>
              <Descriptions.Item label="业务环境">{host.deployserver || '—'}</Descriptions.Item>
              <Descriptions.Item label="连通性">
                {host.up ? <Tag color="green">在线</Tag> : <Tag color="red">离线</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="屏蔽原因">
                <Tag color={REASON_COLOR[host.reason] || 'default'}>{host.reasonCN}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="被屏蔽维度" span={2}>
                {(host.dimsCN || []).map((d) => (
                  <Tag key={d} color="red">
                    {d}
                  </Tag>
                ))}
              </Descriptions.Item>
              {(host.rules || []).length > 0 && (
                <Descriptions.Item label="触发规则" span={2}>
                  {host.rules.map((r) => (
                    <div key={r}>
                      <Text style={{ fontSize: 12 }}>{r}</Text>
                    </div>
                  ))}
                </Descriptions.Item>
              )}
            </Descriptions>

            <Row gutter={12} style={{ marginBottom: 12 }}>
              <Col span={6}>
                <Card size="small">
                  <Statistic
                    title="CPU"
                    value={host.cpu}
                    suffix="%"
                    valueStyle={{ color: waterTag(host.cpu, th?.cpuWarn || 0, th?.cpuCrit || 0).color === 'red' ? '#cf1322' : undefined }}
                  />
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small">
                  <Statistic
                    title="内存"
                    value={host.mem}
                    suffix="%"
                    valueStyle={{ color: waterTag(host.mem, th?.memWarn || 0, th?.memCrit || 0).color === 'red' ? '#cf1322' : undefined }}
                  />
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small">
                  <Statistic
                    title="磁盘"
                    value={host.disk}
                    suffix="%"
                    valueStyle={{ color: waterTag(host.disk, th?.diskWarn || 0, th?.diskCrit || 0).color === 'red' ? '#cf1322' : undefined }}
                  />
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small">
                  <Statistic title="网络" value={host.net} suffix="%" />
                </Card>
              </Col>
            </Row>

            <Card
              size="small"
              title="该目标当前的全部超阈值项"
              extra={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  阈值（关注/严重）：CPU {th?.cpuWarn ?? 0}/{th?.cpuCrit ?? 0}% · 内存 {th?.memWarn ?? 0}/
                  {th?.memCrit ?? 0}% · 磁盘 {th?.diskWarn ?? 0}/{th?.diskCrit ?? 0}%
                </Text>
              }
            >
              {snapIssues === null ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="读取中…" />
              ) : hostIssues.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该目标当前没有超阈值的指标" />
              ) : (
                <Table
                  rowKey={(r) => r.it.metric}
                  size="small"
                  pagination={false}
                  dataSource={hostIssues}
                  columns={[
                    {
                      title: '指标',
                      width: 90,
                      render: (_v, r) => r.it.metricCN,
                    },
                    {
                      title: '等级',
                      width: 90,
                      render: (_v, r) => <Tag color={r.it.level === 'crit' ? 'red' : 'orange'}>{r.it.levelCN}</Tag>,
                    },
                    {
                      title: '当前值',
                      width: 110,
                      render: (_v, r) => (r.it.metric === 'offline' ? <Tag color="red">离线</Tag> : fmtPct(r.it.value)),
                    },
                    {
                      title: '是否上大屏',
                      render: (_v, r) =>
                        r.hidden ? (
                          <Tooltip title={r.reasonCN}>
                            <Tag color="default">不上屏（{r.reasonCN}）</Tag>
                          </Tooltip>
                        ) : (
                          <Tag color="green">上屏</Tag>
                        ),
                    },
                  ]}
                />
              )}
            </Card>
          </>
        )}
      </Drawer>
    </div>
  )
}
