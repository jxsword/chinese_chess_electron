/**
 * 规则引擎测试（对齐原版 board_test.dart 的走法生成部分）。
 * 走法生成用例走 pseudoMovesFor（这些场面均无自将干扰，pseudo == legal）；
 * 合法性过滤 / 将死 / 困毙 / 照面用例在 legalMovesFor/isCheck 落地后补齐（T1.3）。
 */
import { describe, expect, it } from 'vitest'
import {
  Board,
  buildFen,
  pieceFromFenChar,
  pos,
  type BoardGrid,
  type Move,
  type Piece
} from '@packages/rules'

/** [col, row, FEN字符] 三元组，如 [4, 5, 'R'] = 红车在 (4,5)。 */
type PieceSpec = readonly [col: number, row: number, fenChar: string]

/** 在空棋盘上指定棋子构造 Board（对齐 Dart _boardWith）。 */
function boardWith(pieces: readonly PieceSpec[], redTurn = true): Board {
  const grid: BoardGrid = Array.from({ length: 10 }, () =>
    Array<Piece | null>(9).fill(null)
  )
  for (const [col, row, ch] of pieces) {
    const piece = pieceFromFenChar(ch)
    if (piece === null) throw new Error(`非法棋子字符: ${ch}`)
    grid[row][col] = piece
  }
  return Board.fromFen(buildFen({ board: grid, isRedTurn: redTurn }))
}

/** 取 (col,row) 格棋子的伪合法走法目标集合。 */
function pseudoTargets(board: Board, col: number, row: number): Move[] {
  return board.pseudoMovesFor(pos(col, row))
}

describe('Board 初始局面', () => {
  it('棋盘共 32 个棋子（红黑各 16）', () => {
    const board = Board.initial()
    let red = 0
    let black = 0
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = board.pieceAt(c, r)
        if (p === null) continue
        if (p.side === 'red') red++
        else black++
      }
    }
    expect(red).toBe(16)
    expect(black).toBe(16)
  })

  it('初始局面红方先行', () => {
    expect(Board.initial().isRedTurn).toBe(true)
  })
})

describe('车（rook）走法', () => {
  it('空棋盘上的车可横竖移动到所有同行同列格子', () => {
    // 红车放在 (4,5)，红将放在九宫 (3,9)，无任何阻挡。
    const board = boardWith([
      [4, 5, 'R'],
      [3, 9, 'K']
    ])
    const moves = pseudoTargets(board, 4, 5)
    // 同列 9 格（不含自身），同行 8 格（不含自身），共 17。
    expect(moves.length).toBe(17)
  })

  it('车不能跳过棋子', () => {
    const board = boardWith([
      [4, 5, 'R'],
      [4, 3, 'p'],
      [4, 9, 'K']
    ])
    const moves = pseudoTargets(board, 4, 5)
    // 上方遇到黑兵在 (4,3)，可以吃，但不能跳到 (4,2)/(4,1)/(4,0)。
    const upTargets = moves.filter((m) => m.to.col === 4 && m.to.row < 5)
    expect(upTargets.some((m) => m.to.row === 4)).toBe(true)
    expect(upTargets.some((m) => m.to.row === 3)).toBe(true) // 吃兵
    expect(upTargets.some((m) => m.to.row === 2)).toBe(false)
    expect(upTargets.some((m) => m.to.row === 1)).toBe(false)
  })
})

describe('马（knight）走法', () => {
  it('马走日，八个方向均可达', () => {
    const board = boardWith([
      [4, 5, 'N'],
      [4, 0, 'K']
    ])
    const moves = pseudoTargets(board, 4, 5)
    const expected = [
      pos(5, 7),
      pos(3, 7),
      pos(6, 6),
      pos(2, 6),
      pos(6, 4),
      pos(2, 4),
      pos(5, 3),
      pos(3, 3)
    ]
    expect(moves.length).toBe(expected.length)
    for (const e of expected) {
      expect(moves.some((m) => m.to.col === e.col && m.to.row === e.row)).toBe(true)
    }
  })

  it('马腿被堵时无法越过', () => {
    const board = boardWith([
      [4, 5, 'N'],
      [4, 4, 'p'],
      [4, 9, 'K']
    ])
    const moves = pseudoTargets(board, 4, 5)
    // 马腿 (4,4) 被堵，向下不能走 (3,3) / (5,3)。
    expect(moves.some((m) => m.to.col === 3 && m.to.row === 3)).toBe(false)
    expect(moves.some((m) => m.to.col === 5 && m.to.row === 3)).toBe(false)
    // 其余 6 个方向不受影响。
    expect(moves.length).toBe(6)
  })
})

