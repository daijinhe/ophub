import { useState, useMemo, ReactNode } from 'react'
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
  EyeInvisibleOutlined,
  DotChartOutlined,
  FundOutlined,
  NodeIndexOutlined,
  BarChartOutlined,
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
import { useAuth, type MenuNode } from '../store/AuthContext'
import { useTheme } from '../store/ThemeContext'
import AccountModal from '../components/AccountModal'

const { Sider, Header, Content } = Layout
const { useBreakpoint } = Grid

/**
 * 菜单图标映射。
 *
 * 图标是前端资源（ReactNode），没法从后端下发，所以后端菜单节点只声明
 * icon 名（如 "cloud-server"），这里映射到 antd 图标组件。
 * **新增菜单时唯一需要在前端补的东西就是这里的一条映射。**
 */
const ICON_MAP: Record<string, ReactNode> = {
  dashboard: <DashboardOutlined />,
  database: <DatabaseOutlined />,
  'cloud-server': <CloudServerOutlined />,
  api: <ApiOutlined />,
  'deployment-unit': <DeploymentUnitOutlined />,
  tool: <ToolOutlined />,
  appstore: <AppstoreOutlined />,
  'safety-certificate': <SafetyCertificateOutlined />,
  history: <HistoryOutlined />,
  hdd: <HddOutlined />,
  rocket: <RocketOutlined />,
  thunderbolt: <ThunderboltOutlined />,
  'field-time': <FieldTimeOutlined />,
  'file-protect': <FileProtectOutlined />,
  'file-search': <FileSearchOutlined />,
  cluster: <ClusterOutlined />,
  code: <CodeOutlined />,
  control: <ControlOutlined />,
  'file-text': <FileTextOutlined />,
  alert: <AlertOutlined />,
  'eye-invisible': <EyeInvisibleOutlined />,
  'dot-chart': <DotChartOutlined />,
  fund: <FundOutlined />,
  'bar-chart': <BarChartOutlined />,
  'node-index': <NodeIndexOutlined />,
  setting: <SettingOutlined />,
  team: <TeamOutlined />,
  key: <KeyOutlined />,
}

/**
 * 后端菜单树 → antd Menu items（v1.7.46 起菜单不再硬编码）。
 *
 * 约定：
 *   - 页面节点的 key 用 **route**（选中态与跳转都基于路由）；
 *     分组节点的 key 用后端定义的短名（middleware / deploy / monitor …）。
 *   - plainLabel 单独存一份纯文本：标题栏用它，避免大屏节点 label 里的
 *     <a> 被渲染进 h4。
 *   - noMenu（页内功能，如「资产分类」「Web 终端」）与 hidden（如「被屏蔽目标」）
 *     的子节点都不进菜单；若某节点过滤后没有任何菜单子节点，它自身退化为叶子。
 */
function toMenuItems(nodes: MenuNode[]): any[] {
  const out: any[] = []
  for (const n of nodes) {
    const kids = (n.children || []).filter((c) => !c.noMenu && !c.hidden)
    const label =
      n.newTab && n.route ? (
        // 用原生 <a target="_blank"> 打开：保留地址栏与工具栏，可 F11 全屏 / 拖到副屏投屏，
        // 也不会被弹窗拦截器拦截
        <a
          href={n.route}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'inherit', textDecoration: 'none' }}
        >
          {n.label}
        </a>
      ) : (
        n.label
      )
    const item: any = {
      key: n.route || n.key,
      icon: n.icon ? ICON_MAP[n.icon] : undefined,
      label,
      plainLabel: n.label,
      // entryPerms 是 any-of 语义（后端已补齐）；空数组表示「纯容器」，不参与权限过滤
      perms: n.entryPerms || [],
      hidden: n.hidden,
    }
    if (kids.length > 0) item.children = toMenuItems(kids)
    out.push(item)
  }
  return out
}

// 递归按权限过滤菜单。
// includeHidden：是否把 hidden 项（不占菜单、但真实存在且可达的页面，如 /prom/hidden）
// 一并带回。**菜单渲染必须用 false**（否则隐藏项会漏到侧边栏），
// 页头标题 / 选中态反查必须用 true —— 去掉后者会让页头退化成兜底的「概览」。
function filterMenuByPerm(
  items: any[],
  hasPerm: (code: string) => boolean,
  includeHidden = false,
): any[] {
  const out: any[] = []
  for (const it of items) {
    const codes: string[] = it.perms || []
    if (codes.length > 0 && !codes.some(hasPerm)) continue
    if (it.hidden) {
      if (includeHidden) out.push(it)
      continue
    }
    if (it.children) {
      const kids = filterMenuByPerm(it.children, hasPerm, includeHidden)
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
  const { user, logout, hasPerm, menuTree } = useAuth()
  const { mode, toggle } = useTheme()
  const screens = useBreakpoint()
  const [collapsed, setCollapsed] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  // 根据当前路由反查应当默认展开的菜单分组（支持多级嵌套，返回所有祖先分组）
  const openGroupsOf = (p: string): string[] => {
    if (p.startsWith('/inspection')) return ['monitor']
    if (p.startsWith('/prom')) return ['prom']
    if (p.startsWith('/deploy') || p.startsWith('/sysinit-config')) return ['middleware', 'deploy']
    if (p.startsWith('/mwops') || p.startsWith('/mw-capture')) return ['middleware', 'ops']
    if (p.startsWith('/crontab')) return []
    // 脚本管理是独立一级分组（与定时任务平级），展开它才能看到子项
    if (p.startsWith('/scripts')) return ['scripts']
    if (p.startsWith('/nginx-config')) return ['middleware', 'mwconfig']
    if (p.startsWith('/ansible')) return ['ansible']
    if (p.startsWith('/users') || p.startsWith('/roles')) return ['system']
    return []
  }
  const [openKeysState, setOpenKeysState] = useState<string[]>(openGroupsOf(location.pathname))

  // 菜单骨架来自后端下发的菜单权限树（单一事实源），这里只做「图标映射 + 权限过滤」
  const rawItems: any[] = useMemo(() => toMenuItems(menuTree), [menuTree])

  // 菜单渲染用：hidden 项（不占菜单的页面，如 /prom/hidden）在这一路被丢掉
  const allItems: any[] = filterMenuByPerm(rawItems, hasPerm)

  // 展开子菜单后的扁平项，用于选中态与标题计算。
  // ⚠️ 必须走 includeHidden=true 这一路：否则 /prom/hidden 反查不到 label，
  // 页头标题会退化成兜底的「概览」（实测踩过），选中态也会落回 /dashboard。
  const titleItems: any[] = filterMenuByPerm(rawItems, hasPerm, true)
  const flatItems: any[] = titleItems.flatMap((i) => (i.children ? i.children : [i]))
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
            // 侧边栏只有 232px 宽，放全称「云枢 OpsHub」会溢出换行 →
            // 这里用简称，全称留给登录页与浏览器标题（v1.7.45 品牌统一）
            <span
              className="glow-text"
              style={{ fontSize: 16.5, fontWeight: 700, whiteSpace: 'nowrap' }}
            >
              云枢 OpsHub
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
            {flatItems.find((i) => i.key === selected)?.plainLabel || '概览'}
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
