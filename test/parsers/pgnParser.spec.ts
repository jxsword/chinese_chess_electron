/** PGN 解析等价用例集（test/features/puzzle/model/parsers/pgn_parser_test.dart 12 条，06 文档 §4） */
import { mkdtempSync, rmSync, writeFileSync, openSync, readSync, fstatSync, closeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseGame,
  parseGames,
  scanGameOffsets,
  type PgnFileSource
} from '@packages/parsers/pgnParser'

const initialFen =
  'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

/** fs 文件源（与主进程 corpus 服务同一形态的测试替身）。
 * 打开的 fd 登记进 openFds，由 afterEach 统一关闭——泄漏的 fd 会让
 * Windows 的 rmSync 报 ENOTEMPTY（Linux 无此问题，属平台差异）。 */
const openFds: number[] = []
function fsSource(path: string): PgnFileSource {
  const fd = openSync(path, 'r')
  openFds.push(fd)
  const size = fstatSync(fd).size
  return {
    byteLength: size,
    read(offset, length) {
      if (offset >= size) return new Uint8Array(0)
      const buf = Buffer.alloc(Math.min(length, size - offset))
      readSync(fd, buf, 0, buf.length, offset)
      return new Uint8Array(buf)
    }
  }
}

describe('单局解析', () => {
  it('标准初始局面 + 中文纵线记谱（无 FEN 标签）', () => {
    const text = `[Event "测试局"]
[Red "红方"]
[Black "黑方"]

1. 炮二平五  马8进7
2. 马二进三  车9平8
*`
    const puzzle = parseGame(text, '测试')
    expect(puzzle.initialFen).toBe(initialFen)
    expect(puzzle.solutionMoves).toEqual(['h2e2', 'h9g7', 'h0g2', 'i9h9'])
    expect(puzzle.title).toBe('测试局')
    expect(puzzle.format).toBe('pgn')
    expect(puzzle.difficulty).toBe(1)
  })

  it('ICCS 记谱 + FEN 标签', () => {
    const text = `[FEN "${initialFen}"]

1. C3-C4 C9-E7
2. B2-D2 G6-G5
`
    const puzzle = parseGame(text)
    expect(puzzle.solutionMoves).toEqual(['c3c4', 'c9e7', 'b2d2', 'g6g5'])
  })

  it('注释、行注释、变着、NAG 与步数序号被跳过', () => {
    const text = `1. 炮二平五 {好棋; 得中路} 马8进7 ; 行注释到行尾
2. 马二进三 (2. 卒3进1 3. 兵三进一) 车9平8 $1
3. 车一平二
`
    const puzzle = parseGame(text)
    expect(puzzle.solutionMoves).toEqual(['h2e2', 'h9g7', 'h0g2', 'i9h9', 'i0h0'])
  })

  it('全角数字（部分生成器黑方记谱）可解析', () => {
    const text = `1. 兵七进一  象３进５
2. 炮八平六  卒７进１
`
    const puzzle = parseGame(text)
    // 兵七进一 c3c4；象3进5 c9e7；炮八平六 b2d2；卒7进1 g6g5
    expect(puzzle.solutionMoves).toEqual(['c3c4', 'c9e7', 'b2d2', 'g6g5'])
  })

  it('前/后修饰消解同列多子', () => {
    // 红方双炮同在五路（col 4），红方"前"为 row 较小者。
    const fen = '4k4/9/9/9/9/9/4C4/9/4C4/4K4 w - - 0 1'
    const text = `[FEN "${fen}"]

1. 前炮进二
`
    const puzzle = parseGame(text)
    // 前炮 (4,6)=e3，直进两格 → (4,4)=e5
    expect(puzzle.solutionMoves).toEqual(['e3e5'])
  })

  it('着法无法消解时抛 FormatException', () => {
    // 兵不可以在同一路平移五格。
    const text = '1. 兵九平五\n'
    expect(() => parseGame(text)).toThrow()
  })

  it('无任何着法时抛 FormatException', () => {
    expect(() => parseGame('[Event "空局"]\n*')).toThrow()
  })
})

describe('多局切分', () => {
  it('两局文本切分为两局', () => {
    const text = `[Event "第一局"]

1. 炮二平五 马8进7

[Event "第二局"]

1. 兵七进一 卒7进1
`
    const games = parseGames(text)
    expect(games).toHaveLength(2)
    expect(games[0].title).toBe('第一局')
    expect(games[1].title).toBe('第二局')
    expect(games[1].solutionMoves[0]).toBe('c3c4')
  })

  it('单局解析失败不影响其余棋局', () => {
    const text = `[Event "坏局"]

1. 马九进九

[Event "好局"]

1. 炮二平五 马8进7
`
    const games = parseGames(text)
    expect(games).toHaveLength(1)
    expect(games[0].title).toBe('好局')
  })
})

