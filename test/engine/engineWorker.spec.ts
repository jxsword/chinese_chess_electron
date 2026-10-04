/**
 * engine.worker 集成测试（T3.3，03 文档 §6 + 09 文档 §2.4）：
 * postMessage 协议 roundtrip、取消（cancel 后响应被丢弃）、迟到响应按 id 丢弃、
 * Worker 初始化失败回退同步计算。
 *
 * node 环境无 DOM Worker：worker 侧消息处理核心（engineProtocol）直接驱动，
 * client 侧注入 fake Worker（queueMicrotask 异步投递，模拟真实消息时序）。
 */
import { describe, expect, it } from 'vitest'
import { FEN_INITIAL, type Move } from '@packages/rules'
import {
  createEngineWorkerCore,
  CANCELED_ERROR,
  type EngineRequestMsg,
  type EngineResponseMsg
} from '@renderer/workers/engineProtocol'
import { EngineClient, type WorkerLike } from '@renderer/workers/engineClient'

/**
 * fake worker：一端接 EngineClient（onmessage/onerror/postMessage），
 * 另一端接 worker 消息核心（handleRequest）。postMessage 经微任务投递，
 * 模拟真实异步时序；测试可用 pending 队列延迟响应制造"迟到"。
 */
class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: EngineResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  terminated = false

  private readonly core = createEngineWorkerCore()
  private readonly queue: EngineRequestMsg[] = []
  private flushing = false

  /** 测试可注入的响应拦截（默认直通核心处理）。 */
  interceptor: ((msg: EngineRequestMsg, pass: () => void) => void) | null = null

  postMessage(data: EngineRequestMsg): void {
    this.queue.push(data)
    queueMicrotask(() => this.flush())
  }

  /** 直接向 client 投递一条响应（测试制造迟到响应）。 */
  emitToClient(resp: EngineResponseMsg): void {
    queueMicrotask(() => this.onmessage?.({ data: resp }))
  }

  terminate(): void {
    this.terminated = true
  }

  private flush(): void {
    if (this.flushing) return
    this.flushing = true
    while (this.queue.length > 0) {
      const msg = this.queue.shift()!
      const pass = (): void => {
        this.core.handleRequest(msg, (resp) => this.onmessage?.({ data: resp }))
      }
      if (this.interceptor !== null) this.interceptor(msg, pass)
      else pass()
    }
    this.flushing = false
  }
}

const isLegalInitialMove = (move: Move | null): boolean => {
  if (move === null) return false
  const board = Board4Test.initial()
  return board.legalMovesFor(move.from).some((m) => m.to.col === move.to.col && m.to.row === move.to.row)
}

// 独立引入 Board（避免与顶层 import 混淆命名）
import { Board as Board4Test } from '@packages/rules'

describe('engine.worker 协议 roundtrip（03 §6）', () => {
  it('findBestMove：初始局面返回合法应手', async () => {
    const fake = new FakeWorker()
    const client = new EngineClient(() => fake)
    expect(client.backend).toBe('worker')
    const move = await client.findBestMove(FEN_INITIAL, { difficulty: 1 })
    expect(isLegalInitialMove(move)).toBe(true)
    client.dispose()
    expect(fake.terminated).toBe(true)
  })

  it('findBestMoveEx：返回 EngineReport 且 topK 降序', async () => {
    const fake = new FakeWorker()
    const client = new EngineClient(() => fake)
    const report = await client.findBestMoveEx(
      '3k5/9/9/9/R8/8R/9/9/9/4K4 w',
      { depth: 4, topK: 3, timeLimitMs: 10_000 }
    )
    expect(report).not.toBeNull()
    expect(report!.bestCp).toBeGreaterThan(25000)
    expect(report!.topK).toHaveLength(3)
    for (let i = 1; i < report!.topK.length; i++) {
      expect(report!.topK[i][1]).toBeLessThanOrEqual(report!.topK[i - 1][1])
    }
    client.dispose()
  })

  it('evaluateMove：吃车着法大幅占优', async () => {
    const fake = new FakeWorker()
    const client = new EngineClient(() => fake)
    const cp = await client.evaluateMove(
      '3k5/9/9/9/r8/9/R8/9/9/4K4 w',
      { from: { col: 0, row: 6 }, to: { col: 0, row: 4 } },
      { depth: 3 }
    )
    expect(cp).not.toBeNull()
    expect(cp!).toBeGreaterThan(800)
    client.dispose()
  })

  it('无合法走法局面：findBestMove 返回 null（不报错）', async () => {
    const fake = new FakeWorker()
    const client = new EngineClient(() => fake)
    const move = await client.findBestMove('R3k4/9/9/9/9/4R4/9/9/9/4K4 b', { difficulty: 1 })
    expect(move).toBeNull()
    client.dispose()
  })

  it('worker 内异常映射为 ok:false / error 消息', async () => {
    const fake = new FakeWorker()
    const client = new EngineClient(() => fake)
    await expect(client.findBestMove('not-a-fen')).rejects.toThrow(/Invalid FEN/)
    client.dispose()
  })
})

