/**
 * L2 根节点历史回避单测（T3.8，DR-018，final 设计 §4）。
 *
 * - pickAvoidanceMove 纯函数：阈值内随机换着 / 长将强制变着（底线 −500）/ 保留原着；
 * - findBestMove 集成：不传 historyFens 与参谋一致（向后兼容）；命中历史时返回
 *   非重复着法；无合理替代时保留原着（将杀优先于回避）。
 */
import { describe, expect, it } from 'vitest'
import {
  findBestMove,
  findBestMoveEx,
  pickAvoidanceMove,
  EngineBoard,
  posToIndex,
  type ScoredMove
} from '../../src/packages/engine'
import { Board } from '../../src/packages/rules'

const FEN_CANNON_END = '4k4/9/9/9/4r4/4P4/9/4C4/9/4K4 w - - 0 1' // 参谋分差 72 < 阈值 100
const FEN_MATE = '3k5/9/9/9/9/9/9/9/9/R3K4 w - - 0 1' // 一步杀，分差 ≫ 任何阈值

const i = (p: { col: number; row: number }): number => p.row * 9 + p.col

describe('pickAvoidanceMove 纯函数（DR-018）', () => {
  const ctx = (
    scored: ScoredMove[],
    best: number,
    opts: { repeated?: number[]; checks?: number[]; base?: number; random?: () => number } = {}
  ) => ({
    scored,
    best,
    thresholdBase: opts.base ?? 100,
    postCount: (m: number): number => (opts.repeated?.includes(m) ? 1 : 0),
    isCheckMove: (m: number): boolean => opts.checks?.includes(m) ?? false,
    ...(opts.random !== undefined ? { random: opts.random } : {})
  })

  it('阈值内存在非重复候选 → 随机取一（注入固定随机源可断言）', () => {
    const scored: ScoredMove[] = [
      [11, 500],
      [22, 480],
      [33, 460]
    ]
    // 阈值 = 100（500 不 >200 → 系数 1）；11 重复被排除，22/33 均为候选。
    // 固定随机源恒取 0.999 → Fisher-Yates 每步 j=i 不换序 → 取首个（22）。
    const picked = pickAvoidanceMove(ctx(scored, 11, { repeated: [11], random: () => 0.999 }))
    expect(picked).toBe(22)
  })

  it('优劣势系数：大优势阈值 ×0.5，大劣势 ×2.0', () => {
    const scored: ScoredMove[] = [
      [11, 500],
      [22, 470] // 差 30
    ]
    // 大优势（500>200）：阈值 = 100×0.5 = 50 → 470 < 450? 不，470 ≥ 450 → 是候选
    expect(pickAvoidanceMove(ctx(scored, 11, { repeated: [11], random: () => 0 }))).toBe(22)
    // 大劣势（−500 < −200）：阈值 = 100×2 = 200
    const losing: ScoredMove[] = [
      [11, -500],
      [22, -400]
    ]
    expect(pickAvoidanceMove(ctx(losing, 11, { repeated: [11], random: () => 0 }))).toBe(22)
    // 大优势下差 60 超过阈值 50 → 无候选
    const tight: ScoredMove[] = [
      [11, 500],
      [22, 440]
    ]
    expect(pickAvoidanceMove(ctx(tight, 11, { repeated: [11], random: () => 0 }))).toBe(11)
  })

  it('长将形态：无阈值内候选且最佳为将军 → 强制选非将军非重复最高分（底线 −500）', () => {
    const scored: ScoredMove[] = [
      [11, 300], // 最佳：将军且重复
      [22, -100], // 非将军非重复，劣化 400 ≤ 500 底线 → 被选中
      [33, -700] // 劣化 1000 > 底线 → 排除
    ]
    const picked = pickAvoidanceMove(
      ctx(scored, 11, { repeated: [11], checks: [11], random: () => 0 })
    )
    expect(picked).toBe(22)
  })

  it('长将形态底线内无候选 → 保留原着（宁可重复交规则裁决）', () => {
    const scored: ScoredMove[] = [
      [11, 300],
      [22, -400] // 劣化 700 > 500 底线
    ]
    const picked = pickAvoidanceMove(
      ctx(scored, 11, { repeated: [11], checks: [11], random: () => 0 })
    )
    expect(picked).toBe(11)
  })

  it('最佳非将军且无候选 → 保留原着（闲着重复交 L3）', () => {
    const scored: ScoredMove[] = [
      [11, 100],
      [22, -900]
    ]
    const picked = pickAvoidanceMove(ctx(scored, 11, { repeated: [11], random: () => 0 }))
    expect(picked).toBe(11)
  })
})

describe('findBestMove L2 集成（DR-018）', () => {
  it('向后兼容：不传 historyFens 时与参谋报告最佳一致', () => {
    for (const fen of [FEN_CANNON_END, '1rbakab1r/9/1c4nc1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C1N2/9/RNBAKAB1R w - - 0 1']) {
      const best = findBestMove(fen, { difficulty: 3 })
      const report = findBestMoveEx(fen, { depth: 4 })
      expect(report).not.toBeNull()
      expect(best).toEqual(report!.best)
    }
  })

  it('最佳着法命中历史（count=1）→ 返回落子后非重复的着法', () => {
    const fen = FEN_CANNON_END
    const report = findBestMoveEx(fen, { depth: 4 })
    expect(report).not.toBeNull()
    const best = report!.best
    // 构造历史：当前局面 + 最佳着法落子后局面（各出现 1 次）。
    const historyFens = [fen, ...(() => {
      const b = Board.fromFen(fen)
      b.applyMove({ from: best.from, to: best.to })
      return [b.toFen()]
    })()]
    const result = findBestMove(fen, { difficulty: 3, historyFens })
    expect(result).not.toBeNull()
    expect(result).not.toEqual(best) // 分差 72 < 阈值 100，阈值内必有非重复候选
    const b = EngineBoard.fromFen(fen)
    b.applyMove(i(result!.from), i(result!.to))
    // 落子后局面不在历史中（否则仍在重复）——直接比键。
    const marked = historyFens.map((f) => {
      const hb = EngineBoard.fromFen(f)
      return `${hb.zobristLo},${hb.zobristHi}`
    })
    expect(marked).not.toContain(`${b.zobristLo},${b.zobristHi}`)
  })

  it('将杀优先于回避：无合理替代时保留原着（一步杀不因历史回避放弃）', () => {
    const fen = FEN_MATE
    const report = findBestMoveEx(fen, { depth: 4 })
    expect(report).not.toBeNull()
    const best = report!.best
    const b = Board.fromFen(fen)
    b.applyMove({ from: best.from, to: best.to })
    const historyFens = [fen, b.toFen()]
    const result = findBestMove(fen, { difficulty: 3, historyFens })
    // 将杀分 29999 与次选 910 分差 ≫ 阈值与 −500 底线 → 保留将杀。
    expect(result).toEqual(best)
  })

  it('posToIndex 与 packed 坐标一致（协议换算健全性）', () => {
    expect(posToIndex({ col: 0, row: 9 })).toBe(81)
    expect(posToIndex({ col: 4, row: 0 })).toBe(4)
  })
})
