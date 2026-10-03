/**
 * 中国象棋规则引擎（对应 board.dart）。
 *
 * - 棋盘以 10 行 × 9 列矩阵存储，row 0 为黑方底线（FEN 第一行），row 9 为红方底线。
 * - 两层走法：pseudoMovesFor（伪合法，供搜索与 isCheck）→ legalMovesFor
 *   （自将过滤，供 UI/清单，T1.3 落地）。
 * - 纯 TypeScript，不依赖任何环境 API，可独立单测。
 */
import { addPos, inBoard, pos, type Position } from './position'
import { forwardOf, type Piece, type Side } from './piece'
import {
  buildFen,
  parseBoardFen,
  parseTurnFen,
  FEN_INITIAL,
  type BoardGrid
} from './fen'
import type { Move } from './move'

/** 是否在九宫格内（board.dart:54-57）：col 3-5；红 row 7-9 / 黑 row 0-2。 */
export function inPalace(col: number, row: number, side: Side): boolean {
  if (col < 3 || col > 5) return false
  return side === 'red' ? row >= 7 && row <= 9 : row >= 0 && row <= 2
}

/** 是否在自己半场（未过河，board.dart:60-62）：红 row≥5 / 黑 row≤4。 */
export function inOwnHalf(row: number, side: Side): boolean {
  return side === 'red' ? row >= 5 : row <= 4
}

/** 是否已过河到对方半场（board.dart:65）。 */
export const inOpponentHalf = (row: number, side: Side): boolean => !inOwnHalf(row, side)

const DIRS_ORTHO: readonly Position[] = [pos(0, 1), pos(0, -1), pos(1, 0), pos(-1, 0)]
const DIRS_DIAGONAL: readonly Position[] = [pos(1, 1), pos(1, -1), pos(-1, 1), pos(-1, -1)]
const DIRS_ELEPHANT: readonly Position[] = [pos(2, 2), pos(2, -2), pos(-2, 2), pos(-2, -2)]

/** 马的 8 个 (走子偏移, 马腿偏移) 模式（board.dart:300-309）。 */
const KNIGHT_PATTERNS: readonly (readonly [Position, Position])[] = [
  [pos(1, 2), pos(0, 1)], // 下右
  [pos(-1, 2), pos(0, 1)], // 下左
  [pos(1, -2), pos(0, -1)], // 上右
  [pos(-1, -2), pos(0, -1)], // 上左
  [pos(2, 1), pos(1, 0)], // 右下
  [pos(2, -1), pos(1, 0)], // 右上
  [pos(-2, 1), pos(-1, 0)], // 左下
  [pos(-2, -1), pos(-1, 0)] // 左上
]

export class Board {
  private readonly grid: BoardGrid
  private redTurn: boolean

  private constructor(grid: BoardGrid, redTurn: boolean) {
    this.grid = grid
    this.redTurn = redTurn
  }

  /** 从 FEN 字符串构造棋盘（board.dart:16-20）。 */
  static fromFen(fen: string): Board {
    return new Board(parseBoardFen(fen), parseTurnFen(fen))
  }

  /** 标准初始局面（board.dart:23）。 */
  static initial(): Board {
    return Board.fromFen(FEN_INITIAL)
  }

  /** 当前是否轮到红方走（board.dart:29）。 */
  get isRedTurn(): boolean {
    return this.redTurn
  }

  /** 当前轮走方（board.dart:32）。 */
  get turn(): Side {
    return this.redTurn ? 'red' : 'black'
  }

  /** 取某格棋子（board.dart:35）。 */
  pieceAt(col: number, row: number): Piece | null {
    return this.grid[row][col]
  }

  /** 取某格棋子（Position 版，board.dart:38）。 */
  pieceAtP(p: Position): Piece | null {
    return this.grid[p.row][p.col]
  }

  /** 序列化为 FEN（board.dart:41）。 */
  toFen(): string {
    return buildFen({ board: this.grid, isRedTurn: this.redTurn })
  }

  /** 拷贝当前棋盘（深拷贝，Worker 快照传参用；board.dart:44-47）。 */
  copy(): Board {
    return new Board(
      this.grid.map((row) => [...row]),
      this.redTurn
    )
  }

  /** 执行一步走子（不做合法性校验），返回含被吃子的快照（board.dart:124-131）。 */
  applyMove(move: Move): Move {
    const mover = this.pieceAtP(move.from)!
    const captured = this.pieceAtP(move.to)
    this.grid[move.to.row][move.to.col] = mover
    this.grid[move.from.row][move.from.col] = null
    this.redTurn = !this.redTurn
    return { from: move.from, to: move.to, captured: captured ?? undefined }
  }

  /** 撤销一步走子：用 captured 恢复 + 翻回轮走方（board.dart:134-139）。 */
  undoMove(snapshot: Move): void {
    const mover = this.pieceAtP(snapshot.to)!
    this.grid[snapshot.from.row][snapshot.from.col] = mover
    this.grid[snapshot.to.row][snapshot.to.col] = snapshot.captured ?? null
    this.redTurn = !this.redTurn
  }

  // -------------------------------------------------------------------------
  // 走法生成
  // -------------------------------------------------------------------------

