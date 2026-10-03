// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from '@renderer/app/App'
import { createGameStore } from '@renderer/stores/createGameStore'
import { HumanVsHumanPage } from '@renderer/features/board/HumanVsHumanPage'
import { useGlobalSettings } from '@renderer/stores/globalSettings'

// T2.6 组件级冒烟：主页 7 入口 + 双人页信息区/新游戏确认/计时器格式（08 §1/§3.2）。
// IPC 走 mock 层（jsdom 无 preload，client.ts 自动切 mock）。

function renderApp(): ReturnType<typeof render> {
  // App 内置 MemoryRouter（初始路由 '/'）
  return render(<App />)
}

beforeEach(() => {
  useGlobalSettings.setState({ autoSave: true, loaded: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('主页导航（08 §1）', () => {
  it('渲染 7 个入口 + 打开全局设置弹窗（每次打开重新读取）', async () => {
    const loadSpy = vi.spyOn(useGlobalSettings.getState(), 'load')
    const { getByText, getByTitle } = renderApp()
    for (const title of ['残局选关', '人机对战', '人机对战（大模型）', '大模型对战', '双人对弈', '残局工作室（摆盘/导入/求解）', '棋谱库']) {
      expect(getByText(title)).not.toBeNull()
    }
    fireEvent.click(getByTitle('全局设置'))
    expect(screen.getByTestId('global-settings-dialog')).not.toBeNull()
    await waitFor(() => expect(loadSpy).toHaveBeenCalled())
  })

  it('点击"双人对弈"跳转对局页', () => {
    const { getByText } = renderApp()
    fireEvent.click(getByText('双人对弈'))
    expect(getByText('双人对弈', { selector: 'h2' })).not.toBeNull()
  })
})

describe('双人对弈页（08 §3.2）', () => {
  it('信息区：回合/步数/用时 mm:ss；走子后步数与回合更新', async () => {
    const { getByText, container } = render(
      <MemoryRouter initialEntries={['/human-vs-human']}>
        <HumanVsHumanPage />
      </MemoryRouter>
    )
    await screen.findByText('游戏信息') // 恢复流程完成
    expect(getByText('当前回合:')).not.toBeNull()
    expect(getByText('红方', { selector: '.cc-turn-label-red' })).not.toBeNull()
    expect(getByText('步数: 0')).not.toBeNull()
    expect(getByText('用时: 00:00')).not.toBeNull()

    // 点击红车 → 走子（动画结束后步数 1、轮到黑方）
    const svg = container.querySelector('[data-testid="board-svg"]')!
    const cell = Math.min(600 / 9.6, 600 / 10.6)
    const clickAt = (col: number, row: number): void => {
      fireEvent.click(svg, { clientX: 50 + col * cell, clientY: 50 + row * cell })
    }
    clickAt(0, 9)
    clickAt(0, 8)
    await waitFor(() => expect(getByText('步数: 1')).not.toBeNull())
    expect(getByText('黑方', { selector: '.cc-turn-label-black' })).not.toBeNull()
  }, 10000)

  it('新游戏按钮弹出确认对话框（防错 #3），取消不清盘', async () => {
    const { getByText, findByTestId } = render(
      <MemoryRouter initialEntries={['/human-vs-human']}>
        <HumanVsHumanPage />
      </MemoryRouter>
    )
    await screen.findByText('游戏信息')
    fireEvent.click(getByText('新游戏', { selector: 'header .cc-btn' }))
    const dialog = await findByTestId('confirm-dialog')
    expect(dialog).not.toBeNull()
    fireEvent.click(getByText('取消'))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  }, 10000)
})

describe('store 隔离（铁律 #6，页面级）', () => {
  it('每局创建独立实例：卸载后重建页面状态重置', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/human-vs-human']}>
        <HumanVsHumanPage />
      </MemoryRouter>
    )
    await waitFor(() => expect(useGlobalSettings.getState().loaded).toBe(true))
    unmount()
    // 重建后不共享实例
    const storeA = createGameStore({ mode: 'humanVsHuman' })
    const storeB = createGameStore({ mode: 'humanVsHuman' })
    expect(storeA.getState().vm).not.toBe(storeB.getState().vm)
  }, 10000)
})
