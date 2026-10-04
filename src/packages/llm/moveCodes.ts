/**
 * 坐标编码（move_source.dart:1-28 的 1:1 移植）：
 * 列 a-i（对应 col 0-8），行 0-9（0 为黑方底线/棋盘顶部，9 为红方底线）。
 * 这是与 LLM 交互的着法文本格式，例如 "h7-e7"。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */
import type { Move, Position } from '@packages/rules'

/** 单格坐标编码（move_source.dart:11-12）。 */
export function encodeCell(p: Position): string {
  return `${String.fromCharCode(97 + p.col)}${p.row}`
}

/** 解析单格坐标（如 "b2"）；格式非法/越界返回 null（move_source.dart:14-21）。 */
export function decodeCell(cell: string): Position | null {
  if (cell.length !== 2) return null
  const col = cell.charCodeAt(0) - 97
  const row = cell.charCodeAt(1) - 48
  if (col < 0 || col > 8 || row < 0 || row > 9) return null
  return { col, row }
}

/** 把走法编码为 "起点-终点" 文本（move_source.dart:23）。 */
export function encodeMove(move: Move): string {
  return `${encodeCell(move.from)}-${encodeCell(move.to)}`
}
