import {
  createContext,
  useContext,
  useState,
  ReactNode,
  useEffect,
  useCallback,
} from 'react'
import api from '../api/client'

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

interface AuthCtx {
  token: string | null
  user: UserInfo | null
  perms: string[]
  loading: boolean
  /** ready: 是否已完成首次用户信息拉取（有 token 时）。用于避免首屏误判权限。 */
  ready: boolean
  /** isAdmin: 是否属于内置 admin 角色（仅此角色可查看/重置他人密码） */
  isAdmin: boolean
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
  const [loading] = useState(false)
  // 无 token 时无需等待（直接进登录页）；有 token 则待 /auth/me 返回后才算 ready
  const [ready, setReady] = useState(!localStorage.getItem('token'))

  const refresh = useCallback(async () => {
    if (!localStorage.getItem('token')) {
      setReady(true)
      return
    }
    try {
      const r = await api.get('/auth/me')
      const d = r.data.data
      setUser(d)
      setPerms(d.perms || [])
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
  }

  const hasPerm = (code: string) => perms.includes(code)
  const isAdmin = !!user?.roles?.some((r) => r.code === 'admin')

  return (
    <Ctx.Provider
      value={{ token, user, perms, loading, ready, isAdmin, login, register, logout, hasPerm, refresh }}
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
