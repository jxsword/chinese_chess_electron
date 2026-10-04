/**
 * IPC LLM 传输适配器（packages/llm LlmTransport 的 window.api.llm 实现）：
 * - 事件订阅按 requestId 过滤，chat promise 结束即反注册（迟到事件天然丢弃）；
 * - cancel 转发 cc:llm:cancel（主进程 AbortController.abort）。
 */
import { api, createRequestId } from '@renderer/ipc/client'
import type { LlmChatHandlers, LlmChatWireRequest, LlmTransport } from '@packages/llm'

export function createIpcLlmTransport(): LlmTransport {
  return {
    chat(req: LlmChatWireRequest, handlers: LlmChatHandlers): Promise<void> {
      const offChunk = api.llm.onChunk((e) => {
        if (e.requestId === req.requestId) handlers.onChunk?.(e.delta)
      })
      const offDone = api.llm.onDone((e) => {
        if (e.requestId === req.requestId) handlers.onDone(e.text)
      })
      const offError = api.llm.onError((e) => {
        if (e.requestId === req.requestId) handlers.onError(e.message)
      })
      return api.llm
        .chat({
          requestId: req.requestId,
          url: req.url,
          headers: req.headers,
          body: req.body,
          authSlot: req.authSlot
        })
        .finally(() => {
          offChunk()
          offDone()
          offError()
        })
    },
    cancel: async (requestId: string) => {
      await api.llm.cancel(requestId)
    }
  }
}

/** 渲染层 requestId 工厂再导出（LlmChatClientOptions.newId 注入用，00 §3.2 UUID）。 */
export const llmRequestId = createRequestId
