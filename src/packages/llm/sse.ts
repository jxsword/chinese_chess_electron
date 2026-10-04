/**
 * SSE 流重组（五层过滤管线第 1+2 层，05 文档 §4；llm_move_source.dart:438-480 逐字移植）。
 *
 * 第 1 层：按行处理 SSE——空行与 ':' 注释心跳丢弃、data: [DONE] 结束、
 *          delta.content → 正文缓冲、delta.reasoning_content/reasoning → 思维链缓冲、
 *          chunk.error → 抛 LlmApiError、非 data 行/非 JSON 行忽略；
 * 第 2 层：文本提取——正文非空取正文；正文为空（思考型 token 耗尽）退回思维链文本。
 *
 * 纯 TypeScript：主进程 llm-proxy 与 Vitest 共用，禁止环境依赖（铁律 #1）。
 */
import { LlmApiError } from './errors'

/** 单条增量（00 文档 §3.1 delta：content?/reasoning?）。 */
export interface SseDelta {
  content?: string
  reasoning?: string
}

export interface SseLineResult {
  /** true 表示流已结束（data: [DONE]）。 */
  ended: boolean
  /** 本行携带的增量；无可转发增量时省略。 */
  delta?: SseDelta
}

export class SseAssembler {
  private contentBuf = ''
  private reasoningBuf = ''

  /** 正文缓冲（测试观察用）。 */
  get content(): string {
    return this.contentBuf
  }

  /** 思维链缓冲（测试观察用）。 */
  get reasoning(): string {
    return this.reasoningBuf
  }

  /**
   * 解析一行 SSE 数据；返回 true 表示流已结束（[DONE]）。
   * chunk.error 抛 LlmApiError（计一次失败重试，05 §4 第 1 层）。
   */
  handleLine(line: string): SseLineResult {
    const trimmed = line.trim()
    // 空行与注释（如 OpenRouter 的 ": OPENROUTER PROCESSING" 心跳）跳过。
    if (trimmed === '' || trimmed.startsWith(':')) return { ended: false }
    if (!trimmed.startsWith('data:')) return { ended: false }
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') {
      return { ended: true }
    }
    let chunk: unknown
    try {
      chunk = JSON.parse(payload)
    } catch {
      return { ended: false } // 非 JSON 行忽略
    }
    if (typeof chunk === 'object' && chunk !== null) {
      const err = (chunk as { error?: unknown }).error
      if (err !== undefined && err !== null) {
        throw new LlmApiError(`流式响应错误: ${JSON.stringify(err)}`)
      }
    }
    const choices =
      typeof chunk === 'object' && chunk !== null ? (chunk as { choices?: unknown }).choices : null
    if (!Array.isArray(choices) || choices.length === 0) return { ended: false }
    const first = choices[0] as { delta?: unknown } | null
    const delta = typeof first === 'object' && first !== null ? first.delta : null
    if (typeof delta === 'object' && delta !== null) {
      const d = delta as { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }
      const out: SseDelta = {}
      let hasDelta = false
      if (typeof d.content === 'string') {
        out.content = d.content
        this.contentBuf += d.content
        hasDelta = true
      }
      const r = d.reasoning_content ?? d.reasoning
      if (typeof r === 'string') {
        out.reasoning = r
        this.reasoningBuf += r
        hasDelta = true
      }
      return { ended: false, delta: hasDelta ? out : undefined }
    }
    return { ended: false }
  }

  /**
   * 最终答案：正文优先；正文为空（思考型模型耗尽 token）时退回思维链文本，
   * 交给着法解析器尽力提取（llm_move_source.dart:476-480）。
   */
  pickAnswer(): string {
    return this.contentBuf.trim() !== '' ? this.contentBuf : this.reasoningBuf
  }
}
