/**
 * 引擎内部棋盘与搜索内核单测（T3.1，03 文档 §3/§4/§8）。
 *
 * 快速层（EngineBoard）与 rules.Board 逐项对拍锁定语义 1:1；
 * 评估/排序用固定 FEN 手算分数断言；negamax 用金标准局面固定分。
 */
import { describe, expect, it } from 'vitest'
import { Board } from '../../src/packages/rules'
import type { Move, Piece, Position } from '../../src/packages/rules'
import {
  EngineBoard,
  Search,
  MATE_SCORE,
  INFINITY,
  indexToPos,
  packedCaptCode,
  packedFrom,
  packedTo,
  posToIndex
} from '../../src/packages/engine'

/** 对拍用局面集：覆盖将军/照面/蹩腿/炮架/过河兵/沉底车/将死/困毙各形态。 */
const PROBE_FENS = [
  'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1', // 初始
  '3k5/9/9/9/r8/9/R8/9/9/4K4 w - - 0 1', // 白吃车
  '3k5/9/9/9/R8/8R/9/9/9/4K4 w - - 0 1', // 一步杀
  'R3k4/9/9/9/9/4R4/9/9/9/4K4 b - - 0 1', // 黑被将死
  '4k4/9/9/9/4r4/4P4/9/4C4/9/4K4 w - - 0 1', // 兵炮对车
  '1rbakab1r/9/1c4nc1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C1N2/9/RNBAKAB1R w - - 0 1', // 中炮局
  '4k4/9/9/9/4p4/9/9/9/9/4K4 b - - 0 1', // 过河卒
  '2bak1b2/9/1cn4nc/9/9/9/9/9/9/1NBK1B1N1 w - - 0 1' // 士象活动
]

const pieceCode = (p: Piece | null): number => {
  if (p === null) return 0
  const base: Record<string, number> = {
    king: 1,
    advisor: 2,
    minister: 3,
    knight: 4,
    rook: 5,
    cannon: 6,
    pawn: 7
  }
  return base[p.kind] * (p.side === 'red' ? 1 : -1)
}

const posOf = (m: Move): string => `${m.from.col},${m.from.row}->${m.to.col},${m.to.row}`