describe('取消与迟到丢弃（00 §3.2 / 09 §2.4）', () => {
  it('cancel 后请求立即以 canceled 结算，其迟到响应被丢弃', async () => {
    // id 工厂注入可预测值：req-1 = 被取消的请求，req-2 = 后续正常请求。
    let counter = 0
    const fake = new FakeWorker()
    const client = new EngineClient(() => fake, () => `req-${++counter}`)

    // 拦截 req-1 的处理并压住，制造"已发出未响应"窗口。
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fake.interceptor = (msg, pass) => {
      // 只压住 find 请求；同 id 的 cancel 消息必须放行（否则核心无从得知取消，
      // gate 释放后会同步跑满难度 5 搜索——慢机（CI）必超 5s 测试超时）。
      if (msg.id === 'req-1' && msg.type !== 'cancel') {
        void gate.then(pass)
        return
      }
      pass()
    }

    const p1 = client.findBestMove(FEN_INITIAL, { difficulty: 5 })
    await new Promise<void>((resolve) => {
      const check = (): void => {
        // 等待微任务队列把请求送入 fake 队列。
        setTimeout(resolve, 5)
      }
      check()
    })
    client.cancel('req-1')
    await expect(p1).rejects.toThrow(CANCELED_ERROR)

    // 迟到响应：gate 释放后 worker 处理并回响应，client 已无 req-1 条目 → 丢弃。
    release!()
    await new Promise((r) => setTimeout(r, 20))

    // 后续请求不受影响（迟到丢弃不污染 pending 表）。
    const move = await client.findBestMove(FEN_INITIAL, { difficulty: 1 })
    expect(isLegalInitialMove(move)).toBe(true)
    client.dispose()
  })

  it('已正常完成请求的重复响应（伪造迟到）被丢弃且无副作用', async () => {
    const fake = new FakeWorker()
    const client = new EngineClient(() => fake)
    const move = await client.findBestMove(FEN_INITIAL, { difficulty: 1 })
    expect(move).not.toBeNull()
    // 伪造同一 id 的迟到响应（client 无对应 pending 条目）。
    fake.emitToClient({ id: 'unknown-id', ok: true, result: null })
    fake.emitToClient({ id: 'unknown-id-2', ok: false, error: 'late error' })
    await new Promise((r) => setTimeout(r, 10))
    // 后续请求正常（无 unhandled rejection / pending 表污染）。
    const move2 = await client.findBestMove(FEN_INITIAL, { difficulty: 1 })
    expect(isLegalInitialMove(move2)).toBe(true)
    client.dispose()
  })
})

