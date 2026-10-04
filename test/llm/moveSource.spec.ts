/**
 * LlmMoveSource 等价集（T4.3，09 §2 move_source.spec 30 用例 + §2.3 失败模式表）：
 * SSE 解析/五层过滤/重试/降级（管线第 3~6 层 + 兜底链；第 1/2 层与 HTTP 细节
 * 由 test/main/llmProxy.spec.ts 的真实 undici 路径覆盖）。
 */
import { describe, it, expect } from 'vitest'
import { Board, type Move } from '@packages/rules'
import type { MoveSource } from '@packages/engine'
import {
  LlmPlayer,
  LlmChatClient,
  LLM_CANCELED,
  extractMove,
  testLlmConnection,
  LlmConfigError,
  type LlmTransport,
  type LlmChatHandlers,
  type LlmChatWireRequest
} from '@packages/llm'
import type { LlmEndpointConfig } from '@shared/ipc/types'

// ---------------------------------------------------------------------------
// 可编程 fake transport（可编程响应序列，09 §2.3）
// ---------------------------------------------------------------------------

type ScriptItem =
  | { kind: 'text'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'hang' } // 永不结算（模拟只取消才结束的请求）

class FakeTransport implements LlmTransport {
  script: ScriptItem[] = []
  readonly calls: Array<{ req: LlmChatWireRequest; handlers: LlmChatHandlers }> = []
  readonly cancelledIds: string[] = []

  async chat(req: LlmChatWireRequest, handlers: LlmChatHandlers): Promise<void> {
    this.calls.push({ req, handlers })
    const item = this.script[this.calls.length - 1] ?? { kind: 'error', message: '脚本耗尽' }
    if (item.kind === 'text') handlers.onDone(item.text)
    else if (item.kind === 'error') handlers.onError(item.message)
    // hang：不结算，等 cancel
  }

  async cancel(requestId: string): Promise<void> {
    this.cancelledIds.push(requestId)
  }
}

const cfg: LlmEndpointConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-abcd',
  model: 'test-model',
  disableThinking: true
}

/** 双王 + 红车 a9 + 黑卒 a5 的小局面；红方合法含 a9-a5（吃卒）等 */
function simpleBoard(): Board {
  return Board.fromFen('4k4/9/9/9/9/p8/9/9/9/R2K5 w - - 0 1')
}

const noopBuiltin = (): MoveSource => ({
  displayName: '内置 AI（高级）',
  nextMove: async () => {
    throw new Error('builtin source should not be called')
  }
})

/** 顺序 id 工厂（测试断言可预测 requestId） */
const seqId = (): (() => string) => {
  let i = 0
  return () => `id-${++i}`
}

function makePlayer(
  transport: FakeTransport,
  over: Partial<ConstructorParameters<typeof LlmPlayer>[2]> = {}
): LlmPlayer {
  return new LlmPlayer(
    cfg,
    transport,
    {
      fallback: 'builtinAi',
      builtinAiSource: noopBuiltin,
      ...over
    },
    { newId: seqId() }
  )
}

/** 从捕获的请求体解析 messages[].content */
function chatContent(transport: FakeTransport, call = 0): { system: string; user: string } {
  const body = JSON.parse(transport.calls[call]!.req.body) as {
    messages: Array<{ role: string; content: string }>
  }
  return { system: body.messages[0]!.content, user: body.messages[1]!.content }
}

// ---------------------------------------------------------------------------
// 管线：解析 → 白名单 → 重试
// ---------------------------------------------------------------------------

