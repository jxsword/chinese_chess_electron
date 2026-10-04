/**
 * HybridLlmMoveSource 等价集（T4.4，09 §2 hybrid.spec 7 用例 + 否决分支；
 * 05 文档 §5 三模式决策流程）。
 */
import { describe, it, expect } from 'vitest'
import { Board } from '@packages/rules'
import type { EngineReport, MoveSource } from '@packages/engine'
import {
  HybridLlmPlayer,
  type AdvisorEngine,
  type LlmTransport,
  type LlmChatHandlers,
  type LlmChatWireRequest
} from '@packages/llm'
import type { LlmEndpointConfig } from '@shared/ipc/types'

// ---------------------------------------------------------------------------
// 可编程 fake（同 moveSource.spec）
// ---------------------------------------------------------------------------

type ScriptItem =
  | { kind: 'text'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'hang' }

class FakeTransport implements LlmTransport {
  script: ScriptItem[] = []
  readonly calls: Array<{ req: LlmChatWireRequest; handlers: LlmChatHandlers }> = []
  readonly cancelledIds: string[] = []

  async chat(req: LlmChatWireRequest, handlers: LlmChatHandlers): Promise<void> {
    this.calls.push({ req, handlers })
    const item = this.script[this.calls.length - 1] ?? { kind: 'error', message: '脚本耗尽' }
    if (item.kind === 'text') handlers.onDone(item.text)
    else if (item.kind === 'error') handlers.onError(item.message)
  }

  async cancel(requestId: string): Promise<void> {
    this.cancelledIds.push(requestId)
  }
}

class FakeAdvisorEngine implements AdvisorEngine {
  report: EngineReport | null = null
  evalMap = new Map<string, number>()
  lastExOptions: { depth?: number; topK?: number; timeLimitMs?: number } | null = null

  async findBestMoveEx(
    _fen: string,
    options?: { depth?: number; topK?: number; timeLimitMs?: number }
  ): Promise<EngineReport | null> {
    this.lastExOptions = options ?? null
    return this.report
  }

  async evaluateMove(
    _fen: string,
    move: { from: { col: number; row: number }; to: { col: number; row: number } },
    options?: { depth?: number }
  ): Promise<number | null> {
    void options
    return this.evalMap.get(`${move.from.col}${move.from.row}-${move.to.col}${move.to.row}`) ?? null
  }
}

const cfg: LlmEndpointConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: '',
  model: 'test-model',
  disableThinking: true
}

const mv = (code: string, captured = false) => {
  const [f, t] = code.split('-')
  const from = { col: f!.charCodeAt(0) - 97, row: Number(f![1]) }
  const to = { col: t!.charCodeAt(0) - 97, row: Number(t![1]) }
  return captured ? { from, to, captured: { kind: 'pawn' as const, side: 'black' as const } } : { from, to }
}

/** 红车 a9、黑卒 a5：合法 = a9-a8/a7/a6/a5(吃)、d9-d8 */
function simpleBoard(): Board {
  return Board.fromFen('4k4/9/9/9/9/p8/9/9/9/R2K5 w - - 0 1')
}

function report(): EngineReport {
  return {
    best: mv('a9-a5', true),
    bestCp: 300,
    topK: [
      [mv('a9-a5', true), 300],
      [mv('a9-a6'), 290],
      [mv('d9-d8'), 50]
    ]
  }
}

const noopBuiltin = (): MoveSource => ({
  displayName: '内置 AI（高级）',
  nextMove: async () => {
    throw new Error('builtin source should not be called')
  }
})

interface MakeHybridOver {
  advisorMode?: 'off' | 'candidate' | 'gate'
  strengthBlend?: number
  advisorDifficulty?: number
  maxAttempts?: number
  fallback?: 'builtinAi' | 'resign'
}

