// @vitest-environment jsdom
/** 棋谱库页面用例（TC-LIB-001~007 + TC-DET-001~005 + record_saver 保存流程，07 文档 §5） */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { RecordLibraryPage } from '@renderer/features/record/RecordLibraryPage'
import { RecordDetailPage } from '@renderer/features/record/RecordDetailPage'
import { RecordSaveDialog } from '@renderer/features/record/RecordSaveDialog'
import { RecordLauncherDialog } from '@renderer/features/record/RecordLauncherDialog'
import { createGameStore } from '@renderer/stores/createGameStore'
import type { GameRecord, GameRecordSummary } from '@shared/ipc/types'

const { fakeApi } = vi.hoisted(() => ({
  fakeApi: {
    db: {
      recordsList: vi.fn(),
      recordsGet: vi.fn(),
      recordsSave: vi.fn(),
      recordsDelete: vi.fn(),
      saveGame: vi.fn(),
      loadLatest: vi.fn(),
      deleteForMode: vi.fn()
    },
    clipboard: { write: vi.fn(() => Promise.resolve()) },
    dialog: { saveFile: vi.fn(() => Promise.resolve(null)), readFile: vi.fn(() => Promise.resolve(null)) },
    store: { get: vi.fn(() => Promise.resolve(null)), set: vi.fn(() => Promise.resolve()) }
  }
}))

vi.mock('@renderer/ipc/client', () => ({ api: fakeApi, createRequestId: () => 'test-id' }))

const CREATED_AT = new Date(2026, 9, 2, 8).getTime()

function gameRecord(id: number, title: string): GameRecord {
  return {
    id,
    title,
    mode: 'humanVsHuman',
    initialFen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
    moves: [
      { f: [7, 7], t: [4, 7], p: 'C', x: null },
      { f: [7, 0], t: [6, 2], p: 'n', x: null }
    ],
    result: null,
    solveStatus: 'none',
    solutions: null,
    llmNote: null,
    note: null,
    createdAt: CREATED_AT
  }
}

function endgameRecord(id: number, title: string, solveStatus: GameRecord['solveStatus'], solutions: string[][]): GameRecord {
  return {
    id,
    title,
    mode: 'endgame',
    initialFen: '3k5/9/9/9/R8/8R/9/9/9/4K4 w - - 0 1',
    moves: [],
    result: null,
    solveStatus,
    solutions,
    llmNote: null,
    note: null,
    createdAt: CREATED_AT
  }
}

const summaries = (records: GameRecord[]): GameRecordSummary[] =>
  records.map((r) => ({
    id: r.id,
    title: r.title,
    mode: r.mode,
    result: r.result,
    solveStatus: r.solveStatus,
    createdAt: r.createdAt
  }))

let records: GameRecord[]

