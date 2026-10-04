// @vitest-environment jsdom
/**
 * 人机对战（大模型）页用例等价集（T4.5，08 §3.3 + 交互防错清单）。
 * 走 mock IPC 全链路（secure/store/db/llm SSE mock），验证页面与 packages/llm 管线的接缝。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HumanVsLlmPage } from '@renderer/features/board/HumanVsLlmPage'
import { api } from '@renderer/ipc/client'
import { LLM_SETTING_KEYS } from '@packages/llm'
import { formatThinkingSuffix } from '@renderer/llm/useThinkingStatus'

const CHECK_FEN = '4k4/9/9/9/4r4/9/9/9/9/4K4 w - - 0 1' // 黑车将军红帅、轮红

function renderPage(route = '/human-vs-llm'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <HumanVsLlmPage />
    </MemoryRouter>
  )
}

function seedSettings(over: Partial<Record<string, unknown>> = {}): void {
  void api.store.set(LLM_SETTING_KEYS.humanVsLlmOpponentType, 0) // llm
  void api.store.set(LLM_SETTING_KEYS.redSideType, 0)
  void api.store.set(LLM_SETTING_KEYS.blackSideType, 0)
  void api.store.set(LLM_SETTING_KEYS.timeoutSeconds, 30)
  void api.store.set(LLM_SETTING_KEYS.maxAttempts, 3)
  void api.store.set(LLM_SETTING_KEYS.fallbackIndex, 0) // builtinAi
  void api.store.set(LLM_SETTING_KEYS.advisorModeIndex, 1) // candidate
  void api.store.set(LLM_SETTING_KEYS.strengthBlend, 50)
  void api.store.set(LLM_SETTING_KEYS.advisorDifficulty, 1) // 浅搜索提速
  for (const [k, v] of Object.entries(over)) void api.store.set(k, v)
}

/** 玩家红方走炮二平五：点击 (7,7) 炮 → (4,7) */
async function playCannonCentral(container: HTMLElement): Promise<void> {
  const svg = container.querySelector('[data-testid="board-svg"]')!
  const cell = Math.min(600 / 9.6, 600 / 10.6)
  const clickAt = (col: number, row: number): void => {
    fireEvent.click(svg, { clientX: 50 + col * cell, clientY: 50 + row * cell })
  }
  clickAt(7, 7)
  clickAt(4, 7)
}

