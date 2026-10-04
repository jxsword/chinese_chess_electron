// @vitest-environment jsdom
/**
 * 残局工作室页面用例（T6.2/T6.4，TC-SET/FEN/SOL 等价集，08 §4 + 04 §7）：
 * 三 Tab 渲染、摆盘放置与拦截、FEN 导入、校验五条拦截、保存棋局（未求解）、
 * 求解设置→进度→结果 BottomSheet→三种结论全部自动入库、识图未配置提示。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { computeBoardLayout, offsetOf } from '@renderer/features/board/boardLayout'
import type { SolveResult } from '@packages/solver'

const { fakeApi, solveMock } = vi.hoisted(() => ({
  fakeApi: {
    db: {
      recordsList: vi.fn(() => Promise.resolve([])),
      recordsGet: vi.fn(() => Promise.resolve(null)),
      recordsSave: vi.fn((..._args: unknown[]) => Promise.resolve(42)),
      recordsDelete: vi.fn(() => Promise.resolve()),
      saveGame: vi.fn(() => Promise.resolve()),
      loadLatest: vi.fn(() => Promise.resolve(null)),
      deleteForMode: vi.fn(() => Promise.resolve())
    },
    secure: { get: vi.fn(() => Promise.resolve(null)), set: vi.fn(() => Promise.resolve({ stored: 'encrypted' as const })), delete: vi.fn(() => Promise.resolve()) },
    clipboard: { write: vi.fn(() => Promise.resolve()) },
    vision: { readBoard: vi.fn(() => Promise.reject(new Error('not used'))) },
    store: { get: vi.fn(() => Promise.resolve(null)), set: vi.fn(() => Promise.resolve()) }
  },
  solveMock: vi.fn()
}))

vi.mock('@renderer/ipc/client', () => ({ api: fakeApi, createRequestId: () => 'test-id' }))

vi.mock('@renderer/workers/solverClient', () => ({
  SolverClient: class {
    solve = solveMock
    isWinningFirstMove = vi.fn(() => Promise.resolve(false))
    cancel = vi.fn()
    dispose = vi.fn()
  }
}))

const { runSolveAssistMock } = vi.hoisted(() => ({ runSolveAssistMock: vi.fn() }))
vi.mock('@renderer/features/studio/llmAssist', () => ({
  runSolveAssist: runSolveAssistMock
}))

import { EndgameStudioPage } from '@renderer/features/studio/EndgameStudioPage'

const FEN_A = '3k5/9/9/9/R8/8R/9/9/9/4K4 w - - 0 1'

function solvedResult(over: Partial<SolveResult>): SolveResult {
  return { status: 'solved', solutions: [], elapsed: 1200, searchedPlies: 3, ...over }
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/endgame-studio']}>
      <EndgameStudioPage />
    </MemoryRouter>
  )
}

/** 在棋盘上点击交叉点（jsdom 600×600 兜底布局，rect 为 0 → 缩放系数 1）。 */
function tapCell(col: number, row: number): void {
  const svg = screen.getByTestId('board-static-svg')
  const layout = computeBoardLayout(600, 600)
  const p = offsetOf(layout, col, row)
  fireEvent.click(svg, { clientX: p.x, clientY: p.y })
}

const loadFen = (fen: string): void => {
  fireEvent.click(screen.getByText('FEN 导入'))
  fireEvent.change(screen.getByPlaceholderText(/rnbakabnr/), { target: { value: fen } })
  fireEvent.click(screen.getByText('解析并载入棋盘'))
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => cleanup())

