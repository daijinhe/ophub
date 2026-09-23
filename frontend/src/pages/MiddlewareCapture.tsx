import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Input,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApiOutlined,
  CheckCircleOutlined,
  ClearOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  FileSearchOutlined,
  HddOutlined,
  ReloadOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import MwCaptureItemCard, { mwTypeShort } from '../components/MwCaptureItemCard'
import { useAuth } from '../store/AuthContext'
import {
  MW_CAPTURE_STATUS_TEXT,
  MW_CAPTURE_TYPES,
  deleteMwCapture,
  downloadBlob,
  exportMwCaptures,
  getMwCapture,
  listMwCaptureAssets,
  runMwCapture,
  type MwCaptureAssetItem,
  type MwCaptureDetail,
  type MwCaptureItem,
} from '../api/mwcapture'

const { Text } = Typography

// 单批捕捉的资产台数：单批最坏耗时 = 上限(100s) × 批内台数 / 并发(4)，
// 分批既能给出进度反馈，也能把单次 HTTP 请求时长控制在可接受范围。
const CAPTURE_CHUNK = 6

export default function MiddlewareCapture() {
  const { message, modal } = App.useApp()
  const { hasPerm } = useAuth()

  const [assets, setAssets] = useState<MwCaptureAssetItem[]>([])
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [zone, setZone] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<number[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [view, setView] = useState<'asset' | 'summary'>('asset')

  const [detail, setDetail] = useState<MwCaptureDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [exporting, setExporting] = useState(false)

  const load = useCallback(
    async (keepActive = false) => {
      setLoading(true)
      try {
        const { data } = await listMwCaptureAssets()
        const list = data.data?.list || []
        setAssets(list)
        if (!keepActive) {
          const first =
            list.find((a) => a.capture && a.capture.status !== 'failed') || list[0] || null
          setActiveId(first ? first.assetId : null)
        }
      } catch (e: any) {
        message.error(e?.response?.data?.msg || '加载资产列表失败')
      } finally {
        setLoading(false)
      }
    },
    [message],
  )

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 拉取当前选中资产的捕捉结果
  const loadDetail = useCallback(
    async (assetId: number) => {
      setDetailLoading(true)
      try {
        const { data } = await getMwCapture(assetId)
        setDetail(data.data || null)
      } catch (e: any) {
        message.error(e?.response?.data?.msg || '读取捕捉结果失败')
        setDetail(null)
      } finally {
        setDetailLoading(false)
      }
    },
    [message],
  )

  useEffect(() => {
    if (activeId == null) {
      setDetail(null)
      return
    }
    void loadDetail(activeId)
  }, [activeId, loadDetail])

  const filtered = useMemo(
    () =>
      assets.filter((a) => {
        if (zone && a.zone !== zone) return false
        if (!keyword.trim()) return true
        const kw = keyword.trim().toLowerCase()
        return [a.assetName, a.vmName, a.ip, a.zone, (a.capture?.mwTypes || []).join(' ')]
          .join(' ')
          .toLowerCase()
          .includes(kw)
      }),
    [assets, keyword, zone],
  )

  const stats = useMemo(() => {
    const captured = assets.filter((a) => a.capture && a.capture.status !== 'failed')
    const withMw = assets.filter((a) => (a.capture?.mwTypes || []).length > 0)
    const failed = assets.filter((a) => a.capture?.status === 'failed')
    return { total: assets.length, captured: captured.length, withMw: withMw.length, failed: failed.length }
  }, [assets])

  const zones = useMemo(
    () => Array.from(new Set(assets.map((a) => a.zone).filter(Boolean))),
    [assets],
  )

  const doCapture = async (ids: number[]) => {
    if (!ids.length) {
      message.warning('请先勾选要捕捉的资产')
      return
    }
    setRunning(true)
    let ok = 0
    let fail = 0
    try {
      for (let i = 0; i < ids.length; i += CAPTURE_CHUNK) {
        const batch = ids.slice(i, i + CAPTURE_CHUNK)
        setProgress(`正在捕捉 ${Math.min(i + batch.length, ids.length)}/${ids.length} 台…`)
        const { data } = await runMwCapture(batch)
        ok += data.data?.okCount ?? 0
        fail += data.data?.errorCount ?? 0
        setProgress(
          `已完成 ${Math.min(i + batch.length, ids.length)}/${ids.length} 台（成功 ${ok} · 失败 ${fail}）`,
        )
      }
      message.success(`捕捉完成：成功 ${ok} 台${fail ? `，失败 ${fail} 台` : ''}`)
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '捕捉失败（可减少勾选台数后重试）')
    } finally {
      setProgress('')
      setRunning(false)
      await load(true)
      if (activeId != null) await loadDetail(activeId)
    }
  }

  // 捕捉 = 用目标机的实时扫描结果覆盖平台已登记的中间件信息（本次命中的类型条目会被刷新），
  // 因此「重新捕捉」一律二次确认；批量捕捉只在目标里已存在捕捉结果时才确认，
  // 首次捕捉没有信息可覆盖，不打扰。
  const askCapture = (ids: number[], force: boolean) => {
    if (!ids.length) {
      message.warning('请先勾选要捕捉的资产')
      return
    }
    const targets = assets.filter((a) => ids.includes(a.assetId))
    const done = targets.filter((a) => !!a.capture?.capturedAt)
    if (!force && !done.length) {
      void doCapture(ids)
      return
    }
    const one = force ? targets[0] : undefined
    modal.confirm({
      title: force ? '确认重新捕捉？' : `确认重新捕捉选中的 ${ids.length} 台资产？`,
      icon: <ThunderboltOutlined style={{ color: '#1677ff' }} />,
      width: 560,
      okText: force ? '确认重新捕捉' : '确认捕捉',
      cancelText: '取消',
      content: (
        <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.9 }}>
          {one ? (
            <div style={{ marginBottom: 8 }}>
              将重新扫描 <Text strong>{one.assetName}</Text>
              {one.ip ? <Text type="secondary">（{one.ip}）</Text> : null}
              ，并用最新结果覆盖这台机器已登记的中间件信息。
            </div>
          ) : (
            <div style={{ marginBottom: 8 }}>
              将重新扫描选中的 <Text strong>{ids.length}</Text> 台资产
              {done.length ? (
                <>
                  ，其中 <Text strong>{done.length}</Text> 台已有捕捉结果，会被本次结果更新覆盖
                </>
              ) : null}
              。
            </div>
          )}
          {one?.capture?.capturedAt ? (
            <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
              上次捕捉：{one.capture.capturedAt}
              {one.capture.count ? ` · 已登记 ${one.capture.count} 个中间件条目` : ''}
            </div>
          ) : null}
          <ul
            style={{
              margin: '0 0 10px',
              paddingInlineStart: 20,
              color: 'var(--text-secondary)',
            }}
          >
            <li>
              本次扫描命中的中间件条目（端口 / 版本 / 路径 / 证书等）会被
              <Text strong>覆盖为最新值</Text>，手工订正过的内容不再保留
            </li>
            <li>
              手工添加的类型条目与「自定义字段」<Text strong>会保留</Text>，不会被洗掉
            </li>
            <li>
              本次扫描失败或未发现中间件时，<Text strong>不会删除</Text>已有条目
            </li>
          </ul>
        </div>
      ),
      onOk: () => doCapture(ids),
    })
  }

  const doExport = async () => {
    setExporting(true)
    try {
      const ids = selected.length ? selected : undefined
      const resp = await exportMwCaptures(ids)
      downloadBlob(resp.data as BlobPart, `中间件捕捉_${new Date().toISOString().slice(0, 10)}.xlsx`)
      message.success('已导出 Excel')
    } catch {
      message.error('导出失败')
    } finally {
      setExporting(false)
    }
  }

  const activeAsset = assets.find((a) => a.assetId === activeId) || null
  const items = detail?.items || []
  const missing = MW_CAPTURE_TYPES.filter((t) => !items.some((i) => i.type === t.type))

  const summaryRows = useMemo(() => {
    const rows: {
      key: string
      assetId: number
      assetName: string
      host: string
      mw: string
      status: string
      version: string
      ports: string
      install: string
      config: string
      logs: string
      code: string
      certs: string
      capturedAt: string
    }[] = []
    for (const a of assets) {
      if (!a.capture) continue
      rows.push({
        key: `a${a.assetId}`,
        assetId: a.assetId,
        assetName: a.assetName,
        host: a.ip,
        mw: a.capture.mwTypes.map(mwTypeShort).join(', ') || '—',
        status: MW_CAPTURE_STATUS_TEXT[a.capture.status] || a.capture.status,
        version: '',
        ports: '',
        install: '',
        config: '',
        logs: '',
        code: '',
        certs: '',
        capturedAt: a.capture.capturedAt,
      })
    }
    return rows
  }, [assets])

  const summaryColumns: ColumnsType<(typeof summaryRows)[number]> = [
    {
      title: '资产',
      dataIndex: 'assetName',
      key: 'assetName',
      ellipsis: true,
      render: (v, r) => (
        <a onClick={() => { setView('asset'); setActiveId(r.assetId) }} title={v}>
          {v}
        </a>
      ),
    },
    { title: '虚拟机IPv4', dataIndex: 'host', key: 'host', width: 140 },
    {
      title: '中间件',
      dataIndex: 'mw',
      key: 'mw',
      width: 200,
      render: (v: string) =>
        v === '—' ? (
          <Text type="secondary">—</Text>
        ) : (
          <Space size={4} wrap>
            {v.split(', ').map((s) => (
              <Tag key={s} color="blue">
                {s}
              </Tag>
            ))}
          </Space>
        ),
    },
    { title: '状态', dataIndex: 'status', key: 'status', width: 140 },
    { title: '最近捕捉', dataIndex: 'capturedAt', key: 'capturedAt', width: 170 },
  ]

  return (
    <div className="mo-page">
      {/* 概览 */}
      <div className="mw-section">
        <div className="mwc-stats">
          {[
            { label: '资产总数', value: stats.total, color: 'var(--accent)', icon: <HddOutlined /> },
            { label: '已捕捉', value: stats.captured, color: 'var(--ok, #16a34a)', icon: <CheckCircleOutlined /> },
            { label: '发现中间件', value: stats.withMw, color: 'var(--accent2)', icon: <ApiOutlined /> },
            { label: '捕捉失败', value: stats.failed, color: 'var(--danger, #dc2626)', icon: <ExclamationCircleOutlined /> },
          ].map((c) => (
            <div className="glass mw-stat mo-stat" key={c.label}>
              <span className="mo-stat__icon" style={{ color: c.color }}>
                {c.icon}
              </span>
              <div>
                <div className="mw-stat__n" style={{ color: c.color }}>
                  {c.value}
                </div>
                <div className="mw-stat__l">{c.label}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <section className="mw-section">
        <div className="mw-section-title">
          <span className="mw-section-idx">
            <FileSearchOutlined />
          </span>
          <span className="mw-section-h">中间件捕捉</span>
          <span className="mw-section-d">
            直连目标机只读扫描（不写目标机任何文件），捕捉 nginx / php-fpm / Java / Redis / 宝兰德 BWS310
            的版本、端口、安装位置、配置文件、日志、代码路径与证书；结果落库并同步到资产详情与列表
          </span>
        </div>

        <div className="glass mw-panel mwc-toolbar">
          <Space wrap size={8}>
            {hasPerm('mwcapture:create') && (
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={running}
                onClick={() => askCapture(selected.length ? selected : filtered.map((a) => a.assetId), false)}
              >
                {selected.length ? `开始捕捉（${selected.length} 台）` : `捕捉当前列表（${filtered.length} 台）`}
              </Button>
            )}
            {hasPerm('mwcapture:create') && (
              <Button
                icon={<ReloadOutlined />}
                disabled={running || activeId == null}
                title={activeId == null ? '请先在左侧选择一台资产' : undefined}
                onClick={() => askCapture(activeId != null ? [activeId] : [], true)}
              >
                重新捕捉
              </Button>
            )}
            <Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void doExport()}>
              {selected.length ? `导出选中（${selected.length}）` : '导出全部'}
            </Button>
            <Segmented
              value={view}
              onChange={(v) => setView(v as 'asset' | 'summary')}
              options={[
                { label: '按资产查看', value: 'asset' },
                { label: '汇总列表', value: 'summary' },
              ]}
            />
            {!hasPerm('mwcapture:create') && (
              <Text type="secondary">
                当前账号没有「执行中间件捕捉」权限，只能查看已有结果
              </Text>
            )}
            {running && progress && (
              <Text type="secondary">
                <Spin size="small" style={{ marginInlineEnd: 6 }} />
                {progress}
              </Text>
            )}
          </Space>
        </div>

        {view === 'summary' ? (
          <div className="glass mw-panel" style={{ marginTop: 12 }}>
            <Table
              rowKey="key"
              size="small"
              loading={loading}
              dataSource={summaryRows}
              columns={summaryColumns}
              pagination={false}
              locale={{ emptyText: <Empty description="还没有捕捉结果，先勾选资产执行捕捉" /> }}
            />
          </div>
        ) : (
          <div className="mwc-grid">
            {/* 左：资产列表 */}
            <div className="glass mw-panel mwc-side">
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Input
                  allowClear
                  prefix={<SearchOutlined />}
                  placeholder="搜索资产名 / IP / 中间件"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
                <Select
                  allowClear
                  placeholder="按网络区域筛选"
                  style={{ width: '100%' }}
                  value={zone}
                  onChange={setZone}
                  options={zones.map((z) => ({ label: z, value: z }))}
                />
                <Space size={4} wrap>
                  <Button
                    size="small"
                    onClick={() => setSelected(filtered.map((a) => a.assetId))}
                  >
                    全选
                  </Button>
                  <Button
                    size="small"
                    onClick={() =>
                      setSelected(filtered.filter((a) => !selected.includes(a.assetId)).map((a) => a.assetId))
                    }
                  >
                    反选
                  </Button>
                  <Button size="small" icon={<ClearOutlined />} onClick={() => setSelected([])}>
                    清空
                  </Button>
                </Space>
                <div className="mwc-list">
                  {loading ? (
                    <div style={{ textAlign: 'center', padding: 24 }}>
                      <Spin />
                    </div>
                  ) : filtered.length === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的资产" />
                  ) : (
                    filtered.map((a) => {
                      const c = a.capture
                      const checked = selected.includes(a.assetId)
                      return (
                        <div
                          key={a.assetId}
                          className={'mwc-item' + (a.assetId === activeId ? ' mwc-item--active' : '')}
                          onClick={() => setActiveId(a.assetId)}
                        >
                          <Checkbox
                            checked={checked}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) =>
                              setSelected(
                                e.target.checked
                                  ? [...selected, a.assetId]
                                  : selected.filter((x) => x !== a.assetId),
                              )
                            }
                          />
                          <div className="mwc-item__body">
                            <div className="mwc-item__name" title={a.assetName}>
                              {a.assetName}
                            </div>
                            <div className="mwc-item__meta">
                              <span>{a.ip || '未填 IP'}</span>
                              {a.zone ? <span>· {a.zone}</span> : null}
                            </div>
                            <div className="mwc-item__tags">
                              {!a.ready ? (
                                <Tooltip title={a.reason || '缺少 SSH 连接信息'}>
                                  <Tag color="orange">连接信息缺失</Tag>
                                </Tooltip>
                              ) : !c ? (
                                <Tag>未捕捉</Tag>
                              ) : (
                                <>
                                  {(c.mwTypes || []).map((t) => (
                                    <Tag key={t} color="blue">
                                      {mwTypeShort(t)}
                                    </Tag>
                                  ))}
                                  {c.status === 'failed' ? (
                                    <Tooltip title={c.error}>
                                      <Tag color="red">失败</Tag>
                                    </Tooltip>
                                  ) : c.status === 'none' ? (
                                    <Tag>无中间件</Tag>
                                  ) : c.status === 'partial' ? (
                                    <Tooltip title="未取得 root 权限，部分信息可能缺失">
                                      <Tag color="orange">信息不全</Tag>
                                    </Tooltip>
                                  ) : (c.mwTypes || []).length === 0 ? (
                                    <Tag>{MW_CAPTURE_STATUS_TEXT[c.status] || c.status}</Tag>
                                  ) : null}
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </Space>
            </div>

            {/* 右：选中资产的捕捉结果 */}
            <div className="glass mw-panel mwc-main">
              {!activeAsset ? (
                <Empty description="请选择左侧资产" />
              ) : detailLoading ? (
                <div style={{ textAlign: 'center', padding: 40 }}>
                  <Spin />
                </div>
              ) : (
                <>
                  <div className="mwc-main__head">
                    <div>
                      <div className="mwc-main__title">{activeAsset.assetName}</div>
                      <div className="mwc-item__meta">
                        <span>{activeAsset.ip}</span>
                        {activeAsset.zone ? <span>· {activeAsset.zone}</span> : null}
                        {activeAsset.sshUser ? (
                          <span>
                            · SSH {activeAsset.sshUser}@{activeAsset.sshHost || activeAsset.ip}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <Space size={8} wrap>
                      {detail?.exists ? (
                        <>
                          <Tag color={detail.status === 'failed' ? 'red' : detail.status === 'partial' ? 'orange' : 'green'}>
                            {MW_CAPTURE_STATUS_TEXT[detail.status || ''] || detail.status}
                          </Tag>
                          {detail.privileged ? (
                            <Tag color="cyan">root 权限</Tag>
                          ) : (
                            <Tooltip title="未取得 root 权限，配置文件 / 端口归属等信息可能读取不全">
                              <Tag color="orange">未提权</Tag>
                            </Tooltip>
                          )}
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {detail.capturedAt}
                            {detail.capturedBy ? ` · ${detail.capturedBy}` : ''}
                            {detail.durationMs ? ` · ${(detail.durationMs / 1000).toFixed(1)}s` : ''}
                          </Text>
                          {hasPerm('mwcapture:delete') && (
                            <Tooltip title="仅删除平台记录，不影响目标机">
                              <Button
                                size="small"
                                danger
                                onClick={async () => {
                                  await deleteMwCapture(activeAsset.assetId)
                                  message.success('已清除该资产的捕捉结果')
                                  await load(true)
                                  await loadDetail(activeAsset.assetId)
                                }}
                              >
                                清除结果
                              </Button>
                            </Tooltip>
                          )}
                        </>
                      ) : null}
                    </Space>
                  </div>

                  {!detail?.exists ? (
                    <Empty
                      description={
                        activeAsset.ready
                          ? '该资产还没有捕捉过，点上方「重新捕捉」开始'
                          : `无法捕捉：${activeAsset.reason || '缺少 SSH 连接信息'}`
                      }
                    />
                  ) : items.length === 0 ? (
                    <Alert
                      type={detail.status === 'failed' ? 'error' : 'info'}
                      showIcon
                      message={
                        detail.status === 'failed'
                          ? '捕捉失败'
                          : '该机器上未发现 nginx / php-fpm / Java / Redis / 宝兰德 BWS310'
                      }
                      description={detail.error || undefined}
                    />
                  ) : (
                    <>
                      <Space size={6} wrap style={{ marginBottom: 10 }}>
                        {items.map((i) => (
                          <Tag key={i.type} color={i.running ? 'green' : 'default'}>
                            {i.label}
                            {i.version ? ` ${i.version}` : ''}
                          </Tag>
                        ))}
                        {missing.length > 0 && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            未发现：{missing.map((m) => m.short).join('、')}
                          </Text>
                        )}
                      </Space>
                      <div className="mwc-cards">
                        {items.map((i) => (
                          <MwCaptureItemCard key={i.type} item={i} />
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
