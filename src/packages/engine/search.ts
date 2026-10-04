/**
 * 单次搜索任务（03 文档 §3/§5.1，Dart ai_engine.dart `_Search` 的 1:1 移植）。
 *
 * - Negamax + Alpha-Beta（fail-hard），MVV-LVA 排序（等级内嵌走法高位）；
 * - 迭代加深：超时返回上一层完整结果（_lastScored 保留上一层）；
 * - Quiescence：叶子只延伸吃子（ply<8），被将军强制全应将（ply<16）；
 * - 根节点全窗口模式：runScored 强制 / randomness>0 时启用，
 *   保证根节点各着法分数为真实分差（否决阈值计算的前提，03 §5.1）；
 * - 每 64 节点检查一次 deadline / 取消标志（对齐 _bumpNode 节奏），
 *   超时或取消抛 SearchAbort，棋盘停留在中途状态随实例废弃。
 *
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */
import { EngineBoard, PACK_FROM_MASK, PACK_TO_SHIFT, packedTo } from './engineBoard'

/** 将杀评分（区分被杀步数，越早被杀分越差）。 */
export const MATE_SCORE = 30000
/** 搜索无穷大。 */
export const INFINITY = 100000
/** 静态搜索（吃子延伸）最大层数。 */
const MAX_QUIESCENCE_PLY = 8

/** 递归 ply 上限：主搜索深度 ≤8 + 应将延伸 ≤16，取 24 富余。 */
const MAX_PLY = 24
/** 每层走法缓冲容量（单方伪合法走法数远小于此）。 */
const MOVE_STRIDE = 128

/** 搜索中断信号（超时 / 取消，内部使用；等价 Dart `_TimeUp`）。 */
export class SearchAbort extends Error {
  constructor(public readonly timedOut: boolean) {
    super(timedOut ? 'search timeout' : 'search canceled')
    this.name = 'SearchAbort'
  }
}

/** 根节点评分表元素：[packed 走法, 分数（厘兵，走子方视角）]。 */
export type ScoredMove = [number, number]

export interface SearchConfig {
  maxDepth: number
  /** 绝对截止时间戳（Date.now() 基准，毫秒）。 */
  deadlineMs: number
  /** 根节点随机窗口（厘兵）；> 0 时根节点全窗口并在近最佳中随机取一。 */
  randomness: number
  /** 取消探针：与 deadline 同节奏（每 64 节点）轮询，返回 true 即中止。 */
  shouldAbort?: () => boolean
  /**
   * 全局对局历史出现次数表（DR-018，键 `${lo},${hi}`，final 设计 §3）。
   * 缺省 = 完全关闭重复检测，行为与 Dart 口径逐位一致（向后兼容铁律）。
   */
  historyCounts?: Map<string, number>
}

/** 路径重复阶梯惩罚（厘兵，final §3）：occ=2 → +50 / occ=3 → +150 / occ≥4 → 和棋分 0。 */
const PATH_REPEAT_PENALTY = [50, 150]
/** 全局历史命中（count≥2）的单次惩罚基数（厘兵）。 */
const GLOBAL_REPEAT_PENALTY = 100
/** 全局历史检查只在浅层启用（final §3：深层仅查路径内重复，防棋力劣化）。 */
const GLOBAL_CHECK_MAX_PLY = 3

export class Search {
  private readonly board: EngineBoard
  private readonly maxDepth: number
  private readonly deadlineMs: number
  private readonly randomness: number
  private readonly shouldAbort: (() => boolean) | undefined

