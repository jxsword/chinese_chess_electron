/**
 * MatchRunner 金标准对拍 + 结算路径确定性断言（T7.1，09 §2.2 / 05 §8.2）。
 *
 * 测试口径对齐 Flutter 版 strength_evaluation_test.dart：
 * - 弱模型以脚本化 fake transport 驱动（09 §2.3 可编程 fake）；
 * - 对手内置 AI 用难度 3（无随机窗口，完全可复现）；
 * - 质量评估深度对齐（advisorDifficulty 1 → 引擎 depth 2）。
 * 结算路径（resign/no-legal-move/illegal/超时/source-error/draw-limit）
 * 为 Electron 版新增 Electron 层用例（09 §2.3 表的同类扩展）。
 */
import { describe, expect, it } from 'vitest'
import { Board } from '../../src/packages/rules'
import {
  decodeCell,
  HybridLlmPlayer as HybridLlmPlayerCtor,
  LlmPlayer as LlmPlayerCtor
} from '../../src/packages/llm'
import type { AdvisorEngine, LlmTransport } from '../../src/packages/llm'
import type { LlmEndpointConfig } from '../../src/shared/ipc/types'
import {
  findBestMove,
  findBestMoveEx,
  evaluateMove,
  runMatch,
  runMatchSeries,
  BLUNDER_THRESHOLD_CP,
  MatchRunnerBlunder
} from '../../src/packages/engine'
import type { Move, MoveSource, MoveSourceResult } from '../../src/packages/engine'

const config: LlmEndpointConfig = {
  baseUrl: 'https://example.com/v1',
  model: 'fake',
  apiKey: '',
  disableThinking: false
}

/// "弱模型"策略：从 prompt 的着法清单中选择（strength_evaluation_test.dart 同款）。
type WeakStrategy = 'first' | 'last'

const pickWeak = (strategy: WeakStrategy, userPrompt: string): string => {
  // 只取清单段落，避免棋盘图/分析文本中的坐标干扰。
  const start = userPrompt.indexOf('着法清单')
  if (start < 0) return '着法: a0-a1' // 触发拒绝链路
  const outputIdx = userPrompt.indexOf('【输出】', start)
  const section = outputIdx < 0 ? userPrompt.substring(start) : userPrompt.substring(start, outputIdx)
  const codes = [...section.matchAll(/([a-i]\d)-([a-i]\d)/g)].map((m) => m[0])
  if (codes.length === 0) return '着法: a0-a1'
  return `着法: ${strategy === 'first' ? codes[0] : codes[codes.length - 1]}`
}

/// 弱模型 fake transport：解析 prompt 清单并按策略回复（09 §2.3）。
const weakLlmTransport = (strategy: WeakStrategy): LlmTransport => ({
  chat: async (req, handlers) => {
    const body = JSON.parse(req.body) as { messages: Array<{ content: string }> }
    handlers.onDone(pickWeak(strategy, body.messages[1]!.content))
  },
  cancel: async () => {}
})

const baselineSource = (): MoveSource =>
  new LlmPlayerCtor(config, weakLlmTransport('last'), {
    usePromptV2: false,
    maxAttempts: 2,
    fallback: 'builtinAi',
    builtinAiSource: () => engineSource()
  })

const hybridCandidateSource = (): MoveSource =>
  new HybridLlmPlayerCtor(
    config,
    weakLlmTransport('last'),
    advisorEngine(),
    {
      advisorMode: 'candidate',
      strengthBlend: 0,
      advisorDifficulty: 1,
      maxAttempts: 2,
      fallback: 'builtinAi',
      builtinAiSource: () => engineSource()
    }
  )

/// Node 直连引擎的参谋适配器（EngineClient 同语义：同步计算包成 async）。
const advisorEngine = (): AdvisorEngine => ({
  findBestMoveEx: async (fen, options) =>
    findBestMoveEx(fen, {
      depth: options?.depth,
      topK: options?.topK,
      timeLimitMs: options?.timeLimitMs
    }),
  evaluateMove: async (fen, move, options) => evaluateMove(fen, move, { depth: options?.depth })
})

