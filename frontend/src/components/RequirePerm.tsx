import { ReactNode } from 'react'
import { Result, Button } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../store/AuthContext'
import { firstAccessiblePath } from '../utils/perms'

// 权限不足时的统一 403 兜底页
function Denied({ labels }: { labels: string[] }) {
  const { hasPerm } = useAuth()
  const navigate = useNavigate()
  const fallback = firstAccessiblePath(hasPerm)
  return (
    <Result
      status="403"
      title="403"
      subTitle={`你没有访问该功能的权限（${labels.join(' / ')}）。请联系管理员为你的角色授权。`}
      extra={
        fallback ? (
          <Button type="primary" onClick={() => navigate(fallback, { replace: true })}>
            返回可访问页面
          </Button>
        ) : undefined
      }
    />
  )
}

// RequirePerm 路由级权限拦截：无对应权限时展示 403，而不是渲染页面。
// 与侧边栏菜单过滤配合，做到「看不到 + 进不去」。
export default function RequirePerm({
  perm,
  children,
}: {
  perm: string
  children: ReactNode
}) {
  const { hasPerm } = useAuth()
  if (hasPerm(perm)) return <>{children}</>
  return <Denied labels={[perm]} />
}

// RequireAnyPerm 任一权限码命中即放行（any-of）。
// 用于「一个页面被多类角色共用」的场景：如「巡检大屏」既服务于
// 有 inspection:view 的巡检使用者，也服务于只授予 inspection:screen 的「只看大屏」账号。
export function RequireAnyPerm({
  perms,
  children,
}: {
  perms: string[]
  children: ReactNode
}) {
  const { hasPerm } = useAuth()
  if (perms.some((p) => hasPerm(p))) return <>{children}</>
  return <Denied labels={perms} />
}
