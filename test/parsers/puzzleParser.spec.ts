/** 解析门面等价用例集（test/features/puzzle/model/puzzle_parser_test.dart 7 条，06 文档 §4.5） */
import { describe, expect, it } from 'vitest'
import {
  parsePuzzleFile,
  shouldStreamImport
} from '@packages/parsers/puzzleParser'
import { buildXqf } from '../helpers/xqfBuilder'

const encoder = new TextEncoder()
const bytesOf = (text: string): Uint8Array => encoder.encode(text)

describe('PuzzleParser（门面）', () => {
  it('按扩展名分发：.pgn 走 PGN 解析', () => {
    const puzzles = parsePuzzleFile('对局.pgn', bytesOf('1. 炮二平五 马8进7\n'), '测试')
    expect(puzzles).toHaveLength(1)
    expect(puzzles[0].solutionMoves).toEqual(['h2e2', 'h9g7'])
    expect(puzzles[0].format).toBe('pgn')
  })

  it('.pgns 扩展名同样分发到 PGN 解析', () => {
    const puzzles = parsePuzzleFile('合集.pgns', bytesOf('1. 兵七进一 卒7进1\n'), '测试')
    expect(puzzles).toHaveLength(1)
    expect(puzzles[0].solutionMoves[0]).toBe('c3c4')
  })

  it('不认识的扩展名抛异常', () => {
    expect(() => parsePuzzleFile('棋局.cbf', bytesOf(''), '测试')).toThrow(/不支持的棋谱格式/)
  })

  it('非法着被重放校验截断，保留合法前缀', () => {
    // "炮二平五 马8进7 h1h9" 前两着合法；追加一着故意非法的 ICCS（起点无子）触发截断。
    const puzzles = parsePuzzleFile('截断.pgn', bytesOf('1. 炮二平五 马8进7 h1h9\n'), '测试')
    expect(puzzles).toHaveLength(1)
    expect(puzzles[0].solutionMoves).toEqual(['h2e2', 'h9g7'])
  })

  it('全部着法非法时丢弃该局', () => {
    const puzzles = parsePuzzleFile('空.pgn', bytesOf('1. 马九进九\n'), '测试')
    expect(puzzles).toHaveLength(0)
  })

  it('重复 id 自动去重', () => {
    const one = '1. 炮二平五 马8进7\n'
    const multi = `[Event "同一标题"]\n\n${one}[Event "同一标题"]\n\n${one}`
    const puzzles = parsePuzzleFile('重复.pgn', bytesOf(multi), '测试')
    expect(puzzles).toHaveLength(2)
    expect(puzzles[0].id === puzzles[1].id).toBe(false)
    expect(puzzles[1].id.startsWith(puzzles[0].id)).toBe(true)
  })

  it('.xqf 扩展名分发到 XQF 解析（含重放校验）', () => {
    const bytes = buildXqf({
      version: 0x0a,
      fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
      moves: ['h2e2', 'h9g7', 'i0i9zz' as string].slice(0, 2)
    })
    const puzzles = parsePuzzleFile('残局.xqf', bytes, '测试')
    expect(puzzles).toHaveLength(1)
    expect(puzzles[0].format).toBe('xqf')
    expect(puzzles[0].solutionMoves).toEqual(['h2e2', 'h9g7'])
    expect(puzzles[0].id.startsWith('xqf/测试/')).toBe(true)
  })
})

describe('大文件流式导入判定', () => {
  it('多局 PGN 大文件走流式路径，其余走整读', () => {
    const mb = 1024 * 1024
    expect(shouldStreamImport('合集.pgns', 9 * mb)).toBe(true)
    expect(shouldStreamImport('对局.pgn', 9 * mb)).toBe(true)
    expect(shouldStreamImport('合集.pgns', 8 * mb)).toBe(false) // 等于阈值不流式
    expect(shouldStreamImport('对局.pgn', 1024)).toBe(false)
    expect(shouldStreamImport('残局.xqf', 9 * mb)).toBe(false) // XQF 单文件不大，始终整读
  })
})