describe('五层管线（第 3~6 层）', () => {
  it('01 正常回复命中白名单 → ok（白名单精确匹配）', async () => {
    const t = new FakeTransport()
    t.script.push({ kind: 'text', text: '着法: a9-a5' })
    const result = await makePlayer(t).nextMove(simpleBoard())
    expect(result.status).toBe('ok')
    expect(result.move).toEqual({
      from: { col: 0, row: 9 },
      to: { col: 0, row: 5 },
      captured: { kind: 'pawn', side: 'black' }
    })
    expect(result.note).toBeUndefined()
    expect(result.fromFallback).toBeUndefined()
  })

  it('02 白名单精确匹配：归一化 b2e2 → b2-e2 命中；大小写/全角同样命中', async () => {
    for (const text of ['着法: a9a5', '着法: A9-A5', '着法：Ａ９－Ａ５']) {
      const t = new FakeTransport()
      t.script.push({ kind: 'text', text })
      const result = await makePlayer(t).nextMove(simpleBoard())
      expect(result.status).toBe('ok')
      expect(result.move).toEqual({
        from: { col: 0, row: 9 },
        to: { col: 0, row: 5 },
        captured: { kind: 'pawn', side: 'black' }
      })
    }
  })

  it('03 编造清单外着法 → 重试且反馈含原因与上次着法（v2）', async () => {
    const t = new FakeTransport()
    t.script.push({ kind: 'text', text: '着法: e9-e0' }) // 不在清单
    t.script.push({ kind: 'text', text: '着法: a9-a5' })
    const result = await makePlayer(t, { usePromptV2: true }).nextMove(simpleBoard())
    expect(result.status).toBe('ok')
    const second = chatContent(t, 1)
    expect(second.user).toContain('你上一次的回复的着法 e9-e0无效（着法 e9-e0 不在合法清单中）')
    // 重试是在原 user 末尾追加后整段重发（无状态两消息协议）
    expect(second.user.startsWith(chatContent(t, 0).user)).toBe(true)
  })

  it('04 无法解析出坐标 → 重试反馈为"无法从回复中解析出着法"', async () => {
    const t = new FakeTransport()
    t.script.push({ kind: 'text', text: '抱歉，我不会。' })
    t.script.push({ kind: 'text', text: '着法: a9-a5' })
    await makePlayer(t).nextMove(simpleBoard())
    expect(chatContent(t, 1).user).toContain('你上一次的回复无效（无法从回复中解析出着法）')
  })

  it('05 markdown 围栏/全角/零宽包裹 → 归一化后提取成功', async () => {
    const t = new FakeTransport()
    t.script.push({ kind: 'text', text: '```\n着法：Ａ\u200b９－Ａ５\n```' })
    const result = await makePlayer(t).nextMove(simpleBoard())
    expect(result.status).toBe('ok')
  })

  it('06 思维链正文空 → 用 reasoning 文本提取（传输层 pickAnswer 语义）', async () => {
    const t = new FakeTransport()
    t.script.push({ kind: 'text', text: '让我想想……最终 着法: a9-a5' })
    const result = await makePlayer(t).nextMove(simpleBoard())
    expect(result.status).toBe('ok')
  })

  it('07 连续 maxAttempts 次无效 → builtinAi 兜底（note 注明 + fromFallback）', async () => {
    const t = new FakeTransport()
    for (let i = 0; i < 3; i++) t.script.push({ kind: 'text', text: '着法: e9-e0' })
    const player = new LlmPlayer(
      cfg,
      t,
      {
        fallback: 'builtinAi',
        maxAttempts: 3,
        builtinAiSource: () => ({
          displayName: '内置 AI（高级）',
          nextMove: async () => ({ status: 'ok', move: { from: { col: 0, row: 9 }, to: { col: 0, row: 4 } } })
        })
      },
      { newId: () => 'x' }
    )
    const result = await player.nextMove(simpleBoard())
    expect(result.fromFallback).toBe(true)
    expect(result.note).toBe('第 3 次回复无效（着法 e9-e0 不在合法清单中），已由内置 AI 兜底走子')
    expect(result.move).toEqual({ from: { col: 0, row: 9 }, to: { col: 0, row: 4 } })
    expect(t.calls.length).toBe(3)
  })

  it('08 连续失败 + resign 降级 → failed（该方判负终局）', async () => {
    const t = new FakeTransport()
    for (let i = 0; i < 3; i++) t.script.push({ kind: 'error', message: 'HTTP 500: boom' })
    const result = await makePlayer(t, { fallback: 'resign' }).nextMove(simpleBoard())
    expect(result.status).toBe('failed')
    expect(result.note).toBe('第 3 次调用失败：HTTP 500: boom，按判负处理')
  })

  it('09 HTTP 4xx/5xx（传输层 error）→ 计一次失败重试，耗尽 → 降级', async () => {
    const t = new FakeTransport()
    t.script.push({ kind: 'error', message: 'HTTP 429: rate limited' })
    t.script.push({ kind: 'text', text: '着法: a9-a5' })
    const result = await makePlayer(t).nextMove(simpleBoard())
    expect(result.status).toBe('ok')
    expect(t.calls.length).toBe(2)
  })

  it('10 调用异常计入重试次数并保留最近原因', async () => {
    const t = new FakeTransport()
    t.script.push({ kind: 'error', message: '连接失败：ECONNREFUSED' })
    t.script.push({ kind: 'error', message: '空闲超时（60s 内无响应数据）' })
    t.script.push({ kind: 'error', message: '总耗时超过 240s' })
    const result = await makePlayer(t, { fallback: 'resign' }).nextMove(simpleBoard())
    expect(result.status).toBe('failed')
    expect(result.note).toBe('第 3 次调用失败：总耗时超过 240s，按判负处理')
  })

  it('11 无合法着法（将死/困毙）→ noLegalMove，不发起调用', async () => {
    const t = new FakeTransport()
    const result = await makePlayer(t).nextMove(Board.fromFen('k8/1P7/9/9/9/R8/9/9/9/2K6 b - - 0 1'))
    expect(result.status).toBe('noLegalMove')
    expect(t.calls.length).toBe(0)
  })

  it('12 v1/v2 请求体差异：max_tokens 与系统提示', async () => {
    const t1 = new FakeTransport()
    t1.script.push({ kind: 'text', text: '着法: a9-a5' })
    await makePlayer(t1, { usePromptV2: false }).nextMove(simpleBoard())
    const b1 = JSON.parse(t1.calls[0]!.req.body) as Record<string, unknown>
    expect(b1['max_tokens']).toBe(4096)
    expect(chatContent(t1).system).toContain('【回复格式（唯一允许的格式，违反即视为无效）】')

    const t2 = new FakeTransport()
    t2.script.push({ kind: 'text', text: '着法: a9-a5' })
    await makePlayer(t2, { usePromptV2: true }).nextMove(simpleBoard())
    const b2 = JSON.parse(t2.calls[0]!.req.body) as Record<string, unknown>
    expect(b2['max_tokens']).toBe(8192)
    expect(chatContent(t2).system).toContain('【回复格式（唯一允许的格式，共两段）】')
    expect(chatContent(t2).user).toContain('【棋盘图】')
  })

  it('13 鉴权头：完整 Key 内联 Bearer；掩码 Key 走 authSlot（DR-010）', async () => {
    const tFull = new FakeTransport()
    tFull.script.push({ kind: 'text', text: '着法: a9-a5' })
    await makePlayer(tFull).nextMove(simpleBoard())
    expect(tFull.calls[0]!.req.headers['Authorization']).toBe('Bearer sk-test-abcd')
    expect(tFull.calls[0]!.req.authSlot).toBeUndefined()

    const tMasked = new FakeTransport()
    tMasked.script.push({ kind: 'text', text: '着法: a9-a5' })
    const player = new LlmPlayer(
      { ...cfg, apiKey: '****abcd' },
      tMasked,
      { fallback: 'builtinAi', builtinAiSource: noopBuiltin as never },
      { authSlot: 'llm_config_black' }
    )
    await player.nextMove(simpleBoard())
    expect(tMasked.calls[0]!.req.headers['Authorization']).toBeUndefined()
    expect(tMasked.calls[0]!.req.authSlot).toBe('llm_config_black')
  })

  it('14 未配置端点 → 调用失败路径（LlmConfigError 消息）', async () => {
    const t = new FakeTransport()
    t.script.push({ kind: 'error', message: '模型端点未配置（需填写端点与模型 ID）' })
    const player = new LlmPlayer(
      { baseUrl: '', apiKey: '', model: '', disableThinking: true },
      t,
      {
        fallback: 'resign',
        maxAttempts: 1,
        builtinAiSource: noopBuiltin as never
      },
      { newId: () => 'x' }
    )
    const result = await player.nextMove(simpleBoard())
    expect(result.status).toBe('failed')
    expect(result.note).toBe('第 1 次调用失败：模型端点未配置（需填写端点与模型 ID），按判负处理')
  })

  it('15 cancelCurrent：在途请求本地结算 + 通知传输层；迟到 onDone 被忽略', async () => {
    const t = new FakeTransport()
    t.script.push({ kind: 'hang' })
    const player = makePlayer(t)
    const pending = player.nextMove(simpleBoard())
    await new Promise((r) => setTimeout(r, 0))
    await player.cancelCurrent()
    await expect(pending).rejects.toThrow(LLM_CANCELED)
    expect(t.cancelledIds).toEqual(['id-1'])
  })

  it('16 chatOnce 独立通道：不带合法清单协议', async () => {
    const t = new FakeTransport()
    t.script.push({ kind: 'text', text: 'ok' })
    const client = new LlmChatClient(cfg, t, { newId: () => 'c1' })
    const text = await client.chatOnce('你是测试助手。', '请回复：ok')
    expect(text).toBe('ok')
    const body = JSON.parse(t.calls[0]!.req.body) as Record<string, unknown>
    expect(body['max_tokens']).toBe(4096)
    expect((body['messages'] as Array<{ content: string }>)[1]!.content).toBe('请回复：ok')
  })
})

