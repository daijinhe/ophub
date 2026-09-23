import type { MenuNode } from '../store/AuthContext'

/**
 * 路由 <-> 权限码 对照表。
 *
 * v1.7.46 起这份表**不再手工维护** —— 由后端下发的菜单权限树自动派生
 * （MenuNode[]，定义在 backend/perm_tree.go）：
 *   - 每个带 route 的菜单节点产出一条 { path, perms }；
 *   - perms 取节点的 entryPerms（后端已补齐：有 view 动作则为 <resource>:view；
 *     纯容器则为子孙入口权限的并集，即 any-of 语义）。
 *
 * 于是「新增一个菜单要同步 6 处」只剩下 3 处：
 * 后端 perm_tree.go（定义节点）+ 后端 main.go（挂路由）+ 本目录 AuthContext 的
 * iconMap（补一个图标）—— 前端路由拦截表随之自动生成，不会再漏配。
 */
export interface RoutePerm {
  path: string
  perms: string[]
  /** 新标签页打开的展示页（大屏类）—— 不作为登录后的默认落地页 */
  newTab?: boolean
}

/** 由菜单权限树派生「路由 → 所需权限码」表 */
export function buildRoutePerms(tree: MenuNode[]): RoutePerm[] {
  const out: RoutePerm[] = []
  const walk = (nodes: MenuNode[]) => {
    for (const n of nodes) {
      if (n.route) {
        out.push({
          path: n.route,
          perms: n.entryPerms && n.entryPerms.length > 0 ? n.entryPerms : [],
          newTab: n.newTab,
        })
      }
      if (n.children && n.children.length > 0) walk(n.children)
    }
  }
  walk(tree)
  return out
}

/**
 * 菜单树拉取失败时的最小兜底。
 * 正常情况下不会用到；只在 /permissions 请求异常时避免「整站无法进入」的观感。
 */
export const FALLBACK_ROUTE_PERMS: RoutePerm[] = [
  { path: '/dashboard', perms: ['dashboard:view'] },
]

/**
 * 依据当前用户权限，返回第一个可访问的路由；全部无权限时返回 null。
 *
 * 优先排除大屏类页面（newTab）：大屏是「新标签页打开的展示页」，
 * 不适合当登录后的默认工作页 —— 与改造前把 /inspection/screen 排在
 * ROUTE_PERMS 最后是同一个口径。只有当账号**只有**大屏权限时才会落到大屏。
 */
export function firstAccessiblePath(
  hasPerm: (code: string) => boolean,
  routePerms: RoutePerm[],
): string | null {
  const list = routePerms.length > 0 ? routePerms : FALLBACK_ROUTE_PERMS
  const hit = list.find((r) => !r.newTab && r.perms.some(hasPerm))
  if (hit) return hit.path
  const any = list.find((r) => r.perms.some(hasPerm))
  return any ? any.path : null
}
