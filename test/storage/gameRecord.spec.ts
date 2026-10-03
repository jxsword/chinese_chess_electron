import { describe, it, expect } from 'vitest'
import {
  recordFromSession,
  fillMovePieces,
  chineseNotations,
  decodeRecordMove,
  encodeRecordMove,
  solveStatusLabel,
  hasUniqueSolution,
  isEndgameMode,
  type GameRecordData
} from '@packages/storage-schema'
import { pos } from '@packages/rules'
import { FEN_INITIAL } from '@packages/rules'

// 等价集：test/features/record/game_record_test.dart（8 例，09 文档 §1 映射 game_record 8）

const FEN_START = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w'

/** 从初始局面重放 moves 得到终局 FEN（测试辅助，不复用业务代码——对齐原版测试） */
function initialBoardAfter(moves: Array<{ from: ReturnType<typeof pos>; to: ReturnType<typeof pos> }>): string {
  const grid: Array<Array<string | null>> = [
    ['r', 'n', 'b', 'a', 'k', 'a', 'b', 'n', 'r'],
    Array(9).fill(null),
    [null, 'c', null, null, null, null, null, 'c', null],
    ['p', null, 'p', null, 'p', null, 'p', null, 'p'],
    Array(9).fill(null),
    Array(9).fill(null),
    ['P', null, 'P', null, 'P', null, 'P', null, 'P'],
    [null, 'C', null, null, null, null, null, 'C', null],
    Array(9).fill(null),
    ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R']
  ]
  let turn = 'w'
  for (const m of moves) {
    grid[m.to.row][m.to.col] = grid[m.from.row][m.from.col]
    grid[m.from.row][m.from.col] = null
    turn = turn === 'w' ? 'b' : 'w'
  }
  const rows = grid.map((row) => {
    let buf = ''
    let empty = 0
    for (const cell of row) {
      if (cell === null) {
        empty++
      } else {
        if (empty > 0) {
          buf += String(empty)
          empty = 0
        }
        buf += cell
      }
    }
    if (empty > 0) buf += String(empty)
    return buf
  })
  return `${rows.join('/')} ${turn} - - 0 1`
}

describe('recordFromSession（game_record_test.dart fromSession 组）', () => {
  it('从终局反推初始 FEN（标准开局两步）', () => {
    // 炮二平五 / 马8进7
    const moves = [
      { from: pos(7, 7), to: pos(4, 7) },
      { from: pos(7, 0), to: pos(6, 2) }
    ]
    const record = recordFromSession({
      mode: 'humanVsHuman',
      finalFen: initialBoardAfter(moves),
      moves
    })
    expect(record.initialFen.split(' ')[0]).toBe(
      'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR'
    )
    expect(record.createdAt).not.toBeNull()
  })

  it('标题缺省时自动生成', () => {
    const record = recordFromSession({
      mode: 'humanVsAi',
      finalFen: initialBoardAfter([]),
      moves: []
    })
    expect(record.title).toContain('人机对战')
  })
})

describe('fillMovePieces（game_record_test.dart fillMovePieces 组）', () => {
  it('重放补齐棋子与吃子信息', () => {
    // 红车 (8,9)->(8,7)->(8,0) 吃黑马（对齐原版用例）
    const moves = [
      { from: pos(8, 9), to: pos(8, 7) },
      { from: pos(7, 0), to: pos(6, 2) },
      { from: pos(8, 7), to: pos(8, 0) }
    ]
    const filled = fillMovePieces(FEN_START, moves)
    expect(filled.length).toBe(3)
    expect(filled[0]!.piece!.side).toBe('red')
    expect(filled[0]!.captured).toBeUndefined()
    // (8,0) 是黑马边线的黑车（原版断言 captured?.label == '车'）
    expect(filled[2]!.captured!.side).toBe('black')
    expect(filled[2]!.captured!.kind).toBe('rook')
  })

  it('局面不符的走法被截断（防御式）', () => {
    const filled = fillMovePieces(FEN_START, [{ from: pos(4, 4), to: pos(4, 5) }])
    expect(filled).toEqual([])
  })
})

describe('chineseNotations（game_record_test.dart chineseNotations 组）', () => {
  it('生成中文记谱', () => {
    const moves = [{ from: pos(7, 7), to: pos(4, 7) }]
    const record = recordFromSession({
      mode: 'humanVsHuman',
      finalFen: initialBoardAfter(moves),
      moves
    })
    expect(chineseNotations(record.initialFen, record.moves)).toEqual(['炮二平五'])
  })

  it('残局自定义 FEN 同样适用', () => {
    // 红帅 (4,9) + 红车 (3,4)，黑将 (3,0)：车 (3,4)->(3,2) 无吃子
    const fen = '3k5/9/9/9/3R5/9/9/9/9/4K4 w'
    const moves = [{ from: pos(3, 4), to: pos(3, 2) }]
    const notations = chineseNotations(fen, moves)
    expect(notations.length).toBeGreaterThan(0)
    expect(notations[0]!.startsWith('车')).toBe(true)
  })
})

describe('序列化往返（game_record_test.dart 序列化组）', () => {
  it('encodeRecordMove 与 decodeRecordMove 一致（含棋子）', () => {
    const moves = fillMovePieces(FEN_INITIAL, [
      { from: pos(7, 7), to: pos(4, 7) },
      { from: pos(7, 0), to: pos(6, 2) }
    ])
    for (const m of moves) {
      const decoded = decodeRecordMove(encodeRecordMove(m))
      expect(decoded).not.toBeNull()
      expect(decoded!.from).toEqual(m.from)
      expect(decoded!.to).toEqual(m.to)
      expect(decoded!.piece).toEqual(m.piece)
    }
  })
})

describe('SolveStatus（game_record_test.dart SolveStatus 组）', () => {
  it('标签与唯一解判定', () => {
    const record: GameRecordData = {
      mode: 'endgame',
      title: 't',
      initialFen: '3k5/9/9/9/9/9/9/9/9/4K4 w',
      moves: [],
      result: null,
      solveStatus: 'solved',
      solutions: [['h2e2']],
      createdAt: null
    }
    expect(solveStatusLabel(record.solveStatus)).toBe('已破解')
    expect(hasUniqueSolution(record.solveStatus, record.solutions)).toBe(true)
    expect(isEndgameMode(record.mode)).toBe(true)
  })
})