function makeHybrid(
  t: FakeTransport,
  engine: FakeAdvisorEngine,
  over: MakeHybridOver = {}
): HybridLlmPlayer {
  let i = 0
  return new HybridLlmPlayer(
    cfg,
    t,
    engine,
    {
      advisorMode: over.advisorMode ?? 'candidate',
      strengthBlend: over.strengthBlend ?? 50,
      advisorDifficulty: over.advisorDifficulty ?? 5,
      maxAttempts: over.maxAttempts ?? 3,
      fallback: over.fallback ?? 'builtinAi',
      builtinAiSource: noopBuiltin
    },
    { newId: () => `id-${++i}` }
  )
}

function userOf(t: FakeTransport, call = 0): string {
  const body = JSON.parse(t.calls[call]!.req.body) as {
    messages: Array<{ role: string; content: string }>
  }
  return body.messages[1]!.content
}

describe('三模式（05 §5）', () => {
  it('01 off 模式：纯 Prompt v2 全量清单（无候选头/无分档），走 LlmPlayer 兜底链', async () => {
    const t = new FakeTransport()
    const engine = new FakeAdvisorEngine()
    t.script.push({ kind: 'text', text: '着法: a9-a5' })
    const player = makeHybrid(t, engine, { advisorMode: 'off' })
    const result = await player.nextMove(simpleBoard())
    expect(result.status).toBe('ok')
    expect(result.note).toBeUndefined() // off 模式成功即无参谋注解
    expect(engine.lastExOptions).toBeNull() // 不做参谋搜索
    const user = userOf(t)
    expect(user).toContain('【合法着法清单（共')
    expect(user).toContain('括号内为中文记法/吃子/将军注解')
    expect(user).not.toContain('【候选着法清单')
    expect(user).not.toContain(' — ')
  })

  it('02 candidate 模式：Top-K 短名单附分档；池内命中 → note=参谋评分分桶', async () => {
    const t = new FakeTransport()
    const engine = new FakeAdvisorEngine()
    engine.report = report()
    t.script.push({ kind: 'text', text: '分析: 吃过河卒。\n着法: a9-a5' })
    const result = await makeHybrid(t, engine, { advisorMode: 'candidate', strengthBlend: 0 }).nextMove(simpleBoard())
    expect(result.status).toBe('ok')
    expect(result.note).toBe('参谋评分: 最佳/均势') // bestCp 300 − 300 = 0
    expect(engine.lastExOptions).toEqual({ depth: 6, topK: 3, timeLimitMs: 5000 })
    const user = userOf(t)
    expect(user).toContain('【候选着法清单（共 3 条，由本地引擎选出，必须从中选择一条；「—」后为引擎评估分档）】')
    expect(user).toContain('a9-a5(车九进四,吃卒) — 最佳/均势')
    expect(user).toContain('d9-d8(帅六进一) — 明显亏（约半子）')
    expect(user).not.toContain('【合法着法清单（共')
  })

  it('03 candidate 编造非 Top-K → 重试（不在候选清单中）→ 二次池内命中', async () => {
    const t = new FakeTransport()
    const engine = new FakeAdvisorEngine()
    engine.report = report()
    t.script.push({ kind: 'text', text: '着法: a9-a8' }) // 合法但不在 Top-K
    t.script.push({ kind: 'text', text: '着法: a9-a6' })
    const result = await makeHybrid(t, engine, { advisorMode: 'candidate' }).nextMove(simpleBoard())
    expect(result.status).toBe('ok')
    expect(result.note).toBe('参谋评分: 最佳/均势') // 300 − 290 = 10
    expect(userOf(t, 1)).toContain('你上一次的回复的着法 a9-a8无效（着法 a9-a8 不在候选清单中）')
  })

  it('04 gate 模式：全量清单自由选；选在 Top-K 外 → 用否决评估值补齐 note', async () => {
    const t = new FakeTransport()
    const engine = new FakeAdvisorEngine()
    engine.report = report()
    engine.evalMap.set('09-08', 290) // a9-a8 → loss 10
    t.script.push({ kind: 'text', text: '着法: a9-a8' })
    const result = await makeHybrid(t, engine, { advisorMode: 'gate', strengthBlend: 0 }).nextMove(simpleBoard())
    expect(result.status).toBe('ok')
    expect(result.note).toBe('参谋评分: 最佳/均势')
    const user = userOf(t)
    expect(user).toContain('【合法着法清单（共 7 条，必须从中选择一条）】')
    expect(user).toContain('a9-a8(车九进一)')
    expect(user).not.toContain(' — 最佳/均势') // gate 无分档
  })

  it('05 gate 否决 → 带理由再问 → 二次通过（复评 loss ≤ 阈值）', async () => {
    const t = new FakeTransport()
    const engine = new FakeAdvisorEngine()
    engine.report = report()
    engine.evalMap.set('09-08', 0) // a9-a8 亏损 300 > 阈值 80（blend 0）
    engine.evalMap.set('09-07', 295) // a9-a7 复评 loss 5 ≤ 80
    t.script.push({ kind: 'text', text: '着法: a9-a8' })
    t.script.push({ kind: 'text', text: '分析: 换一路。\n着法: a9-a7' })
    const result = await makeHybrid(t, engine, { advisorMode: 'gate', strengthBlend: 0 }).nextMove(simpleBoard())
    expect(result.status).toBe('ok')
    expect(result.fromFallback).toBeUndefined()
    expect(result.move).toEqual(mv('a9-a7'))
    expect(result.note).toBe('参谋评分: 最佳/均势')
    // 第二次调用的 user 追加了参谋否决文本（含分桶与厘兵损失）
    expect(userOf(t, 1)).toContain(
      '【参谋否决】你上一次选择的 a9-a8 会被引擎惩罚（大亏（丢一马/一炮级），相对最佳损失 300 厘兵）'
    )
  })

  it('06 gate 二次违抗 → 引擎最佳代走（参谋职责，不走 resign 分支）', async () => {
    const t = new FakeTransport()
    const engine = new FakeAdvisorEngine()
    engine.report = report()
    engine.evalMap.set('09-08', 0) // 首选 loss 300 > 80
    engine.evalMap.set('09-07', 0) // 二次仍 loss 300 > 80
    t.script.push({ kind: 'text', text: '着法: a9-a8' })
    t.script.push({ kind: 'text', text: '着法: a9-a7' })
    const result = await makeHybrid(t, engine, {
      advisorMode: 'gate',
      strengthBlend: 0,
      fallback: 'resign' // 即使 resign 设置，否决代走也不走该分支
    }).nextMove(simpleBoard())
    expect(result.status).toBe('ok')
    expect(result.fromFallback).toBe(true)
    expect(result.move).toEqual(mv('a9-a5', true)) // report.best
    expect(result.note).toBe('已由参谋否决（两次选择均造成最佳/均势的损失），改为引擎最佳着法')
  })

  it('07 模型真失败 → builtinAi：report.best 代走 note 注明；resign → failed', async () => {
    const tBuiltin = new FakeTransport()
    const eBuiltin = new FakeAdvisorEngine()
    eBuiltin.report = report()
    for (let i = 0; i < 3; i++) tBuiltin.script.push({ kind: 'text', text: '不好意思' })
    const r1 = await makeHybrid(tBuiltin, eBuiltin, { advisorMode: 'candidate', maxAttempts: 3 }).nextMove(simpleBoard())
    expect(r1.status).toBe('ok')
    expect(r1.fromFallback).toBe(true)
    expect(r1.move).toEqual(mv('a9-a5', true))
    expect(r1.note).toBe('模型未给出有效着法（无法从回复中解析出着法），已由参谋（内置引擎）代走')

    const tResign = new FakeTransport()
    const eResign = new FakeAdvisorEngine()
    eResign.report = report()
    tResign.script.push({ kind: 'error', message: 'HTTP 500: boom' })
    const r2 = await makeHybrid(tResign, eResign, { advisorMode: 'candidate', maxAttempts: 1, fallback: 'resign' }).nextMove(simpleBoard())
    expect(r2.status).toBe('failed')
    expect(r2.note).toBe('模型未给出有效着法（第 1 次调用失败：HTTP 500: boom），按判负处理')
  })
})

