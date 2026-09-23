import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Row,
  Col,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Switch,
  Tag,
  Space,
  Popconfirm,
  App,
  Spin,
  Select,
  Typography,
  Empty,
  Drawer,
  Tabs,
  Divider,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  AppstoreOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  SafetyCertificateOutlined,
  SearchOutlined,
  FilterOutlined,
  ReloadOutlined,
  EyeOutlined,
  CloudServerOutlined,
  TagsOutlined,
  ClusterOutlined,
  SettingOutlined,
  RocketOutlined,
  DatabaseOutlined,
  CodeOutlined,
} from '@ant-design/icons'
import {
  listDeployMiddlewares,
  createDeployMiddleware,
  updateDeployMiddleware,
  deleteDeployMiddleware,
  type DeployMiddleware,
  type PkgInfo,
  type DeployModeDef,
  STYLE_LABELS,
  NETWORK_ZONES,
} from '../api/deploy'
import { MwBrandIcon, MW_BRAND_COLOR } from '../components/MwBrandIcon'
import { useAuth } from '../store/AuthContext'

const { Text } = Typography

const TOPO_LABELS: Record<string, string> = {
  single: '单机',
  cluster: '集群（自动分配主从）',
  roles: '角色模式（手动指定）',
}

// OS/CPU 令牌必须与控制节点脚本文件名中的令牌一致（any = 不区分该维度）
const OS_TYPES = [
  'centos7',
  'almalinux8.9',
  'almalinux8.10',
  'openEuler20.03',
  'openEuler22.03',
  'hce2.0',
  'kylinV10',
  'any',
]
const CPU_TYPES = ['x86_64', 'aarch64', 'any']

// 中间件品牌色（与 MwBrandIcon.MW_BRAND_COLOR 保持一致）
const MW_COLOR: Record<string, string> = MW_BRAND_COLOR

const MW_DESC: Record<string, string> = {
  nginx: '高性能 HTTP 与反向代理服务器',
  jdk: 'Java 运行时环境（JDK 8u481，X86 / ARM）',
  redis: '内存键值数据库（单机，端口 17000）',
  mysql: '开源关系型数据库（暂无离线脚本）',
  php: 'PHP-FPM 运行环境（7.2.34 / 7.4.33）',
  宝兰德bws310: '宝兰德 BWS310 应用服务器',
}

const CATEGORIES = ['Web服务器', '运行环境', '应用服务器', '数据库缓存']

interface PkgRow {
  osType: string
  cpuType: string
  pkg: string
  script: string
  target: string
  zones?: string[]
}

