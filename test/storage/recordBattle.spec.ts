/** 进入对战起点计算等价用例（test/features/record/record_battle_launcher_test.dart 纯函数组，07 文档 §5 F1） */
import { describe, expect, it } from 'vitest'
import { battleStartFen, canLaunchBattle, battleRouteFor } from '@packages/storage-schema/recordBattle'
import { fillMovePieces, type GameRecordData } from '@packages/storage-schema'
import { pos, FEN_INITIAL, type Move } from '@packages/rules'

const CREATED_AT = new Date(2026, 9, 2, 8).getTime()

/** 对局类棋谱（两着：炮二平五 / 马8进7，可带结果） */
function sessionRecord(result: GameRecordData['result']): GameRecordData {
  const moves: Move[] = fillMovePieces(FEN_INITIAL, [
    { from: pos(7, 7), to: pos(4, 7) },
    { from: pos(7, 0), to: pos(6, 2) }
  ])
  return {
    title: '对局',
    mode: 'humanVsHuman',
    initialFen: FEN_INITIAL,
    moves,
    result,
    solveStatus: 'none',
    solutions: [],
    llmNote: null,
    note: null,
    createdAt: CREATED_AT
  }
}

/** 多解残局棋谱 */
function endgameRecord(status: GameRecordData['solveStatus']): GameRecordData {
  return {
    title: '残局',
    mode: 'endgame',
    initialFen: '3k5/9/9/9/R8/8R/9/9/9/4K4 w - - 0 1',
    moves: [],
    result: null,
    solveStatus: status,
    solutions:
      status === 'solved'
        ? [
            ['a5d5'],
            ['i4d4']
          ]
        : [],
    llmNote: null,
    note: null,
    createdAt: CREATED_AT
  }
}

describe('battleStartFen / canLaunchBattle', () => {
  it('对局未分胜负 → 起点 = 终局 FEN', () => {
    const record = sessionRecord(null)
    const fen = battleStartFen(record)
    expect(fen).not.toBeNull()
    expect((fen as string).split(' ')[0]).not.toBe(
      'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR'
    )
    expect(canLaunchBattle(record)).toBe(true)
  })

  it('对局已分胜负 → 无入口', () => {
    const record = sessionRecord('redWins')
    expect(battleStartFen(record)).toBeNull()
    expect(canLaunchBattle(record)).toBe(false)
  })

  it('残局类（含无解/未决）→ 起点 = initialFen', () => {
    for (const status of ['solved', 'noSolution', 'timeout', 'none'] as const) {
      const record = endgameRecord(status)
      expect(battleStartFen(record)).toBe(record.initialFen)
      expect(canLaunchBattle(record)).toBe(true)
    }
  })

  it('续战路由携带 fen/side query（页面 canSave=false 门控就绪）', () => {
    const fen = '3k5/9/9/9/R8/8R/9/9/9/4K4 w - - 0 1'
    expect(battleRouteFor('humanVsHuman', fen)).toBe(
      `/human-vs-human?fen=${encodeURIComponent(fen)}`
    )
    expect(battleRouteFor('humanVsAi', fen, 'black')).toBe(
      `/human-vs-ai?fen=${encodeURIComponent(fen)}&side=black`
    )
    expect(battleRouteFor('llmVsLlm', fen)).toBe(`/llm-vs-llm?fen=${encodeURIComponent(fen)}`)
  })
})