describe('炮（cannon）走法', () => {
  it('空格移动同车；吃子需隔一子（炮架）', () => {
    const board = boardWith([
      [4, 5, 'C'],
      [4, 3, 'p'],
      [4, 1, 'a'],
      [4, 9, 'K']
    ])
    const moves = pseudoTargets(board, 4, 5)
    // 上方可走到空格 (4,4)；(4,3) 是炮架不能吃；隔架可吃 (4,1)；(4,0) 越过目标不可达。
    expect(moves.some((m) => m.to.col === 4 && m.to.row === 4)).toBe(true)
    expect(moves.some((m) => m.to.col === 4 && m.to.row === 3)).toBe(false)
    expect(moves.some((m) => m.to.col === 4 && m.to.row === 1)).toBe(true)
    expect(moves.some((m) => m.to.col === 4 && m.to.row === 0)).toBe(false)
  })
})

describe('象/相（minister）走法', () => {
  it('象走田，不能过河，受象眼限制', () => {
    const board = boardWith([
      [4, 9, 'B'],
      [4, 0, 'K']
    ])
    const moves = pseudoTargets(board, 4, 9)
    // 红相在 (4,9)，可走 (2,7)、(6,7)，不能过河（row < 5）。
    expect(moves.some((m) => m.to.col === 2 && m.to.row === 7)).toBe(true)
    expect(moves.some((m) => m.to.col === 6 && m.to.row === 7)).toBe(true)
    expect(moves.every((m) => m.to.row >= 5)).toBe(true)
  })
})

describe('士（advisor）走法', () => {
  it('士只能在九宫格内斜走', () => {
    const board = boardWith([
      [3, 9, 'A'],
      [4, 9, 'K']
    ])
    const moves = pseudoTargets(board, 3, 9)
    // 红士在 (3,9)，可斜走到 (4,8)。
    expect(moves.some((m) => m.to.col === 4 && m.to.row === 8)).toBe(true)
    // 不能平走到 (3,8) 或 (2,9)（不属于斜走）。
    expect(moves.some((m) => m.to.col === 3 && m.to.row === 8)).toBe(false)
    expect(moves.length).toBe(1)
  })
})

describe('将/帅（king）走法', () => {
  it('将只能在九宫格内直走一格', () => {
    const board = boardWith([[4, 9, 'K']])
    const moves = pseudoTargets(board, 4, 9)
    expect(moves.some((m) => m.to.col === 4 && m.to.row === 8)).toBe(true)
    expect(moves.some((m) => m.to.col === 3 && m.to.row === 9)).toBe(true)
    expect(moves.some((m) => m.to.col === 5 && m.to.row === 9)).toBe(true)
    // 不能斜走。
    expect(moves.some((m) => m.to.col === 3 && m.to.row === 8)).toBe(false)
    // 不能走出九宫。
    expect(moves.some((m) => m.to.col === 4 && m.to.row === 6)).toBe(false)
    expect(moves.length).toBe(3)
  })
})

describe('兵/卒（pawn）走法', () => {
  it('未过河兵只能前进', () => {
    const board = boardWith([
      [4, 6, 'P'],
      [4, 9, 'K']
    ])
    const moves = pseudoTargets(board, 4, 6)
    expect(moves.some((m) => m.to.col === 4 && m.to.row === 5)).toBe(true)
    expect(moves.some((m) => m.to.col === 3 && m.to.row === 6)).toBe(false)
    expect(moves.some((m) => m.to.col === 5 && m.to.row === 6)).toBe(false)
    expect(moves.length).toBe(1)
  })

  it('过河兵可前进或横走', () => {
    const board = boardWith([
      [4, 4, 'P'],
      [4, 9, 'K']
    ])
    const moves = pseudoTargets(board, 4, 4)
    expect(moves.some((m) => m.to.col === 4 && m.to.row === 3)).toBe(true)
    expect(moves.some((m) => m.to.col === 3 && m.to.row === 4)).toBe(true)
    expect(moves.some((m) => m.to.col === 5 && m.to.row === 4)).toBe(true)
    expect(moves.some((m) => m.to.col === 4 && m.to.row === 5)).toBe(false) // 不能后退
    expect(moves.length).toBe(3)
  })
})

describe('applyMove / undoMove 互逆', () => {
  it('走子 + 悔棋后 FEN 不变', () => {
    const fen0 = Board.initial().toFen()
    const board = Board.fromFen(fen0)
    const move: Move = { from: pos(1, 7), to: pos(2, 7) }
    const snapshot = board.applyMove(move)
    expect(board.toFen() === fen0).toBe(false)
    expect(board.isRedTurn).toBe(false)
    board.undoMove(snapshot)
    expect(board.toFen()).toBe(fen0)
    expect(board.isRedTurn).toBe(true)
  })
})
