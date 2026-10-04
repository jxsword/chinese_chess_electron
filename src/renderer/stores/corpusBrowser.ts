/**
 * 语料库浏览 store（对应 corpus_browser_vm.dart，06 文档 §6）。
 *
 * 职责：扫描语料分类、按分类懒解析 XQF 文件（worker 分批 128 + 进度）、
 * PGN 大文件按局索引分页浏览（每页 50）、搜索/难度筛选/排序。
 * generation 计数防旧任务覆盖新分类状态（corpus_browser_vm.dart:141 对齐 _generation）。
 * 应用级数据（非对局状态），允许单例；对局状态仍必须走 createGameStore 工厂（铁律 #6）。
 */
import { create } from 'zustand'
import { api } from '@renderer/ipc/client'
import { ParserClient } from '@renderer/workers/parserClient'
import { isEndgamePuzzle, type ParsedPuzzle } from '@packages/parsers'
import type { CorpusCategory, CorpusEntry, CorpusFileBytes, PgnIndexEntry } from '@shared/ipc/types'
import type { ParsedPuzzleView } from './corpusTypes'

/** 列表排序方式（corpus_browser_vm.dart:16）。 */
export type CorpusSortMode = 'name' | 'moves' | 'difficulty'

/** PGN 大文件分页大小（06 文档 §4.4：渲染层分页列表每页 50）。 */
export const PGN_PAGE_SIZE = 50

/** 批量解析分批大小（06 文档 §6：每批 128 个文件）。 */
export const PARSE_BATCH_SIZE = 128

interface CorpusBrowserState {
  /** 语料目录是否存在（不存在/为空时展示下载引导）。 */
  corpusExists: boolean
  /** 解析后的语料目录绝对路径（缺失引导展示/下载用）。 */
  corpusPath: string
  categories: CorpusCategory[]
  /** 当前选中的分类下标；-1 = 未选择。 */
  selectedCategory: number
  /** 当前 XQF 分类的文件条目（与 puzzles 对齐）。 */
  entries: CorpusEntry[]
  /** 与 entries 对齐的解析结果（解析中/失败为 null）。 */
  puzzles: Array<ParsedPuzzleView | null>
  /** 批量解析进度（0.0-1.0）；-1 表示不在解析中。 */
  progress: number
  query: string
  /** 仅显示残局/排局题（区别于全局对局）。 */
  onlyEndgame: boolean
  /** 难度筛选（1-5）；0 = 全部。 */
  difficultyFilter: number
  sortMode: CorpusSortMode
  // ---- PGN 大文件浏览态 ----
  /** 当前打开的 PGN 大文件分类路径（null = 非 PGN 视图）。 */
  pgnPath: string | null
  pgnSource: string
  pgnIndex: PgnIndexEntry[]
  pgnPage: number
  pgnLoading: boolean
  pgnQuery: string

  load: () => Promise<void>
  pickCustomDirectory: (directoryPath: string) => Promise<void>
  selectCategory: (index: number) => Promise<void>
  setQuery: (query: string) => void
  setOnlyEndgame: (value: boolean) => void
  setDifficultyFilter: (difficulty: number) => void
  setSortMode: (mode: CorpusSortMode) => void
  openPgnCategory: (index: number) => Promise<void>
  setPgnPage: (page: number) => void
  setPgnQuery: (query: string) => void
}

let generation = 0
let parserClient: ParserClient | null = null

function getParserClient(): ParserClient {
  if (parserClient === null) parserClient = new ParserClient()
  return parserClient
}