  private nodes = 0
  /** 最后一层完整搜索的根节点评分表（未排序）。 */
  private lastScored: ScoredMove[] = []
  /** 最佳走法（packed；迭代加深逐层覆盖）。 */
  private best: number | null = null
  /** 中断原因：超时/取消后置位（对齐 Dart `_TimeUp` 捕获语义，不向上抛）。 */
  interrupted: 'timeout' | 'canceled' | null = null
  private readonly moveBufs = new Int32Array(MAX_PLY * MOVE_STRIDE)
  private readonly historyCounts: Map<string, number> | undefined
  /** 搜索路径局面键栈（按 ply 下标覆盖写，negamax 入口赋值即等效 push）。 */
  private readonly pathLo = new Int32Array(MAX_PLY)
  private readonly pathHi = new Int32Array(MAX_PLY)

  constructor(board: EngineBoard, config: SearchConfig) {
    this.board = board
    this.maxDepth = config.maxDepth
    this.deadlineMs = config.deadlineMs
    this.randomness = config.randomness
    this.shouldAbort = config.shouldAbort
    this.historyCounts = config.historyCounts
  }

  /**
   * 迭代加深主入口：返回最佳走法（packed）。
   * 超时返回上一深度已得到的最佳走法；无合法走法返回 null。
   */
  run(): number | null {
    this.iterate(false)
    return this.best
  }

  /**
   * 迭代加深并返回最后一层完整搜索的根节点评分表（按分数降序）。
   * 强制根节点全窗口（不剪枝）：表中每个着法的分数是真实分差。
   * 空表 = 无合法走法（被将死/困毙）。
   */
  runScored(): ScoredMove[] {
    this.iterate(true)
    return [...this.lastScored].sort((a, b) => b[1] - a[1])
  }

  /** 已消耗节点数（测试/统计用）。 */
  get nodeCount(): number {
    return this.nodes
  }

  private iterate(forceFullRootWindow: boolean): void {
    const b = this.board
    const buf = this.moveBufs
    // 根节点走法必须做合法性过滤（深层节点在递归内过滤）：
    // 否则被将军时 AI 可能"吃掉将军的子"而不真正解将。
    const n = b.generateMoves(buf, 0, false)
    // 按等级降序（升序排后倒序）。
    const ordered = Array.from(buf.subarray(0, n)).sort((x, y) => y - x)
    const rootMoves: number[] = []
    for (const move of ordered) {
      const from = move & PACK_FROM_MASK
      const to = (move >>> PACK_TO_SHIFT) & PACK_FROM_MASK
      const cap = b.applyMove(from, to)
      const leavesSelfInCheck = b.isCheck(!b.isRedTurn)
      b.undoMove(from, to, cap)
      if (!leavesSelfInCheck) rootMoves.push(move)
    }
    if (rootMoves.length === 0) return // 被将死或困毙

    // 根节点是否全窗口：低难度需要真实分差做随机挑选；
    // runScored 强制全窗口（分数即真实分差）。
    const fullRootWindow = forceFullRootWindow || this.randomness > 0

    // 根节点排序：上层最佳走法放最前（浅层结果指导深层剪枝）。
    if (this.best === null) this.best = rootMoves[0]

    // 根局面压入路径栈 ply=0（L1 路径重复基准，DR-018）。
    this.pathLo[0] = b.zobristLo
    this.pathHi[0] = b.zobristHi

    for (let depth = 1; depth <= this.maxDepth; depth++) {
      let alpha = -INFINITY
      let bestScore = -INFINITY
      let bestThisDepth: number | null = null
      const scored: ScoredMove[] = []
      let timedOut = false

      for (const move of rootMoves) {
        const from = move & PACK_FROM_MASK
        const to = (move >>> PACK_TO_SHIFT) & PACK_FROM_MASK
        const cap = b.applyMove(from, to)
        let score: number
        try {
          score = fullRootWindow
            ? // 全窗口：根节点不剪枝，每个着法的分数都是真实分差。
              -this.negamax(depth - 1, -INFINITY, INFINITY, 1)
            : // 剪枝模式下，未超过 alpha 的走法会返回边界值，
              // 因此只在严格更优时更新 best。
              -this.negamax(depth - 1, -INFINITY, -alpha, 1)
        } catch (e) {
          if (e instanceof SearchAbort) {
            this.interrupted = e.timedOut ? 'timeout' : 'canceled'
            timedOut = true
            break
          }
          throw e
        } finally {
          if (!timedOut) b.undoMove(from, to, cap)
        }
        scored.push([move, score])
        if (score > bestScore) {
          bestScore = score
          bestThisDepth = move
        }
        if (score > alpha) alpha = score
      }

      if (timedOut) break

      this.lastScored = scored
      if (this.randomness > 0) {
        const picked = this.pickRootMove(scored)
        if (picked !== null) this.best = picked
      } else if (bestThisDepth !== null) {
        this.best = bestThisDepth
      }

      // 已找到确定的将杀路线，无需更深搜索。
      if (alpha >= MATE_SCORE - 100) break
    }
  }

