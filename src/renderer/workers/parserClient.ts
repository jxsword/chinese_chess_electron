/**
 * 解析 Worker 客户端（06 文档 §6）：requestId 匹配 + 批次进度 + 迟到响应丢弃。
 *
 * - Worker 初始化失败（极端环境）回退渲染线程同步计算，
 *   与引擎客户端的兜底策略一致（engineClient.ts）；
 * - 迟到响应按 id 匹配，不在 pending 表即丢弃（00 §3.2 主语义）；
 * - parseBatch 的 progress 事件按 id 回调（语料库页进度条）。
 */
import type { ParsedPuzzle } from '@packages/parsers'
import { createRequestId } from '@renderer/ipc/client'
import {
  CANCELED_ERROR,
  createParserWorkerCore,
  type ParseBatchPayload,
  type ParseBatchResult,
  type ParserRequestMsg,
  type ParserRequestType,
  type ParserResponseMsg
} from './parserProtocol'

/** 最小 Worker 接口（与 DOM Worker 结构兼容，便于测试注入 fake）。 */
export interface ParserWorkerLike {
  postMessage(data: ParserRequestMsg): void
  terminate(): void
  onmessage: ((e: { data: ParserResponseMsg }) => void) | null
  onerror: ((e: unknown) => void) | null
}

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  onProgress?: (done: number, total: number) => void
}

/**
 * 取 DOM Worker 构造器：renderer 环境有、Node（Vitest/tsconfig.node）没有。
 * 经 globalThis 动态取用而非直接引用，node 侧类型检查与运行时均落 sync 兜底。
 */
function createDomWorker(url: URL): ParserWorkerLike | null {
  const ctor = (globalThis as unknown as {
    Worker?: new (url: URL, options: { type: 'module' }) => ParserWorkerLike
  }).Worker
  return ctor !== undefined ? new ctor(url, { type: 'module' }) : null
}

export class ParserClient {
  private worker: ParserWorkerLike | null
  private readonly pending = new Map<string, PendingEntry>()
  private disposed = false

  constructor(
    createWorker?: () => ParserWorkerLike,
    /** requestId 工厂（测试注入可预测 id；默认 UUID，00 §3.2）。 */
    private readonly newId: () => string = createRequestId
  ) {
    let w: ParserWorkerLike | null
    try {
      w = createWorker !== undefined
        ? createWorker()
        : createDomWorker(new URL('./parser.worker.ts', import.meta.url))
      if (w === null) w = null
    } catch {
      w = null
    }
    this.worker = w
    if (w !== null) {
      w.onmessage = (e) => {
        this.handleResponse(e.data)
      }
      w.onerror = () => {
        // Worker 运行期崩溃：降级同步后端（未决请求由调用方收口）。
        this.degradeToSync()
      }
    }
  }

  /**
   * 批量解析：files 顺序与结果一一对应；损坏/无可演示走法的位为 null。
   * [onProgress] 每解析完一个文件回调 (done, total)。
   */
  async parseBatch(
    files: ParseBatchPayload['files'],
    onProgress?: (done: number, total: number) => void
  ): Promise<ParseBatchResult> {
    const result = (await this.request('parseBatch', { files }, onProgress)) as ParseBatchResult
    return result
  }

  /** 取消在途批次：立即以 canceled 结算并移出 pending（迟到响应丢弃）。 */
  cancel(id: string): void {
    const entry = this.pending.get(id)
    if (entry !== undefined) {
      this.pending.delete(id)
      entry.reject(new Error(CANCELED_ERROR))
    }
    this.worker?.postMessage({ id, type: 'cancel' })
  }

  /** 终止 worker（页面销毁时调用）。 */
  dispose(): void {
    this.disposed = true
    this.worker?.terminate()
    this.worker = null
  }

  private request(
    type: ParserRequestType,
    payload: unknown,
    onProgress?: (done: number, total: number) => void
  ): Promise<unknown> {
    const id = this.newId()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
      const worker = this.worker
      if (worker === null) {
        // 同步后端：microtask 中用协议核心结算，保持一致的异步语义与进度行为。
        queueMicrotask(() => {
          const core = createParserWorkerCore()
          core.handleRequest(
            { id, type: type as 'parseBatch', payload },
            (resp) => {
              this.handleResponse(resp)
            }
          )
        })
        return
      }
      if (this.disposed) {
        this.pending.delete(id)
        reject(new Error('parser client disposed'))
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

  private handleResponse(resp: ParserResponseMsg): void {
    const entry = this.pending.get(resp.id)
    if (entry === undefined) return // 迟到响应：按 id 丢弃（00 §3.2）
    if (resp.progress !== undefined) {
      entry.onProgress?.(resp.progress.done, resp.progress.total)
      // 进度不是终态：等 result/error。
      return
    }
    this.pending.delete(resp.id)
    if (resp.ok) entry.resolve(resp.result)
    else entry.reject(new Error(resp.error ?? 'parser error'))
  }

  private degradeToSync(): void {
    if (this.worker === null) return
    const w = this.worker
    this.worker = null
    w.onmessage = null
    w.onerror = null
    w.terminate()
  }
}

export type { ParsedPuzzle }
