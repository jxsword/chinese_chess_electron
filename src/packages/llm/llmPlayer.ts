/**
 * 大模型棋手（05 文档 §4 五层过滤管线 + 兜底链；llm_move_source.dart LlmMoveSource 1:1 移植）。
 *
 * 每手流程：合法清单 → Prompt(v1/v2) → 调用 → 解析 → 白名单校验 →
 * （失败）user 末尾追加反馈重试 →（耗尽）降级 builtinAi/resign。
 * 模型只"提议"，本地规则是唯一事实源——白名单比对是精确字符串匹配（铁律 #3）。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */
import type { Board, Move } from '@packages/rules'
import type { MoveSource, MoveSourceResult } from '@packages/engine'
import type { LlmEndpointConfig, LlmTestConnectionResult, SecureSlot } from '@shared/ipc/types'
import {
  TEST_CONNECTION_SYSTEM,
  TEST_CONNECTION_USER,
  buildChatRequest,
  isConfigured,
  annotateModelHint,
  extractMove,
  retryFeedback,
  retryFeedbackV2,
  systemV1,
  systemV2,
  userV1,
  userV2,
  encodeMove,
  LlmApiError,
  LlmConfigError,
  type LlmFallback,
  type LlmTransport
} from './index'

/** 取消标记错误（对局重开/悔棋时经 cancelCurrent 结算在途请求）。 */
export const LLM_CANCELED = 'llm chat canceled'

/** 默认 requestId 生成器（三端安全；渲染层可注入 UUID 版 createRequestId）。 */
let idCounter = 0
const defaultNewId = (): string => `llm-${Date.now().toString(36)}-${(++idCounter).toString(36)}`

export interface LlmChatClientOptions {
  /** 掩码 Key 回读场景：主进程按槽位注入真实 Authorization（DR-010） */
  authSlot?: SecureSlot
  /** requestId 工厂（测试注入可预测 id；默认 UUID，00 §3.2） */
  newId?: () => string
}

/**
 * 单次对话客户端：buildChatRequest → transport → 结局结算。
 * 取消：cancelCurrent 立即以 LLM_CANCELED 拒绝在途请求并通知传输层。
 */
export class LlmChatClient {
  private inFlight: { requestId: string; reject: (e: Error) => void } | null = null

  constructor(
    protected readonly config: LlmEndpointConfig,
    protected readonly transport: LlmTransport,
    protected readonly options: LlmChatClientOptions = {}
 ) {}

  /** 状态栏展示名（llm_move_source.dart:257）。 */
  get displayName(): string {
    const model = this.config.model.trim()
    return model === '' ? '（未配置模型）' : model
  }

  /**
   * 一次性的文本问答（残局求解辅助等复用同一条流式通道）。
   * 与 nextMove 的区别：不附加合法清单协议，也不做重试降级。
   * useV2 决定 max_tokens 预算（8192/4096，llm_move_source.dart:365）。
   */
  async chatOnce(system: string, user: string, opts: { useV2?: boolean } = {}): Promise<string> {
    const built = buildChatRequest(this.config, system, user, {
      useV2: opts.useV2 ?? false,
      authSlot: this.options.authSlot
    })
    const requestId = this.options.newId?.() ?? defaultNewId()
    return await new Promise<string>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (this.inFlight !== null && this.inFlight.requestId === requestId) this.inFlight = null
        fn()
      }
      this.inFlight = { requestId, reject }
      void this.transport.chat({ ...built, requestId }, {
        onDone: (text) => settle(() => resolve(text)),
        onError: (message) => settle(() => reject(new LlmApiError(message)))
      })
    })
  }

  /** 取消在途请求：本地立即结算 + 通知传输层（主进程 abort，幂等）。 */
  async cancelCurrent(): Promise<void> {
    const inflight = this.inFlight
    if (inflight === null) return
    this.inFlight = null
    inflight.reject(new Error(LLM_CANCELED))
    await this.transport.cancel(inflight.requestId)
  }
}

export interface LlmPlayerOptions {
  /** Prompt v2（棋盘图 + 注解 + 分析段）；默认 false 保留 v1 协议（能力评估基线）。 */
  usePromptV2?: boolean
  /** 最多请求次数（含首次），默认 3。 */
  maxAttempts?: number
  /** 模型持续失败时的降级策略。 */
  fallback: LlmFallback
  /** builtinAi 降级时的内置 AI 棋手工厂（对局页注入 ChessAiPlayer(difficulty 3)）。 */
  builtinAiSource: () => MoveSource
  /** 每次尝试开始时的进度回调（思考型模型单次可达数分钟，UI 借此显示"第 N/M 次尝试"） */
  onAttempt?: (attempt: number, totalAttempts: number) => void
}

