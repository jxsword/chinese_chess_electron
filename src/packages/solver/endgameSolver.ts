/**
 * 中国象棋残局求解器：迭代加深 AND/OR 杀棋搜索（endgame_solver.dart 1:1 移植，04 文档）。
 *
 * 与评分引擎的本质区别：这是**证明问题**（存在必胜策略并给出强制线路）。
 * 语义（04 文档 §1）：
 * - OR 节点（求解方行棋）：存在一路必胜走法即胜；
 * - AND 节点（应对方行棋）：所有防着皆败才胜——防着分叉即"多条破解走法"；
 * - 将杀**或困毙**均判胜（中国象棋无逼和）；
 * - 路径去重：搜索路径内局面重复即剪枝（近似长将判负，已知限制）；
 * - 限时内未决返回 timeout；深度树闭合返回 noSolution。
 *
 * 置换表按完整 FEN 字符串键（对齐原版；Zobrist 优化不在本期，04 §9.2）。
 * 纯 TypeScript：不依赖引擎，仅依赖 rules 的 Board 层（04 §9.1）。
 */
import { Board, opponentOf, type Move, type Side } from '../rules'

/** 求解结论状态（与棋谱 SolveStatus 一一对应：solved/noSolution/timeout）。 */
export type EndgameSolveStatus = 'solved' | 'noSolution' | 'timeout'

/** 一条强制线路（自初始局面起，求解方先行；裸坐标，落库前经 fillMovePieces 补齐）。 */
export interface SolverSolution {
  moves: Move[]
}

/** 求解结果。 */
export interface SolveResult {
  status: EndgameSolveStatus
  solutions: SolverSolution[]
  /** 用时（毫秒）。 */
  elapsed: number
  /** 实际搜索到的深度（半着数）。 */
  searchedPlies: number
}

/** 解是否唯一：solved 且只有一条破解走法（endgame_solver.dart:39）。 */
export function solveIsUnique(result: SolveResult): boolean {
  return result.status === 'solved' && result.solutions.length === 1
}

export interface SolveOptions {
  /** 限时毫秒数，默认 30s；≤0 视为不限（原版按 1 小时兜底）。 */
  timeLimitMs?: number
  /** 深度上限（半着数，奇数：求解方最后收官），默认 9。 */
  maxPlies?: number
  /** 外部中止探针（worker cancel 接入点；每 512 节点检查）。 */
  shouldAbort?: () => boolean
}

/** 最多枚举的解数量（防组合爆炸，endgame_solver.dart:68）。 */
export const MAX_SOLUTIONS = 64

/** 期限耗尽 / 外部中止（内部控制流异常，对应 Dart _SearchTimeout）。 */
class SearchTimeout extends Error {}

/** 递归状态（一次 solve/isWinningFirstMove 一份，对应 Dart 实例字段）。 */
interface SearchState {
  board: Board
  /** winAt[key]=r：该局面（含轮走方）已在 r 半着内证明（OR→胜 / AND→全败）。 */
  readonly winAt: Map<string, number>
  /** failAt[key]=r：该局面已在 r 半着预算内证明无解（OR→不能胜 / AND→有逃着）。 */
  readonly failAt: Map<string, number>
  /** 当前搜索路径上的局面键：重复即剪枝（近似长将判负）。 */
  readonly path: Set<string>
  nodes: number
  readonly deadline: number
  readonly shouldAbort: () => boolean
  readonly maxPlies: number
}

const HOUR_MS = 60 * 60 * 1000

function newState(fen: string, timeLimitMs: number, maxPlies: number, shouldAbort: () => boolean): SearchState {
  const limit = Number.isFinite(timeLimitMs) && timeLimitMs > 0 ? timeLimitMs : HOUR_MS
  return {
    board: Board.fromFen(fen),
    winAt: new Map(),
    failAt: new Map(),
    path: new Set(),
    nodes: 0,
    deadline: Date.now() + limit,
    shouldAbort,
    maxPlies
  }
}

/** 重置搜索状态（isWinningFirstMove 复用，endgame_solver.dart:304-308）。 */
function resetState(state: SearchState, fen: string): void {
  state.board = Board.fromFen(fen)
  state.winAt.clear()
  state.failAt.clear()
  state.path.clear()
  state.nodes = 0
}

/**
 * 入口：求解一个残局（渲染进程应在 solver.worker 内调用，不阻塞 UI）。
 * 对应 EndgameSolver.solve（原版经 Isolate，此处同步核心由 Worker 薄壳承载）。
 */
