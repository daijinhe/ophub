// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import {
  createContext,
  useContext,
  useState,
  ReactNode,
  useEffect,
  useCallback,
} from 'react'
import api from '../api/client'
import { buildRoutePerms, type RoutePerm } from '../utils/perms'

export interface Role {
  id: number
  name: string
  code: string
  description?: string
  permissions: string[]
}

export interface UserInfo {
  id: number
  username: string
  nickname?: string
  email?: string
  phone?: string
  status: number
  roles: Role[]
  isAdmin?: boolean
}

/**
 * MenuNode 菜单 + 权限树节点（由后端 perm_tree.go 下发，前端不手工维护）。
 *
 * 这是 v1.7.46 权限收口的**单一事实源**：侧边栏菜单、路由拦截所需权限码、
 * 角色授权树的层级，三处全部由它派生 —— 新增一个菜单只需改后端一处 +
 * 在这里的 iconMap 补一个图标，不会再出现「菜单看不到但能访问」的漏配。
 */
export interface MenuNode {
  key: string
  label: string
  icon?: string
  route?: string
  resource?: string
  actions?: string[]
  /** 不占菜单（页内功能，如资产管理页里的「资产分类」「Web 终端」） */
  noMenu?: boolean
  /** 菜单里有定义但不渲染（页头标题反查仍需它，如「被屏蔽目标」） */
  hidden?: boolean
  /** 新标签页打开（大屏类） */
  newTab?: boolean
  /** 进入该页面所需权限码（any-of），由后端补齐 */
  entryPerms?: string[]
  /**
   * 本节点的权限码清单（含中文名），由后端补齐。
   * 角色授权树直接用它渲染，前端不再维护一份「动作 → 中文名」映射。
   */
  permItems?: { code: string; name: string }[]
  children?: MenuNode[]
}

export interface PermDef {
  code: string
  name: string
  group: string
}

interface AuthCtx {
  token: string | null
  user: UserInfo | null
  perms: string[]
  loading: boolean
  /** ready: 是否已完成首次用户信息拉取（有 token 时）。用于避免首屏误判权限。 */
  ready: boolean
  /** isAdmin: 是否属于内置 admin 角色（仅此角色可查看/重置他人密码） */
  isAdmin: boolean
  /** menuTree: 后端下发的菜单权限树（含未授予的节点；前端按权限自行过滤渲染） */
  menuTree: MenuNode[]
  /** flatPerms: 扁平权限目录（Group = 菜单祖先路径） */
  flatPerms: PermDef[]
  /** routePerms: 由 menuTree 派生的「路由 → 所需权限码」表 */
  routePerms: RoutePerm[]
  login: (username: string, password: string) => Promise<void>
  register: (data: any) => Promise<void>
  logout: () => Promise<void>
  hasPerm: (code: string) => boolean
  refresh: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'))
  const [user, setUser] = useState<UserInfo | null>(null)
  const [perms, setPerms] = useState<string[]>([])
  const [menuTree, setMenuTree] = useState<MenuNode[]>([])
  const [flatPerms, setFlatPerms] = useState<PermDef[]>([])
  const [routePerms, setRoutePerms] = useState<RoutePerm[]>([])
  const [loading] = useState(false)
  // 无 token 时无需等待（直接进登录页）；有 token 则待 /auth/me 返回后才算 ready
  const [ready, setReady] = useState(!localStorage.getItem('token'))

  const refresh = useCallback(async () => {
    if (!localStorage.getItem('token')) {
      setReady(true)
      return
    }
    try {
      // 用户信息与菜单权限树**并行**拉取，并共用同一个 ready 时机 ——
      // 否则会出现「路由已渲染但权限树还没到」的中间态：菜单空白、
      // firstAccessiblePath 返回 null 并误报「暂无可用功能」。
      const [meRes, permRes] = await Promise.all([
        api.get('/auth/me'),
        api.get('/permissions'),
      ])
      const d = meRes.data.data
      setUser(d)
      setPerms(d.perms || [])
      const tree: MenuNode[] = permRes.data.data?.tree || []
      const flat: PermDef[] = permRes.data.data?.flat || []
      setMenuTree(tree)
      setFlatPerms(flat)
      setRoutePerms(buildRoutePerms(tree))
    } catch {
      /* ignore */
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    if (token) refresh()
    else setReady(true)
  }, [token, refresh])

  const login = async (username: string, password: string) => {
    const r = await api.post('/auth/login', { username, password })
    const d = r.data.data
    localStorage.setItem('token', d.token)
    setToken(d.token)
    setUser({
      id: 0,
      username: d.username,
      nickname: d.nickname,
      status: 1,
      roles: d.roles || [],
      isAdmin: !!d.isAdmin,
    })
    setPerms(d.perms || [])
    setReady(true)
  }

  const register = async (data: any) => {
    await api.post('/auth/register', data)
  }

  const logout = async () => {
    try {
      await api.post('/auth/logout')
    } catch {
      /* ignore */
    }
    localStorage.removeItem('token')
    setToken(null)
    setUser(null)
    setPerms([])
    setMenuTree([])
    setFlatPerms([])
    setRoutePerms([])
  }

  const hasPerm = (code: string) => perms.includes(code)
  const isAdmin = !!user?.roles?.some((r) => r.code === 'admin')

  return (
    <Ctx.Provider
      value={{
        token,
        user,
        perms,
        loading,
        ready,
        isAdmin,
        menuTree,
        flatPerms,
        routePerms,
        login,
        register,
        logout,
        hasPerm,
        refresh,
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth must be used within AuthProvider')
  return c
}
