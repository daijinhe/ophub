import { Routes, Route, Navigate } from 'react-router-dom'
import { Spin, Result } from 'antd'
import MainLayout from './layout/MainLayout'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import Users from './pages/Users'
import Roles from './pages/Roles'
import CMDB from './pages/CMDB'
import AnsibleRemote from './pages/AnsibleRemote'
import AnsibleLocal from './pages/AnsibleLocal'
import AnsibleMode from './pages/AnsibleMode'
import MiddlewareDeploy from './pages/MiddlewareDeploy'
import MiddlewareOps from './pages/MiddlewareOps'
import MiddlewareCapture from './pages/MiddlewareCapture'
import MiddlewareConfig from './pages/MiddlewareConfig'
import CertManage from './pages/CertManage'
import SysInitConfig from './pages/SysInitConfig'
import NginxConfig from './pages/NginxConfig'
import CrontabManage from './pages/CrontabManage'
import JavaScriptManager from './pages/JavaScriptManager'
import InspectionTasks from './pages/InspectionTasks'
import InspectionRecords from './pages/InspectionRecords'
import InspectionAlertRules from './pages/InspectionAlertRules'
import DeployRecords from './pages/DeployRecords'
import InspectionScreen from './pages/InspectionScreen'
import InspectionReport from './pages/InspectionReport'
import PromDataSources from './pages/PromDataSources'
import PromHidden from './pages/PromHidden'
import PromReport from './pages/PromReport'
import PromScreen from './pages/PromScreen'
import PromScreenAdmin from './pages/PromScreenAdmin'
import WebTerminalPage from './pages/WebTerminalPage'
import RequirePerm, { RequireRoute } from './components/RequirePerm'
import { useAuth } from './store/AuthContext'
import { firstAccessiblePath } from './utils/perms'

// 首页重定向：跳到当前用户第一个有权限的路由；一个都没有时给出提示。
// 避免「普通成员没有 dashboard:view 却被硬编码跳到 /dashboard」导致 403。
function IndexRedirect() {
  const { hasPerm, routePerms } = useAuth()
  const p = firstAccessiblePath(hasPerm, routePerms)
  if (!p) {
    return (
      <Result
        status="403"
        title="暂无可用功能"
        subTitle="你的账号还没有被分配任何功能权限，请联系管理员调整角色。"
      />
    )
  }
  return <Navigate to={p} replace />
}

/**
 * 老链接兼容（v1.7.41）：「报表模板 / 报告记录」已并入「监控报表」的三个页签。
 * 这里把旧路径原样转到对应页签，并**保留 query**（?view=<id> 这类深链不能丢）。
 * 直接读 window.location.search：这个组件只在旧链接被访问时渲染一次。
 */
function PromTabRedirect({ tab }: { tab: string }) {
  const q = new URLSearchParams(window.location.search)
  q.set('tab', tab)
  return <Navigate to={`/prom/report?${q.toString()}`} replace />
}

/**
 * 路由表（v1.7.46）。
 *
 * 菜单页面统一用 `<RequireRoute path="..." />`：权限码从后端下发的菜单权限树里
 * 按 path 自动查，前端不再手写权限码 —— 后端改了码、新增了菜单，这里自动跟随。
 * 只有**非菜单路由**（老链接重定向、详情页、Web 终端）才需要显式 RequirePerm。
 */
