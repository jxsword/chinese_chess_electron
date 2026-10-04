/**
 * 主进程视觉识图服务（05 文档 §7，vision_board_reader.dart 的 HTTP 部分等价移植）。
 *
 * - 非流式 POST OpenAI 兼容 /chat/completions（多模态 image_url + 文本提示词）；
 * - 单次超时 120s（AbortController），最多尝试 2 次——HTTP 错误、超时、
 *   JSON 坏损、双王校验失败均触发重试（协议/解析复用 packages/llm/vision 纯函数）；
 * - Key 注入（DR-010）：渲染层只见掩码 Key，携带 authSlot 时由本服务从凭据
 *   槽位注入真实 Authorization；持完整 Key（用户刚输入未回读）时直接内联。
 */
import { LlmApiError } from '@packages/llm'
import {
  VISION_MAX_ATTEMPTS,
  VISION_TIMEOUT_MS,
  buildVisionRequest,
  excerptVisionBody,
  parseVisionPieces,
  parseVisionTurn,
  visionGridToFen
} from '@packages/llm/vision'
import type { SecureSlot, VisionReadBoardRequest, VisionReadBoardResult } from '@shared/ipc/types'

export interface VisionReaderOptions {
  /** 单次请求超时毫秒数（默认 120s；测试注入短超时）。 */
  timeoutMs?: number
  /** 最多尝试次数（默认 2；测试注入 1 以观察错误直通）。 */
  maxAttempts?: number
  /** 凭据槽位 → 完整 API Key（authSlot 注入用；无/未配置返回 null）。 */
  resolveApiKey?(slot: SecureSlot): string | null
}

/** 超时的用户可操作提示（与普通异常区分，vision_board_reader.dart:71-74）。 */
function timeoutMessage(timeoutMs: number): string {
  return (
    `请求超时（${Math.round(timeoutMs / 1000)}s）。` +
    '大模型思维链过慢或网络较差，可重试或更换更快的视觉模型'
  )
}

export class VisionReader {
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly resolveApiKey: (slot: SecureSlot) => string | null

  constructor(options: VisionReaderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? VISION_TIMEOUT_MS
    this.maxAttempts = options.maxAttempts ?? VISION_MAX_ATTEMPTS
    this.resolveApiKey = options.resolveApiKey ?? (() => null)
  }

  /** 调用视觉模型识别棋盘，返回组装好的 FEN；全部尝试耗尽抛 LlmApiError。 */
  async readBoard(req: VisionReadBoardRequest): Promise<VisionReadBoardResult> {
    // DR-010：掩码 Key（secure.get 回读）→ authSlot 注入真实 Key；完整 Key 直接内联。
    const key = req.config.apiKey.trim()
    let apiKey = key
    if (key.startsWith('****')) {
      const real =
        req.authSlot !== undefined ? (this.resolveApiKey(req.authSlot) ?? '') : ''
      apiKey = real
    }

    const dataUrl = `data:${req.mime};base64,${req.imageBase64}`
    const built = buildVisionRequest({ ...req.config, apiKey }, dataUrl)

    let lastError: string | null = null
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const content = await this.requestOnce(built.url, built.headers, built.body)
        const grid = parseVisionPieces(content)
        const turn = parseVisionTurn(content)
        return { fen: visionGridToFen(grid, turn) }
      } catch (e) {
        if (e instanceof VisionTimeoutError) {
          lastError = timeoutMessage(this.timeoutMs)
        } else {
          lastError = e instanceof Error ? e.message : String(e)
        }
      }
    }
    throw new LlmApiError(`已重试 ${this.maxAttempts} 次仍失败：${lastError ?? '未知错误'}`)
  }

  private async requestOnce(
    url: string,
    headers: Record<string, string>,
    body: string
  ): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    } catch (e) {
      // 超时中止与网络错误在此汇合；按 abort 标记区分提示。
      if (controller.signal.aborted) throw new VisionTimeoutError()
      throw new Error(`连接失败：${e instanceof Error ? e.message : String(e)}`, { cause: e })
    } finally {
      clearTimeout(timer)
    }
    if (response.status !== 200) {
      const text = await safeText(response)
      throw new Error(`HTTP ${response.status}: ${excerptVisionBody(text)}`, { cause: response.status })
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error('响应不是合法 JSON')
    }
    const choices = (payload as { choices?: unknown })['choices']
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error('响应缺少 choices')
    }
    const message = (choices[0] as { message?: unknown })['message']
    const content = (message as { content?: unknown } | null)?.['content']
    if (typeof content !== 'string') {
      throw new Error('响应缺少正文')
    }
    return content
  }
}

class VisionTimeoutError extends Error {}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