beforeEach(async () => {
  // mock 单例跨测试共享：清掉上一测试自动保存的对局存档（防恢复干扰），
  // 并等上一测试卸载回写链（含 DR-014 新键）完全冲洗后再播种。
  await api.db.deleteForMode('humanVsLlm')
  await new Promise((r) => setTimeout(r, 120))
  seedSettings() // 含 humanVsLlmOpponentType=llm（覆盖用例 10b 的改动）
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('思考状态后缀格式化（思考型模型透明化）', () => {
  it('未满 3 秒且首次尝试 → 空后缀', () => {
    expect(formatThinkingSuffix(1, { n: 1, total: 3 })).toBe('')
    expect(formatThinkingSuffix(0, null)).toBe('')
  })
  it('≥3 秒显示已等待；重试附带第 N/M 次尝试', () => {
    expect(formatThinkingSuffix(65, null)).toBe('（已等待 65 秒）')
    expect(formatThinkingSuffix(65, { n: 2, total: 3 })).toBe('（第 2/3 次尝试 · 已等待 65 秒）')
  })
})

describe('人机对战（大模型）页（08 §3.3）', () => {
  let container0: HTMLElement | null = null
  afterEach(() => {
    container0 = null
  })
  it('01 配置卡与设置区可见，默认参谋模式候选、模型未配置时占位显示', async () => {
    renderPage()
    await screen.findByTestId('llm-config-card')
    expect(screen.getByText('黑方模型（对手）')).not.toBeNull()
    expect(screen.getByLabelText('引擎参谋')).not.toBeNull()
    expect((screen.getByLabelText('引擎参谋') as HTMLSelectElement).value).toBe('candidate')
    expect((screen.getByLabelText('参谋强度') as HTMLSelectElement).value).toBe('50')
    expect(screen.getByTestId('llm-display-name').textContent).toBe('大模型')
    expect(screen.getByRole('status').textContent).toContain('轮到你走棋（红方）')
  })

  it('02 已保存配置回显（掩码 Key/模型 ID）；测试连接返回结果', async () => {
    await api.secure.set('llm_config_black', {
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test-abcd',
      model: 'glm-4-flash',
      disableThinking: true
    })
    renderPage()
    await screen.findByTestId('llm-config-card')
    await waitFor(() => expect(screen.getByTestId('llm-display-name').textContent).toBe('glm-4-flash'))
    expect((screen.getByLabelText('模型 ID') as HTMLInputElement).value).toBe('glm-4-flash')
    fireEvent.click(screen.getByTestId('llm-test-connection'))
    await waitFor(() => expect(screen.getByTestId('llm-test-result').textContent).toContain('mock 连接成功'))
  })

  it('03 玩家走子 → 黑方思考 → mock 回复无效 → 重试耗尽 → 内置 AI 兜底落子并注明（全链路）', async () => {
    const { container } = renderPage()
    await screen.findByTestId('llm-config-card')
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('轮到你走棋（红方）'))
    await playCannonCentral(container)
    // 思考态出现（mock SSE 流式期间）
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('正在思考')
    )
    // mock 回复不可解析 → 3 次重试耗尽 → builtinAi 兜底 → 轮红 + 兜底注解
    await waitFor(
      () => expect(screen.getByRole('status').textContent).toContain('已由参谋（内置引擎）代走'),
      { timeout: 15_000 }
    )
    expect(screen.getByText(/当前回合：/).textContent).toContain('红方')
  }, 20_000)

  it('04 降级策略 resign：持续失败显式判负，防软死锁（防错 #7）', async () => {
    await api.store.set(LLM_SETTING_KEYS.fallbackIndex, 1) // resign
    const { container } = renderPage()
    await screen.findByTestId('llm-config-card')
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('轮到你走棋（红方）'))
    await playCannonCentral(container)
    await waitFor(
      () => expect(screen.getByRole('status').textContent).toContain('对局结束：红方获胜'),
      { timeout: 15_000 }
    )
    // 终局态优先于失败注解（Dart _statusOf 同优先级）：显式写入胜负即防软死锁。
    expect(screen.getByText('红方胜！', { selector: '.cc-result-banner' })).not.toBeNull()
  }, 20_000)

  it('05 将军态状态栏提示（轮红被将军）', async () => {
    renderPage(`/human-vs-llm?fen=${encodeURIComponent(CHECK_FEN)}`)
    await screen.findByTestId('llm-config-card')
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('红方被将军！')
    )
  })

  it('06 思考中点新游戏 → 确认后作废在途应手（不落子、解锁）', async () => {
    const { getByText, container } = renderPage()
    await screen.findByTestId('llm-config-card')
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('轮到你走棋（红方）'))
    await playCannonCentral(container)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('正在思考'))
    fireEvent.click(getByText('新游戏', { selector: 'header .cc-btn' }))
    const dialog = await screen.findByTestId('confirm-dialog')
    fireEvent.click(dialog.querySelector('.cc-btn-primary')!)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('轮到你走棋（红方）'))
    // 作废后 mock 回复不再结算：棋盘保持初始（无兜底落子）
    await new Promise((r) => setTimeout(r, 600))
    expect(screen.getByRole('status').textContent).toContain('轮到你走棋（红方）')
  }, 15_000)

  it('07 悔棋整轮：撤 AI 兜底应手与玩家一手', async () => {
    const { getByText, container } = renderPage()
    await screen.findByTestId('llm-config-card')
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('轮到你走棋（红方）'))
    await playCannonCentral(container)
    await waitFor(
      () => expect(screen.getByRole('status').textContent).toContain('已由参谋（内置引擎）代走'),
      { timeout: 15_000 }
    )
    fireEvent.click(getByText('悔棋'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('轮到你走棋（红方）'))
  }, 20_000)

  it('08 设置改动防抖 800ms 落盘（electron-store mock）', async () => {
    const storeSpy = vi.spyOn(api.store, 'set')
    renderPage()
    await screen.findByTestId('llm-config-card')
    fireEvent.change(screen.getByLabelText('空闲超时'), { target: { value: '120' } })
    // 防抖窗口内未落盘
    await new Promise((r) => setTimeout(r, 200))
    expect(await api.store.get(LLM_SETTING_KEYS.timeoutSeconds)).toBe(30)
    expect(storeSpy).not.toHaveBeenCalledWith(LLM_SETTING_KEYS.timeoutSeconds, 120)
    // 防抖到期后落盘
    await new Promise((r) => setTimeout(r, 1000))
    expect(await api.store.get(LLM_SETTING_KEYS.timeoutSeconds)).toBe(120)
  }, 15_000)

  it('09 配置加载完成前卸载：不回写存储（防错 #4）；加载完成后卸载按 Dart dispose 回写', async () => {
    // 前半：secure.get 挂起（模拟加载中）→ 卸载不得写任何配置/设置
    vi.spyOn(api.secure, 'get').mockReturnValue(new Promise(() => {}))
    const setSpy = vi.spyOn(api.secure, 'set')
    const storeSpy = vi.spyOn(api.store, 'set')
    const { unmount } = renderPage()
    await new Promise((r) => setTimeout(r, 30))
    unmount()
    await new Promise((r) => setTimeout(r, 30))
    expect(setSpy).not.toHaveBeenCalled()
    expect(storeSpy).not.toHaveBeenCalledWith(LLM_SETTING_KEYS.timeoutSeconds, expect.anything())
    // 后半：加载完成后卸载 → 按已加载值回写（human_vs_llm_page.dart dispose 语义）
    cleanup()
    vi.restoreAllMocks()
    const setSpy2 = vi.spyOn(api.secure, 'set')
    const second = renderPage()
    await second.findByTestId('llm-config-card')
    await new Promise((r) => setTimeout(r, 30))
    second.unmount()
    await new Promise((r) => setTimeout(r, 30))
    expect(setSpy2).toHaveBeenCalled()
    expect((setSpy2.mock.calls[0]![1] as { model: string }).model).toBeDefined()
  })

  it('10b 对手引擎选内置 AI：黑方由内置引擎直接应手（DR-014）', async () => {
    await api.store.set(LLM_SETTING_KEYS.humanVsLlmOpponentType, 1) // builtin
    const { container } = renderPage()
    container0 = container
    await screen.findByTestId('llm-config-card')
    expect(screen.getByTestId('llm-display-name').textContent).toBe('内置 AI')
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('轮到你走棋（红方）'))
    await playCannonCentral(container0!)
    // 内置 AI 黑方应手 → 轮红（无兜底注解，直接走子）
    await waitFor(
      () => expect(screen.getByText(/当前回合：/).textContent).toContain('红方'),
      { timeout: 20_000 }
    )
    expect(screen.queryByTestId('llm-test-result')).toBeNull()
  }, 30_000)

  it('10c 黑方未配置 → 跨页镜像红方配置（DR-014）：测试连接测红方', async () => {
    // 红方槽位有配置（模拟大模型对战页保存过红方），黑方槽位为空
    await api.secure.delete('llm_config_black')
    await api.secure.set('llm_config_red', {
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test-abcd',
      model: 'glm-4-flash',
      disableThinking: true
    })
    renderPage()
    await screen.findByTestId('llm-config-card')
    // 显示镜像提示；对手名来自红方配置
    await waitFor(() => expect(screen.getByTestId('black-crosspage-hint')).not.toBeNull())
    await waitFor(() => expect(screen.getByTestId('llm-display-name').textContent).toBe('glm-4-flash'))
    // 测试连接走红方槽位（mock 返回成功）
    fireEvent.click(screen.getByTestId('llm-test-connection'))
    await waitFor(() => expect(screen.getByTestId('llm-test-result').textContent).toContain('mock 连接成功'))
  }, 20_000)

  it('10 残局来源：不显示"保存棋局"（防错 #6），黑先残局模型先行', async () => {
    const blackFirst = '4k4/9/9/9/9/9/4C4/9/4C4/4K4 b - - 0 1'
    const { container, getByText } = renderPage(`/human-vs-llm?fen=${encodeURIComponent(blackFirst)}`)
    await screen.findByTestId('llm-config-card')
    expect(screen.queryByText('保存棋局', { selector: 'header .cc-btn' })).toBeNull()
    // 黑先 → 模型先应手（mock 无效 → 兜底落子）→ 轮红
    await waitFor(
      () => expect(screen.getByRole('status').textContent).toContain('已由参谋（内置引擎）代走'),
      { timeout: 15_000 }
    )
    void container
    void getByText
    expect(screen.getByText(/当前回合：/).textContent).toContain('红方')
  }, 20_000)
})