/** 搜索 + 难度筛选 + 排序后的可见列表（仅已解析成功的条目，corpus_browser_vm.dart:71-101）。 */
export function visibleItems(state: {
  entries: CorpusEntry[]
  puzzles: Array<ParsedPuzzleView | null>
  query: string
  onlyEndgame: boolean
  difficultyFilter: number
  sortMode: CorpusSortMode
}): Array<{ entry: CorpusEntry; puzzle: ParsedPuzzleView }> {
  const query = state.query.trim()
  const items: Array<{ entry: CorpusEntry; puzzle: ParsedPuzzleView }> = []
  for (let i = 0; i < state.entries.length; i++) {
    const puzzle = state.puzzles[i]
    if (puzzle === undefined || puzzle === null) continue
    if (state.difficultyFilter !== 0 && puzzle.difficulty !== state.difficultyFilter) continue
    if (state.onlyEndgame && !puzzle.endgame) continue
    if (query.length > 0 && !(puzzle.title ?? state.entries[i].displayName).includes(query)) {
      continue
    }
    items.push({ entry: state.entries[i], puzzle })
  }
  switch (state.sortMode) {
    case 'name':
      // Dart compareTo 为 UTF-16 码元序，localeCompare 依赖 ICU 不可用（跨平台结果漂移）。
      items.sort((a, b) => (a.entry.displayName < b.entry.displayName ? -1 : a.entry.displayName > b.entry.displayName ? 1 : 0))
      break
    case 'moves':
      items.sort((a, b) => a.puzzle.moveCount - b.puzzle.moveCount)
      break
    case 'difficulty':
      items.sort((a, b) => {
        const d = a.puzzle.difficulty - b.puzzle.difficulty
        return d !== 0 ? d : a.puzzle.moveCount - b.puzzle.moveCount
      })
      break
  }
  return items
}

/** PGN 索引的搜索 + 分页切片（corpus_pgn_browser_page.dart:172-223）。 */
export function pgnPageSlice(
  index: PgnIndexEntry[],
  query: string,
  page: number
): { slice: PgnIndexEntry[]; totalPages: number; total: number } {
  const q = query.trim()
  const filtered =
    q.length === 0
      ? index
      : index.filter(
          (e) =>
            (e.event !== null && e.event.includes(q)) ||
            (e.red !== null && e.red.includes(q)) ||
            (e.black !== null && e.black.includes(q))
        )
  const totalPages = Math.max(1, Math.ceil(filtered.length / PGN_PAGE_SIZE))
  const safePage = Math.min(Math.max(page, 0), totalPages - 1)
  return {
    slice: filtered.slice(safePage * PGN_PAGE_SIZE, (safePage + 1) * PGN_PAGE_SIZE),
    totalPages,
    total: filtered.length
  }
}

