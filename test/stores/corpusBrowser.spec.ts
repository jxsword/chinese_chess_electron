/** 语料库 store 用例（corpus_browser_vm.dart 等价：筛选排序 + PGN 分页 + generation 防覆盖，06 文档 §6） */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// api 注入：验证分类选择 → 分批解析的渲染层编排

vi.mock('@renderer/ipc/client', () => ({
  api: {
    corpus: {
      scan: vi.fn(() =>
        Promise.resolve({
          root: '/corpus',
          exists: true,
          categories: [
            { name: 'XQF-象棋谱大全', path: '/corpus/xqf', kind: 'xqfDirectory', source: 'XQF-象棋谱大全' },
            { name: 'PGN · big.pgns（多局合一）', path: '/corpus/big.pgns', kind: 'pgnFile', source: 'wxf/ICCS' }
          ]
        })
      ),
      listEntries: vi.fn(() => {
        return Promise.resolve([
          { path: '/corpus/xqf/甲.xqf', category: 'XQF-象棋谱大全', source: '残局/适情雅趣', displayName: '甲' },
          { path: '/corpus/xqf/乙.xqf', category: 'XQF-象棋谱大全', source: '全局', displayName: '乙' }
        ])
      }),
      readFiles: vi.fn((paths: string[]) =>
        Promise.resolve(paths.map((p) => ({ path: p, bytes: new Uint8Array(0) })))
      ),
      pgnIndex: vi.fn(() => Promise.resolve([])),
      readPgnGame: vi.fn(() => Promise.resolve('')),
      pickDirectory: vi.fn(() => Promise.resolve(null))
    },
    store: { get: vi.fn(() => Promise.resolve(null)), set: vi.fn(() => Promise.resolve()) }
  }
}))

// parser 客户端注入：返回按输入顺序的已解析视图
vi.mock('@renderer/workers/parserClient', () => ({
  ParserClient: class {
    async parseBatch(files: Array<{ name: string; source: string }>): Promise<unknown> {
      return {
        puzzles: files.map((f) =>
          f.name.includes('乙')
            ? {
                id: `xqf/${f.source}/乙`,
                initialFen: '4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1',
                solutionMoves: ['h2e2'],
                title: '乙',
                description: null,
                source: f.source,
                format: 'xqf',
                difficulty: 1
              }
            : null
        )
      }
    }
    cancel(): void {}
    dispose(): void {}
  }
}))

import { pgnPageSlice, useCorpusBrowser, visibleItems, type CorpusSortMode } from '@renderer/stores/corpusBrowser'
import type { ParsedPuzzleView } from '@renderer/stores/corpusTypes'
import type { CorpusEntry, PgnIndexEntry } from '@shared/ipc/types'
import { PGN_PAGE_SIZE } from '@renderer/stores/corpusBrowser'

function puzzle(overrides: Partial<ParsedPuzzleView>): ParsedPuzzleView {
  return {
    id: 't',
    initialFen: '4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1',
    solutionMoves: [],
    title: null,
    description: null,
    source: '残局/适情雅趣',
    format: 'xqf',
    difficulty: 1,
    moveCount: 10,
    endgame: true,
    ...overrides
  }
}

const entry = (name: string): CorpusEntry => ({
  path: `/corpus/${name}.xqf`,
  category: 'XQF测试谱',
  source: '残局/适情雅趣',
  displayName: name
})

