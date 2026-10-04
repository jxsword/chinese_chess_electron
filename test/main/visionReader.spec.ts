/**
 * 主进程 VisionReader 集成测试（T6.3，05 §7）：
 * 真实 undici（Node fetch）+ mock HTTP 服务器——
 * 成功解析 / 失败重试（坏 JSON→第二次成功）/ HTTP≠200 / 超时 / 双王失败重试 /
 * 重试耗尽 LlmApiError / authSlot 掩码 Key 注入（DR-010）。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { LlmApiError } from '@packages/llm'
import { VisionReader } from '@main/services/visionReader'
import { startMockSseServer, sleep, type MockSseServer } from './helpers/mockLlmServer'

const servers: MockSseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

const okJson = JSON.stringify({
  turn: 'red',
  pieces: [
    { col: 'd', row: '0', piece: 'k' },
    { col: 'e', row: '9', piece: 'K' }
  ]
})

/** 以非流式 JSON 回包（fetch().json() 不校验 content-type）。 */
function replyJson(api: { respond: (s: number) => void; write: (t: string) => Promise<void>; end: () => void }, body: string, status = 200): Promise<void> {
  void (async () => {
    if (status !== 200) api.respond(status)
    else api.respond(200)
    await api.write(body)
    api.end()
  })()
  return Promise.resolve()
}

const req = (baseUrl: string, apiKey = '', authSlot?: 'llm_config_assistant') => ({
  config: {
    baseUrl,
    apiKey,
    model: 'glm-4.5v',
    disableThinking: true
  },
  imageBase64: 'AAA',
  mime: 'image/png' as const,
  authSlot
})

describe('VisionReader（真实 fetch 路径）', () => {
  it('成功：返回组装 FEN（轮走方随识别结果）', async () => {
    const server = await startMockSseServer(async (_req, api) => {
      await replyJson(api, JSON.stringify({ choices: [{ message: { content: okJson } }] }))
    })
    servers.push(server)
    const reader = new VisionReader()
    const result = await reader.readBoard(req(server.url, 'sk-real'))
    expect(result.fen).toBe('3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1')
    expect(server.requests).toHaveLength(1)
    const body = JSON.parse(server.requests[0]!.body) as { temperature: number; stream?: boolean }
    expect(body.temperature).toBe(0.1)
    expect(body.stream).toBeUndefined()
  })

  it('首次坏 JSON / 双王失败 → 重试后成功（请求共 2 次）', async () => {
    let calls = 0
    const server = await startMockSseServer(async (_req, api) => {
      calls++
      if (calls === 1) {
        await replyJson(api, JSON.stringify({ choices: [{ message: { content: '抱歉无法识别' } }] }))
      } else {
        await replyJson(api, JSON.stringify({ choices: [{ message: { content: okJson } }] }))
      }
    })
    servers.push(server)
    const reader = new VisionReader()
    const result = await reader.readBoard(req(server.url))
    expect(result.fen).toContain('4K4')
    expect(server.requests).toHaveLength(2)
  })

  it('HTTP 500：截取响应体进错误消息并重试，耗尽抛 LlmApiError', async () => {
    const server = await startMockSseServer(async (_req, api) => {
      await replyJson(api, '上游模型过载', 500)
    })
    servers.push(server)
    const reader = new VisionReader()
    const error = await reader.readBoard(req(server.url)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmApiError)
    expect((error as Error).message).toMatch(/已重试 2 次仍失败：HTTP 500/)
    expect(server.requests).toHaveLength(2)
  })

  it('超时：注入 50ms 短超时 → 用户可操作提示', async () => {
    const server = await startMockSseServer(async (_req, api) => {
      await sleep(300)
      await replyJson(api, JSON.stringify({ choices: [{ message: { content: okJson } }] }))
    })
    servers.push(server)
    const reader = new VisionReader({ timeoutMs: 50 })
    await expect(reader.readBoard(req(server.url))).rejects.toThrow(
      /已重试 2 次仍失败：请求超时（0s）。大模型思维链过慢或网络较差/
    )
  })

  it('authSlot + 掩码 Key：主进程注入真实 Authorization（DR-010）', async () => {
    const server = await startMockSseServer(async (r, api) => {
      expect(r.headers['authorization']).toBe('Bearer sk-real-key')
      await replyJson(api, JSON.stringify({ choices: [{ message: { content: okJson } }] }))
    })
    servers.push(server)
    const reader = new VisionReader({
      resolveApiKey: (slot) => (slot === 'llm_config_assistant' ? 'sk-real-key' : null)
    })
    const result = await reader.readBoard(req(server.url, '****abcd', 'llm_config_assistant'))
    expect(result.fen).toContain('4K4')
  })

  it('端点未配置：构建期直接抛错（不发起请求）', async () => {
    const reader = new VisionReader()
    await expect(reader.readBoard(req(''))).rejects.toThrow(/视觉模型未配置/)
  })
})
