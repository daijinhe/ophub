import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Modal, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd'
import { ReloadOutlined, SyncOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { applyCalibration, calibrateAsset, type CalibItem, type CalibResult } from '../api/calibrate'

const { Text } = Typography

/** 需要校准的资产（最小信息集） */
export interface CalibTarget {
  id: number
  name?: string
  ip?: string
}

interface Props {
  target: CalibTarget | null
  open: boolean
  onClose: () => void
  /** 同步完成后回调（刷新资产列表） */
  onSynced?: () => void
}

/** 资源校准弹窗：SSH 直连目标机采集硬件规格 → 与导入值比对 → 勾选确认同步 */
export default function AssetCalibrate({ target, open, onClose, onSynced }: Props) {
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<CalibResult | null>(null)
  const [selected, setSelected] = useState<string[]>([])

  const run = useCallback(async (id: number) => {
    setLoading(true)
    setError('')
    setResult(null)
    setSelected([])
    try {
      const res = await calibrateAsset(id)
      setResult(res)
      // 默认勾选：与登记值不一致 且 实测值有效
      setSelected(res.items.filter((it) => it.diff && it.synced).map((it) => it.key))
    } catch (e: any) {
      setError(e?.response?.data?.msg || e?.message || '采集失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && target) {
      run(target.id)
    } else {
      setResult(null)
      setError('')
      setSelected([])
    }
  }, [open, target, run])

  const diffCount = useMemo(() => (result ? result.items.filter((i) => i.diff).length : 0), [result])

  const doApply = async () => {
    if (!target || !result) return
    const fields: Record<string, string> = {}
    result.items.forEach((it) => {
      if (selected.includes(it.key) && it.detected) fields[it.key] = it.detected
    })
    if (!Object.keys(fields).length) {
      message.warning('请至少勾选一项要同步的内容')
      return
    }
    setApplying(true)
    try {
      const res = await applyCalibration(target.id, fields)
      message.success(`已同步 ${res.synced?.length || Object.keys(fields).length} 项资产信息`)
      onSynced?.()
      onClose()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '同步失败')
    } finally {
      setApplying(false)
    }
  }

  const columns: ColumnsType<CalibItem> = [
    {
      title: '校准项',
      dataIndex: 'label',
      width: 132,
      render: (v: string) => <Text strong style={{ color: 'var(--text-strong)' }}>{v}</Text>,
    },
    {
      title: '导入信息',
      dataIndex: 'imported',
      width: 168,
      render: (v: string) => (v ? v : <Text type="secondary">未填写</Text>),
    },
    {
      title: '实测信息',
      dataIndex: 'detected',
      width: 268,
      render: (v: string, r) => {
        if (!v) {
          return <Text type="secondary">未采集到</Text>
        }
        return (
          <Space size={6} wrap>
            <Text strong style={{ color: r.diff ? '#f59e0b' : 'var(--text-strong)' }}>
              {v}
            </Text>
            {r.device && /^[a-z]/.test(r.device) && (
              <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px', opacity: 0.85 }}>
                {r.device}
              </Tag>
            )}
          </Space>
        )
      },
    },
    {
      title: '对比结果',
      key: 'status',
      width: 104,
      render: (_, r) => {
        if (!r.detected) return <Tag bordered={false} color="default">无法采集</Tag>
        if (!r.diff) return <Tag bordered={false} color="success">一致</Tag>
        if (r.same) {
          return (
            <Tooltip title="与登记信息为同一系统，仅书写方式不同；同步后按「ID+版本号」记录（如 almalinux8.9）">
              <Tag bordered={false} color="geekblue">写法不同</Tag>
            </Tooltip>
          )
        }
        return <Tag bordered={false} color="warning">不一致</Tag>
      },
    },
    {
      title: '说明',
      key: 'note',
      render: (_, r) => {
        const lines: string[] = []
        if (r.hint) lines.push(r.hint)
        if (r.std) lines.push(`平台识别：${r.std}`)
        if (r.raw && r.raw !== r.detected) lines.push(`实测原始值：${r.raw}`)
        if (!lines.length) {
          return <Text type="secondary" style={{ fontSize: 12 }}>{r.detected ? '与导入信息一致，无需同步' : '-'}</Text>
        }
        return (
          <div style={{ fontSize: 12 }}>
            {lines.map((t, i) => (
              <div key={i} style={{ color: i === 0 && r.hint ? undefined : 'var(--text-secondary)' }}>
                {t}
              </div>
            ))}
          </div>
        )
      },
    },
  ]

  const title = (
    <Space size={8} align="center">
      <ThunderboltOutlined style={{ color: '#38bdf8' }} />
      <span>资源校准</span>
      {target && (
        <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
          {target.name || `#${target.id}`}
        </Text>
      )}
    </Space>
  )

  const footer = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {result && !loading
          ? `共 ${result.items.length} 项，检出 ${diffCount} 项差异；未勾选的项不会被修改`
          : '校准过程只读取目标机信息，不会修改目标机'}
      </Text>
      <Space>
        <Button onClick={onClose}>关闭</Button>
        <Tooltip title="重新 SSH 采集一次">
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            disabled={!target}
            onClick={() => target && run(target.id)}
          >
            重新采集
          </Button>
        </Tooltip>
        <Button
          type="primary"
          icon={<SyncOutlined />}
          loading={applying}
          disabled={loading || !result || selected.length === 0}
          onClick={doApply}
        >
          同步选中（{selected.length}）
        </Button>
      </Space>
    </div>
  )

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={title}
      footer={footer}
      width={1020}
      centered
      destroyOnClose
      /* 防误触丢失：点遮罩、按 ESC 均不关闭，退出只能点底部按钮 */
      maskClosable={false}
      keyboard={false}
    >
      {loading && (
        <div style={{ padding: '56px 0', textAlign: 'center' }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>
            <Text type="secondary">
              正在 SSH 连接 {target?.ip || ''} 采集硬件信息（操作系统 / CPU / 内存 / 磁盘）…
            </Text>
          </div>
          <div style={{ marginTop: 6 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              目标机网络不通或凭据不正确时会自动失败，不会在目标机上留下任何文件
            </Text>
          </div>
        </div>
      )}

      {!loading && error && (
        <Alert
          type="error"
          showIcon
          message="采集失败"
          description={
            <div>
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{error}</div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                若提示连接超时/拒绝，通常是平台所在主机到该资产（{target?.ip}）的网络不通或 SSH 端口未放通；
                若提示认证失败，请检查资产「用户名 / 密码」字段。
              </Text>
            </div>
          }
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => target && run(target.id)}>
              重试
            </Button>
          }
        />
      )}

      {!loading && !error && result && (
        <>
          <Space size={8} wrap style={{ marginBottom: 12 }}>
            <Tag bordered={false} color="blue">SSH {result.ssh}</Tag>
            {result.zone && <Tag bordered={false}>网络区域 {result.zone}</Tag>}
            <Tag bordered={false} color={diffCount ? 'gold' : 'green'}>
              {diffCount ? `${diffCount} 项与导入信息不一致` : '全部一致'}
            </Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>耗时 {result.durationMs} ms</Text>
          </Space>

          {result.warning && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={result.warning} />
          )}
          {result.probeOutput && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="探测原始输出（用于排查）"
              description={
                <pre style={{ margin: 0, maxHeight: 160, overflow: 'auto', fontSize: 12 }}>
                  {result.probeOutput}
                </pre>
              }
            />
          )}

          <Table<CalibItem>
            rowKey="key"
            size="small"
            columns={columns}
            dataSource={result.items}
            pagination={false}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys as string[]),
              getCheckboxProps: (r) => ({ disabled: !r.synced || !r.detected }),
            }}
            locale={{ emptyText: '未采集到任何信息' }}
          />
        </>
      )}
    </Modal>
  )
}
