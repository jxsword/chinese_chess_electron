/** XQF 解析等价用例集（test/features/puzzle/model/parsers/xqf_parser_test.dart 等价，06 文档 §3） */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { XQF_HEADER_SIZE, parseXqf } from '@packages/parsers/xqfParser'
import { parseIccs } from '@packages/parsers/iccs'
import { Board, FEN_INITIAL } from '@packages/rules'
import { buildXqf } from '../helpers/xqfBuilder'

/** 语料联接缺失时的真实格式锚点：仓库自带样例（v0x0D，位置置换加密）。 */
const sampleBytes = (): Uint8Array => new Uint8Array(readFileSync(join(__dirname, '../fixtures/sample_xqf.xqf')))

/** 用规则内核重放走法，返回成功应用的手数（xqf_parser_test.dart 重放校验同款）。 */
function replayApplied(initialFen: string, moves: string[]): number {
  const board = Board.fromFen(initialFen)
  let applied = 0
  for (const iccs of moves) {
    const p = parseIccs(iccs)
    if (p === null) break
    const legal = board
      .legalMovesFor(p.from)
      .some((m) => m.from.col === p.from.col && m.from.row === p.from.row && m.to.col === p.to.col && m.to.row === p.to.row)
    if (!legal) break
    board.applyMove({ from: p.from, to: p.to })
    applied += 1
  }
  return applied
}

describe('XqfParser', () => {
  it('坏魔数抛 FormatException', () => {
    const bad = new Uint8Array(1100).fill(0)
    bad[0] = 0x58
    bad[1] = 0x58
    bad[2] = 0x0a
    expect(() => parseXqf(bad)).toThrow()
  })

  it('文件过短抛 FormatException', () => {
    expect(() => parseXqf(new Uint8Array([0x58, 0x51, 0x0a, 1, 2, 3]))).toThrow()
  })

  it('缺将帅抛 FormatException', () => {
    // 无黑将（k 缺失）的 FEN 构造 v0x0A 文件。
    const bytes = buildXqf({
      version: 0x0a,
      fen: 'rnba1abnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
      moves: ['h2e2']
    })
    expect(() => parseXqf(bytes)).toThrow(/缺少将\/帅/)
  })

  it('真语料样例（v0x0D，位置置换加密）：FEN/元数据/全量重放合法', () => {
    const puzzle = parseXqf(sampleBytes(), '样例')
    expect(puzzle.format).toBe('xqf')
    expect(puzzle.title).toBe('挺兵对卒底炮')
    expect(puzzle.description).toContain('96全国象棋锦标赛')
    expect(puzzle.description).toContain('1996.5.20')
    expect(puzzle.initialFen).toBe(FEN_INITIAL)
    expect(puzzle.solutionMoves.length).toBe(77)
    expect(puzzle.solutionMoves.slice(0, 5)).toEqual(['c3c4', 'b7c7', 'h2e2', 'c9e7', 'h0g2'])
    expect(puzzle.difficulty).toBe(3)
    // 全部走法在规则内核上重放合法（真实加密格式的金标准锚点）。
    expect(replayApplied(puzzle.initialFen, puzzle.solutionMoves)).toBe(77)
  })

  it('往返：旧格式 v0x0A（无加密）', () => {
    const moves = ['h2e2', 'h9g7', 'h0g2', 'i9h9', 'c3c4', 'c6c5']
    const bytes = buildXqf({
      version: 0x0a,
      fen: FEN_INITIAL,
      moves,
      title: '中炮对屏风马',
      event: '测试赛事',
      date: '2024.1.1',
      red: '红方选手',
      black: '黑方选手'
    })
    const puzzle = parseXqf(bytes, '往返')
    expect(puzzle.initialFen).toBe(FEN_INITIAL)
    expect(puzzle.solutionMoves).toEqual(moves)
    expect(puzzle.title).toBe('中炮对屏风马')
    expect(puzzle.description).toBe('测试赛事 · 2024.1.1 · 红方选手 vs 黑方选手')
    expect(puzzle.source).toBe('往返')
  })

  it('往返：加密版本 v0x0C（无布局置换）', () => {
    const moves = ['c3c4', 'b7c7', 'h2e2']
    const bytes = buildXqf({ version: 0x0c, fen: FEN_INITIAL, moves, title: '加密局' })
    const puzzle = parseXqf(bytes)
    expect(puzzle.initialFen).toBe(FEN_INITIAL)
    expect(puzzle.solutionMoves).toEqual(moves)
    expect(puzzle.title).toBe('加密局')
  })

  it('往返：高版本 v0x12（布局位置置换）+ 让子盘面', () => {
    // 红让左车（a 路车缺失）： 0xFF 让子路径。
    const fen = 'rnbakabn1/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'
    const moves = ['h2e2', 'h9g7']
    const bytes = buildXqf({ version: 0x12, fen, moves, title: '让车局' })
    const puzzle = parseXqf(bytes)
    expect(puzzle.initialFen).toBe(fen)
    expect(puzzle.solutionMoves).toEqual(moves)
    expect(puzzle.title).toBe('让车局')
  })

  it('往返：残局盘面 + 黑先行棋方推断', () => {
    // 首着起点为黑子 → isRedTurn=false（xqf_parser.dart:133-140）。
    const fen = '3k5/9/9/9/9/9/9/9/9/4K4 b - - 0 1'
    const moves = ['d9e8']
    const bytes = buildXqf({ version: 0x0b, fen, moves })
    const puzzle = parseXqf(bytes)
    expect(puzzle.initialFen).toBe(fen)
    expect(puzzle.solutionMoves).toEqual(moves)
  })

  it('文件头大小常量为 0x400', () => {
    expect(XQF_HEADER_SIZE).toBe(0x400)
  })
})
