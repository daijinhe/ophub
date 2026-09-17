import { App, Badge, Button, Input, Space, Tag, Typography } from 'antd'
import { DeleteOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { MW_CAPTURE_TYPES, type MwCaptureItem, type MwCodePath, type MwJavaApp, type MwKv } from '../api/mwcapture'

// ---------------------------------------------------------------------------
// 中间件捕捉结果卡片 —— 「中间件捕捉」页（只读）与「资产详情 · 中间件和数据库信息」
// 分组（可编辑）共用。
//
// 本文件是「每类中间件展示哪些字段、按什么顺序、用什么中文标签」的唯一口径
// （严格对齐需求里逐项列出的字段与顺序），两处都从这里取，禁止再各自拼一套。
// 样式类 `.mwc-*` 定义在全局样式里，CMDB 详情分组直接复用。
// ---------------------------------------------------------------------------

const { Text } = Typography

/** 各类中间件的展示字段与中文标签 */
export const MW_TYPE_FIELDS: Record<string, { key: string; label: string }[]> = {
  nginx: [
    { key: 'version', label: '版本号' },
    { key: 'ports', label: '端口' },
    { key: 'installPath', label: '安装位置' },
    { key: 'configPaths', label: '配置文件位置' },
    { key: 'logPaths', label: '日志路径' },
    { key: 'codePaths', label: '代码路径' },
    { key: 'certs', label: '证书路径' },
  ],
  php: [
    { key: 'version', label: '版本号' },
    { key: 'installPath', label: '安装位置' },
    { key: 'configPaths', label: '配置文件位置' },
  ],
  java: [{ key: 'version', label: 'JVM 版本' }],
  // 2026-09-17 用户要求：去掉「配置文件位置 / 日志路径 / 存储位置」，改为登记 Redis 密码
  redis: [
    { key: 'version', label: '版本号' },
    { key: 'ports', label: '端口号' },
    { key: 'installPath', label: '安装位置' },
    { key: 'password', label: '密码' },
  ],
  // 2026-09-17 用户新增：ElasticSearch（版本 / 端口 / 安装目录 / 访问地址 / 账号 / 密码 / 备注）
  // 探测拿不到的字段（账号、密码、访问地址含主机 IP 部分）一律留空让用户编辑模式手动补
  es: [
    { key: 'version', label: '版本' },
    { key: 'ports', label: '端口' },
    { key: 'installPath', label: '安装目录' },
    { key: 'accessUrl', label: '访问地址' },
    { key: 'username', label: '账号' },
    { key: 'password', label: '密码' },
  ],
  bws310: [
    { key: 'version', label: '版本号' },
    { key: 'ports', label: '端口' },
    { key: 'installPath', label: '安装位置' },
    { key: 'configPaths', label: '配置文件位置' },
    { key: 'logPaths', label: '日志路径' },
    { key: 'codePaths', label: '代码路径' },
    { key: 'certs', label: '证书路径' },
  ],
  tomcat: [
    { key: 'version', label: '版本号' },
    { key: 'ports', label: '端口' },
    { key: 'installPath', label: '安装位置' },
    { key: 'codePaths', label: '代码路径' },
  ],
}

/** 类型码 → 展示名（如 Nginx / 宝兰德 BWS310 / Tomcat） */
export const mwTypeLabel = (type: string) =>
  MW_CAPTURE_TYPES.find((t) => t.type === type)?.label || type

/** 类型码 → 短名（列表标签用，如 nginx / java / tomcat） */
export const mwTypeShort = (type: string) =>
  MW_CAPTURE_TYPES.find((t) => t.type === type)?.short || type

/** 捕捉状态 → 文字色 */
export function mwStatusColor(status?: string) {
  switch (status) {
    case 'ok':
      return 'var(--ok, #16a34a)'
    case 'partial':
      return 'var(--warn, #d97706)'
    case 'failed':
      return 'var(--danger, #dc2626)'
    default:
      return 'var(--text-secondary)'
  }
}

/** 双击复制（与 CMDB 详情一致的操作习惯） */
function Copyable({ text, children }: { text: string; children?: React.ReactNode }) {
  const { message } = App.useApp()
  if (!text) return <span className="empty-val">—</span>
  return (
    <span
      className="copy-val"
      title="双击复制"
      style={{ cursor: 'copy' }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        navigator.clipboard
          .writeText(text)
          .then(() => message.success('已复制'))
          .catch(() => message.warning('复制失败'))
      }}
    >
      {children ?? text}
    </span>
  )
}

