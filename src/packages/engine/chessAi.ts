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
import { EngineBoard, packedFrom, packedTo, packedToMove, posToIndex } from './engineBoard'
import { MATE_SCORE, Search, type ScoredMove } from './search'

/** 难度参数表（03 §2；区别于参谋深度档）。 */
const LEVEL_PARAMS: Readonly<Record<number, { depth: number; timeMs: number; randomness: number }>> = {
  1: { depth: 2, timeMs: 300, randomness: 120 }, // 初级
  2: { depth: 3, timeMs: 800, randomness: 50 }, // 中级
  3: { depth: 4, timeMs: 1600, randomness: 0 }, // 高级
  4: { depth: 5, timeMs: 3000, randomness: 0 }, // 专家
  5: { depth: 6, timeMs: 5000, randomness: 0 } // 大师
}

/** L2 回避阈值基础值（厘兵，DR-018，final §4；随难度递减保棋力）。 */
const AVOID_THRESHOLD_BASE: Readonly<Record<number, number>> = { 1: 200, 2: 200, 3: 100, 4: 50, 5: 30 }
/** 长将强制变着底线（厘兵）：非将军替代着法劣化超过此值则宁可重复交规则裁决。 */
const FORCED_CHANGE_FLOOR = 500

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
  /**
   * 对局历史局面 FEN 序列（初始局面→当前，含轮走方；DR-018 L2 根节点回避）。
   * 缺省/空 = 完全关闭重复回避，行为与 Dart 口径逐位一致（向后兼容铁律）。
   * 仅 findBestMove 接受该参数；findBestMoveEx/evaluateMove 不接受（03 §5.1 可复现性）。
   */
  historyFens?: readonly string[]
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

/** 由历史 FEN 序列构建局面出现次数表（键 `${lo},${hi}`）；无效 FEN 跳过；空表返回 undefined。 */
function buildHistoryCounts(historyFens?: readonly string[]): Map<string, number> | undefined {
  if (historyFens === undefined || historyFens.length === 0) return undefined
  const counts = new Map<string, number>()
  for (const f of historyFens) {
    try {
      const b = EngineBoard.fromFen(f)
      const key = `${b.zobristLo},${b.zobristHi}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    } catch {
      // 无效 FEN 跳过（页面侧数据容错）
    }
  }
  return counts.size > 0 ? counts : undefined
}

/** L2 回避决策入参（final §4 流程图 L2 段的纯函数化，供直测）。 */
export interface AvoidanceContext {
  /** 全窗口根节点评分表（降序）。 */
  scored: readonly ScoredMove[]
  /** 当前最佳着法（packed）。 */
  best: number
  /** 阈值基础值（厘兵，随难度递减）。 */
  thresholdBase: number
  /** 着法落子后局面在历史中的出现次数。 */
  postCount: (packed: number) => number
  /** 着法是否为将军着法。 */
  isCheckMove: (packed: number) => boolean
  /** 随机源（默认 Math.random；测试注入固定序列）。 */
  random?: () => number
}

/**
 * L2 根节点回避决策（DR-018，final §4）：
 * 1. 阈值内（base × 优劣势系数）且落子后非重复的候选 → 随机取一；
 * 2. 长将形态（最佳为将军且造成重复）→ 强制选非将军非重复的最高分着法，
 *    底线 −500 厘兵防送子；
 * 3. 无合理替代 → 保留原着交规则裁决（L3）。
 * 返回最终应走的 packed 着法。
 */
export function pickAvoidanceMove(ctx: AvoidanceContext): number {
  const { scored, best, thresholdBase, postCount, isCheckMove } = ctx
  const random = ctx.random ?? Math.random
  const bestScore = scored[0]![1]
  const coef = bestScore > 200 ? 0.5 : bestScore < -200 ? 2.0 : 1
  const threshold = thresholdBase * coef
  const candidates = scored.filter(([m, s]) => s >= bestScore - threshold && postCount(m) === 0)
  if (candidates.length > 0) {
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      const tmp = candidates[i]!
      candidates[i] = candidates[j]!
      candidates[j] = tmp
    }
    return candidates[0]![0]
  }
  if (isCheckMove(best)) {
    const forced = scored.filter(
      ([m, s]) => !isCheckMove(m) && postCount(m) === 0 && s >= bestScore - FORCED_CHANGE_FLOOR
    )
    if (forced.length > 0) return forced[0]![0] // scored 已降序，首项即最高分
  }
  return best
}

/**
 * 为 board 的当前走子方寻找最佳走法（board 为 FEN 或规则层 Board）。
 * 若当前方无任何合法走法（被将死/困毙）返回 null。
 *
 * L2 根节点历史回避（DR-018，final §4）：提供 historyFens 时，若最佳着法落子后
 * 局面已在历史中出现（count≥1），在剩余时限内补一次全窗口搜索，于阈值内
 * （基础值随难度递减 × 优劣势系数）随机换非重复着法；长将形态强制变着
 * （底线 −500 厘兵）；无合理替代则保留原着交规则裁决（L3）。
 * 未提供 historyFens 时行为与 Dart 口径逐位一致。
 */
export function findBestMove(board: EngineInput, options: FindBestMoveOptions = {}): Move | null {
  const difficulty = clampInt(options.difficulty ?? DEFAULT_DIFFICULTY, 1, 5)
  const params = LEVEL_PARAMS[difficulty] ?? LEVEL_PARAMS[DEFAULT_DIFFICULTY]!
  const fen = toFen(board)
  const historyCounts = buildHistoryCounts(options.historyFens)
  const deadlineMs = Date.now() + params.timeMs
  const search = new Search(EngineBoard.fromFen(fen), {
    maxDepth: params.depth,
    deadlineMs,
    randomness: params.randomness,
    shouldAbort: options.shouldAbort,
    historyCounts
  })
  const best = search.run()
  if (best === null) return null
  if (historyCounts === undefined) return packedToMove(best)

  // ---- L2 根节点回避（仅在最佳着法命中历史时付出全窗口重搜成本）----
  const rootBoard = EngineBoard.fromFen(fen)
  /** packed 走法落子后局面键及其在历史中的出现次数（apply/undo 平衡）。 */
  const postCount = (packed: number): number => {
    const cap = rootBoard.applyMove(packedFrom(packed), packedTo(packed))
    const key = `${rootBoard.zobristLo},${rootBoard.zobristHi}`
    rootBoard.undoMove(packedFrom(packed), packedTo(packed), cap)
    return historyCounts.get(key) ?? 0
  }
  const bestCount = postCount(best)
  if (bestCount === 0) return packedToMove(best)

  const remaining = deadlineMs - Date.now()
  const scored = new Search(EngineBoard.fromFen(fen), {
    maxDepth: params.depth,
    deadlineMs: Date.now() + Math.max(remaining, 100),
    randomness: 0,
    shouldAbort: options.shouldAbort,
    historyCounts
  }).runScored()
  if (scored.length === 0) return packedToMove(best)
  const moverIsRed = rootBoard.isRedTurn
  const isCheckMove = (packed: number): boolean => {
    const cap = rootBoard.applyMove(packedFrom(packed), packedTo(packed))
    const check = rootBoard.isCheck(!moverIsRed)
    rootBoard.undoMove(packedFrom(packed), packedTo(packed), cap)
    return check
  }
  const picked = pickAvoidanceMove({
    scored,
    best,
    thresholdBase: AVOID_THRESHOLD_BASE[difficulty] ?? 100,
    postCount,
    isCheckMove
  })
  return packedToMove(picked)
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
