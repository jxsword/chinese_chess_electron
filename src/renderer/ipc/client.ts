import { createMockApi } from './mock-api'
import type { WindowApi } from '@shared/ipc/api'

// 00 文档 §6：Electron 内 preload 注入真实 window.api；纯浏览器（dev:web）无 preload，
// 切换到 mock 实现，保证 UI 开发不依赖主进程。
// Node 测试环境无 window：同样落到 mock（类型层契约一致，见 contract.spec）。

declare global {
  interface Window {
    readonly api?: WindowApi
  }
}

function resolveApi(): WindowApi {
  // 经 globalThis 取窗体引用：本文件会被 Node 侧测试间接引入（tsconfig.node 无 DOM 库）
  const w = (globalThis as unknown as { window?: { readonly api?: WindowApi } }).window
  if (w?.api !== undefined) return w.api
  return createMockApi()
}

export const api: WindowApi = resolveApi()

/** requestId 工厂（00 文档 §3.2）：所有异步操作（LLM/下载/Worker）统一使用 */
export function createRequestId(): string {
  return crypto.randomUUID()
}
