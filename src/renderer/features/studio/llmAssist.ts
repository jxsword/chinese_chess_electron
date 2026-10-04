/**
 * 工作室"大模型辅助"编排（endgame_studio_page.dart:_runLlmAssist 1:1 移植，
 * 05 文档 §6 时序）：模型提议首着与思路 → 求解器 isWinningFirstMove 验证 →
 * 通过才作为 llmNote 写入棋谱；未通过/失败也生成说明文字（求解照常进行）。
 */
import { Board, type Move } from '@packages/rules'
import { decodeCell, proposeSolveFirstMove, type LlmTransport } from '@packages/llm'
import type { LlmEndpointConfig, SecureSlot } from '@shared/ipc/types'

export interface SolveAssistRunOptions {
  timeLimitMs: number
  maxPlies: number
}

export interface SolveAssistContext {
  /** 助手槽位配置（null/未配置 → 返回 null，静默跳过辅助） */
  config: LlmEndpointConfig | null
  transport: LlmTransport
  authSlot?: SecureSlot
}

/**
 * 执行一次 LLM 求解辅助，返回 llmNote 文本；null = 未配置（不产生注释）。
 * verify 为求解器裁判（SolverClient.isWinningFirstMove 的适配），保持本模块
 * 不直接依赖 worker 客户端。
 *
 * options.timeLimitMs/maxPlies 透传给求解器验证（与正式求解同口径），
 * 由 verify 适配层消费；本函数仅负责协议与文案。
 */
export async function runSolveAssist(
  fen: string,
  options: SolveAssistRunOptions,
  verify: (fen: string, firstMove: Move) => Promise<boolean>,
  ctx: SolveAssistContext
): Promise<string | null> {
  void options
  const config = ctx.config
  if (config === null || config.baseUrl.trim() === '' || config.model.trim() === '') {
    return null
  }
  try {
    const board = Board.fromFen(fen)
    const { proposal, message } = await proposeSolveFirstMove(board, config, ctx.transport, {
      authSlot: ctx.authSlot
    })
    const code = proposal?.firstMoveCode ?? null
    if (code === null) {
      return `大模型辅助未给出有效提议（${message}）`
    }
    // extract 返回 "h2-e2" 格式；解析前归一化掉分隔符。
    const normalized = code.replaceAll(/[^a-i0-9]/g, '')
    if (normalized.length !== 4) {
      return `大模型辅助未给出有效提议（${message}）`
    }
    const from = decodeCell(normalized.slice(0, 2))
    const to = decodeCell(normalized.slice(2, 4))
    if (from === null || to === null) return null
    const verified = await verify(fen, { from, to })
    const idea = proposal?.idea
    return verified
      ? `大模型首选 ${code}（已验证为必胜着法）${idea === null || idea === undefined ? '' : `；思路: ${idea}`}`
      : `大模型首选 ${code} 未通过求解器验证，已忽略${idea === null || idea === undefined ? '' : `；思路: ${idea}`}`
  } catch (e) {
    return `大模型辅助调用失败：${e instanceof Error ? e.message : String(e)}`
  }
}
