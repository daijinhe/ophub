import { useState } from 'react'
import { Layout, Menu, Dropdown, Avatar, Typography, Grid } from 'antd'
import {
  DashboardOutlined,
  DatabaseOutlined,
  CloudServerOutlined,
  ApiOutlined,
  DeploymentUnitOutlined,
  ToolOutlined,
  AppstoreOutlined,
  SafetyCertificateOutlined,
  HistoryOutlined,
  HddOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  FieldTimeOutlined,
  FileProtectOutlined,
  FileSearchOutlined,
  ClusterOutlined,
  CodeOutlined,
  ControlOutlined,
  FileTextOutlined,
  AlertOutlined,
  DotChartOutlined,
  FundOutlined,
  NodeIndexOutlined,
  BarChartOutlined,
  StopOutlined,
  SettingOutlined,
  TeamOutlined,
  KeyOutlined,
  CloudOutlined,
  MoonOutlined,
  SunOutlined,
  UserOutlined,
  LogoutOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../store/AuthContext'
import { useTheme } from '../store/ThemeContext'
import AccountModal from '../components/AccountModal'

const { Sider, Header, Content } = Layout
const { useBreakpoint } = Grid

// 递归按权限过滤菜单：分组不带 perm（仅容器），子项各自携权限码；
// 子项可用 perm（单码）或 perms（任一命中即显示，any-of，用于「巡检大屏」
// 这种既给 inspection:view 又给 inspection:screen 的共用入口）；
// 任意无可见子项的分组自动隐藏，既避免越权进入，也避免有权限页面被错藏。
function filterMenuByPerm(items: any[], hasPerm: (code: string) => boolean): any[] {
  const out: any[] = []
  for (const it of items) {
    const codes: string[] = it.perms || (it.perm ? [it.perm] : [])
    if (codes.length > 0 && !codes.some(hasPerm)) continue
    if (it.children) {
      const kids = filterMenuByPerm(it.children, hasPerm)
      if (kids.length === 0) continue
      out.push({ ...it, children: kids })
    } else {
      out.push(it)
    }
  }
  return out
}

export default function MainLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout, hasPerm } = useAuth()
  const { mode, toggle } = useTheme()
  const screens = useBreakpoint()
  const [collapsed, setCollapsed] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  // 根据当前路由反查应当默认展开的菜单分组（支持多级嵌套，返回所有祖先分组）
  const openGroupsOf = (p: string): string[] => {
    if (p.startsWith('/inspection')) return ['monitor']
    if (p.startsWith('/prom')) return ['prom']
    if (p.startsWith('/deploy') || p.startsWith('/sysinit-config')) return ['middleware', 'deploy']
    if (p.startsWith('/mwops')) return ['middleware', 'ops']
    if (p.startsWith('/crontab')) return []
    // 脚本管理是独立一级分组（与定时任务平级），展开它才能看到子项
    if (p.startsWith('/scripts')) return ['scripts']
    if (p.startsWith('/nginx-config')) return ['middleware', 'mwconfig']
    if (p.startsWith('/ansible')) return ['ansible']
    if (p.startsWith('/users') || p.startsWith('/roles')) return ['system']
    return []
  }
  const [openKeysState, setOpenKeysState] = useState<string[]>(openGroupsOf(location.pathname))

  // 按业务域归类的菜单骨架：分组本身不带 perm（仅作容器），
  // 由子项各自携权限码，递归过滤后「无可见子项的分组自动隐藏」，
  // 避免「菜单看不到但手敲 URL 仍能进」的越权，也不会误把有权限的页面藏进别的组。
  const rawItems: any[] = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: '概览', perm: 'dashboard:view' },

    // 资产管理：v1.7.16 起提升为一级菜单（原「资源配置」分组拆散：资产管理独立，ansible 相关另立分组）
    { key: '/cmdb', icon: <DatabaseOutlined />, label: '资产管理', perm: 'cmdb:view' },

    // Ansible 管理：与资产管理平级的一级分组（v1.7.16）。
    // 采集通道设置放第一个——它是全平台开关，配置优先级高于具体节点管理。
    {
      key: 'ansible',
      icon: <CloudServerOutlined />,
      label: 'Ansible 管理',
      children: [
        { key: '/ansible/mode', icon: <ApiOutlined />, label: '平台采集通道设置', perm: 'ansible:manage' },
        { key: '/ansible/local', icon: <CodeOutlined />, label: '本机 Ansible 管理', perm: 'ansible:manage' },
        { key: '/ansible/remote', icon: <CloudServerOutlined />, label: '远端 Ansible 管理', perm: 'ansible:manage' },
      ],
    },

    {
      key: 'middleware',
      icon: <ApiOutlined />,
      label: '中间件管理',
      children: [
        {
          key: 'deploy',
          icon: <DeploymentUnitOutlined />,
          label: '中间件部署',
          children: [
            { key: '/deploy', icon: <RocketOutlined />, label: '应用中间件安装', perm: 'deploy:manage' },
            { key: '/sysinit-config', icon: <ToolOutlined />, label: '系统初始化管理', perm: 'deploy:manage' },
            { key: '/deploy-config', icon: <AppstoreOutlined />, label: '中间件部署配置', perm: 'deploy:manage' },
            { key: '/deploy-certs', icon: <SafetyCertificateOutlined />, label: '证书管理', perm: 'deploy:manage' },
            { key: '/deploy-records', icon: <HistoryOutlined />, label: '部署执行记录', perm: 'deploy:manage' },
          ],
        },
        {
          key: 'ops',
          icon: <HddOutlined />,
          label: '中间件运维',
          children: [
            { key: '/mwops', icon: <ThunderboltOutlined />, label: '中间件管控', perm: 'mwops:view' },
            { key: '/mw-capture', icon: <FileSearchOutlined />, label: '中间件捕捉', perm: 'mwcapture:view' },
          ],
        },
        {
          key: 'mwconfig',
          icon: <FileProtectOutlined />,
          label: '中间件配置管理',
          children: [
            { key: '/nginx-config', icon: <FileProtectOutlined />, label: 'Nginx 配置', perm: 'config:view' },
          ],
        },
      ],
    },

    // 定时任务：一级菜单（独立域，管理的是目标机 crontab，与中间件部署/管控无关）
    { key: '/crontab', icon: <FieldTimeOutlined />, label: '定时任务', perm: 'crontab:view' },

    // 脚本管理：独立一级菜单，与定时任务平级。
    // 目前只有「Java 启停脚本管理」一个子项，未来扩展 PHP / Python / Shell 时
    // 只需往 children 追加，架构不动。
    {
      key: 'scripts',
      icon: <CodeOutlined />,
      label: '脚本管理',
      children: [
        {
          key: '/scripts/java',
          icon: <CodeOutlined />,
          label: 'Java 启停脚本管理',
          perm: 'script:view',
        },
      ],
    },

    {
      key: 'monitor',
      icon: <ClusterOutlined />,
      label: '监控巡检',
      children: [
        // 用原生 <a target="_blank"> 在浏览器新标签页打开：
        // 保留地址栏与工具栏，可 F11 全屏 / 拖到副屏投屏，也不会被弹窗拦截器拦截
        {
          key: '/inspection/screen',
          icon: <DotChartOutlined />,
          label: (
            <a
              href="/inspection/screen"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              巡检大屏
            </a>
          ),
          // 大屏是共用入口：老角色（inspection:view）与新角色（inspection:screen）都能看到
          perms: ['inspection:screen', 'inspection:view'],
        },
        { key: '/inspection/tasks', icon: <ControlOutlined />, label: '智能巡检', perm: 'inspection:view' },
        { key: '/inspection/records', icon: <FileTextOutlined />, label: '巡检报表', perm: 'inspection:view' },
        // 告警规则属配置动作 → 用 inspection:manage（与任务增删改同权限）
        { key: '/inspection/alert-rules', icon: <AlertOutlined />, label: '告警规则', perm: 'inspection:manage' },
      ],
    },

    // Prometheus 监控：独立一级大类（v1.8.0）。
    // 数据源管理列出用 prom:view，增删改在页面内再按 prom:manage 收口；
    // 大屏在新标签页打开，prom:screen（只看大屏）与 prom:view 共用入口。
    {
      key: 'prom',
      icon: <FundOutlined />,
      label: 'Prometheus 监控',
      children: [
        { key: '/prom/datasources', icon: <ApiOutlined />, label: '数据源管理', perm: 'prom:view' },
        { key: '/prom/report', icon: <BarChartOutlined />, label: '监控报表', perm: 'prom:view' },
        { key: '/prom/report-records', icon: <FileTextOutlined />, label: '报告记录', perm: 'prom:view' },
        {
          key: '/prom/screen',
          icon: <DotChartOutlined />,
          label: (
            <a
              href="/prom/screen"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              监控大屏
            </a>
          ),
          perms: ['prom:screen', 'prom:view'],
        },
        { key: '/prom/screen-admin', icon: <ControlOutlined />, label: '大屏管理', perm: 'prom:manage' },
        { key: '/prom/masks', icon: <StopOutlined />, label: '屏蔽规则', perm: 'prom:manage' },
      ],
    },

    {
      key: 'system',
      icon: <SettingOutlined />,
      label: '系统管理',
      children: [
        { key: '/users', icon: <TeamOutlined />, label: '用户管理', perm: 'user:view' },
        { key: '/roles', icon: <KeyOutlined />, label: '角色权限', perm: 'role:view' },
      ],
    },
  ]

  const allItems: any[] = filterMenuByPerm(rawItems, hasPerm)

  // 展开子菜单后的扁平项，用于选中态与标题计算
  const flatItems: any[] = allItems.flatMap((i) => (i.children ? i.children : [i]))
  const selected =
    flatItems.find((i) => location.pathname === i.key)?.key ||
    flatItems.find((i) => location.pathname.startsWith(i.key))?.key ||
    '/dashboard'

  const userMenu = {
    items: [
      {
        key: 'account',
        icon: <UserOutlined />,
        label: '个人中心',
      },
      { type: 'divider' as const },
      {
        key: 'logout',
        icon: <LogoutOutlined />,
        label: '退出登录',
      },
    ],
    onClick: ({ key }: any) => {
      if (key === 'account') setAccountOpen(true)
      else if (key === 'logout') logout().then(() => navigate('/login'))
    },
  }

  return (
    <Layout style={{ minHeight: '100vh', background: 'transparent' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        width={232}
        style={{
          borderRight: '1px solid var(--border-soft)',
          backdropFilter: 'blur(14px)',
        }}
        breakpoint="lg"
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 18px',
          }}
        >
          <CloudOutlined style={{ fontSize: 26, color: 'var(--accent)' }} />
          {!collapsed && (
            <span className="glow-text" style={{ fontSize: 17, fontWeight: 700 }}>
              个人工作空间
            </span>
          )}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selected]}
          openKeys={openKeysState}
          onOpenChange={(keys) => setOpenKeysState(keys as string[])}
          onClick={({ key }) => {
            const k = String(key)
            // 巡检大屏 / 监控大屏：由 label 里的 <a target="_blank"> 打开新标签页，此处不 navigate，
            // 主窗口保持在当前页，方便同时使用其他功能
            if (k === '/inspection/screen' || k === '/prom/screen') return
            if (k.startsWith('/inspection')) {
              setOpenKeysState((prev) => (prev.includes('monitor') ? prev : [...prev, 'monitor']))
            }
            if (k.startsWith('/prom')) {
              setOpenKeysState((prev) => (prev.includes('prom') ? prev : [...prev, 'prom']))
            }
            navigate(k)
          }}
          items={allItems}
          style={{ background: 'transparent', border: 'none' }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 24px',
            borderBottom: '1px solid var(--border-soft)',
            backdropFilter: 'blur(14px)',
          }}
        >
          <Typography.Title level={4} style={{ margin: 0, fontWeight: 600 }}>
            {flatItems.find((i) => i.key === selected)?.label || '概览'}
          </Typography.Title>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              className="theme-toggle"
              onClick={toggle}
              title={mode === 'dark' ? '切换到浅色' : '切换到深色'}
              aria-label="切换主题"
            >
              {mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            </div>
            <Dropdown menu={userMenu} placement="bottomRight">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <Avatar
                  style={{ background: 'linear-gradient(135deg,var(--accent),#6366f1)' }}
                  icon={<UserOutlined />}
                />
              <span>{user?.nickname || user?.username}</span>
            </div>
          </Dropdown>
          </div>
        </Header>
        <Content
          style={{
            padding: screens.xs ? 12 : 24,
            overflow: 'auto',
          }}
        >
          <div className="fade-up" key={location.pathname}>
            <Outlet />
          </div>
        </Content>
      </Layout>
      <AccountModal open={accountOpen} onClose={() => setAccountOpen(false)} />
    </Layout>
  )
}
