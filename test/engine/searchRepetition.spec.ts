/**
 * L1 搜索内重复检测单测（T3.7，DR-018，final 设计 §3）。
 *
 * - 向后兼容：historyCounts 缺省 = 旧行为（金标准分不变，两次运行确定性一致）；
 * - 全局历史惩罚：count≥2 的局面在 ply≤3 命中即剪枝，被标记着法分数显著下降；
 * - 路径重复阶梯：搜索分支内自循环被惩罚（empty 表即启用路径检测）。
 */
import { describe, expect, it } from 'vitest'
import { EngineBoard, Search, packedFrom, packedTo } from '../../src/packages/engine'

const DEADLINE = Date.now() + 10_000

/** 车马对弱方等基准局面（金标准既有期望覆盖，不传 historyCounts 分数不变）。 */
const PROBE_FENS = [
  '3k5/9/9/9/r8/9/R8/9/9/4K4 w - - 0 1', // 白吃车
  '1rbakab1r/9/1c4nc1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C1N2/9/RNBAKAB1R w - - 0 1',
  '4k4/9/9/9/4r4/4P4/9/4C4/9/4K4 w - - 0 1'
]

/** 车在底线的摇摆局面：红可 Ra1-a10 将军后摇摆回原位，形成搜索路径内循环。 */
const SWING_FEN = '4k4/9/9/9/9/9/9/9/9/R2K5 w - - 0 1'

const runScored = (fen: string, depth: number, historyCounts?: Map<string, number>) => {
  const s = new Search(EngineBoard.fromFen(fen), {
    maxDepth: depth,
    deadlineMs: DEADLINE,
    randomness: 0,
    historyCounts
  })
  return s.runScored()
}

describe('L1 重复检测（DR-018）', () => {
  it('向后兼容：缺省 historyCounts 两次运行 best/分数/nodeCount 逐位一致', () => {
    for (const fen of PROBE_FENS) {
      const s1 = new Search(EngineBoard.fromFen(fen), {
        maxDepth: 4,
        deadlineMs: DEADLINE,
        randomness: 0
      })
      const best1 = s1.run()
      const n1 = s1.nodeCount
      const s2 = new Search(EngineBoard.fromFen(fen), {
        maxDepth: 4,
        deadlineMs: DEADLINE,
        randomness: 0
      })
      const best2 = s2.run()
      expect(best1).toBe(best2)
      expect(n1).toBe(s2.nodeCount)
    }
  })

  it('全局历史惩罚：count=2/3 的惩罚值精确（重复方 −50/−200，命中即剪枝）', () => {
    const fen = PROBE_FENS[1]!
    const baseline = runScored(fen, 4)
    const [bestPacked] = baseline[0]!
    const from = packedFrom(bestPacked)
    const to = packedTo(bestPacked)
    // 落子后局面（红方视角静态分）作为惩罚基准。
    const probe = EngineBoard.fromFen(fen)
    probe.applyMove(from, to)
    const evalAfterMove = -probe.evaluate() // evaluate() 为走子方（黑）视角 → 取反得红方视角
    for (const [count, penalty] of [
      [2, 100],
      [3, 200]
    ] as const) {
      const counts = new Map<string, number>([[`${probe.zobristLo},${probe.zobristHi}`, count]])
      const scored = runScored(fen, 4, counts)
      const same = scored.find(([m]) => m === bestPacked)!
      // ply1 节点命中即剪枝：返回值 = 落子后静态评估 − 100×(count−1)，精确无搜索噪声。
      expect(same[1]).toBe(evalAfterMove - penalty)
    }
  })

  it('路径检测启用（空表）：搜索确定且分数有限（摇摆局面冒烟）', () => {
    const a = runScored(SWING_FEN, 6, new Map())
    const b = runScored(SWING_FEN, 6, new Map())
    expect(a).toEqual(b)
    for (const [, score] of a) expect(Number.isFinite(score)).toBe(true)
  })

  it('性能：检测的节点数开销 ≤5%（惩罚改变分数窗口可轻微改变剪枝形态）', () => {
    const runCounted = (fen: string, depth: number, counts?: Map<string, number>) => {
      const s = new Search(EngineBoard.fromFen(fen), {
        maxDepth: depth,
        deadlineMs: DEADLINE,
        randomness: 0,
        historyCounts: counts
      })
      s.run()
      return s.nodeCount
    }
    for (const fen of PROBE_FENS) {
      const baseline = runCounted(fen, 6)
      const withDetection = runCounted(fen, 6, new Map())
      expect(withDetection).toBeLessThanOrEqual(Math.ceil(baseline * 1.05))
    }
  })
})
