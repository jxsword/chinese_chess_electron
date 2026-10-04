/**
 * 主进程 LLM SSE 代理（05 文档 §3，DR-004/DR-005）。
 *
 * - 对外 HTTP 收敛在主进程（DR-004）：undici（Node 内置 fetch 即 undici 实现）
 *   流式 POST，SSE 增量逐块经 sender 转发（cc:llm:chunk）；
 * - 空闲超时 = 两次数据块的最大间隔（模型持续吐字不误判），每收到一块重置；
 *   总耗时上限 = 空闲超时 × 4（独立计时器，防思维链无限输出）——
 *   计时器只在主进程侧（00 文档 §2 TIMER 职责铁律）；
 * - 取消：cancel(requestId) → AbortController.abort，此后不再有任何事件；
 * - HTTP ≠ 200：截取响应体前 160 字符进错误消息，命中模型类型误用特征时
 *   附加 annotateModelHint 提示（05 §3.2）；
 * - 鉴权（DR-010）：渲染层只见掩码 Key，请求载荷带 authSlot 时由本代理从
 *   凭据槽位注入真实 Authorization，完整 Key 不回渲染层内存。
 */
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import {
  SseAssembler,
  annotateModelHint,
  resolveTimeoutSeconds,
  buildTestConnectionChat,
  LlmApiError
} from '@packages/llm'
import type {
  LlmChatRequest,
  LlmDelta,
  LlmEndpointConfig,
  LlmTestConnectionResult,
  SecureSlot
} from '@shared/ipc/types'

/** 测试连接的请求序号（进程内自增即可，无并发碰撞面）。 */
let testConnCounter = 0

/** 事件回发接口（ipc/llm.ts 以 webContents.send 实现；测试以收集器实现）。 */
export interface LlmProxySender {
  sendChunk(requestId: string, delta: LlmDelta): void
  sendDone(requestId: string, text: string): void
  sendError(requestId: string, message: string): void
}

export interface LlmProxyOptions {
  /** 空闲超时秒数来源（llm_settings_timeoutSeconds，未配置回落默认并 clamp） */
  getTimeoutSeconds(): number
  /** 凭据槽位 → 完整 API Key（authSlot 注入用；无/未配置返回 null） */
  resolveApiKey?(slot: SecureSlot): string | null
}

interface ActiveRequest {
  readonly controller: AbortController
  idleTimer: ReturnType<typeof setTimeout> | null
  totalTimer: ReturnType<typeof setTimeout> | null
  cancelled: boolean
  settled: boolean
}

export class LlmProxy {
  private readonly active = new Map<string, ActiveRequest>()

  constructor(private readonly options: LlmProxyOptions) {}

  /** 在途请求数（测试观察用）。 */
  get size(): number {
    return this.active.size
  }