function safeParseArr(s: string): string[] {
  if (!s) return []
  try {
    const a = JSON.parse(s)
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}

function parsePkgs(packages: string): PkgRow[] {
  if (!packages) return []
  try {
    const map = JSON.parse(packages) as Record<string, PkgInfo>
    return Object.entries(map).map(([k, v]) => {
      const idx = k.lastIndexOf('_')
      const osType = idx > 0 ? k.slice(0, idx) : k
      const cpuType = idx > 0 ? k.slice(idx + 1) : 'any'
      return {
        osType,
        cpuType: cpuType || 'any',
        pkg: v.pkg,
        script: v.script,
        target: v.target,
        zones: v.zones || [],
      }
    })
  } catch {
    return []
  }
}

function toPkgJSON(rows: PkgRow[]): string {
  const map: Record<string, PkgInfo> = {}
  rows.forEach((r) => {
    const os = r.osType || 'any'
    const cpu = r.cpuType || 'any'
    const item: PkgInfo = { pkg: r.pkg, script: r.script, target: r.target }
    if (r.zones && r.zones.length) item.zones = r.zones
    map[`${os}_${cpu}`] = item
  })
  return JSON.stringify(map)
}

function parseModes(modes: string): DeployModeDef[] {
  if (!modes) return []
  try {
    const arr = JSON.parse(modes)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function toModesJSON(rows: DeployModeDef[]): string {
  return JSON.stringify(
    rows.map((r) => ({
      key: r.key,
      label: r.label,
      topology: r.topology,
      nodeCount: r.topology === 'cluster' ? Number(r.nodeCount) || 0 : undefined,
      replicas: r.topology === 'cluster' ? Number(r.replicas) || 0 : undefined,
      roles: r.topology === 'roles' ? r.roles || [] : undefined,
    })),
  )
}

type StatusFilter = 'all' | 'ready' | 'enabled' | 'needCert'
const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'ready', label: '已就绪' },
  { key: 'enabled', label: '已启用' },
  { key: 'needCert', label: '需证书' },
]

export default function MiddlewareConfig() {
  const { message } = App.useApp()
  const { hasPerm } = useAuth()
  const [list, setList] = useState<DeployMiddleware[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState<DeployMiddleware | null>(null)
  const [saving, setSaving] = useState(false)
  const [detail, setDetail] = useState<DeployMiddleware | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [form] = Form.useForm()

  const total = list.length
  const readyCnt = list.filter((l) => l.ready).length
  const enabledCnt = list.filter((l) => l.enabled).length
  const needCertCnt = list.filter((l) => l.needCert).length

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return list.filter((m) => {
      if (statusFilter === 'ready' && !m.ready) return false
      if (statusFilter === 'enabled' && !m.enabled) return false
      if (statusFilter === 'needCert' && !m.needCert) return false
      if (kw) {
        const hay = `${m.name} ${m.label} ${m.description || ''}`.toLowerCase()
        if (!hay.includes(kw)) return false
      }
      return true
    })
  }, [list, search, statusFilter])

  const load = async () => {
    setLoading(true)
    try {
      const data = await listDeployMiddlewares()
      setList(data)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({
      name: '',
      label: '',
      icon: '',
      category: undefined,
      description: '',
      versions: [],
      needCert: false,
      ready: false,
      enabled: false,
      subDir: '',
      style: 'copy',
      playbook: '',
      installPath: '',
      defaultPort: '',
      certDir: '',
      pkgList: [],
      modeList: [],
    })
    setModal(true)
  }

  const openEdit = (m: DeployMiddleware) => {
    setEditing(m)
    form.resetFields()
    form.setFieldsValue({
      name: m.name,
      label: m.label,
      icon: m.icon,
      description: m.description,
      category: m.category || undefined,
      versions: safeParseArr(m.versions),
      needCert: m.needCert,
      ready: m.ready,
      enabled: m.enabled,
      subDir: m.subDir || '',
      style: m.style || 'copy',
      playbook: m.playbook || '',
      installPath: m.installPath || '',
      defaultPort: m.defaultPort || '',
      certDir: m.certDir || '',
      pkgList: parsePkgs(m.packages),
      modeList: parseModes(m.modes),
    })
    setModal(true)
  }

  const submit = async () => {
    const v = await form.validateFields()
    setSaving(true)
    try {
      const payload = {
        name: v.name,
        label: v.label,
        icon: v.icon,
        description: v.description,
        category: v.category || '',
        versions: JSON.stringify(v.versions || []),
        packages: toPkgJSON(v.pkgList || []),
        modes: toModesJSON(v.modeList || []),
        subDir: v.subDir || '',
        style: v.style || 'copy',
        playbook: v.playbook || '',
        installPath: v.installPath || '',
        defaultPort: v.defaultPort || '',
        certDir: v.certDir || '',
        needCert: !!v.needCert,
        ready: !!v.ready,
        enabled: !!v.enabled,
      }
      if (editing) {
        await updateDeployMiddleware(editing.id, payload)
        message.success('已更新')
      } else {
        await createDeployMiddleware(payload)
        message.success('已新增')
      }
      setModal(false)
      load()
    } catch (e: any) {
      if (e?.response?.data?.msg) message.error(e.response.data.msg)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: number) => {
    try {
      await deleteDeployMiddleware(id)
      message.success('已删除')
      load()
    } catch {
      message.error('删除失败')
    }
  }

  // 根据 topology 展示额外参数
  const ModeExtra = ({ fieldName }: { fieldName: number }) => (
    <Form.Item noStyle shouldUpdate>
      {() => {
        const topo = form.getFieldValue(['modeList', fieldName, 'topology'])
        if (topo === 'cluster') {
          return (
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item
                  name={[fieldName, 'nodeCount']}
                  label="节点数"
                  rules={[{ required: true, message: '必填' }]}
                  style={{ marginBottom: 0 }}
                >
                  <InputNumber min={1} placeholder="如 6" style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name={[fieldName, 'replicas']}
                  label="每主从库数"
                  rules={[{ required: true, message: '必填' }]}
                  style={{ marginBottom: 0 }}
                >
                  <InputNumber min={1} placeholder="如 1（3 主 3 从）" style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
          )
        }
        if (topo === 'roles') {
          return (
            <Form.Item
              name={[fieldName, 'roles']}
              label="可选角色（自定义）"
              rules={[{ required: true, message: '必填' }]}
              style={{ marginBottom: 0 }}
            >
              <Select
                mode="tags"
                placeholder="如 master, replica, sentinel"
                tokenSeparators={[',']}
              />
            </Form.Item>
          )
        }
        return <Text type="secondary">单机模式无需额外参数</Text>
      }}
    </Form.Item>
  )

  return (
    <div className="mw-cfg-page">
      {/* HERO */}
      <div className="mw-hero glass fade-up" style={{ marginBottom: 18 }}>
        <div className="mw-hero__glow" />
        <div className="mw-hero__mesh" />
        <div className="mw-hero__main">
          <div className="mw-hero__title">
            <AppstoreOutlined /> 中间件部署配置
          </div>
          <div className="mw-hero__desc">
            统一管理各类中间件的离线安装包、可用版本与部署模式。部署时按目标操作系统 × CPU 自动匹配，并由系统依据所属网络区域自动分配执行节点。
          </div>
        </div>
        <div className="mw-hero__chips">
          <div className="mw-chip">
            <div className="mw-chip__v">{total}</div>
            <div className="mw-chip__l">配置总数</div>
          </div>
          <div className="mw-chip">
            <div className="mw-chip__v">{readyCnt}</div>
            <div className="mw-chip__l">离线包就绪</div>
          </div>
          <div className="mw-chip">
            <div className="mw-chip__v">{enabledCnt}</div>
            <div className="mw-chip__l">已启用</div>
          </div>
          <div className="mw-chip">
            <div className="mw-chip__v">{needCertCnt}</div>
            <div className="mw-chip__l">需证书</div>
          </div>
          {hasPerm('mwtemplate:create') && (
            <Button type="primary" size="large" icon={<PlusOutlined />} onClick={openCreate}>
              新增中间件
            </Button>
          )}
        </div>
      </div>

      {/* TOOLBAR */}
      <div className="mw-cfg-toolbar glass">
        <Input
          prefix={<SearchOutlined style={{ color: 'var(--text-secondary)' }} />}
          placeholder="搜索 展示名 / 类型标识"
          allowClear
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 260 }}
        />
        <div className="mw-cfg-filters">
          <span className="mw-cfg-filters__lbl">
            <FilterOutlined /> 状态
          </span>
          {FILTERS.map((f) => (
            <Tag.CheckableTag
              key={f.key}
              checked={statusFilter === f.key}
              onChange={() => setStatusFilter(f.key)}
            >
              {f.label}
            </Tag.CheckableTag>
          ))}
        </div>
        <Button
          icon={<ReloadOutlined />}
          onClick={load}
          style={{ marginLeft: 'auto' }}
        >
          刷新
        </Button>
      </div>

      {/* GRID */}
      {loading ? (
        <div className="mw-cfg-loading glass">
          <Spin size="large" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="mw-cfg-empty glass">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              search || statusFilter !== 'all'
                ? '没有匹配的中间件配置'
                : '暂无中间件配置，点击右上角新增'
            }
          />
          {(search || statusFilter !== 'all') && (
            <Button
              style={{ marginTop: 12 }}
              onClick={() => {
                setSearch('')
                setStatusFilter('all')
              }}
            >
              清除筛选
            </Button>
          )}
        </div>
      ) : (
        <Row gutter={[18, 18]} className="mw-cfg-grid">
          {filtered.map((m) => (
            <Col key={m.id} xs={24} sm={12} md={12} lg={8} xl={6}>
              <ConfigCard
                m={m}
                onView={() => setDetail(m)}
                onEdit={() => openEdit(m)}
                onDelete={() => remove(m.id)}
              />
            </Col>
          ))}
        </Row>
      )}

      {/* DETAIL DRAWER */}
      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width={680}
        destroyOnClose
        title={
          detail && (
            <div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  color: 'var(--text-strong)',
                  lineHeight: 1.3,
                }}
              >
                {detail.label}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  fontFamily: 'monospace',
                }}
              >
                {detail.name}
              </div>
            </div>
          )
        }
        extra={
          detail &&
          hasPerm('mwtemplate:update') && (
            <Button
              type="primary"
              icon={<EditOutlined />}
              onClick={() => {
                const snapshot = detail
                setDetail(null)
                openEdit(snapshot)
              }}
            >
              编辑
            </Button>
          )
        }
      >
        {detail && <DetailBody m={detail} />}
      </Drawer>

      {/* EDIT MODAL */}
      <Modal
        title={
          editing ? (
            <span>
              <EditOutlined /> 编辑中间件配置 · {editing.label}
            </span>
          ) : (
            <span>
              <PlusOutlined /> 新增中间件配置
            </span>
          )
        }
        open={modal}
        onCancel={() => setModal(false)}
        onOk={submit}
        confirmLoading={saving}
        width={840}
        destroyOnClose
        okText="保存"
        cancelText="取消"
        className="mw-edit-modal"
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Tabs
            className="mw-edit-tabs"
            items={[
              {
                key: 'basic',
                label: (
                  <span>
                    <SettingOutlined /> 基本信息
                  </span>
                ),
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={9}>
                        <Form.Item
                          name="name"
                          label="类型标识 (name)"
                          rules={[{ required: true, message: '请输入类型标识' }]}
                          extra="唯一标识，部署时按此匹配，建议英文小写"
                        >
                          <Input disabled={!!editing} placeholder="nginx" />
                        </Form.Item>
                      </Col>
                      <Col span={9}>
                        <Form.Item
                          name="label"
                          label="展示名"
                          rules={[{ required: true, message: '请输入展示名' }]}
                        >
                          <Input placeholder="Nginx" />
                        </Form.Item>
                      </Col>
                      <Col span={6}>
                        <Form.Item name="icon" label="图标" extra="展示用">
                          <Input placeholder="nginx" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item name="description" label="说明">
                      <Input placeholder="可选，一句话描述" />
                    </Form.Item>
                    <Form.Item name="versions" label="可用版本">
                      <Select
                        mode="tags"
                        placeholder="输入版本后回车，如 1.28.3"
                        tokenSeparators={[',']}
                      />
                    </Form.Item>
                    <Row gutter={16}>
                      <Col span={6}>
                        <Form.Item name="category" label="分类">
                          <Select allowClear placeholder="选择分类" options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
                        </Form.Item>
                      </Col>
                      <Col span={6}>
                        <Form.Item
                          name="subDir"
                          label="控制节点目录"
                          extra="相对 DEPLOY_BASE，如 redis/STAND-ALONE"
                        >
                          <Input placeholder="nginx" />
                        </Form.Item>
                      </Col>
                      <Col span={6}>
                        <Form.Item name="installPath" label="默认安装路径">
                          <Input placeholder="/opt/servers/nginx" />
                        </Form.Item>
                      </Col>
                      <Col span={6}>
                        <Form.Item name="defaultPort" label="默认端口">
                          <Input placeholder="8089" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item
                          name="style"
                          label="部署方式"
                          extra="需与控制节点脚本形态一致"
                        >
                          <Select
                            options={[
                              { value: 'copy', label: '上传包 + 脚本执行（nginx/jdk）' },
                              { value: 'unarchive', label: '解压后执行包内脚本（php）' },
                              { value: 'dir', label: '下发整个目录后执行（BWS310）' },
                              { value: 'playbook', label: '执行既有 playbook（redis）' },
                            ]}
                          />
                        </Form.Item>
                      </Col>
                      <Col span={16}>
                        <Form.Item
                          noStyle
                          shouldUpdate={(prev, cur) => prev.style !== cur.style}
                        >
                          {({ getFieldValue }) =>
                            getFieldValue('style') === 'playbook' ? (
                              <Form.Item
                                name="playbook"
                                label="既有 playbook 路径（控制节点）"
                                rules={[{ required: true, message: '请填写 playbook 路径' }]}
                              >
                                <Input placeholder="/data/.../redis/STAND-ALONE/redis-5.0.14-stand-alone.yml" />
                              </Form.Item>
                            ) : (
                              <Form.Item label=" ">
                                <div style={{ color: '#64748b', fontSize: 12, lineHeight: '32px' }}>
                                  当前方式下由平台生成 playbook，离线包矩阵见下一个页签
                                </div>
                              </Form.Item>
                            )
                          }
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item
                      noStyle
                      shouldUpdate={(prev, cur) => prev.needCert !== cur.needCert}
                    >
                      {({ getFieldValue }) =>
                        getFieldValue('needCert') ? (
                          <Row gutter={16}>
                            <Col span={12}>
                              <Form.Item
                                name="certDir"
                                label="证书下发目录（目标机）"
                                extra="平台只把 CRT/KEY 下发到该目录，并通过 HAS_CERT / CERT_DIR / CERT_NAME / CERT_CRT / CERT_KEY / CERT_CA 环境变量交给安装脚本，由脚本自行配置 SSL；Nginx 留空即为 conf/ssl"
                              >
                                <Input placeholder="/data/BWS310/ssl" />
                              </Form.Item>
                            </Col>
                          </Row>
                        ) : null
                      }
                    </Form.Item>
                    <Divider />
                    <div className="mw-edit-switches">
                      <Form.Item
                        name="needCert"
                        label="部署时需要证书"
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item name="ready" label="离线包已就绪" valuePropName="checked">
                        <Switch />
                      </Form.Item>
                      <Form.Item name="enabled" label="在部署向导中启用" valuePropName="checked">
                        <Switch />
                      </Form.Item>
                    </div>
                  </>
                ),
              },
              {
                key: 'pkgs',
                label: (
                  <span>
                    <CloudServerOutlined /> 离线包矩阵
                  </span>
                ),
                children: (
                  <Form.List name="pkgList">
                    {(fields, { add, remove }) => (
                      <div>
                        {fields.length === 0 && (
                          <div className="mw-edit-empty">
                            尚未配置安装包，点击下方添加（至少为主推环境配置一项）
                          </div>
                        )}
                        {fields.map((field) => (
                          <div key={field.key} className="mw-pkg-form-card">
                            <div className="mw-pkg-form-card__head">
                              <span className="mw-pkg-form-card__title">
                                <CloudServerOutlined /> 离线包 #{field.name + 1}
                              </span>
                              <Button
                                size="small"
                                danger
                                type="text"
                                icon={<DeleteOutlined />}
                                onClick={() => remove(field.name)}
                              >
                                删除
                              </Button>
                            </div>
                            <Row gutter={12}>
                              <Col span={8}>
                                <Form.Item
                                  name={[field.name, 'osType']}
                                  label="操作系统"
                                  rules={[{ required: true, message: '必选' }]}
                                >
                                  <Select
                                    options={OS_TYPES.map((o) => ({
                                      value: o,
                                      label: o,
                                    }))}
                                    placeholder="选择 OS"
                                  />
                                </Form.Item>
                              </Col>
                              <Col span={6}>
                                <Form.Item
                                  name={[field.name, 'cpuType']}
                                  label="CPU 架构"
                                  rules={[{ required: true, message: '必选' }]}
                                >
                                  <Select
                                    options={CPU_TYPES.map((o) => ({
                                      value: o,
                                      label: o,
                                    }))}
                                    placeholder="选择 CPU"
                                  />
                                </Form.Item>
                              </Col>
                              <Col span={10}>
                                <Form.Item
                                  name={[field.name, 'target']}
                                  label="目标安装路径"
                                >
                                  <Input placeholder="如 /opt/servers/nginx" />
                                </Form.Item>
                              </Col>
                            </Row>
                            <Form.Item
                              name={[field.name, 'zones']}
                              label="适用网络区域"
                              extra="留空 = 所有区域通用；两区脚本不一致时按区域限定"
                            >
                              <Select
                                mode="multiple"
                                allowClear
                                placeholder="全部区域"
                                options={NETWORK_ZONES.map((z) => ({ value: z, label: z }))}
                              />
                            </Form.Item>
                            <Form.Item
                              name={[field.name, 'pkg']}
                              label="安装包路径（控制节点）"
                              rules={[
                                { required: true, message: '请填写安装包完整路径' },
                              ]}
                            >
                              <Input placeholder="/data/.../files/xxx.tar.gz" />
                            </Form.Item>
                            <Form.Item
                              name={[field.name, 'script']}
                              label="部署脚本路径（控制节点）"
                              extra="解压方式（unarchive）可留空，平台会自动执行包内同名脚本"
                              style={{ marginBottom: 0 }}
                            >
                              <Input placeholder="/data/.../files/deploy-xxx.sh" />
                            </Form.Item>
                          </div>
                        ))}
                        <Button
                          type="dashed"
                          block
                          icon={<PlusOutlined />}
                          onClick={() => add({ osType: 'centos7', cpuType: 'x86_64' })}
                          style={{ marginTop: 4 }}
                        >
                          添加安装包（操作系统 × CPU）
                        </Button>
                      </div>
                    )}
                  </Form.List>
                ),
              },
              {
                key: 'modes',
                label: (
                  <span>
                    <ClusterOutlined /> 部署模式
                  </span>
                ),
                children: (
                  <Form.List name="modeList">
                    {(fields, { add, remove }) => (
                      <div>
                        {fields.length === 0 && (
                          <div className="mw-edit-empty">
                            未配置部署模式，部署时按单机处理
                          </div>
                        )}
                        {fields.map((field) => (
                          <div key={field.key} className="mw-mode-form-card">
                            <div className="mw-mode-form-card__head">
                              <span className="mw-mode-form-card__title">
                                <ClusterOutlined /> 模式 #{field.name + 1}
                              </span>
                              <Button
                                size="small"
                                danger
                                type="text"
                                icon={<DeleteOutlined />}
                                onClick={() => remove(field.name)}
                              >
                                删除
                              </Button>
                            </div>
                            <Row gutter={12}>
                              <Col span={8}>
                                <Form.Item
                                  name={[field.name, 'key']}
                                  label="模式标识"
                                  rules={[{ required: true, message: '必填' }]}
                                >
                                  <Input placeholder="如 cluster" />
                                </Form.Item>
                              </Col>
                              <Col span={8}>
                                <Form.Item
                                  name={[field.name, 'label']}
                                  label="展示名"
                                  rules={[{ required: true, message: '必填' }]}
                                >
                                  <Input placeholder="三主三从集群" />
                                </Form.Item>
                              </Col>
                              <Col span={8}>
                                <Form.Item
                                  name={[field.name, 'topology']}
                                  label="拓扑"
                                  rules={[{ required: true, message: '必选' }]}
                                >
                                  <Select
                                    options={[
                                      { value: 'single', label: '单机（无需拓扑）' },
                                      { value: 'cluster', label: '集群（自动分配主从）' },
                                      { value: 'roles', label: '角色模式（手动指定）' },
                                    ]}
                                  />
                                </Form.Item>
                              </Col>
                            </Row>
                            <ModeExtra fieldName={field.name} />
                          </div>
                        ))}
                        <Button
                          type="dashed"
                          block
                          icon={<PlusOutlined />}
                          onClick={() => add({ topology: 'single' })}
                          style={{ marginTop: 4 }}
                        >
                          添加部署模式
                        </Button>
                      </div>
                    )}
                  </Form.List>
                ),
              },
            ]}
          />
        </Form>
      </Modal>
    </div>
  )
}