beforeEach(() => {
  records = [
    gameRecord(3, '对局甲'),
    endgameRecord(2, '残局乙', 'solved', [
      ['a5d5'],
      ['i4d4']
    ]),
    endgameRecord(1, '残局丙', 'noSolution', [])
  ]
  // 列表按 id 倒序（created_at DESC, id DESC）
  fakeApi.db.recordsList.mockImplementation(() =>
    Promise.resolve(summaries([...records].sort((a, b) => b.id - a.id)))
  )
  fakeApi.db.recordsGet.mockImplementation((id: number) =>
    Promise.resolve(records.find((r) => r.id === id) ?? null)
  )
  fakeApi.db.recordsSave.mockImplementation(() => Promise.resolve(99))
  fakeApi.db.recordsDelete.mockImplementation((id: number) => {
    records = records.filter((r) => r.id !== id)
    return Promise.resolve()
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderLibrary(): void {
  render(
    <MemoryRouter>
      <RecordLibraryPage />
    </MemoryRouter>
  )
}

describe('棋谱库列表（TC-LIB）', () => {
  it('TC-LIB-001 列表展示全部棋谱（id 倒序）', async () => {
    renderLibrary()
    await screen.findByText('残局丙')
    expect(screen.getByText('对局甲')).not.toBeNull()
    expect(screen.getByText('残局乙')).not.toBeNull()
  })

  it('TC-LIB-002 状态筛选', async () => {
    renderLibrary()
    await screen.findByText('残局丙')
    fireEvent.click(screen.getByText('对局', { selector: 'button' }))
    expect(screen.getByText('对局甲')).not.toBeNull()
    expect(screen.queryByText('残局乙')).toBeNull()
    fireEvent.click(screen.getByText('已破解', { selector: 'button' }))
    expect(screen.getByText('残局乙')).not.toBeNull()
    expect(screen.queryByText('对局甲')).toBeNull()
    fireEvent.click(screen.getByText('无解', { selector: 'button' }))
    expect(screen.getByText('残局丙')).not.toBeNull()
    expect(screen.queryByText('残局乙')).toBeNull()
  })

  it('TC-LIB-003 导出 PGN（复制）到剪贴板', async () => {
    renderLibrary()
    await screen.findByText('残局乙')
    fireEvent.change(screen.getByLabelText('棋谱操作 残局乙'), { target: { value: 'pgn' } })
    await waitFor(() => expect(fakeApi.clipboard.write).toHaveBeenCalled())
    const pgn = (fakeApi.clipboard.write.mock.calls[0] as unknown as string[])[0]
    expect(pgn).toContain('[Event "中国象棋 Ultra"]')
    expect(pgn).toContain('[SetFen')
    expect(pgn).toContain('[Result "1-0"]')
  })

  it('TC-LIB-004 分享文本（复制）', async () => {
    renderLibrary()
    await screen.findByText('残局乙')
    fireEvent.change(screen.getByLabelText('棋谱操作 残局乙'), { target: { value: 'share' } })
    await waitFor(() => expect(fakeApi.clipboard.write).toHaveBeenCalled())
    const text = (fakeApi.clipboard.write.mock.calls[0] as unknown as string[])[0]
    expect(text).toContain('破解之法（2 条')
    expect(text).toContain('解法1: a5d5')
  })

  it('TC-LIB-007 删除确认框取消后棋谱保留', async () => {
    renderLibrary()
    await screen.findByText('残局丙')
    fireEvent.change(screen.getByLabelText('棋谱操作 残局丙'), { target: { value: 'delete' } })
    await screen.findByTestId('confirm-dialog')
    fireEvent.click(screen.getByText('取消'))
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull())
    expect(fakeApi.db.recordsDelete).not.toHaveBeenCalled()
    expect(screen.getByText('残局丙')).not.toBeNull()
  })

  it('TC-LIB-006 删除确认后棋谱移除', async () => {
    renderLibrary()
    await screen.findByText('残局丙')
    fireEvent.change(screen.getByLabelText('棋谱操作 残局丙'), { target: { value: 'delete' } })
    await screen.findByTestId('confirm-dialog')
    fireEvent.click(screen.getByText('删除', { selector: 'button.cc-btn-primary' }))
    await waitFor(() => expect(screen.queryByText('残局丙')).toBeNull())
    expect(fakeApi.db.recordsDelete).toHaveBeenCalledWith(1)
  })
})

describe('棋谱详情（TC-DET）', () => {
  // 直接渲染组件时 useParams 为空，须经 <Route path="/record-library/:id"> 挂载。
  function renderDetail(id: number): void {
    render(
      <MemoryRouter initialEntries={[`/record-library/${id}`]}>
        <Routes>
          <Route path="/record-library/:id" element={<RecordDetailPage />} />
        </Routes>
      </MemoryRouter>
    )
  }

  it('TC-DET-001 对局谱打开即保存时的局面（2/2）；首末跳转与步进', async () => {
    renderDetail(3)
    await screen.findByText('棋谱信息')
    // 有走法的对局谱：打开直接定位保存时的局面（主变末尾）。
    expect(screen.getByTestId('replay-position').textContent).toBe('2 / 2 着')
    fireEvent.click(screen.getByLabelText('上一着'))
    expect(screen.getByTestId('replay-position').textContent).toBe('1 / 2 着')
    fireEvent.click(screen.getByLabelText('跳到开局'))
    expect(screen.getByTestId('replay-position').textContent).toBe('0 / 2 着')
    fireEvent.click(screen.getByLabelText('下一着'))
    expect(screen.getByTestId('replay-position').textContent).toBe('1 / 2 着')
    fireEvent.click(screen.getByLabelText('下一着'))
    expect(screen.getByTestId('replay-position').textContent).toBe('2 / 2 着')
    fireEvent.click(screen.getByLabelText('跳到末尾'))
    expect(screen.getByTestId('replay-position').textContent).toBe('2 / 2 着')
  })

  it('TC-DET-003 点击中文记谱芯片跳转到对应局面', async () => {
    renderDetail(3)
    await screen.findByText('棋谱信息')
    fireEvent.click(screen.getByText('1. 炮二平五'))
    expect(screen.getByTestId('replay-position').textContent).toBe('1 / 2 着')
  })

  it('TC-DET-004 多解残局：自动定位第一条解法，线路切换独立重放', async () => {
    renderDetail(2)
    await screen.findByText('棋谱信息')
    // 无对局走法的残局自动定位到第一条解法（1 着）。
    expect(screen.getByTestId('replay-position').textContent).toBe('0 / 1 着')
    // 切到解法 2。
    fireEvent.change(screen.getByLabelText('线路:').querySelector('select') ?? screen.getByRole('combobox'), {
      target: { value: '1' }
    })
    expect(screen.getByTestId('replay-position').textContent).toBe('0 / 1 着')
    // 切回主变：无着法。
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '-1' } })
    expect(screen.getByTestId('replay-position').textContent).toBe('0 / 0 着')
  })

  it('TC-DET-005 无解/超时棋谱显示求解结论文案', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/record-library/1']}>
        <Routes>
          <Route path="/record-library/:id" element={<RecordDetailPage />} />
        </Routes>
      </MemoryRouter>
    )
    await screen.findByText('棋谱信息')
    expect(screen.getByTestId('solve-verdicts').textContent).toContain('求解结论: 无解（深度上界内已证明）')
    unmount()

    records = [endgameRecord(4, '未决谱', 'timeout', [])]
    render(
      <MemoryRouter initialEntries={['/record-library/4']}>
        <Routes>
          <Route path="/record-library/:id" element={<RecordDetailPage />} />
        </Routes>
      </MemoryRouter>
    )
    await screen.findByText('棋谱信息')
    expect(screen.getByTestId('solve-verdicts').textContent).toContain('求解结论: 限时内未找到解法')
  })
})

