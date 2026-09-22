import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Col,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  StopOutlined,
} from '@ant-design/icons'
import {
  getPromScreenConfig,
  promSnapshot,
  savePromScreenConfig,
  type PromMaskRule,
} from '../api/prometheus'

const { Title, Text, Paragraph } = Typography

function errMsg(e: any, fallback = '操作失败'): string {
  return e?.response?.data?.msg || e?.message || fallback
}

/** 屏蔽规则的指标口径 */
const MASK_METRIC_OPTIONS = [
  { value: 'all', label: '全部指标' },
  { value: 'cpu', label: 'CPU' },
  { value: 'mem', label: '内存' },
  { value: 'disk', label: '磁盘' },
  { value: 'offline', label: '离线（连通性）' },
]
const MASK_METRIC_CN: Record<string, string> = {
  all: '全部指标',
  cpu: 'CPU',
  mem: '内存',
  disk: '磁盘',
  offline: '离线（连通性）',
}

/**
 * Prometheus 监控 · 屏蔽规则（v1.7.36 独立菜单）
 *
 * 从「大屏管理」里拆出来单独立页：屏蔽规则是高频运维动作（哪台机器已知问题、
 * 暂不处理就先屏蔽掉），不该每次都要先打开大屏管理再翻到下面找。
 *
 * 生效口径：命中规则的（主机, 指标）不再进入大屏「超阈值主机」面板，也不再计数；
 * 保存后服务端立即用当前快照重算，不用等下一轮采集。
 */