export function solveEndgame(fen: string, options: SolveOptions = {}): SolveResult {
  const started = Date.now()
  const state = newState(
    fen,
    options.timeLimitMs ?? 30_000,
    options.maxPlies ?? 9,
    options.shouldAbort ?? (() => false)
  )
  const result = runSolve(state, fen)
  return { ...result, elapsed: Date.now() - started }
}

function runSolve(state: SearchState, fen: string): Omit<SolveResult, 'elapsed'> {
  resetState(state, fen)

  // 对方已被将死（处于被将军且无着可走）：0 步解。
  // 注意：对方"暂无着"但未被将军时不构成胜势——此刻轮走方是己方，
  // 己方一手后对方可能重新获得着法（endgame_solver.dart:124-134）。
  const opponent = opponentOf(state.board.turn)
  if (state.board.isCheck(opponent) && !state.board.hasAnyLegalMoveFor(opponent)) {
    return { status: 'solved', solutions: [], searchedPlies: 0 }
  }

  for (let plies = 1; plies <= state.maxPlies; plies += 2) {
    try {
      if (attackWin(state, plies)) {
        return {
          status: 'solved',
          solutions: enumerate(state, plies),
          searchedPlies: plies
        }
      }
    } catch (e) {
      if (e instanceof SearchTimeout) {
        return { status: 'timeout', solutions: [], searchedPlies: plies }
      }
      throw e
    }
  }
  return { status: 'noSolution', solutions: [], searchedPlies: state.maxPlies }
}

// ---------------------------------------------------------------------------
// AND/OR 搜索（endgame_solver.dart:166-232）
// ---------------------------------------------------------------------------

/** OR 节点：求解方行棋，能否在 r 半着内强制获胜。 */
function attackWin(state: SearchState, r: number): boolean {
  if (r <= 0) return false
  tick(state)
  const key = state.board.toFen()
  if (state.path.has(key)) return false // 重复局面：不视为必胜（近似长将判负）
  const win = state.winAt.get(key)
  if (win !== undefined && win <= r) return true
  const fail = state.failAt.get(key)
  if (fail !== undefined && fail >= r) return false

  const moves = orderedMoves(state)
  state.path.add(key)
  let won = false
  for (const m of moves) {
    state.board.applyMove(m)
    const opponent: Side = state.board.turn
    if (!state.board.hasAnyLegalMoveFor(opponent)) {
      // 将死或困毙：应对方无着可走即判负（中国象棋无逼和）。
      won = true
    } else if (r >= 2 && defendLose(state, r - 1)) {
      won = true
    }
    state.board.undoMove(m)
    if (won) break
  }
  state.path.delete(key)
  if (won) {
    state.winAt.set(key, win === undefined ? r : Math.min(win, r))
    return true
  }
  state.failAt.set(key, fail === undefined ? r : Math.max(fail, r))
  return false
}

/** AND 节点：应对方行棋，是否所有防着都在 r 半着内被制服。 */
function defendLose(state: SearchState, r: number): boolean {
  tick(state)
  const key = state.board.toFen()
  if (state.path.has(key)) return false
  const win = state.winAt.get(key)
  if (win !== undefined && win <= r) return true
  const fail = state.failAt.get(key)
  if (fail !== undefined && fail >= r) return false

  // 应对方无着可走 = 被将死/困毙 = 求解方胜。
  if (!state.board.hasAnyLegalMoveFor(state.board.turn)) return true

  const moves = orderedMoves(state)
  state.path.add(key)
  let allLose = moves.length > 0
  for (const d of moves) {
    state.board.applyMove(d)
    const lose = r >= 1 ? attackWin(state, r - 1) : false
    state.board.undoMove(d)
    if (!lose) {
      allLose = false
      break
    }
  }
  state.path.delete(key)
  if (allLose) {
    state.winAt.set(key, win === undefined ? r : Math.min(win, r))
    return true
  }
  state.failAt.set(key, fail === undefined ? r : Math.max(fail, r))
  return false
}

// ---------------------------------------------------------------------------
// 多解枚举：根节点所有必胜首着 × 应对方每种防着的分支线路（endgame_solver.dart:238-300）
// ---------------------------------------------------------------------------

function enumerate(state: SearchState, plies: number): SolverSolution[] {
  const out: SolverSolution[] = []
  for (const m of orderedMoves(state)) {
    state.board.applyMove(m)
    let win = false
    if (!state.board.hasAnyLegalMoveFor(state.board.turn)) {
      win = true // 一着制胜
    } else if (plies >= 2 && defendLose(state, plies - 1)) {
      win = true
    }
    if (win) {
      const line: Move[] = [m]
      if (state.board.hasAnyLegalMoveFor(state.board.turn)) {
        extendLine(state, line, plies - 1, out)
      }
      out.push({ moves: [...line] })
    }
    state.board.undoMove(m)
    if (out.length >= MAX_SOLUTIONS) break
  }
  return out
}

