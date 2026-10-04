/**
 * MoveAnnotation 用例（T4.2，09 §2 move_annotation 6 用例；move_annotation.dart 1:1）。
 */
import { describe, it, expect } from 'vitest'
import { Board } from '@packages/rules'
import { annotateMove, annotatedWithBucket, asciiBoard, scoreBucket } from '@packages/llm'

const mv = (code: string) => {
  const [f, t] = code.split('-')
  return {
    from: { col: f!.charCodeAt(0) - 97, row: Number(f![1]) },
    to: { col: t!.charCodeAt(0) - 97, row: Number(t![1]) }
  }
}

describe('annotateMove（b2-e2(中文记法,吃X,将军)）', () => {
  it('吃子注解：车吃卒（被吃子取棋盘实际局面）', () => {
    const board = Board.fromFen('4k4/9/9/9/9/p8/9/9/9/R2K5 w - - 0 1')
    expect(annotateMove(board, mv('a9-a5'))).toBe('a9-a5(车九进四,吃卒)')
  })

  it('将军注解：走后对方被将军（probe 用走后轮走方判定）', () => {
    const board = Board.fromFen('4k4/9/9/9/9/9/9/9/9/3K4R w - - 0 1')
    expect(annotateMove(board, mv('i9-i0'))).toBe('i9-i0(车一进九,将军)')
  })

  it('无吃无将：仅中文记法', () => {
    const board = Board.fromFen('4k4/9/9/9/9/9/9/9/9/3KN4 w - - 0 1')
    expect(annotateMove(board, mv('e9-g8'))).toBe('e9-g8(马五进三)')
  })

  it('起点无棋子退化为纯坐标', () => {
    const board = Board.fromFen('4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1')
    expect(annotateMove(board, mv('a4-a5'))).toBe('a4-a5')
  })
})

describe('scoreBucket（≤30/≤100/≤250/≤600/否则）', () => {
  it('边界值五档', () => {
    expect(scoreBucket(0)).toBe('最佳/均势')
    expect(scoreBucket(30)).toBe('最佳/均势')
    expect(scoreBucket(31)).toBe('略亏')
    expect(scoreBucket(100)).toBe('略亏')
    expect(scoreBucket(101)).toBe('明显亏（约半子）')
    expect(scoreBucket(250)).toBe('明显亏（约半子）')
    expect(scoreBucket(251)).toBe('大亏（丢一马/一炮级）')
    expect(scoreBucket(600)).toBe('大亏（丢一马/一炮级）')
    expect(scoreBucket(601)).toBe('致命（丢车/被将杀级）')
  })

  it('负数（超出最佳的收益）归入最佳/均势', () => {
    expect(scoreBucket(-50)).toBe('最佳/均势')
  })
})

describe('annotatedWithBucket（候选清单行格式）', () => {
  it('`注解 — 分档` 用「 — 」连接', () => {
    const board = Board.fromFen('4k4/9/9/9/9/p8/9/9/9/R2K5 w - - 0 1')
    expect(annotatedWithBucket(board, mv('a9-a5'), 300)).toBe(
      'a9-a5(车九进四,吃卒) — 大亏（丢一马/一炮级）'
    )
  })
})

describe('asciiBoard（10 行，大写红/小写黑，. 为空）', () => {
  it('初始局面全字快照', () => {
    expect(asciiBoard(Board.initial())).toBe(
      '    a b c d e f g h i\n' +
        '0  r n b a k a b n r\n' +
        '1  . . . . . . . . .\n' +
        '2  . c . . . . . c .\n' +
        '3  p . p . p . p . p\n' +
        '4  . . . . . . . . .\n' +
        '5  . . . . . . . . .\n' +
        '6  P . P . P . P . P\n' +
        '7  . C . . . . . C .\n' +
        '8  . . . . . . . . .\n' +
        '9  R N B A K A B N R\n'
    )
  })
})