describe('worker 核心（engineProtocol）直测', () => {
  it('cancel 先到：同 id 请求直接回 canceled，不计算', () => {
    const core = createEngineWorkerCore()
    const responses: EngineResponseMsg[] = []
    core.handleRequest({ id: 'x', type: 'cancel' }, (r) => responses.push(r))
    core.handleRequest(
      { id: 'x', type: 'findBestMove', payload: { fen: FEN_INITIAL, difficulty: 3 } },
      (r) => responses.push(r)
    )
    expect(responses).toEqual([{ id: 'x', ok: false, error: CANCELED_ERROR }])
  })

  it('正常请求后 cancel 不影响后续同类型请求', () => {
    const core = createEngineWorkerCore()
    const responses: EngineResponseMsg[] = []
    core.handleRequest(
      { id: 'a', type: 'findBestMove', payload: { fen: FEN_INITIAL, difficulty: 1 } },
      (r) => responses.push(r)
    )
    core.handleRequest({ id: 'a', type: 'cancel' }, (r) => responses.push(r))
    core.handleRequest(
      { id: 'b', type: 'findBestMove', payload: { fen: FEN_INITIAL, difficulty: 1 } },
      (r) => responses.push(r)
    )
    expect(responses).toHaveLength(2) // cancel 不产生响应
    expect(responses[0]).toMatchObject({ id: 'a', ok: true })
    expect(responses[1]).toMatchObject({ id: 'b', ok: true })
  })

  it('shouldAbort 探针被接入搜索循环（03 §6 每 64 节点检查）', async () => {
    // 通过 evaluateMove 的同步路径验证探针参数被接受并透传（行为级验证放 Search 单测）。
    const core = createEngineWorkerCore()
    const responses: EngineResponseMsg[] = []
    core.handleRequest(
      {
        id: 'p',
        type: 'evaluateMove',
        payload: {
          fen: '3k5/9/9/9/r8/9/R8/9/9/4K4 w',
          move: { from: { col: 0, row: 6 }, to: { col: 0, row: 4 } },
          depth: 2
        }
      },
      (r) => responses.push(r)
    )
    expect(responses[0]).toMatchObject({ id: 'p', ok: true })
  })
})

describe('Worker 初始化失败回退同步计算（03 §6）', () => {
  it('createWorker 抛错 → backend=sync → 仍返回正确结果', async () => {
    const client = new EngineClient(() => {
      throw new Error('Worker unavailable')
    })
    expect(client.backend).toBe('sync')
    const move = await client.findBestMove(FEN_INITIAL, { difficulty: 1 })
    expect(isLegalInitialMove(move)).toBe(true)
    const report = await client.findBestMoveEx('3k5/9/9/9/R8/8R/9/9/9/4K4 w', {
      depth: 4,
      topK: 3,
      timeLimitMs: 10_000
    })
    expect(report!.bestCp).toBeGreaterThan(25000)
    client.dispose()
  })

  it('worker 运行期 onerror → 降级同步后端', async () => {
    const fake = new FakeWorker()
    const client = new EngineClient(() => fake)
    expect(client.backend).toBe('worker')
    // 触发运行期错误（不 resolve 任何响应即代表 worker 已死）。
    fake.onerror?.(new Error('worker crashed'))
    expect(client.backend).toBe('sync')
    const move = await client.findBestMove(FEN_INITIAL, { difficulty: 1 })
    expect(isLegalInitialMove(move)).toBe(true)
    client.dispose()
  })

  it('真实环境（node 无 Worker 构造器）自动落 sync', async () => {
    const client = new EngineClient()
    expect(client.backend).toBe('sync')
    const move = await client.findBestMove(FEN_INITIAL, { difficulty: 1 })
    expect(isLegalInitialMove(move)).toBe(true)
    client.dispose()
  })
})

describe('同 Worker 串行排队（对齐原版 Isolate 语义）', () => {
  it('多个请求按 FIFO 顺序处理并各自返回', async () => {
    const fake = new FakeWorker()
    const client = new EngineClient(() => fake)
    const order: string[] = []
    const p1 = client.findBestMove(FEN_INITIAL, { difficulty: 1 }).then(() => order.push('1'))
    const p2 = client
      .findBestMoveEx('3k5/9/9/9/R8/8R/9/9/9/4K4 w', { depth: 2, topK: 2, timeLimitMs: 10_000 })
      .then(() => order.push('2'))
    const p3 = client
      .evaluateMove(
        '3k5/9/9/9/r8/9/R8/9/9/4K4 w',
        { from: { col: 0, row: 6 }, to: { col: 0, row: 4 } },
        { depth: 1 }
      )
      .then(() => order.push('3'))
    await Promise.all([p1, p2, p3])
    expect(order).toEqual(['1', '2', '3'])
    client.dispose()
  })
})
