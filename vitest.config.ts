import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// 单测运行于 Node 环境（packages/* 纯 TS 三端共用的第三端，见 00 文档 §4 分层原则）
// UI 组件测试在各自文件以 `// @vitest-environment jsdom` 声明浏览器环境
export default defineConfig({
  esbuild: {
    // test/*.tsx 不在任何 tsconfig include 内，显式指定自动 JSX 运行时
    jsx: 'automatic'
  },
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
