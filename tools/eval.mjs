#!/usr/bin/env node
/**
 * eval CLI 引导（npm run eval）：用 vite ssrLoadModule 加载 tools/eval.ts
 * （TS + @ 别名解析，零新依赖——vite 已在依赖树内）。
 * CLI 本体见 tools/eval.ts（Node 直连 packages/*，无需窗口，05 §8.2）。
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

const vite = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true },
  resolve: {
    alias: {
      '@main': resolve(root, 'src/main'),
      '@shared': resolve(root, 'src/shared'),
      '@renderer': resolve(root, 'src/renderer'),
      '@packages': resolve(root, 'src/packages')
    }
  }
})

try {
  const mod = await vite.ssrLoadModule('tools/eval.ts')
  await mod.main(process.argv.slice(2))
} finally {
  await vite.close()
}
