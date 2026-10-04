/** PGN 导出等价用例集（test/features/record/pgn_writer_test.dart 8 条，07 文档 §5 F2）+ 快照锁定 */
import { describe, expect, it } from 'vitest'
import { writePgn, pgnResultTag, solveVerdictLines } from '@packages/storage-schema/pgnWriter'
import { recordFromSession, type GameRecordData } from '@packages/storage-schema/gameRecord'
import { writeShareText } from '@packages/storage-schema/shareText'
import { fillMovePieces } from '@packages/storage-schema/gameRecord'
import { parseIccs } from '@packages/parsers/iccs'
import { pos, FEN_INITIAL, type Move } from '@packages/rules'

/** 固定时间戳：本地 2026-10-02 08:00（快照与用例共用，取本地时间避免时区漂移） */
const CREATED_AT = new Date(2026, 9, 2, 8, 0, 0).getTime()
const FIXED_NOW = new Date(CREATED_AT)

/** 标准开局两步（炮二平五 / 马8进7）的带棋子历史 */
function sessionMoves(): Move[] {
  return fillMovePieces(FEN_INITIAL, [
    { from: pos(7, 7), to: pos(4, 7) },
    { from: pos(7, 0), to: pos(6, 2) }
  ])
}

/** 两步对局记录（经 fromSession 反推 initialFen） */
function sessionRecord(): GameRecordData {
  const moves = sessionMoves()
  const finalFen = fillFenAfter(FEN_INITIAL, moves)
  return recordFromSession({
    title: '对局测试',
    mode: 'humanVsHuman',
    finalFen,
    moves,
    redName: '玩家甲',
    blackName: '玩家乙',
    createdAt: CREATED_AT
  })
}

/** 从初始局面重放 moves 得到终局 FEN（测试辅助，不复用业务代码——对齐 pgn_writer_test.dart finalFenOf） */
function fillFenAfter(initialFen: string, moves: readonly Move[]): string {
  void initialFen // 与 Dart 原版一致：从标准初始盘面构造
  const grid: Array<Array<string | null>> = [
    ['r', 'n', 'b', 'a', 'k', 'a', 'b', 'n', 'r'],
    Array<string | null>(9).fill(null),
    [null, 'c', null, null, null, null, null, 'c', null],
    ['p', null, 'p', null, 'p', null, 'p', null, 'p'],
    Array<string | null>(9).fill(null),
    Array<string | null>(9).fill(null),
    ['P', null, 'P', null, 'P', null, 'P', null, 'P'],
    [null, 'C', null, null, null, null, null, 'C', null],
    Array<string | null>(9).fill(null),
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

/** 残局求解记录（无对局走法，只有解法） */
function endgameRecord(status: GameRecordData['solveStatus'], solutions: string[][]): GameRecordData {
  return {
    title: '残局测试',
    mode: 'endgame',
    initialFen: '3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1',
    moves: [],
    result: null,
    solveStatus: status,
    solutions,
    llmNote: null,
    note: null,
    createdAt: CREATED_AT
  }
}

describe('PgnWriter.writePgn', () => {
  it('标准七标签 + ICCS 着法', () => {
    const pgn = writePgn(sessionRecord(), FIXED_NOW)
    expect(pgn).toContain('[Event "中国象棋 Ultra"]')
    expect(pgn).toContain('[Red "玩家甲"]')
    expect(pgn).toContain('[Black "玩家乙"]')
    expect(pgn).toContain('[Result "*"]')
    expect(pgn).toContain('1. h2e2 h9g7')
    // 标准开局不写 SetFen。
    expect(pgn).not.toContain('[SetFen')
  })

  it('残局记录带 SetFen/FEN 与结果标记', () => {
    const pgn = writePgn(endgameRecord('solved', [['h5h3']]), FIXED_NOW)
    expect(pgn).toContain('[SetFen "3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1"]')
    expect(pgn).toContain('[Result "1-0"]')
    expect(pgn).toContain('[Annotator "已破解"]')
  })

  it('无解残局结果标记为 0-1', () => {
    const pgn = writePgn(endgameRecord('noSolution', []), FIXED_NOW)
    expect(pgn).toContain('[Result "0-1"]')
  })

  it('结果标记分支：对局胜负与和棋', () => {
    expect(pgnResultTag({ ...sessionRecord(), result: 'redWins' })).toBe('1-0')
    expect(pgnResultTag({ ...sessionRecord(), result: 'blackWins' })).toBe('0-1')
    expect(pgnResultTag({ ...sessionRecord(), result: 'draw' })).toBe('1/2-1/2')
    expect(pgnResultTag({ ...endgameRecord('timeout', []), result: null })).toBe('*')
  })

  it('ICCS 着法可被 Iccs 解析还原（导出可往返）', () => {
    const pgn = writePgn(sessionRecord(), FIXED_NOW)
    const body = pgn.split('\n\n')[1] ?? ''
    const tokens = body
      .replaceAll('*', '')
      .replace(/\d+\./g, '')
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0)
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) {
      expect(parseIccs(token)).not.toBeNull()
    }
  })
})

describe('solveVerdictLines（分享文本/详情页结论块）', () => {
  it('多解残局列出全部解法并标注数量', () => {
    const lines = solveVerdictLines(
      endgameRecord('solved', [['h5h3'], ['h5h4'], ['h5g5']])
    )
    expect(lines.join('\n')).toContain('破解之法（3 条）:')
    expect(lines.join('\n')).toContain('解法1: h5h3')
    expect(lines.join('\n')).toContain('解法3: h5g5')
  })

  it('唯一解标注', () => {
    const lines = solveVerdictLines(endgameRecord('solved', [['h5h3']]))
    expect(lines.join('\n')).toContain('破解之法（1 条，唯一解）:')
  })

  it('无解与超时标记', () => {
    expect(solveVerdictLines(endgameRecord('noSolution', [])).join('')).toContain('无解')
    expect(solveVerdictLines(endgameRecord('timeout', [])).join('')).toContain('限时内未找到解法')
  })
})

describe('PGN 导出快照（协议面）', () => {
  it('标准对局导出全文', () => {
    expect(writePgn(sessionRecord(), FIXED_NOW)).toMatchSnapshot()
  })

  it('多解残局导出全文', () => {
    expect(writePgn(endgameRecord('solved', [['h5h3'], ['i4d4']]), FIXED_NOW)).toMatchSnapshot()
  })

  it('中文记谱分享文本（writeShareText 与 PGN 组合断言）', () => {
    const text = writeShareText(sessionRecord())
    expect(text).toContain('【中国象棋 Ultra 棋谱】对局测试')
    expect(text).toContain('双人对弈')
    expect(text).toContain('1. 炮二平五  马8进7')
  })
})
