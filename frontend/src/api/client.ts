import axios from 'axios'

// 统一 API 客户端：baseURL 相对路径，由 nginx / vite 代理转发到后端
const api = axios.create({
  baseURL: '/api',
  timeout: 60000,
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
      localStorage.removeItem('token')
      if (location.pathname !== '/login' && location.pathname !== '/register') {
        location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export default api
