/**
 * L3 规则裁决层（DR-018，final 设计 §5；02 §6 缺口的落地）。
 *
 * 无状态纯函数：每次真实落子后由页面以完整 fenHistory 调用，内部现算出现次数
 * 与环内将军归责——悔棋/读档/新局回滚即截断重算，无任何可被污染的增量状态。
 *
 * v1 范围（DR-018 裁决）：长将判负 + 重复局面判和（含双方长将不变作和、
 * 第 4 次出现强制判和）；长捉判定不做（复杂度高、误判即判负）。
 * 长将归责为亚洲棋规的近似：以"重现计数 + 环内该方每手均将军"替代连续长将追踪。
 *
 * 判定细节：
 * - 局面键 = 完整 FEN（含轮走方，fen.ts 恒 halfMove 0）；
 * - 第 i 手的走子方 = fenHistory[i] 的轮走方；该手"将军" = fenHistory[i+1] 局面下
 *   其对手被 Board.isCheck 判将（含将帅照面）；
 * - 环 = 最近两次重现之间的着法；归责 = 环内该方每手均将军（且该方有手）。
 *
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */
import { Board } from './board'
import { parseTurnFen } from './fen'
import { opponentOf, type Side } from './piece'

export type RepetitionVerdict =
  | { type: 'perpetualCheckWarning'; side: Side } // k=2 单方全程将军 → 非阻塞警告
  | { type: 'perpetualCheckLoss'; side: Side } // k=3 单方全程将军 → 违规方判负
  | { type: 'bothPerpetualCheckDraw' } // k=3 双方全程将军 → 不变作和
  | { type: 'repetitionDraw' } // k=3 无人全程将军 → 三次重复判和
  | { type: 'forcedRepetitionDraw' } // k≥4 → 强制判和（拒绝和棋后不再询问）

/** 环内将军归责：'red' | 'black' | 'both' | 'none'。 */
type CycleClass = 'red' | 'black' | 'both' | 'none'

/**
 * 裁决入口：以完整局面 FEN 序列（含初始局面与轮走方）调用。
 * 返回 null = 无重复/无需介入。
 */
export function judgeRepetition(fenHistory: readonly string[]): RepetitionVerdict | null {
  if (fenHistory.length < 2) return null
  const last = fenHistory[fenHistory.length - 1]!
  const occurrences: number[] = []
  for (let i = 0; i < fenHistory.length; i++) {
    if (fenHistory[i] === last) occurrences.push(i)
  }
  const k = occurrences.length
  if (k <= 1) return null

  // 最近一环：最近两次重现之间的着法（fenHistory[prev+1 .. len-1]）。
  const prev = occurrences[k - 2]!
  const cls = classifyCycle(fenHistory, prev)

  if (k === 2) {
    if (cls === 'red') return { type: 'perpetualCheckWarning', side: 'red' }
    if (cls === 'black') return { type: 'perpetualCheckWarning', side: 'black' }
    return null // 闲着/双方将军重现：仅长将形态才警告
  }
  if (k === 3) {
    if (cls === 'red') return { type: 'perpetualCheckLoss', side: 'red' }
    if (cls === 'black') return { type: 'perpetualCheckLoss', side: 'black' }
    if (cls === 'both') return { type: 'bothPerpetualCheckDraw' }
    return { type: 'repetitionDraw' }
  }
  // k≥4：仅当玩家在 k=3 拒绝过和棋才会走到（页面在 k=3 弹确认框）。
  return { type: 'forcedRepetitionDraw' }
}

/** 环内将军归责：每手走子方按其"将军"标志统计，全将军者为长将方。 */
function classifyCycle(fenHistory: readonly string[], prevIdx: number): CycleClass {
  // isCheck 结果缓存（同一调用内同一局面只算一次）。
  const checkCache = new Map<string, boolean>()
  const total = { red: 0, black: 0 }
  const checks = { red: 0, black: 0 }
  for (let i = prevIdx; i < fenHistory.length - 1; i++) {
    const moverIsRed = parseTurnFen(fenHistory[i]!)
    const mover: Side = moverIsRed ? 'red' : 'black'
    const after = fenHistory[i + 1]!
    let gaveCheck = checkCache.get(after)
    if (gaveCheck === undefined) {
      const b = Board.fromFen(after)
      // 走子后轮走方 = mover 的对手；其被将军即该手为"将军"。
      gaveCheck = b.isCheck(opponentOf(mover))
      checkCache.set(after, gaveCheck)
    }
    total[mover]++
    if (gaveCheck) checks[mover]++
  }
  const redAll = total.red > 0 && checks.red === total.red
  const blackAll = total.black > 0 && checks.black === total.black
  if (redAll && blackAll) return 'both'
  if (redAll) return 'red'
  if (blackAll) return 'black'
  return 'none'
}