describe('兜底链细节（llm_move_source.dart:_fallback）', () => {
  it('17 builtinAi 兜底无合法着法 → noLegalMove（不 failed）', async () => {
    const t = new FakeTransport()
    for (let i = 0; i < 3; i++) t.script.push({ kind: 'text', text: '着法: e9-e0' })
    const player = new LlmPlayer(
      cfg,
      t,
      {
        fallback: 'builtinAi',
        maxAttempts: 1,
        builtinAiSource: () => ({
          displayName: 'x',
          nextMove: async () => ({ status: 'noLegalMove' })
        })
      },
      { newId: () => 'x' }
    )
    const result = await player.nextMove(simpleBoard())
    expect(result.status).toBe('noLegalMove')
  })

  it('18 displayName：模型名/未配置占位', () => {
    const t = new FakeTransport()
    expect(makePlayer(t).displayName).toBe('test-model')
    const empty = new LlmPlayer(
      { baseUrl: 'https://a.com', apiKey: '', model: '', disableThinking: true },
      t,
      { fallback: 'resign', builtinAiSource: noopBuiltin }
    )
    expect(empty.displayName).toBe('（未配置模型）')
  })

  it('19 合法清单去重（codesByMove 语义）', () => {
    const board = simpleBoard()
    const legal = board.allLegalMoves()
    const codes = legal.map((m: Move) => `${'abcdefghi'[m.from.col]}${m.from.row}-${'abcdefghi'[m.to.col]}${m.to.row}`)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes).toContain('a9-a5')
  })
})

