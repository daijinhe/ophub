import { Card, Form, Input, Button, Typography, App } from 'antd'
import { UserOutlined, LockOutlined, MailOutlined, PhoneOutlined, CloudOutlined } from '@ant-design/icons'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../store/AuthContext'

export default function Register() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [form] = Form.useForm()

  const onFinish = async (v: any) => {
    try {
      await register({
        username: v.username,
        password: v.password,
        nickname: v.nickname,
        email: v.email,
        phone: v.phone,
      })
      message.success('注册成功，请登录')
      navigate('/login')
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '注册失败')
    }
  }

  return (
    <div
      className="tech-grid"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <Card className="glass fade-up" style={{ width: 420, border: 'none' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <CloudOutlined style={{ fontSize: 40, color: 'var(--accent)' }} />
          <Typography.Title level={3} className="glow-text" style={{ marginTop: 12, marginBottom: 4 }}>
            创建账号
          </Typography.Title>
          <Typography.Text type="secondary">加入个人工作空间</Typography.Text>
        </div>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" size="large" />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }, { min: 6, message: '密码至少 6 位' }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="密码（至少 6 位）" size="large" />
          </Form.Item>
          <Form.Item
            name="confirm"
            dependencies={['password']}
            rules={[
              { required: true, message: '请确认密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) return Promise.resolve()
                  return Promise.reject(new Error('两次密码不一致'))
                },
              }),
            ]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="确认密码" size="large" />
          </Form.Item>
          <Form.Item name="nickname">
            <Input placeholder="昵称（可选）" size="large" />
          </Form.Item>
          <Form.Item name="email">
            <Input prefix={<MailOutlined />} placeholder="邮箱（可选）" size="large" />
          </Form.Item>
          <Form.Item name="phone">
            <Input prefix={<PhoneOutlined />} placeholder="手机号（可选）" size="large" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" htmlType="submit" block size="large">
              注 册
            </Button>
          </Form.Item>
        </Form>
        <div style={{ textAlign: 'center' }}>
          <Typography.Text type="secondary">已有账号？</Typography.Text>{' '}
          <Link to="/login">返回登录</Link>
        </div>
      </Card>
    </div>
  )
}
