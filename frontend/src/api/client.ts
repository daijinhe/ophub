import axios from 'axios'

// 统一 API 客户端：baseURL 相对路径，由 nginx / vite 代理转发到后端
//
// v1.7.1+ 改造：
//   - withCredentials=true：所有请求自动带 httpOnly cookie（后端 Login 已下发 ophub_token）
//   - 同时保留 Bearer token（向后兼容外部脚本/调试）；优先 cookie，后端中间件会先读 cookie 再读 header
const api = axios.create({
  baseURL: '/api',
  timeout: 60000,
  withCredentials: true, // v1.7.1+：让浏览器自动带 httpOnly ophub_token
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (resp) => resp,
  (error) => {
    if (error.response?.status === 401) {
      // 401 表示 cookie 与 token 都失效（也可能后端在 401 里塞了「被锁定」之类的语义）
      localStorage.removeItem('token')
      if (location.pathname !== '/login' && location.pathname !== '/register') {
        location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export default api
