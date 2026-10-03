/**
 * engine.worker 协议与消息处理核心（03 文档 §6，00 文档 §3.2）。
 *
 * 协议统一为：
 * - 请求 { id, type: 'findBestMove'|'findBestMoveEx'|'evaluateMove'|'cancel', payload }
 * - 响应 { id, ok, result?, error? }
 *
 * 处理核心与 Worker 薄壳（engine.worker.ts）分离：纯逻辑可在 Vitest/Node
 * 直接测试协议 roundtrip / 取消 / 迟到丢弃。board 以 FEN 字符串传递
 * （纯数据天然可结构化克隆），结果 Move/EngineReport 亦为纯数据。
 */
import type { Move } from '@packages/rules'
import { findBestMove, findBestMoveEx, evaluateMove } from '@packages/engine'

export type EngineRequestType = 'findBestMove' | 'findBestMoveEx' | 'evaluateMove' | 'cancel'

export interface EngineRequestMsg {
  id: string
  type: EngineRequestType
  payload?: unknown
}

export interface EngineResponseMsg {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface FindBestMovePayload {
  fen: string
  difficulty?: number
}

export interface FindBestMoveExPayload {
  fen: string
  depth?: number
  topK?: number
  timeLimitMs?: number
}

export interface EvaluateMovePayload {
  fen: string
  move: Move
  depth?: number
}

export type EngineReply = (resp: EngineResponseMsg) => void

/** 取消响应的 error 文案（client 侧据此识别，迟到丢弃为主语义）。 */
export const CANCELED_ERROR = 'canceled'

/**
 * Worker 消息处理核心：同一时刻只算一个搜索（消息 FIFO 天然串行，
 * 对齐原版 Isolate 语义）。cancel 记录待取消 id：
 * - 对尚未开始处理的请求：直接回 canceled（排队防线的防御检查）；
 * - 正在计算的请求无法收到消息（Worker 单线程同步计算），
 *   中断由 client 侧丢弃语义 + deadline（≤5s）兜底（00 §3.2）。
 */
export function createEngineWorkerCore() {
  const cancelledIds = new Set<string>()

  const handleRequest = (msg: EngineRequestMsg, reply: EngineReply): void => {
    if (msg.type === 'cancel') {
      cancelledIds.add(msg.id)
      return
    }
    if (cancelledIds.delete(msg.id)) {
      // 请求到达前已被取消：不计算，直接回 canceled。
      reply({ id: msg.id, ok: false, error: CANCELED_ERROR })
      return
    }
    try {
      const result = dispatch(msg, () => cancelledIds.has(msg.id))
      reply({ id: msg.id, ok: true, result })
    } catch (e) {
      reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return { handleRequest }
}

function dispatch(msg: EngineRequestMsg, shouldAbort: () => boolean): unknown {
  switch (msg.type) {
    case 'findBestMove': {
      const p = (msg.payload ?? {}) as FindBestMovePayload
      return findBestMove(p.fen, { difficulty: p.difficulty, shouldAbort })
    }
    case 'findBestMoveEx': {
      const p = (msg.payload ?? {}) as FindBestMoveExPayload
      return findBestMoveEx(p.fen, {
        depth: p.depth,
        topK: p.topK,
        timeLimitMs: p.timeLimitMs,
        shouldAbort
      })
    }
    case 'evaluateMove': {
      const p = (msg.payload ?? {}) as EvaluateMovePayload
      return evaluateMove(p.fen, p.move, { depth: p.depth, shouldAbort })
    }
    default:
      throw new Error(`Unknown engine request type: ${String(msg.type)}`)
  }
}
