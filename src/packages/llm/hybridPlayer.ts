/**
 * 引擎参谋制走子来源（05 文档 §5 单手棋总决策流程；
 * hybrid_llm_move_source.dart 1:1 移植）。
 *
 * 每手棋先由本地引擎搜索出带评分的候选报告，再按 advisorMode 决定 LLM 的决策空间：
 * - **候选模式**（candidate）：Prompt 只给引擎 Top-K 短名单（附分数分桶），LLM 从中
 *   选一——"只在好棋里挑"；
 * - **护航模式**（gate）：LLM 在全量清单中自由选择，引擎对其选择单独评估，
 *   相对最佳分差超过否决阈值（丢大子/被杀）时行使否决权——带理由再问
 *   一次，仍不行由引擎最佳着法代走（这是参谋职责，不走"模型失败"的
 *   resign 降级分支）；
 * - **关闭**（off）：等价 P0（Prompt v2 + 全量清单），用于能力评估基线对比。
 *
 * 棋力旋钮 strengthBlend（0~100）：候选模式 K = 3 + blend/20（3~8）；
 * 护航模式否决阈值 = 80 + 3.2×blend 厘兵（blend=100 时不否决）。
 * 兜底链：LLM 失效 → 引擎最佳着法代走（note 注明），永不卡死。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */
import type { Board, Move } from '@packages/rules'
import type { EngineReport, MoveSource, MoveSourceResult } from '@packages/engine'
import type { LlmEndpointConfig, SecureSlot } from '@shared/ipc/types'
import {
  LLM_CANCELED,
  LlmChatClient,
  LlmPlayer,
  annotateMove,
  annotatedWithBucket,
  asciiBoard,
  encodeMove,
  extractMove,
  historyTextV2,
  retryFeedbackV2,
  scoreBucket,
  systemV2,
  vetoFeedback,
  type AdvisorMode,
  type LlmFallback,
  type LlmTransport
} from './index'

/** 引擎参谋接口（EngineClient 结构兼容；测试注入 fake）。 */
export interface AdvisorEngine {
  findBestMoveEx(
    fen: string,
    options?: { depth?: number; topK?: number; timeLimitMs?: number }
  ): Promise<EngineReport | null>
  evaluateMove(fen: string, move: Move, options?: { depth?: number }): Promise<number | null>
}

export interface HybridLlmPlayerOptions {
  /** 引擎参谋模式，默认 candidate。 */
  advisorMode?: AdvisorMode
  /** 棋力旋钮 0~100，默认 50。 */
  strengthBlend?: number
  /** 参谋搜索深度档 1~5（迭代深度 = 档 + 1），默认 5。 */
  advisorDifficulty?: number
  /** 最多请求次数（含首次），默认 3。 */
  maxAttempts?: number
  /** 模型持续失败时的降级策略（off 模式与候选/护航兜底共用）。 */
  fallback: LlmFallback
  /** off 模式（纯 Prompt v2）降级链所需的内置 AI 棋手工厂。 */
  builtinAiSource: () => MoveSource
  /** 每次尝试开始时的进度回调（UI 显示"第 N/M 次尝试"用）。 */
  onAttempt?: (attempt: number, totalAttempts: number) => void
}

export interface HybridLlmClientOptions {
  /** 掩码 Key 回读场景：主进程按槽位注入真实 Authorization（DR-010）。 */
  authSlot?: SecureSlot
  /** requestId 工厂（测试注入可预测 id）。 */
  newId?: () => string
}

export class HybridLlmPlayer implements MoveSource {
  private readonly client: LlmChatClient
  private readonly advisorMode: AdvisorMode
  private readonly strengthBlend: number
  private readonly advisorDifficulty: number
  private readonly maxAttempts: number
  /** off 模式的纯 Prompt v2 委托（懒构造，取消链路覆盖） */
  private offDelegate: LlmPlayer | null = null

  constructor(
    private readonly config: LlmEndpointConfig,
    private readonly transport: LlmTransport,
    private readonly engine: AdvisorEngine,
    private readonly options: HybridLlmPlayerOptions,
    private readonly clientOptions: HybridLlmClientOptions = {}
  ) {
    this.client = new LlmChatClient(config, transport, clientOptions)
    this.advisorMode = options.advisorMode ?? 'candidate'
    this.strengthBlend = options.strengthBlend ?? 50
    this.advisorDifficulty = options.advisorDifficulty ?? 5
    this.maxAttempts = options.maxAttempts ?? 3
  }

  get displayName(): string {
    return this.client.displayName
  }

  /** 取消在途请求（off 委托与参谋链路都覆盖；对局重开/暂停/离开页面时调用）。 */
  async cancelCurrent(): Promise<void> {
    await this.offDelegate?.cancelCurrent()
    await this.client.cancelCurrent()
  }

