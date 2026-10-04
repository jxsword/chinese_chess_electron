// @vitest-environment jsdom
/**
 * 重复裁决页面集成测试（T3.10，DR-018，final 设计 §6；08 防错 #11/#12）。
 *
 * 两种手构环（残局 FEN 起盘，双人页逐点击走子）：
 * - SWING 长将环（车在底线来回将军）：k=2 → toast 警告；k=3 → 长将方判负；
 * - QUIET 闲着环（车摆动、双方王闲走，无人将军）：k=3 → 和棋确认框
 *   （拒绝可变着 / 接受判和）；k=4 → 强制判和。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HumanVsHumanPage } from '@renderer/features/board/HumanVsHumanPage'
import { useGlobalSettings } from '@renderer/stores/globalSettings'

const SWING_FEN = '4k4/R8/9/9/9/9/9/9/9/8K w - - 0 1' // 车 a9、黑王 e10、红王 h1

/** SWING：Ra9-a10+ / Ke10-e9 / Ra10-a9+ / Ke9-e10 → 回到起盘（红方每手将军）。 */
const SWING_CYCLE: Array<[number, number, number, number]> = [
  [0, 1, 0, 0],
  [4, 0, 4, 1],
  [0, 0, 0, 1],
  [4, 1, 4, 0]
]

/** QUIET：Ra9-a8 / Ke10-d10 / Ra8-a9 / Kd10-e10 → 回到起盘（无人将军）。 */
const QUIET_CYCLE: Array<[number, number, number, number]> = [
  [0, 1, 0, 2],
  [4, 0, 3, 0],
  [0, 2, 0, 1],
  [3, 0, 4, 0]
]

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/human-vs-human?fen=${encodeURIComponent(SWING_FEN)}`]}>
      <HumanVsHumanPage />
    </MemoryRouter>
  )
}

function makeClicker(container: HTMLElement): (col: number, row: number) => void {
  const svg = container.querySelector('[data-testid="board-svg"]')!
  const cell = Math.min(600 / 9.6, 600 / 10.6)
  return (col: number, row: number): void => {
    fireEvent.click(svg, { clientX: 50 + col * cell, clientY: 50 + row * cell })
  }
}

beforeEach(() => {
  useGlobalSettings.setState({ autoSave: true, loaded: true })
})

afterEach(() => {
  cleanup()
})

describe('重复裁决接线（DR-018，08 防错 #11/#12）', () => {
  it('长将环：k=2 toast 非阻塞警告 → k=3 长将方判负（无弹窗）', async () => {
    const { getByText, container } = renderPage()
    await screen.findByText('游戏信息')
    const clickAt = makeClicker(container)

    const playCycle = async (cycle: typeof SWING_CYCLE, from: number): Promise<void> => {
      for (const [fc, fr, tc, tr] of cycle) {
        clickAt(fc, fr)
        clickAt(tc, tr)
        from++
        await waitFor(() => expect(getByText(`步数: ${from}`)).not.toBeNull())
      }
    }

    // 第一轮：k=2 → toast 非阻塞警告（不弹框，防错 #11）。
    await playCycle(SWING_CYCLE, 0)
    await waitFor(() => expect(screen.getByText('红方连续将军重复，再次将判负')).not.toBeNull())
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()

    // 第二轮：k=3 → 长将方（红）判负，走既有结算横幅（ResultBanner）。
    await playCycle(SWING_CYCLE, 4)
    await waitFor(() => expect(getByText('黑方胜！')).not.toBeNull())
  }, 60000)

  it('闲着环：k=2 无警告 → k=3 确认框（拒绝变着）→ k=4 强制判和', async () => {
    const { getByText, container } = renderPage()
    await screen.findByText('游戏信息')
    const clickAt = makeClicker(container)

    const playCycle = async (cycle: typeof SWING_CYCLE, from: number): Promise<void> => {
      for (const [fc, fr, tc, tr] of cycle) {
        clickAt(fc, fr)
        clickAt(tc, tr)
        from++
        await waitFor(() => expect(getByText(`步数: ${from}`)).not.toBeNull())
      }
    }

    // 第一轮：k=2 闲着重现 → 不警告不弹框。
    await playCycle(QUIET_CYCLE, 0)
    await waitFor(() => expect(getByText('步数: 4')).not.toBeNull())
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
    expect(screen.queryByText('红方连续将军重复，再次将判负')).toBeNull()

    // 第二轮：k=3 → 三次重复判和确认框（防错 #12）。
    await playCycle(QUIET_CYCLE, 4)
    const dialog = await screen.findByTestId('confirm-dialog')
    expect(dialog.textContent).toContain('三次重复局面')

    // 玩家拒绝（变着继续）→ 对局继续。
    fireEvent.click(screen.getByText('变着继续'))
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull())
    expect(screen.queryByText('对局结束：和棋')).toBeNull()

    // 第三轮：k=4 → 强制判和。
    await playCycle(QUIET_CYCLE, 8)
    await waitFor(() => expect(getByText('和棋')).not.toBeNull())
  }, 60000)

  it('闲着环：k=3 接受和棋 → result=draw 终局', async () => {
    const { getByText, container } = renderPage()
    await screen.findByText('游戏信息')
    const clickAt = makeClicker(container)

    const playCycle = async (cycle: typeof SWING_CYCLE, from: number): Promise<void> => {
      for (const [fc, fr, tc, tr] of cycle) {
        clickAt(fc, fr)
        clickAt(tc, tr)
        from++
        await waitFor(() => expect(getByText(`步数: ${from}`)).not.toBeNull())
      }
    }

    await playCycle(QUIET_CYCLE, 0)
    await playCycle(QUIET_CYCLE, 4)
    fireEvent.click(await screen.findByText('接受和棋'))
    await waitFor(() => expect(getByText('和棋')).not.toBeNull())
  }, 60000)
})