export class LlmPlayer implements MoveSource {
  private readonly client: LlmChatClient
  private readonly usePromptV2: boolean
  private readonly maxAttempts: number

  constructor(
    config: LlmEndpointConfig,
    transport: LlmTransport,
    private readonly options: LlmPlayerOptions,
    clientOptions: LlmChatClientOptions = {}
  ) {
    this.client = new LlmChatClient(config, transport, clientOptions)
    this.usePromptV2 = options.usePromptV2 ?? false
    this.maxAttempts = options.maxAttempts ?? 3
  }

  get displayName(): string {
    return this.client.displayName
  }

  /** 取消在途请求（对局重开/悔棋/离开页面时调用，00 §3.2）。 */
  async cancelCurrent(): Promise<void> {
    await this.client.cancelCurrent()
  }

  async nextMove(board: Board, history: readonly Move[] = []): Promise<MoveSourceResult> {
    const legal = board.allLegalMoves()
    if (legal.length === 0) return { status: 'noLegalMove' }

    const codesByMove = new Map<string, Move>()
    for (const move of legal) codesByMove.set(encodeMove(move), move)
    const legalCodes = [...codesByMove.keys()]

    const system = this.usePromptV2 ? systemV2(board.turn) : systemV1(board.turn)
    let user = this.usePromptV2
      ? userV2(board, history, legal)
      : userV1(board, history, legalCodes)

    let lastNote: string | undefined
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this.options.onAttempt?.(attempt, this.maxAttempts)
      let content: string
      try {
        content = await this.client.chatOnce(system, user, { useV2: this.usePromptV2 })
      } catch (e) {
        // 取消（新局/悔棋/离开页面）：原样上抛，页面按取消收口（等价 ChessAiPlayer）。
        if (e instanceof Error && e.message === LLM_CANCELED) throw e
        lastNote = `第 ${attempt} 次调用失败：${String(e instanceof Error ? e.message : e)}`
        // 网络类错误重试意义有限，但仍给满次数（端点偶发抖动常见）。
        continue
      }

      const code = extractMove(content)
      const move = code === null ? undefined : codesByMove.get(code)
      if (move !== undefined) {
        // 严格单行格式下回复无附加信息，成功时 note 留空。
        return { status: 'ok', move }
      }

      const reason =
        code === null ? '无法从回复中解析出着法' : `着法 ${code} 不在合法清单中`
      lastNote = `第 ${attempt} 次回复无效（${reason}）`
      user += this.usePromptV2
        ? retryFeedbackV2(reason, code ?? undefined)
        : retryFeedback(reason)
    }

    return this.fallback(board, lastNote ?? `模型连续 ${this.maxAttempts} 次未给出合法着法`)
  }

  /** 降级：内置 AI 代走（默认）或判负（llm_move_source.dart:317-335）。 */
  private async fallback(board: Board, reason: string): Promise<MoveSourceResult> {
    if (this.options.fallback === 'builtinAi') {
      const result = await this.options.builtinAiSource().nextMove(board)
      if (result.status === 'ok' && result.move !== undefined) {
        return {
          status: 'ok',
          move: result.move,
          note: `${reason}，已由内置 AI 兜底走子`,
          fromFallback: true
        }
      }
      return { status: 'noLegalMove' }
    }
    return { status: 'failed', note: `${reason}，按判负处理` }
  }
}

/**
 * 配置卡"测试连接"：发一条最小请求，返回 (是否成功, 说明)
 * （llm_move_source.dart:488-497；错误消息附模型类型误用提示）。
 */
export async function testLlmConnection(
  config: LlmEndpointConfig,
  transport: LlmTransport,
  authSlot?: SecureSlot,
  newId?: () => string
): Promise<LlmTestConnectionResult> {
  try {
    if (!isConfigured(config)) {
      throw new LlmConfigError('模型端点未配置（需填写端点与模型 ID）')
    }
    const client = new LlmChatClient(config, transport, { authSlot, newId })
    await client.chatOnce(TEST_CONNECTION_SYSTEM, TEST_CONNECTION_USER)
    return { ok: true, message: `连接成功，模型 ${config.model} 响应正常` }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, message: `连接失败：${annotateModelHint(message)}` }
  }
}
