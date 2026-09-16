import { useEffect, useState } from 'react'
import {
  Modal,
  Form,
  Input,
  Button,
  Space,
  Tag,
  Typography,
  Divider,
  App,
  Row,
  Col,
} from 'antd'
import { EyeOutlined, EyeInvisibleOutlined, KeyOutlined } from '@ant-design/icons'
import api from '../api/client'
import { useAuth } from '../store/AuthContext'

// 个人中心：查看自己的登录密码 / 修改自己的密码
export default function AccountModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { user } = useAuth()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [loadingPwd, setLoadingPwd] = useState(false)

  // 每次打开重置状态，避免上次查看的明文残留
  useEffect(() => {
    if (open) {
      form.resetFields()
      setRevealed(null)
    }
  }, [open, form])

  const revealPassword = async () => {
    if (revealed !== null) {
      setRevealed(null)
      return
    }
    setLoadingPwd(true)
    try {
      const r = await api.get('/auth/password')
      setRevealed(r.data.data.password || '')
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '获取密码失败')
    } finally {
      setLoadingPwd(false)
    }
  }

  const submit = async () => {
    const v = await form.validateFields()
    setSubmitting(true)
    try {
      await api.post('/auth/change-password', {
        oldPassword: v.oldPassword,
        newPassword: v.newPassword,
      })
      message.success('密码已修改')
      form.resetFields()
      setRevealed(null)
      onClose()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '修改失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={
        <Space>
          <KeyOutlined style={{ color: 'var(--accent)' }} />
          个人中心
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnClose
      width={520}
    >
      <Row gutter={12} style={{ marginBottom: 4 }}>
        <Col span={8}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            用户名
          </Typography.Text>
          <div>{user?.username || '-'}</div>
        </Col>
        <Col span={8}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            昵称
          </Typography.Text>
          <div>{user?.nickname || '-'}</div>
        </Col>
        <Col span={8}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            角色
          </Typography.Text>
          <div>
            <Space wrap size={4}>
              {(user?.roles || []).map((r) => (
                <Tag color="cyan" key={r.id}>
                  {r.name}
                </Tag>
              ))}
              {!user?.roles?.length && '-'}
            </Space>
          </div>
        </Col>
      </Row>

      <Divider style={{ margin: '16px 0' }}>查看当前密码</Divider>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          readOnly
          value={revealed === null ? '••••••••' : revealed}
          placeholder="点击右侧按钮查看"
        />
        <Button
          icon={revealed === null ? <EyeOutlined /> : <EyeInvisibleOutlined />}
          loading={loadingPwd}
          onClick={revealPassword}
        >
          {revealed === null ? '查看' : '隐藏'}
        </Button>
      </Space.Compact>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        仅显示你自己的登录密码；历史账号若提示无记录，修改一次密码后即可查看。
      </Typography.Text>

      <Divider style={{ margin: '16px 0' }}>修改密码</Divider>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item
          name="oldPassword"
          label="原密码"
          rules={[{ required: true, message: '请输入原密码' }]}
        >
          <Input.Password placeholder="当前登录密码" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码"
          rules={[
            { required: true, message: '请输入新密码' },
            { min: 6, message: '新密码长度至少 6 位' },
          ]}
          hasFeedback
        >
          <Input.Password placeholder="至少 6 位" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="确认新密码"
          dependencies={['newPassword']}
          hasFeedback
          rules={[
            { required: true, message: '请再次输入新密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('newPassword') === value) return Promise.resolve()
                return Promise.reject(new Error('两次输入的密码不一致'))
              },
            }),
          ]}
        >
          <Input.Password placeholder="再次输入新密码" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={submitting} block>
          保存修改
        </Button>
      </Form>
    </Modal>
  )
}
