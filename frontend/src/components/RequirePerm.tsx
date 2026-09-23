import { ReactNode } from 'react'
import { Result, Button } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../store/AuthContext'
import { firstAccessiblePath } from '../utils/perms'

// 权限不足时的统一 403 兜底页
function Denied({ labels, note }: { labels: string[]; note?: string }) {
  const { hasPerm, routePerms } = useAuth()
  const navigate = useNavigate()
  const fallback = firstAccessiblePath(hasPerm, routePerms)
  return (
    <Result
      status="403"
      title="403"
      subTitle={
        note ||
        `你没有访问该功能的权限（${labels.join(' / ')}）。请联系管理员为你的角色授权。`
      }
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

/**
 * RequirePerm 显式权限码拦截。
 *
 * 用于**非菜单路由**：老链接兼容的重定向、详情页（/inspection/report/:id）、
 * Web 终端（/webterm/:assetId）等 —— 这些页面不在菜单树里，只能显式写码。
 * 菜单页面请统一用下面的 RequireRoute，避免前后端权限码不同步。
 */
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

/**
 * RequireRoute 路由级权限拦截（**菜单页面统一用它**）。
 *
 * 所需权限码不再手写 —— 按 path 从后端下发的菜单权限树里自动查 entryPerms。
 * 这样「后端改了权限码 / 新增了菜单，前端忘了同步」这类漏配从根上消失：
 * 前端路由表只声明 path，权限永远跟着后端定义走。
 *
 * 与侧边栏菜单过滤（MainLayout）配合，做到「看不到 + 进不去」。
 */
export function RequireRoute({
  path,
  children,
}: {
  path: string
  children: ReactNode
}) {
  const { hasPerm, routePerms } = useAuth()

  // 权限树尚未就绪或拉取失败：放行，由后端接口的权限中间件兜底。
  // 前端拦截只是体验层，真正的安全边界在后端；此时若一律 403 会让整站打不开。
  if (routePerms.length === 0) return <>{children}</>

  const hit = routePerms.find((r) => r.path === path)
  if (!hit) {
    // 前端路由没有在后端菜单树里登记 —— 属于配置遗漏，按无权限处理并留下线索
    console.warn(
      `[RequireRoute] 路由 ${path} 未在菜单权限树中登记，已按无权限处理。请检查 backend/perm_tree.go 是否遗漏该节点。`,
    )
    return (
      <Denied
        labels={[path]}
        note={`页面 ${path} 未在权限树中登记，已阻止访问。请联系管理员检查菜单与权限配置。`}
      />
    )
  }
  if (hit.perms.length === 0 || hit.perms.some(hasPerm)) return <>{children}</>
  return <Denied labels={hit.perms} />
}
