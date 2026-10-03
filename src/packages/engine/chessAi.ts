/**
 * ChessAi 三接口（03 文档 §1/§2/§5，Dart ai_engine.dart `ChessAi` 的 1:1 移植）：
 *
 * - findBestMove(board, difficulty)：对局 AI 应手（难度 1-5，低难度带随机窗口）；
 * - findBestMoveEx(board, depth, topK)：参谋报告——零随机 + 根节点强制全窗口，
 *   分数为真实分差、名单稳定可复现（否决阈值计算的前提，03 §5.1）；
 * - evaluateMove(board, move, depth)：单着法评估（护航否决用），毫秒级，
 *   必须先做几何合法性校验（applyMove 不校验蹩腿等伪非法着法）。
 *
 * 无将杀/困毙时返回 null 的语义与 Dart 一致；引擎内部对棋盘深拷贝后搜索，
 * 不修改调用方传入的棋盘。纯 TypeScript：禁止 import DOM/Node/React（铁律 #1）。
 */
import type { Board as RulesBoard, Move } from '../rules'
import { EngineBoard, packedToMove, posToIndex } from './engineBoard'
import { MATE_SCORE, Search } from './search'

/** 难度参数表（03 §2；区别于参谋深度档）。 */
const LEVEL_PARAMS: Readonly<Record<number, { depth: number; timeMs: number; randomness: number }>> = {
  1: { depth: 2, timeMs: 300, randomness: 120 }, // 初级
  2: { depth: 3, timeMs: 800, randomness: 50 }, // 中级
  3: { depth: 4, timeMs: 1600, randomness: 0 }, // 高级
  4: { depth: 5, timeMs: 3000, randomness: 0 }, // 专家
  5: { depth: 6, timeMs: 5000, randomness: 0 } // 大师
}

/** 引擎搜索报告：最佳着法、最佳评分（厘兵，正数=当前方占优）与 Top-K 候选。 */
export interface EngineReport {
  best: Move
  bestCp: number
  /** Top-K 候选（move, cp），按 cp 降序；cp 为从当前走子方视角的评分。 */
  topK: Array<[Move, number]>
}

export interface FindBestMoveOptions {
  /** 难度 1-5（初级-大师），越界取 clamp（Dart 同语义）。 */
  difficulty?: number
  /** 取消探针：与 deadline 同节奏（每 64 节点）轮询（03 §6）。 */
  shouldAbort?: () => boolean
}

export interface FindBestMoveExOptions {
  /** 搜索深度，1-8。 */
  depth?: number
  /** 返回候选数，最小 1。 */
  topK?: number
  /** 时间上限（毫秒）。 */
  timeLimitMs?: number
  /** 取消探针：与 deadline 同节奏（每 64 节点）轮询（03 §6）。 */
  shouldAbort?: () => boolean
}

export interface EvaluateMoveOptions {
  /** 对手视角搜索深度，1-6。 */
  depth?: number
  /** 取消探针：与 deadline 同节奏（每 64 节点）轮询（03 §6）。 */
  shouldAbort?: () => boolean
}

/** 接受规则层 Board 实例或 FEN 字符串（Worker 协议传 FEN，天然可结构化克隆）。 */
export type EngineInput = RulesBoard | string

const toFen = (board: EngineInput): string => (typeof board === 'string' ? board : board.toFen())

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.round(v)))

const DEFAULT_DIFFICULTY = 3

/**
 * 为 board 的当前走子方寻找最佳走法（board 为 FEN 或规则层 Board）。
 * 若当前方无任何合法走法（被将死/困毙）返回 null。
 */
export function findBestMove(board: EngineInput, options: FindBestMoveOptions = {}): Move | null {
  const difficulty = clampInt(options.difficulty ?? DEFAULT_DIFFICULTY, 1, 5)
  const params = LEVEL_PARAMS[difficulty] ?? LEVEL_PARAMS[DEFAULT_DIFFICULTY]!
  const fen = toFen(board)
  const search = new Search(EngineBoard.fromFen(fen), {
    maxDepth: params.depth,
    deadlineMs: Date.now() + params.timeMs,
    randomness: params.randomness,
    shouldAbort: options.shouldAbort
  })
  const best = search.run()
  return best === null ? null : packedToMove(best)
}

/**
 * 引擎参谋报告：以固定深度、无随机性搜索一次，返回最佳着法与按分数降序的
 * Top-K 候选（根节点强制全窗口，分数为真实分差，03 §5.1）。
 * 无合法走法（被将死/困毙）返回 null。
 */
export function findBestMoveEx(
  board: EngineInput,
  options: FindBestMoveExOptions = {}
): EngineReport | null {
  const { depth = 6, topK = 5, timeLimitMs = 5000 } = options
  const fen = toFen(board)
  const search = new Search(EngineBoard.fromFen(fen), {
    maxDepth: clampInt(depth, 1, 8),
    deadlineMs: Date.now() + timeLimitMs,
    randomness: 0,
    shouldAbort: options.shouldAbort
  })
  const scored = search.runScored()
  if (scored.length === 0) return null
  const k = clampInt(topK, 1, scored.length)
  const topKList = scored
    .slice(0, k)
    .map(([packed, cp]) => [packedToMove(packed), cp] as [Move, number])
  return { best: topKList[0][0], bestCp: topKList[0][1], topK: topKList }
}

/**
 * 单着法评估（护航否决用）：走 move 后以浅搜索取对手最佳分，
 * 返回从当前走子方视角的评分（厘兵）。毫秒级（浅 1-6 层 + 2s 上限）。
 *
 * move 必须是 board 当前方的一步合法走法；非法（起点无己方子/走完自将）
 * 返回 null。几何合法性必须先行校验——applyMove 不校验蹩腿等伪非法着法。
 */
export function evaluateMove(
  board: EngineInput,
  move: Move,
  options: EvaluateMoveOptions = {}
): number | null {
  const { depth = 4 } = options
  const probe = EngineBoard.fromFen(toFen(board))
  const from = posToIndex(move.from)
  const to = posToIndex(move.to)
  const mover = probe.pieceAt(from)
  if (mover === 0) return null
  if (mover > 0 !== probe.isRedTurn) return null
  // 几何合法性校验（applyMove 不校验蹩腿/隔子等伪非法着法）。
  if (!probe.hasPseudoMove(from, to)) return null
  const cap = probe.applyMove(from, to)
  if (probe.isCheck(mover > 0)) {
    probe.undoMove(from, to, cap)
    return null // 走完自将，非法
  }
  // 对手视角搜索（probe 所有权移交 Search，用完即弃）。
  const scored = new Search(probe, {
    maxDepth: clampInt(depth, 1, 6),
    deadlineMs: Date.now() + 2000,
    randomness: 0,
    shouldAbort: options.shouldAbort
  }).runScored()
  if (scored.length === 0) return MATE_SCORE // 走完后对手被将死/困毙
  let bestOpp = -Number.MAX_SAFE_INTEGER
  for (const [, score] of scored) {
    if (score > bestOpp) bestOpp = score
  }
  return -bestOpp
}