describe('渲染与摆盘（TC-SET）', () => {
  it('① 三 Tab + 操作按钮 + 空盘 FEN 预览', () => {
    renderPage()
    expect(screen.getByText('摆盘')).toBeTruthy()
    expect(screen.getByText('FEN 导入')).toBeTruthy()
    expect(screen.getByText('图片识图')).toBeTruthy()
    expect(screen.getByText('保存棋局')).toBeTruthy()
    expect(screen.getByText('AI 求破解')).toBeTruthy()
    expect(screen.getByText(/当前 FEN: 9\/9\/9\/9\/9\/9\/9\/9\/9\/9（红方行棋）/)).toBeTruthy()
  })

  it('② 选红车放置 → FEN 预览实时更新（TC-SET-002）', () => {
    renderPage()
    // 红子调色板中的"车"（黑子行也有"车"，取红子行内的第一个）。
    const redRow = screen.getByText('红子').parentElement!
    fireEvent.click([...redRow.querySelectorAll('button')].find((b) => b.textContent === '车')!)
    tapCell(0, 4)
    expect(screen.getByText(/当前 FEN: 9\/9\/9\/9\/R8\/9\/9\/9\/9\/9（红方行棋）/)).toBeTruthy()
  })

  it('③ 摆放位置即时拦截：红帅放九宫外 toast（TC-SET 逐条规则）', () => {
    renderPage()
    const redRow = screen.getByText('红子').parentElement!
    fireEvent.click([...redRow.querySelectorAll('button')].find((b) => b.textContent === '帅')!)
    tapCell(0, 4)
    expect(screen.getByRole('status').textContent).toBe('帅/将只能放在九宫内的 9 个位置')
  })
})

describe('FEN 导入（TC-FEN）', () => {
  it('④ 完整 FEN 载入 → toast 行棋方；仅棋盘字段接受；非法 FEN 拒绝且棋盘不变', () => {
    renderPage()
    loadFen(FEN_A)
    expect(screen.getByRole('status').textContent).toContain('已载入（红方行棋）')
    fireEvent.click(screen.getByText('摆盘'))
    expect(screen.getByText(/当前 FEN: 3k5\/9\/9\/9\/R8\/8R\/9\/9\/9\/4K4/)).toBeTruthy()

    // 仅棋盘字段：缺省按当前行棋方（红）处理。
    fireEvent.click(screen.getByText('FEN 导入'))
    fireEvent.change(screen.getByPlaceholderText(/rnbakabnr/), { target: { value: '9/9/9/9/9/9/9/9/9/4K4' } })
    fireEvent.click(screen.getByText('解析并载入棋盘'))
    expect(screen.getByRole('status').textContent).toContain('已载入（红方行棋）')

    // FEN-E 非法（末行 10 列）→ 拒绝，棋盘保持上一次载入。
    fireEvent.change(screen.getByPlaceholderText(/rnbakabnr/), {
      target: { value: 'k8/9/9/9/9/9/9/9/9/4K5 w' }
    })
    fireEvent.click(screen.getByText('解析并载入棋盘'))
    expect(screen.getByRole('status').textContent).toContain('FEN 无效')
    fireEvent.click(screen.getByText('摆盘'))
    expect(screen.getByText(/当前 FEN: 9\/9\/9\/9\/9\/9\/9\/9\/9\/4K4/)).toBeTruthy()
  })
})

describe('校验五条与保存棋局', () => {
  it('⑤ 缺王拦截保存与求解（TC-SET-006）', () => {
    renderPage()
    fireEvent.click(screen.getByText('保存棋局'))
    expect(screen.getByRole('status').textContent).toContain('双方必须各有一个将/帅（红 0 / 黑 0）')
    expect(fakeApi.db.recordsSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('AI 求破解'))
    expect(screen.queryByTestId('solve-options-dialog')).toBeNull()
  })

  it('⑥ 保存棋局（未求解）入库 solveStatus=none', async () => {
    renderPage()
    loadFen(FEN_A)
    fireEvent.click(screen.getByText('保存棋局'))
    await waitFor(() => expect(fakeApi.db.recordsSave).toHaveBeenCalledTimes(1))
    const record = fakeApi.db.recordsSave.mock.calls[0]![0] as { title: string; solveStatus: string; mode: string; solutions: unknown[] }
    expect(record.mode).toBe('endgame')
    expect(record.solveStatus).toBe('none')
    expect(record.solutions).toEqual([])
    expect(record.title).toMatch(/红方残局（未求解）$/)
    expect(screen.getByRole('status').textContent).toContain('棋局已保存到棋谱库（未求解）')
  })
})

