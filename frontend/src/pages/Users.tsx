import { useEffect, useState } from 'react'
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  App,
  Input as SearchInput,
  Popconfirm,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  SearchOutlined,
  EyeOutlined,
  ReloadOutlined,
  CopyOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '../api/client'
import { getRegisterAllowAdmin, setRegisterAllow } from '../api/system'
import { useAuth, type Role, type UserInfo } from '../store/AuthContext'

export default function Users() {
  const { hasPerm, isAdmin } = useAuth()
  const { message } = App.useApp()
  const [data, setData] = useState<UserInfo[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [kw, setKw] = useState('')
  const [loading, setLoading] = useState(false)
  const [roles, setRoles] = useState<Role[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<UserInfo | null>(null)
  const [form] = Form.useForm()
  // 密码查看 / 重置结果弹窗
  const [pwdModal, setPwdModal] = useState<{ open: boolean; title: string; password: string }>({
    open: false,
    title: '',
    password: '',
  })
  // 注册开关（v1.7.45）：null = 还没读到，先不渲染这一块，避免闪成「已关闭」
  const [regAllow, setRegAllow] = useState<boolean | null>(null)
  // 当前值是否来自环境变量 ALLOW_PUBLIC_REGISTER（= 还没在页面上设置过）
  const [regFromEnv, setRegFromEnv] = useState(false)
  const [regSaving, setRegSaving] = useState(false)

  const load = async (p = page, keyword = kw) => {
    setLoading(true)
    try {
      const r = await api.get('/users', { params: { page: p, size: 10, keyword } })
      setData(r.data.data.list)
      setTotal(r.data.data.total)
      setPage(p)
    } finally {
      setLoading(false)
    }
  }

  // 注册开关只对「能编辑用户」的人显示 / 可改（后端同样用 user:update 拦截）
  const loadRegister = async () => {
    if (!hasPerm('user:update')) return
    try {
      const r = await getRegisterAllowAdmin()
      setRegAllow(r.allow)
      setRegFromEnv(r.fromEnv)
    } catch {
      /* 读不到就不显示这一块，不影响用户列表主流程 */
    }
  }

  useEffect(() => {
    load(1)
    api.get('/roles').then((r) => setRoles(r.data.data || []))
    loadRegister()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleRegister = async (v: boolean) => {
    setRegSaving(true)
    try {
      await setRegisterAllow(v)
      setRegAllow(v)
      setRegFromEnv(false) // 一旦在页面上保存过，就由页面开关说了算
      message.success(v ? '已开放自助注册' : '已关闭自助注册')
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '保存失败')
    } finally {
      setRegSaving(false)
    }
  }

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ status: 1, roleIds: [] })
    setOpen(true)
  }

  const openEdit = (u: UserInfo) => {
    setEditing(u)
    form.setFieldsValue({
      ...u,
      roleIds: u.roles.map((r) => r.id),
      password: '',
    })
    setOpen(true)
  }

  const submit = async () => {
    const v = await form.validateFields()
    // Switch 的值为 boolean，后端为 int（1 启用 / 0 禁用），此处统一转换
    const payload = { ...v, status: v.status ? 1 : 0 }
    try {
      if (editing) {
        await api.put(`/users/${editing.id}`, payload)
        message.success('已保存')
      } else {
        await api.post('/users', payload)
        message.success('已创建')
      }
      setOpen(false)
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '操作失败')
    }
  }

  // 查看指定用户密码（仅超级管理员）
  const viewPassword = async (u: UserInfo) => {
    try {
      const r = await api.get(`/users/${u.id}/password`)
      setPwdModal({ open: true, title: `${u.username} 的登录密码`, password: r.data.data.password })
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '获取密码失败')
    }
  }

  // 重置指定用户密码为随机串（仅超级管理员），并展示新密码
  const resetPassword = async (u: UserInfo) => {
    try {
      const r = await api.post(`/users/${u.id}/reset-password`)
      setPwdModal({
        open: true,
        title: `${u.username} 的新密码（请转告用户，关闭后不再显示）`,
        password: r.data.data.password,
      })
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '重置失败')
    }
  }

  const remove = async (u: UserInfo) => {
    try {
      await api.delete(`/users/${u.id}`)
      message.success('已删除')
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '删除失败')
    }
  }

  const columns: ColumnsType<UserInfo> = [
    { title: '用户名', dataIndex: 'username' },
    { title: '昵称', dataIndex: 'nickname' },
    { title: '邮箱', dataIndex: 'email', render: (t) => t || '-' },
    { title: '手机号', dataIndex: 'phone', render: (t) => t || '-' },
    {
      title: '角色',
      dataIndex: 'roles',
      render: (roles: Role[]) => (
        <Space wrap>
          {roles.map((r) => (
            <Tag color="cyan" key={r.id}>
              {r.name}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (s: number) => <Tag color={s === 1 ? 'green' : 'red'}>{s === 1 ? '启用' : '禁用'}</Tag>,
    },
    {
      title: '操作',
      width: 300,
      render: (_, u) => {
        const canEdit = hasPerm('user:update')
        const canDel = hasPerm('user:delete')
        if (!canEdit && !canDel && !isAdmin) return null
        return (
          <Space wrap>
            {isAdmin && (
              <Button size="small" icon={<EyeOutlined />} onClick={() => viewPassword(u)}>
                查看密码
              </Button>
            )}
            {isAdmin && (
              <Popconfirm
                title="确认重置该用户密码？将生成随机新密码"
                onConfirm={() => resetPassword(u)}
              >
                <Button size="small" icon={<ReloadOutlined />}>
                  重置密码
                </Button>
              </Popconfirm>
            )}
            {canEdit && (
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(u)}>
                编辑
              </Button>
            )}
            {canDel && (
              <Popconfirm title="确认删除该用户？" onConfirm={() => remove(u)}>
                <Button size="small" danger icon={<DeleteOutlined />}>
                  删除
                </Button>
              </Popconfirm>
            )}
          </Space>
        )
      },
    },
  ]

  return (
    <Card
      className="glass"
      style={{ border: 'none' }}
      title="用户管理"
      extra={
        hasPerm('user:create') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建用户
          </Button>
        )
      }
    >
      {/* 注册设置（v1.7.45）：这是「用户从哪来」的总开关 —— 与新建用户按钮同权限，只对能管用户的人显示 */}
      {hasPerm('user:update') && regAllow !== null && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            padding: '10px 14px',
            marginBottom: 16,
            border: '1px solid var(--border-soft)',
            borderRadius: 10,
            background: 'rgba(148,163,184,0.08)',
          }}
        >
          <Switch size="small" checked={regAllow} loading={regSaving} onChange={toggleRegister} />
          <span style={{ fontWeight: 500 }}>允许自助注册</span>
          <Tag color={regAllow ? 'green' : 'default'}>{regAllow ? '已开启' : '已关闭'}</Tag>
          <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
            开启后登录页出现「立即注册」；新注册账号
            <b>默认没有任何权限</b>，需在本页为其分配角色。
            {regFromEnv ? '（当前值来自环境变量，在此保存后改由本开关控制）' : ''}
          </span>
        </div>
      )}
      <Space style={{ marginBottom: 16 }}>
        <SearchInput
          allowClear
          placeholder="搜索用户名 / 昵称 / 邮箱"
          prefix={<SearchOutlined />}
          style={{ width: 280 }}
          onChange={(e) => setKw(e.target.value)}
          onPressEnter={() => load(1, kw)}
        />
        <Button onClick={() => load(1, kw)}>查询</Button>
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={data}
        pagination={{
          current: page,
          total,
          pageSize: 10,
          onChange: (p) => load(p),
        }}
      />

      <Modal
        title={editing ? '编辑用户' : '新建用户'}
        open={open}
        onOk={submit}
        onCancel={() => setOpen(false)}
        destroyOnClose
        width={520}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input disabled={!!editing} />
          </Form.Item>
          <Form.Item
            name="password"
            label={editing ? '密码（留空则不修改）' : '密码'}
            rules={editing ? [] : [{ required: true, message: '请输入密码' }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item name="nickname" label="昵称">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="邮箱">
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="手机号">
            <Input />
          </Form.Item>
          <Form.Item name="roleIds" label="角色" rules={[{ required: true, message: '请选择角色' }]}>
            <Select mode="multiple" placeholder="选择角色" options={roles.map((r) => ({ value: r.id, label: r.name }))} />
          </Form.Item>
          <Form.Item name="status" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* 密码查看 / 重置结果 */}
      <Modal
        title={pwdModal.title}
        open={pwdModal.open}
        onCancel={() => setPwdModal((s) => ({ ...s, open: false }))}
        footer={null}
        destroyOnClose
      >
        <Space.Compact style={{ width: '100%' }}>
          <Input readOnly value={pwdModal.password} />
          <Button
            icon={<CopyOutlined />}
            onClick={() => {
              navigator.clipboard?.writeText(pwdModal.password)
              message.success('已复制到剪贴板')
            }}
          >
            复制
          </Button>
        </Space.Compact>
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <Button type="primary" onClick={() => setPwdModal((s) => ({ ...s, open: false }))}>
            知道了
          </Button>
        </div>
      </Modal>
    </Card>
  )
}
