/**
 * 工作室 LLM 求解辅助编排测试（T6.4，_runLlmAssist 等价集）：
 * 未配置静默跳过 / 验证通过写入注释 / 未通过注明已忽略 / 无效提议 / 调用失败。
 */
import { describe, expect, it } from 'vitest'
import { runSolveAssist, type SolveAssistContext } from '@renderer/features/studio/llmAssist'
import type { LlmTransport } from '@packages/llm'

const FEN_A = '3k5/9/9/9/R8/8R/9/9/9/4K4 w - - 0 1'
const OPTIONS = { timeLimitMs: 30_000, maxPlies: 9 }

const config = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk', model: 'glm-4.5v', disableThinking: true }

/** 可编程单次回包传输。 */
function oneShot(response: string): LlmTransport {
  return {
    chat(_req, handlers) {
      queueMicrotask(() => handlers.onDone(response))
      return Promise.resolve()
    },
    cancel: () => Promise.resolve()
  }
}

const reply = '首选着法: a4-d4\n备选着法: 无\n思路: 平车闷杀'

describe('runSolveAssist（LLM 提议 → 求解器验证 → llmNote）', () => {
  it('配置为 null → null（静默跳过，不产生注释）', async () => {
    const note = await runSolveAssist(FEN_A, OPTIONS, async () => true, {
      config: null,
      transport: oneShot(reply)
    })
    expect(note).toBeNull()
  })

  it('验证通过：llmNote = "大模型首选 a4-d4（已验证为必胜着法）；思路: …"', async () => {
    const ctx: SolveAssistContext = { config, transport: oneShot(reply), authSlot: 'llm_config_assistant' }
    const note = await runSolveAssist(FEN_A, OPTIONS, async (_fen, move) => {
      expect(move.from).toEqual({ col: 0, row: 4 })
      expect(move.to).toEqual({ col: 3, row: 4 })
      return true
    }, ctx)
    expect(note).toBe('大模型首选 a4-d4（已验证为必胜着法）；思路: 平车闷杀')
  })

  it('验证未通过：注明"未通过求解器验证，已忽略"（思路保留）', async () => {
    const ctx: SolveAssistContext = { config, transport: oneShot(reply) }
    const note = await runSolveAssist(FEN_A, OPTIONS, async () => false, ctx)
    expect(note).toBe('大模型首选 a4-d4 未通过求解器验证，已忽略；思路: 平车闷杀')
  })

  it('无有效提议：说明原因', async () => {
    const ctx: SolveAssistContext = {
      config,
      transport: oneShot('首选着法: z9-z9\n思路: 无')
    }
    const note = await runSolveAssist(FEN_A, OPTIONS, async () => true, ctx)
    expect(note).toContain('大模型辅助未给出有效提议（')
    expect(note).toContain('不在合法清单中')
  })

  it('调用失败：与原版一致在重试循环内捕获 → "未给出有效提议（原因）"（求解照常进行）', async () => {
    const failing: LlmTransport = {
      chat(_req, handlers) {
        queueMicrotask(() => handlers.onError('连接失败：ECONNREFUSED'))
        return Promise.resolve()
      },
      cancel: () => Promise.resolve()
    }
    const note = await runSolveAssist(FEN_A, OPTIONS, async () => true, { config, transport: failing })
    expect(note).toBe('大模型辅助未给出有效提议（连接失败：ECONNREFUSED）')
  })
})
