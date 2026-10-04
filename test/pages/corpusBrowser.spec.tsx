// @vitest-environment jsdom
/** 语料库页冒烟（06 文档 §6：缺失引导 / 分类列表 / 解析进度 / PGN 分页） */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CorpusBrowserPage } from '@renderer/features/puzzle/CorpusBrowserPage'
import { useCorpusBrowser } from '@renderer/stores/corpusBrowser'

// IPC 注入：真实扫描/解析时序由主进程与 worker 测试覆盖，此处验证页面编排与渲染分支。
// vi.mock 工厂被提升到文件顶部，被引变量须经 vi.hoisted 创建。
const { fakeApi } = vi.hoisted(() => ({
  fakeApi: {
    corpus: {
      scan: vi.fn(),
      listEntries: vi.fn(),
      readFiles: vi.fn(),
      pgnIndex: vi.fn(),
      readPgnGame: vi.fn(),
      pickDirectory: vi.fn(),
      download: vi.fn(() => Promise.resolve()),
      onProgress: vi.fn(() => () => {})
    },
    store: { get: vi.fn(() => Promise.resolve(null)), set: vi.fn(() => Promise.resolve()) }
  }
}))

vi.mock('@renderer/ipc/client', () => ({
  api: fakeApi,
  createRequestId: () => 'test-id'
}))

vi.mock('@renderer/workers/parserClient', () => ({
  ParserClient: class {
    async parseBatch(files: Array<{ name: string }>): Promise<unknown> {
      return {
        puzzles: files.map((f) =>
          f.name.includes('坏')
            ? null
            : {
                id: `xqf/残局/${f.name}`,
                initialFen: '4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1',
                solutionMoves: ['h2e2'],
                title: f.name.split('/').pop() ?? f.name,
                description: null,
                source: '残局/适情雅趣',
                format: 'xqf',
                difficulty: 1
              }
        )
      }
    }
    cancel(): void {}
    dispose(): void {}
  }
}))

function renderPage(): void {
  render(
    <MemoryRouter>
      <CorpusBrowserPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  useCorpusBrowser.setState({
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
    pgnQuery: ''
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('语料缺失引导', () => {
  it('目录缺失：展示期望路径 + 下载按钮 + 选择其他棋谱目录', async () => {
    fakeApi.corpus.scan.mockResolvedValue({ root: '/expect/corpus', exists: false, categories: [] })
    renderPage()
    await waitFor(() => expect(screen.getByText('期望路径：/expect/corpus')).not.toBeNull())
    expect(screen.getByText('下载语料包（约 45MB）')).not.toBeNull()
    expect(screen.getByText('选择其他棋谱目录')).not.toBeNull()
  })

  it('点击下载：调用 cc:corpus:download 后重新 load', async () => {
    fakeApi.corpus.scan.mockResolvedValue({ root: '/expect/corpus', exists: false, categories: [] })
    fakeApi.corpus.download.mockResolvedValue(undefined)
    renderPage()
    await screen.findByText('下载语料包（约 45MB）')
    fireEvent.click(screen.getByText('下载语料包（约 45MB）'))
    await waitFor(() => expect(fakeApi.corpus.download).toHaveBeenCalled())
    // 下载完成后再次 scan（load 刷新）。
    await waitFor(() => expect(fakeApi.corpus.scan.mock.calls.length).toBeGreaterThanOrEqual(2))
  })
})

describe('语料浏览', () => {
  const categories = [
    { name: '残局大全', path: '/corpus/endgame', kind: 'xqfDirectory' as const, source: '残局大全' },
    { name: 'PGN · big.pgns（多局合一）', path: '/corpus/big.pgns', kind: 'pgnFile' as const, source: 'wxf/ICCS' }
  ]

  it('分类点击 → XQF 列表渲染（含解析进度收尾与坏文件过滤）', async () => {
    fakeApi.corpus.scan.mockResolvedValue({ root: '/corpus', exists: true, categories })
    fakeApi.corpus.listEntries.mockResolvedValue([
      { path: '/corpus/endgame/好局.xqf', category: '残局大全', source: '残局/适情雅趣', displayName: '好局' },
      { path: '/corpus/endgame/坏局.xqf', category: '残局大全', source: '残局/适情雅趣', displayName: '坏局' }
    ])
    fakeApi.corpus.readFiles.mockImplementation((paths: string[]) =>
      Promise.resolve(paths.map((p) => ({ path: p, bytes: new Uint8Array(0) })))
    )
    renderPage()
    await screen.findByText('残局大全')
    fireEvent.click(screen.getByText('残局大全'))
    await waitFor(() => expect(screen.getByText('好局.xqf')).not.toBeNull())
    expect(screen.queryByText('坏局.xqf')).toBeNull() // 解析失败条目不进列表
    expect(screen.getByText(/残局\/适情雅趣 · 1 着/)).not.toBeNull()
  })

  it('PGN 分类 → 索引分页（每页 50，翻页可用）', async () => {
    fakeApi.corpus.scan.mockResolvedValue({ root: '/corpus', exists: true, categories })
    const index = Array.from({ length: 123 }, (_, i) => ({
      offset: i * 100,
      length: 100,
      event: `对局 ${i}`,
      red: `红${i}`,
      black: `黑${i}`
    }))
    fakeApi.corpus.pgnIndex.mockResolvedValue(index)
    renderPage()
    await screen.findByText('PGN · big.pgns（多局合一）')
    fireEvent.click(screen.getByText('PGN · big.pgns（多局合一）'))
    await waitFor(() => expect(screen.getByText('共 123 局')).not.toBeNull())
    expect(screen.getByText('对局 0')).not.toBeNull()
    expect(screen.getByText('第 1 / 3 页')).not.toBeNull()
    fireEvent.click(screen.getByText('下一页'))
    expect(screen.getByText('第 2 / 3 页')).not.toBeNull()
    expect(screen.getByText('对局 50')).not.toBeNull()
  })
})