  /** 按分数挑选根节点走法；带随机窗口时在接近最佳的走法中随机取一。 */
  private pickRootMove(scored: ScoredMove[]): number | null {
    if (scored.length === 0) return null
    if (this.randomness <= 0) {
      let best: ScoredMove | null = null
      for (const s of scored) {
        if (best === null || s[1] > best[1]) best = s
      }
      return best![0]
    }
    let bestScore = -INFINITY
    for (const [, score] of scored) {
      if (score > bestScore) bestScore = score
    }
    const candidates = scored.filter(([, score]) => score >= bestScore - this.randomness).map(([m]) => m)
    if (candidates.length === 0) return scored[0][0]
    // 洗牌后取首个（等价 Dart candidates.shuffle()）。
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = candidates[i]
      candidates[i] = candidates[j]
      candidates[j] = tmp
    }
    return candidates[0]
  }

  // ---------------------------------------------------------------------------
  // Negamax + Alpha-Beta
  // ---------------------------------------------------------------------------

  private negamax(depth: number, alpha: number, beta: number, ply: number): number {
    this.bumpNode()
    if (depth <= 0) return this.quiescence(alpha, beta, ply)

    const b = this.board
    const buf = this.moveBufs
    const base = ply * MOVE_STRIDE

    // L1 重复检测（DR-018，final §3）：historyCounts 缺省时整体关闭，保持旧口径。
    // 路径栈按 ply 覆盖写 = push；qsearch 不参与（吃子线不可能成环）。
    if (this.historyCounts !== undefined) {
      const lo = b.zobristLo
      const hi = b.zobristHi
      this.pathLo[ply] = lo
      this.pathHi[ply] = hi
      const pathLo = this.pathLo
      const pathHi = this.pathHi
      let earlier = 0 // 路径 0..ply-1 中同键出现次数（occ = earlier + 1）
      for (let i = ply - 1; i >= 0; i--) {
        if (pathLo[i] === lo && pathHi[i] === hi) {
          earlier++
          if (earlier >= 3) break
        }
      }
      if (earlier > 0) {
        // 造成重复的一方（父节点走子方）受罚：节点分（走子方视角）加惩罚。
        if (earlier >= 3) return 0 // 第 3 次及以上：和棋分
        return b.evaluate() + PATH_REPEAT_PENALTY[earlier - 1]!
      }
      if (ply <= GLOBAL_CHECK_MAX_PLY) {
        const count = this.historyCounts.get(`${lo},${hi}`)
        // count≥2 = 真实重复威胁（第 3 次将现）；count=1 不罚，避免误伤正常巡回。
        if (count !== undefined && count >= 2) {
          return b.evaluate() + GLOBAL_REPEAT_PENALTY * (count - 1)
        }
      }
    }

    const n = b.generateMoves(buf, base, false)
    // MVV-LVA：等级在 packed 高位，段内升序排后倒序遍历即等级降序（吃大子优先）。
    buf.subarray(base, base + n).sort()
    let anyLegal = false
    for (let i = 0; i < n; i++) {
      // 升序排后倒序遍历 = 等级降序（MVV-LVA，吃大子优先）。
      const move = buf[base + i]
      const from = move & PACK_FROM_MASK
      const to = (move >>> PACK_TO_SHIFT) & PACK_FROM_MASK
      const cap = b.applyMove(from, to)
      // 伪合法走法：走完自将则跳过。
      if (b.isCheck(!b.isRedTurn)) {
        b.undoMove(from, to, cap)
        continue
      }
      anyLegal = true
      const score = -this.negamax(depth - 1, -beta, -alpha, ply + 1)
      b.undoMove(from, to, cap)
      if (score >= beta) return beta
      if (score > alpha) alpha = score
    }

    if (!anyLegal) {
      // 无合法走法：被将死或困毙，均判负；越早被杀分越差。
      return -MATE_SCORE + ply
    }
    return alpha
  }

  /** 静态搜索：只延伸吃子走法，避免在叶子节点因"刚好吃亏"误判。 */
  private quiescence(alpha: number, beta: number, ply: number): number {
    this.bumpNode()

    const b = this.board
    // 被将军时必须搜索全部应将走法，否则评估失真。
    if (b.isCheck(b.isRedTurn) && ply < MAX_QUIESCENCE_PLY * 2) {
      return this.searchEvasions(alpha, beta, ply)
    }

    const standPat = b.evaluate()
    if (standPat >= beta) return beta
    if (standPat > alpha) alpha = standPat
    if (ply >= MAX_QUIESCENCE_PLY) return alpha

    const buf = this.moveBufs
    const base = ply * MOVE_STRIDE
    const n = b.generateMoves(buf, base, true)
    buf.subarray(base, base + n).sort() // MVV-LVA（吃大子优先）
    for (let i = 0; i < n; i++) {
      const move = buf[base + i]
      const from = move & PACK_FROM_MASK
      const to = (move >>> PACK_TO_SHIFT) & PACK_FROM_MASK
      const cap = b.applyMove(from, to)
      if (b.isCheck(!b.isRedTurn)) {
        b.undoMove(from, to, cap)
        continue
      }
      const score = -this.quiescence(-beta, -alpha, ply + 1)
      b.undoMove(from, to, cap)
      if (score >= beta) return beta
      if (score > alpha) alpha = score
    }
    return alpha
  }

  /** 被将军时的全部应将搜索（含解将失败即被将死的判定）。 */
  private searchEvasions(alpha: number, beta: number, ply: number): number {
    const b = this.board
    const buf = this.moveBufs
    const base = ply * MOVE_STRIDE
    const n = b.generateMoves(buf, base, false)
    buf.subarray(base, base + n).sort() // MVV-LVA（吃大子优先）
    let anyLegal = false
    for (let i = 0; i < n; i++) {
      const move = buf[base + i]
      const from = move & PACK_FROM_MASK
      const to = (move >>> PACK_TO_SHIFT) & PACK_FROM_MASK
      const cap = b.applyMove(from, to)
      if (b.isCheck(!b.isRedTurn)) {
        b.undoMove(from, to, cap)
        continue
      }
      anyLegal = true
      const score =
        ply >= MAX_QUIESCENCE_PLY * 2
          ? b.evaluate()
          : -this.quiescence(-beta, -alpha, ply + 1)
      b.undoMove(from, to, cap)
      if (score >= beta) return beta
      if (score > alpha) alpha = score
    }
    if (!anyLegal) return -MATE_SCORE + ply
    return alpha
  }

  /** 每 64 节点查一次 deadline / 取消标志，超时或取消即中止。 */
  private bumpNode(): void {
    this.nodes++
    if ((this.nodes & 0x3f) === 0) {
      const now = Date.now()
      if (now > this.deadlineMs) throw new SearchAbort(true)
      if (this.shouldAbort !== undefined && this.shouldAbort()) throw new SearchAbort(false)
    }
  }
}

/** packed 走法的目标格（search 内部调试/测试用）。 */
export const packedTarget = packedTo