/// Node 直连引擎的内置 AI 棋手（镜像 ChessAiMoveSource(difficulty: 3)：
/// depth 4 / 1600ms 上限，无随机窗口，对局完全可复现）。
const engineSource = (): MoveSource => ({
  displayName: '内置 AI（高级）',
  nextMove: async (board) => {
    const move = findBestMove(board, { difficulty: 3 })
    if (move === null) return { status: 'noLegalMove' }
    return { status: 'ok', move }
  }
})

/// 脚本化棋手：按固定序列回复（结算路径确定性驱动）。
const scriptedSource = (
  displayName: string,
  script: Array<(board: Board, ply: number) => MoveSourceResult>
): MoveSource => ({
  displayName,
  nextMove: async (board, _history) => {
    const fn = script.shift()
    if (fn === undefined) return { status: 'noLegalMove' }
    return fn(board, 0)
  }
})

const moveOf = (iccs: string): Move => {
  const [from, to] = iccs.split('-')
  return { from: decodeCell(from!)!, to: decodeCell(to!)! }
}

const ok = (iccs: string) => (): MoveSourceResult => ({ status: 'ok', move: moveOf(iccs) })

describe('战术命中率（确定性，镜像原版）', () => {
  /// 固定战术局面集：每个局面都存在引擎认可的明显好着。
  const tacticalFens = [
    '4k4/9/9/9/r8/9/R8/9/9/4K4 w', // R×r 白吃车
    '3k5/9/9/9/R8/8R/9/9/9/4K4 w', // 双车杀
    '4k4/9/9/9/9/4C4/9/4C4/9/4K4 w - - 0 1' // 双炮中线
  ]

  it('Hybrid 候选模式命中率 = 100%，基线选尾严格更低', async () => {
    let hybridHits = 0
    let baselineHits = 0
    let total = 0
    for (const fen of tacticalFens) {
      const board = Board.fromFen(fen)
      // 与被测 source 同深度（advisorDifficulty 1 → 引擎 depth 2），
      // 否则两个深度的 Top-3 集合可能不一致，断言结构上不成立。
      const report = findBestMoveEx(board, { depth: 2, topK: 3 })
      if (report === null) continue
      const top3 = new Set(report.topK.map(([m]) => `${m.from.col},${m.from.row}-${m.to.col},${m.to.row}`))
      total++

      // Hybrid 候选模式：池被限定在 Top-K 内，怎么选都命中。
      const hybrid = hybridCandidateSource()
      const hybridResult = await hybrid.nextMove(board)
      if (hybridResult.move !== undefined && top3.has(`${hybridResult.move.from.col},${hybridResult.move.from.row}-${hybridResult.move.to.col},${hybridResult.move.to.row}`)) {
        hybridHits++
      }

      // 基线：弱模型在全量清单中选尾。
      const baseline = baselineSource()
      const baselineResult = await baseline.nextMove(board)
      if (baselineResult.move !== undefined && top3.has(`${baselineResult.move.from.col},${baselineResult.move.from.row}-${baselineResult.move.to.col},${baselineResult.move.to.row}`)) {
        baselineHits++
      }
    }
    expect(total, '局面集应全部有效').toBe(3)
    expect(hybridHits, '候选模式命中 Top-3 比例应为 100%').toBe(total)
    expect(baselineHits, '基线选尾命中率应更低').toBeLessThan(total)
  })
})

