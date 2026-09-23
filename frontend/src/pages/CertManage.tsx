import { useEffect, useMemo, useState } from 'react'
import {
  App,
  Alert,
  Badge,
  Button,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  SafetyCertificateOutlined,
  PlusOutlined,
  SearchOutlined,
  ReloadOutlined,
  EditOutlined,
  DeleteOutlined,
  EyeOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  UploadOutlined,
  InboxOutlined,
  KeyOutlined,
} from '@ant-design/icons'
import {
  listDeployCerts,
  getDeployCert,
  createDeployCert,
  updateDeployCert,
  deleteDeployCert,
  certSummary,
  uploadDeployCert,
  type DeployCert,
  type CertSummary,
} from '../api/deploy'
import { useAuth } from '../store/AuthContext'

const { Text, Paragraph, Title } = Typography

// 状态元数据
const STATUS_META: Record<
  string,
  { label: string; color: string; bg: string; icon: React.ReactNode }
> = {
  valid: { label: '有效', color: '#16a34a', bg: 'rgba(22,163,74,.12)', icon: <CheckCircleOutlined /> },
  expiring: { label: '即将到期', color: '#f59e0b', bg: 'rgba(245,158,11,.14)', icon: <ClockCircleOutlined /> },
  expired: { label: '已过期', color: '#ef4444', bg: 'rgba(239,68,68,.14)', icon: <CloseCircleOutlined /> },
  unknown: { label: '未解析', color: '#94a3b8', bg: 'rgba(148,163,184,.14)', icon: <WarningOutlined /> },
}

