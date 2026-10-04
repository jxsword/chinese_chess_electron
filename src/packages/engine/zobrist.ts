/**
 * Zobrist 哈希（DR-019，final 设计 §2）。
 *
 * - 64 位键拆为 hashLo/hashHi 两个 32 位整数（JS number 位运算安全域内；
 *   BigInt 逐节点分配在搜索热路径不可接受，故弃）；
 * - 随机键表：ZobristLo/ZobristHi 两张 Int32Array，索引 (pieceCode+7)*90+sq
 *   （data[sq] 的带符号编码 -7..7 直接做索引），另含一组先手方键；
 * - 固定种子 xorshift32 惰性初始化——键序列跨进程确定，可快照锁定；
 * - 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */

/** 棋子编码种类数（-7..7 共 15 种，0=空不占用键）。 */
const CODE_SPAN = 15
/** 键表条目数：15 种棋子 × 90 格。 */
const TABLE_SIZE = CODE_SPAN * 90

export const ZOBRIST_LO = new Int32Array(TABLE_SIZE)
export const ZOBRIST_HI = new Int32Array(TABLE_SIZE)
/** 先手方（红方走子）键：黑方走子时异或，使轮走方参与键。 */
export const TURN_LO = new Int32Array(1)
export const TURN_HI = new Int32Array(1)

/** pieceCode(-7..7) + 格索引 → 键表下标。 */
export const zobristIndex = (code: number, sq: number): number => (code + 7) * 90 + sq

/**
 * 固定种子 xorshift32 填表（模块加载时惰性执行一次）。
 * 种子取固定常量：换种子会改变全部键，须同步 review 快照（DR-019）。
 */
let initialized = false
function initTables(): void {
  if (initialized) return
  initialized = true
  let s = 0x9e3779b9 | 0 // 黄金比例常数做种子
  const next = (): number => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s | 0
  }
  for (let i = 0; i < TABLE_SIZE; i++) {
    ZOBRIST_LO[i] = next()
    ZOBRIST_HI[i] = next()
  }
  TURN_LO[0] = next()
  TURN_HI[0] = next()
}

/**
 * 全量重建键（fromFen 与测试的一致性基准）：
 * 逐格异或 (code,sq) 键，黑方走子再异或先手方键。
 */
export function rebuildZobrist(data: Int8Array, isRedTurn: boolean): [number, number] {
  initTables()
  let lo = 0
  let hi = 0
  for (let sq = 0; sq < 90; sq++) {
    const code = data[sq]
    if (code === 0) continue
    const idx = zobristIndex(code, sq)
    lo ^= ZOBRIST_LO[idx]!
    hi ^= ZOBRIST_HI[idx]!
  }
  if (!isRedTurn) {
    lo ^= TURN_LO[0]!
    hi ^= TURN_HI[0]!
  }
  return [lo, hi]
}

/**
 * 单格增量更新（applyMove/undoMove 共用，异或自逆）：
 * code=0 时退化为空操作（captured 为空即不出子）。
 */
export function xorPiece(lo: number, hi: number, code: number, sq: number): [number, number] {
  if (code === 0) return [lo, hi]
  const idx = zobristIndex(code, sq)
  return [lo ^ ZOBRIST_LO[idx]!, hi ^ ZOBRIST_HI[idx]!]
}

/** 轮走方键翻转（每次 apply/undo 各一次）。 */
export function xorTurn(lo: number, hi: number): [number, number] {
  initTables()
  return [lo ^ TURN_LO[0]!, hi ^ TURN_HI[0]!]
}
