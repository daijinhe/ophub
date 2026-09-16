import { useEffect, useState } from 'react'
import { App, Button, Card, Divider, Input, Modal, Popconfirm, Space, Tag, Alert } from 'antd'
import { PlusOutlined, DeleteOutlined, SettingOutlined } from '@ant-design/icons'
import {
  MwTemplate,
  MwField,
  getMwTemplates,
  upsertMwTemplate,
  deleteMwTemplate,
} from '../api/mw'

interface Props {
  open: boolean
  onClose: () => void
  templates: MwTemplate[]
  onSaved: (next: MwTemplate[]) => void
}

export default function MwTemplateManager({ open, onClose, templates, onSaved }: Props) {
  const { message } = App.useApp()
  const [list, setList] = useState<MwTemplate[]>(templates)
  const [newType, setNewType] = useState('')

  useEffect(() => {
    if (open) setList(templates)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const reload = async () => {
    try {
      const r = await getMwTemplates()
      setList(r)
      onSaved(r)
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '加载失败')
    }
  }

  const updateField = (type: string, idx: number, patch: Partial<MwField>) => {
    setList((prev) =>
      prev.map((t) =>
        t.type === type
          ? { ...t, fields: t.fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)) }
          : t,
      ),
    )
  }

  const addField = (type: string) => {
    setList((prev) =>
      prev.map((t) =>
        t.type === type
          ? { ...t, fields: [...t.fields, { key: '', label: '', default: '', options: [] }] }
          : t,
      ),
    )
  }

  const removeField = (type: string, idx: number) => {
    setList((prev) =>
      prev.map((t) =>
        t.type === type ? { ...t, fields: t.fields.filter((_, i) => i !== idx) } : t,
      ),
    )
  }

  const saveType = async (type: string) => {
    const tpl = list.find((t) => t.type === type)
    if (!tpl) return
    const fields = tpl.fields
      .filter((f) => (f.label || '').trim() !== '')
      .map((f) => ({ ...f, key: f.key || f.label, label: f.label.trim() }))
    try {
      await upsertMwTemplate(type, fields)
      message.success(`已保存「${type}」`)
      await reload()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '保存失败')
    }
  }

  const removeType = async (type: string) => {
    try {
      await deleteMwTemplate(type)
      message.success(`已删除「${type}」`)
      await reload()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '删除失败')
    }
  }

  const addType = async () => {
    const t = (newType || '').trim()
    if (!t) return message.warning('请输入类型名称')
    if (list.some((x) => x.type === t)) return message.warning('该类型已存在')
    try {
      await upsertMwTemplate(t, [{ key: '实例名称', label: '实例名称', default: '', options: [] }])
      setNewType('')
      await reload()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '创建失败')
    }
  }

  return (
    <Modal
      title={
        <Space>
          <SettingOutlined />
          中间件类型管理（字段与默认值）
        </Space>
      }
      open={open}
      onCancel={onClose}
      onOk={onClose}
      okText="完成"
      width={760}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="这里定义的字段与选项会全局共享，新建/编辑任意资产选择该中间件类型时即可直接套用默认值，无需重复填写。"
      />
      <div style={{ maxHeight: 460, overflowY: 'auto', paddingRight: 8 }}>
        {list.length === 0 && <div style={{ opacity: 0.6, padding: 12 }}>暂无类型，请在下方新增。</div>}
        {list.map((t) => (
          <Card
            key={t.type}
            size="small"
            style={{ marginBottom: 12 }}
            title={
              <Space>
                <Tag color="#475569">{t.type}</Tag>
                <span style={{ opacity: 0.6, fontSize: 12 }}>{t.fields.length} 个字段</span>
              </Space>
            }
            extra={
              <Popconfirm title={`删除类型「${t.type}」？`} onConfirm={() => removeType(t.type)}>
                <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                  删除类型
                </Button>
              </Popconfirm>
            }
          >
            <Space direction="vertical" style={{ width: '100%' }} size={6}>
              {t.fields.map((f, idx) => (
                <div
                  key={idx}
                  style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                >
                  <Input
                    placeholder="字段名"
                    style={{ width: 170 }}
                    value={f.label}
                    onChange={(e) => updateField(t.type, idx, { label: e.target.value, key: e.target.value })}
                  />
                  <Input
                    placeholder="默认值"
                    style={{ width: 200 }}
                    value={f.default ?? ''}
                    onChange={(e) => updateField(t.type, idx, { default: e.target.value })}
                  />
                  <Input
                    placeholder="下拉选项，逗号分隔（留空为文本输入）"
                    style={{ width: 220 }}
                    value={(f.options || []).join(', ')}
                    onChange={(e) =>
                      updateField(t.type, idx, {
                        options: e.target.value
                          .split(/[,，]/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                  <Button
                    size="small"
                    type="link"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removeField(t.type, idx)}
                  />
                </div>
              ))}
              <Button
                size="small"
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() => addField(t.type)}
              >
                添加字段
              </Button>
              <Divider style={{ margin: '8px 0' }} />
              <Button size="small" type="primary" onClick={() => saveType(t.type)}>
                保存该类型
              </Button>
            </Space>
          </Card>
        ))}
      </div>
      <Divider style={{ margin: '12px 0' }} />
      <Space>
        <Input
          placeholder="新增中间件类型名称，如 rabbitmq"
          style={{ width: 240 }}
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
          onPressEnter={addType}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={addType}>
          新增类型
        </Button>
      </Space>
    </Modal>
  )
}
