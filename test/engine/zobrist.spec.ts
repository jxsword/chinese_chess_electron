/**
 * Zobrist 哈希单测（T3.6，DR-019，final 设计 §2）。
 *
 * - 确定性：初始局面键对快照（固定种子 PRNG，跨进程可复现）；
 * - 增量===重建：随机对局每步增量键与 fromFen 式全量重建键一致；
 * - apply/undo 往返：键复原；
 * - 轮走方参与键：同局面异轮走方键不同。
 */
import { describe, expect, it } from 'vitest'
import { EngineBoard } from '../../src/packages/engine'
import { rebuildZobrist } from '../../src/packages/engine/zobrist'

const FENS = [
  'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
  '1rbakab1r/9/1c4nc1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C1N2/9/RNBAKAB1R w - - 0 1',
  '3k5/9/9/9/r8/9/R8/9/9/4K4 w - - 0 1',
  '4k4/9/9/9/4r4/4P4/9/4C4/9/4K4 w - - 0 1'
]

/** 测试内固定种子 LCG，保证随机对局可复现。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('Zobrist 哈希（DR-019）', () => {
  it('初始局面键对跨进程确定（快照）', () => {
    const b = EngineBoard.fromFen(FENS[0]!)
    expect([b.zobristLo, b.zobristHi]).toMatchSnapshot()
  })

  it('fromFen 全量键 === rebuildZobrist 重建键', () => {
    for (const fen of FENS) {
      const b = EngineBoard.fromFen(fen)
      const [lo, hi] = rebuildZobrist(b.data, b.isRedTurn)
      expect(b.zobristLo).toBe(lo)
      expect(b.zobristHi).toBe(hi)
    }
  })

  it('随机对局每步：增量键 === 全量重建键；undo 后键复原', () => {
    const rand = lcg(0x5eed1234)
    for (const fen of FENS) {
      const b = EngineBoard.fromFen(fen)
      const lo0 = b.zobristLo
      const hi0 = b.zobristHi
      for (let step = 0; step < 120; step++) {
        const buf = new Int32Array(128)
        const n = b.generateMoves(buf, 0, false)
        if (n === 0) break
        // 收集合法（不吃王）走法，随机取一。
        const candidates: Array<[number, number]> = []
        for (let i = 0; i < n; i++) {
          const from = buf[i]! & 0x7f
          const to = (buf[i]! >>> 7) & 0x7f
          const t = b.pieceAt(to)
          if (t === 1 || t === -1) continue // 不吃王，保持王位缓存有效
          candidates.push([from, to])
        }
        if (candidates.length === 0) break
        const [from, to] = candidates[Math.floor(rand() * candidates.length)]!
        const keyBefore: [number, number] = [b.zobristLo, b.zobristHi]
        const captured = b.applyMove(from, to)
        const [lo, hi] = rebuildZobrist(b.data, b.isRedTurn)
        expect(b.zobristLo).toBe(lo)
        expect(b.zobristHi).toBe(hi)
        b.undoMove(from, to, captured)
        expect(b.zobristLo).toBe(keyBefore[0])
        expect(b.zobristHi).toBe(keyBefore[1])
      }
      expect(b.zobristLo).toBe(lo0)
      expect(b.zobristHi).toBe(hi0)
    }
  })

  it('同局面异轮走方键不同（轮走方参与键）', () => {
    const redToMove = EngineBoard.fromFen(FENS[1]!)
    const blackToMove = EngineBoard.fromFen(FENS[1]!.replace(' w ', ' b '))
    expect(redToMove.zobristLo).not.toBe(blackToMove.zobristLo)
  })

  it('不同局面键不同（捕获改变键）', () => {
    const before = EngineBoard.fromFen('3k5/9/9/9/r8/9/R8/9/9/4K4 w - - 0 1')
    const after = EngineBoard.fromFen('3k5/9/9/9/9/9/R8/9/9/4K4 w - - 0 1')
    expect(before.zobristLo).not.toBe(after.zobristLo)
  })
})