describe('旋钮与边界（hybrid_llm_move_source.dart:74-78）', () => {
  it('08 shortlistSize：blend 0→3 / 40→5 / 100→8；越界 clamp', () => {
    expect(HybridLlmPlayer.shortlistSize(0)).toBe(3)
    expect(HybridLlmPlayer.shortlistSize(40)).toBe(5)
    expect(HybridLlmPlayer.shortlistSize(100)).toBe(8)
    expect(HybridLlmPlayer.shortlistSize(-20)).toBe(3)
    expect(HybridLlmPlayer.shortlistSize(200)).toBe(8)
  })

  it('09 vetoThresholdCp：blend 0→80 / 50→240 / 100→400', () => {
    expect(HybridLlmPlayer.vetoThresholdCp(0)).toBe(80)
    expect(HybridLlmPlayer.vetoThresholdCp(50)).toBe(240)
    expect(HybridLlmPlayer.vetoThresholdCp(100)).toBe(400)
  })

  it('10 blend=100 时 gate 不否决（阈值 400，loss 300 不触发）', async () => {
    const t = new FakeTransport()
    const engine = new FakeAdvisorEngine()
    engine.report = report()
    t.script.push({ kind: 'text', text: '着法: a9-a8' })
    const result = await makeHybrid(t, engine, { advisorMode: 'gate', strengthBlend: 100 }).nextMove(simpleBoard())
    expect(result.status).toBe('ok')
    expect(t.calls.length).toBe(1) // 没有第二次否决再问
    expect(result.note).toBe('参谋评分: 未单独评估') // 不做否决评估，Top-K 外无分
  })

  it('11 棋盘无合法着法 / 引擎报告 null → noLegalMove，不发起调用', async () => {
    const t = new FakeTransport()
    const engine = new FakeAdvisorEngine()
    engine.report = null
    const r1 = await makeHybrid(t, engine, { advisorMode: 'candidate' }).nextMove(
      Board.fromFen('k8/1P7/9/9/9/R8/9/9/9/2K6 b - - 0 1')
    )
    const r2 = await makeHybrid(t, engine, { advisorMode: 'gate' }).nextMove(simpleBoard())
    expect(r1.status).toBe('noLegalMove')
    expect(r2.status).toBe('noLegalMove')
    expect(t.calls.length).toBe(0)
  })

  it('12 gate 评估返回 null（理论上池内均合法的防御路径）→ pick 置空走兜底链', async () => {
    const t = new FakeTransport()
    const engine = new FakeAdvisorEngine()
    engine.report = report()
    // evaluateMove 对 a9-a8 返回 null → pick = null → 按模型失败兜底（Dart :173-175）
    t.script.push({ kind: 'text', text: '着法: a9-a8' })
    const result = await makeHybrid(t, engine, { advisorMode: 'gate', strengthBlend: 0 }).nextMove(simpleBoard())
    expect(result.status).toBe('ok')
    expect(result.fromFallback).toBe(true)
    expect(result.move).toEqual(mv('a9-a5', true))
    expect(result.note).toBe('模型未给出有效着法，已由参谋（内置引擎）代走')
  })

  it('13 off 模式取消：cancelCurrent 覆盖委托链路', async () => {
    const t = new FakeTransport()
    const engine = new FakeAdvisorEngine()
    t.script.push({ kind: 'hang' })
    const player = makeHybrid(t, engine, { advisorMode: 'off' })
    const pending = player.nextMove(simpleBoard())
    await new Promise((r) => setTimeout(r, 0))
    await player.cancelCurrent()
    await expect(pending).rejects.toThrow('llm chat canceled')
    expect(t.cancelledIds.length).toBe(1)
  })
})