  /**
   * 发起一次流式对话（cc:llm:chat）。promise 仅表示"处理完毕"（正常/出错/取消），
   * 结局一律经 sender 事件传递，与 WindowApi.llm.chat 契约一致。
   *
   * override.idleTimeoutMs：测试注入短超时用；生产路径恒由设置解析（clamp 5~600s）。
   */
  async chat(
    req: LlmChatRequest,
    sender: LlmProxySender,
    override?: { idleTimeoutMs?: number }
  ): Promise<void> {
    const idleMs =
      override?.idleTimeoutMs !== undefined
        ? override.idleTimeoutMs
        : resolveTimeoutSeconds(this.options.getTimeoutSeconds()) * 1000
    const totalMs = idleMs * 4
    const idleSec = Math.round(idleMs / 1000)
    const totalSec = Math.round(totalMs / 1000)

    const controller = new AbortController()
    const state: ActiveRequest = {
      controller,
      idleTimer: null,
      totalTimer: null,
      cancelled: false,
      settled: false
    }
    this.active.set(req.requestId, state)

    const clearTimers = (): void => {
      if (state.idleTimer !== null) clearTimeout(state.idleTimer)
      if (state.totalTimer !== null) clearTimeout(state.totalTimer)
      state.idleTimer = null
      state.totalTimer = null
    }
    const finish = (): void => {
      clearTimers()
      this.active.delete(req.requestId)
    }
    const fail = (message: string): void => {
      if (state.settled || state.cancelled) return
      state.settled = true
      finish()
      sender.sendError(req.requestId, message)
    }
    const succeed = (text: string): void => {
      if (state.settled || state.cancelled) return
      state.settled = true
      finish()
      sender.sendDone(req.requestId, text)
    }
    const resetIdle = (): void => {
      if (state.idleTimer !== null) clearTimeout(state.idleTimer)
      state.idleTimer = setTimeout(() => {
        controller.abort()
        fail(`空闲超时（${idleSec}s 内无响应数据，可在对局设置中调大）`)
      }, idleMs)
    }

    // 总耗时上限独立计时（05 §3.2：防思维链无限制输出）。
    state.totalTimer = setTimeout(() => {
      controller.abort()
      fail(
        `总耗时超过 ${totalSec}s（可在对局设置中调大超时，或为 Qwen3 等模型开启「关闭思维链」）`
      )
    }, totalMs)

    // DR-010：渲染层持掩码 Key，经 authSlot 由主进程注入真实鉴权头。
    const headers: Record<string, string> = { ...req.headers }
    if (req.authSlot !== undefined) {
      const realKey = this.options.resolveApiKey?.(req.authSlot) ?? null
      if (realKey !== null && realKey !== '') {
        headers['Authorization'] = `Bearer ${realKey}`
      } else {
        delete headers['Authorization']
      }
    }

    let response: Response
    try {
      resetIdle()
      response = await fetch(req.url, {
        method: 'POST',
        headers,
        body: req.body,
        signal: controller.signal
      })
    } catch (e) {
      // 取消/超时已发事件或不应发事件：静默收尾。
      if (state.settled || state.cancelled) return
      finish()
      const message = e instanceof Error ? e.message : String(e)
      sender.sendError(req.requestId, `连接失败：${message}`)
      return
    }

    if (response.status !== 200) {
      const body = await safeText(response)
      fail(annotateModelHint(`HTTP ${response.status}: ${excerpt(body)}`))
      return
    }
    if (response.body === null) {
      fail('HTTP 200：响应无内容流')
      return
    }

    const assembler = new SseAssembler()
    // Web ReadableStream → Node 流（async 可迭代），utf8 解码后按行切分；
    // 半行跨 TCP 分包时经 buffer 重组（utf8 边界由 Buffer.toString 保证）。
    const stream = Readable.fromWeb(response.body as NodeWebReadableStream<Uint8Array>)
    let buffer = ''
    try {
      for await (const chunk of stream) {
        if (state.settled || state.cancelled) return
        buffer += Buffer.from(chunk as Uint8Array).toString('utf8')
        let idx = buffer.indexOf('\n')
        while (idx >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          const result = assembler.handleLine(line)
          if (state.settled || state.cancelled) return
          if (result.delta !== undefined) sender.sendChunk(req.requestId, result.delta)
          if (result.ended) {
            succeed(assembler.pickAnswer())
            return
          }
          idx = buffer.indexOf('\n')
        }
        resetIdle() // 每收到一块 → 重置空闲计时器（05 §3.2）
      }
      // 流自然结束（部分端点不发 [DONE]）：以已累积内容结算。
      succeed(assembler.pickAnswer())
    } catch (e) {
      if (state.settled || state.cancelled) return
      if (e instanceof LlmApiError) {
        fail(e.message)
        return
      }
      const message = e instanceof Error ? e.message : String(e)
      fail(`连接中断：${message}`)
    }
  }

  /**
   * 配置卡"测试连接"（cc:llm:testConnection）：单次最小流式请求，
   * 收集结局返回结果（llm_move_source.dart:488-497 语义，主进程执行）。
   */
  async testConnection(config: LlmEndpointConfig): Promise<LlmTestConnectionResult> {
    const built = buildTestConnectionChat(config)
    const requestId = `test-conn-${Date.now()}-${++testConnCounter}`
    return await new Promise<LlmTestConnectionResult>((resolve) => {
      void this.chat(
        { requestId, url: built.url, headers: built.headers, body: built.body, authSlot: built.authSlot },
        {
          sendChunk: () => {},
          sendDone: () =>
            resolve({ ok: true, message: `连接成功，模型 ${config.model} 响应正常` }),
          sendError: (message) => resolve({ ok: false, message: `连接失败：${annotateModelHint(message)}` })
        }
      )
    })
  }

  /**
   * 取消在途请求（cc:llm:cancel → AbortController.abort）。
   * 取消后不再有任何事件（迟到丢弃在渲染层收口，00 §3.2）；幂等。
   */
  cancel(requestId: string): void {
    const state = this.active.get(requestId)
    if (state === undefined) return
    state.cancelled = true
    if (state.idleTimer !== null) clearTimeout(state.idleTimer)
    if (state.totalTimer !== null) clearTimeout(state.totalTimer)
    state.controller.abort()
    this.active.delete(requestId)
  }
}

/** 响应体安全读取：超长截断由 excerpt 负责，这里仅防御流读取异常。 */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/** 截取响应体前 160 字符（llm_move_source.dart:482-486）。 */
function excerpt(body: string): string {
  const text = body.trim()
  if (text.length <= 160) return text
  return `${text.slice(0, 160)}…`
}
