// @vitest-environment jsdom
/**
 * 大模型对战页用例（T4.6，08 §3.4 + 05 §8.1：循环/暂停/失败判负）。
 * mock IPC 全链路：双方模型回复不可解析 → 每手经重试耗尽走兜底，验证循环驱动。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LlmVsLlmPage } from '@renderer/features/board/LlmVsLlmPage'
import { api } from '@renderer/ipc/client'
import { LLM_SETTING_KEYS } from '@packages/llm'

const CONFIG = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-abcd', model: 'test-model', disableThinking: true }

function renderPage(route = '/llm-vs-llm'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <LlmVsLlmPage />
    </MemoryRouter>
  )
}

async function seedBothConfigs(): Promise<void> {
  await api.secure.set('llm_config_red', { ...CONFIG })
  await api.secure.set('llm_config_black', { ...CONFIG, model: 'test-model-b' })
}

function seedSettings(over: Partial<Record<string, unknown>> = {}): void {
  void api.store.set(LLM_SETTING_KEYS.timeoutSeconds, 30)
  void api.store.set(LLM_SETTING_KEYS.maxAttempts, 3)
  void api.store.set(LLM_SETTING_KEYS.fallbackIndex, 0) // builtinAi
  void api.store.set(LLM_SETTING_KEYS.intervalSeconds, 0)
  void api.store.set(LLM_SETTING_KEYS.advisorModeIndex, 1) // candidate
  void api.store.set(LLM_SETTING_KEYS.strengthBlend, 50)
  void api.store.set(LLM_SETTING_KEYS.advisorDifficulty, 1) // 浅搜索提速
  for (const [k, v] of Object.entries(over)) void api.store.set(k, v)
}

beforeEach(async () => {
  // mock 单例跨测试共享：清存档 + 冲洗上一测试的卸载回写链
  await api.db.deleteForMode('llmVsLlm')
  await new Promise((r) => setTimeout(r, 80))
  seedSettings()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('大模型对战页（08 §3.4 / 05 §8.1）', () => {
  it('01 双方未配置：开始被拦截并提示', async () => {
    renderPage()
    await screen.findAllByTestId('llm-config-card')
    fireEvent.click(screen.getByTestId('llm-loop-toggle'))
    await waitFor(() => expect(screen.getByText('请先为红黑双方填写端点地址与模型 ID')).not.toBeNull())
    expect(screen.getByTestId('llm-loop-status').textContent).toContain('等待开始')
  })

  it('02 对局循环：红黑交替应手（mock 回复无效 → 兜底落子），状态区更新', async () => {
    await seedBothConfigs()
    renderPage()
    await screen.findAllByTestId('llm-config-card')
    fireEvent.click(screen.getByTestId('llm-loop-toggle'))
    await waitFor(
      () => expect(screen.getByTestId('llm-red-note').textContent).toContain('红方：'),
      { timeout: 20_000 }
    )
    expect(screen.getByTestId('llm-last-move').textContent).toContain('红方')
    await waitFor(
      () => expect(screen.getByTestId('llm-black-note').textContent).toContain('黑方：'),
      { timeout: 20_000 }
    )
    expect(screen.getByTestId('llm-last-move').textContent).toContain('黑方')
    // 停止终止循环
    fireEvent.click(screen.getByText('停止'))
    expect(screen.getByTestId('llm-loop-status').textContent).toContain('已停止')
  }, 60_000)

  it('03 失败判负：resign 策略下一方失败 → 显式判负终止（防错 #7）', async () => {
    await seedBothConfigs()
    await api.store.set(LLM_SETTING_KEYS.fallbackIndex, 1) // resign
    renderPage()
    await screen.findAllByTestId('llm-config-card')
    fireEvent.click(screen.getByTestId('llm-loop-toggle'))
    await waitFor(
      () => expect(screen.getByText('黑方胜！', { selector: '.cc-result-banner' })).not.toBeNull(),
      { timeout: 20_000 }
    )
    // 终局态优先于失败文案（Dart resultText ?? _statusText 同优先级）；
    // 失败原因落入红方注解区。
    expect(screen.getByTestId('llm-red-note').textContent).toContain('按判负处理')
  }, 30_000)

  it('04 暂停在两手之间生效；继续后恢复对局', async () => {
    await seedBothConfigs()
    renderPage()
    await screen.findAllByTestId('llm-config-card')
    fireEvent.click(screen.getByTestId('llm-loop-toggle'))
    await waitFor(() => expect(screen.getByTestId('llm-last-move')).not.toBeNull(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('llm-loop-toggle')) // 暂停
    expect(screen.getByTestId('llm-loop-status').textContent).toContain('已暂停')
    const frozen = screen.getByTestId('llm-last-move').textContent
    await new Promise((r) => setTimeout(r, 900))
    // 暂停期间不再有新手
    expect(screen.getByTestId('llm-last-move').textContent).toBe(frozen)
    // 继续 → 循环恢复（有新手落盘）
    fireEvent.click(screen.getByTestId('llm-loop-toggle')) // 继续
    await waitFor(
      () => expect(screen.getByTestId('llm-last-move').textContent).not.toBe(frozen),
      { timeout: 20_000 }
    )
    fireEvent.click(screen.getByText('停止'))
    expect(screen.getByTestId('llm-loop-status').textContent).toContain('已停止')
  }, 60_000)

  it('05 恢复存档后不自动续跑，由用户点开始继续', async () => {
    await seedBothConfigs()
    await api.db.saveGame({ mode: 'llmVsLlm', fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1', moves: [[7, 7, 4, 7]] })
    renderPage()
    await screen.findAllByTestId('llm-config-card')
    await new Promise((r) => setTimeout(r, 100))
    // 恢复了 1 手（走法记录区可见），但循环未启动
    expect(screen.getByTestId('llm-loop-status').textContent).toContain('等待开始')
    expect(screen.queryByTestId('llm-last-move')).toBeNull()
  })

  it('06 新游戏：清空状态区并回到等待开始', async () => {
    await seedBothConfigs()
    renderPage()
    await screen.findAllByTestId('llm-config-card')
    fireEvent.click(screen.getByTestId('llm-loop-toggle'))
    await waitFor(() => expect(screen.getByTestId('llm-red-note')).not.toBeNull(), { timeout: 20_000 })
    fireEvent.click(screen.getByText('新游戏', { selector: 'header .cc-btn' }))
    const dialog = await screen.findByTestId('confirm-dialog')
    fireEvent.click(dialog.querySelector('.cc-btn-primary')!)
    expect(screen.getByTestId('llm-loop-status').textContent).toContain('等待开始')
    expect(screen.queryByTestId('llm-red-note')).toBeNull()
    expect(screen.queryByTestId('llm-black-note')).toBeNull()
  }, 30_000)
})
