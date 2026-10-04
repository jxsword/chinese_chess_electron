/**
 * 大模型求解辅助（05 文档 §6，llm_solve_assist.dart 1:1 移植）。
 *
 * Hybrid 架构：模型只"提议"首着与思路，是否必胜由 EndgameSolver
 * （isWinningFirstMove）验证后才写入棋谱注释——模型启发式、引擎裁判。
 * 不走合法清单协议的五层过滤，仅复用坐标归一化提取（extractMove）；
 * 提议不在合法清单 → user 末尾追加失败原因重试（≤2 次），无降级链。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */
import type { Board } from '@packages/rules'
import type { LlmEndpointConfig, SecureSlot } from '@shared/ipc/types'
import { asciiBoard, extractMove, encodeMove, isConfigured, LlmChatClient, type LlmTransport } from './index'

/** system 提示词：三行固定格式（llm_solve_assist.dart:17-27，逐字）。 */
export const SOLVE_ASSIST_SYSTEM =
  '你是中国象棋残局研究助手，协助分析一个残局是否有强制将死的杀法。\n' +
  '坐标约定：列用字母 a-i（从左到右），行用数字 0-9' +
  '（0 为黑方底线、棋盘顶部，9 为红方底线、棋盘底部）。\n' +
  '你只能从「合法着法清单」中选择首着，禁止编造清单之外的着法。\n' +
  '\n' +
  '【回复格式（唯一允许的格式，共三行）】\n' +
  '首选着法: 起点-终点\n' +
  '备选着法: 起点-终点（没有则写 无）\n' +
  '思路: 一句话说明攻击目标与关键点\n' +
  '禁止输出其他任何内容。'

/** user 提示词：FEN + ASCII 棋盘图 + 轮走方 + 任务说明 + 完整合法着法清单（:29-40）。 */
export function solveAssistUser(board: Board, legalCodes: readonly string[]): string {
  const buf: string[] = []
  buf.push(`【局面 FEN】${board.toFen()}\n`)
  buf.push('【棋盘图（大写为红方、小写为黑方，第一行是黑方底线）】\n')
  buf.push(asciiBoard(board))
  buf.push(`【轮走方】${board.isRedTurn ? '红方' : '黑方'}（求解方）\n`)
  buf.push(
    '【任务】判断该局面求解方是否有强制将死的杀法；' +
      '若有，给出首选首着与备选首着（均取自合法着法清单）。\n'
  )
  buf.push(`【合法着法清单（共 ${legalCodes.length} 条）】\n`)
  buf.push(legalCodes.join(', '))
  return buf.join('')
}

/** 模型提议的解析结果（llm_solve_assist.dart:44-53）。 */
export interface SolveProposal {
  /** 归一化 ICCS 式 "h2-e2"（内部行号约定，同 LLM 对弈协议）。 */
  firstMoveCode: string | null
  alternateCode: string | null
  idea: string | null
}

/** 解析三行格式回复；坐标归一化复用 extractMove（:101-120）。 */
export function parseSolveProposal(content: string): SolveProposal {
  const field = (label: string): string | null => {
    const match = new RegExp(`${label}\\s*[:：]\\s*(.+)`).exec(content)
    return match?.[1]?.trim() ?? null
  }
  const code = (raw: string | null): string | null => {
    if (raw === null || raw === '' || raw.includes('无')) return null
    return extractMove(raw)
  }
  const idea = field('思路')
  return {
    firstMoveCode: code(field('首选着法')),
    alternateCode: code(field('备选着法')),
    idea: idea === null || idea === '' ? null : idea
  }
}

export interface SolveAssistOptions {
  /** 最多尝试次数（含首次），默认 2（llm_solve_assist.dart:56）。 */
  maxAttempts?: number
  /** 掩码 Key 回读场景：主进程按槽位注入真实 Authorization（DR-010）。 */
  authSlot?: SecureSlot
  /** requestId 工厂（测试注入）。 */
  newId?: () => string
}

export interface SolveProposeResult {
  /** 提议（首着不在合法清单/调用失败时为 null）。 */
  proposal: SolveProposal | null
  /** 说明（成功时为思路文本；失败时给出原因）。 */
  message: string
}

/**
 * 大模型求解辅助：一次调用链，返回候选首着与思路注释（llm_solve_assist.dart:63-98）。
 * 返回 (提议, 说明)；失败时提议为 null，说明给出原因。
 */
export async function proposeSolveFirstMove(
  board: Board,
  config: LlmEndpointConfig,
  transport: LlmTransport,
  options: SolveAssistOptions = {}
): Promise<SolveProposeResult> {
  if (!isConfigured(config)) {
    return { proposal: null, message: '研究助手模型未配置' }
  }
  const legal = board.allLegalMoves()
  if (legal.length === 0) {
    return { proposal: null, message: '当前局面无合法着法' }
  }

  const codesByMove = new Map<string, string>()
  const legalCodes: string[] = []
  for (const m of legal) {
    const code = encodeMove(m)
    if (!codesByMove.has(code)) {
      codesByMove.set(code, code)
      legalCodes.push(code)
    }
  }

  const client = new LlmChatClient(config, transport, { authSlot: options.authSlot, newId: options.newId })
  const system = SOLVE_ASSIST_SYSTEM
  let user = solveAssistUser(board, legalCodes)

  let lastError: string | null = null
  const maxAttempts = options.maxAttempts ?? 2
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let content: string
    try {
      content = await client.chatOnce(system, user)
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      user = `${user}\n\n（上次回复无效：${lastError}，请严格按三行格式重新回答）`
      continue
    }
    const proposal = parseSolveProposal(content)
    if (proposal.firstMoveCode !== null && codesByMove.has(proposal.firstMoveCode)) {
      return { proposal, message: proposal.idea ?? '' }
    }
    lastError = `回复 ${proposal.firstMoveCode ?? content} 不在合法清单中`
    user = `${user}\n\n（上次回复无效：${lastError}，请严格按三行格式重新回答）`
  }
  return { proposal: null, message: lastError ?? '未知错误' }
}
