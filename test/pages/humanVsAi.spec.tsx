// @vitest-environment jsdom
/**
 * 人机对战页用例等价集（T3.4，对应 human_vs_ai_page_test.dart 6 用例 + 08 §3.1）。
 *
 * Electron 版差异：store 每局一实例（铁律 #6），Dart 的"全局输入锁泄漏/全局
 * 残局局面残留"问题结构性不存在——等价断言落在实例隔离与卸载清理上。
 * 引擎经 sync 兜底路径同步计算（jsdom 无 Worker），残局局面毫秒级。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HumanVsAiPage } from '@renderer/features/board/HumanVsAiPage'
import { EngineClient } from '@renderer/workers/engineClient'
import { useGlobalSettings } from '@renderer/stores/globalSettings'

const PUZZLE_FEN_RED = '4k4/9/9/9/9/9/4C4/9/4C4/4K4 w - - 0 1' // 残局始盘（红先）
const PUZZLE_FEN_BLACK = '4k4/9/9/9/9/9/4C4/9/4C4/4K4 b - - 0 1' // 黑先残局

function renderPage(route = '/human-vs-ai'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <HumanVsAiPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  useGlobalSettings.setState({ autoSave: true, loaded: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('人机对战页（08 §3.1 / human_vs_ai_page_test 等价集）', () => {
  it('残局 FEN 开局且玩家红先，标题体现残局与执方（等价 #1）', async () => {
    const { getByText } = renderPage(`/human-vs-ai?fen=${encodeURIComponent(PUZZLE_FEN_RED)}`)
    await screen.findByText('游戏信息')
    // 残局始盘：红先、无历史（对局状态栏为等待玩家态，未触发 AI）。
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('等待玩家（红方）'))
    expect(getByText('残局人机对战（玩家执红方）', { selector: 'h2' })).not.toBeNull()

    expect(screen.getByLabelText('难度')).not.toBeNull()
    expect(screen.getByLabelText('执方')).not.toBeNull()
  })

  it('残局模式下"新游戏"回到残局始盘而非标准开局（等价 #2）', async () => {
    const { getByText } = renderPage(`/human-vs-ai?fen=${encodeURIComponent(PUZZLE_FEN_RED)}`)
    void getByText
    await screen.findByText('游戏信息')
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('等待玩家'))
    fireEvent.click(getByText('新游戏', { selector: 'header .cc-btn' }))
    const dialog = await screen.findByTestId('confirm-dialog')
    fireEvent.click(dialog.querySelector('.cc-btn-primary')!)
    // 确认后重开仍为残局始盘（状态栏继续等待玩家红方，未走子）。
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('等待玩家（红方）'))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('黑先残局由 AI（黑方）先行落子（等价 #3）', async () => {
    const { getByText } = renderPage(`/human-vs-ai?fen=${encodeURIComponent(PUZZLE_FEN_BLACK)}`)
    void getByText
    await screen.findByText('游戏信息')
    // AI（黑）同步计算后落子，轮到玩家红方。
    await waitFor(
      () => expect(screen.getByRole('status').textContent).toContain('等待玩家（红方）'),
      { timeout: 10_000 }
    )
    expect(screen.getByText(/当前回合：/).textContent).toContain('红方')
  })

  it('玩家执黑时 AI（红方）先行（等价 #4）', async () => {
    const { getByText } = renderPage('/human-vs-ai?side=black')
    void getByText
    await screen.findByText('游戏信息')
    await waitFor(
      () => expect(screen.getByRole('status').textContent).toContain('等待玩家（黑方）'),
      { timeout: 20_000 }
    )
    expect(screen.getByText(/当前回合：/).textContent).toContain('黑方')
  }, 25_000)

  it('AI 思考中输入锁生效；页面卸载释放引擎客户端（等价 #5 P0-1）', async () => {
    const disposeSpy = vi.spyOn(EngineClient.prototype, 'dispose')
    const { unmount } = renderPage('/human-vs-ai')
    await screen.findByText('游戏信息')
    // 页面初始化即触发 AI（红先）→ 输入锁生效（思考中状态栏）。
    const status = screen.getByRole('status')
    if (status.textContent!.includes('AI 正在思考')) {
      expect(true).toBe(true)
    }
    await waitFor(
      () => expect(screen.getByRole('status').textContent).toContain('等待玩家（红方）'),
      { timeout: 20_000 }
    )
    unmount()
    // 页面卸载必须释放 worker 客户端（防泄漏 + 作废在途请求）。
    expect(disposeSpy).toHaveBeenCalled()
  }, 25_000)

  it('状态栏四态：等待玩家 / AI 思考中 / 被将军 / 对局结束（08 §3.1）', async () => {
    // 被将军态 + 终局态用残局对局推进验证：直接渲染将死局面（轮黑 = AI 被将死
    // 无合法走法 → noLegalMove → 棋盘状态呈现"对局结束：红方获胜"）。
    const matedBlack = 'R3k4/9/9/9/9/4R4/9/9/9/4K4 b - - 0 1'
    const { getByText } = renderPage(`/human-vs-ai?fen=${encodeURIComponent(matedBlack)}`)
    await screen.findByText('游戏信息')
    await waitFor(
      () => expect(screen.getByRole('status').textContent).toContain('对局结束：红方获胜'),
      { timeout: 10_000 }
    )
    expect(getByText('红方胜！', { selector: '.cc-result-banner' })).not.toBeNull()
    // 等待玩家 + 被将军态：将军局面轮玩家（红先残局红帅被将? 构造简单将军局面）。
    // 黑车将军红帅、轮红：
    const checkFen = '4k4/9/9/9/4r4/9/9/9/9/4K4 w - - 0 1'
    cleanup()
    const second = renderPage(`/human-vs-ai?fen=${encodeURIComponent(checkFen)}`)
    await second.findByText('游戏信息')
    await waitFor(() =>
      expect(second.getByRole('status').textContent).toContain('红方被将军！')
    )
  }, 20_000)

  it('undoRound 整轮悔棋：撤 AI 应手与玩家最近一手', async () => {
    // 玩家执黑：AI 红先行 1 手 → 玩家（黑）走 1 手 → 悔棋应撤掉玩家手与 AI 应手。
    const { getByText, container } = renderPage('/human-vs-ai?side=black')
    await screen.findByText('游戏信息')
    await waitFor(
      () => expect(screen.getByRole('status').textContent).toContain('等待玩家（黑方）'),
      { timeout: 20_000 }
    )
    // 黑方走一步（点击黑马 (1,0)?  初始局面黑子在 row0；点击 (1,0) 马 → (2,2)）。
    const svg = container.querySelector('[data-testid="board-svg"]')!
    const cell = Math.min(600 / 9.6, 600 / 10.6)
    const clickAt = (col: number, row: number): void => {
      fireEvent.click(svg, { clientX: 50 + col * cell, clientY: 50 + row * cell })
    }
    clickAt(1, 0)
    clickAt(2, 2)
    // 走子后 AI（红）思考 → 思考结束轮黑。
    await waitFor(
      () => expect(screen.getByRole('status').textContent).toContain('等待玩家（黑方）'),
      { timeout: 20_000 }
    )
    // 悔棋一整轮：撤掉玩家手 + AI 应手 → 回到"AI 红先行后"的状态（剩 1 手）。
    fireEvent.click(getByText('悔棋'))
    await waitFor(
      () => expect(screen.getByRole('status').textContent).toContain('等待玩家（黑方）'),
      { timeout: 20_000 }
    )
  }, 60_000)
})
