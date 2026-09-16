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
  Checkbox,
  App,
  Popconfirm,
  Typography,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '../api/client'
import { useAuth, type Role } from '../store/AuthContext'

interface PermDef {
  code: string
  name: string
  group: string
}

export default function Roles() {
  const { hasPerm } = useAuth()
  const { message } = App.useApp()
  const [data, setData] = useState<Role[]>([])
  const [catalog, setCatalog] = useState<PermDef[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Role | null>(null)
  const [form] = Form.useForm()

  const load = async () => {
    const r = await api.get('/roles')
    setData(r.data.data || [])
  }

  useEffect(() => {
    load()
    api.get('/permissions').then((r) => setCatalog(r.data.data || []))
  }, [])

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ permissions: [] })
    setOpen(true)
  }

  const openEdit = (r: Role) => {
    setEditing(r)
    form.setFieldsValue({ ...r })
    setOpen(true)
  }

  const submit = async () => {
    const v = await form.validateFields()
    // permissions 契约必须是权限码数组。历史踩坑：Checkbox.Group 没绑到 Form 时
    // 会拿到单个字符串，提交后后端只回一句「参数错误」，很难定位 —— 这里显式拦下。
    if (v.permissions != null && !Array.isArray(v.permissions)) {
      message.error('权限分配数据异常，请重新勾选后再保存')
      return
    }
    const payload = { ...v, permissions: Array.isArray(v.permissions) ? v.permissions : [] }
    try {
      if (editing) {
        await api.put(`/roles/${editing.id}`, payload)
        message.success('已保存')
      } else {
        await api.post('/roles', payload)
        message.success('已创建')
      }
      setOpen(false)
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '操作失败')
    }
  }

  const remove = async (r: Role) => {
    try {
      await api.delete(`/roles/${r.id}`)
      message.success('已删除')
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '删除失败')
    }
  }

  // 按 group 分组
  const groups = Array.from(new Set(catalog.map((c) => c.group)))
  const permByGroup: Record<string, PermDef[]> = {}
  catalog.forEach((c) => {
    permByGroup[c.group] = permByGroup[c.group] || []
    permByGroup[c.group].push(c)
  })

  const columns: ColumnsType<Role> = [
    { title: '名称', dataIndex: 'name' },
    { title: '编码', dataIndex: 'code', render: (t) => <Tag color="blue">{t}</Tag> },
    { title: '描述', dataIndex: 'description', render: (t) => t || '-' },
    {
      title: '权限数',
      dataIndex: 'permissions',
      render: (p: string[]) => <Tag color="cyan">{p?.length || 0}</Tag>,
    },
    {
      title: '操作',
      render: (_, r) =>
        hasPerm('role:update') || hasPerm('role:delete') ? (
          <Space>
            {hasPerm('role:update') && (
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
                编辑
              </Button>
            )}
            {hasPerm('role:delete') && r.code !== 'admin' && (
              <Popconfirm title="确认删除该角色？" onConfirm={() => remove(r)}>
                <Button size="small" danger icon={<DeleteOutlined />}>
                  删除
                </Button>
              </Popconfirm>
            )}
          </Space>
        ) : null,
    },
  ]

  return (
    <Card
      className="glass"
      style={{ border: 'none' }}
      title="角色权限"
      extra={
        hasPerm('role:create') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建角色
          </Button>
        )
      }
    >
      <Table rowKey="id" columns={columns} dataSource={data} pagination={false} />

      <Modal
        title={editing ? '编辑角色' : '新建角色'}
        open={open}
        onOk={submit}
        onCancel={() => setOpen(false)}
        destroyOnClose
        width={620}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="角色名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="code"
            label="角色编码"
            rules={[{ required: true, message: '请输入编码' }]}
          >
            <Input disabled={!!editing} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input />
          </Form.Item>
          {/*
            ⚠️ Form.Item 的**直接子元素**必须是被控组件本身（Checkbox.Group）。
            之前这里用 <div> 包住了 Checkbox.Group，Form 注入的 value/onChange 落在 div 上：
              ① 角色已有权限不回显（勾选框全空）；
              ② 点击复选框时事件冒泡到 div，antd 的 defaultGetValueFromEvent 取到
                 event.target.value（单个权限码字符串）作为表单值 →
                 提交 body 变成 permissions:"inspection:screen" →
                 后端 []string 反序列化失败 → 报「参数错误」。
          */}
          <Form.Item name="permissions" label="权限分配">
            <Checkbox.Group style={{ display: 'block' }}>
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                {groups.map((g) => (
                  <div key={g} style={{ marginBottom: 14 }}>
                    <Typography.Text strong style={{ color: 'var(--accent)' }}>
                      {g}
                    </Typography.Text>
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {permByGroup[g].map((p) => (
                        <Checkbox key={p.code} value={p.code}>
                          {p.name}
                        </Checkbox>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Checkbox.Group>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
