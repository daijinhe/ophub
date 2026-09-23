import { useState, useEffect } from 'react'
import { Form, Input, Button, ConfigProvider, App } from 'antd'
import { UserOutlined, LockOutlined } from '@ant-design/icons'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../store/AuthContext'
import { getRegisterAllow } from '../api/system'
import { darkTheme } from '../theme'
import BrandLogo from '../components/BrandLogo'
import '../styles/login.css'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  // 是否显示「立即注册」由「系统管理 → 用户管理 → 注册设置」决定。
  // 用 null 表示「还没读到」，读到之前这一段不渲染 —— 否则会先闪一下「注册已关闭」再变。
  const [allowRegister, setAllowRegister] = useState<boolean | null>(null)

  useEffect(() => {
    getRegisterAllow()
      .then(setAllowRegister)
      .catch(() => setAllowRegister(false))
  }, [])

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
    // 门户页固定深色：嵌套一层 ConfigProvider 让 antd 组件用 darkAlgorithm，
    // 不跟随应用内主题（登录前也拿不到用户主题偏好）
    <ConfigProvider theme={darkTheme}>
      <div className="xy-auth">
        <div className="xy-card">
          <div style={{ textAlign: 'center', marginBottom: 30 }}>
            <BrandLogo size={64} />
            <h1 className="xy-title" style={{ marginTop: 20 }}>
              云枢 OpsHub
            </h1>
            {/* 英文副标与巡检大屏顶栏同一句，品牌口径统一 */}
            <div className="xy-sub">XIANGYUN VM INSPECTION PLATFORM</div>
          </div>

          <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false}>
            <Form.Item
              name="username"
              rules={[{ required: true, message: '请输入用户名' }]}
              style={{ marginBottom: 16 }}
            >
              <Input
                prefix={<UserOutlined />}
                placeholder="用户名"
                size="large"
                autoComplete="username"
              />
            </Form.Item>
            <Form.Item
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
              style={{ marginBottom: 26 }}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder="密码"
                size="large"
                autoComplete="current-password"
              />
            </Form.Item>
            <Form.Item style={{ marginBottom: 0 }}>
              <Button className="xy-submit" type="primary" htmlType="submit" block size="large">
                登 录
              </Button>
            </Form.Item>
          </Form>

          <div className="xy-foot" style={{ textAlign: 'center', marginTop: 22, minHeight: 20 }}>
            {allowRegister === null ? null : allowRegister ? (
              <>
                还没有账号？ <Link to="/register">立即注册</Link>
              </>
            ) : (
              <span style={{ color: '#5a6a7f' }}>自助注册已关闭 · 账号请联系管理员开通</span>
            )}
          </div>
        </div>
        <div className="xy-meta">云枢 OpsHub · v1.7.45</div>
      </div>
    </ConfigProvider>
  )
}
