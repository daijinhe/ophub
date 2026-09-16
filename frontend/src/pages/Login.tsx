import { Card, Form, Input, Button, Typography, App } from 'antd'
import { UserOutlined, LockOutlined, CloudOutlined } from '@ant-design/icons'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../store/AuthContext'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [form] = Form.useForm()

  const onFinish = async (v: any) => {
    try {
      await login(v.username, v.password)
      message.success('登录成功')
      navigate('/')
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '登录失败')
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
      <Card className="glass fade-up" style={{ width: 400, border: 'none' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <CloudOutlined style={{ fontSize: 40, color: 'var(--accent)' }} />
          <Typography.Title level={3} className="glow-text" style={{ marginTop: 12, marginBottom: 4 }}>
            个人工作空间
          </Typography.Title>
          <Typography.Text type="secondary">统一认证 · 资产管理 · 权限治理</Typography.Text>
        </div>
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" size="large" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" htmlType="submit" block size="large">
              登 录
            </Button>
          </Form.Item>
        </Form>
        <div style={{ textAlign: 'center' }}>
          <Typography.Text type="secondary">还没有账号？</Typography.Text>{' '}
          <Link to="/register">立即注册</Link>
        </div>
      </Card>
    </div>
  )
}
