import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// 单测运行于 Node 环境（packages/* 纯 TS 三端共用的第三端，见 00 文档 §4 分层原则）
export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve('src/main'),
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer'),
      '@packages': resolve('src/packages')
    }
  },
  test: {
    include: ['test/**/*.spec.{ts,tsx}'],
    environment: 'node',
    passWithNoTests: true
  }
})
