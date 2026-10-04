/**
 * 残局摆盘的合法性规则（board_setup_rules.dart 1:1 移植，纯函数便于单测）。
 *
 * 车马炮可到任意空位；帅/将限九宫；士/仕限九宫 5 个斜线点；
 * 相/象限己方半场的田字点（偶数列，且行奇偶随起点锁定：红 5/7/9 排、
 * 黑 0/2/4 排——田字移动不改变 列+行 的奇偶性）；兵/卒不能位于本方
 * 底线三排（红兵起始 row 6 只进不退，黑卒同理）。
 */
import { inOwnHalf, inPalace, pieceLabel, type Piece, type PieceKind } from '@packages/rules'

/** 每种棋子每方的数量上限（象棋标准配置，board_setup_rules.dart:14-22）。 */
export const MAX_COUNT_PER_KIND: Readonly<Record<PieceKind, number>> = {
  king: 1,
  advisor: 2,
  minister: 2,
  knight: 2,
  rook: 2,
  cannon: 2,
  pawn: 5
}

const sideName = (piece: Piece): string => (piece.side === 'red' ? '红方' : '黑方')

/**
 * [piece] 放到 (col,row) 是否合法；不合法返回给用户看的原因，合法返回 null
 * （board_setup_rules.dart:25-68）。
 */
export function placementIssue(piece: Piece, col: number, row: number): string | null {
  switch (piece.kind) {
    case 'king':
      if (!inPalace(col, row, piece.side)) {
        return '帅/将只能放在九宫内的 9 个位置'
      }
      break
    case 'advisor': {
      if (!inPalace(col, row, piece.side)) {
        return '士/仕只能放在己方九宫内'
      }
      // 士走斜线：只能在九宫的 5 个斜线点。
      // 黑方九宫斜线点满足 (col+row) 为奇数，红方为偶数。
      const parity = (col + row) % 2
      const ok = piece.side === 'red' ? parity === 0 : parity === 1
      if (!ok) return '士/仕只能放在九宫的 5 个斜线位置上'
      break
    }
    case 'minister': {
      if (!inOwnHalf(row, piece.side)) {
        return '相/象不能摆到对方半场'
      }
      // 象走田字（列行各 ±2），(col+row) 奇偶性永不改变：
      // 红相起点 (2,9)/(6,9) 为奇数和 → 只能落在奇数行（5/7/9 排）；
      // 黑象起点 (2,0)/(6,0) 为偶数和 → 只能落在偶数行（0/2/4 排）。
      if (col % 2 !== 0) {
        return '相/象只能落在偶数列的田字点上'
      }
      const rowParityOk = piece.side === 'red' ? row % 2 === 1 : row % 2 === 0
      if (!rowParityOk) {
        return piece.side === 'red'
          ? '相只能放在己方半场 5/7/9 排的田字点上'
          : '象只能放在己方半场 0/2/4 排的田字点上'
      }
      break
    }
    case 'pawn': {
      // 兵/卒只进不退（过河后可横走）：红兵不可能出现在 row 7~9，
      // 黑卒不可能出现在 row 0~2。
      const ok = piece.side === 'red' ? row <= 6 : row >= 3
      if (!ok) return '兵/卒不能放在本方底线三排'
      break
    }
    case 'rook':
    case 'knight':
    case 'cannon':
      break // 无位置限制
  }
  return null
}

/**
 * [counts]（按棋子统计的已有数量）整体数量是否合法；
 * 返回首个超限原因，合法返回 null（board_setup_rules.dart:72-81）。
 */
export function countIssue(counts: Iterable<[Piece, number]>): string | null {
  for (const [piece, count] of counts) {
    const limit = MAX_COUNT_PER_KIND[piece.kind]
    if (count > limit) {
      return `${sideName(piece)}${pieceLabel(piece)}最多 ${limit} 枚（当前 ${count} 枚）`
    }
  }
  return null
}

/**
 * 放置 [piece] 前的数量校验：若目标格已有同种棋子则替换不算新增
 * （board_setup_rules.dart:84-99）。
 */
export function countIssueForPlacement(
  piece: Piece,
  currentCount: number,
  occupant?: Piece | null
): string | null {
  const replacesSame =
    occupant != null && occupant.kind === piece.kind && occupant.side === piece.side
  if (replacesSame) return null
  const limit = MAX_COUNT_PER_KIND[piece.kind]
  if (currentCount + 1 > limit) {
    return `${sideName(piece)}${pieceLabel(piece)}最多 ${limit} 枚`
  }
  return null
}