describe('求解流程与三种结论自动入库（TC-SOL / 04 §7 状态机）', () => {
  it('⑦ FEN-A 求解 → 多解 BottomSheet + 中文记谱 + 入库 solved', async () => {
    solveMock.mockResolvedValue(
      solvedResult({
        solutions: [
          { moves: [{ from: { col: 0, row: 4 }, to: { col: 3, row: 4 } }] },
          { moves: [{ from: { col: 8, row: 5 }, to: { col: 3, row: 5 } }] }
        ]
      })
    )
    renderPage()
    loadFen(FEN_A)
    fireEvent.click(screen.getByText('AI 求破解'))
    fireEvent.click(screen.getByText('开始求解'))
    await waitFor(() => expect(screen.getByTestId('solve-result-sheet')).toBeTruthy())
    expect(screen.getByText('已破解（2 条破解走法）')).toBeTruthy()
    expect(screen.getByText(/解法 1（红方先行）/)).toBeTruthy()
    expect(solveMock).toHaveBeenCalledWith(FEN_A, { timeLimitMs: 30_000, maxPlies: 9 })
    await waitFor(() => expect(fakeApi.db.recordsSave).toHaveBeenCalledTimes(1))
    const record = fakeApi.db.recordsSave.mock.calls[0]![0] as { title: string; solveStatus: string; solutions: string[][]; llmNote: string | null }
    expect(record.solveStatus).toBe('solved')
    expect(record.solutions).toEqual([['a5d5'], ['i4d4']])
    expect(record.title).toMatch(/红方残局（多解）$/)
    expect(record.llmNote).toBeNull()
    expect(screen.getByText(/用时 1\.2s，已保存到棋谱库$/)).toBeTruthy()
  })

  it('⑧ 唯一解文案与标题（TC-SOL-010）', async () => {
    solveMock.mockResolvedValue(
      solvedResult({ solutions: [{ moves: [{ from: { col: 0, row: 4 }, to: { col: 3, row: 4 } }] }] })
    )
    renderPage()
    loadFen(FEN_A)
    fireEvent.click(screen.getByText('AI 求破解'))
    fireEvent.click(screen.getByText('开始求解'))
    await waitFor(() => expect(screen.getByTestId('solve-result-sheet')).toBeTruthy())
    expect(screen.getByText('已破解（唯一解）')).toBeTruthy()
    await waitFor(() => expect(fakeApi.db.recordsSave).toHaveBeenCalledTimes(1))
    expect((fakeApi.db.recordsSave.mock.calls[0]![0] as { title: string }).title).toMatch(/（唯一解）$/)
  })

  it('⑨ 无解入库（TC-SOL-003）：文案含证明深度 + solveStatus=noSolution', async () => {
    solveMock.mockResolvedValue({ status: 'noSolution', solutions: [], elapsed: 800, searchedPlies: 5 })
    renderPage()
    loadFen(FEN_A)
    fireEvent.click(screen.getByText('AI 求破解'))
    fireEvent.click(screen.getByText('开始求解'))
    await waitFor(() => expect(screen.getByTestId('solve-result-sheet')).toBeTruthy())
    expect(screen.getByText('无解（5 半着内已证明）')).toBeTruthy()
    await waitFor(() => expect(fakeApi.db.recordsSave).toHaveBeenCalledTimes(1))
    expect((fakeApi.db.recordsSave.mock.calls[0]![0] as { solveStatus: string }).solveStatus).toBe('noSolution')
  })

  it('⑩ 超时入库（TC-SOL-004）+ 0 步解特例（TC-SOL-005）', async () => {
    solveMock.mockResolvedValue({ status: 'timeout', solutions: [], elapsed: 10_000, searchedPlies: 3 })
    renderPage()
    loadFen(FEN_A)
    fireEvent.click(screen.getByText('AI 求破解'))
    fireEvent.click(screen.getByText('开始求解'))
    await waitFor(() => expect(screen.getByTestId('solve-result-sheet')).toBeTruthy())
    expect(screen.getByText('限时内未找到解法')).toBeTruthy()
    await waitFor(() => expect(fakeApi.db.recordsSave).toHaveBeenCalledTimes(1))
    expect((fakeApi.db.recordsSave.mock.calls[0]![0] as { solveStatus: string }).solveStatus).toBe('timeout')
    fireEvent.click(screen.getByTestId('solve-result-close'))

    // 对方已被将死：solved 且 0 条解法 → 特例提示（FEN-D 结构经 FEN 导入绕开校验）。
    solveMock.mockResolvedValue(solvedResult({ solutions: [], searchedPlies: 0 }))
    loadFen(FEN_A)
    fireEvent.click(screen.getByText('AI 求破解'))
    fireEvent.click(screen.getByText('开始求解'))
    await waitFor(() => expect(screen.getByTestId('solve-result-sheet')).toBeTruthy())
    expect(screen.getByText(/对方已被将死\/困毙，无需再走。/)).toBeTruthy()
  })
})

