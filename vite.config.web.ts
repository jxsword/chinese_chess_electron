import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 浏览器开发模式（npm run dev:web）：只跑 renderer，IPC 走 mock 层（00 文档 §6）
export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer'),
      '@packages': resolve('src/packages')
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: resolve('dist-web'),
    emptyOutDir: true
  }
})
