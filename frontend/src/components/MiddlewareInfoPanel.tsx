import { useEffect, useState, type ReactNode } from 'react'
import { App, Alert, Button, Select, Space, Tag, Tooltip, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons'
import {
  getMwCapture,
  MW_CAPTURE_TYPES,
  MW_CAPTURE_STATUS_TEXT,
  runMwCapture,
  updateMwCapture,
  type MwCaptureItem,
  type MwKv,
} from '../api/mwcapture'
import MwCaptureItemCard, { EditableKv, mwStatusColor } from './MwCaptureItemCard'

// ---------------------------------------------------------------------------
// 资产详情 ·「中间件和数据库信息」分组里的「中间件捕捉」区块。
//
// 这里把之前独立的「中间件捕捉信息」分组并入既有的「04 中间件和数据库信息」组，
// 与 CMDB 原有的「中间件」字段（第 7 类，手工维护）同处一组，实现：
//   - 一键捕捉 / 重新捕捉（只读扫描，mwcapture:manage）
//   - 捕捉后**就地编辑**任意字段（端口、安装位置、代码路径、证书…）
//   - **手工添加**一台中间件（包括扫描器不覆盖的类型，如 mysql）
//   - **自定义字段**：用户可自由增删键值（如「负责人」「备注」「连接串」）
//   - 保存即落库（PUT /mwcapture/asset/:id），与捕捉数据合并展示
// ---------------------------------------------------------------------------

const { Text } = Typography

/**
 * 从后端 rec.Error 里抽出「详细原因」段。
 *
 * 后端约定：探测失败原因用 "【详细原因】…" 作前缀。
 * 没有就原样返回空串。
 */
function extractPrivHint(err?: string): string {
  if (!err) return ''
  const idx = err.indexOf('【详细原因】')
  if (idx < 0) return ''
  return err.slice(idx + '【详细原因】'.length).trim()
}

function blankItem(type: string): MwCaptureItem {
  const t = MW_CAPTURE_TYPES.find((x) => x.type === type)
  return { type, label: t?.label || type, running: false }
}

export default function MiddlewareInfoPanel({
  assetId,
  canManage,
  onChanged,
  onDirtyChange,
  readOnlyTip,
}: {
  assetId: number
  canManage: boolean
  onChanged?: () => void
  /** 未落库的本地编辑状态向上汇报（详情退出编辑模式前据此提醒） */
  onDirtyChange?: (dirty: boolean) => void
  /** 只读时的说明文案（详情未点「编辑」时与「无权限」是两回事） */
  readOnlyTip?: ReactNode
}) {
  const { message, modal } = App.useApp()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  // 是否存在尚未落库的本地编辑（重新捕捉会重新拉取数据，这些修改会丢失）
  const [dirty, setDirty] = useState(false)
  const [detail, setDetail] = useState<{
    exists: boolean
    status?: string
    capturedAt?: string
    capturedBy?: string
    host?: string
    privileged?: boolean
    error?: string
  } | null>(null)
  const [items, setItems] = useState<MwCaptureItem[]>([])
  const [customFields, setCustomFields] = useState<MwKv[]>([])

  const load = async () => {
    setLoading(true)
    try {
      const { data } = await getMwCapture(assetId)
      const d = data.data
      if (d?.exists) {
        setDetail({
          exists: true,
          status: d.status,
          capturedAt: d.capturedAt,
          capturedBy: d.capturedBy,
          host: d.host,
          privileged: d.privileged,
          error: d.error,
        })
        setItems(d.items || [])
        setCustomFields(d.customFields || [])
        setDirty(false)
      } else {
        setDetail({ exists: false })
        setItems([])
        setCustomFields([])
        setDirty(false)
      }
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '读取中间件捕捉信息失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId])

  // 本地编辑状态向上汇报：详情要退出编辑模式时据此提醒「未保存的修改会丢失」
  useEffect(() => {
    onDirtyChange?.(dirty)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty])

  const doRecapture = async () => {
    setRunning(true)
    try {
      await runMwCapture([assetId])
      await load()
      message.success('已重新捕捉')
      onChanged?.()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '重新捕捉失败')
    } finally {
      setRunning(false)
    }
  }

  // 重新捕捉会覆盖本资产已登记的中间件信息（本次扫描命中的类型条目按最新结果刷新），
  // 所以必须先确认；首次捕捉（尚未捕捉过）没有信息可覆盖，直接执行不打扰。
  const recapture = () => {
    if (!detail?.exists) {
      void doRecapture()
      return
    }
    modal.confirm({
      title: '确认重新捕捉？',
      icon: <ThunderboltOutlined style={{ color: '#1677ff' }} />,
      width: 560,
      okText: '确认重新捕捉',
      cancelText: '取消',
      content: (
        <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.9 }}>
          <div style={{ marginBottom: 8 }}>
            将重新扫描 <Text strong>{detail.host || '目标机'}</Text>
            ，并用最新结果覆盖本资产已登记的中间件信息。
          </div>
          {detail.capturedAt ? (
            <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
              上次捕捉：{detail.capturedAt}
              {detail.capturedBy ? ` · ${detail.capturedBy}` : ''}
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
          {dirty ? (
            <Alert
              type="warning"
              showIcon
              message="当前有未保存的修改"
              description="重新捕捉会重新拉取数据，未保存的修改将丢失。建议先点「保存」。"
            />
          ) : null}
        </div>
      ),
      onOk: () => doRecapture(),
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      const cleanItems = items
        .map((it) => ({ ...it, notes: it.notes?.filter(Boolean) || [] }))
      const cleanCustom = customFields.filter((k) => k.key.trim() && k.value.trim())
      await updateMwCapture(assetId, { items: cleanItems, customFields: cleanCustom })
      message.success('已保存')
      await load()
      onChanged?.()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const addMiddleware = (type: string) => {
    setItems((prev) => [...prev, blankItem(type)])
    setDirty(true)
  }

  if (loading) {
    return <div className="mwc-panel__empty">正在读取中间件捕捉信息…</div>
  }

  const dirtyCount = items.length + customFields.filter((k) => k.key.trim()).length

  return (
    <div className="mwc-panel">
      <div className="mwc-panel__bar">
        <Space size={14} wrap style={{ fontSize: 12.5 }}>
          {detail?.exists ? (
            <>
              <span>
                <span style={{ color: 'var(--text-secondary)' }}>状态：</span>
                <b style={{ color: mwStatusColor(detail.status) }}>
                  {MW_CAPTURE_STATUS_TEXT[detail.status || ''] || detail.status}
                </b>
              </span>
              {detail.capturedAt ? (
                <span style={{ color: 'var(--text-secondary)' }}>
                  捕捉于 {detail.capturedAt}
                  {detail.capturedBy ? ` · ${detail.capturedBy}` : ''}
                </span>
              ) : null}
              {detail.host ? (
                <span>
                  <span style={{ color: 'var(--text-secondary)' }}>目标机：</span>
                  {detail.host}
                </span>
              ) : null}
              {detail.privileged ? (
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                  已提权
                </Tag>
              ) : (
                <Tooltip
                  title={
                    extractPrivHint(detail.error) ||
                    '未取得 root 权限，nginx/redis 等系统级中间件的路径与配置无法读取'
                  }
                >
                  <Tag color="orange" style={{ marginInlineEnd: 0, cursor: 'help' }}>
                    未提权
                  </Tag>
                </Tooltip>
              )}
            </>
          ) : (
            <span style={{ color: 'var(--text-secondary)' }}>尚未捕捉</span>
          )}
        </Space>
        {canManage && (
          <Space size={8}>
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              loading={running}
              onClick={recapture}
            >
              {detail?.exists ? '重新捕捉' : '立即捕捉'}
            </Button>
          </Space>
        )}
      </div>

      {detail?.exists && detail.status === 'none' && !items.length ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="未发现目标中间件"
          description={detail.error || '这台机器上没有捕捉到 nginx / php-fpm / java / redis / 宝兰德 BWS310 / Tomcat。'}
        />
      ) : null}
      {detail?.exists && detail.status === 'failed' && !items.length ? (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message="捕捉失败" description={detail.error} />
      ) : null}

      {/* 已捕捉 / 手工添加的中间件条目 */}
      <div className="mwc-section-title">中间件条目（{items.length}）</div>
      {items.length ? (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {items.map((it, idx) => (
            <MwCaptureItemCard
              key={`${it.type}-${idx}`}
              item={it}
              editable={canManage}
              onChange={(next: MwCaptureItem) => {
                setItems((prev) => prev.map((x, i) => (i === idx ? next : x)))
                setDirty(true)
              }}
              onRemove={
                canManage
                  ? () => {
                      setItems((prev) => prev.filter((_, i) => i !== idx))
                      setDirty(true)
                    }
                  : undefined
              }
            />
          ))}
        </Space>
      ) : (
        <div className="mwc-panel__empty" style={{ padding: '10px 0' }}>
          {canManage
            ? '暂无中间件条目。可点下方「添加中间件」手工登记，或先「立即捕捉」。'
            : '暂无中间件条目。'}
        </div>
      )}

      {canManage && (
        <Space wrap style={{ marginTop: 12 }}>
          <Select
            size="small"
            placeholder="添加中间件…"
            style={{ width: 200 }}
            options={MW_CAPTURE_TYPES.map((t) => ({ value: t.type, label: t.label }))}
            onChange={(v: string) => addMiddleware(v)}
            suffixIcon={<PlusOutlined />}
          />
        </Space>
      )}

      {/* 自定义字段 */}
      <div className="mwc-section-title" style={{ marginTop: 18 }}>
        自定义字段（{customFields.filter((k) => k.key.trim()).length}）
      </div>
      <EditableKv
        value={customFields}
        readOnly={!canManage}
        onChange={(v: MwKv[]) => {
          setCustomFields(v)
          setDirty(true)
        }}
        keyPlaceholder="字段名（如 负责人 / 备注 / 连接串）"
        valPlaceholder="字段值"
      />

      {canManage && (
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              共 {dirtyCount} 项待保存
            </Text>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
              保存
            </Button>
          </Space>
        </div>
      )}
      {!canManage && (
        <div style={{ marginTop: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {readOnlyTip || '当前账号无编辑权限，仅展示。'}
          </Text>
        </div>
      )}
    </div>
  )
}
