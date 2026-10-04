/**
 * solver.worker 集成测试（T6.1，04 文档 §2/§9.4 + 09 §2.4）：
 * postMessage 协议 roundtrip、取消（cancel 后响应被丢弃）、迟到响应按 id 丢弃、
 * Worker 初始化失败回退同步计算。
 *
 * node 环境无 DOM Worker：worker 侧消息处理核心（solverProtocol）直接驱动，
 * client 侧注入 fake Worker（queueMicrotask 异步投递，模拟真实消息时序）。
 */
import { describe, expect, it } from 'vitest'
import { solveIsUnique } from '@packages/solver'
import {
  createSolverWorkerCore,
  SOLVER_CANCELED_ERROR,
  type SolverRequestMsg,
  type SolverResponseMsg
} from '@renderer/workers/solverProtocol'
import { SolverClient, type WorkerLike } from '@renderer/workers/solverClient'

/** 双车马闷杀残局（多解金标准 FEN-A）。 */
const FEN_A = '3k5/9/9/9/R8/8R/9/9/9/4K4 w'

/**
 * fake worker：一端接 SolverClient（onmessage/onerror/postMessage），
 * 另一端接 worker 消息核心（handleRequest）。postMessage 经微任务投递，
 * 模拟真实异步时序；测试可用拦截器延迟响应制造"迟到"。
 */