describe('对局质量（MatchRunner，短局确定性对比，镜像原版）', () => {
  it('Hybrid 对弱模型的 Top-3 跟随改善：对抗 ChessAi(d3) 短局', { timeout: 120_000 }, async () => {
    // 基线（弱模型裸奔）。
    const baselineReport = await runMatch(baselineSource(), engineSource(), {
      maxPlies: 40,
      evaluateQuality: true,
      qualityDepth: 2
    })
    // Hybrid 候选模式（同一弱模型 + 参谋）。
    const hybridReport = await runMatch(hybridCandidateSource(), engineSource(), {
      maxPlies: 40,
      evaluateQuality: true,
      qualityDepth: 2
    })

    expect(baselineReport.evaluatedPlies).toBeGreaterThan(0)
    expect(hybridReport.evaluatedPlies).toBeGreaterThan(0)
    // Top-3 跟随率：Hybrid 候选模式被限定在引擎名单内（0 失随），
    // 基线选尾必然大量脱离引擎认可集合。
    expect(hybridReport.redTop3Misses, '候选模式所有选择都应在引擎 Top-3 内').toBe(0)
    expect(baselineReport.redTop3Misses, '基线选尾应有脱离引擎 Top-3 的着法').toBeGreaterThan(0)
    // 阈值常量与 Dart 一致（docs/phase5/02 §4）。
    expect(BLUNDER_THRESHOLD_CP).toBe(250)
    expect(MatchRunnerBlunder.mate).toBe(30000)
  })
})

describe('"大模型对战"场景（镜像原版）', () => {
  it('两 Hybrid 互打能正常完成对局', async () => {
    const hybridGate = (): MoveSource =>
      new HybridLlmPlayerCtor(
        config,
        weakLlmTransport('first'),
        advisorEngine(),
        {
          advisorMode: 'gate',
          strengthBlend: 0,
          advisorDifficulty: 1,
          maxAttempts: 2,
          fallback: 'builtinAi',
          builtinAiSource: () => engineSource()
        }
      )
    const report = await runMatch(hybridCandidateSource(), hybridGate(), { maxPlies: 30 })
    expect(report.plies).toBeGreaterThan(0)
    expect(['checkmate', 'stalemate', 'move-limit', 'resign', 'no-legal-move', 'illegal-move']).toContain(
      report.endReason
    )
    // 棋谱可追溯。
    expect(report.movesIccs.length).toBeGreaterThan(0)
    expect(report.movesIccs.length).toBe(report.plies)
  })
})