  /** 计算某格棋子的所有伪合法走法（不检查是否自将，board.dart:74-93）。 */
  pseudoMovesFor(p: Position): Move[] {
    const piece = this.pieceAtP(p)
    if (piece === null) return []
    switch (piece.kind) {
      case 'king':
        return this.kingMoves(p, piece)
      case 'advisor':
        return this.advisorMoves(p, piece)
      case 'minister':
        return this.ministerMoves(p, piece)
      case 'knight':
        return this.knightMoves(p, piece)
      case 'rook':
        return this.rookMoves(p, piece)
      case 'cannon':
        return this.cannonMoves(p, piece)
      case 'pawn':
        return this.pawnMoves(p, piece)
    }
  }

  /** 将：九宫内 4 直向 ×1 格（board.dart:236-253）。 */
  private kingMoves(p: Position, piece: Piece): Move[] {
    const moves: Move[] = []
    for (const d of DIRS_ORTHO) {
      const to = addPos(p, d)
      if (!inBoard(to.col, to.row)) continue
      if (!inPalace(to.col, to.row, piece.side)) continue
      const target = this.pieceAtP(to)
      if (target !== null && target.side === piece.side) continue
      moves.push({ from: p, to, captured: target ?? undefined })
    }
    return moves
  }

  /** 士：九宫内 4 斜向 ×1 格（board.dart:255-272）。 */
  private advisorMoves(p: Position, piece: Piece): Move[] {
    const moves: Move[] = []
    for (const d of DIRS_DIAGONAL) {
      const to = addPos(p, d)
      if (!inBoard(to.col, to.row)) continue
      if (!inPalace(to.col, to.row, piece.side)) continue
      const target = this.pieceAtP(to)
      if (target !== null && target.side === piece.side) continue
      moves.push({ from: p, to, captured: target ?? undefined })
    }
    return moves
  }

  /** 象：4 田字方向 ×2 格，检查象眼（田字中心）且不能过河（board.dart:274-295）。 */
  private ministerMoves(p: Position, piece: Piece): Move[] {
    const moves: Move[] = []
    for (const d of DIRS_ELEPHANT) {
      const to = addPos(p, d)
      if (!inBoard(to.col, to.row)) continue
      // 象不能过河（board.dart:286）。
      if (!inOwnHalf(to.row, piece.side)) continue
      // 象眼 = 田字中心（d~/2，board.dart:288）。
      const eye = pos(p.col + Math.trunc(d.col / 2), p.row + Math.trunc(d.row / 2))
      if (this.pieceAtP(eye) !== null) continue
      const target = this.pieceAtP(to)
      if (target !== null && target.side === piece.side) continue
      moves.push({ from: p, to, captured: target ?? undefined })
    }
    return moves
  }

  /** 马：8 个 delta+leg 模式，马腿 = 起点往该方向先走一步的位置（board.dart:297-320）。 */
  private knightMoves(p: Position, piece: Piece): Move[] {
    const moves: Move[] = []
    for (const [delta, leg] of KNIGHT_PATTERNS) {
      const to = addPos(p, delta)
      if (!inBoard(to.col, to.row)) continue
      // 马腿检查（board.dart:314）。
      if (this.pieceAtP(addPos(p, leg)) !== null) continue
      const target = this.pieceAtP(to)
      if (target !== null && target.side === piece.side) continue
      moves.push({ from: p, to, captured: target ?? undefined })
    }
    return moves
  }

  /** 车：4 方向滑动，遇子停止，敌子可吃（board.dart:322-346）。 */
  private rookMoves(p: Position, piece: Piece): Move[] {
    const moves: Move[] = []
    for (const d of DIRS_ORTHO) {
      let to = addPos(p, d)
      while (inBoard(to.col, to.row)) {
        const target = this.pieceAtP(to)
        if (target === null) {
          moves.push({ from: p, to })
        } else {
          if (target.side !== piece.side) {
            moves.push({ from: p, to, captured: target })
          }
          break
        }
        to = addPos(to, d)
      }
    }
    return moves
  }

  /** 炮：直线滑空格；吃子需隔恰一个炮架后找第一个子，敌子可吃（board.dart:348-380）。 */
  private cannonMoves(p: Position, piece: Piece): Move[] {
    const moves: Move[] = []
    for (const d of DIRS_ORTHO) {
      // 第一阶段：直线无阻走空格（board.dart:358-362）。
      let to = addPos(p, d)
      while (inBoard(to.col, to.row) && this.pieceAtP(to) === null) {
        moves.push({ from: p, to })
        to = addPos(to, d)
      }
      // 第二阶段：越过炮架（第一个非空格）后，再吃对方（board.dart:364-377）。
      if (inBoard(to.col, to.row)) {
        to = addPos(to, d)
        while (inBoard(to.col, to.row)) {
          const target = this.pieceAtP(to)
          if (target !== null) {
            if (target.side !== piece.side) {
              moves.push({ from: p, to, captured: target })
            }
            break
          }
          to = addPos(to, d)
        }
      }
    }
    return moves
  }

  /** 兵：前进 1 格；已过河可左右横走；底线后仍仅平移，无升变（board.dart:382-400）。 */
  private pawnMoves(p: Position, piece: Piece): Move[] {
    const moves: Move[] = []
    const forward = forwardOf(piece.side)
    const deltas: Position[] = [pos(0, forward)]
    // 过河后可横走（board.dart:387-390）。
    if (inOpponentHalf(p.row, piece.side)) {
      deltas.push(pos(1, 0), pos(-1, 0))
    }
    for (const d of deltas) {
      const to = addPos(p, d)
      if (!inBoard(to.col, to.row)) continue
      const target = this.pieceAtP(to)
      if (target !== null && target.side === piece.side) continue
      moves.push({ from: p, to, captured: target ?? undefined })
    }
    return moves
  }
}
