/**
 * LLM 传输抽象（packages/llm 与环境的边界）：
 * - Electron 渲染层实现：包装 window.api.llm（cc:llm:chat/cancel + 事件流）；
 * - Vitest 实现：可编程 fake（09 §2.3 失败模式表）。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */
import type { SseDelta } from './sse'
import type { SecureSlot } from '@shared/ipc/types'

/** 单条增量（等价 SseDelta；与 cc:llm:chunk 的 delta 载荷同形）。 */
export type LlmDelta = SseDelta

/** 单次 chat 的结局回调（done/error 必有其一，且至多一次；取消时两者皆无）。 */
export interface LlmChatHandlers {
  /** 增量转发（UI 流式展示用；着法管线不依赖） */
  onChunk?(delta: LlmDelta): void
  /** 正常结束：全量回复文本（正文为空时为思维链全文） */
  onDone(text: string): void
  /** 失败结束：错误消息（可能含掩码后的端点信息） */
  onError(message: string): void
}

export interface LlmChatWireRequest {
  requestId: string
  url: string
  headers: Record<string, string>
  body: string
  authSlot?: SecureSlot
}

export interface LlmTransport {
  /**
   * 发起一次流式对话。promise 仅表示"请求已被受理并处理完毕"，恒 resolve；
   * 一切结局经 handlers 传递（与 WindowApi.llm.chat 契约一致）。
   * 取消后不再有任何事件（迟到丢弃由调用方按 requestId 收口）。
   */
  chat(req: LlmChatWireRequest, handlers: LlmChatHandlers): Promise<void>
  /** 取消在途请求（幂等） */
  cancel(requestId: string): Promise<void>
}
