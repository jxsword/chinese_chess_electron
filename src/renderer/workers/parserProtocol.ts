/**
 * parser.worker 协议与消息处理核心（06 文档 §6，00 文档 §3.2）。
 *
 * 协议统一为：
 * - 请求 { id, type: 'parseBatch'|'cancel', payload }
 * - 响应 { id, ok, result?, error?, progress? }
 *
 * parseBatch：批量解析棋谱文件字节（XQF/PGN 按扩展名分发，含重放校验），
 * 每解析完一个文件即回报 progress {done, total}（语料库页进度条 n/m）。
 * 处理核心与 Worker 薄壳分离：纯逻辑可在 Vitest/Node 直接测试。
 */
import { parsePuzzleFile, type ParsedPuzzle } from '@packages/parsers'

export type ParserRequestType = 'parseBatch' | 'cancel'

export interface ParserRequestMsg {
  id: string
  type: ParserRequestType
  payload?: unknown
}

export interface ParserResponseMsg {
  id: string
  ok: boolean
  result?: unknown
  error?: string
  progress?: { done: number; total: number }
}

/** parseBatch 载荷：单批 ≤128 个文件（06 文档 §6 分批约定）。 */
export interface ParseBatchPayload {
  files: Array<{ name: string; source: string; bytes: Uint8Array }>
}

/** parseBatch 结果：与 files 等长，损坏/无可演示走法位为 null。 */
export interface ParseBatchResult {
  puzzles: Array<ParsedPuzzle | null>
}

export type ParserReply = (resp: ParserResponseMsg) => void

/**
 * Worker 消息处理核心：消息 FIFO 天然串行（对齐原版 Isolate 语义）。
 * cancel 与 engine.worker 同语义：记录待取消 id，请求到达前已取消直接回 canceled。
 */
export function createParserWorkerCore() {
  const cancelledIds = new Set<string>()

  const handleRequest = (msg: ParserRequestMsg, reply: ParserReply): void => {
    if (msg.type === 'cancel') {
      cancelledIds.add(msg.id)
      return
    }
    if (cancelledIds.delete(msg.id)) {
      reply({ id: msg.id, ok: false, error: CANCELED_ERROR })
      return
    }
    try {
      const result = dispatch(msg, reply, () => cancelledIds.has(msg.id))
      void result
    } catch (e) {
      reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return { handleRequest }
}

/** 取消响应的 error 文案（与 engine.worker 保持一致）。 */
export const CANCELED_ERROR = 'canceled'

function dispatch(msg: ParserRequestMsg, reply: ParserReply, shouldAbort: () => boolean): unknown {
  switch (msg.type) {
    case 'parseBatch': {
      const p = (msg.payload ?? {}) as ParseBatchPayload
      const files = Array.isArray(p.files) ? p.files : []
      const puzzles: Array<ParsedPuzzle | null> = new Array(files.length).fill(null)
      let done = 0
      for (let i = 0; i < files.length; i++) {
        if (shouldAbort()) {
          // 批中途被取消：剩余位保持 null，以 canceled 结算。
          reply({ id: msg.id, ok: false, error: CANCELED_ERROR })
          return null
        }
        const file = files[i]
        try {
          puzzles[i] = parsePuzzleFile(file.name, file.bytes, file.source)[0] ?? null
        } catch {
          puzzles[i] = null // 损坏文件：单条失败不中断批次
        }
        done += 1
        reply({ id: msg.id, ok: true, progress: { done, total: files.length } })
      }
      reply({ id: msg.id, ok: true, result: { puzzles } satisfies ParseBatchResult })
      return null
    }
    default:
      throw new Error(`Unknown parser request type: ${String(msg.type)}`)
  }
}
