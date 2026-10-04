/**
 * 求解 Worker 客户端（04 文档 §2/§9.4）：requestId 匹配 + 取消 + 迟到响应丢弃。
 *
 * - Worker 初始化失败（极端环境）回退渲染线程同步计算，
 *   与原版"Isolate 不可用退化同步"兜底一致（move_source.dart:107-113）；
 * - 迟到响应按 id 匹配，不在 pending 表即丢弃（00 §3.2 主语义）；
 * - cancel：立即以 canceled 结算对应请求并从 pending 删除（后续迟到响应丢弃），
 *   同时通知 worker（防排队请求空算；在途求解由 timeLimitMs 兜底收口）。
 */
import type { Move } from '@packages/rules'
import type { SolveResult } from '@packages/solver'
import { isWinningFirstMove, solveEndgame } from '@packages/solver'
import { createRequestId } from '@renderer/ipc/client'
import {
  SOLVER_CANCELED_ERROR,
  type IsWinningFirstMovePayload,
  type SolvePayload,
  type SolverRequestMsg,
  type SolverRequestType,
  type SolverResponseMsg
} from './solverProtocol'

/** 最小 Worker 接口（与 DOM Worker 结构兼容，便于测试注入 fake）。 */
export interface WorkerLike {
  postMessage(data: SolverRequestMsg): void
  terminate(): void
  onmessage: ((e: { data: SolverResponseMsg }) => void) | null
  onerror: ((e: unknown) => void) | null
}

export type SolverBackend = 'worker' | 'sync'

/**
 * 取 DOM Worker 构造器：renderer 环境有、Node（Vitest/tsconfig.node）没有。
 * 经 globalThis 动态取用而非直接引用，node 侧类型检查与运行时均落 sync 兜底。
 */
function createDomWorker(url: URL): WorkerLike | null {
  const ctor = (globalThis as unknown as {
    Worker?: new (url: URL, options: { type: 'module' }) => WorkerLike
  }).Worker
  return ctor !== undefined ? new ctor(url, { type: 'module' }) : null
}

export interface SolveRequestOptions {
  timeLimitMs?: number
  maxPlies?: number
}

export class SolverClient {
  private worker: WorkerLike | null
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private disposed = false
  private _backend: SolverBackend

  /** 当前后端：worker 运行期崩溃降级后变为 'sync'。 */
  get backend(): SolverBackend {
    return this._backend
  }

  constructor(
    createWorker?: () => WorkerLike,
    /** requestId 工厂（测试注入可预测 id；默认 UUID，00 §3.2）。 */
    private readonly newId: () => string = createRequestId
  ) {
    let w: WorkerLike | null
    try {
      w = createWorker
        ? createWorker()
        : createDomWorker(new URL('./solver.worker.ts', import.meta.url))
    } catch {
      w = null
    }
    this.worker = w
    this._backend = w !== null ? 'worker' : 'sync'
    if (w !== null) {
      w.onmessage = (e) => {
        this.handleResponse(e.data)
      }
      w.onerror = () => {
        // Worker 运行期崩溃：降级同步后端（未决请求由调用方限时/取消收口）。
        this.degradeToSync()
      }
    }
  }

  /** 求解残局（SolveResult 为纯数据；页面侧不做二次校验）。 */
  async solve(fen: string, options: SolveRequestOptions = {}): Promise<SolveResult> {
    const payload: SolvePayload = {
      fen,
      timeLimitMs: options.timeLimitMs,
      maxPlies: options.maxPlies
    }
    return (await this.request('solve', payload)) as SolveResult
  }

  /** 验证首着是否必胜（LLM 求解辅助的裁判，04 文档 §6）。 */
  async isWinningFirstMove(
    fen: string,
    firstMove: Move,
    options: { plies?: number; timeLimitMs?: number } = {}
  ): Promise<boolean> {
    const payload: IsWinningFirstMovePayload = {
      fen,
      firstMove,
      plies: options.plies,
      timeLimitMs: options.timeLimitMs
    }
    return (await this.request('isWinningFirstMove', payload)) as boolean
  }

  /**
   * 取消请求：立即以 canceled 结算并移出 pending（其迟到响应将被丢弃），
   * 同时通知 worker。id 不在 pending 时仅通知（幂等）。
   */
  cancel(id: string): void {
    const entry = this.pending.get(id)
    if (entry !== undefined) {
      this.pending.delete(id)
      entry.reject(new Error(SOLVER_CANCELED_ERROR))
    }
    this.worker?.postMessage({ id, type: 'cancel' })
  }

  /** 终止 worker；此后请求走同步后端（页面销毁时调用）。 */
  dispose(): void {
    this.disposed = true
    this.worker?.terminate()
    this.worker = null
  }

  private request(type: SolverRequestType, payload: unknown): Promise<unknown> {
    const id = this.newId()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const worker = this.worker
      if (worker === null) {
        // 同步后端：microtask 中结算，保持与 worker 后端一致的异步语义。
        queueMicrotask(() => {
          try {
            this.handleResponse({ id, ok: true, result: this.computeSync(type, payload) })
          } catch (e) {
            this.handleResponse({
              id,
              ok: false,
              error: e instanceof Error ? e.message : String(e)
            })
          }
        })
        return
      }
      if (this.disposed) {
        this.pending.delete(id)
        reject(new Error('solver client disposed'))
        return
      }
      try {
        worker.postMessage({ id, type, payload })
      } catch (e) {
        this.pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  private handleResponse(resp: SolverResponseMsg): void {
    const entry = this.pending.get(resp.id)
    if (entry === undefined) return // 迟到响应：按 id 丢弃（00 §3.2）
    this.pending.delete(resp.id)
    if (resp.ok) entry.resolve(resp.result)
    else entry.reject(new Error(resp.error ?? 'solver error'))
  }

  private degradeToSync(): void {
    if (this.worker === null) return
    const w = this.worker
    this.worker = null
    this._backend = 'sync'
    w.onmessage = null
    w.onerror = null
    w.terminate()
  }

  /** 同步计算（初始化失败/运行期崩溃的兜底路径，等价 move_source.dart:107-113）。 */
  private computeSync(type: SolverRequestType, payload: unknown): unknown {
    switch (type) {
      case 'solve': {
        const p = (payload ?? {}) as SolvePayload
        return solveEndgame(p.fen, { timeLimitMs: p.timeLimitMs, maxPlies: p.maxPlies })
      }
      case 'isWinningFirstMove': {
        const p = (payload ?? {}) as IsWinningFirstMovePayload
        return isWinningFirstMove(p.fen, p.firstMove, { plies: p.plies, timeLimitMs: p.timeLimitMs })
      }
      default:
        throw new Error(`Unknown solver request type: ${String(type)}`)
    }
  }
}
