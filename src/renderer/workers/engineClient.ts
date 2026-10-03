/**
 * 引擎 Worker 客户端（03 文档 §6）：requestId 匹配 + 取消 + 迟到响应丢弃。
 *
 * - Worker 初始化失败（极端环境）回退渲染线程同步计算，
 *   与原版"Isolate 不可用退化同步"兜底一致（move_source.dart:107-113）；
 * - 迟到响应按 id 匹配，不在 pending 表即丢弃（00 §3.2 主语义，
 *   等价 Flutter `_gameSeq` 代数机制；丢弃逻辑在渲染层收口）；
 * - cancel：立即以 canceled 结算对应请求并从 pending 删除（后续迟到响应丢弃），
 *   同时通知 worker（防排队请求空算）。
 */
import type { Move } from '@packages/rules'
import { findBestMove, findBestMoveEx, evaluateMove, type EngineReport } from '@packages/engine'
import { createRequestId } from '@renderer/ipc/client'
import {
  CANCELED_ERROR,
  type EngineRequestMsg,
  type EngineRequestType,
  type EngineResponseMsg,
  type EvaluateMovePayload,
  type FindBestMoveExPayload,
  type FindBestMovePayload
} from './engineProtocol'

/** 最小 Worker 接口（与 DOM Worker 结构兼容，便于测试注入 fake）。 */
export interface WorkerLike {
  postMessage(data: EngineRequestMsg): void
  terminate(): void
  onmessage: ((e: { data: EngineResponseMsg }) => void) | null
  onerror: ((e: unknown) => void) | null
}

export type EngineBackend = 'worker' | 'sync'

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

export class EngineClient {
  private worker: WorkerLike | null
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private disposed = false
  private _backend: EngineBackend

  /** 当前后端：worker 运行期崩溃降级后变为 'sync'。 */
  get backend(): EngineBackend {
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
        : createDomWorker(new URL('./engine.worker.ts', import.meta.url))
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
        // Worker 运行期崩溃：降级同步后端（未决请求由调用方超时/取消收口）。
        this.degradeToSync()
      }
    }
  }

  /** 对局 AI 应手（Move 为纯数据，页面 playMove 仍做最终校验）。 */
  async findBestMove(fen: string, options: { difficulty?: number } = {}): Promise<Move | null> {
    const payload: FindBestMovePayload = { fen, difficulty: options.difficulty }
    return (await this.request('findBestMove', payload)) as Move | null
  }

  /** 参谋报告（Top-K 真实分差）。 */
  async findBestMoveEx(
    fen: string,
    options: { depth?: number; topK?: number; timeLimitMs?: number } = {}
  ): Promise<EngineReport | null> {
    const payload: FindBestMoveExPayload = {
      fen,
      depth: options.depth,
      topK: options.topK,
      timeLimitMs: options.timeLimitMs
    }
    return (await this.request('findBestMoveEx', payload)) as EngineReport | null
  }

  /** 单着法评估（护航否决用）。 */
  async evaluateMove(
    fen: string,
    move: Move,
    options: { depth?: number } = {}
  ): Promise<number | null> {
    const payload: EvaluateMovePayload = { fen, move, depth: options.depth }
    return (await this.request('evaluateMove', payload)) as number | null
  }

  /**
   * 取消请求：立即以 canceled 结算并移出 pending（其迟到响应将被丢弃），
   * 同时通知 worker。id 不在 pending 时仅通知（幂等）。
   */
  cancel(id: string): void {
    const entry = this.pending.get(id)
    if (entry !== undefined) {
      this.pending.delete(id)
      entry.reject(new Error(CANCELED_ERROR))
    }
    this.worker?.postMessage({ id, type: 'cancel' })
  }

  /** 终止 worker；此后请求走同步后端（页面销毁时调用）。 */
  dispose(): void {
    this.disposed = true
    this.worker?.terminate()
    this.worker = null
  }

  private request(type: EngineRequestType, payload: unknown): Promise<unknown> {
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
        reject(new Error('engine client disposed'))
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

  private handleResponse(resp: EngineResponseMsg): void {
    const entry = this.pending.get(resp.id)
    if (entry === undefined) return // 迟到响应：按 id 丢弃（00 §3.2）
    this.pending.delete(resp.id)
    if (resp.ok) entry.resolve(resp.result)
    else entry.reject(new Error(resp.error ?? 'engine error'))
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
  private computeSync(type: EngineRequestType, payload: unknown): unknown {
    switch (type) {
      case 'findBestMove': {
        const p = (payload ?? {}) as FindBestMovePayload
        return findBestMove(p.fen, { difficulty: p.difficulty })
      }
      case 'findBestMoveEx': {
        const p = (payload ?? {}) as FindBestMoveExPayload
        return findBestMoveEx(p.fen, { depth: p.depth, topK: p.topK, timeLimitMs: p.timeLimitMs })
      }
      case 'evaluateMove': {
        const p = (payload ?? {}) as EvaluateMovePayload
        return evaluateMove(p.fen, p.move, { depth: p.depth })
      }
      default:
        throw new Error(`Unknown engine request type: ${String(type)}`)
    }
  }
}
