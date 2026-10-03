/**
 * 金标准对拍测试（09 §2.1）：
 * 1. moves.json —— allLegalMoves 输出与期望走法集合相等（顺序无关）；
 * 2. fen.json   —— FEN 逐条往返 fromFen(f).toFen() === f；
 * 3. notation.json —— 中文记法逐字一致。
 * 数据落盘于 tools/golden/，后续引擎/求解器对拍复用同一集合。
 */
import { describe, expect, it } from 'vitest'
import {
  Board,
  chineseNotation,
  isValidFen,
  pieceFromFenChar,
  pos,
  type Move,
  type Side
} from '@packages/rules'
import fenGolden from '../../tools/golden/fen.json'
import movesGolden from '../../tools/golden/moves.json'
import notationGolden from '../../tools/golden/notation.json'

interface GoldenStatus {
  inCheck: boolean
  checkmate: boolean
  stalemate: boolean
}

interface GoldenMoveCase {
  name: string
  fen: string
  side: Side
  status: GoldenStatus
  moves: number[][]
}

interface GoldenNotationCase {
  name: string
  piece: string
  from: number[]
  to: number[]
  expected: string
}

const moveCases = movesGolden.cases as GoldenMoveCase[]
const notationCases = notationGolden.cases as GoldenNotationCase[]

/** 走法 → 比较键（四元组字符串，顺序无关比较用）。 */
const moveKey = (m: Move): string => `${m.from.col},${m.from.row},${m.to.col},${m.to.row}`

describe('金标准走法对拍（tools/golden/moves.json）', () => {
  for (const c of moveCases) {
    it(c.name, () => {
      const board = Board.fromFen(c.fen)
      const actual = board.allLegalMoves(c.side)
      const actualKeys = new Set(actual.map(moveKey))
      const expectedKeys = c.moves.map((q) => q.join(','))

      // 集合相等：数量一致 + 每条期望走法都在实际输出中。
      expect(actualKeys.size, '着法数量不一致').toBe(expectedKeys.length)
      for (const key of expectedKeys) {
        expect(actualKeys.has(key), `缺少期望着法 (${key})`).toBe(true)
      }

      // 终局状态期望。
      expect(board.isCheck(c.side), 'isCheck 不一致').toBe(c.status.inCheck)
      expect(board.isCheckmate(c.side), 'isCheckmate 不一致').toBe(c.status.checkmate)
      expect(board.isStalemate(c.side), 'isStalemate 不一致').toBe(c.status.stalemate)
    })
  }
})

describe('金标准 FEN 往返（tools/golden/fen.json）', () => {
  it('金标准集全部通过粗校验', () => {
    for (const fen of fenGolden.fens) {
      expect(isValidFen(fen), fen).toBe(true)
    }
  })

  it('fromFen → toFen 逐条往返一致', () => {
    for (const fen of fenGolden.fens) {
      expect(Board.fromFen(fen).toFen(), fen).toBe(fen)
    }
  })
})

describe('金标准中文记法对拍（tools/golden/notation.json）', () => {
  for (const c of notationCases) {
    it(c.name, () => {
      const piece = pieceFromFenChar(c.piece)
      if (piece === null) throw new Error(`非法棋子字符: ${c.piece}`)
      const result = chineseNotation(piece, pos(c.from[0], c.from[1]), pos(c.to[0], c.to[1]))
      expect(result).toBe(c.expected)
    })
  }
})