describe('大模型辅助注释（TC-SOL-008，05 §6 Hybrid）', () => {
  it('⑫ 验证通过 → BottomSheet 显示注释 + 入库 llmNote 同步', async () => {
    runSolveAssistMock.mockResolvedValue('大模型首选 a4-d4（已验证为必胜着法）；思路: 平车闷杀')
    solveMock.mockResolvedValue(
      solvedResult({ solutions: [{ moves: [{ from: { col: 0, row: 4 }, to: { col: 3, row: 4 } }] }] })
    )
    renderPage()
    loadFen(FEN_A)
    fireEvent.click(screen.getByText('AI 求破解'))
    fireEvent.click(screen.getByTestId('solve-llm-switch'))
    fireEvent.click(screen.getByText('开始求解'))
    await waitFor(() => expect(screen.getByTestId('solve-result-sheet')).toBeTruthy())
    expect(screen.getByTestId('solve-llm-note').textContent).toContain('已验证为必胜着法')
    await waitFor(() => expect(fakeApi.db.recordsSave).toHaveBeenCalledTimes(1))
    expect((fakeApi.db.recordsSave.mock.calls[0]![0] as { llmNote: string }).llmNote).toContain('已验证为必胜着法')
  })

  it('⑬ 未通过验证 → 注明"已忽略"；未开启辅助时 llmNote 为 null', async () => {
    runSolveAssistMock.mockResolvedValue('大模型首选 a4-d4 未通过求解器验证，已忽略')
    solveMock.mockResolvedValue(solvedResult({ solutions: [] }))
    renderPage()
    loadFen(FEN_A)
    fireEvent.click(screen.getByText('AI 求破解'))
    fireEvent.click(screen.getByTestId('solve-llm-switch'))
    fireEvent.click(screen.getByText('开始求解'))
    await waitFor(() => expect(screen.getByTestId('solve-llm-note')).toBeTruthy())
    expect(screen.getByTestId('solve-llm-note').textContent).toContain('未通过求解器验证，已忽略')
    fireEvent.click(screen.getByTestId('solve-result-close'))

    // 不勾选大模型辅助：不调用 assist，llmNote=null。
    solveMock.mockResolvedValue(solvedResult({ solutions: [] }))
    fireEvent.click(screen.getByText('AI 求破解'))
    fireEvent.click(screen.getByTestId('solve-llm-switch')) // 关闭开关
    fireEvent.click(screen.getByText('开始求解'))
    await waitFor(() => expect(screen.getAllByTestId('solve-result-sheet')).toHaveLength(1))
    expect(screen.queryByTestId('solve-llm-note')).toBeNull()
    expect(runSolveAssistMock).toHaveBeenCalledTimes(1)
  })
})

describe('图片识图（TC-VIS 前置）', () => {
  it('⑪ 助手模型未配置：提示先配置（人工核对文案常驻）', async () => {
    renderPage()
    fireEvent.click(screen.getByText('图片识图'))
    expect(screen.getByText(/请人工核对每个棋子后再求解/)).toBeTruthy()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).not.toBeNull()
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'board.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer) })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('请先配置研究助手模型'))
  })
})