/** 从"应对方行棋、已被证明必败"的局面继续，把每种防着展开成一条线路。 */
function extendLine(state: SearchState, prefix: Move[], r: number, out: SolverSolution[]): void {
  if (out.length >= MAX_SOLUTIONS || r <= 0) return
  for (const d of orderedMoves(state)) {
    if (out.length >= MAX_SOLUTIONS) return
    state.board.applyMove(d)
    if (r >= 1 && attackWin(state, r - 1)) {
      const reply = findWinningReply(state, r - 1)
      if (reply !== null) {
        const line = [...prefix, d, reply]
        state.board.applyMove(reply)
        const finished = !state.board.hasAnyLegalMoveFor(state.board.turn)
        state.board.undoMove(reply)
        if (finished) {
          out.push({ moves: line })
        } else {
          extendLine(state, line, r - 2, out)
        }
      }
    }
    state.board.undoMove(d)
    // 该防着在当前预算下未被证明必败（理论不应发生）：跳过该分支。
  }
}

/** OR 节点（求解方行棋）找一个必胜应手；无则 null。 */
function findWinningReply(state: SearchState, r: number): Move | null {
  for (const m of orderedMoves(state)) {
    state.board.applyMove(m)
    let win = false
    if (!state.board.hasAnyLegalMoveFor(state.board.turn)) {
      win = true
    } else if (r >= 2 && defendLose(state, r - 1)) {
      win = true
    }
    state.board.undoMove(m)
    if (win) return m
  }
  return null
}

/**
 * 验证某条"首着"是否属于必胜着法集合（LLM 求解辅助的裁判，04 文档 §6；
 * endgame_solver.dart:102-110 / 303-320）。
 *
 * 语义：把 firstMove 当作根节点唯一首着跑 _attackWin——若成立，该首着必胜。
 * 仅当 solveEndgame 得出 solved 结论后调用才有证明意义。
 */
export function isWinningFirstMove(
  fen: string,
  firstMove: Move,
  options: { plies?: number; timeLimitMs?: number; shouldAbort?: () => boolean } = {}
): boolean {
  const state = newState(
    fen,
    options.timeLimitMs ?? 30_000,
    options.plies ?? 9,
    options.shouldAbort ?? (() => false)
  )
  resetState(state, fen)
  const legal = state.board
    .legalMovesFor(firstMove.from)
    .some((m) => m.to.col === firstMove.to.col && m.to.row === firstMove.to.row)
  if (!legal) return false
  state.board.applyMove(firstMove)
  try {
    if (!state.board.hasAnyLegalMoveFor(state.board.turn)) return true
    const plies = state.maxPlies
    return plies >= 2 && defendLose(state, plies - 1)
  } catch (e) {
    if (e instanceof SearchTimeout) return false
    throw e
  }
}

// ---------------------------------------------------------------------------
// 辅助（endgame_solver.dart:326-368）
// ---------------------------------------------------------------------------

/** 吃子子力价值（车90/炮45/马40/士象20/兵10/将1000）。 */
const CAPTURE_VALUE: Record<string, number> = {
  rook: 90,
  cannon: 45,
  knight: 40,
  minister: 20,
  advisor: 20,
  pawn: 10,
  king: 1000
}

/** 着法排序：将军 > 吃子（按子力价值）> 其他，显著改善剪枝效率。 */
function orderedMoves(state: SearchState): Move[] {
  const scored: Array<{ score: number; move: Move }> = []
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = state.board.pieceAt(col, row)
      if (piece === null || piece.side !== state.board.turn) continue
      // legalMovesFor 已过滤自将，且每条 Move 带被吃子信息。
      for (const m of state.board.legalMovesFor({ col, row })) {
        scored.push({ score: scoreMove(state, m), move: m })
      }
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((e) => e.move)
}

function scoreMove(state: SearchState, m: Move): number {
  let score = 0
  if (m.captured !== undefined) {
    score += CAPTURE_VALUE[m.captured.kind] ?? 0
  } else {
    const target = state.board.pieceAtP(m.to)
    if (target !== null) score += CAPTURE_VALUE[target.kind] ?? 0
  }
  // 将军加成：走完后对方王被将。
  state.board.applyMove(m)
  if (state.board.isCheck(state.board.turn)) score += 500
  state.board.undoMove(m)
  return score
}

/** 每 512 节点查一次截止时间 / 中止探针（endgame_solver.dart:363-368）。 */
function tick(state: SearchState): void {
  state.nodes++
  if (state.nodes % 512 === 0) {
    if (state.shouldAbort() || Date.now() > state.deadline) {
      throw new SearchTimeout()
    }
  }
}