  /** 候选名单宽度：blend 0→3，100→8（hybrid_llm_move_source.dart:74）。 */
  static shortlistSize(blend: number): number {
    return Math.min(8, Math.max(3, 3 + Math.floor(blend / 20)))
  }

  /** 护航否决阈值（厘兵）：blend 0→80（严），100→400（最宽）（:77-78）。 */
  static vetoThresholdCp(blend: number): number {
    return 80 + Math.trunc((320 * Math.min(100, Math.max(0, blend))) / 100)
  }

  /** 参谋迭代深度：档位 1~5 → 2~6（:85）。 */
  private get depth(): number {
    return Math.min(5, Math.max(1, this.advisorDifficulty)) + 1
  }

  async nextMove(board: Board, history: readonly Move[] = []): Promise<MoveSourceResult> {
    if (this.advisorMode === 'off') {
      // P0 基线：Prompt v2 + 全量清单，无参谋（:92-103；等价每次新建
      // LlmMoveSource(usePromptV2: true) 的 Dart 写法，此处惰性单例保取消语义）。
      if (this.offDelegate === null) {
        this.offDelegate = new LlmPlayer(
          this.config,
          this.transport,
          {
            usePromptV2: true,
            maxAttempts: this.maxAttempts,
            fallback: this.options.fallback,
            builtinAiSource: this.options.builtinAiSource
          },
          this.clientOptions
        )
      }
      return this.offDelegate.nextMove(board, history)
    }
    return this.nextMoveWithAdvisor(board, history)
  }

  private async nextMoveWithAdvisor(
    board: Board,
    history: readonly Move[]
  ): Promise<MoveSourceResult> {
    const legal = board.allLegalMoves()
    if (legal.length === 0) return { status: 'noLegalMove' }

    // 1. 引擎参谋搜索（EngineClient 内部已含 Isolate/Worker 兜底语义）。
    const fen = board.toFen()
    const depth = this.depth
    const topK = HybridLlmPlayer.shortlistSize(this.strengthBlend)
    const report = await this.engine.findBestMoveEx(fen, { depth, topK, timeLimitMs: 5000 })
    if (report === null) return { status: 'noLegalMove' }

    // 2. 本轮 LLM 可见池 + Prompt v2。
    const pool =
      this.advisorMode === 'candidate' ? report.topK.map(([move]) => move) : legal
    const poolByCode = new Map<string, Move>()
    for (const move of pool) poolByCode.set(encodeMove(move), move)
    // 分档引导只在清单真的带分桶时出现（候选模式）。
    const system = systemV2(board.turn, this.advisorMode === 'candidate')
    let user = this.buildUser(board, history, pool, report)

    // 3. LLM 提议（重试带失败原因）。lastReason 仅记录"模型未给出有效
    // 着法"类真失败；一旦给出有效着法即置 null。
    let lastReason: string | undefined
    let pick: Move | undefined
    let pickCp: number | undefined
    for (let attempt = 1; attempt <= this.maxAttempts && pick === undefined; attempt++) {
      this.options.onAttempt?.(attempt, this.maxAttempts)
      let content: string
      try {
        content = await this.client.chatOnce(system, user, { useV2: true })
      } catch (e) {
        if (e instanceof Error && e.message === LLM_CANCELED) throw e
        lastReason = `第 ${attempt} 次调用失败：${String(e instanceof Error ? e.message : e)}`
        continue
      }
      const lastCode = extractMove(content)
      pick = lastCode === null ? undefined : poolByCode.get(lastCode)
      if (pick === undefined) {
        lastReason =
          lastCode === null ? '无法从回复中解析出着法' : `着法 ${lastCode} 不在候选清单中`
        user += retryFeedbackV2(lastReason, lastCode ?? undefined)
      } else {
        lastReason = undefined
      }
    }

    // 4. 护航模式：引擎否决权。否决是参谋的正常职责——即使最终由引擎
    // 最佳代走，也不走"模型失败"的降级分支（该分支遵循 resign 设置）。
    let vetoEvalCp: number | null | undefined
    let vetoOverridden = false
    if (pick !== undefined && this.advisorMode === 'gate' && this.strengthBlend < 100) {
      const vetoDepth = depth - 1
      const picked = pick
      vetoEvalCp = await this.engine.evaluateMove(fen, picked, { depth: vetoDepth })
      if (vetoEvalCp === null || vetoEvalCp === undefined) {
        pick = undefined // 非法着法（理论上不会发生，池内均合法）
      } else {
        const loss = report.bestCp - vetoEvalCp
        if (loss > HybridLlmPlayer.vetoThresholdCp(this.strengthBlend)) {
          const second = await this.askAgainWithVeto(
            board,
            history,
            poolByCode,
            report,
            system,
            user,
            picked,
            loss
          )
          if (second !== null) {
            pick = second.move
            pickCp = second.cp
          } else {
            // 两次都违抗否决：采用引擎最佳（参谋职责，非模型失效）。
            vetoOverridden = true
            pick = report.best
            pickCp = report.bestCp
          }
        }
      }
    }

    // 5. 兜底链与注解。
    if (pick === undefined) {
      const reason = `模型未给出有效着法${lastReason === undefined ? '' : `（${lastReason}）`}`
      if (this.options.fallback === 'builtinAi') {
        return {
          status: 'ok',
          move: report.best,
          note: `${reason}，已由参谋（内置引擎）代走`,
          fromFallback: true
        }
      }
      return { status: 'failed', note: `${reason}，按判负处理` }
    }

    if (vetoOverridden) {
      return {
        status: 'ok',
        move: pick,
        note: `已由参谋否决（两次选择均造成${scoreBucket(report.bestCp - pickCp!)}的损失），改为引擎最佳着法`,
        fromFallback: true
      }
    }

    let chosenCp: number | null | undefined = pickCp ?? HybridLlmPlayer.cpOf(report, pick)
    if (chosenCp === undefined) chosenCp = vetoEvalCp
    const note =
      chosenCp === undefined || chosenCp === null
        ? '参谋评分: 未单独评估'
        : `参谋评分: ${scoreBucket(report.bestCp - chosenCp)}`
    return { status: 'ok', move: pick, note }
  }

