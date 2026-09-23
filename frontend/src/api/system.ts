import api from './client'

/**
 * 系统设置相关接口（v1.7.45）。
 *
 * 公开注册开关有两个读取入口，用途不同：
 *   - getRegisterAllow       公开、无需登录，仅供登录 / 注册页决定渲染「立即注册」还是「注册已关闭」
 *   - getRegisterAllowAdmin  带 user:update 权限，额外回传 fromEnv（当前值是否来自环境变量）
 */

/** 公开：是否开放公开注册 */
export async function getRegisterAllow(): Promise<boolean> {
  const r = await api.get('/auth/register-allow')
  return !!r.data?.data?.allow
}

/** 管理端：读取注册开关（fromEnv=true 表示还没在页面上设置过，当前值来自环境变量） */
export async function getRegisterAllowAdmin(): Promise<{ allow: boolean; fromEnv: boolean }> {
  const r = await api.get('/system/register-allow')
  const d = r.data?.data || {}
  return { allow: !!d.allow, fromEnv: !!d.fromEnv }
}

/** 管理端：设置是否开放公开注册（写完立即生效，不用重启） */
export async function setRegisterAllow(allow: boolean): Promise<boolean> {
  const r = await api.put('/system/register-allow', { allow })
  return !!r.data?.data?.allow
}
