/**
 * 中文纵线记法（对应 move_notation.dart，02 文档 §4）。
 *
 * 形如 "炮二平五" / "马8进7"：红方用汉字数字（从红方视角右→左），
 * 黑方用阿拉伯数字。三分支：同列直线（进/退+步数）、同行平移（平+目标列号）、
 * 斜走（进/退+目标列号）。进/退方向：红方 row 减小为进，黑方 row 增大为进。
 *
 * 已知局限（02 §6 保持一致）：无"前/后/中"同列多子消歧——正向记谱不输出，
 * 该消歧仅在 PGN 解析器（06 文档 §3.3）中反向实现。
 */
import type { Position } from './position'
import { isRedSide, pieceLabel, type Piece } from './piece'

/** 红方列号汉字：han[col]，col 0 → '九'、col 8 → '一'（move_notation.dart:11）。 */
const HAN = ['九', '八', '七', '六', '五', '四', '三', '二', '一'] as const

/** 同列直线时红方步数取 han[9 - steps]（move_notation.dart:28）。 */
const stepLabel = (steps: number): string => HAN[9 - steps]

/**
 * 把 (piece, from, to) 序列化为带颜色与中文坐标的记法字符串
 * （move_notation.dart:9-39）。
 */
export function chineseNotation(piece: Piece, from: Position, to: Position): string {
  const red = isRedSide(piece.side)
  const colLabel = (c: number): string => (red ? HAN[c] : String(c + 1))

  const fromCol = colLabel(from.col)
  const toCol = colLabel(to.col)
  const sameCol = from.col === to.col
  const forwardDelta = to.row - from.row
  const isForward = red ? forwardDelta < 0 : forwardDelta > 0

  let action: string
  let target: string
  if (sameCol) {
    // 同列直线：进/退 + 步数（红方步数取 han[9-steps]）。
    action = isForward ? '进' : '退'
    const steps = Math.abs(forwardDelta)
    target = red ? stepLabel(steps) : String(steps)
  } else if (from.row === to.row) {
    // 同行平移：平 + 目标列号。
    action = '平'
    target = toCol
  } else {
    // 斜走（马/象/士）：进/退 + 目标列号。
    action = isForward ? '进' : '退'
    target = toCol
  }
  return `${pieceLabel(piece)}${fromCol}${action}${target}`
}
