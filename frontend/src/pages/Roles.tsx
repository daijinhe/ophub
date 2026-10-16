// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from 'react'
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Tree,
  App,
  Popconfirm,
  Typography,
  Alert,
  Empty,
} from 'antd'
import type { DataNode } from 'antd/es/tree'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '../api/client'
import { useAuth, type Role, type MenuNode } from '../store/AuthContext'

/**
 * 权限树：层级与侧边栏菜单**严格一致**（由后端 perm_tree.go 下发）。
 *
 * 节点的 key 有两类：
 *   - 叶子 = 权限码本身（如 cmdb:create），勾选后提交给后端；
 *   - 容器 = `#<menuKey>`（带 # 前缀，不会与 `资源:动作` 形式的权限码混淆），
 *     只用于承载层级与「一键全选子项」，提交前会被 codeSet 过滤掉。
 */
function toTreeData(nodes: MenuNode[]): DataNode[] {
  const out: DataNode[] = []
  for (const n of nodes) {
    const children: DataNode[] = []
    for (const p of n.permItems || []) {
      children.push({ key: p.code, title: p.name, isLeaf: true })
    }
    if (n.children && n.children.length > 0) {
      children.push(...toTreeData(n.children))
    }
    if (children.length === 0) continue
    const suffix = n.noMenu ? '（页内功能）' : n.hidden ? '（不占菜单）' : ''
    out.push({
      key: `#${n.key}`,
      title: `${n.label}${suffix}`,
      children,
    })
  }
  return out
}

/** 收集树里的全部权限码（用于「全选」） */
function allCodesOf(nodes: MenuNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    for (const p of n.permItems || []) out.push(p.code)
    if (n.children && n.children.length > 0) out.push(...allCodesOf(n.children))
  }
  return out
}

export default function Roles() {
  const { hasPerm, menuTree } = useAuth()
  const { message } = App.useApp()
  const [data, setData] = useState<Role[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Role | null>(null)
  const [checked, setChecked] = useState<string[]>([])
  const [form] = Form.useForm()

  const codeSet = useMemo(() => {
    const s = new Set<string>()
    for (const c of allCodesOf(menuTree)) s.add(c)
    return s
  }, [menuTree])

  const treeData = useMemo(() => toTreeData(menuTree), [menuTree])

  const load = async () => {
    const r = await api.get('/roles')
    setData(r.data.data || [])
  }

  useEffect(() => {
    load()
  }, [])

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    setChecked([])
    setOpen(true)
  }

  const openEdit = (r: Role) => {
    setEditing(r)
    form.setFieldsValue({ ...r })
    setChecked(r.permissions || [])
    setOpen(true)
  }

  const submit = async () => {
    const v = await form.validateFields()
    // Tree 在联动模式下回传的 keys 里会带上容器节点（`#middleware` 之类），
    // 必须只保留真实权限码 —— 否则后端会因「未知权限码」整单拒绝。
    const permissions = checked.filter((c) => codeSet.has(c))
    const payload = { ...v, permissions }
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

  /** 权限码 → 中文名（用于列表里回显授权内容） */
  const nameOf = useMemo(() => {
    const m = new Map<string, string>()
    const walk = (nodes: MenuNode[]) => {
      for (const n of nodes) {
        for (const p of n.permItems || []) m.set(p.code, p.name)
        if (n.children) walk(n.children)
      }
    }
    walk(menuTree)
    return m
  }, [menuTree])

  const columns: ColumnsType<Role> = [
    { title: '名称', dataIndex: 'name' },
    { title: '编码', dataIndex: 'code', render: (t) => <Tag color="blue">{t}</Tag> },
    { title: '描述', dataIndex: 'description', render: (t) => t || '-' },
    {
      title: '权限数',
      dataIndex: 'permissions',
      width: 90,
      render: (p: string[]) => <Tag color="cyan">{p?.length || 0}</Tag>,
    },
    {
      title: '权限明细',
      dataIndex: 'permissions',
      render: (p: string[]) =>
        p?.length ? (
          <Space size={[4, 4]} wrap style={{ maxWidth: 420 }}>
            {p.slice(0, 6).map((c) => (
              <Tag key={c} style={{ marginInlineEnd: 0 }}>
                {nameOf.get(c) || c}
              </Tag>
            ))}
            {p.length > 6 && <Tag>… 共 {p.length} 项</Tag>}
          </Space>
        ) : (
          <Typography.Text type="secondary">未授权</Typography.Text>
        ),
    },
    {
      title: '操作',
      width: 170,
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
        title={editing ? `编辑角色：${editing.name}` : '新建角色'}
        open={open}
        onOk={submit}
        onCancel={() => setOpen(false)}
        destroyOnClose
        width={760}
        styles={{ body: { maxHeight: '62vh', overflow: 'auto' } }}
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
        </Form>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography.Text strong style={{ color: 'var(--accent)' }}>
            权限分配
          </Typography.Text>
          <Space size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已选 {checked.length} 项
            </Typography.Text>
            <Button size="small" type="link" onClick={() => setChecked([...codeSet])}>
              全选
            </Button>
            <Button size="small" type="link" onClick={() => setChecked([])}>
              清空
            </Button>
          </Space>
        </div>
        <Alert
          type="info"
          showIcon
          style={{ margin: '10px 0 12px' }}
          message="层级与左侧菜单一致；勾选页面名称即授予该页面的全部操作权限。"
          description="账号登录后只显示已授权页面。若某页面只勾了「新增」没勾「查看」，该账号仍看不到这个菜单 —— 请按需勾选「查看」。"
        />
        {treeData.length === 0 ? (
          <Empty description="权限树加载中…" />
        ) : (
          <Tree
            checkable
            defaultExpandAll
            selectable={false}
            treeData={treeData}
            checkedKeys={checked}
            onCheck={(keys) => {
              // 联动模式下 keys 为 Key[]（含容器节点），过滤后只留真实权限码
              const arr = (Array.isArray(keys) ? keys : keys.checked).map(String)
              setChecked(arr.filter((k) => codeSet.has(k)))
            }}
            style={{ paddingBottom: 4 }}
          />
        )}
      </Modal>
    </Card>
  )
}
