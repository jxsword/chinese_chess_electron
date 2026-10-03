/**
 * 中国象棋标准局面 FEN 编解码（对应 fen.dart，参考 XQFEN）。
 *
 * 棋盘从黑方底线（row 0）写到红方底线（row 9），每行 9 列从左到右，
 * 数字表示连续空位，红方大写、黑方小写。
 * halfMove 恒 0、fullMove 恒 1（原版未维护半回合计数，保持一致，02 文档 §1.4/§6）。
 */
import { pieceFenChar, pieceFromFenChar, type Piece } from './piece'

/** 标准初始局面（fen.dart:11-12）。 */
export const FEN_INITIAL =
  'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

/** 棋盘矩阵：[row][col] 10×9，空格为 null。 */
export type BoardGrid = (Piece | null)[][]

/** FEN 格式异常（Dart FormatException 等价，fen.dart:41/56/63）。 */
export class FenFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FenFormatError'
  }
}

const splitFields = (fen: string): string[] => fen.trim().split(/\s+/)

const isDigitChar = (ch: string): boolean => /\d/.test(ch)

/**
 * 校验是否为合法 FEN（粗校：10 行、每行合计 9 列、字符 ∈ {1-9, KABNRCPkabnrcp}；
 * fen.dart:15-34）。
 */
export function isValidFen(fen: string): boolean {
  const parts = splitFields(fen)
  if (parts.length === 0) return false
  const rows = parts[0].split('/')
  if (rows.length !== 10) return false
  for (const rowStr of rows) {
    let sum = 0
    for (const ch of rowStr) {
      if (isDigitChar(ch)) {
        sum += Number.parseInt(ch, 10)
      } else if (pieceFromFenChar(ch) !== null) {
        sum += 1
      } else {
        return false
      }
    }
    if (sum !== 9) return false
  }
  return true
}

/**
 * 解析 FEN 棋盘部分，返回 10 行 × 9 列矩阵，空格为 null。
 * 矩阵下标为 [row][col]，row 0 为黑方底线（FEN 第一行），row 9 为红方底线。
 * 行数错 / 行长≠9 / 非法字符抛 FenFormatException（fen.dart:38-68）。
 */
export function parseBoardFen(fen: string): BoardGrid {
  const rows = splitFields(fen)[0].split('/')
  if (rows.length !== 10) {
    throw new FenFormatError(`Invalid FEN board rows: ${rows.length}`)
  }
  const result: BoardGrid = Array.from({ length: 10 }, () =>
    Array<Piece | null>(9).fill(null)
  )
  for (let r = 0; r < 10; r++) {
    let col = 0
    for (const ch of rows[r]) {
      if (isDigitChar(ch)) {
        col += Number.parseInt(ch, 10)
      } else {
        const piece = pieceFromFenChar(ch)
        if (piece === null) {
          throw new FenFormatError(`Invalid FEN char: ${ch}`)
        }
        result[r][col] = piece
        col += 1
      }
    }
    if (col !== 9) {
      throw new FenFormatError(`Invalid FEN row length at ${r}: expected 9 got ${col}`)
    }
  }
  return result
}

/** 解析 FEN 中"轮走方"字段，true=红方；解析到 `w` 或 `r` 都算红（fen.dart:71-75）。 */
export function parseTurnFen(fen: string): boolean {
  const parts = splitFields(fen)
  if (parts.length < 2) return true
  const turn = parts[1].toLowerCase()
  return turn === 'w' || turn === 'r'
}

/** 将棋盘矩阵序列化为 FEN 棋盘部分（fen.dart:78-99）。 */
export function boardGridToFen(grid: BoardGrid): string {
  const rows: string[] = []
  for (let r = 0; r < 10; r++) {
    let buf = ''
    let empty = 0
    for (let c = 0; c < 9; c++) {
      const p = grid[r][c]
      if (p === null) {
        empty += 1
      } else {
        if (empty > 0) {
          buf += String(empty)
          empty = 0
        }
        buf += pieceFenChar(p)
      }
    }
    if (empty > 0) buf += String(empty)
    rows.push(buf)
  }
  return rows.join('/')
}

/** 拼装完整 FEN 的参数（halfMove/fullMove 仅保留接口形状，原版恒 0/1）。 */
export interface BuildFenOptions {
  board: BoardGrid
  isRedTurn: boolean
  halfMove?: number
  fullMove?: number
}

/** 拼装完整 FEN（含走子方/回合数等扩展字段，fen.dart:102-109）。 */
export function buildFen({
  board,
  isRedTurn,
  halfMove = 0,
  fullMove = 1
}: BuildFenOptions): string {
  return `${boardGridToFen(board)} ${isRedTurn ? 'w' : 'b'} - - ${halfMove} ${fullMove}`
}
