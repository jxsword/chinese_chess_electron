import { resolve } from 'path'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// 生产构建时向渲染页注入 CSP（00 文档 §5 安全清单）。
// 开发模式不注入：Vite HMR 需要内联脚本与 ws 连接。
// style-src 'unsafe-inline' 为 React 内联 style 所需，属 00 §5 的实践性放宽。
function cspForBuild(): Plugin {
  return {
    name: 'cc:inject-csp-on-build',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
          }
        }
      ]
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@packages': resolve('src/packages')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        // 00 文档 §4：preload 位于 src/main/preload（非默认的 src/preload），须显式指定入口
        input: { index: resolve('src/main/preload/index.ts') }
      }
    }
  },
  renderer: {
    plugins: [react(), cspForBuild()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
        '@packages': resolve('src/packages')
      }
    }
  }
})
