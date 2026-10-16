// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发时 /api 代理到后端（docker-compose 中由 nginx 代理）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // 禁用清空 dist：dist 中的 cmdb_template.xlsx 偶发被 Excel 锁定，
    // 会触发 safe-delete(回收站)失败导致构建中断。资源采用 content-hash，
    // 旧 chunk 残留无害，部署时由 nginx 容器构建覆盖即可。
    emptyOutDir: false,
  },
})
