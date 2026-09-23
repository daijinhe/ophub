import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Button,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Descriptions,
} from 'antd'
import {
  HistoryOutlined,
  ReloadOutlined,
  FileSearchOutlined,
  RocketOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import {
  listDeployJobs,
  getDeployJob,
  rerunDeployJob,
  listDeployMiddlewares,
  listUsers,
  DeployJob,
  SimpleUser,
  DeployMiddleware,
} from '../api/deploy'
import { useAuth } from '../store/AuthContext'

const { Text, Paragraph } = Typography

const STATUS_META: Record<string, { color: string; text: string }> = {
  pending: { color: 'default', text: '待执行' },
  running: { color: 'processing', text: '执行中' },
  success: { color: 'success', text: '成功' },
  failed: { color: 'error', text: '失败' },
}

function statusTag(status: string) {
  const m = STATUS_META[status] || { color: 'default', text: status }
  return <Tag color={m.color}>{m.text}</Tag>
}

/** 从 Targets JSON 取出目标台数 */
function targetCount(targets: string): number {
  if (!targets) return 0
  try {
    const arr = JSON.parse(targets)
    return Array.isArray(arr) ? arr.length : 0
  } catch {
    return 0
  }
}

export default function DeployRecords() {
  const { message } = App.useApp()
  const { hasPerm } = useAuth()

  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<DeployJob[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [fMiddleware, setFMiddleware] = useState<string | undefined>()
  const [fStatus, setFStatus] = useState<string | undefined>()
  const [keyword, setKeyword] = useState('')

  const [mwMap, setMwMap] = useState<Record<string, string>>({})
  const [users, setUsers] = useState<SimpleUser[]>([])

  const [drawerId, setDrawerId] = useState<number | null>(null)
  const [detail, setDetail] = useState<DeployJob | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [rerunning, setRerunning] = useState(false)

  const userMap = useMemo(() => {
    const m: Record<number, string> = {}
    for (const u of users) m[u.id] = u.nickname || u.username
    return m
  }, [users])

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listDeployJobs({
        page,
        size,
        middleware: fMiddleware,
        status: fStatus,
      })
      let list = res.list
      if (keyword.trim()) {
        const kw = keyword.trim().toLowerCase()
        list = list.filter(
          (j) =>
            (j.middleware || '').toLowerCase().includes(kw) ||
            (j.version || '').toLowerCase().includes(kw) ||
            (j.certName || '').toLowerCase().includes(kw) ||
            String(j.id) === kw,
        )
      }
      setRows(list)
      setTotal(res.total)
    } catch (e: any) {
      message.error(e?.message || '加载执行记录失败')
    } finally {
      setLoading(false)
    }
  }, [page, size, fMiddleware, fStatus, keyword, message])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  useEffect(() => {
    listDeployMiddlewares()
      .then((list) => {
        const m: Record<string, string> = {}
        for (const it of list) m[it.name] = it.label || it.name
        setMwMap(m)
      })
      .catch(() => {})
    listUsers().then(setUsers).catch(() => {})
  }, [])

  // 抽屉：实时轮询执行日志（pending / running 时每 1.5s 拉取一次）
  useEffect(() => {
    if (drawerId == null) {
      setDetail(null)
      return
    }
    let alive = true
    let timer: any = null
    const load = async () => {
      try {
        const j = await getDeployJob(drawerId)
        if (!alive) return
        setDetail(j)
        if (j.status === 'pending' || j.status === 'running') {
          timer = setTimeout(load, 1500)
        }
      } catch (e: any) {
        if (alive) message.error(e?.message || '加载日志失败')
      }
    }
    setDetailLoading(true)
    load().finally(() => alive && setDetailLoading(false))
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [drawerId, message])

  const openDrawer = (id: number) => setDrawerId(id)

  const handleRerun = async (sourceId: number) => {
    setRerunning(true)
    try {
      const { jobId } = await rerunDeployJob(sourceId)
      message.success(`已重新运行，新任务 #${jobId}`)
      // 直接打开新任务的实时日志抽屉
      setDrawerId(jobId)
      // 列表刷新（新记录会排到最前）
      fetchList()
    } catch (e: any) {
      message.error(e?.message || '重新运行失败')
    } finally {
      setRerunning(false)
    }
  }

  const columns: ColumnsType<DeployJob> = [
    { title: 'ID', dataIndex: 'id', width: 70 },
    {
      title: '中间件',
      dataIndex: 'middleware',
      render: (_, r) => (
        <Space size={4} direction="vertical" style={{ lineHeight: 1.3 }}>
          <Text strong>{mwMap[r.middleware] || r.middleware}</Text>
          {r.version && <Text type="secondary" style={{ fontSize: 12 }}>v{r.version}</Text>}
        </Space>
      ),
    },
    {
      title: '模式',
      dataIndex: 'mode',
      width: 110,
      render: (v) => (v ? <Tag>{v}</Tag> : <Text type="secondary">—</Text>),
    },
    {
      title: '目标服务器',
      dataIndex: 'targets',
      width: 100,
      align: 'center',
      render: (v: string) => targetCount(v),
    },
    {
      title: '证书',
      render: (_, r) =>
        r.hasCert ? <Tag color="gold">{r.certName || '已启用'}</Tag> : <Text type="secondary">—</Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v) => statusTag(v),
    },
    {
      title: '操作人',
      dataIndex: 'createdBy',
      width: 110,
      render: (v: number) => userMap[v] || `ID:${v}`,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
    },
    {
      title: '完成时间',
      dataIndex: 'finishedAt',
      width: 170,
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: '操作',
      width: 170,
      fixed: 'right',
      render: (_, r) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<FileSearchOutlined />}
            onClick={() => openDrawer(r.id)}
          >
            日志
          </Button>
          {hasPerm('deploy:exec') && (
            <Button
              size="small"
              type="primary"
              ghost
              icon={<RocketOutlined />}
              loading={rerunning}
              onClick={() => handleRerun(r.id)}
            >
              重新运行
            </Button>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <HistoryOutlined style={{ fontSize: 22, color: 'var(--accent)' }} />
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            部署执行记录
          </Typography.Title>
          <Text type="secondary">
            每次中间件部署都会留痕，出问题可在此查看日志并一键重新运行。
          </Text>
        </div>
      </div>

      <div className="mw-cfg-toolbar" style={{ marginBottom: 14 }}>
        <Select
          allowClear
          placeholder="按中间件筛选"
          style={{ width: 200 }}
          value={fMiddleware}
          onChange={(v) => {
            setFMiddleware(v)
            setPage(1)
          }}
          options={Object.entries(mwMap).map(([name, label]) => ({ value: name, label }))}
        />
        <Select
          allowClear
          placeholder="按状态筛选"
          style={{ width: 150 }}
          value={fStatus}
          onChange={(v) => {
            setFStatus(v)
            setPage(1)
          }}
          options={[
            { value: 'pending', label: '待执行' },
            { value: 'running', label: '执行中' },
            { value: 'success', label: '成功' },
            { value: 'failed', label: '失败' },
          ]}
        />
        <Input.Search
          allowClear
          placeholder="搜索 ID / 中间件 / 版本 / 证书"
          style={{ width: 240 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={fetchList}>
          刷新
        </Button>
      </div>

      <Table<DeployJob>
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 1100 }}
        pagination={{
          current: page,
          pageSize: size,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, s) => {
            setPage(p)
            setSize(s)
          },
        }}
        locale={{ emptyText: <Empty description="暂无部署执行记录" /> }}
      />

      <Drawer
        title={
          <Space>
            <FileSearchOutlined />
            <span>部署执行记录 #{drawerId}</span>
            {detail && statusTag(detail.status)}
          </Space>
        }
        width={760}
        open={drawerId != null}
        onClose={() => setDrawerId(null)}
        extra={
          detail &&
          hasPerm('deploy:exec') && (
            <Button
              type="primary"
              icon={<RocketOutlined />}
              loading={rerunning}
              onClick={() => handleRerun(detail.id)}
            >
              重新运行
            </Button>
          )
        }
      >
        {detailLoading && !detail ? (
          <Text type="secondary">加载中…</Text>
        ) : detail ? (
          <>
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="中间件">
                {mwMap[detail.middleware] || detail.middleware} {detail.version && `v${detail.version}`}
              </Descriptions.Item>
              <Descriptions.Item label="模式">{detail.mode || '—'}</Descriptions.Item>
              <Descriptions.Item label="目标服务器">{targetCount(detail.targets)} 台</Descriptions.Item>
              <Descriptions.Item label="证书">
                {detail.hasCert ? detail.certName || '已启用' : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="操作人">
                {userMap[detail.createdBy] || `ID:${detail.createdBy}`}
              </Descriptions.Item>
              <Descriptions.Item label="创建时间">{detail.createdAt}</Descriptions.Item>
            </Descriptions>

            <Typography.Title level={5}>执行日志</Typography.Title>
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              任务进行中会自动刷新；日志为各网络区域 Ansible 执行输出。
            </Paragraph>
            <pre
              style={{
                background: 'var(--bg-code, #0b1021)',
                color: 'var(--text-code, #d6e2ff)',
                padding: 14,
                borderRadius: 8,
                maxHeight: 460,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                fontSize: 12.5,
                lineHeight: 1.6,
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
              }}
            >
              {detail.output || (detail.status === 'pending' ? '（等待执行…）' : '（无输出）')}
            </pre>
            {detail.errorMsg && (
              <pre
                style={{
                  background: 'rgba(255,77,79,0.08)',
                  color: '#ff7875',
                  padding: 12,
                  borderRadius: 8,
                  marginTop: 10,
                  maxHeight: 220,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  fontSize: 12.5,
                }}
              >
                错误信息：{detail.errorMsg}
              </pre>
            )}
          </>
        ) : (
          <Text type="secondary">未找到该记录</Text>
        )}
      </Drawer>
    </div>
  )
}
