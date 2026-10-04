/**
 * solver.worker 薄壳（04 文档 §9.4）：结构化克隆收发，同步计算不阻塞主线程。
 * 协议与处理核心在 solverProtocol.ts（可脱离 Worker 环境测试）。
 */
import { createSolverWorkerCore, type SolverRequestMsg } from './solverProtocol'

/** 最小 Worker 作用域接口（tsconfig.web 无 WebWorker lib，局部断言）。 */
interface WorkerScope {
  onmessage: ((e: { data: unknown }) => void) | null
  postMessage(msg: unknown): void
}

const ctx = self as unknown as WorkerScope
const core = createSolverWorkerCore()

ctx.onmessage = (e: { data: unknown }) => {
  core.handleRequest(e.data as SolverRequestMsg, (resp) => {
    ctx.postMessage(resp)
  })
}