/** 多行值渲染（一个元素一行） */
function MultiLines({ lines, mono = true, tone }: { lines: string[]; mono?: boolean; tone?: string }) {
  if (!lines.length) return <span className="empty-val">—</span>
  return (
    <div className="mwc-lines">
      {lines.map((l, i) => (
        <div key={i} className={mono ? 'mwc-mono' : undefined} style={tone ? { color: tone } : undefined}>
          <Copyable text={l} />
        </div>
      ))}
    </div>
  )
}

/** 可编辑的字符串列表（配置文件 / 日志 / 证书路径等） */
function EditableList({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  mono?: boolean
}) {
  const list = value && value.length ? value : ['']
  return (
    <div className="mwc-lines">
      {list.map((v, i) => (
        <div key={i} className="mwc-edit-row">
          <Input
            size="small"
            value={v}
            placeholder={placeholder}
            className={mono ? 'mwc-mono' : undefined}
            onChange={(e) => {
              const next = [...list]
              next[i] = e.target.value
              onChange(next.map((x) => x.trim()).filter((x, idx, arr) => x !== '' || idx === arr.length - 1))
            }}
            onBlur={() => onChange(list.map((x) => x.trim()).filter(Boolean))}
          />
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => onChange(list.filter((_, idx) => idx !== i).filter(Boolean))}
          />
        </div>
      ))}
      <Button
        size="small"
        type="dashed"
        block
        onClick={() => onChange([...list.filter(Boolean), ''])}
      >
        + 增加一行
      </Button>
    </div>
  )
}