// ============== Premium Product Card ==============
function ConfigCard({
  m,
  onView,
  onEdit,
  onDelete,
}: {
  m: DeployMiddleware
  onView: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { hasPerm } = useAuth()
  const color = MW_COLOR[m.name] || '#64748b'
  const desc = MW_DESC[m.name] || m.description || ''
  const versions = safeParseArr(m.versions)
  const pkgs = parsePkgs(m.packages)
  const modes = parseModes(m.modes)
  const osPills = pkgs.slice(0, 4)
  const osMore = pkgs.length - osPills.length

  return (
    <div className="mw-cfg-card">
      <div
        className="mw-cfg-card__accent"
        style={{ background: `linear-gradient(90deg, ${color}, ${color}99)` }}
      />
      <div className="mw-cfg-card__head">
        <div
          className="mw-cfg-card__icon"
          style={{
            background: color,
            boxShadow: `0 6px 18px ${color}55`,
          }}
        >
          <MwBrandIcon type={m.name} size={30} color="#fff" />
        </div>
        <div className="mw-cfg-card__title-wrap">
          <div className="mw-cfg-card__title">{m.label}</div>
        </div>
      </div>
      <div className="mw-cfg-card__desc">{desc || '—'}</div>
      <div className="mw-cfg-card__status">
        {m.ready ? (
          <span className="mw-cfg-card__pill mw-cfg-card__pill--ok">
            <CheckCircleFilled /> 离线包就绪
          </span>
        ) : (
          <span className="mw-cfg-card__pill mw-cfg-card__pill--warn">
            <CloseCircleFilled /> 未就绪
          </span>
        )}
        {m.enabled ? (
          <span className="mw-cfg-card__pill mw-cfg-card__pill--info">已启用</span>
        ) : (
          <span className="mw-cfg-card__pill mw-cfg-card__pill--muted">已停用</span>
        )}
        {m.needCert && (
          <span className="mw-cfg-card__pill mw-cfg-card__pill--cert">
            <SafetyCertificateOutlined /> 需证书
          </span>
        )}
      </div>
      <div className="mw-cfg-card__metrics">
        <div className="mw-cfg-card__metric">
          <div className="mw-cfg-card__metric-v">{versions.length}</div>
          <div className="mw-cfg-card__metric-l">版本</div>
        </div>
        <div className="mw-cfg-card__metric">
          <div className="mw-cfg-card__metric-v">{pkgs.length}</div>
          <div className="mw-cfg-card__metric-l">离线包</div>
        </div>
        <div className="mw-cfg-card__metric">
          <div className="mw-cfg-card__metric-v">{modes.length || 1}</div>
          <div className="mw-cfg-card__metric-l">部署模式</div>
        </div>
      </div>
      {(m.installPath || m.defaultPort || (m.needCert && m.certDir)) && (
        <div className="mw-cfg-card__desc" style={{ marginTop: 6, fontSize: 12 }}>
          {m.installPath ? `安装路径 ${m.installPath}` : ''}
          {m.installPath && m.defaultPort ? ' · ' : ''}
          {m.defaultPort ? `端口 ${m.defaultPort}` : ''}
          {m.needCert && m.certDir ? ` · 证书目录 ${m.certDir}` : ''}
        </div>
      )}
      <div className="mw-cfg-card__os">
        {osPills.map((p) => (
          <span
            key={`${p.osType}_${p.cpuType}`}
            className="mw-cfg-card__os-pill"
          >
            {p.osType}
            <span className="mw-cfg-card__os-sep">/</span>
            {p.cpuType}
          </span>
        ))}
        {osMore > 0 && (
          <span className="mw-cfg-card__os-pill mw-cfg-card__os-pill--more">
            +{osMore}
          </span>
        )}
      </div>
      <div className="mw-cfg-card__footer">
        <Button type="text" size="small" icon={<EyeOutlined />} onClick={onView}>
          详情
        </Button>
        {hasPerm('mwtemplate:update') && (
          <Button type="text" size="small" icon={<EditOutlined />} onClick={onEdit}>
            编辑
          </Button>
        )}
        {hasPerm('mwtemplate:delete') && (
          <Popconfirm
            title="确认删除该中间件配置？"
            description="删除后无法恢复，部署向导中也不再可用"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={onDelete}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        )}
      </div>
    </div>
  )
}

// ============== Detail Body ==============
function DetailBody({ m }: { m: DeployMiddleware }) {
  const color = MW_COLOR[m.name] || '#64748b'
  const desc = MW_DESC[m.name] || m.description || '—'
  const versions = safeParseArr(m.versions)
  const pkgs = parsePkgs(m.packages)
  const modes = parseModes(m.modes)

  return (
    <div className="mw-drawer">
      <div className="mw-drawer__top">
        <div
          className="mw-cfg-card__icon mw-drawer__icon"
          style={{
            background: color,
            boxShadow: `0 6px 20px ${color}55`,
          }}
        >
          <MwBrandIcon type={m.name} size={36} color="#fff" />
        </div>
        <div className="mw-drawer__top-info">
          <div className="mw-drawer__desc">{desc}</div>
          <div className="mw-drawer__status">
            {m.ready ? (
              <span className="mw-cfg-card__pill mw-cfg-card__pill--ok">
                <CheckCircleFilled /> 离线包就绪
              </span>
            ) : (
              <span className="mw-cfg-card__pill mw-cfg-card__pill--warn">
                <CloseCircleFilled /> 未就绪
              </span>
            )}
            <span
              className={`mw-cfg-card__pill ${
                m.enabled ? 'mw-cfg-card__pill--info' : 'mw-cfg-card__pill--muted'
              }`}
            >
              {m.enabled ? '已启用' : '已停用'}
            </span>
            {m.needCert && (
              <span className="mw-cfg-card__pill mw-cfg-card__pill--cert">
                <SafetyCertificateOutlined /> 需证书
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mw-drawer-section">
        <div className="mw-drawer-section__head">
          <TagsOutlined /> 可用版本
        </div>
        <div className="mw-drawer-section__body">
          {versions.length ? (
            <Space wrap>
              {versions.map((v) => (
                <Tag key={v} color="blue">
                  {v}
                </Tag>
              ))}
            </Space>
          ) : (
            <Text type="secondary">—</Text>
          )}
        </div>
      </div>

      <div className="mw-drawer-section">
        <div className="mw-drawer-section__head">
          <CloudServerOutlined /> 部署信息
        </div>
        <div className="mw-drawer-section__body">
          <Row gutter={[12, 8]} style={{ fontSize: 13 }}>
            <Col span={12}>
              <Text type="secondary">部署方式：</Text>
              <Tag color="geekblue">{STYLE_LABELS[m.style || 'copy'] || m.style || 'copy'}</Tag>
            </Col>
            <Col span={12}>
              <Text type="secondary">控制节点目录：</Text>
              {m.subDir || m.name}
            </Col>
            <Col span={12}>
              <Text type="secondary">默认安装路径：</Text>
              {m.installPath || '—'}
            </Col>
            <Col span={12}>
              <Text type="secondary">默认端口：</Text>
              {m.defaultPort || '—'}
            </Col>
            {m.style === 'playbook' && (
              <Col span={24}>
                <Text type="secondary">既有 playbook：</Text>
                <div style={{ wordBreak: 'break-all', marginTop: 4 }}>{m.playbook || '—'}</div>
              </Col>
            )}
          </Row>
        </div>
      </div>

      <div className="mw-drawer-section">
        <div className="mw-drawer-section__head">
          <CloudServerOutlined /> 离线包矩阵（操作系统 × CPU）
        </div>
        <div className="mw-drawer-section__body">
          {pkgs.length ? (
            <div className="mw-pkg-matrix">
              <div className="mw-pkg-matrix__row mw-pkg-matrix__row--head">
                <div>操作系统</div>
                <div>CPU</div>
                <div>区域</div>
                <div>安装包</div>
                <div>部署脚本</div>
                <div>目标路径</div>
              </div>
              {pkgs.map((p) => (
                <div
                  key={`${p.osType}_${p.cpuType}`}
                  className="mw-pkg-matrix__row"
                >
                  <div>
                    <Tag color="blue">{p.osType}</Tag>
                  </div>
                  <div>
                    <Tag>{p.cpuType}</Tag>
                  </div>
                  <div>
                    {p.zones && p.zones.length ? (
                      <Space size={4} wrap>
                        {p.zones.map((z) => (
                          <Tag key={z} color="purple" style={{ marginRight: 0 }}>
                            {z}
                          </Tag>
                        ))}
                      </Space>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        全部
                      </Text>
                    )}
                  </div>
                  <div className="mw-pkg-matrix__path">{p.pkg || '—'}</div>
                  <div className="mw-pkg-matrix__path">{p.script || '—'}</div>
                  <div className="mw-pkg-matrix__path">{p.target || '—'}</div>
                </div>
              ))}
            </div>
          ) : (
            <Text type="secondary">未配置离线包</Text>
          )}
        </div>
      </div>

      <div className="mw-drawer-section">
        <div className="mw-drawer-section__head">
          <ClusterOutlined /> 部署模式
        </div>
        <div className="mw-drawer-section__body">
          {modes.length === 0 ? (
            <Text type="secondary">单机（默认）</Text>
          ) : (
            <div className="mw-drawer-modes">
              {modes.map((md) => (
                <div key={md.key} className="mw-drawer-mode-card">
                  <div className="mw-drawer-mode-card__title">
                    {md.label} <Text type="secondary" code>{md.key}</Text>
                  </div>
                  <div className="mw-drawer-mode-card__meta">
                    <Tag color="geekblue">{TOPO_LABELS[md.topology] || md.topology}</Tag>
                    {md.topology === 'cluster' && (
                      <span>
                        节点 {md.nodeCount} · 每主从库 {md.replicas}
                      </span>
                    )}
                    {md.topology === 'roles' && (
                      <span>角色：{(md.roles || []).join(' / ')}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}