function fmtDate(s?: string) {
  if (!s) return '-'
  const d = new Date(s)
  if (isNaN(d.getTime())) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 剩余天数 → 进度条百分比与配色
function daysProgress(daysLeft: number, status: string) {
  if (status === 'expired') return { percent: 100, stroke: '#ef4444' }
  if (status === 'expiring') return { percent: Math.max(6, Math.min(100, (daysLeft / 30) * 100)), stroke: '#f59e0b' }
  if (status === 'valid') return { percent: 100, stroke: '#16a34a' }
  return { percent: 0, stroke: '#94a3b8' }
}

export default function CertManage() {
  const { message } = App.useApp()
  const { hasPerm } = useAuth()
  const [list, setList] = useState<DeployCert[]>([])
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<CertSummary | null>(null)

  const [kw, setKw] = useState('')
  const [filter, setFilter] = useState<string>('all') // all/valid/expiring/expired/unknown

  const [detail, setDetail] = useState<DeployCert | null>(null)
  const [drawer, setDrawer] = useState(false)

  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState<DeployCert | null>(null) // null = 新增；否则编辑/更新
  const [renew, setRenew] = useState(false) // 更新证书模式（提示重传 CRT/KEY）
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  // 上传证书文件
  const [uploadOpen, setUploadOpen] = useState(false)
  const [crtFile, setCrtFile] = useState<File | null>(null)
  const [keyFile, setKeyFile] = useState<File | null>(null)
  const [caFile, setCaFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadForm] = Form.useForm()

  const load = async () => {
    setLoading(true)
    try {
      const [cs, sm] = await Promise.all([listDeployCerts(), certSummary()])
      setList(cs)
      setSummary(sm)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    const k = kw.trim().toLowerCase()
    return list.filter((c) => {
      if (filter !== 'all' && (c.status || 'unknown') !== filter) return false
      if (!k) return true
      return (
        (c.name || '').toLowerCase().includes(k) ||
        (c.domain || '').toLowerCase().includes(k) ||
        (c.sans || '').toLowerCase().includes(k) ||
        (c.project || '').toLowerCase().includes(k) ||
        (c.issuer || '').toLowerCase().includes(k)
      )
    })
  }, [list, kw, filter])

  const openCreate = () => {
    setEditing(null)
    setRenew(false)
    form.resetFields()
    setModal(true)
  }

  const openEdit = (cert: DeployCert) => {
    setEditing(cert)
    setRenew(false)
    form.setFieldsValue({
      name: cert.name,
      domain: cert.domain,
      sans: cert.sans,
      project: cert.project,
      crtContent: '',
      keyContent: '',
      caContent: '',
      remark: cert.remark,
    })
    setModal(true)
  }

  const openRenew = async (cert: DeployCert) => {
    setEditing(cert)
    setRenew(true)
    try {
      const full = await getDeployCert(cert.id)
      form.setFieldsValue({
        name: full.name,
        domain: full.domain,
        sans: full.sans,
        project: full.project,
        crtContent: '',
        keyContent: '',
        caContent: '',
        remark: full.remark,
      })
    } catch {
      form.setFieldsValue({ name: cert.name, domain: cert.domain, project: cert.project, remark: cert.remark })
    }
    setModal(true)
  }

  const openDetail = async (cert: DeployCert) => {
    setDetail(cert)
    setDrawer(true)
    try {
      const full = await getDeployCert(cert.id)
      setDetail(full)
    } catch {
      /* 使用列表快照 */
    }
  }

  const submit = async () => {
    const v = await form.validateFields()
    setSaving(true)
    try {
      let id = editing?.id
      if (!editing) {
        const r = await createDeployCert(v)
        id = r.id
        message.success('证书已保存')
      } else {
        await updateDeployCert(editing.id, v)
        message.success(renew ? '证书已更新（换证成功）' : '证书已更新')
      }
      // 取回解析后的到期信息，给出明确反馈
      if (id) {
        try {
          const full = await getDeployCert(id)
          if (full.notAfter) {
            const tip =
              (full.status === 'expired' ? '⚠️ 该证书已过期' : full.status === 'expiring' ? '注意：该证书即将到期' : '有效期至') +
              ` ${fmtDate(full.notAfter)}（剩余 ${full.daysLeft} 天）`
            message.info(tip)
          }
        } catch {
          /* ignore */
        }
      }
      setModal(false)
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: number) => {
    try {
      await deleteDeployCert(id)
      message.success('已删除')
      if (detail?.id === id) setDrawer(false)
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.message || '删除失败')
    }
  }

  // 上传证书文件
  const openUpload = () => {
    setCrtFile(null)
    setKeyFile(null)
    setCaFile(null)
    uploadForm.resetFields()
    setUploadOpen(true)
  }

  const onCertFileChange = (
    setter: (f: File | null) => void,
    autoName: boolean,
  ) => (info: any) => {
    const f: File | undefined = info.file?.originFileObj || info.file
    if (!f) return
    setter(f)
    if (autoName) {
      const name = (f.name || '').replace(/\.[^.]+$/, '')
      if (name) uploadForm.setFieldsValue({ name })
    }
  }

  const submitUpload = async () => {
    const v = await uploadForm.validateFields()
    if (!crtFile) {
      message.error('请上传证书文件（CRT）')
      return
    }
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('name', v.name)
      if (v.domain) fd.append('domain', v.domain)
      if (v.sans) fd.append('sans', v.sans)
      if (v.project) fd.append('project', v.project)
      if (v.remark) fd.append('remark', v.remark)
      fd.append('crtFile', crtFile)
      if (keyFile) fd.append('keyFile', keyFile)
      if (caFile) fd.append('caFile', caFile)
      const r = await uploadDeployCert(fd)
      message.success(r.created ? '证书已上传并保存' : '证书已更新（换证成功）')
      setUploadOpen(false)
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.message || '上传失败')
    } finally {
      setUploading(false)
    }
  }

  const counts = summary?.counts
  const expiringList = summary?.expiring || []

  const columns: ColumnsType<DeployCert> = [
    {
      title: '证书',
      key: 'name',
      render: (_: any, r: DeployCert) => (
        <Space>
          <span className="cert-badge">
            <SafetyCertificateOutlined />
          </span>
          <div>
            <div style={{ fontWeight: 600 }}>{r.name}</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {r.domain || r.commonName || '-'}
            </Text>
          </div>
        </Space>
      ),
    },
    {
      title: '备用域名 (SAN)',
      dataIndex: 'sans',
      key: 'sans',
      ellipsis: true,
      render: (s: string) =>
        s ? (
          <Text style={{ fontSize: 12 }}>{s}</Text>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            -
          </Text>
        ),
    },
    {
      title: '关联项目',
      dataIndex: 'project',
      key: 'project',
      render: (p: string) =>
        p ? (
          <Tag color="geekblue" style={{ borderRadius: 6 }}>
            {p}
          </Tag>
        ) : (
          <Text type="secondary">-</Text>
        ),
    },
    {
      title: '签发者',
      dataIndex: 'issuer',
      key: 'issuer',
      ellipsis: true,
      render: (i: string) => i || <Text type="secondary">-</Text>,
    },
    {
      title: '到期时间',
      dataIndex: 'notAfter',
      key: 'notAfter',
      sorter: (a: DeployCert, b: DeployCert) =>
        new Date(a.notAfter || 0).getTime() - new Date(b.notAfter || 0).getTime(),
      render: (s: string, r: DeployCert) => (
        <div>
          <div>{fmtDate(s)}</div>
          {r.algorithm && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {r.algorithm}
            </Text>
          )}
        </div>
      ),
    },
    {
      title: '剩余天数',
      key: 'daysLeft',
      width: 150,
      sorter: (a: DeployCert, b: DeployCert) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999),
      render: (_: any, r: DeployCert) => {
        const status = r.status || 'unknown'
        const meta = STATUS_META[status]
        const { percent, stroke } = daysProgress(r.daysLeft ?? -1, status)
        return (
          <div style={{ width: 120 }}>
            <Progress
              percent={percent}
              showInfo={false}
              strokeColor={stroke}
              size="small"
              trailColor="var(--border-soft)"
            />
            <Text style={{ fontSize: 12, color: meta.color, fontWeight: 600 }}>
              {status === 'unknown'
                ? '未解析'
                : r.daysLeft != null && r.daysLeft >= 0
                ? `剩余 ${r.daysLeft} 天`
                : `已过期 ${Math.abs(r.daysLeft ?? 0)} 天`}
            </Text>
          </div>
        )
      },
    },
    {
      title: '状态',
      key: 'status',
      filters: [
        { text: '有效', value: 'valid' },
        { text: '即将到期', value: 'expiring' },
        { text: '已过期', value: 'expired' },
        { text: '未解析', value: 'unknown' },
      ],
      onFilter: (val, r) => (r.status || 'unknown') === val,
      render: (_: any, r: DeployCert) => {
        const status = r.status || 'unknown'
        const meta = STATUS_META[status]
        return (
          <span className="cert-status" style={{ color: meta.color, background: meta.bg }}>
            {meta.icon} {meta.label}
          </span>
        )
      },
    },
    {
      title: '操作',
      key: 'op',
      width: 200,
      render: (_: any, r: DeployCert) => (
        <Space size={4}>
          <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => openDetail(r)}>
            详情
          </Button>
          {hasPerm('cert:update') && (
            <Button size="small" type="text" icon={<UploadOutlined />} onClick={() => openRenew(r)}>
              更新
            </Button>
          )}
          {hasPerm('cert:update') && (
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          )}
          {hasPerm('cert:delete') && (
            <Popconfirm title="确认删除该证书？" description="删除后不可恢复" onConfirm={() => remove(r.id)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div className="cert-page">
      {/* Hero */}
      <div className="mw-hero glass fade-up" style={{ marginBottom: 18 }}>
        <div className="mw-hero__glow" />
        <div className="mw-hero__main">
          <div className="mw-hero__title">
            <SafetyCertificateOutlined />
            证书管理
          </div>
          <div className="mw-hero__desc">
            集中管理 Nginx / 宝兰德 BWS 等中间件的 SSL 证书。系统自动解析到期时间与签发信息，临近到期（≤30 天）主动预警，
            并支持按项目批量轮转换证，告别每年手动翻找证书。
          </div>
        </div>
        <div className="mw-hero__chips">
          <div className="mw-stat">
            <div className="mw-stat__n">{counts?.total ?? '-'}</div>
            <div className="mw-stat__l">证书总数</div>
          </div>
          <div className="mw-stat" style={{ ['--c' as any]: '#f59e0b' }}>
            <div className="mw-stat__n">{counts?.expiring ?? '-'}</div>
            <div className="mw-stat__l">即将到期</div>
          </div>
          <div className="mw-stat" style={{ ['--c' as any]: '#ef4444' }}>
            <div className="mw-stat__n">{counts?.expired ?? '-'}</div>
            <div className="mw-stat__l">已过期</div>
          </div>
          <div className="mw-stat" style={{ ['--c' as any]: '#94a3b8' }}>
            <div className="mw-stat__n">{counts?.unknown ?? '-'}</div>
            <div className="mw-stat__l">未解析</div>
          </div>
        </div>
      </div>

      {/* 到期预警横幅 */}
      {expiringList.length > 0 && (
        <Alert
          className="cert-alert fade-up"
          type={expiringList.some((e) => e.status === 'expired') ? 'error' : 'warning'}
          showIcon
          icon={<WarningOutlined />}
          message={
            <Space wrap>
              <Text strong>
                {expiringList.some((e) => e.status === 'expired')
                  ? `有 ${expiringList.filter((e) => e.status === 'expired').length} 张证书已过期`
                  : `有 ${expiringList.length} 张证书将在 30 天内到期`}
                ，请及时换证
              </Text>
            </Space>
          }
          description={
            <div className="cert-alert-list">
              {expiringList.slice(0, 6).map((e) => (
                <div key={e.id} className="cert-alert-item">
                  <span className="cert-alert-dot" style={{ background: STATUS_META[e.status]?.color }} />
                  <span style={{ fontWeight: 600 }}>{e.name}</span>
                  <span className="cert-alert-sub">
                    {e.project ? `${e.project} · ` : ''}
                    {fmtDate(e.notAfter)}
                  </span>
                  <span style={{ color: STATUS_META[e.status]?.color, fontWeight: 600 }}>
                    {e.daysLeft >= 0 ? `剩 ${e.daysLeft} 天` : `已过期 ${Math.abs(e.daysLeft)} 天`}
                  </span>
                  {hasPerm('cert:update') && (
                    <Button size="small" type="link" onClick={() => openRenew({ id: e.id } as DeployCert)}>
                      去换证
                    </Button>
                  )}
                </div>
              ))}
            </div>
          }
        />
      )}

      {/* 工具栏 */}
      <div className="mw-cfg-toolbar glass">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索证书名称 / 域名 / 项目 / 签发者"
          style={{ width: 280 }}
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
        <Space size={4} className="cert-filters">
          {[
            { k: 'all', t: '全部' },
            { k: 'expiring', t: '即将到期' },
            { k: 'expired', t: '已过期' },
            { k: 'valid', t: '有效' },
            { k: 'unknown', t: '未解析' },
          ].map((f) => (
            <span
              key={f.k}
              className={`cert-filter ${filter === f.k ? 'active' : ''}`}
              onClick={() => setFilter(f.k)}
            >
              {f.t}
            </span>
          ))}
        </Space>
        <div style={{ flex: 1 }} />
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          {hasPerm('cert:create') && (
            <Button icon={<UploadOutlined />} onClick={openUpload}>
              上传证书
            </Button>
          )}
          {hasPerm('cert:create') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增证书
            </Button>
          )}
        </Space>
      </div>

      {/* 表格 */}
      <div className="glass cert-table-wrap">
        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          dataSource={filtered}
          columns={columns}
          pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 张证书`, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty description="暂无证书，点击「新增证书」上传第一张" /> }}
        />
      </div>

      {/* 详情抽屉 */}
      <Drawer
        width={640}
        open={drawer}
        onClose={() => setDrawer(false)}
        title={
          detail && (
            <Space>
              <span className="cert-badge">
                <SafetyCertificateOutlined />
              </span>
              <div>
                <div style={{ fontWeight: 700 }}>{detail.name}</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {detail.domain || detail.commonName || '-'}
                </Text>
              </div>
            </Space>
          )
        }
        extra={
          detail && (
            <Space>
              {hasPerm('cert:update') && (
                <Button icon={<UploadOutlined />} onClick={() => openRenew(detail)}>
                  更新证书
                </Button>
              )}
              {hasPerm('cert:update') && (
                <Button icon={<EditOutlined />} onClick={() => openEdit(detail)}>
                  编辑
                </Button>
              )}
            </Space>
          )
        }
      >
        {detail && (
          <div className="cert-drawer">
            <div className="cert-drawer-status">
              <span
                className="cert-status"
                style={{ color: STATUS_META[detail.status || 'unknown'].color, background: STATUS_META[detail.status || 'unknown'].bg }}
              >
                {STATUS_META[detail.status || 'unknown'].icon} {STATUS_META[detail.status || 'unknown'].label}
              </span>
              {detail.project && <Tag color="geekblue">{detail.project}</Tag>}
              {detail.algorithm && <Tag>{detail.algorithm}</Tag>}
            </div>

            <Descriptions column={1} size="small" bordered className="cert-desc" style={{ marginBottom: 18 }}>
              <Descriptions.Item label="主域名">{detail.domain || '-'}</Descriptions.Item>
              <Descriptions.Item label="备用域名 (SAN)">{detail.sans || '-'}</Descriptions.Item>
              <Descriptions.Item label="关联项目">{detail.project || '-'}</Descriptions.Item>
              <Descriptions.Item label="主体 (CN)">{detail.commonName || '-'}</Descriptions.Item>
              <Descriptions.Item label="签发者 (CA)">{detail.issuer || '-'}</Descriptions.Item>
              <Descriptions.Item label="序列号">
                <Text copyable={!!detail.serialNumber} style={{ fontSize: 12 }}>
                  {detail.serialNumber || '-'}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="生效时间">{fmtDate(detail.notBefore)}</Descriptions.Item>
              <Descriptions.Item label="到期时间">{fmtDate(detail.notAfter)}</Descriptions.Item>
              <Descriptions.Item label="剩余天数">
                {detail.daysLeft != null && detail.daysLeft >= 0 ? `${detail.daysLeft} 天` : `已过期 ${Math.abs(detail.daysLeft ?? 0)} 天`}
              </Descriptions.Item>
              <Descriptions.Item label="备注">{detail.remark || '-'}</Descriptions.Item>
            </Descriptions>

            <Title level={5}>
              <KeyOutlined /> 证书内容 (CRT)
            </Title>
            <Paragraph>
              <pre className="cert-pre">{detail.crtContent || '(无)'}</pre>
            </Paragraph>
            {detail.caContent && (
              <>
                <Title level={5}>CA 链</Title>
                <Paragraph>
                  <pre className="cert-pre">{detail.caContent}</pre>
                </Paragraph>
              </>
            )}
          </div>
        )}
      </Drawer>

      {/* 新增 / 编辑 / 更新证书 */}
      <Modal
        width={680}
        open={modal}
        onCancel={() => setModal(false)}
        onOk={submit}
        confirmLoading={saving}
        title={
          <Space>
            <SafetyCertificateOutlined style={{ color: 'var(--accent)' }} />
            {editing ? (renew ? '更新证书（换证）' : '编辑证书') : '新增证书'}
          </Space>
        }
        okText={editing ? (renew ? '保存并更新' : '保存') : '保存证书'}
        cancelText="取消"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item
            name="name"
            label="证书名称（用于 vhost，如 example.com）"
            rules={[{ required: true, message: '请输入证书名称' }]}
          >
            <Input placeholder="example.com" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="domain" label="主域名" style={{ flex: 1 }}>
              <Input placeholder="www.example.com" />
            </Form.Item>
            <Form.Item name="sans" label="备用域名 SAN（逗号分隔）" style={{ flex: 1 }}>
              <Input placeholder="a.example.com,b.example.com" />
            </Form.Item>
          </Space>
          <Form.Item name="project" label="关联项目 / 用途">
            <Input placeholder="如 ERP、OA 门户、微信公众号回调（便于按项目轮转）" />
          </Form.Item>
          <Form.Item
            name="crtContent"
            label={renew ? '新证书 CRT（PEM）' : '证书 CRT（PEM）'}
            rules={editing ? [] : [{ required: true, message: '请粘贴证书内容' }]}
          >
            <Input.TextArea rows={5} placeholder={renew ? '换证：粘贴新证书。留空则保持不变' : '-----BEGIN CERTIFICATE-----'} />
          </Form.Item>
          <Form.Item
            name="keyContent"
            label={renew ? '新私钥 KEY（PEM）' : '私钥 KEY（PEM）'}
            rules={editing ? [] : [{ required: true, message: '请粘贴私钥内容' }]}
          >
            <Input.TextArea rows={4} placeholder={renew ? '换证：粘贴新私钥。留空则保持不变' : '-----BEGIN PRIVATE KEY-----'} />
          </Form.Item>
          <Form.Item name="caContent" label="CA 链证书（可选，PEM）">
            <Input.TextArea rows={3} placeholder="-----BEGIN CERTIFICATE-----（中间证书链）" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} placeholder="可选说明" />
          </Form.Item>
        </Form>
        {renew && (
          <Alert
            type="info"
            showIcon
            message="换证提示"
            description="保存后系统会重新解析新证书的到期时间。部署时选该证书即自动下发新证书到目标机。"
          />
        )}
      </Modal>

      {/* 上传证书文件 */}
      <Modal
        width={680}
        open={uploadOpen}
        onCancel={() => setUploadOpen(false)}
        onOk={submitUpload}
        confirmLoading={uploading}
        title={
          <Space>
            <UploadOutlined style={{ color: 'var(--accent)' }} />
            上传证书文件
          </Space>
        }
        okText="上传并保存"
        cancelText="取消"
      >
        <Alert
          style={{ marginBottom: 14 }}
          type="info"
          showIcon
          message="支持上传 .crt / .pem / .cer 证书文件，系统自动解析到期时间与签发信息（CRT 必填，KEY / CA 可选）。"
        />
        <Form form={uploadForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item
            name="name"
            label="证书名称（用于 vhost，如 example.com）"
            rules={[{ required: true, message: '请输入证书名称' }]}
          >
            <Input placeholder="上传 CRT 后会按文件名自动填充，可修改" />
          </Form.Item>
          <Form.Item label="证书文件 CRT（必填）" required>
            <Upload.Dragger
              accept=".crt,.pem,.cer,.txt"
              maxCount={1}
              beforeUpload={() => false}
              fileList={crtFile ? [{ uid: '-1', name: crtFile.name, status: 'done' }] : []}
              onChange={onCertFileChange(setCrtFile, true)}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽证书文件到此处（CRT）</p>
              <p className="ant-upload-hint">支持 .crt / .pem / .cer</p>
            </Upload.Dragger>
          </Form.Item>
          <Form.Item label="私钥 KEY（可选，PEM）">
            <Upload.Dragger
              accept=".key,.pem,.txt"
              maxCount={1}
              beforeUpload={() => false}
              fileList={keyFile ? [{ uid: '-2', name: keyFile.name, status: 'done' }] : []}
              onChange={onCertFileChange(setKeyFile, false)}
            >
              <p className="ant-upload-drag-icon">
                <KeyOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽私钥文件到此处（KEY）</p>
              <p className="ant-upload-hint">部署 nginx SSL 时需要，可稍后补充</p>
            </Upload.Dragger>
          </Form.Item>
          <Form.Item label="CA 链证书（可选，PEM）">
            <Upload.Dragger
              accept=".crt,.pem,.cer,.txt"
              maxCount={1}
              beforeUpload={() => false}
              fileList={caFile ? [{ uid: '-3', name: caFile.name, status: 'done' }] : []}
              onChange={onCertFileChange(setCaFile, false)}
            >
              <p className="ant-upload-drag-icon">
                <SafetyCertificateOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽 CA 链文件到此处（可选）</p>
              <p className="ant-upload-hint">中间证书链（fullchain 亦可）</p>
            </Upload.Dragger>
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="domain" label="主域名" style={{ flex: 1 }}>
              <Input placeholder="www.example.com" />
            </Form.Item>
            <Form.Item name="sans" label="备用域名 SAN（逗号分隔）" style={{ flex: 1 }}>
              <Input placeholder="a.example.com,b.example.com" />
            </Form.Item>
          </Space>
          <Form.Item name="project" label="关联项目 / 用途">
            <Input placeholder="如 ERP、OA 门户（便于按项目轮转）" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} placeholder="可选说明" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