/** 可编辑的「键值」列表（redis 存储位置 / 自定义字段） */
export function EditableKv({
  value,
  onChange,
  keyPlaceholder,
  valPlaceholder,
  readOnly,
}: {
  value: MwKv[]
  onChange: (v: MwKv[]) => void
  keyPlaceholder?: string
  valPlaceholder?: string
  /** 只读展示（详情未进入编辑模式时用）：不渲染输入框，也不给增删入口 */
  readOnly?: boolean
}) {
  const list = value && value.length ? value : [{ key: '', value: '' }]
  if (readOnly) {
    const rows = (value || []).filter((kv) => (kv.key || '').trim() || (kv.value || '').trim())
    return (
      <div className="mwc-lines">
        {rows.length ? (
          rows.map((kv, i) => (
            <div key={i}>
              <span style={{ color: 'var(--text-secondary)' }}>{kv.key}：</span>
              <span className="mwc-mono">
                <Copyable text={kv.value} />
              </span>
            </div>
          ))
        ) : (
          <div className="mwc-mono" style={{ color: 'var(--text-secondary)' }}>
            未填写
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="mwc-lines">
      {list.map((kv, i) => (
        <div key={i} className="mwc-edit-kv">
          <Input
            size="small"
            value={kv.key}
            placeholder={keyPlaceholder || '名称'}
            onChange={(e) => {
              const next = [...list]
              next[i] = { ...kv, key: e.target.value }
              onChange(next)
            }}
          />
          <Input
            size="small"
            value={kv.value}
            placeholder={valPlaceholder || '值'}
            className="mwc-mono"
            onChange={(e) => {
              const next = [...list]
              next[i] = { ...kv, value: e.target.value }
              onChange(next)
            }}
          />
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => onChange(list.filter((_, idx) => idx !== i))}
          />
        </div>
      ))}
      <Button
        size="small"
        type="dashed"
        block
        onClick={() => onChange([...list, { key: '', value: '' }])}
      >
        + 增加一行
      </Button>
    </div>
  )
}

/** 可编辑的代码路径（按端口配对） */
function EditableCodePaths({
  value,
  onChange,
}: {
  value: MwCodePath[]
  onChange: (v: MwCodePath[]) => void
}) {
  const list = value && value.length ? value : [{ port: '', path: '', biz: '' }]
  return (
    <div className="mwc-lines">
      {list.map((cp, i) => (
        <div key={i} className="mwc-edit-cp">
          <Input
            size="small"
            value={cp.port}
            placeholder="端口（可空，多个用 , 分隔）"
            style={{ width: 110, flex: '0 0 auto' }}
            className="mwc-mono"
            onChange={(e) => {
              const next = [...list]
              next[i] = { ...cp, port: e.target.value }
              onChange(next)
            }}
          />
          <Input
            size="small"
            value={cp.path}
            placeholder="代码路径（可填多个目录，用 、 分隔）"
            className="mwc-mono"
            style={{ flex: '1 1 0', minWidth: 0 }}
            onChange={(e) => {
              const next = [...list]
              next[i] = { ...cp, path: e.target.value }
              onChange(next)
            }}
          />
          <Input
            size="small"
            value={cp.biz || ''}
            placeholder="代码业务（手动填写）"
            style={{ flex: '1 1 0', minWidth: 0 }}
            onChange={(e) => {
              const next = [...list]
              next[i] = { ...cp, biz: e.target.value }
              onChange(next)
            }}
          />
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => onChange(list.filter((_, idx) => idx !== i))}
          />
        </div>
      ))}
      <Button
        size="small"
        type="dashed"
        block
        onClick={() => onChange([...list, { port: '', path: '', biz: '' }])}
      >
        + 增加一套代码路径
      </Button>
    </div>
  )
}

/** 可编辑的 Java 应用列表 */
function EditableJars({
  value,
  onChange,
}: {
  value: MwJavaApp[]
  onChange: (v: MwJavaApp[]) => void
}) {
  if (!value || value.length === 0) return <span className="empty-val">—</span>
  return (
    <div className="mwc-lines">
      {value.map((j, i) => (
        <div key={i} className="mwc-jar">
          <div className="mwc-edit-row">
            <Input
              size="small"
              value={j.name}
              placeholder="JAR 包名"
              className="mwc-mono"
              onChange={(e) => {
                const next = [...value]
                next[i] = { ...j, name: e.target.value }
                onChange(next)
              }}
            />
          </div>
          <div className="mwc-edit-row">
            <Input
              size="small"
              value={j.codePath}
              placeholder="代码路径"
              className="mwc-mono"
              onChange={(e) => {
                const next = [...value]
                next[i] = { ...j, codePath: e.target.value }
                onChange(next)
              }}
            />
          </div>
          <div className="mwc-edit-row">
            <Input
              size="small"
              value={j.biz || ''}
              placeholder="代码业务（手动填写）"
              onChange={(e) => {
                const next = [...value]
                next[i] = { ...j, biz: e.target.value }
                onChange(next)
              }}
            />
          </div>
          <div className="mwc-edit-row">
            <Input
              size="small"
              value={j.port}
              placeholder="启动端口（多个用 , 分隔）"
              className="mwc-mono"
              onChange={(e) => {
                const next = [...value]
                next[i] = { ...j, port: e.target.value }
                onChange(next)
              }}
            />
          </div>
          <div className="mwc-edit-row">
            <Input.TextArea
              size="small"
              value={j.command}
              placeholder="启动命令"
              autoSize={{ minRows: 1, maxRows: 4 }}
              className="mwc-mono"
              onChange={(e) => {
                const next = [...value]
                next[i] = { ...j, command: e.target.value }
                onChange(next)
              }}
            />
          </div>
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => onChange(value.filter((_, idx) => idx !== i))}
          >
            删除此应用
          </Button>
        </div>
      ))}
    </div>
  )
}

export interface MwCaptureItemCardProps {
  item: MwCaptureItem
  editable?: boolean
  onChange?: (item: MwCaptureItem) => void
  onRemove?: () => void
}

