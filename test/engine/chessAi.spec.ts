/**
 * ChessAi 三接口金标准对拍（T3.2，09 文档 §2.2）。
 *
 * 金标准来源：Flutter 版 ChessAi（ai_engine.dart）在固定 FEN 上
 * findBestMoveEx 逐层独立搜索的输出（tools/golden/engine.json，dart run 提取）。
 * 根节点全窗口下每个着法的分数是精确 minimax 值（与走法生成顺序无关），
 * 因此跨语言逐位可复现；同分着法间的排序不参与对拍（Dart sort 不稳定）。
 *
 * 慢速对拍集（initial/midgame 深层完整搜索耗时 3.6~25s）与性能门用例
 * 由 RUN_SLOW=1 启用：RUN_SLOW=1 node tools/run-vitest.mjs run test/engine
 */
import { describe, expect, it } from 'vitest'
import golden from '../../tools/golden/engine.json'
import { Board } from '../../src/packages/rules'
import type { Move } from '../../src/packages/rules'
import { findBestMove, findBestMoveEx, evaluateMove } from '../../src/packages/engine'

interface GoldenCase {
  name: string
  fen: string
  ex: Record<string, { best: GoldenMoveJson | null; bestCp: number | null; topK: GoldenTopEntry[] | null }>
  evaluate?: GoldenEvalEntry[]
}
interface GoldenMoveJson {
  from: string
  to: string
  captured?: string
}
interface GoldenTopEntry {
  move: GoldenMoveJson
  cp: number
}
interface GoldenEvalEntry {
  move: GoldenMoveJson
  depth: number
  cp: number | null
}

const cases = golden.cases as unknown as GoldenCase[]

/** 慢速对拍集：完整搜索耗时较长，普通 CI 跳过（见 09 §2.2 与金标准 note）。 */
const slowDepths = golden.slowDepths as Record<string, number[]>
const RUN_SLOW = process.env.RUN_SLOW === '1'

const parsePos = (s: string): { col: number; row: number } => {
  const [col, row] = s.replace(/[[\]]/g, '').split(',').map(Number)
  return { col, row }
}

const moveKey = (m: Move): string => `${m.from.col},${m.from.row}->${m.to.col},${m.to.row}`
const goldenMoveKey = (g: GoldenMoveJson): string => `${parsePos(g.from).col},${parsePos(g.from).row}->${parsePos(g.to).col},${parsePos(g.to).row}`

describe('findBestMoveEx 金标准对拍（全窗口真实分差，tools/golden/engine.json）', () => {
  for (const c of cases) {
    for (const [depthStr, report] of Object.entries(c.ex)) {
      const depth = Number(depthStr)
      const isSlow = (slowDepths[c.name] ?? []).includes(depth)
      const runIt = isSlow && !RUN_SLOW ? it.skip : it
      runIt(
        `${c.name} 深度 ${depth}${isSlow ? '（慢速集）' : ''}`,
        { timeout: isSlow ? 120_000 : 10_000 },
        () => {
          const board = Board.fromFen(c.fen)
          const actual = findBestMoveEx(board, { depth, topK: 16, timeLimitMs: 60_000 })

          if (report.topK === null) {
            // 被将死/困毙：无合法走法返回 null。
            expect(actual).toBeNull()
            return
          }
          expect(actual).not.toBeNull()
          const rep = actual!

          // bestCp 与 Dart 一致；best 着法在同分着法间可能不同（Dart sort 不稳定），
          // 故只断言分数逐位与逐着法一致，不断言 best 的具体着法。
          expect(rep.bestCp).toBe(report.bestCp)
          expect(rep.topK[0][1]).toBe(rep.bestCp)

          // 分数序列逐位一致（降序）。
          expect(rep.topK.length).toBeGreaterThanOrEqual(report.topK.length)
          for (let i = 0; i < report.topK.length; i++) {
            expect(rep.topK[i][1]).toBe(report.topK[i].cp)
          }

          // 逐着法分数一致（同分着法间的顺序不作断言）。
          const goldenByMove = new Map(report.topK.map((e) => [goldenMoveKey(e.move), e.cp]))
          for (const [move, cp] of rep.topK) {
            const expected = goldenByMove.get(moveKey(move))
            if (expected !== undefined) expect(cp).toBe(expected)
          }
        }
      )
    }
  }
})

describe('evaluateMove 金标准对拍', () => {
  for (const c of cases) {
    for (const e of c.evaluate ?? []) {
      it(`${c.name} ${e.move.from}->${e.move.to} 深度 ${e.depth}`, () => {
        const board = Board.fromFen(c.fen)
        const move: Move = {
          from: parsePos(e.move.from),
          to: parsePos(e.move.to)
        }
        const cp = evaluateMove(board, move, { depth: e.depth })
        expect(cp).toBe(e.cp)
      })
    }
  }
})

