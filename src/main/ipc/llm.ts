/**
 * cc:llm:chat / cc:llm:cancel / cc:llm:testConnection 通道 handler
 * （00 文档 §3.1；DR-005 invoke/事件语义拆分）。
 * 事件经 event.sender（webContents.send）回发；窗口销毁后不再回发。
 */
import { ipcMain } from 'electron'
import { CC } from '@shared/ipc/channels'
import type { LlmChatRequest, LlmEndpointConfig } from '@shared/ipc/types'
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

  ipcMain.handle(CC.llm.testConnection, (_event, req: { config: LlmEndpointConfig }) => {
    return proxy.testConnection(req.config)
  })
}
