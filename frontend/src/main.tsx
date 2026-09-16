import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import { lightTheme, darkTheme } from './theme'
import { AuthProvider } from './store/AuthContext'
import { ThemeProvider, useTheme } from './store/ThemeContext'
import './styles/global.css'

function ThemedApp() {
  const { mode } = useTheme()
  return (
    <ConfigProvider theme={mode === 'dark' ? darkTheme : lightTheme} locale={zhCN}>
      <AntApp>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </AntApp>
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ThemedApp />
    </ThemeProvider>
  </React.StrictMode>
)