export default function PromMaskRules() {
  const [masks, setMasks] = useState<PromMaskRule[]>([])
  const [hostOpts, setHostOpts] = useState<{ value: string; label: string }[]>([])
  const [newTarget, setNewTarget] = useState('')
  const [newMetric, setNewMetric] = useState<PromMaskRule['metric']>('all')
  const [newNote, setNewNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [issueCount, setIssueCount] = useState<{ crit: number; warn: number } | null>(null)
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await getPromScreenConfig()
      setMasks(r.config.masks || [])
      setDirty(false)
    } catch (e) {
      message.error('加载屏蔽规则失败:' + errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 主机候选：拉一次快照（instance + 展示名）；失败不影响规则编辑
  useEffect(() => {
    promSnapshot()
      .then((s) => {
        const hs = s.data?.hosts || []
        const opts: { value: string; label: string }[] = []
        const seen = new Set<string>()
        for (const h of hs) {
          if (h.instance && !seen.has(h.instance)) {
            seen.add(h.instance)
            opts.push({ value: h.instance, label: h.instance })
          }
          const nm = [h.system, h.env, h.deployserver].filter(Boolean).join('_')
          if (nm && !seen.has(nm)) {
            seen.add(nm)
            opts.push({ value: nm, label: `${nm}（项目名_环境_业务环境）` })
          }
        }
        setHostOpts(opts)
        if (s.data?.issueStat) {
          setIssueCount({ crit: s.data.issueStat.crit, warn: s.data.issueStat.warn })
        }
      })
      .catch(() => undefined)
  }, [])

  const onSave = useCallback(async () => {
    setSaving(true)
    try {
      // 只提交 masks：后端对未传字段保持原值（阈值/采集间隔不会被打回默认）
      const r = await savePromScreenConfig({ masks })
      message.success(r.msg || '已保存，屏蔽规则立即生效')
      setDirty(false)
      const s = await promSnapshot()
      if (s.data?.issueStat) setIssueCount({ crit: s.data.issueStat.crit, warn: s.data.issueStat.warn })
    } catch (e) {
      message.error('保存失败:' + errMsg(e))
    } finally {
      setSaving(false)
    }
  }, [masks])

  const addMask = useCallback(() => {
    const t = newTarget.trim()
    if (!t) {
      message.warning('请填写要屏蔽的主机（instance 或名称关键字）')
      return
    }
    if (masks.some((m) => m.target === t && m.metric === newMetric)) {
      message.info('该屏蔽规则已存在')
      return
    }
    setMasks((prev) => [...prev, { target: t, metric: newMetric, note: newNote.trim() || undefined }])
    setNewTarget('')
    setNewNote('')
    setDirty(true)
  }, [masks, newTarget, newMetric, newNote])

  const removeMask = useCallback((t: string, m: string) => {
    setMasks((prev) => prev.filter((x) => !(x.target === t && x.metric === m)))
    setDirty(true)
  }, [])

  const columns = useMemo(
    () => [
      {
        title: '目标（包含匹配）',
        dataIndex: 'target',
        key: 'target',
        render: (v: string, r: PromMaskRule) => (
          <div>
            <div style={{ fontWeight: 600 }}>{v}</div>
            {r.note && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {r.note}
              </Text>
            )}
          </div>
        ),
      },
      {
        title: '屏蔽指标',
        dataIndex: 'metric',
        key: 'metric',
        width: 150,
        render: (v: string) => (
          <Tag color={v === 'all' ? 'red' : 'geekblue'}>{MASK_METRIC_CN[v] || v}</Tag>
        ),
      },
      {
        title: '操作',
        key: 'op',
        width: 80,
        render: (_: any, r: PromMaskRule) => (
          <Tooltip title="删除该规则">
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeMask(r.target, r.metric)}
            />
          </Tooltip>
        ),
      },
    ],
    [removeMask],
  )

  const stat = useMemo(() => {
    const byMetric: Record<string, number> = {}
    for (const m of masks) byMetric[m.metric] = (byMetric[m.metric] || 0) + 1
    return byMetric
  }, [masks])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          <StopOutlined style={{ marginRight: 8 }} />
          屏蔽规则（超阈值面板）
        </Title>
        <Tag color="purple">v1.7.36</Tag>
        {dirty && <Tag color="orange">有未保存的改动</Tag>}
        <Space style={{ marginLeft: 'auto' }}>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={onSave} loading={saving}>
            保存并生效
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="命中规则的主机指标不会再出现在大屏「超阈值主机」面板，也不计入统计"
        description={
          <div>
            目标可以是 <code>instance</code>（如 <code>198.51.100.31:9100</code>）也可以是展示名关键字（如{' '}
            <code>和创利OA</code>），按<strong>包含</strong>匹配、不区分大小写 —— 填 IP 段或项目名片段即可批量屏蔽。
            保存后服务端立即用当前快照重算，<strong>不用等下一轮采集</strong>。
          </div>
        }
      />

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={16}>
          <Card
            size="small"
            title={<span><StopOutlined /> 规则列表</span>}
            extra={<Tag color={masks.length ? 'red' : 'default'}>{masks.length} 条</Tag>}
            loading={loading}
          >
            <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
              <AutoComplete
                value={newTarget}
                onChange={setNewTarget}
                options={hostOpts}
                placeholder="主机 instance（IP:端口）或展示名关键字"
                style={{ width: '44%' }}
                filterOption={(input, option) =>
                  String(option?.value || '').toLowerCase().includes(input.toLowerCase())
                }
              />
              <Select
                value={newMetric}
                onChange={(v) => setNewMetric(v)}
                options={MASK_METRIC_OPTIONS}
                style={{ width: '24%' }}
              />
              <Input
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="备注（可选，例：备份机磁盘长期偏高）"
                style={{ width: '24%' }}
                maxLength={50}
                onPressEnter={addMask}
              />
              <Button type="primary" icon={<PlusOutlined />} onClick={addMask} title="添加屏蔽规则" />
            </Space.Compact>
            <Table
              rowKey={(r) => `${r.target}|${r.metric}`}
              size="small"
              columns={columns}
              dataSource={masks}
              pagination={false}
              locale={{ emptyText: '暂无屏蔽规则 —— 大屏展示全部超阈值主机' }}
            />
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
              提示：屏蔽只是「不在大屏面板里展示」，不影响采集与报表数据；
              想恢复展示，删掉对应规则保存即可。
            </Paragraph>
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card size="small" title="当前屏蔽概览" style={{ marginBottom: 12 }}>
            <Row gutter={[8, 8]}>
              <Col span={12}>
                <Statistic title="规则总数" value={masks.length} suffix="条" />
              </Col>
              <Col span={12}>
                <Statistic
                  title="大屏超阈值项"
                  value={issueCount ? issueCount.crit + issueCount.warn : 0}
                  suffix="项"
                  valueStyle={{ color: issueCount && issueCount.crit > 0 ? '#ef4444' : undefined }}
                />
              </Col>
            </Row>
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                按指标分布：
              </Text>
              <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {masks.length === 0 ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    —
                  </Text>
                ) : (
                  Object.keys(stat).map((k) => (
                    <Tag key={k} color={k === 'all' ? 'red' : 'geekblue'}>
                      {MASK_METRIC_CN[k] || k} × {stat[k]}
                    </Tag>
                  ))
                )}
              </div>
            </div>
            {issueCount && (
              <div style={{ marginTop: 12 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  当前快照：严重 {issueCount.crit} 项 · 关注 {issueCount.warn} 项（已扣除被屏蔽项）
                </Text>
              </div>
            )}
          </Card>

          <Card size="small" title="匹配示例">
            <Paragraph style={{ fontSize: 12, marginBottom: 6 }}>
              <code>10.207.147</code> → 屏蔽该网段所有主机的指定指标
            </Paragraph>
            <Paragraph style={{ fontSize: 12, marginBottom: 6 }}>
              <code>和创利OA</code> → 展示名（项目名_环境_业务环境）里含该关键字的主机
            </Paragraph>
            <Paragraph style={{ fontSize: 12, marginBottom: 0 }}>
              <code>disk</code> 指标单独屏蔽 → 只隐藏磁盘超阈值，CPU / 内存照常告警
            </Paragraph>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
