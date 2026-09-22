import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  ApiOutlined,
  CloudOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import {
  createPromDataSource,
  deletePromDataSource,
  listPromDataSources,
  testPromDataSource,
  updatePromDataSource,
  type PromDataSource,
  type PromDSBody,
  type PromTestResult,
} from '../api/prometheus'
import { useAuth } from '../store/AuthContext'

const { Title, Text } = Typography

function errMsg(e: any, fallback = '操作失败'): string {
  return e?.response?.data?.msg || e?.message || fallback
}

const AUTH_LABEL: Record<string, string> = {
  none: '无认证',
  basic: 'Basic',
  bearer: 'Bearer Token',
}

/**
 * Prometheus 数据源管理（v1.8.0）
 *
 * 数据源 = Prometheus Server 地址（http://prom:9090）+ 可选认证。
 * 平台对 Prometheus 全部为只读查询（官方 /api/v1/*），凭据只存后端、
 * 前端与浏览器永远接触不到 Basic 密码 / Bearer Token。
 */
export default function PromDataSources() {
  const { hasPerm } = useAuth()
  const canManage = hasPerm('prom:manage')

  const [list, setList] = useState<PromDataSource[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<PromDataSource | null>(null)
  const [testing, setTesting] = useState<number | 'form' | null>(null)
  const [form] = Form.useForm<PromDSBody>()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await listPromDataSources()
      setList(r.list || [])
    } catch (e) {
      message.error('加载数据源失败:' + errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ authType: 'none', enabled: 1 })
    setModalOpen(true)
  }

  const openEdit = (ds: PromDataSource) => {
    setEditing(ds)
    form.resetFields()
    form.setFieldsValue({
      name: ds.name,
      url: ds.url,
      authType: ds.authType,
      username: ds.username,
      enabled: ds.enabled,
      remark: ds.remark,
      // 密码 / token 不回填（安全）：留空 = 保持原值
    })
    setModalOpen(true)
  }

  const submit = async () => {
    const vals = await form.validateFields()
    try {
      if (editing) {
        await updatePromDataSource(editing.id, vals)
        message.success('已保存')
      } else {
        await createPromDataSource(vals)
        message.success('已创建')
      }
      setModalOpen(false)
      load()
    } catch (e) {
      message.error(errMsg(e))
    }
  }

  /** 表单内直接测试（未保存也能测） */
  const testForm = async () => {
    const vals = await form.validateFields()
    setTesting('form')
    try {
      const r = await testPromDataSource(editing?.id || 0, vals)
      showTest(r)
    } catch (e) {
      message.error('连接失败:' + errMsg(e, '目标不可达'))
    } finally {
      setTesting(null)
    }
  }

  const testRow = async (ds: PromDataSource) => {
    setTesting(ds.id)
    try {
      const r = await testPromDataSource(ds.id)
      showTest(r)
    } catch (e) {
      message.error('连接失败:' + errMsg(e, '目标不可达'))
    } finally {
      setTesting(null)
    }
  }

  const showTest = (r: PromTestResult) => {
    Modal.info({
      title: '连接成功',
      content: (
        <div style={{ lineHeight: 2 }}>
          <div>延迟：{r.elapsedMs} ms</div>
          <div>
            采集目标：{r.targets} 个（在线 {r.online} / 离线 {r.offline}）
          </div>
          {r.version && <div>Server 版本：{r.version}</div>}
        </div>
      ),
      okText: '知道了',
    })
  }

  const remove = async (ds: PromDataSource) => {
    try {
      await deletePromDataSource(ds.id)
      message.success('已删除:' + ds.name)
      load()
    } catch (e) {
      message.error(errMsg(e))
    }
  }

  const columns: ColumnsType<PromDataSource> = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 180,
      render: (v: string) => (
        <Space>
          <CloudOutlined style={{ color: 'var(--accent)' }} />
          <Text strong>{v}</Text>
        </Space>
      ),
    },
    { title: '地址', dataIndex: 'url', ellipsis: true },
    {
      title: '认证方式',
      dataIndex: 'authType',
      width: 130,
      render: (v: string, r: PromDataSource) => (
        <Space size={4}>
          <Tag color={v === 'none' ? 'default' : 'blue'}>{AUTH_LABEL[v] || v}</Tag>
          {r.authConfigured && <Tag color="green">已配置凭据</Tag>}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 90,
      render: (v: number) =>
        v === 1 ? <Tag color="success">启用</Tag> : <Tag color="default">停用</Tag>,
    },
    { title: '备注', dataIndex: 'remark', ellipsis: true },
    { title: '更新时间', dataIndex: 'updatedAt', width: 170, render: (v: string) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—') },
    {
      title: '操作',
      key: 'ops',
      width: 220,
      render: (_, r: PromDataSource) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            loading={testing === r.id}
            onClick={() => testRow(r)}
          >
            测试
          </Button>
          {canManage && (
            <>
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
                编辑
              </Button>
              <Popconfirm
                title={`确认删除数据源「${r.name}」?`}
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => remove(r)}
              >
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          <ApiOutlined style={{ marginRight: 8 }} />
          Prometheus 数据源管理
        </Title>
        <Tag color="purple">v1.8.0</Tag>
        <div style={{ flex: 1 }} />
        {canManage && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            添加数据源
          </Button>
        )}
      </div>

      <Card size="small">
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={list}
          loading={loading}
          pagination={false}
          locale={{ emptyText: '暂无数据源，请点击右上角「添加数据源」' }}
        />
      </Card>

      <Modal
        title={editing ? `编辑数据源：${editing.name}` : '添加 Prometheus 数据源'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={submit}
        okText={editing ? '保存' : '创建'}
        cancelText="取消"
        width={620}
        destroyOnClose
        footer={
          <Space>
            <Button onClick={() => setModalOpen(false)}>取消</Button>
            <Button icon={<ThunderboltOutlined />} loading={testing === 'form'} onClick={testForm}>
              测试连接
            </Button>
            <Button type="primary" onClick={submit}>
              {editing ? '保存' : '创建'}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请填写名称' }]}
          >
            <Input placeholder="生产环境-Prometheus" />
          </Form.Item>
          <Form.Item
            name="url"
            label="地址"
            rules={[
              { required: true, message: '请填写 Prometheus 地址' },
              { pattern: /^https?:\/\//, message: '必须以 http:// 或 https:// 开头' },
            ]}
            extra="形如 http://prometheus:9090；平台对它只做只读查询"
          >
            <Input placeholder="http://prometheus:9090" />
          </Form.Item>
          <Form.Item name="authType" label="认证方式" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'none', label: '无认证' },
                { value: 'basic', label: 'Basic 认证' },
                { value: 'bearer', label: 'Bearer Token' },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.authType !== b.authType}>
            {({ getFieldValue }) => {
              const t = getFieldValue('authType')
              if (t === 'basic') {
                return (
                  <>
                    <Form.Item name="username" label="用户名" rules={[{ required: !editing, message: 'Basic 认证需要填写用户名' }]}>
                      <Input autoComplete="off" />
                    </Form.Item>
                    <Form.Item
                      name="password"
                      label="密码"
                      extra={editing ? '留空 = 保持原密码' : undefined}
                      rules={[{ required: !editing, message: 'Basic 认证需要填写密码' }]}
                    >
                      <Input.Password autoComplete="new-password" />
                    </Form.Item>
                  </>
                )
              }
              if (t === 'bearer') {
                return (
                  <Form.Item
                    name="bearerToken"
                    label="Bearer Token"
                    extra={editing ? '留空 = 保持原 Token' : undefined}
                    rules={[{ required: !editing, message: 'Bearer 认证需要填写 Token' }]}
                  >
                    <Input.Password autoComplete="new-password" placeholder="eyJhbGciOi..." />
                  </Form.Item>
                )
              }
              return null
            }}
          </Form.Item>
          <Form.Item
            name="enabled"
            label="启用"
            valuePropName="checked"
            getValueFromEvent={(v: boolean) => (v ? 1 : 0)}
            getValueProps={(v) => ({ checked: !!v })}
          >
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} placeholder="用途 / 负责人 / 网络位置" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