export const useCorpusBrowser = create<CorpusBrowserState>()((set, get) => ({
  corpusExists: true,
  corpusPath: '',
  categories: [],
  selectedCategory: -1,
  entries: [],
  puzzles: [],
  progress: -1,
  query: '',
  onlyEndgame: false,
  difficultyFilter: 0,
  sortMode: 'name',
  pgnPath: null,
  pgnSource: '',
  pgnIndex: [],
  pgnPage: 0,
  pgnLoading: false,
  pgnQuery: '',

  load: async () => {
    const myGen = ++generation
    let scan
    try {
      // root 空串：主进程按 用户设置 > legacy > 平台默认 解析（corpus_paths.dart:150-172）
      scan = await api.corpus.scan('')
    } catch {
      scan = { root: '', exists: false, categories: [] }
    }
    if (myGen !== generation) return
    const base = {
      corpusPath: scan.root,
      categories: scan.categories,
      selectedCategory: -1,
      entries: [],
      puzzles: [],
      progress: -1,
      pgnPath: null,
      pgnIndex: [],
      pgnPage: 0
    }
    if (!scan.exists || scan.categories.length === 0) {
      // 目录缺失或为空（下载失败残留半成品等）：视同缺失，回到下载引导。
      set({ ...base, corpusExists: false })
      return
    }
    set({ ...base, corpusExists: true })
    await get().selectCategory(0)
  },

  pickCustomDirectory: async (directoryPath) => {
    try {
      await api.store.set('corpus.userPath', directoryPath)
    } catch {
      // 设置写失败：仍用本次选择加载
    }
    await get().load()
  },

  selectCategory: async (index) => {
    const myGen = ++generation
    const category = get().categories[index]
    if (category === undefined) return
    if (category.kind !== 'xqfDirectory') {
      // PGN 大文件分类只记录选中（页面层跳转 openPgnCategory），不批量解析。
      set({ selectedCategory: index, entries: [], puzzles: [], progress: -1 })
      return
    }
    set({ selectedCategory: index, entries: [], puzzles: [], progress: -1 })

    let entries: CorpusEntry[]
    try {
      entries = await api.corpus.listEntries(category.path, category.name)
    } catch {
      entries = []
    }
    if (myGen !== generation) return
    set({ entries, puzzles: entries.map(() => null), progress: entries.length > 0 ? 0 : -1 })
    if (entries.length === 0) return

    // 分批经 parser.worker 解析（每批 128），渐进展示（corpus_browser_vm.dart:226-245）。
    const client = getParserClient()
    const puzzles: Array<ParsedPuzzleView | null> = new Array(entries.length).fill(null)
    for (let start = 0; start < entries.length; start += PARSE_BATCH_SIZE) {
      const end = Math.min(start + PARSE_BATCH_SIZE, entries.length)
      const chunk = entries.slice(start, end)
      let bytes: CorpusFileBytes[]
      try {
        bytes = await api.corpus.readFiles(chunk.map((e) => e.path))
      } catch {
        bytes = []
      }
      if (myGen !== generation) return
      const byteByPath = new Map(bytes.map((b) => [b.path, b.bytes]))
      const files: Array<{ name: string; source: string; bytes: Uint8Array }> = []
      const fileChunkIndex: number[] = []
      chunk.forEach((e, ci) => {
        const b = byteByPath.get(e.path)
        if (b !== undefined) {
          files.push({ name: e.path, source: e.source, bytes: b })
          fileChunkIndex.push(ci)
        }
      })
      try {
        const result = await client.parseBatch(files)
        if (myGen !== generation) return
        // 结果按 files 顺序回填到 entries 对应下标（readFiles 可能跳过坏路径）。
        result.puzzles.forEach((p, i) => {
          const ci = fileChunkIndex[i]
          if (ci === undefined) return
          puzzles[start + ci] = toView(p, chunk[ci].source)
        })
        set({ puzzles: [...puzzles], progress: end / entries.length })
      } catch {
        if (myGen !== generation) return
        // 批次失败：该批保持 null，继续下一批
        set({ puzzles: [...puzzles], progress: end / entries.length })
      }
    }
    if (myGen === generation) {
      set({ puzzles, progress: -1 })
    }
  },

  setQuery: (query) => set({ query }),
  setOnlyEndgame: (value) => set({ onlyEndgame: value }),
  setDifficultyFilter: (difficulty) => set({ difficultyFilter: difficulty }),
  setSortMode: (mode) => set({ sortMode: mode }),

  openPgnCategory: async (index) => {
    const category = get().categories[index]
    if (category === undefined || category.kind !== 'pgnFile') return
    set({
      selectedCategory: index,
      pgnPath: category.path,
      pgnSource: category.source,
      pgnIndex: [],
      pgnPage: 0,
      pgnLoading: true
    })
    try {
      const pgnIndex = await api.corpus.pgnIndex(category.path)
      set({ pgnIndex, pgnLoading: false })
    } catch {
      set({ pgnIndex: [], pgnLoading: false })
    }
  },

  setPgnPage: (page) => set({ pgnPage: page }),
  setPgnQuery: (query) => set({ pgnQuery: query, pgnPage: 0 })
}))

/** 把 worker 解析结果投影为视图模型（isEndgamePuzzle 预计算，避免渲染期重复判定）。 */
function toView(p: ParsedPuzzle | null, fallbackSource: string): ParsedPuzzleView | null {
  if (p === null) return null
  const source = p.source.length > 0 ? p.source : fallbackSource
  return {
    id: p.id,
    initialFen: p.initialFen,
    solutionMoves: p.solutionMoves,
    title: p.title,
    description: p.description,
    source,
    format: p.format,
    difficulty: p.difficulty,
    moveCount: p.solutionMoves.length,
    endgame: isEndgamePuzzle(source, p.initialFen)
  }
}