describe('结算路径（脚本化确定性）', () => {
  it('失败/无着 = 当方认输（winner=失败方-resign / endReason）', async () => {
    const blackFailed = scriptedSource('黑-失败', [() => ({ status: 'failed', note: '模型失效' })])
    const r1 = await runMatch(scriptedSource('红', [ok('h7-e7')]), blackFailed)
    // Dart 语义：winner = sideResign(loser)，即失败方为 red-resign/black-resign。
    expect(r1.winner).toBe('black-resign')
    expect(r1.endReason).toBe('resign')
    expect(r1.plies).toBe(1)
    expect(r1.movesIccs).toEqual(['h7e7'])

    const blackNoLegal = scriptedSource('黑-无着', [() => ({ status: 'noLegalMove' })])
    const r2 = await runMatch(scriptedSource('红', [ok('h7-e7')]), blackNoLegal)
    expect(r2.winner).toBe('black-resign')
    expect(r2.endReason).toBe('no-legal-move')
    expect(r2.plies).toBe(1)
  })

  it('source 异常 = 当方认输（endReason source-error）', async () => {
    const blackThrow = scriptedSource('黑-异常', [
      () => {
        throw new Error('boom')
      }
    ])
    const r = await runMatch(scriptedSource('红', [ok('h7-e7')]), blackThrow)
    expect(r.winner).toBe('black-resign')
    expect(r.endReason).toBe('source-error')
    expect(r.plies).toBe(1)
  })

  it('非法着法 = 当方认输（endReason illegal-move，合法性终审兜底）', async () => {
    // 黑方返回红方棋子的着法（起点非走子方棋子 → 非法）。
    const blackIllegal = scriptedSource('黑-非法', [() => ({ status: 'ok', move: moveOf('h7-e7') })])
    const r = await runMatch(scriptedSource('红', [ok('h7-e7')]), blackIllegal)
    expect(r.winner).toBe('black-resign')
    expect(r.endReason).toBe('illegal-move')
    expect(r.plies).toBe(1)
  })

  it('单手超时 = 超时方认输（默认 5 分钟，可注入短超时）', async () => {
    const blackStall = scriptedSource('黑-卡死', [() => new Promise<MoveSourceResult>(() => {})])
    const r = await runMatch(scriptedSource('红', [ok('h7-e7')]), blackStall, {
      perMoveTimeoutMs: 30
    })
    expect(r.winner).toBe('black-resign')
    expect(r.endReason).toBe('resign')
  })

  it('跑满 maxPlies = draw-limit，着法序列完整', async () => {
    // 双方都取第一个合法着法：确定且永不终局。
    const firstLegal = (name: string): MoveSource => ({
      displayName: name,
      nextMove: async (board) => {
        const legal = board.allLegalMoves()
        if (legal.length === 0) return { status: 'noLegalMove' }
        return { status: 'ok', move: legal[0]! }
      }
    })
    const r = await runMatch(firstLegal('红'), firstLegal('黑'), { maxPlies: 40 })
    expect(r.winner).toBe('draw-limit')
    expect(r.endReason).toBe('move-limit')
    expect(r.plies).toBe(40)
    expect(r.movesIccs.length).toBe(40)
    expect(r.redTimeMs).toBeGreaterThanOrEqual(0)
    expect(r.blackTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('runSeries 红黑换边：奇数局交换（消除执先偏差）', async () => {
    const calls: string[] = []
    const tag = (name: string, side: 'red' | 'black'): MoveSource => {
      calls.push(`${name}:${side}`)
      return scriptedSource(`${name}-${side}`, [() => ({ status: 'noLegalMove' })])
    }
    const reports = await runMatchSeries(
      (side) => tag('R', side),
      (side) => tag('B', side),
      { games: 2, maxPlies: 4 }
    )
    expect(reports.length).toBe(2)
    // 局 0：红先（R:red）；局 1：换边（R:black）——双方 builder 每局都构造（Dart 同款）。
    expect(calls).toEqual(['R:red', 'B:black', 'B:black', 'R:red'])
    // 两局都是"红侧无着认输"：局 0 R 执红先手即无着；局 1 换边后 B 执红、
    // B 的脚本同样首轮即无着 → 认输方均为红侧（red-resign）。
    expect(reports[0]!.winner).toBe('red-resign')
    expect(reports[1]!.winner).toBe('red-resign')
  })
})

describe('MatchReport JSON 协议面（05 §8.2 字段）', () => {
  it('字段名与 Dart 原版 toJson 逐字一致', async () => {
    const r = await runMatch(scriptedSource('红', [ok('h7-e7')]), scriptedSource('黑', [() => ({ status: 'failed' })]))
    expect(Object.keys(r).sort()).toEqual(
      [
        'blackBlunders',
        'blackFallbacks',
        'blackTimeMs',
        'blackTop3Hits',
        'blackTop3Misses',
        'endReason',
        'evaluatedPlies',
        'movesIccs',
        'plies',
        'redBlunders',
        'redFallbacks',
        'redTimeMs',
        'redTop3Hits',
        'redTop3Misses',
        'winner'
      ].sort()
    )
    // JSON 化后 moves 键名（Dart toJson 的 movesIccs → moves）。
    const json = JSON.parse(JSON.stringify(r)) as Record<string, unknown>
    expect(json['winner']).toBe('black-resign')
    expect(json['plies']).toBe(1)
    // JSON 化后键名即 MatchReport 字段（Dart toJson 的 movesIccs → moves 映射在 CLI 报告组装层）。
    expect(json['movesIccs']).toEqual(['h7e7'])
  })
})
