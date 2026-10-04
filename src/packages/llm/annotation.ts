/**
 * 着法注解与引擎分数分桶（05 文档 §2.2 清单行规则；move_annotation.dart 1:1 移植）。
 *
 * 所有标注信息（棋子/中文记法/吃子/将军/分数分桶）均由本地规则引擎
 * 与搜索结果生成，零成本、零幻觉——给 LLM 的"战术眼镜"。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */
import type { Board, Move } from '@packages/rules'
import { chineseNotation, pieceFenChar, pieceLabel } from '@packages/rules'
import { encodeMove } from './moveCodes'

/**
 * 生成带注解的着法文本：`b2-e2(炮二平五,吃卒,将军)`（move_annotation.dart:17-31）。
 *
 * board 为走子前的局面（move 的起点须有棋子）；起点无棋子时退化为纯坐标。
 */
export function annotateMove(board: Board, move: Move): string {
  const piece = board.pieceAtP(move.from)
  if (piece === null) return encodeMove(move)

  const parts: string[] = [chineseNotation(piece, move.from, move.to)]
  // 优先用棋盘实际局面取被吃子（手工构造的 Move 不带 captured）。
  const captured = move.captured ?? board.pieceAtP(move.to)
  if (captured !== null && captured !== undefined) parts.push(`吃${pieceLabel(captured)}`)

  const probe = board.copy()
  probe.applyMove({ from: move.from, to: move.to })
  if (probe.isCheck(probe.turn)) parts.push('将军')

  return `${encodeMove(move)}(${parts.join(',')})`
}

/**
 * 相对最佳分的损失 → 分桶文字（给 LLM 的可读评估，move_annotation.dart:36-42）。
 * cpDiff 为厘兵（正数越大亏损越多）。
 */
export function scoreBucket(cpDiff: number): string {
  if (cpDiff <= 30) return '最佳/均势'
  if (cpDiff <= 100) return '略亏'
  if (cpDiff <= 250) return '明显亏（约半子）'
  if (cpDiff <= 600) return '大亏（丢一马/一炮级）'
  return '致命（丢车/被将杀级）'
}

/** 候选清单的一行文本：`b2-e2(炮二平五,吃卒,将军) — 均势`（move_annotation.dart:44-46）。 */
export function annotatedWithBucket(board: Board, move: Move, cpDiff: number): string {
  return `${annotateMove(board, move)} — ${scoreBucket(cpDiff)}`
}

/**
 * 棋盘 ASCII 图（原 llm_solve_assist._asciiBoard，move_annotation.dart:50-62）：
 * 10 行文本，大写红方/小写黑方，行号 0-9（0 为黑方底线）、列标 a-i。
 * 行首 "row  两空格"，列间单空格，列标行 "    a b c d e f g h i"。
 */
export function asciiBoard(board: Board): string {
  const buf: string[] = []
  buf.push('    a b c d e f g h i\n')
  for (let row = 0; row < 10; row++) {
    const cells: string[] = []
    for (let col = 0; col < 9; col++) {
      const piece = board.pieceAt(col, row)
      cells.push(piece === null ? '.' : pieceFenChar(piece))
    }
    buf.push(`${row}  ${cells.join(' ')}\n`)
  }
  return buf.join('')
}
