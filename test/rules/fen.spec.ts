/** FEN 编解码测试（对齐原版 fen_test.dart 5 用例 + 02 §1.4 异常契约）。 */
import { describe, expect, it } from 'vitest'
import {
  FEN_INITIAL,
  FenFormatError,
  boardGridToFen,
  isValidFen,
  parseBoardFen,
  parseTurnFen
} from '@packages/rules'

describe('Fen', () => {
  it('initial FEN 应通过校验', () => {
    expect(isValidFen(FEN_INITIAL)).toBe(true)
  })

  it('空字符串、错误列数、错误字符均不通过校验', () => {
    expect(isValidFen('')).toBe(false)
    expect(isValidFen('9/9/9/9/9/9/9/9/9/9 w - - 0 1')).toBe(true)
    expect(isValidFen('9/9/9/9/9/9/9/9/9/8 w - - 0 1')).toBe(false)
    expect(isValidFen('xxxxxxxxx/9/9/9/9/9/9/9/9/9 w - - 0 1')).toBe(false)
    // 行数不对（只有 9 行）。
    expect(isValidFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/9/9/9 w - - 0 1')).toBe(false)
  })

  it('parseBoard 与 boardToFen 互逆', () => {
    const grid = parseBoardFen(FEN_INITIAL)
    const fen = boardGridToFen(grid)
    expect(fen).toBe(FEN_INITIAL.split(' ')[0])
  })

  it('parseBoard 解析初始局面：红车在右下角（row=9, col=0/8）', () => {
    const grid = parseBoardFen(FEN_INITIAL)
    expect(grid[9][0]?.kind).toBe('rook')
    expect(grid[9][0]?.side).toBe('red')
    expect(grid[0][0]?.kind).toBe('rook')
    expect(grid[0][0]?.side).toBe('black')
  })

  it('parseTurn 红方先行', () => {
    expect(parseTurnFen(FEN_INITIAL)).toBe(true)
    expect(parseTurnFen('9/9/9/9/9/9/9/9/9/9 b - - 0 1')).toBe(false)
  })

  it('parseBoard 对行数错/行长≠9/非法字符抛 FormatException 等价异常（02 §1.4）', () => {
    expect(() => parseBoardFen('9/9/9/9/9/9/9/9/9 w - - 0 1')).toThrow(FenFormatError)
    expect(() => parseBoardFen('9/9/9/9/9/9/9/9/8 w - - 0 1')).toThrow(FenFormatError)
    expect(() => parseBoardFen('xxxxxxxxx/9/9/9/9/9/9/9/9/9 w - - 0 1')).toThrow(
      FenFormatError
    )
  })
})
