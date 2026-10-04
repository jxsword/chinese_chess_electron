/**
 * cc:llm:chat / cc:llm:cancel 通道 handler（00 文档 §3.1；DR-005 invoke/事件语义拆分）。
 * 事件经 event.sender（webContents.send）回发；窗口销毁后不再回发。
 * cc:llm:testConnection 属 T4.3（依赖 packages/llm 请求构建器）。
 */
import { ipcMain } from 'electron'
import { CC } from '@shared/ipc/channels'
import type { LlmChatRequest } from '@shared/ipc/types'
import type { LlmProxy, LlmProxySender } from '../services/llm-proxy'

export function registerLlmIpc(proxy: LlmProxy): void {
  ipcMain.handle(CC.llm.chat, (event, req: LlmChatRequest) => {
    const sender = event.sender
    const safeSender: LlmProxySender = {
      sendChunk: (requestId, delta) => {
        if (!sender.isDestroyed()) sender.send(CC.llm.chunk, { requestId, delta })
      },
      sendDone: (requestId, text) => {
        if (!sender.isDestroyed()) sender.send(CC.llm.done, { requestId, text })
      },
      sendError: (requestId, message) => {
        if (!sender.isDestroyed()) sender.send(CC.llm.error, { requestId, message })
      }
    }
    return proxy.chat(req, safeSender)
  })

  ipcMain.handle(CC.llm.cancel, (_event, req: { requestId: string }) => {
    proxy.cancel(req.requestId)
  })
}