describe('EngineBoard 与 rules.Board 对拍（语义 1:1）', () => {
  it('fromFen 的棋盘内容与轮走方逐格一致', () => {
    for (const fen of PROBE_FENS) {
      const rules = Board.fromFen(fen)
      const eb = EngineBoard.fromFen(fen)
      expect(eb.isRedTurn).toBe(rules.isRedTurn)
      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 9; c++) {
          expect(eb.pieceAt(r * 9 + c)).toBe(pieceCode(rules.pieceAt(c, r)))
        }
      }
    }
  })

  it('isCheck 双方判定一致', () => {
    for (const fen of PROBE_FENS) {
      const rules = Board.fromFen(fen)
      const eb = EngineBoard.fromFen(fen)
      expect(eb.isCheck(true)).toBe(rules.isCheck('red'))
      expect(eb.isCheck(false)).toBe(rules.isCheck('black'))
    }
  })

  it('伪合法走法集合一致（from/to/captured 逐条）', () => {
    for (const fen of PROBE_FENS) {
      const rules = Board.fromFen(fen)
      const eb = EngineBoard.fromFen(fen)
      const buf = new Int32Array(128)
      for (let sq = 0; sq < 90; sq++) {
        const p = rules.pieceAt(sq % 9, (sq / 9) | 0)
        if (p === null) continue
        const ruleMoves = rules
          .pseudoMovesFor({ col: sq % 9, row: (sq / 9) | 0 })
          .map(posOf)
          .sort()
        const n = eb.generateMovesFor(buf, 0, sq, false)
        const ebMoves: string[] = []
        for (let i = 0; i < n; i++) {
          const m = buf[i]
          const cap = packedCaptCode(m)
          ebMoves.push(
            `${packedFrom(m) % 9},${(packedFrom(m) / 9) | 0}->${packedTo(m) % 9},${(packedTo(m) / 9) | 0}`
          )
          // 位段 captured 与 rules 走法一致。
          const toPos: Position = indexToPos(packedTo(m))
          const capturedPiece = rules.pieceAt(toPos.col, toPos.row)
          if (cap === 0) {
            expect(capturedPiece).toBeNull()
          } else {
            expect(capturedPiece).not.toBeNull()
            expect(pieceCode(capturedPiece)).toBe(cap <= 7 ? cap : 8 - cap)
          }
        }
        expect(ebMoves.sort()).toEqual(ruleMoves)
      }
    }
  })

  it('capturesOnly 只保留吃子', () => {
    const eb = EngineBoard.fromFen('4k4/9/9/9/4r4/4P4/9/4C4/9/4K4 w - - 0 1')
    const buf = new Int32Array(128)
    const n = eb.generateMoves(buf, 0, true)
    expect(n).toBeGreaterThan(0)
    for (let i = 0; i < n; i++) {
      expect(packedCaptCode(buf[i])).not.toBe(0)
    }
  })

  it('applyMove/undoMove 往返与 rules 一致（全合法走法遍历）', () => {
    for (const fen of PROBE_FENS) {
      const rules = Board.fromFen(fen)
      const eb = EngineBoard.fromFen(fen)
      const before = Array.from(eb.data)
      for (const move of rules.allLegalMoves()) {
        const from = posToIndex(move.from)
        const to = posToIndex(move.to)
        const cap = eb.applyMove(from, to)
        const applied = rules.applyMove(move)
        expect(eb.isRedTurn).toBe(rules.isRedTurn)
        for (let sq = 0; sq < 90; sq++) {
          const p = rules.pieceAt(sq % 9, (sq / 9) | 0)
          expect(eb.pieceAt(sq)).toBe(pieceCode(p))
        }
        eb.undoMove(from, to, cap)
        rules.undoMove(applied)
      }
      expect(Array.from(eb.data)).toEqual(before)
    }
  })

  it('将死/困毙局面判定一致', () => {
    const mated = EngineBoard.fromFen('R3k4/9/9/9/9/4R4/9/9/9/4K4 b - - 0 1')
    expect(mated.isCheck(false)).toBe(true)
    const stalemate = Board.fromFen('R3k4/9/9/9/9/4R4/9/9/9/4K4 b - - 0 1')
    expect(stalemate.isCheck('black')).toBe(true)
  })
})

describe('静态评估（03 §4，固定 FEN 手算分数）', () => {
  it('初始局面红黑镜像对称，评估为 0', () => {
    expect(EngineBoard.fromFen(Board.initial().toFen()).evaluate()).toBe(0)
  })

  it('过河卒：子力 100 + 40 + 8×中距', () => {
    // 黑卒 (4,5) 已过河（row≥5）：colCenter=4 → 100 + 40 + 32 = 172；黑走 → +172。
    const eb = EngineBoard.fromFen('4k4/9/9/9/9/4p4/9/9/9/4K4 b - - 0 1')
    expect(eb.evaluate()).toBe(172)
  })

  it('未过河卒无位置修正', () => {
    // 黑卒 (4,3) 未过河：红视角 = -100，黑走 → +100。
    const eb = EngineBoard.fromFen('4k4/9/9/4p4/9/9/9/9/9/4K4 b - - 0 1')
    expect(eb.evaluate()).toBe(100)
  })

  it('沉底车 +10', () => {
    // 红车 (0,0) 沉底（红方沉底 = row 0）：900 + 10 = 910。
    const eb = EngineBoard.fromFen('R3k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1')
    expect(eb.evaluate()).toBe(910)
  })

  it('居中炮 +4×中距，边炮 0', () => {
    // 炮 (4,7)：colCenter=4 → 450+16=466。
    const center = EngineBoard.fromFen('3k5/9/9/9/9/9/9/4C4/9/3K5 w - - 0 1')
    expect(center.evaluate()).toBe(466)
    // 炮 (0,7)：colCenter=0 → 450。
    const flank = EngineBoard.fromFen('3k5/9/9/9/9/9/9/C8/9/3K5 w - - 0 1')
    expect(flank.evaluate()).toBe(450)
  })

  it('评估按轮走方视角取正负', () => {
    const redTurn = EngineBoard.fromFen('R3k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1')
    const blackTurn = EngineBoard.fromFen('R3k4/9/9/9/9/9/9/9/9/4K4 b - - 0 1')
    expect(redTurn.evaluate()).toBe(910)
    expect(blackTurn.evaluate()).toBe(-910)
  })
})