describe('visibleItems（搜索 + 筛选 + 排序，corpus_browser_vm.dart:71-101）', () => {
  const entries = [entry('丙'), entry('甲'), entry('乙')]
  const puzzles: Array<ParsedPuzzleView | null> = [
    puzzle({ title: '丙局', difficulty: 3, moveCount: 50, endgame: false }),
    puzzle({ title: '甲局', difficulty: 1, moveCount: 10, endgame: true }),
    null // 解析失败条目不可见
  ]

  it('搜索匹配标题，解析失败条目被过滤', () => {
    const items = visibleItems({ entries, puzzles, query: '甲', onlyEndgame: false, difficultyFilter: 0, sortMode: 'name' })
    expect(items).toHaveLength(1)
    expect(items[0].entry.displayName).toBe('甲')
  })

  it('仅看残局 + 难度筛选可叠加', () => {
    const only = visibleItems({ entries, puzzles, query: '', onlyEndgame: true, difficultyFilter: 0, sortMode: 'name' })
    expect(only.map((i) => i.entry.displayName)).toEqual(['甲'])
    const byDiff = visibleItems({ entries, puzzles, query: '', onlyEndgame: false, difficultyFilter: 3, sortMode: 'name' })
    expect(byDiff.map((i) => i.entry.displayName)).toEqual(['丙'])
  })

  it('三种排序：名称 / 步数 / 难度（难度并列按步数）', () => {
    const sort = (mode: CorpusSortMode, ps: Array<ParsedPuzzleView | null>): string[] =>
      visibleItems({ entries, puzzles: ps, query: '', onlyEndgame: false, difficultyFilter: 0, sortMode: mode }).map(
        (i) => i.entry.displayName
      )
    // 名称排序为 UTF-16 码元序（对齐 Dart compareTo）：丙 U+4E19 < 甲 U+7532。
    expect(sort('name', puzzles)).toEqual(['丙', '甲'])
    expect(sort('moves', puzzles)).toEqual(['甲', '丙'])
    expect(sort('difficulty', puzzles)).toEqual(['甲', '丙'])
    // 难度并列时按步数：丙(3,80) vs 甲(3,50)
    const tied: Array<ParsedPuzzleView | null> = [
      puzzle({ difficulty: 3, moveCount: 80 }),
      puzzle({ difficulty: 3, moveCount: 50 })
    ]
    expect(sort('difficulty', tied)).toEqual(['甲', '丙'])
  })
})

describe('pgnPageSlice（PGN 大文件分页，06 §4.4 每页 50）', () => {
  const index: PgnIndexEntry[] = Array.from({ length: 123 }, (_, i) => ({
    offset: i,
    length: 10,
    event: `对局 ${i}`,
    red: `红${i}`,
    black: `黑${i}`
  }))

  it('分页切片与总页数', () => {
    const { slice, totalPages, total } = pgnPageSlice(index, '', 0)
    expect(total).toBe(123)
    expect(totalPages).toBe(3)
    expect(slice).toHaveLength(PGN_PAGE_SIZE)
    expect(slice[0].event).toBe('对局 0')
    const last = pgnPageSlice(index, '', 2)
    expect(last.slice).toHaveLength(23)
  })

  it('搜索过滤后分页与越界页收敛', () => {
    const { total, totalPages } = pgnPageSlice(index, '红1', 0)
    expect(total).toBe(34) // 红1、红10~红19、红100~红122（contains 语义）
    expect(totalPages).toBe(1)
    const clamped = pgnPageSlice(index, '', 99)
    expect(clamped.slice).toHaveLength(23) // 收敛到最后一页
  })
})

describe('语料库 store 集成（分批解析 + generation）', () => {
  beforeEach(() => {
    useCorpusBrowser.setState({
      corpusExists: false,
      corpusPath: '',
      categories: [],
      selectedCategory: -1,
      entries: [],
      puzzles: [],
      progress: -1,
      pgnPath: null
    })
  })

  it('load → selectCategory(0)：解析结果回填，进度收尾为 -1', async () => {
    await useCorpusBrowser.getState().load()
    const state = useCorpusBrowser.getState()
    expect(state.corpusExists).toBe(true)
    expect(state.selectedCategory).toBe(0)
    expect(state.puzzles).toHaveLength(2)
    expect(state.puzzles[0]).toBeNull() // 甲：worker 返回 null
    expect(state.puzzles[1]?.title).toBe('乙')
    expect(state.puzzles[1]?.endgame).toBe(false) // 来源"全局"关键词 → 全局对局
    expect(state.progress).toBe(-1)
  })

  it('PGN 分类不批量解析，openPgnCategory 建立索引视图', async () => {
    await useCorpusBrowser.getState().load()
    await useCorpusBrowser.getState().openPgnCategory(1)
    const state = useCorpusBrowser.getState()
    expect(state.pgnPath).toBe('/corpus/big.pgns')
    expect(state.selectedCategory).toBe(1)
  })
})