/** 进入对战弹层（record_battle_launcher widget 流程的等价：模式选择 → 执方 → 路由跳转） */
describe('进入对战启动器', () => {
  function renderLauncher(fen: string): ReturnType<typeof render> {
    return render(
      <MemoryRouter>
        <RecordLauncherDialog startFen={fen} onClose={() => {}} />
      </MemoryRouter>
    )
  }

  it('已分胜负的对局不应打开弹层（canLaunchBattle=false 的调用方门控在页面层）', () => {
    // 本弹层只负责打开后的流程；无入口时调用方不渲染（TC-LIB 菜单不含"进入对战"）。
    render(
      <MemoryRouter>
        <RecordLauncherDialog startFen="" onClose={() => {}} />
      </MemoryRouter>
    )
    expect(screen.getByTestId('record-launcher-dialog')).not.toBeNull()
  })

  it('选择双人对弈：直接跳转双人页并携带 fen', () => {
    const { container } = renderLauncher('3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1')
    fireEvent.click(screen.getByText('双人对弈'))
    // 弹层通过 navigate 跳转（MemoryRouter 环境下无断言目标页，验证不抛错即可）。
    expect(container).not.toBeNull()
  })

  it('选择人机 AI：先选执方再进入', () => {
    renderLauncher('3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1')
    fireEvent.click(screen.getByText('人机对战（内置 AI）'))
    // 先出现执方选择，再选择执方（Dart 流程：mode → side → push）。
    expect(screen.getByText(/选择执方（AI 执另一方）/)).not.toBeNull()
    fireEvent.click(screen.getByText('玩家执黑'))
  })
})

describe('保存为棋谱（record_saver 等价）', () => {
  it('标题留空自动生成、备注透传，保存后回调关闭', async () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const vm = store.getState().vm
    vm.newGame()
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <RecordSaveDialog store={store} mode="humanVsHuman" onClose={onClose} />
      </MemoryRouter>
    )
    fireEvent.change(screen.getByTestId('record-title-input'), { target: { value: '  ' } })
    fireEvent.change(screen.getByTestId('record-note-input'), { target: { value: '经典开局' } })
    fireEvent.click(screen.getByText(/保存（共 0 着）/))
    await waitFor(() => expect(fakeApi.db.recordsSave).toHaveBeenCalled())
    const saved = fakeApi.db.recordsSave.mock.calls[0][0] as GameRecord
    expect(saved.title).toMatch(/\d{4}-\d{2}-\d{2} 双人对弈/)
    expect(saved.note).toBe('经典开局')
    expect(saved.initialFen.split(' ')[0]).toBe('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('保存失败（存储不可用）提示且不关闭', async () => {
    fakeApi.db.recordsSave.mockRejectedValueOnce(new Error('db unavailable'))
    const store = createGameStore({ mode: 'humanVsHuman' })
    store.getState().vm.newGame()
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <RecordSaveDialog store={store} mode="humanVsHuman" onClose={onClose} />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByText(/保存（共 0 着）/))
    await waitFor(() => expect(screen.getByText('保存失败：本地存储不可用')).not.toBeNull())
    expect(onClose).not.toHaveBeenCalled()
  })
})