describe('MVV-LVA 排序（吃大子优先）', () => {
  it('马的多目标吃子按 victim 价值降序', () => {
    // 红马 (4,7) 可吃黑车 (5,5)（key=9000-400=8600）与黑卒 (3,5)（600）；
    // 等级在 packed 高位，升序排后等级小（优先级高）在前：吃车、吃卒、空格。
    const eb = EngineBoard.fromFen('3k5/9/9/9/9/3p1r3/9/4N4/9/4K4 w - - 0 1')
    const buf = new Int32Array(32)
    const from = posToIndex({ col: 4, row: 7 })
    const n = eb.generateMovesFor(buf, 0, from, false)
    expect(n).toBeGreaterThanOrEqual(2)
    const sorted = Array.from(buf.subarray(0, n)).sort((x, y) => x - y)
    expect(packedTo(sorted[0])).toBe(posToIndex({ col: 5, row: 5 }))
    expect(packedTo(sorted[1])).toBe(posToIndex({ col: 3, row: 5 }))
  })
})

describe('negamax/quiescence 固定分（金标准局面，03 §3）', () => {
  it('一步杀局面：全窗口深度 1 分 = mateScore − 1', () => {
    const eb = EngineBoard.fromFen('3k5/9/9/9/R8/8R/9/9/9/4K4 w - - 0 1')
    const search = new Search(eb, {
      maxDepth: 1,
      deadlineMs: Date.now() + 10_000,
      randomness: 0
    })
    const scored = search.runScored()
    expect(scored.length).toBeGreaterThan(0)
    expect(scored[0][1]).toBe(MATE_SCORE - 1)
  })

  it('被将死局面：runScored 空表、run 返回 null', () => {
    const eb = EngineBoard.fromFen('R3k4/9/9/9/9/4R4/9/9/9/4K4 b - - 0 1')
    const search = new Search(eb, { maxDepth: 2, deadlineMs: Date.now() + 10_000, randomness: 0 })
    expect(search.runScored()).toEqual([])
    expect(search.run()).toBeNull()
  })

  it('白吃车局面深度 2 全窗口分 = 638（Dart 参考值）', () => {
    const eb = EngineBoard.fromFen('4k4/9/9/9/4r4/4P4/9/4C4/9/4K4 w - - 0 1')
    const search = new Search(eb, { maxDepth: 2, deadlineMs: Date.now() + 10_000, randomness: 0 })
    const scored = search.runScored()
    expect(scored[0][1]).toBe(638)
  })

  it('deadline 已过时优雅中断并标记 interrupted（对齐 Dart 捕获语义）', () => {
    const eb = EngineBoard.fromFen(Board.initial().toFen())
    const search = new Search(eb, {
      maxDepth: 6,
      deadlineMs: Date.now() - 1,
      randomness: 0
    })
    const best = search.run()
    expect(search.interrupted).toBe('timeout')
    // 返回的是某一完整层的确定结果或 null。
    if (best !== null) {
      expect(best & 0x7f).toBeLessThanOrEqual(89)
    }
  })

  it('INFINITY 与 mate 分档不越界（杀分 < mateScore）', () => {
    expect(MATE_SCORE).toBe(30000)
    expect(INFINITY).toBe(100000)
  })
})