/** 一个中间件的捕捉结果卡片（editable=false 只读展示；true 就地编辑） */
export default function MwCaptureItemCard({ item, editable, onChange, onRemove }: MwCaptureItemCardProps) {
  const fields = MW_TYPE_FIELDS[item.type] || []
  const emit = (patch: Partial<MwCaptureItem>) => onChange?.({ ...item, ...patch })

  const rows: { label: string; node: React.ReactNode }[] = []
  for (const f of fields) {
    switch (f.key) {
      case 'version':
        rows.push({
          label: f.label,
          node: editable ? (
            <Input
              size="small"
              value={item.version || ''}
              placeholder="版本号"
              onChange={(e) => emit({ version: e.target.value })}
            />
          ) : item.version ? (
            <Copyable text={item.version} />
          ) : null,
        })
        break
      case 'ports':
        rows.push({
          label: f.label,
          node: editable ? (
            <Input
              size="small"
              value={(item.ports || []).join(',')}
              placeholder="多个端口用 , 分隔"
              className="mwc-mono"
              onChange={(e) =>
                emit({ ports: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
              }
            />
          ) : item.ports?.length ? (
            <Space size={4} wrap>
              {item.ports.map((p) => (
                <Tag key={p} color="blue" style={{ fontFamily: 'ui-monospace, monospace' }}>
                  {p}
                </Tag>
              ))}
            </Space>
          ) : (
            // 端口行始终展示，避免字段被悄悄吞掉；运行中却没拿到端口时给原因提示，
            // 帮用户定位是「探测不到」而不是「真的没监听」。
            <Text type="secondary" style={{ fontSize: 12 }}>
              {item.running
                ? '未探测到监听端口（未取得 root 权限或 ss 看不到该进程；Tomcat 会从 server.xml 兜底，nginx/redis/bws310 会从 conf 的 listen/port 兜底）'
                : '未运行，未采集端口'}
            </Text>
          ),
        })
        break
      case 'password':
        // 密码是敏感值：只读态只显示掩码（不提供双击复制明文），仅进入编辑态才可见/可改。
        rows.push({
          label: f.label,
          node: editable ? (
            <Input.Password
              size="small"
              value={item.password || ''}
              placeholder="Redis 访问密码"
              onChange={(e) => emit({ password: e.target.value })}
            />
          ) : item.password ? (
            <Text style={{ fontFamily: 'ui-monospace, monospace' }}>••••••</Text>
          ) : null,
        })
        break
      case 'installPath':
        rows.push({
          label: f.label,
          node: editable ? (
            <Input
              size="small"
              value={item.installPath || ''}
              placeholder="安装位置"
              className="mwc-mono"
              onChange={(e) => emit({ installPath: e.target.value })}
            />
          ) : item.installPath ? (
            <Copyable text={item.installPath} />
          ) : null,
        })
        break
      case 'configPaths':
        rows.push({
          label: f.label,
          node: editable ? (
            <EditableList
              value={item.configPaths || []}
              onChange={(v) => emit({ configPaths: v })}
              placeholder="配置文件路径"
            />
          ) : (
            <MultiLines lines={item.configPaths || []} />
          ),
        })
        break
      case 'logPaths':
        rows.push({
          label: f.label,
          node: editable ? (
            <EditableList
              value={item.logPaths || []}
              onChange={(v) => emit({ logPaths: v })}
              placeholder="日志目录"
            />
          ) : (
            <MultiLines lines={item.logPaths || []} />
          ),
        })
        break
      case 'certs':
        rows.push({
          label: f.label,
          node: editable ? (
            <EditableList value={item.certs || []} onChange={(v) => emit({ certs: v })} placeholder="证书路径" />
          ) : item.certs?.length ? (
            <MultiLines lines={item.certs} />
          ) : (
            <Text type="secondary">无</Text>
          ),
        })
        break
      case 'codePaths':
        rows.push({
          label: f.label,
          node: editable ? (
            <EditableCodePaths value={item.codePaths || []} onChange={(v) => emit({ codePaths: v })} />
          ) : item.codePaths?.length ? (
            <div className="mwc-lines">
              {item.codePaths.map((cp, i) => (
                <div key={i} className="mwc-mono">
                  {/* 路径是主体；端口作为「该路径对应的监听端口」用灰色括号补注到路径后面，
                      业务名称同理补注，避免「代码路径」一行的值列被单一信息抢走视觉重点。 */}
                  <Copyable text={cp.path} />
                  {cp.port ? (
                    <Text type="secondary" style={{ marginInlineStart: 8 }}>
                      （端口 {cp.port}）
                    </Text>
                  ) : null}
                  {cp.biz ? (
                    <Text type="secondary" style={{ marginInlineStart: 8 }}>
                      （业务：{cp.biz}）
                    </Text>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null,
        })
        break
      case 'storage':
        rows.push({
          label: f.label,
          node: editable ? (
            <EditableKv value={item.storage || []} onChange={(v) => emit({ storage: v })} keyPlaceholder="名称" valPlaceholder="路径" />
          ) : item.storage?.length ? (
            <div className="mwc-lines">
              {item.storage.map((kv, i) => (
                <div key={i}>
                  <span style={{ color: 'var(--text-secondary)' }}>{kv.key}：</span>
                  <span className="mwc-mono">
                    <Copyable text={kv.value} />
                  </span>
                </div>
              ))}
            </div>
          ) : null,
        })
        break
    }
  }
  const visible = rows.filter((r) => r.node !== null)

  return (
    <div className="mwc-card">
      <div className="mwc-card__head">
        <span className="mwc-card__title">{item.label}</span>
        <Badge status={item.running ? 'success' : 'default'} text={item.running ? '运行中' : '未运行'} />
        {item.certs?.length ? (
          <Tag icon={<SafetyCertificateOutlined />} color="green">
            有证书
          </Tag>
        ) : null}
        {editable && onRemove ? (
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            style={{ marginInlineStart: 'auto' }}
            onClick={onRemove}
          >
            删除
          </Button>
        ) : null}
      </div>
      {visible.length > 0 && (
        <div className="mwc-rows">
          {visible.map((r) => (
            <div className="mwc-row" key={r.label}>
              <div className="mwc-label">{r.label}</div>
              <div className="mwc-val">{r.node}</div>
            </div>
          ))}
        </div>
      )}

      {/* Java 应用逐个列出：JAR 包名 / 代码路径 / 启动端口 / 启动命令 */}
      {item.jars?.length ? (
        <div style={{ marginTop: visible.length ? 12 : 0 }}>
          <div className="mwc-subtitle">Java 应用（共 {item.jars.length} 个）</div>
          {editable ? (
            <EditableJars value={item.jars} onChange={(v) => emit({ jars: v })} />
          ) : (
            item.jars.map((j, i) => (
              <div className="mwc-jar" key={i}>
                <div className="mwc-row">
                  <div className="mwc-label">JAR 包名</div>
                  <div className="mwc-val">
                    <span className="mwc-mono">
                      <Copyable text={j.name} />
                    </span>
                    <Text type="secondary" style={{ marginInlineStart: 8, fontSize: 12 }}>
                      pid {j.pid}
                    </Text>
                  </div>
                </div>
                <div className="mwc-row">
                  <div className="mwc-label">代码路径</div>
                  <div className="mwc-val mwc-mono">
                    <Copyable text={j.codePath} />
                    {j.biz ? (
                      <Text type="secondary" style={{ marginInlineStart: 8, fontSize: 12 }}>
                        （业务：{j.biz}）
                      </Text>
                    ) : null}
                  </div>
                </div>
                <div className="mwc-row">
                  <div className="mwc-label">启动端口</div>
                  <div className="mwc-val">
                    {j.port ? (
                      <Space size={4} wrap>
                        {j.port.split(',').map((p) => (
                          <Tag key={p} color="blue" style={{ fontFamily: 'ui-monospace, monospace' }}>
                            {p}
                          </Tag>
                        ))}
                      </Space>
                    ) : (
                      <Text type="secondary">未探测到监听端口（可能未提权）</Text>
                    )}
                  </div>
                </div>
                <div className="mwc-row">
                  <div className="mwc-label">启动命令</div>
                  <div className="mwc-val">
                    <div className="mwc-cmd">
                      <Copyable text={j.command} />
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {item.notes?.length ? (
        <div className="mwc-notes">
          {item.notes.map((n, i) => (
            <div key={i}>· {n}</div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