class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: SolverResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  terminated = false

  private readonly core = createSolverWorkerCore()
  private readonly queue: SolverRequestMsg[] = []
  private flushing = false

  /** 测试可注入的响应拦截（默认直通核心处理）。 */
  interceptor: ((msg: SolverRequestMsg, pass: () => void) => void) | null = null

  postMessage(data: SolverRequestMsg): void {
    this.queue.push(data)
    queueMicrotask(() => this.flush())
  }

  /** 直接向 client 投递一条响应（测试制造迟到响应）。 */
  emitToClient(resp: SolverResponseMsg): void {
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

describe('solver.worker 协议 roundtrip（04 §2）', () => {
  it('solve：FEN-A 返回 solved 多解结果', async () => {
    const fake = new FakeWorker()
    const client = new SolverClient(() => fake)
    expect(client.backend).toBe('worker')
    const result = await client.solve(FEN_A, { timeLimitMs: 10_000, maxPlies: 3 })
    expect(result.status).toBe('solved')
    expect(result.solutions.length).toBeGreaterThanOrEqual(2)
    expect(solveIsUnique(result)).toBe(false)
    expect(result.elapsed).toBeGreaterThanOrEqual(0)
    client.dispose()
    expect(fake.terminated).toBe(true)
  })

  it('isWinningFirstMove：必胜首着 true / 无关首着 false', async () => {
    const fake = new FakeWorker()
    const client = new SolverClient(() => fake)
    const winning = await client.isWinningFirstMove(
      FEN_A,
      { from: { col: 0, row: 4 }, to: { col: 3, row: 4 } },
      { plies: 1 }
    )
    expect(winning).toBe(true)
    const losing = await client.isWinningFirstMove(
      FEN_A,
      { from: { col: 2, row: 1 }, to: { col: 4, row: 2 } },
      { plies: 1 }
    )
    expect(losing).toBe(false)
    client.dispose()
  })

  it('worker 内异常映射为 ok:false / error 消息', async () => {
    const fake = new FakeWorker()
    const client = new SolverClient(() => fake)
    await expect(client.solve('not-a-fen')).rejects.toThrow(/Invalid FEN/)
    client.dispose()
  })
})

describe('取消与迟到丢弃（00 §3.2 / 09 §2.4）', () => {
  it('cancel 后请求立即以 canceled 结算，其迟到响应被丢弃', async () => {
    let counter = 0
    const fake = new FakeWorker()
    const client = new SolverClient(() => fake, () => `req-${++counter}`)

    // 拦截 req-1 的处理并压住，制造"已发出未响应"窗口。
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fake.interceptor = (msg, pass) => {
      if (msg.id === 'req-1') {
        void gate.then(pass)
        return
      }
      pass()
    }

    const p1 = client.solve(FEN_A, { timeLimitMs: 30_000, maxPlies: 9 })
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    client.cancel('req-1')
    await expect(p1).rejects.toThrow(SOLVER_CANCELED_ERROR)

    // 迟到响应：gate 释放后 worker 处理并回响应，client 已无 req-1 条目 → 丢弃。
    release!()
    await new Promise((r) => setTimeout(r, 50))

    // 后续请求不受影响（迟到丢弃不污染 pending 表）。
    const result = await client.solve(FEN_A, { timeLimitMs: 10_000, maxPlies: 3 })
    expect(result.status).toBe('solved')
    client.dispose()
  })

  it('已正常完成请求的重复响应（伪造迟到）被丢弃且无副作用', async () => {
    const fake = new FakeWorker()
    const client = new SolverClient(() => fake)
    const result = await client.solve(FEN_A, { timeLimitMs: 10_000, maxPlies: 3 })
    expect(result.status).toBe('solved')
    fake.emitToClient({ id: 'unknown-id', ok: true, result: null })
    fake.emitToClient({ id: 'unknown-id-2', ok: false, error: 'late error' })
    await new Promise((r) => setTimeout(r, 10))
    const again = await client.solve(FEN_A, { timeLimitMs: 10_000, maxPlies: 3 })
    expect(again.status).toBe('solved')
    client.dispose()
  })
})

describe('worker 核心（solverProtocol）直测', () => {
  it('cancel 先到：同 id 请求直接回 canceled，不计算', () => {
    const core = createSolverWorkerCore()
    const responses: SolverResponseMsg[] = []
    core.handleRequest({ id: 'x', type: 'cancel' }, (r) => responses.push(r))
    core.handleRequest(
      { id: 'x', type: 'solve', payload: { fen: FEN_A, timeLimitMs: 10_000, maxPlies: 3 } },
      (r) => responses.push(r)
    )
    expect(responses).toEqual([{ id: 'x', ok: false, error: SOLVER_CANCELED_ERROR }])
  })

  it('正常请求后 cancel 不影响后续同类型请求', () => {
    const core = createSolverWorkerCore()
    const responses: SolverResponseMsg[] = []
    core.handleRequest(
      { id: 'a', type: 'solve', payload: { fen: FEN_A, timeLimitMs: 10_000, maxPlies: 3 } },
      (r) => responses.push(r)
    )
    core.handleRequest({ id: 'a', type: 'cancel' }, (r) => responses.push(r))
    core.handleRequest(
      { id: 'b', type: 'solve', payload: { fen: FEN_A, timeLimitMs: 10_000, maxPlies: 3 } },
      (r) => responses.push(r)
    )
    expect(responses).toHaveLength(2) // cancel 不产生响应
    expect(responses[0]).toMatchObject({ id: 'a', ok: true })
    expect(responses[1]).toMatchObject({ id: 'b', ok: true })
  })
})

describe('Worker 初始化失败回退同步计算（04 §9.4）', () => {
  it('createWorker 抛错 → backend=sync → 仍返回正确结果', async () => {
    const client = new SolverClient(() => {
      throw new Error('Worker unavailable')
    })
    expect(client.backend).toBe('sync')
    const result = await client.solve(FEN_A, { timeLimitMs: 10_000, maxPlies: 3 })
    expect(result.status).toBe('solved')
    expect(result.solutions.length).toBeGreaterThanOrEqual(2)
    const winning = await client.isWinningFirstMove(
      FEN_A,
      { from: { col: 0, row: 4 }, to: { col: 3, row: 4 } },
      { plies: 1 }
    )
    expect(winning).toBe(true)
    client.dispose()
  })

  it('worker 运行期 onerror → 降级同步后端', async () => {
    const fake = new FakeWorker()
    const client = new SolverClient(() => fake)
    expect(client.backend).toBe('worker')
    fake.onerror?.(new Error('worker crashed'))
    expect(client.backend).toBe('sync')
    const result = await client.solve(FEN_A, { timeLimitMs: 10_000, maxPlies: 3 })
    expect(result.status).toBe('solved')
    client.dispose()
  })

  it('真实环境（node 无 Worker 构造器）自动落 sync', async () => {
    const client = new SolverClient()
    expect(client.backend).toBe('sync')
    const result = await client.solve(FEN_A, { timeLimitMs: 10_000, maxPlies: 3 })
    expect(result.status).toBe('solved')
    client.dispose()
  })
})