export default function App() {
  const { token, ready } = useAuth()

  // 有 token 但用户信息 / 菜单权限树尚未拉取完成时，先不渲染路由，
  // 避免权限未就绪导致误跳 403 / 登录页（AuthContext 里两者是并行拉取、共用 ready）
  if (token && !ready) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Spin size="large" />
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={token ? <Navigate to="/" /> : <Login />} />
      <Route path="/register" element={token ? <Navigate to="/" /> : <Register />} />
      <Route path="/" element={token ? <MainLayout /> : <Navigate to="/login" />}>
        <Route index element={<IndexRedirect />} />
        <Route path="dashboard" element={<RequireRoute path="/dashboard"><Dashboard /></RequireRoute>} />
        <Route path="users" element={<RequireRoute path="/users"><Users /></RequireRoute>} />
        <Route path="roles" element={<RequireRoute path="/roles"><Roles /></RequireRoute>} />
        <Route path="cmdb" element={<RequireRoute path="/cmdb"><CMDB /></RequireRoute>} />
        {/* Ansible 管理：/ansible 默认落到「平台采集通道设置」；远端/本机 ansible 管理为同级子页面 */}
        <Route path="ansible" element={<Navigate to="/ansible/mode" replace />} />
        <Route path="ansible/mode" element={<RequireRoute path="/ansible/mode"><AnsibleMode /></RequireRoute>} />
        <Route path="ansible/local" element={<RequireRoute path="/ansible/local"><AnsibleLocal /></RequireRoute>} />
        <Route path="ansible/remote" element={<RequireRoute path="/ansible/remote"><AnsibleRemote /></RequireRoute>} />
        <Route path="deploy" element={<RequireRoute path="/deploy"><MiddlewareDeploy /></RequireRoute>} />
        <Route path="deploy-config" element={<RequireRoute path="/deploy-config"><MiddlewareConfig /></RequireRoute>} />
        <Route path="deploy-certs" element={<RequireRoute path="/deploy-certs"><CertManage /></RequireRoute>} />
        <Route path="deploy-records" element={<RequireRoute path="/deploy-records"><DeployRecords /></RequireRoute>} />
        <Route path="sysinit-config" element={<RequireRoute path="/sysinit-config"><SysInitConfig /></RequireRoute>} />
        <Route path="mwops" element={<RequireRoute path="/mwops"><MiddlewareOps /></RequireRoute>} />
        <Route path="mw-capture" element={<RequireRoute path="/mw-capture"><MiddlewareCapture /></RequireRoute>} />
        <Route path="nginx-config" element={<RequireRoute path="/nginx-config"><NginxConfig /></RequireRoute>} />
        <Route path="crontab" element={<RequireRoute path="/crontab"><CrontabManage /></RequireRoute>} />
        <Route path="scripts/java" element={<RequireRoute path="/scripts/java"><JavaScriptManager /></RequireRoute>} />
        <Route path="inspection/tasks" element={<RequireRoute path="/inspection/tasks"><InspectionTasks /></RequireRoute>} />
        <Route path="inspection/records" element={<RequireRoute path="/inspection/records"><InspectionRecords /></RequireRoute>} />
        <Route path="inspection/alert-rules" element={<RequireRoute path="/inspection/alert-rules"><InspectionAlertRules /></RequireRoute>} />
        {/* Prometheus 监控：数据源 / 监控报表 / 大屏管理 在主布局内，大屏新标签页 */}
        <Route path="prom/datasources" element={<RequireRoute path="/prom/datasources"><PromDataSources /></RequireRoute>} />
        {/* 监控报表（v1.7.41 起内含「生成报告 / 报表模板 / 报告记录」三页签） */}
        <Route path="prom/report" element={<RequireRoute path="/prom/report"><PromReport /></RequireRoute>} />
        {/* 老链接兼容：两个独立菜单已合并，旧路径重定向到对应页签（非菜单路由 → 显式权限码） */}
        <Route path="prom/report-templates" element={<RequirePerm perm="prom:report:view"><PromTabRedirect tab="templates" /></RequirePerm>} />
        <Route path="prom/report-records" element={<RequirePerm perm="prom:report:view"><PromTabRedirect tab="records" /></RequirePerm>} />
        <Route path="prom/screen-admin" element={<RequireRoute path="/prom/screen-admin"><PromScreenAdmin /></RequireRoute>} />
        <Route path="prom/masks" element={<RequirePerm perm="prom:screen:config:view"><Navigate to="/prom/screen-admin" replace /></RequirePerm>} />
        {/* 被屏蔽目标明细（v1.7.43）：大屏的审计视图 —— **不占侧边栏菜单**
            （入口：大屏管理 → 风险与屏蔽 → 「被屏蔽明细」），但路由保留可直达，
            故仍在菜单树里登记（hidden: true），RequireRoute 随之生效。 */}
        <Route path="prom/hidden" element={<RequireRoute path="/prom/hidden"><PromHidden /></RequireRoute>} />
      </Route>
      {/* Web 终端：非菜单页面（入口在资产详情页），权限码 asset:terminal 显式声明 */}
      <Route
        path="/webterm/:assetId"
        element={
          token ? (
            <RequirePerm perm="asset:terminal">
              <WebTerminalPage />
            </RequirePerm>
          ) : (
            <Navigate to="/login" />
          )
        }
      />
      {/* 巡检大屏：新标签页打开的展示页，权限码由菜单树自动查（inspection:screen） */}
      <Route
        path="/inspection/screen"
        element={
          token ? (
            <RequireRoute path="/inspection/screen">
              <InspectionScreen />
            </RequireRoute>
          ) : (
            <Navigate to="/login" />
          )
        }
      />
      {/* 巡检报告详情：非菜单页面 → 显式权限码 */}
      <Route
        path="/inspection/report/:id"
        element={
          token ? (
            <RequirePerm perm="inspection:record:view">
              <InspectionReport />
            </RequirePerm>
          ) : (
            <Navigate to="/login" />
          )
        }
      />
      {/* Prometheus 监控大屏：与巡检大屏同口径 */}
      <Route
        path="/prom/screen"
        element={
          token ? (
            <RequireRoute path="/prom/screen">
              <PromScreen />
            </RequireRoute>
          ) : (
            <Navigate to="/login" />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  )
}
