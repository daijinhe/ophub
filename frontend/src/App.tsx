import { Routes, Route, Navigate } from 'react-router-dom'
import { Spin, Result } from 'antd'
import MainLayout from './layout/MainLayout'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import Users from './pages/Users'
import Roles from './pages/Roles'
import CMDB from './pages/CMDB'
import Ansible from './pages/Ansible'
import MiddlewareDeploy from './pages/MiddlewareDeploy'
import MiddlewareOps from './pages/MiddlewareOps'
import MiddlewareCapture from './pages/MiddlewareCapture'
import MiddlewareConfig from './pages/MiddlewareConfig'
import CertManage from './pages/CertManage'
import SysInitConfig from './pages/SysInitConfig'
import NginxConfig from './pages/NginxConfig'
import CrontabManage from './pages/CrontabManage'
import InspectionTasks from './pages/InspectionTasks'
import InspectionRecords from './pages/InspectionRecords'
import InspectionAlertRules from './pages/InspectionAlertRules'
import DeployRecords from './pages/DeployRecords'
import InspectionScreen from './pages/InspectionScreen'
import InspectionReport from './pages/InspectionReport'
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
        <Route path="ansible" element={<RequirePerm perm="ansible:manage"><Ansible /></RequirePerm>} />
        <Route path="deploy" element={<RequirePerm perm="deploy:manage"><MiddlewareDeploy /></RequirePerm>} />
        <Route path="deploy-config" element={<RequirePerm perm="deploy:manage"><MiddlewareConfig /></RequirePerm>} />
        <Route path="deploy-certs" element={<RequirePerm perm="deploy:manage"><CertManage /></RequirePerm>} />
        <Route path="deploy-records" element={<RequirePerm perm="deploy:manage"><DeployRecords /></RequirePerm>} />
        <Route path="sysinit-config" element={<RequirePerm perm="deploy:manage"><SysInitConfig /></RequirePerm>} />
        <Route path="mwops" element={<RequirePerm perm="mwops:view"><MiddlewareOps /></RequirePerm>} />
        <Route path="mw-capture" element={<RequirePerm perm="mwcapture:view"><MiddlewareCapture /></RequirePerm>} />
        <Route path="nginx-config" element={<RequirePerm perm="config:view"><NginxConfig /></RequirePerm>} />
        <Route path="crontab" element={<RequirePerm perm="crontab:view"><CrontabManage /></RequirePerm>} />
        <Route path="inspection/tasks" element={<RequirePerm perm="inspection:view"><InspectionTasks /></RequirePerm>} />
        <Route path="inspection/records" element={<RequirePerm perm="inspection:view"><InspectionRecords /></RequirePerm>} />
        <Route path="inspection/alert-rules" element={<RequirePerm perm="inspection:manage"><InspectionAlertRules /></RequirePerm>} />
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
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  )
}
