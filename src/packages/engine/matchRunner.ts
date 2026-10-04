/**
 * 无 UI 对局运行器（05 文档 §8.2，match_runner.dart 1:1 移植）：
 * 两枚 MoveSource 对打并产出五期能力评估统计。
 *
 * - 单手超时默认 5 分钟；失败/无着 = 当方认输；合法性终审兜底（铁律 #3）；
 * - evaluateQuality 开启时每手用 findBestMoveEx + evaluateMove（深度对齐口径）
 *   算失误数（分差 >250 厘兵）与 Top-3 命中/失随；
 * - 也可在测试中以脚本化假 LLM 驱动做确定性断言。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 * （setTimeout/Promise.race 为三端全局 API，类型随所在工程 lib 解析。）
 */
import { samePos, Board } from '../rules'
import type { Move, Position, Side } from '../rules'
import type { MoveSource, MoveSourceResult } from './moveSource'
import { findBestMoveEx, evaluateMove } from './chessAi'

/** 一场对局的统计报告（五期能力评估用）。 */
export interface MatchReport {
  /** 'red' | 'black' | 'draw-limit' | 'red-resign' | 'black-resign' |
   *  'red-illegal' | 'black-illegal'（后两者在 Dart 原版实现中折叠为
   *  red/black-resign + endReason 'illegal-move'，此处保持一致）。 */
  winner: string
  endReason: string
  plies: number
  redTimeMs: number
  blackTimeMs: number

  /** 走子来源触发兜底（fromFallback）的次数。 */
  redFallbacks: number
  blackFallbacks: number

  /** 相对引擎最佳损失 > blunderThresholdCp 的手数（质量指标）。 */
  redBlunders: number
  blackBlunders: number
  evaluatedPlies: number

  /** 所选着法 ∈ 引擎当层 Top-3 的跟随统计（质量跟随度指标）。 */
  redTop3Hits: number
  redTop3Misses: number
  blackTop3Hits: number
  blackTop3Misses: number
  movesIccs: string[]
}

/** 质量评估辅助常量（match_runner.dart MatchRunnerBlunder）。 */
export const MatchRunnerBlunder = {
  /** 走完即杀对方时的损失按将杀级计。 */
  mate: 30000
} as const

/** 逐手质量评估的"失误"阈值（厘兵，docs/phase5/02 §4）。 */
export const BLUNDER_THRESHOLD_CP = 250

export interface MatchRunnerOptions {
  /** 初始局面，缺省标准开局。 */
  initial?: Board
  /** 最大半回合数（draw-limit 终止）。 */
  maxPlies?: number
  /** 是否逐手质量评估（每手多付一次引擎搜索成本）。 */
  evaluateQuality?: boolean
  /** 质量评估搜索深度（默认 4；evaluateMove 取 depth-1 对齐口径）。 */
  qualityDepth?: number
  /** 单手超时（毫秒），默认 5 分钟（match_runner.dart:124）。 */
  perMoveTimeoutMs?: number
}

const sideResign = (loser: Side): string => (loser === 'red' ? 'red-resign' : 'black-resign')

const iccsOf = (from: Position, to: Position): string =>
  `${String.fromCharCode(97 + from.col)}${from.row}${String.fromCharCode(97 + to.col)}${to.row}`

/**
 * 无 UI 对局运行：两枚 MoveSource 对打并产出统计报告。
 * 结算路径与 Dart 逐条一致：source 异常 → resign(source-error)；
 * 失败/无着 → resign/no-legal-move；非法着法 → resign(illegal-move)；
 * 将死/困毙 → 当方胜；跑满 maxPlies → draw-limit。
 */
