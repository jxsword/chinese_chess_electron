import { createMockApi } from './mock-api'
import type { WindowApi } from '@shared/ipc/api'

// 00 文档 §6：Electron 内 preload 注入真实 window.api；纯浏览器（dev:web）无 preload，
// 切换到 mock 实现，保证 UI 开发不依赖主进程。

declare global {
  interface Window {
    readonly api?: WindowApi
  }
}

export const api: WindowApi = window.api ?? createMockApi()

/** requestId 工厂（00 文档 §3.2）：所有异步操作（LLM/下载/Worker）统一使用 */
export function createRequestId(): string {
  return crypto.randomUUID()
}
