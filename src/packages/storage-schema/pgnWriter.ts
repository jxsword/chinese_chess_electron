/**
 * 棋谱导出：标准 PGN 文本（ICCS 着法）+ 结果标记（对应 pgn_writer.dart，07 文档 §5 F2）。
 * 协议面：输出经快照测试锁定（test/storage/pgnWriter.spec.ts），改动须显式 review。
 * 与 packages/parsers 的 PGN 解析器（导入方向）对偶：本文件只负责生成。
 * 中文记谱分享文本在 ./shareText（writeShareText）。
 */
import { isInitialBoardFen, hasUniqueSolution, solveStatusLabel, type GameRecordData } from './gameRecord'
import { iccsFallbackFormat } from './gameRecord'

/** PGN 结果标记（pgn_writer.dart:105-119）：残局按求解状态、对局按结果。 */
export function pgnResultTag(record: GameRecordData): string {
  if (record.mode === 'endgame') {
    switch (record.solveStatus) {
      case 'solved':
        return '1-0'
      case 'noSolution':
        return '0-1'
      default:
        return '*'
    }
  }
  switch (record.result) {
    case 'redWins':
      return '1-0'
    case 'blackWins':
      return '0-1'
    case 'draw':
      return '1/2-1/2'
    default:
      return '*'
  }
}

/**
 * 生成 PGN（Seven Tag Roster + ICCS 着法序列，残局附 SetFen/FEN，pgn_writer.dart:11-50）。
 */
export function writePgn(record: GameRecordData, now: Date = new Date()): string {
  const date = record.createdAt !== null ? new Date(record.createdAt) : now
  const pad = (v: number): string => String(v).padStart(2, '0')
  const result = pgnResultTag(record)
  const headers: string[] = [
    '[Event "中国象棋 Ultra"]',
    '[Site "ChineseChessUltra"]',
    `[Date "${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}"]`,
    '[Round "-"]',
    `[Red "${record.redName ?? '红方'}"]`,
    `[Black "${record.blackName ?? '黑方'}"]`,
    `[Result "${result}"]`
  ]
  if (record.solveStatus !== 'none') {
    headers.push(`[Annotator "${solveStatusLabel(record.solveStatus)}"]`)
  }
  // 残局与初始局面不同时标注起始 FEN，导入方可据此复原。
  if (!isInitialBoardFen(record.initialFen)) {
    headers.push(`[SetFen "${record.initialFen}"]`)
    headers.push(`[FEN "${record.initialFen}"]`)
  }

  const parts: string[] = []
  for (let plies = 0; plies < record.moves.length; plies++) {
    if (plies % 2 === 0) parts.push(`${Math.floor(plies / 2) + 1}.`)
    parts.push(iccsFallbackFormat(record.moves[plies]))
  }
  const body = record.moves.length === 0 ? '' : `${parts.join(' ')} ${result}`
  return `${headers.join('\n')}\n\n${body}\n`
}

/** 分享文本的求解结论块（无解/超时文案，供详情页复用，pgn_writer.dart:88-92）。 */
export function solveVerdictLines(record: GameRecordData): string[] {
  const solutions = record.solutions
  if (solutions.length > 0) {
    const unique = hasUniqueSolution(record.solveStatus, record.solutions) ? '，唯一解' : ''
    const lines = [`破解之法（${solutions.length} 条${unique}）:`]
    solutions.forEach((solution, i) => {
      lines.push(`解法${i + 1}: ${solution.join(' ')}`)
    })
    return lines
  }
  if (record.solveStatus === 'noSolution') return ['求解结论: 无解（深度上界内已证明）']
  if (record.solveStatus === 'timeout') return ['求解结论: 限时内未找到解法']
  return []
}
