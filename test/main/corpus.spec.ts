/** 语料服务等价用例集（test/features/puzzle/model/corpus_scanner_test.dart 临时目录部分 + 路径优先级，06 文档 §1） */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  displayNameOf,
  listXqfEntries,
  readCorpusFiles,
  resolveCorpusDir,
  scanCorpus,
  scanPgnIndex,
  readPgnGameText
} from '@main/services/corpus'

const dirs: string[] = []
const makeTemp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'corpus_test_'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('语料扫描（临时目录）', () => {
  it('scanCategories 忽略 _ref、按一级子目录聚合', () => {
    const tmp = makeTemp()
    // 构造: XQF测试谱/残局/适情雅趣/a.xqf, XQF测试谱/全局/子/b.xqf, _ref/c.xqf
    const d1 = join(tmp, 'XQF测试谱', '残局', '适情雅趣')
    mkdirSync(d1, { recursive: true })
    writeFileSync(join(d1, 'a.xqf'), Buffer.alloc(1100))
    const d2 = join(tmp, 'XQF测试谱', '全局', '子')
    mkdirSync(d2, { recursive: true })
    writeFileSync(join(d2, 'b.XQF'), '')
    mkdirSync(join(tmp, '_ref'))
    writeFileSync(join(tmp, '_ref', 'c.xqf'), '')

    const scan = scanCorpus(tmp)
    expect(scan.exists).toBe(true)
    expect(scan.categories.map((c) => c.name)).toEqual(['XQF测试谱'])
    expect(scan.categories[0].kind).toBe('xqfDirectory')
    expect(scan.categories[0].source).toBe('XQF测试谱')
  })

  it('listXqfEntries 递归列出并按名称排序，source 取子分类', () => {
    const tmp = makeTemp()
    const d1 = join(tmp, 'XQF测试谱', '残局', '适情雅趣')
    mkdirSync(d1, { recursive: true })
    writeFileSync(join(d1, 'a.xqf'), '')
    const d2 = join(tmp, 'XQF测试谱', '全局', '子')
    mkdirSync(d2, { recursive: true })
    writeFileSync(join(d2, 'b.XQF'), '')

    const scan = scanCorpus(tmp)
    const entries = listXqfEntries(scan.categories[0].path, scan.categories[0].name)
    expect(entries.map((e) => e.displayName)).toEqual(['a', 'b'])
    expect(entries[0].source).toBe(`残局${sep}适情雅趣`.split(sep).join('/'))
    expect(entries[1].source).toBe('全局/子')
  })

  it('ChessQ 的 gamebooks 通用目录层不出现在 source 中', () => {
    const tmp = makeTemp()
    const d1 = join(tmp, 'ChessQ-gamebooks', 'gamebooks', '杀势集')
    mkdirSync(d1, { recursive: true })
    writeFileSync(join(d1, 'endgame1.xqf'), '')
    const scan = scanCorpus(tmp)
    const entries = listXqfEntries(scan.categories[0].path, scan.categories[0].name)
    expect(entries[0].source).toBe('杀势集')
  })

  it('CGLemon-PGN 下的 .pgn/.pgns 每文件一分类，source 取前两级', () => {
    const tmp = makeTemp()
    const d1 = join(tmp, 'CGLemon-PGN', 'wxf', 'ICCS')
    mkdirSync(d1, { recursive: true })
    writeFileSync(join(d1, 'wxf-big.pgns'), '')
    writeFileSync(join(d1, 'other.txt'), '')
    const scan = scanCorpus(tmp)
    expect(scan.categories).toHaveLength(1)
    expect(scan.categories[0].kind).toBe('pgnFile')
    expect(scan.categories[0].name).toBe('PGN · wxf-big.pgns（多局合一）')
    expect(scan.categories[0].source).toBe('wxf/ICCS')
  })

  it('空目录 / 不存在的目录返回空', () => {
    const tmp = makeTemp()
    const scan = scanCorpus(join(tmp, '不存在'))
    expect(scan.exists).toBe(false)
    expect(scan.categories).toEqual([])
  })

  it('目录存在但为空：exists=true 且分类为空', () => {
    const tmp = makeTemp()
    const scan = scanCorpus(tmp)
    expect(scan.exists).toBe(true)
    expect(scan.categories).toEqual([])
  })

  it('displayNameOf：去扩展名；无扩展名/点开头原样', () => {
    expect(displayNameOf(`/a/b${sep}适情雅趣 第1局.xqf`)).toBe('适情雅趣 第1局')
    expect(displayNameOf(`/a/b${sep}README`)).toBe('README')
    expect(displayNameOf(`/a/b${sep}.hidden.xqf`)).toBe('.hidden')
  })
})

describe('语料目录优先级（corpus_paths.dart:150-172）', () => {
  it('用户设置 > legacy 相对目录 > 平台默认', () => {
    const docs = makeTemp()
    const legacyBase = makeTemp()
    mkdirSync(join(legacyBase, 'corpus'))
    // 1. 用户设置优先
    expect(
      resolveCorpusDir({ userSetting: ' /tmp/my-corpus ', documentsPath: docs, legacyBasePath: legacyBase })
    ).toBe('/tmp/my-corpus')
    // 2. legacy 相对目录存在则沿用
    expect(resolveCorpusDir({ userSetting: '', documentsPath: docs, legacyBasePath: legacyBase })).toBe(
      join(legacyBase, 'corpus')
    )
    // 3. 平台默认 <documents>/ChineseChessUltra/corpus
    expect(resolveCorpusDir({ userSetting: null, documentsPath: docs, legacyBasePath: join(docs, 'nope') })).toBe(
      join(docs, 'ChineseChessUltra', 'corpus')
    )
  })
})

describe('批量读取与 PGN 大文件', () => {
  it('readCorpusFiles：只读棋谱扩展名，缺失文件跳过', () => {
    const tmp = makeTemp()
    const a = join(tmp, 'a.xqf')
    writeFileSync(a, Buffer.from([1, 2, 3]))
    writeFileSync(join(tmp, 'b.txt'), 'nope')
    const files = readCorpusFiles([a, join(tmp, 'b.txt'), join(tmp, 'missing.xqf')])
    expect(files).toHaveLength(1)
    expect(Array.from(files[0].bytes)).toEqual([1, 2, 3])
  })

  it('scanPgnIndex + readPgnGameText：临时 PGN 索引与单局读取', () => {
    const tmp = makeTemp()
    const pgn = join(tmp, 'multi.pgn')
    writeFileSync(
      pgn,
      `[Event "甲局"]\n[Red "红甲"]\n\n1. 炮二平五 马8进7\n\n[Event "乙局"]\n[Red "红乙"]\n\n1. 兵七进一 卒7进1\n`,
      'utf8'
    )
    const index = scanPgnIndex(pgn)
    expect(index).toHaveLength(2)
    expect(index[0].event).toBe('甲局')
    expect(index[1].red).toBe('红乙')

    const game2 = readPgnGameText(pgn, index[1])
    expect(game2).toContain('乙局')
    expect(game2).toContain('兵七进一')
  })
})
