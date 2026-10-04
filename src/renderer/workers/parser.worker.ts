/**
 * parser.worker 薄壳（06 文档 §6）：结构化克隆收发，批量解析不阻塞主线程。
 * 协议与处理核心在 parserProtocol.ts（可脱离 Worker 环境测试）。
 */
import { createParserWorkerCore, type ParserRequestMsg } from './parserProtocol'

/** 最小 Worker 作用域接口（tsconfig.web 无 WebWorker lib，局部断言）。 */
interface WorkerScope {
  onmessage: ((e: { data: unknown }) => void) | null
  postMessage(msg: unknown): void
}

const ctx = self as unknown as WorkerScope
const core = createParserWorkerCore()

ctx.onmessage = (e: { data: unknown }) => {
  core.handleRequest(e.data as ParserRequestMsg, (resp) => {
    ctx.postMessage(resp)
  })
}
