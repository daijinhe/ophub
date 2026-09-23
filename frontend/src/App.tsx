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
import RequirePerm, { RequireAnyPerm } from './components/RequirePerm'
import { useAuth } from './store/AuthContext'
import { firstAccessiblePath } from './utils/perms'

// 首页重定向：跳到当前用户第一个有权限的路由；一个都没有时给出提示。
// 避免「普通成员没有 dashboard:view 却被硬编码跳到 /dashboard」导致 403。
function IndexRedirect() {
  const { hasPerm } = useAuth()
  const p = firstAccessiblePath(hasPerm)
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

export default function App() {
  const { token, ready } = useAuth()

  // 有 token 但用户信息尚未拉取完成时，先不渲染路由，避免权限未就绪导致误跳 403 / 登录页
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
      <Route
        path="/"
        element={token ? <MainLayout /> : <Navigate to="/login" />}
      >
        <Route index element={<IndexRedirect />} />
        <Route path="dashboard" element={<RequirePerm perm="dashboard:view"><Dashboard /></RequirePerm>} />
        <Route path="users" element={<RequirePerm perm="user:view"><Users /></RequirePerm>} />
        <Route path="roles" element={<RequirePerm perm="role:view"><Roles /></RequirePerm>} />
        <Route path="cmdb" element={<RequirePerm perm="cmdb:view"><CMDB /></RequirePerm>} />
        {/* Ansible 管理：/ansible 默认落到「平台采集通道设置」；远端/本机 ansible 管理为同级子页面 */}
        <Route path="ansible" element={<Navigate to="/ansible/mode" replace />} />
        <Route path="ansible/mode" element={<RequirePerm perm="ansible:manage"><AnsibleMode /></RequirePerm>} />
        <Route path="ansible/local" element={<RequirePerm perm="ansible:manage"><AnsibleLocal /></RequirePerm>} />
        <Route path="ansible/remote" element={<RequirePerm perm="ansible:manage"><AnsibleRemote /></RequirePerm>} />
        <Route path="deploy" element={<RequirePerm perm="deploy:manage"><MiddlewareDeploy /></RequirePerm>} />
        <Route path="deploy-config" element={<RequirePerm perm="deploy:manage"><MiddlewareConfig /></RequirePerm>} />
        <Route path="deploy-certs" element={<RequirePerm perm="deploy:manage"><CertManage /></RequirePerm>} />
        <Route path="deploy-records" element={<RequirePerm perm="deploy:manage"><DeployRecords /></RequirePerm>} />
        <Route path="sysinit-config" element={<RequirePerm perm="deploy:manage"><SysInitConfig /></RequirePerm>} />
        <Route path="mwops" element={<RequirePerm perm="mwops:view"><MiddlewareOps /></RequirePerm>} />
        <Route path="mw-capture" element={<RequirePerm perm="mwcapture:view"><MiddlewareCapture /></RequirePerm>} />
        <Route path="nginx-config" element={<RequirePerm perm="config:view"><NginxConfig /></RequirePerm>} />
        <Route path="crontab" element={<RequirePerm perm="crontab:view"><CrontabManage /></RequirePerm>} />
        <Route path="scripts/java" element={<RequirePerm perm="script:view"><JavaScriptManager /></RequirePerm>} />
        <Route path="inspection/tasks" element={<RequirePerm perm="inspection:view"><InspectionTasks /></RequirePerm>} />
        <Route path="inspection/records" element={<RequirePerm perm="inspection:view"><InspectionRecords /></RequirePerm>} />
        <Route path="inspection/alert-rules" element={<RequirePerm perm="inspection:manage"><InspectionAlertRules /></RequirePerm>} />
        {/* Prometheus 监控（v1.8.0 独立大类）：数据源 / 监控报表在主布局内，大屏新标签页 */}
        <Route path="prom/datasources" element={<RequirePerm perm="prom:view"><PromDataSources /></RequirePerm>} />
        {/* 监控报表（v1.7.41 起内含「生成报告 / 报表模板 / 报告记录」三页签） */}
        <Route path="prom/report" element={<RequirePerm perm="prom:view"><PromReport /></RequirePerm>} />
        {/* 老链接兼容：两个独立菜单已合并，旧路径重定向到对应页签 */}
        <Route path="prom/report-templates" element={<RequirePerm perm="prom:view"><PromTabRedirect tab="templates" /></RequirePerm>} />
        <Route path="prom/report-records" element={<RequirePerm perm="prom:view"><PromTabRedirect tab="records" /></RequirePerm>} />
        {/* 大屏管理（展示内容 / 风险与屏蔽 / 阈值与采集）：配置动作 → prom:manage。
            v1.7.36 独立出去的「屏蔽规则」v1.7.41 已并回本页，/prom/masks 一并重定向。 */}
        <Route path="prom/screen-admin" element={<RequirePerm perm="prom:manage"><PromScreenAdmin /></RequirePerm>} />
        <Route path="prom/masks" element={<RequirePerm perm="prom:manage"><Navigate to="/prom/screen-admin" replace /></RequirePerm>} />
        {/* 被屏蔽目标（v1.7.43）：大屏的审计视图 —— 大屏上看不到的目标 / 风险项 / 榜位都在这里。
            属**查看**动作，prom:view 即可（不需要 prom:manage，否则普通监控使用者看不到自己漏了什么）。 */}
        <Route path="prom/hidden" element={<RequirePerm perm="prom:view"><PromHidden /></RequirePerm>} />
      </Route>
      <Route
        path="/webterm/:assetId"
        element={token ? <WebTerminalPage /> : <Navigate to="/login" />}
      />
      <Route
        path="/inspection/screen"
        element={
          token ? (
            <RequireAnyPerm perms={['inspection:screen', 'inspection:view']}>
              <InspectionScreen />
            </RequireAnyPerm>
          ) : (
            <Navigate to="/login" />
          )
        }
      />
      <Route
        path="/inspection/report/:id"
        element={
          token ? (
            <RequirePerm perm="inspection:view">
              <InspectionReport />
            </RequirePerm>
          ) : (
            <Navigate to="/login" />
          )
        }
      />
      {/* Prometheus 监控大屏：与巡检大屏同口径，只看大屏的账号（prom:screen）也能进 */}
      <Route
        path="/prom/screen"
        element={
          token ? (
            <RequireAnyPerm perms={['prom:screen', 'prom:view']}>
              <PromScreen />
            </RequireAnyPerm>
          ) : (
            <Navigate to="/login" />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  )
}