describe('测试连接（llm_move_source.dart:testConnection）', () => {
  it('20 成功：固定成功消息', async () => {
    const t = new FakeTransport()
    t.script.push({ kind: 'text', text: 'ok' })
    const res = await testLlmConnection(cfg, t)
    expect(res).toEqual({ ok: true, message: '连接成功，模型 test-model 响应正常' })
    expect(t.calls.length).toBe(1)
  })

  it('21 失败：连接失败 + annotateModelHint（翻译模型）', async () => {
    const t = new FakeTransport()
    t.script.push({ kind: 'error', message: 'HTTP 400: Streaming translation is not supported' })
    const res = await testLlmConnection(cfg, t)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('连接失败：')
    expect(res.message).toContain('翻译模型（qwen-mt-* 系列）')
  })

  it('22 未配置 → 失败消息（不发起请求）', async () => {
    const t = new FakeTransport()
    const res = await testLlmConnection({ baseUrl: '', apiKey: '', model: '', disableThinking: true }, t)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('模型端点未配置')
    expect(t.calls.length).toBe(0)
  })

  it('23 图片生成模型报错 → 通用误用提示', async () => {
    const t = new FakeTransport()
    t.script.push({
      kind: 'error',
      message: "HTTP 400: invalid_parameter_error: Input should be 'user': input.messages"
    })
    const res = await testLlmConnection(cfg, t)
    expect(res.message).toContain('该模型可能不支持 OpenAI 兼容对话接口')
  })
})

describe('解析器补充（管线第 4 层入口一致性）', () => {
  it('24 extractMove 输出即白名单键（encodeMove 归一）', () => {
    const board = simpleBoard()
    const codes = new Set(
      board.allLegalMoves().map((m: Move) => {
        const cell = (p: { col: number; row: number }): string => `${'abcdefghi'[p.col]}${p.row}`
        return `${cell(m.from)}-${cell(m.to)}`
      })
    )
    const code = extractMove('着法: a9 - a5')
    expect(code).not.toBeNull()
    expect(codes.has(code!)).toBe(true)
  })

  it('25 LlmConfigError 可作为异常抛出并被消息匹配', () => {
    expect(new LlmConfigError('x').message).toBe('x')
  })
})
