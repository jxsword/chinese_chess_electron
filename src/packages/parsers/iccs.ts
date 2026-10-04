/**
 * ICCS 坐标走法工具（对应 iccs.dart，06 文档 §2）。
 *
 * ICCS（International Chinese Chess Standard）记谱：列 a-i（红方视角从左到右），
 * 行 0-9（0 为红方底线、9 为黑方底线），一着写作起止两格，如 `h3e3` / `H3-E3`。
 *
 * 本项目内部坐标为 Position（col 0-8、row 0-9，row 0 为黑方底线），
 * 因此与 ICCS 的换算关系是 **row = 9 − rank**。
 *
 * 注意与走子源 encodeCell 的区别：后者行 0 为黑底线（LLM 协议），两者行号
 * 镜像，禁止混用。解析器（XQF/PGN）与演示 VM 共用本文件，避免两处实现漂移。
 */
import { inBoard, pos, type Position } from '../rules'

const ICCS_PATTERN = /^\s*([a-iA-I])(\d{1,2})\s*-?\s*([a-iA-I])(\d{1,2})\s*$/

/** 解析 ICCS 走法为起止坐标；格式非法或坐标越界返回 null（iccs.dart:25-43）。 */
export function parseIccs(iccs: string): { from: Position; to: Position } | null {
  const match = ICCS_PATTERN.exec(iccs)
  if (match === null) return null

  const parseSquare = (file: string, rankStr: string): Position | null => {
    const rank = Number.parseInt(rankStr, 10)
    if (!Number.isFinite(rank) || rank > 10) return null
    const col = file.toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0)
    if (col < 0 || col > 8) return null
    // 行号兼容个别记谱把黑方底线写成 10 的情况（此时按 0 处理）。
    const row = rank >= 10 ? 0 : 9 - rank
    if (row < 0 || row > 9) return null
    return pos(col, row)
  }

  const from = parseSquare(match[1], match[2])
  const to = parseSquare(match[3], match[4])
  if (from === null || to === null) return null
  return { from, to }
}

/** 把起止坐标编码为小写紧凑 ICCS（`h3e3`），坐标越界返回 null（iccs.dart:46-58）。 */
export function formatIccs(
  from: Position,
  to: Position
): string | null {
  const square = (p: Position): string | null => {
    if (!inBoard(p.col, p.row)) return null
    const file = 'a'.charCodeAt(0) + p.col
    const rank = 9 - p.row
    return `${String.fromCharCode(file)}${rank}`
  }
  const f = square(from)
  const t = square(to)
  if (f === null || t === null) return null
  return `${f}${t}`
}
