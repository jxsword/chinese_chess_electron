// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { BoardView } from '@renderer/features/board/BoardView'
import { createGameStore, type GameStore } from '@renderer/stores/createGameStore'
import { pos } from '@packages/rules'

// 等价集：test/features/board/view/widgets/board_painter_test.dart(3 例：高亮/选中渲染)
// + T2.3 专属验收：动画竞态 3 用例（08 §7 防错 #1，board_widget.dart:42,104）。

const SIZE = { width: 600, height: 600 }

function centerOf(col: number, row: number): { clientX: number; clientY: number } {
  // 600×600：cell = min(600/9.6, 600/10.6) = 600/10.6；网格居中
  const cell = Math.min(600 / 9.6, 600 / 10.6)
  const originX = (600 - 8 * cell) / 2
  const originY = (600 - 9 * cell) / 2
  return { clientX: originX + col * cell, clientY: originY + row * cell }
}

function renderBoard(store: GameStore, onMoved?: () => void) {
  const utils = render(<BoardView store={store} onMoved={onMoved} sizeOverride={SIZE} />)
  const svg = utils.getByTestId('board-svg')
  const clickAt = (col: number, row: number): void => {
    fireEvent.click(svg, centerOf(col, row))
  }
  return { ...utils, svg, clickAt }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  // jsdom 的 getBoundingClientRect 恒为 0：固定为 600×600（与 sizeOverride 一致，缩放比 1）
  vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 600,
    height: 600
  } as DOMRect)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('渲染等价（board_painter_test.dart 高亮/选中）', () => {
  it('初始局面渲染 32 枚棋子，无选中/无提示/无 lastMove', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const { container } = renderBoard(store)
    expect(container.querySelectorAll('[data-piece]').length).toBe(32)
    expect(container.querySelector('[data-selected]')).toBeNull()
    expect(container.querySelectorAll('.cc-hint-dot, .cc-hint-ring').length).toBe(0)
    expect(container.querySelectorAll('[data-lastmove]').length).toBe(0)
  })

  it('点击红车产生选中圈与合法目标点（车 a0 → 2 个目标）', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const { container, clickAt } = renderBoard(store)
    clickAt(0, 9)
    expect(store.getState().selected).toEqual(pos(0, 9))
    expect(container.querySelector('[data-selected]')).not.toBeNull()
    // 红 (0,9)：纵向 (0,8)(0,7)，(0,6) 有己方兵；横向被己方一排挡死
    expect(store.getState().legalTargets).toEqual([pos(0, 8), pos(0, 7)])
    expect(container.querySelectorAll('.cc-hint-dot').length).toBe(2)
    expect(container.querySelectorAll('.cc-hint-ring').length).toBe(0)
  })

  it('走子后 lastMove 高亮起止两格；敌子目标显示吃子外环', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const { container, clickAt } = renderBoard(store)
    clickAt(0, 9)
    clickAt(0, 8)
    act(() => { vi.advanceTimersByTime(220) }) // 动画结束才落子
    expect(container.querySelectorAll('[data-lastmove]').length).toBe(2)

    // 黑方应手：黑马 (1,0)→(2,2)（马腿 (1,1) 空，合法）
    clickAt(1, 0)
    clickAt(2, 2)
    act(() => { vi.advanceTimersByTime(220) })
    expect(store.getState().moveHistory.length).toBe(2)

    // 红炮 (7,7)：越过炮架 (7,2) 打黑马 (7,0) → 吃子外环；空目标为圆点
    clickAt(7, 7)
    expect(container.querySelectorAll('.cc-hint-ring').length).toBe(1)
    expect(container.querySelectorAll('.cc-hint-dot').length).toBeGreaterThan(0)
    expect(store.getState().legalTargets.some((p) => p.col === 7 && p.row === 0)).toBe(true)
  })
})

describe('动画竞态（08 §7 防错 #1，board_widget.dart:42,104）', () => {
  it('动画期间忽略新点击：不切换选中、不产生第二段动画、不提前落子', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const onMoved = vi.fn()
    const { container, clickAt } = renderBoard(store, onMoved)

    clickAt(0, 9) // 选中红车
    clickAt(0, 8) // 触发动画
    expect(store.getState().moveHistory.length).toBe(0) // 尚未落子
    expect(container.querySelectorAll('.cc-flying').length).toBe(1)

    clickAt(1, 9) // 动画期间的点击必须被忽略
    expect(store.getState().selected).toEqual(pos(0, 9)) // 选中未被切换/清除
    expect(container.querySelectorAll('.cc-flying').length).toBe(1) // 未覆盖飞行棋子
    expect(store.getState().moveHistory.length).toBe(0)

    act(() => { vi.advanceTimersByTime(220) })
    expect(store.getState().moveHistory.length).toBe(1) // 只落一次子
    expect(onMoved).toHaveBeenCalledTimes(1)
  })

  it('动画结束才落子：onMoved 恰好一次，飞行层清除', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const onMoved = vi.fn()
    const { container, clickAt } = renderBoard(store, onMoved)

    clickAt(0, 9)
    clickAt(0, 8)
    expect(onMoved).not.toHaveBeenCalled()
    expect(store.getState().moveHistory.length).toBe(0)

    act(() => { vi.advanceTimersByTime(219) })
    expect(store.getState().moveHistory.length).toBe(0) // 219ms 时仍未落子

    act(() => { vi.advanceTimersByTime(1) })
    expect(store.getState().moveHistory.length).toBe(1)
    expect(store.getState().lastMove?.to).toEqual(pos(0, 8))
    expect(onMoved).toHaveBeenCalledTimes(1)
    expect(container.querySelectorAll('.cc-flying').length).toBe(0)
  })

  it('动画窗口内历史未增长（选中被外部清除）→ onMoved 不触发', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const onMoved = vi.fn()
    const { clickAt } = renderBoard(store, onMoved)

    clickAt(0, 9)
    clickAt(0, 8) // 动画开始
    // 模拟动画窗口的竞态：外部（新局/悔棋/恢复）清掉选中与历史
    store.getState().vm.newGame()
    act(() => { vi.advanceTimersByTime(220) })

    // onTap 未产生走子 → 不得触发 onMoved（board_widget.dart:104）
    expect(store.getState().moveHistory.length).toBe(0)
    expect(onMoved).not.toHaveBeenCalled()
    expect(store.getState().fen).toContain('rnbakabnr') // 初始局面未被扰动
  })
})
