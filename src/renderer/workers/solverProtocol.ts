/**
 * solver.worker 协议与消息处理核心（04 文档 §2/§9.4，协议同 03 文档 §6）。
 *
 * 协议统一为：
 * - 请求 { id, type: 'solve'|'isWinningFirstMove'|'cancel', payload }
 * - 响应 { id, ok, result?, error? }
 *
 * 处理核心与 Worker 薄壳（solver.worker.ts）分离：纯逻辑可在 Vitest/Node
 * 直接测试协议 roundtrip / 取消 / 迟到丢弃。board 以 FEN 字符串传递，
 * 结果 SolveResult/boolean 亦为纯数据；取消探针每 512 节点接入搜索循环。
 */
import type { Move } from '@packages/rules'
import { isWinningFirstMove, solveEndgame } from '@packages/solver'

export type SolverRequestType = 'solve' | 'isWinningFirstMove' | 'cancel'

export interface SolverRequestMsg {
  id: string
  type: SolverRequestType
  payload?: unknown
}

export interface SolverResponseMsg {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface SolvePayload {
  fen: string
  timeLimitMs?: number
  maxPlies?: number
}

export interface IsWinningFirstMovePayload {
  fen: string
  firstMove: Move
  plies?: number
  timeLimitMs?: number
}

export type SolverReply = (resp: SolverResponseMsg) => void

/** 取消响应的 error 文案（client 侧据此识别，迟到丢弃为主语义）。 */
export const SOLVER_CANCELED_ERROR = 'canceled'

/**
 * Worker 消息处理核心：同一时刻只算一次求解（消息 FIFO 天然串行，
 * 对齐原版 Isolate 语义）。cancel 记录待取消 id：
 * - 对尚未开始处理的请求：直接回 canceled（排队防线的防御检查）；
 * - 正在计算的请求无法收到消息（Worker 单线程同步计算），
 *   中断由 client 侧丢弃语义 + 限时（timeLimitMs）兜底（00 §3.2）。
 */
export function createSolverWorkerCore() {
  const cancelledIds = new Set<string>()

  const handleRequest = (msg: SolverRequestMsg, reply: SolverReply): void => {
    if (msg.type === 'cancel') {
      cancelledIds.add(msg.id)
      return
    }
    if (cancelledIds.delete(msg.id)) {
      // 请求到达前已被取消：不计算，直接回 canceled。
      reply({ id: msg.id, ok: false, error: SOLVER_CANCELED_ERROR })
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

function dispatch(msg: SolverRequestMsg, shouldAbort: () => boolean): unknown {
  switch (msg.type) {
    case 'solve': {
      const p = (msg.payload ?? {}) as SolvePayload
      return solveEndgame(p.fen, {
        timeLimitMs: p.timeLimitMs,
        maxPlies: p.maxPlies,
        shouldAbort
      })
    }
    case 'isWinningFirstMove': {
      const p = (msg.payload ?? {}) as IsWinningFirstMovePayload
      return isWinningFirstMove(p.fen, p.firstMove, {
        plies: p.plies,
        timeLimitMs: p.timeLimitMs,
        shouldAbort
      })
    }
    default:
      throw new Error(`Unknown solver request type: ${String(msg.type)}`)
  }
}
