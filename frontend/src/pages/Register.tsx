import { useState, useEffect } from 'react'
import { Form, Input, Button, ConfigProvider, App, Alert } from 'antd'
import { UserOutlined, LockOutlined, MailOutlined, PhoneOutlined } from '@ant-design/icons'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../store/AuthContext'
import { getRegisterAllow } from '../api/system'
import { lightTheme } from '../theme'
import BrandLogo from '../components/BrandLogo'
import '../styles/login.css'

export default function Register() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  // null = 还没读到（先不渲染表单，避免「先显示表单又整块换成已关闭提示」的跳动）
  const [allowRegister, setAllowRegister] = useState<boolean | null>(null)

  useEffect(() => {
    getRegisterAllow()
      .then(setAllowRegister)
      .catch(() => setAllowRegister(false))
  }, [])

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
    // 与登录页同一套固定浅色门户视觉
    <ConfigProvider theme={lightTheme}>
      <div className="xy-auth">
        <div className="xy-card" style={{ width: 440 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <BrandLogo size={56} />
            <h1 className="xy-title" style={{ marginTop: 16, fontSize: 23 }}>
              创建账号
            </h1>
            <div className="xy-sub">XIANGYUN VM INSPECTION PLATFORM</div>
          </div>

          {allowRegister === null ? null : allowRegister === false ? (
            /* 管理员关了注册：不渲染表单，直接给出去哪申请 —— 比让用户填完再报错友好 */
            <>
              <Alert
                type="warning"
                showIcon
                message="自助注册已关闭"
                description="请将用户名和用途告知管理员，由管理员在「系统管理 → 用户管理」里创建账号并分配权限。"
              />
              <div className="xy-foot" style={{ textAlign: 'center', marginTop: 22 }}>
                <Link to="/login">返回登录</Link>
              </div>
            </>
          ) : (
            <>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 18 }}
                message="注册后账号默认没有任何权限"
                description="需要管理员在「系统管理 → 用户管理」里分配角色后，才能看到对应功能。"
              />
              <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false}>
                <Form.Item
                  name="username"
                  rules={[{ required: true, message: '请输入用户名' }]}
                  style={{ marginBottom: 14 }}
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
                  rules={[
                    { required: true, message: '请输入密码' },
                    { min: 6, message: '密码至少 6 位' },
                  ]}
                  style={{ marginBottom: 14 }}
                >
                  <Input.Password
                    prefix={<LockOutlined />}
                    placeholder="密码（至少 6 位）"
                    size="large"
                    autoComplete="new-password"
                  />
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
                  style={{ marginBottom: 14 }}
                >
                  <Input.Password
                    prefix={<LockOutlined />}
                    placeholder="确认密码"
                    size="large"
                    autoComplete="new-password"
                  />
                </Form.Item>
                <Form.Item name="nickname" style={{ marginBottom: 14 }}>
                  <Input placeholder="昵称（可选）" size="large" />
                </Form.Item>
                <Form.Item name="email" style={{ marginBottom: 14 }}>
                  <Input prefix={<MailOutlined />} placeholder="邮箱（可选）" size="large" />
                </Form.Item>
                <Form.Item name="phone" style={{ marginBottom: 22 }}>
                  <Input prefix={<PhoneOutlined />} placeholder="手机号（可选）" size="large" />
                </Form.Item>
                <Form.Item style={{ marginBottom: 0 }}>
                  <Button className="xy-submit" type="primary" htmlType="submit" block size="large">
                    注 册
                  </Button>
                </Form.Item>
              </Form>
              <div className="xy-foot" style={{ textAlign: 'center', marginTop: 20 }}>
                已有账号？ <Link to="/login">返回登录</Link>
              </div>
            </>
          )}
        </div>
        <div className="xy-meta">云枢 OpsHub · v1.7.46</div>
      </div>
    </ConfigProvider>
  )
}