  /** 否决后的再问：带否决理由重新提议一次（:280-318）。
   * 返回 (着法, 引擎评分)；第二次选择仍超阈值、无效或调用失败返回 null。 */
  private async askAgainWithVeto(
    board: Board,
    history: readonly Move[],
    poolByCode: Map<string, Move>,
    report: EngineReport,
    system: string,
    user: string,
    vetoed: Move,
    loss: number
  ): Promise<{ move: Move; cp: number } | null> {
    void board
    void history
    const vetoNote = vetoFeedback(user, encodeMove(vetoed), scoreBucket(loss), loss)
    let content: string
    try {
      content = await this.client.chatOnce(system, vetoNote, { useV2: true })
    } catch (e) {
      if (e instanceof Error && e.message === LLM_CANCELED) throw e
      return null
    }
    const code = extractMove(content)
    const second = code === null ? undefined : poolByCode.get(code)
    if (second === undefined) return null

    const secondCp = await this.engine.evaluateMove(board.toFen(), second, {
      depth: this.depth - 1
    })
    if (secondCp === null || secondCp === undefined) return null
    const secondLoss = report.bestCp - secondCp
    if (secondLoss > HybridLlmPlayer.vetoThresholdCp(this.strengthBlend)) return null
    return { move: second, cp: secondCp }
  }

  /** v2 用户提示的 Hybrid 版：清单为 pool（候选模式附分数分桶，:321-348）。 */
  private buildUser(
    board: Board,
    history: readonly Move[],
    pool: readonly Move[],
    report: EngineReport
  ): string {
    const buf: string[] = []
    buf.push(`【当前局面 FEN】${board.toFen()}\n`)
    buf.push('【棋盘图】\n')
    buf.push(asciiBoard(board))
    buf.push(`【轮走方】${board.turn === 'red' ? '红方' : '黑方'}（该方是你）\n`)
    buf.push(`【对局着法（中文记法，最新在最后）】${historyTextV2(history)}\n`)
    if (this.advisorMode === 'candidate') {
      buf.push(
        `【候选着法清单（共 ${pool.length} 条，由本地引擎选出，` +
          '必须从中选择一条；「—」后为引擎评估分档）】\n'
      )
      for (const [move, cp] of report.topK) {
        buf.push(`${annotatedWithBucket(board, move, report.bestCp - cp)}\n`)
      }
    } else {
      buf.push(`【合法着法清单（共 ${pool.length} 条，必须从中选择一条）】\n`)
      for (const move of pool) {
        buf.push(`${annotateMove(board, move)}\n`)
      }
    }
    buf.push('【输出】先输出「分析:」段，最后一行输出「着法: 起点-终点」')
    return buf.join('')
  }

  /** 护航模式的选择不在 Top-K 内时返回 null（:362-367）。 */
  static cpOf(report: EngineReport, move: Move): number | undefined {
    for (const [m, cp] of report.topK) {
      if (m.from.col === move.from.col && m.from.row === move.from.row && m.to.col === move.to.col && m.to.row === move.to.row) {
        return cp
      }
    }
    return undefined
  }
}
