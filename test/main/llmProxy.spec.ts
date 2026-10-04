/**
 * 主进程 llm-proxy 集成测试（T4.1，09 §2.3/§2.4）：
 * mock SSE 服务器 + 真实 undici（Node fetch）路径——
 * 块序完整 / 跨分包行重组 / 空闲计时器重置 / 总上限 / cancel → abort /
 * HTTP≠200 + annotateModelHint / chunk.error / 思维链退回 / authSlot 注入。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { LlmProxy, type LlmProxySender } from '@main/services/llm-proxy'
import {
  startMockSseServer,
  sseData,
  sleep,
  type MockSseServer
} from './helpers/mockLlmServer'
import type { LlmDelta } from '@shared/ipc/types'

const servers: MockSseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

function makeProxy(resolveApiKey?: (slot: string) => string | null): LlmProxy {
  return new LlmProxy({ getTimeoutSeconds: () => 60, resolveApiKey })
}

interface Collector {
  chunks: LlmDelta[]
  done: string[]
  errors: string[]
  sender: LlmProxySender
}

function makeCollector(): Collector {
  const collector: Collector = {
    chunks: [],
    done: [],
    errors: [],
    sender: {
      sendChunk: (_id, delta) => collector.chunks.push(delta),
      sendDone: (_id, text) => collector.done.push(text),
      sendError: (_id, message) => collector.errors.push(message)
    }
  }
  return collector
}

const chatReq = (url: string, body = '{}'): {
  requestId: string
  url: string
  headers: Record<string, string>
  body: string
} => ({
  requestId: 'r1',
  url,
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body
})

describe('llm-proxy（真实 undici 流式路径）', () => {
  it('正常增量 + [DONE]：chunk 逐块转发、顺序完整、done 为全量正文', async () => {
    const server = await startMockSseServer(async (_req, api) => {
      await api.write(sseData('{"choices":[{"delta":{"content":"着法"}}]}'))
      await api.write(sseData('{"choices":[{"delta":{"content":": b2-e2"}}]}'))
      await api.write(sseData('[DONE]'))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy()
    const c = makeCollector()
    await proxy.chat(chatReq(`${server.url}/v1/chat/completions`), c.sender)
    expect(c.errors).toEqual([])
    expect(c.chunks.map((d) => d.content).join('')).toBe('着法: b2-e2')
    expect(c.done).toEqual(['着法: b2-e2'])
    expect(proxy.size).toBe(0)
  })

  it('一行 SSE 跨多个 TCP 分包 / 半行到达：按行重组不丢字', async () => {
    const server = await startMockSseServer(async (_req, api) => {
      // 一行拆三段写（含中文多字节边界），最后补 \n
      await api.write('data: {"choices":[{"del')
      await api.write('ta":{"content":"炮二平五，马8进7，用半个')
      await api.write('「着法: h2-e2」"}}]}\n\n')
      await api.write(sseData('[DONE]'))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy()
    const c = makeCollector()
    await proxy.chat(chatReq(server.url), c.sender)
    expect(c.errors).toEqual([])
    expect(c.chunks.map((d) => d.content).join('')).toBe('炮二平五，马8进7，用半个「着法: h2-e2」')
    expect(c.done[0]).toContain('炮二平五')
  })

  it('块间间隔小于空闲超时：计时器逐块重置，不误判', async () => {
    const server = await startMockSseServer(async (_req, api) => {
      for (let i = 0; i < 4; i++) {
        await sleep(80)
        await api.write(sseData(`{"choices":[{"delta":{"content":"块${i}"}}]}`))
      }
      await api.write(sseData('[DONE]'))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy()
    const c = makeCollector()
    // 空闲 150ms > 块间 80ms；总上限 600ms > 全程 ~320ms+结算，安全完成
    await proxy.chat(chatReq(server.url), c.sender, { idleTimeoutMs: 150 })
    expect(c.errors).toEqual([])
    expect(c.chunks.length).toBe(4)
    expect(c.done[0]).toBe('块0块1块2块3')
  })

  it('空闲超时：块间最大间隔超限 → error 含「空闲超时」并中止', async () => {
    const server = await startMockSseServer(async (_req, api) => {
      await api.write(sseData('{"choices":[{"delta":{"content":"首块"}}]}'))
      await sleep(500) // 远超空闲 120ms
      await api.write(sseData('[DONE]'))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy()
    const c = makeCollector()
    await proxy.chat(chatReq(server.url), c.sender, { idleTimeoutMs: 120 })
    expect(c.done).toEqual([])
    expect(c.errors.length).toBe(1)
    expect(c.errors[0]).toContain('空闲超时')
    expect(c.errors[0]).toContain('内无响应数据')
    expect(c.errors[0]).toContain('可在对局设置中调大')
  })

  it('总耗时上限 = 空闲 × 4：持续吐块仍会被总计时器截断', async () => {
    const server = await startMockSseServer(async (_req, api) => {
      // 每块间隔 50ms（< 空闲 100ms，不触发空闲超时），共 12 块 ≈ 600ms
      // 总上限 400ms 将先触发
      for (let i = 0; i < 12; i++) {
        await sleep(50)
        await api.write(sseData(`{"choices":[{"delta":{"content":"${i}"}}]}`))
      }
      await api.write(sseData('[DONE]'))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy()
    const c = makeCollector()
    await proxy.chat(chatReq(server.url), c.sender, { idleTimeoutMs: 100 })
    expect(c.done).toEqual([])
    expect(c.errors.length).toBe(1)
    expect(c.errors[0]).toContain('总耗时超过 0s')
    expect(c.errors[0]).toContain('关闭思维链')
  }, 10000)

  it('cancel：abort 后不再有任何事件，chat promise 正常返回', async () => {
    const server = await startMockSseServer(async (_req, api) => {
      for (let i = 0; i < 10; i++) {
        await sleep(70)
        await api.write(sseData(`{"choices":[{"delta":{"content":"${i}"}}]}`))
      }
      await api.write(sseData('[DONE]'))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy()
    const c = makeCollector()
    const finished = proxy.chat(chatReq(server.url), c.sender, { idleTimeoutMs: 5000 })
    await sleep(120) // 收到 1~2 块
    expect(c.chunks.length).toBeGreaterThanOrEqual(1)
    proxy.cancel('r1')
    await finished
    const countAtCancel = c.chunks.length
    await sleep(250)
    expect(c.chunks.length).toBe(countAtCancel) // 无迟到块
    expect(c.done).toEqual([])
    expect(c.errors).toEqual([])
    expect(proxy.size).toBe(0)
  })

  it('cancel 未知 requestId 幂等', async () => {
    const proxy = makeProxy()
    expect(() => proxy.cancel('nope')).not.toThrow()
  })

  it('HTTP 500：响应体进错误消息 + 翻译模型误用提示', async () => {
    const server = await startMockSseServer(async (req, api) => {
      void req
      api.respond(500, { 'Content-Type': 'application/json' })
      await api.write(JSON.stringify({ error: 'Streaming translation is not supported' }))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy()
    const c = makeCollector()
    await proxy.chat(chatReq(server.url), c.sender)
    expect(c.done).toEqual([])
    expect(c.errors.length).toBe(1)
    expect(c.errors[0]).toContain('HTTP 500')
    expect(c.errors[0]).toContain('Streaming translation is not supported')
    expect(c.errors[0]).toContain('翻译模型（qwen-mt-* 系列）') // annotateModelHint
  })

  it('HTTP 4xx 长响应体：截取前 160 字符 + 省略号', async () => {
    const longBody = 'x'.repeat(300) + 'marker-that-must-not-appear'
    const server = await startMockSseServer((_req, api) => {
      api.respond(400, { 'Content-Type': 'text/plain' })
      api.end(longBody)
    })
    servers.push(server)
    const proxy = makeProxy()
    const c = makeCollector()
    await proxy.chat(chatReq(server.url), c.sender)
    expect(c.done).toEqual([])
    expect(c.errors.length).toBe(1)
    expect(c.errors[0]).toContain('HTTP 400')
    expect(c.errors[0]!.length).toBeLessThan(longBody.length)
    expect(c.errors[0]).not.toContain('marker-that-must-not-appear')
    expect(c.errors[0]!.endsWith('…')).toBe(true)
  })

  it('流中 chunk.error → error（流式响应错误）', async () => {
    const server = await startMockSseServer(async (_req, api) => {
      await api.write(sseData('{"choices":[{"delta":{"content":"ok"}}]}'))
      await api.write(sseData('{"error":{"message":"server exploded"}}'))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy()
    const c = makeCollector()
    await proxy.chat(chatReq(server.url), c.sender)
    expect(c.errors.length).toBe(1)
    expect(c.errors[0]).toContain('流式响应错误')
    expect(c.errors[0]).toContain('server exploded')
    expect(c.done).toEqual([])
  })

  it('正文为空 → done 退回思维链全文（思考型 token 耗尽）', async () => {
    const server = await startMockSseServer(async (_req, api) => {
      await api.write(sseData('{"choices":[{"delta":{"reasoning_content":"先看中路…"}}]}'))
      await api.write(sseData('{"choices":[{"delta":{"reasoning_content":"着法: b2-e2"}}]}'))
      await api.write(sseData('[DONE]'))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy()
    const c = makeCollector()
    await proxy.chat(chatReq(server.url), c.sender)
    expect(c.errors).toEqual([])
    expect(c.done[0]).toBe('先看中路…着法: b2-e2')
    expect(c.chunks.map((d) => d.reasoning ?? '').join('')).toBe('先看中路…着法: b2-e2')
  })

  it('无 [DONE] 流自然结束：仍以已累积内容结算 done', async () => {
    const server = await startMockSseServer(async (_req, api) => {
      await api.write(sseData('{"choices":[{"delta":{"content":"着法: e3-e0"}}]}'))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy()
    const c = makeCollector()
    await proxy.chat(chatReq(server.url), c.sender)
    expect(c.errors).toEqual([])
    expect(c.done).toEqual(['着法: e3-e0'])
  })

  it('连接拒绝 → error（连接失败）', async () => {
    // 占住一个端口再关掉：拿到"确定没人听"的端口
    const server = await startMockSseServer(() => {})
    const deadUrl = server.url
    await server.close()
    const idx = servers.indexOf(server)
    if (idx >= 0) servers.splice(idx, 1)

    const proxy = makeProxy()
    const c = makeCollector()
    await proxy.chat(chatReq(deadUrl), c.sender)
    expect(c.done).toEqual([])
    expect(c.errors.length).toBe(1)
    expect(c.errors[0]).toContain('连接失败')
  })

  it('并发请求按 requestId 隔离，互不串流', async () => {
    const server = await startMockSseServer(async (req, api) => {
      const who = req.url?.includes('red') ? '红方: b2-e2' : '黑方: h2-e2'
      await api.write(sseData(`{"choices":[{"delta":{"content":"${who}"}}]}`))
      await api.write(sseData('[DONE]'))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy()
    const cA = makeCollector()
    const cB = makeCollector()
    await Promise.all([
      proxy.chat({ ...chatReq(`${server.url}/red`), requestId: 'red' }, cA.sender),
      proxy.chat({ ...chatReq(`${server.url}/black`), requestId: 'black' }, cB.sender)
    ])
    expect(cA.done[0]).toBe('红方: b2-e2')
    expect(cB.done[0]).toBe('黑方: h2-e2')
    expect(cA.errors).toEqual([])
    expect(cB.errors).toEqual([])
  })

  it('authSlot：主进程注入真实 Authorization；槽位无 Key 时剔除掩码头', async () => {
    const seenAuth: Array<string | undefined> = []
    const server = await startMockSseServer(async (req, api) => {
      seenAuth.push(req.headers.authorization)
      await api.write(sseData('[DONE]'))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy((slot) => (slot === 'llm_config_black' ? 'sk-real-9999' : null))
    const c = makeCollector()
    await proxy.chat(
      {
        ...chatReq(`${server.url}/a`),
        authSlot: 'llm_config_black',
        headers: { 'Content-Type': 'application/json' }
      },
      c.sender
    )
    await proxy.chat(
      {
        ...chatReq(`${server.url}/b`),
        authSlot: 'llm_config_red', // 槽位无 Key
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ****abcd' }
      },
      c.sender
    )
    expect(seenAuth[0]).toBe('Bearer sk-real-9999')
    expect(seenAuth[1]).toBeUndefined()
    expect(c.errors).toEqual([])
    expect(c.done.length).toBe(2)
  })

  it('testConnection：错误消息为真实错误而非 requestId（遮蔽回归）', async () => {
    const server = await startMockSseServer((_req, api) => {
      api.respond(400, { 'Content-Type': 'text/plain' })
      api.end('Streaming translation is not supported')
    })
    servers.push(server)
    const proxy = makeProxy(() => 'sk-real')
    const res = await proxy.testConnection(
      { baseUrl: server.url, apiKey: '****abcd', model: 'm', disableThinking: true },
      'llm_config_black'
    )
    expect(res.ok).toBe(false)
    expect(res.message).toContain('HTTP 400')
    expect(res.message).toContain('翻译模型')
    expect(res.message).not.toContain('test-conn')
  })

  it('testConnection：端点未配置 → 构建期错误直接作为失败消息', async () => {
    const proxy = makeProxy()
    const res = await proxy.testConnection({ baseUrl: '', apiKey: '', model: '', disableThinking: true })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('模型端点未配置')
  })

  it('渲染层自持完整 Key（无 authSlot）：鉴权头原样透传', async () => {
    let seenAuth: string | undefined
    const server = await startMockSseServer(async (req, api) => {
      seenAuth = req.headers.authorization
      await api.write(sseData('[DONE]'))
      api.end()
    })
    servers.push(server)
    const proxy = makeProxy(() => 'should-not-be-used')
    const c = makeCollector()
    await proxy.chat(
      { ...chatReq(server.url), headers: { Authorization: 'Bearer sk-inline' } },
      c.sender
    )
    expect(seenAuth).toBe('Bearer sk-inline')
  })
})