describe('findBestMove 行为等价（Dart ai_engine_test.dart 用例集）', () => {
  it('初始局面返回合法走法且不修改调用方棋盘', () => {
    const board = Board.initial()
    const fenBefore = board.toFen()
    const move = findBestMove(board, { difficulty: 1 })
    expect(move).not.toBeNull()
    const legal = board
      .legalMovesFor(move!.from)
      .some((m) => m.to.col === move!.to.col && m.to.row === move!.to.row)
    expect(legal).toBe(true)
    expect(board.toFen()).toBe(fenBefore)
  })

  it('优先白吃高价值棋子（difficulty 2）', () => {
    const board = Board.fromFen('4k4/9/9/9/4r4/4P4/9/4C4/9/4K4 w - - 0 1')
    const move = findBestMove(board, { difficulty: 2 })
    expect(move).not.toBeNull()
    expect(move!.to).toEqual({ col: 4, row: 4 })
    expect(move!.captured?.kind).toBe('rook')
  })

  it('被将死局面返回 null', () => {
    const board = Board.fromFen('R3k4/4R4/4P4/9/9/9/9/9/9/4K4 b - - 0 1')
    expect(board.isCheckmate('black')).toBe(true)
    expect(findBestMove(board, { difficulty: 1 })).toBeNull()
  })

  it('被将军时优先解将而不是进攻（difficulty 1）', () => {
    const board = Board.fromFen('4k4/9/9/9/4R4/9/9/9/9/4K4 w - - 0 1')
    const move = findBestMove(board, { difficulty: 1 })
    expect(move).not.toBeNull()
    board.applyMove(move!)
    expect(board.isCheck('red')).toBe(false)
  })

  it('难度 1-5 均给出合法走法', { timeout: 30_000 }, () => {
    const board = Board.initial()
    for (let level = 1; level <= 5; level++) {
      const move = findBestMove(board, { difficulty: level })
      expect(move, `难度 ${level} 应返回走法`).not.toBeNull()
      const legal = board
        .legalMovesFor(move!.from)
        .some((m) => m.to.col === move!.to.col && m.to.row === move!.to.row)
      expect(legal, `难度 ${level} 的走法应合法`).toBe(true)
    }
  })
})

describe('findBestMoveEx 行为等价（Dart ai_engine_ex_test.dart 用例集）', () => {
  const captureFen = '3k5/9/9/9/r8/9/R8/9/9/4K4 w'
  const mateFen = '3k5/9/9/9/R8/8R/9/9/9/4K4 w'
  const deadFen = 'R3k4/9/9/9/9/4R4/9/9/9/4K4 b'

  it('Top-K 降序排列，最佳与首位一致', () => {
    const report = findBestMoveEx(Board.fromFen(captureFen), { depth: 4, topK: 3 })!
    expect(report.topK).toHaveLength(3)
    for (let i = 1; i < report.topK.length; i++) {
      expect(report.topK[i][1]).toBeLessThanOrEqual(report.topK[i - 1][1])
    }
    expect(report.best).toEqual(report.topK[0][0])
    expect(report.bestCp).toBe(report.topK[0][1])
  })

  it('吃车着法进入 Top-K 且大幅占优（> 800 厘兵）', () => {
    const report = findBestMoveEx(Board.fromFen(captureFen), { depth: 4, topK: 8 })!
    const eatRook = report.topK.find(
      ([m]) => m.from.col === 0 && m.from.row === 6 && m.to.col === 0 && m.to.row === 4
    )
    expect(eatRook, '吃车着法未入 Top-K').toBeDefined()
    expect(eatRook![1]).toBeGreaterThan(800)
  })

  it('一步杀局面 bestCp 达到将杀分量级（> 25000）', () => {
    const report = findBestMoveEx(Board.fromFen(mateFen), { depth: 4, topK: 3 })!
    expect(report.bestCp).toBeGreaterThan(25000)
  })

  it('黑方被将死（轮黑无合法着法）返回 null', () => {
    expect(findBestMoveEx(Board.fromFen(deadFen), { depth: 2 })).toBeNull()
  })
})

describe('evaluateMove 行为等价（Dart ai_engine_ex_test.dart 用例集）', () => {
  const captureFen = '3k5/9/9/9/r8/9/R8/9/9/4K4 w'

  it('好着（吃车）大幅占优，消极着法分差明显', () => {
    const board = Board.fromFen(captureFen)
    const goodCp = evaluateMove(board, { from: { col: 0, row: 6 }, to: { col: 0, row: 4 } }, { depth: 3 })
    expect(goodCp).not.toBeNull()
    const passiveCp = evaluateMove(board, { from: { col: 0, row: 6 }, to: { col: 5, row: 6 } }, { depth: 3 })
    expect(passiveCp).not.toBeNull()
    expect(passiveCp!).toBeLessThan(goodCp!)
  })

  it('非法着法返回 null（起点无己方子 / 走完自将）', () => {
    const board = Board.fromFen(captureFen)
    expect(evaluateMove(board, { from: { col: 0, row: 0 }, to: { col: 0, row: 1 } })).toBeNull()
    expect(evaluateMove(board, { from: { col: 0, row: 4 }, to: { col: 0, row: 6 } })).toBeNull()
  })
})

describe('性能门（@slow，RUN_SLOW=1 启用；09 §2.2：难度 5 应答 ≤ 7.5s）', { timeout: 120_000 }, () => {
  it.skipIf(!RUN_SLOW)('难度 5（深度 6）初始局面应答 ≤ 7.5s', () => {
    const board = Board.initial()
    const t0 = performance.now()
    const move = findBestMove(board, { difficulty: 5 })
    const elapsed = performance.now() - t0
    expect(move).not.toBeNull()
    expect(elapsed).toBeLessThanOrEqual(7500)
    console.info(`性能门：难度 5 初始局面应答 ${elapsed.toFixed(0)}ms`)
  })

  it.skipIf(!RUN_SLOW)('慢速对拍集（initial/midgame 深层）', () => {
    for (const c of cases) {
      if (!(c.name in slowDepths)) continue
      for (const depth of slowDepths[c.name]) {
        const report = findBestMoveEx(Board.fromFen(c.fen), { depth, topK: 16, timeLimitMs: 60_000 })
        const goldenReport = c.ex[String(depth)]
        if (goldenReport.topK === null) {
          expect(report).toBeNull()
          continue
        }
        expect(report!.bestCp).toBe(goldenReport.bestCp)
        for (let i = 0; i < goldenReport.topK.length; i++) {
          expect(report!.topK[i][1]).toBe(goldenReport.topK[i].cp)
        }
      }
    }
  })
})
