import { describe, it, expect } from 'vitest'
import { writeShareText } from '@packages/storage-schema'
import { recordFromSession, type GameRecordData } from '@packages/storage-schema'
import { pos } from '@packages/rules'

// 协议面快照测试（开发规范：分享文本属"协议面"，改动必须显式 review 快照 diff）。
// 1:1 对齐 pgn_writer.dart writeShareText（53-97 行）。

const FEN_START = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

describe('writeShareText 快照（pgn_writer.dart:53-97）', () => {
  it('对局类：标题/模式/结果/中文记谱两列', () => {
    const moves = [
      { from: pos(7, 7), to: pos(4, 7), piece: { kind: 'cannon' as const, side: 'red' as const } },
      { from: pos(7, 0), to: pos(6, 2), piece: { kind: 'knight' as const, side: 'black' as const } }
    ]
    const record = recordFromSession({
      mode: 'humanVsHuman',
      finalFen: FEN_START,
      moves: [],
      title: '示例对局'
    })
    record.moves = moves
    record.result = 'redWins'
    expect(writeShareText(record)).toMatchSnapshot()
  })

  it('残局类：起始 FEN/解法/唯一解标注/llmNote/备注', () => {
    const record: GameRecordData = {
      title: '双车残局',
      mode: 'endgame',
      initialFen: '3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1',
      moves: [],
      result: null,
      solveStatus: 'solved',
      solutions: [['h5h3'], ['h5h4', 'h0g2']],
      llmNote: '大模型首选 h5h3（已验证为必胜着法）',
      note: '经典双车残局',
      createdAt: null
    }
    expect(writeShareText(record)).toMatchSnapshot()
  })

  it('无解/超时的求解结论行', () => {
    const base: GameRecordData = {
      title: '无解局',
      mode: 'endgame',
      initialFen: '4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1',
      moves: [],
      result: null,
      solveStatus: 'noSolution',
      solutions: [],
      createdAt: null
    }
    expect(writeShareText(base)).toMatchSnapshot()
    expect(writeShareText({ ...base, solveStatus: 'timeout' })).toMatchSnapshot()
  })

  it('标准开局 FEN 不输出起始 FEN 行（isInitialBoardFen）', () => {
    const record: GameRecordData = {
      title: 't',
      mode: 'humanVsAi',
      initialFen: FEN_START,
      moves: [],
      result: null,
      solveStatus: 'none',
      solutions: [],
      createdAt: null
    }
    expect(writeShareText(record)).not.toContain('起始 FEN')
  })
})
