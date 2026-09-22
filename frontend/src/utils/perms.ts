// 路由 <-> 权限码 对照表。
// 与 MainLayout 侧边栏菜单的 perm 保持同一口径：菜单隐藏 + 路由拦截，
// 避免「菜单看不到但手敲 URL 仍能进」的越权问题。
export const ROUTE_PERMS: { path: string; perm: string }[] = [
  { path: '/dashboard', perm: 'dashboard:view' },
  { path: '/cmdb', perm: 'cmdb:view' },
  { path: '/users', perm: 'user:view' },
  { path: '/roles', perm: 'role:view' },
  { path: '/ansible', perm: 'ansible:manage' },
  { path: '/ansible/mode', perm: 'ansible:manage' },
  { path: '/ansible/local', perm: 'ansible:manage' },
  { path: '/ansible/remote', perm: 'ansible:manage' },
  { path: '/crontab', perm: 'crontab:view' },
  { path: '/scripts/java', perm: 'script:view' },
  { path: '/deploy', perm: 'deploy:manage' },
  { path: '/deploy-config', perm: 'deploy:manage' },
  { path: '/deploy-certs', perm: 'deploy:manage' },
  { path: '/deploy-records', perm: 'deploy:manage' },
  { path: '/sysinit-config', perm: 'deploy:manage' },
  { path: '/mwops', perm: 'mwops:view' },
  { path: '/mw-capture', perm: 'mwcapture:view' },
  { path: '/nginx-config', perm: 'config:view' },
  { path: '/inspection/tasks', perm: 'inspection:view' },
  { path: '/inspection/records', perm: 'inspection:view' },
  // 告警规则属配置动作，与巡检任务增删改同权限
  { path: '/inspection/alert-rules', perm: 'inspection:manage' },
  // 巡检大屏：独立权限码，可单独授予「只看大屏」的账号。
  // 放在最后，保证同时有 inspection:view 的账号仍首选落到「智能巡检」而非大屏。
  { path: '/inspection/screen', perm: 'inspection:screen' },
  // Prometheus 监控（v1.8.0）：数据源/指标/报表用 prom:view（页面内按 prom:manage 收口）；
  // 大屏独立权限码，可单独授予「只看大屏」的账号（路由侧 RequireAnyPerm 放行两种）。
  { path: '/prom/datasources', perm: 'prom:view' },
  { path: '/prom/metrics', perm: 'prom:view' },
  { path: '/prom/report', perm: 'prom:view' },
  { path: '/prom/screen', perm: 'prom:screen' },
  // 大屏管理（阈值 / 采集频率 / 手动采集）：配置动作，用 prom:manage
  { path: '/prom/screen-admin', perm: 'prom:manage' },
]

// 路由路径 -> 所需权限码
export const ROUTE_PERM_MAP: Record<string, string> = ROUTE_PERMS.reduce(
  (m, r) => ({ ...m, [r.path]: r.perm }),
  {},
)

// 依据当前用户权限，返回第一个可访问的路由；全部无权限时返回 null
export function firstAccessiblePath(hasPerm: (code: string) => boolean): string | null {
  const hit = ROUTE_PERMS.find((r) => hasPerm(r.perm))
  return hit ? hit.path : null
}