describe('大文件按局索引', () => {
  const dirs: string[] = []
  const makeTempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'pgn_index_test_'))
    dirs.push(dir)
    return dir
  }
  afterEach(async () => {
    // 先关 fd 再删目录：Windows 句柄未关时 rmSync 偶发 ENOTEMPTY（AV/索引器
    // 短暂持句），再带退避重试兜底。
    for (const fd of openFds.splice(0)) {
      try {
        closeSync(fd)
      } catch {
        // 已关闭
      }
    }
    for (const d of dirs.splice(0)) {
      for (let attempt = 0; ; attempt++) {
        try {
          rmSync(d, { recursive: true, force: true })
          break
        } catch (e) {
          if (attempt >= 5 || (e as NodeJS.ErrnoException)?.code !== 'ENOTEMPTY') throw e
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
        }
      }
    }
  })

  function writeFixture(name: string, content: string): string {
    const dir = makeTempDir()
    const p = join(dir, name)
    writeFileSync(p, content, 'utf8')
    return p
  }

  it('扫描偏移索引并按需读取单局', () => {
    const pgnFile = writeFixture(
      'multi.pgn',
      `[Event "甲局"]
[Red "红甲"]
[Black "黑甲"]

1. 炮二平五 马8进7
2. 马二进三 车9平8

[Event "乙局"]
[Red "红乙"]
[Black "黑乙"]

1. 兵七进一 卒7进1
`
    )
    const source = fsSource(pgnFile)
    const index = scanGameOffsets(source)
    expect(index).toHaveLength(2)
    expect(index[0].event).toBe('甲局')
    expect(index[1].event).toBe('乙局')
    expect(index[1].red).toBe('红乙')

    const readSlice = (i: number): string => {
      const fd = openSync(pgnFile, 'r')
      const buf = Buffer.alloc(index[i].length)
      readSync(fd, buf, 0, index[i].length, index[i].offset)
      closeSync(fd)
      return new TextDecoder('utf-8').decode(buf)
    }
    const game1 = readSlice(0)
    expect(parseGame(game1).solutionMoves).toHaveLength(4)

    const game2 = readSlice(1)
    const parsed2 = parseGame(game2)
    expect(parsed2.solutionMoves[0]).toBe('c3c4')
    expect(parsed2.title).toBe('乙局')
  })

  it('maxGames 限制扫描数量', () => {
    const pgnFile = writeFixture(
      'multi.pgn',
      `[Event "甲局"]

1. 炮二平五 马8进7

[Event "乙局"]

1. 兵七进一 卒7进1
`
    )
    const index = scanGameOffsets(fsSource(pgnFile), 1)
    expect(index).toHaveLength(1)
  })

  it('超长行按 moves 行处理，pending 不再无限累积（P2-5）', () => {
    // 9MB 无换行的单行畸形文件（超过 8MB 阈值）+ 一个正常局。
    const dir = makeTempDir()
    const longFile = join(dir, 'long.pgn')
    writeFileSync(
      longFile,
      `${'a'.repeat(9 << 20)}\n[Event "超长行后的一局"]\n[Red "红"]\n\n1. 炮二平五\n`,
      'utf8'
    )

    const index = scanGameOffsets(fsSource(longFile))

    // 超长行被计为 moves 行（gameStart=0），随后标签行开启第二局。
    expect(index).toHaveLength(2)
    expect(index[0].offset).toBe(0)
    expect(index[1].event).toBe('超长行后的一局')
    expect(index[1].red).toBe('红')
  })

  it('99813 局大文件索引 + 分页切片（验收基准）', () => {
    // 生成 99813 局单行紧凑 PGN（每局约 120 字节，文件约 12MB）。
    const dir = makeTempDir()
    const bigFile = join(dir, 'big.pgns')
    const games: string[] = []
    for (let i = 0; i < 99813; i++) {
      games.push(`[Event "对局 ${i}"]\n[Red "红${i}"]\n[Black "黑${i}"]\n\n1. 炮二平五 马8进7\n2. 马二进三 车9平8\n`)
    }
    writeFileSync(bigFile, games.join('\n'), 'utf8')

    const index = scanGameOffsets(fsSource(bigFile))
    expect(index).toHaveLength(99813)
    expect(index[99812].event).toBe('对局 99812')

    // 分页浏览：每页 50，第 1000 页切片可正常解析。
    const pageSize = 50
    const page1000 = index.slice(999 * pageSize, 1000 * pageSize)
    expect(page1000).toHaveLength(50)
    expect(page1000[0].event).toBe('对局 49950')
  })
})