export async function runMatch(
  red: MoveSource,
  black: MoveSource,
  options: MatchRunnerOptions = {}
): Promise<MatchReport> {
  const {
    initial,
    maxPlies = 120,
    evaluateQuality = false,
    qualityDepth = 4,
    perMoveTimeoutMs = 5 * 60 * 1000
  } = options
  const board = (initial ?? Board.initial()).copy()
  const history: Move[] = []
  const movesIccs: string[] = []
  let redTimeMs = 0
  let blackTimeMs = 0
  let redFallbacks = 0
  let blackFallbacks = 0
  let redBlunders = 0
  let blackBlunders = 0
  let evaluatedPlies = 0
  let redTop3Hits = 0
  let redTop3Misses = 0
  let blackTop3Hits = 0
  let blackTop3Misses = 0

  /** 以当前累计统计结算（Dart _finish 的等价收口）。 */
  const finish = (winner: string, endReason: string, plies: number): MatchReport => ({
    winner,
    endReason,
    plies,
    redTimeMs,
    blackTimeMs,
    redFallbacks,
    blackFallbacks,
    redBlunders,
    blackBlunders,
    evaluatedPlies,
    redTop3Hits,
    redTop3Misses,
    blackTop3Hits,
    blackTop3Misses,
    movesIccs
  })

  /** 单手超时（等价 Dart .timeout(onTimeout: failed)，计时器结算后清理）。 */
  const withTimeout = (p: Promise<MoveSourceResult>): Promise<MoveSourceResult> => {
    let timer: ReturnType<typeof setTimeout> | null = null
    return Promise.race([
      p.finally(() => {
        if (timer !== null) clearTimeout(timer)
      }),
      new Promise<MoveSourceResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'failed', note: '单手超时' }), perMoveTimeoutMs)
      })
    ])
  }

  for (let ply = 0; ply < maxPlies; ply++) {
    const mover = board.turn
    const source = mover === 'red' ? red : black

    const start = Date.now()
    let result: MoveSourceResult
    // Dart 原版 sideResign 的 note 参数即被忽略（报告无 note 字段），异常文本不落报告。
    try {
      result = await withTimeout(source.nextMove(board, [...history]))
    } catch {
      return finish(sideResign(mover), 'source-error', ply)
    }
    if (mover === 'red') {
      redTimeMs += Date.now() - start
    } else {
      blackTimeMs += Date.now() - start
    }

    // 失败/无着 → 当方认输。
    if (result.status !== 'ok' || result.move === undefined) {
      return finish(
        sideResign(mover),
        result.status === 'noLegalMove' ? 'no-legal-move' : 'resign',
        ply
      )
    }

    const move = result.move
    // 合法性终审（来源自带校验，这里兜底）。
    const legal = board.legalMovesFor(move.from).some((m) => samePos(m.to, move.to))
    if (!legal) {
      return finish(sideResign(mover), 'illegal-move', ply)
    }

    if (result.fromFallback === true) {
      if (mover === 'red') {
        redFallbacks++
      } else {
        blackFallbacks++
      }
    }

    // 逐手质量评估：所选着法相对引擎最佳的损失（深度对齐口径）。
    if (evaluateQuality) {
      const snapshot = board.copy()
      // findBestMoveEx(depth) 的根分 = 走 1 步后对手搜 depth-1 层（总深 depth ply）；
      // evaluateMove 须取 depth-1 对齐，否则不同深度的分相减会系统性失真。
      const evalDepth = Math.min(6, Math.max(1, qualityDepth - 1))
      const report = findBestMoveEx(snapshot, { depth: qualityDepth })
      if (report !== null) {
        evaluatedPlies++
        const pickedCp = evaluateMove(snapshot, move, { depth: evalDepth })
        const loss = pickedCp === null ? MatchRunnerBlunder.mate : report.bestCp - pickedCp
        if (loss > BLUNDER_THRESHOLD_CP) {
          if (mover === 'red') {
            redBlunders++
          } else {
            blackBlunders++
          }
        }
        const inTop3 = report.topK
          .slice(0, 3)
          .some(([m]) => samePos(m.from, move.from) && samePos(m.to, move.to))
        if (mover === 'red') {
          if (inTop3) {
            redTop3Hits++
          } else {
            redTop3Misses++
          }
        } else {
          if (inTop3) {
            blackTop3Hits++
          } else {
            blackTop3Misses++
          }
        }
      }
    }

    // 落子。
    const piece = board.pieceAtP(move.from)
    const applied = board.applyMove({ from: move.from, to: move.to })
    history.push({
      from: applied.from,
      to: applied.to,
      piece: piece ?? undefined,
      captured: applied.captured
    })
    movesIccs.push(iccsOf(applied.from, applied.to))

    // 终局判定。
    const next = board.turn
    if (board.isCheckmate(next)) {
      return finish(mover, 'checkmate', ply + 1)
    }
    // 困毙判负（中国象棋规则）。
    if (board.isStalemate(next)) {
      return finish(mover, 'stalemate', ply + 1)
    }
  }

  return finish('draw-limit', 'move-limit', maxPlies)
}

export interface RunSeriesOptions extends MatchRunnerOptions {
  /** 对局数；奇数局红黑换边，消除执先偏差。 */
  games: number
}

/** 连跑 games 局，红黑换边；返回每局报告（match_runner.dart runSeries）。 */
export async function runMatchSeries(
  buildRed: (side: Side) => MoveSource,
  buildBlack: (side: Side) => MoveSource,
  options: RunSeriesOptions
): Promise<MatchReport[]> {
  const { games, ...rest } = options
  const reports: MatchReport[] = []
  for (let i = 0; i < games; i++) {
    const swap = i % 2 === 1
    reports.push(
      await runMatch(
        swap ? buildBlack('black') : buildRed('red'),
        swap ? buildRed('red') : buildBlack('black'),
        rest
      )
    )
  }
  return reports
}
