/**
 * 引擎内部棋盘（03 文档 §8 性能注意 1-3 的落实）：
 *
 * - 棋盘用 Int8Array(90) 一维数组，index = row * 9 + col（row 0 为黑方底线）；
 * - 棋子编码为整数：0 = 空；红方 1..7；黑方 -1..-7。
 *   kind 编码 1=帅/将 2=仕/士 3=相/象 4=马 5=车 6=炮 7=兵/卒；
 * - applyMove/undoMove 栈式回退（captured 编码由调用方保存），零对象分配；
 * - 走法打包为整数输出到复用数组：位段 [排序等级 | captured | to | from]，
 *   MVV-LVA 排序键内嵌高位，升序排后倒序遍历即按键降序。
 *
 * 与 packages/rules 的 Board 语义 1:1（pseudoMovesFor / isCheck / apply+undo
 * 结果集等价，由 test/engine/engineBoard.spec.ts 对拍锁定）。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */
import { parseBoardFen, parseTurnFen } from '../rules/fen'
import type { Move, Piece, PieceKind, Position } from '../rules'
import { ZOBRIST_HI, ZOBRIST_LO, TURN_HI, TURN_LO, rebuildZobrist } from './zobrist'

/** kind 编码（1..7，见文件头注释）。 */
const KING = 1
const KNIGHT = 4
const ROOK = 5
const CANNON = 6
const PAWN = 7

const KIND_CODE: Record<PieceKind, number> = {
  king: 1,
  advisor: 2,
  minister: 3,
  knight: 4,
  rook: 5,
  cannon: 6,
  pawn: 7
}

/** 编码（1..7）→ kind，packed 位段反解用。 */
const CODE_KIND: PieceKind[] = ['king', 'advisor', 'minister', 'knight', 'rook', 'cannon', 'pawn']

/** 子力价值（厘兵，03 §4；下标 = kind 编码）。 */
export const PIECE_VALUE = [0, 10000, 200, 200, 400, 900, 450, 100]

/**
 * MVV-LVA 排序等级：Dart 版排序键 = victim 价值×10 − attacker 价值（吃子）、
 * 非吃子 = 0。这里把全部（victim, attacker）组合的键值降序去重后映射为
 * 紧凑等级（0 = 最优先），非吃子与键值为 0 的互吃（如兵吃兵）共享同一等级
 * ——与 Dart 的排序键数值序完全一致。等级占 6 bit（最多 43 档）。
 */
const RANK = new Int8Array(64)
/** 非吃子排序等级。 */
const RANK_QUIET = (() => {
  const keys = new Set<number>([0])
  for (let v = 1; v <= 7; v++) {
    for (let a = 1; a <= 7; a++) keys.add(PIECE_VALUE[v] * 10 - PIECE_VALUE[a])
  }
  const sorted = [...keys].sort((x, y) => y - x)
  const rankOf = new Map(sorted.map((k, i) => [k, i]))
  for (let v = 1; v <= 7; v++) {
    for (let a = 1; a <= 7; a++) {
      RANK[v * 8 + a] = rankOf.get(PIECE_VALUE[v] * 10 - PIECE_VALUE[a])!
    }
  }
  return rankOf.get(0)!
})()

/**
 * 位置修正表（03 §4，Dart _pieceSquareBonus 的查表化）：
 * PSQ[kind 编码 * 90 + sq] 为红方视角修正值；黑子按行镜像 sq 查同一张表
 * （黑兵过河 row≥5 ⇔ 镜像后 row≤4，与红兵条件重合；沉底车同理）。
 */
const PSQ = new Int16Array(8 * 90)
{
  for (let kind = 1; kind <= 7; kind++) {
    for (let sq = 0; sq < 90; sq++) {
      const col = sq % 9
      const row = (sq / 9) | 0
      const colCenter = 4 - Math.abs(col - 4)
      let bonus = 0
      if (kind === PAWN) {
        // 红兵过河：row ≤ 4。
        if (row <= 4) bonus = 40 + colCenter * 8
      } else if (kind === KNIGHT || kind === CANNON) {
        bonus = colCenter * 4
      } else if (kind === ROOK) {
        // 沉底车：红 row 0。
        if (row === 0) bonus = 10
      }
      PSQ[kind * 90 + sq] = bonus
    }
  }
}

/** 行镜像（黑子查表用）：row r → 9−r，col 不变。 */
const mirrorSq = (sq: number): number => (9 - ((sq / 9) | 0)) * 9 + (sq % 9)

/** 位段宽度：from/to 各 7 bit（0..89），captured 4 bit（0..15），等级占高位。 */
export const PACK_FROM_MASK = 0x7f
export const PACK_TO_SHIFT = 7
export const PACK_CAP_SHIFT = 14
export const PACK_RANK_SHIFT = 18

/** 解包工具（引擎输出层与测试共用）。 */
export const packedFrom = (packed: number): number => packed & PACK_FROM_MASK
export const packedTo = (packed: number): number => (packed >>> PACK_TO_SHIFT) & PACK_FROM_MASK
export const packedCaptCode = (packed: number): number => (packed >>> PACK_CAP_SHIFT) & 0xf

/** 走法打包：等级占最高位。 */
const packMove = (rank: number, capCode: number, to: number, from: number): number =>
  (rank << PACK_RANK_SHIFT) | (capCode << PACK_CAP_SHIFT) | (to << PACK_TO_SHIFT) | from

/**
 * packed 整数 → 规则层 Move（captured 从位段反解，无需查盘）。
 * 与 rules/board.ts 伪合法走法一致：不含 piece 字段。
 */
export function packedToMove(packed: number): Move {
  const cc = packedCaptCode(packed)
  const captured: Piece | undefined =
    cc === 0
      ? undefined
      : cc <= 7
        ? { kind: CODE_KIND[cc - 1], side: 'red' }
        : { kind: CODE_KIND[cc - 9], side: 'black' }
  return {
    from: indexToPos(packedFrom(packed)),
    to: indexToPos(packedTo(packed)),
    ...(captured !== undefined ? { captured } : {})
  }
}

/** index = row*9+col ↔ Position。 */
export const posToIndex = (p: Position): number => p.row * 9 + p.col
export const indexToPos = (sq: number): Position => ({ col: sq % 9, row: (sq / 9) | 0 })

/** 直线四方向 [dCol, dRow]（车/炮/帅共用枚举顺序，对齐 rules/board.ts）。 */
const DIRS_ORTHO: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0]
]
const DIRS_DIAGONAL: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1]
]
const DIRS_ELEPHANT: readonly (readonly [number, number])[] = [
  [2, 2],
  [2, -2],
  [-2, 2],
  [-2, -2]
]
/** 马 8 组 [dCol, dRow, legCol, legRow]（顺序对齐 rules/board.ts KNIGHT_PATTERNS）。 */
const KNIGHT_PATTERNS: readonly (readonly [number, number, number, number])[] = [
  [1, 2, 0, 1],
  [-1, 2, 0, 1],
  [1, -2, 0, -1],
  [-1, -2, 0, -1],
  [2, 1, 1, 0],
  [2, -1, 1, 0],
  [-2, 1, -1, 0],
  [-2, -1, -1, 0]
]

/**
 * 引擎内部棋盘：语义与 rules.Board 1:1，表示为 Int8Array(90)。
 * 每次搜索新建实例（fromFen），超时/取消后随 Search 一起废弃（Dart 同语义）。
 */
export class EngineBoard {
  readonly data = new Int8Array(90)
  /** [红帅 index, 黑将 index]，无王为 -1（isCheck 对齐 Dart：无王返回 false）。 */
  private readonly kings = new Int8Array(2)
  isRedTurn: boolean
  /** Zobrist 增量键（DR-019）：fromFen 全量重建，apply/undo 对称异或维护。 */
  private hashLo = 0
  private hashHi = 0

  private constructor() {
    this.isRedTurn = true
  }

  /** 从 FEN 构造（解析复用 rules/fen，保持解析行为单一事实源）。 */
  static fromFen(fen: string): EngineBoard {
    const grid = parseBoardFen(fen)
    const b = new EngineBoard()
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p: Piece | null = grid[r][c]
        if (p === null) continue
        const code = KIND_CODE[p.kind] * (p.side === 'red' ? 1 : -1)
        const sq = r * 9 + c
        b.data[sq] = code
        if (p.kind === 'king') b.kings[p.side === 'red' ? 0 : 1] = sq
      }
    }
    b.isRedTurn = parseTurnFen(fen)
    ;[b.hashLo, b.hashHi] = rebuildZobrist(b.data, b.isRedTurn)
    return b
  }

  /** 当前局面 Zobrist 键（DR-019，低 32 位 / 高 32 位）。 */
  get zobristLo(): number {
    return this.hashLo
  }

  get zobristHi(): number {
    return this.hashHi
  }

  /** 某格棋子编码（0 = 空）。 */
  pieceAt(sq: number): number {
    return this.data[sq]
  }

  /**
   * 执行走子（不做合法性校验），返回被吃子编码（0 = 空）。
   * 与 rules.Board.applyMove 一致：翻转轮走方。
   * Zobrist 增量：mover@from 出、captured@to 出（若有）、mover@to 入、翻轮走方键。
   */
  applyMove(from: number, to: number): number {
    const d = this.data
    const mover = d[from]
    const captured = d[to]
    d[to] = mover
    d[from] = 0
    if (mover === KING) this.kings[0] = to
    else if (mover === -KING) this.kings[1] = to
    let lo = this.hashLo
    let hi = this.hashHi
    let i = (mover + 7) * 90 + from
    lo ^= ZOBRIST_LO[i]!
    hi ^= ZOBRIST_HI[i]!
    if (captured !== 0) {
      i = (captured + 7) * 90 + to
      lo ^= ZOBRIST_LO[i]!
      hi ^= ZOBRIST_HI[i]!
    }
    i = (mover + 7) * 90 + to
    lo ^= ZOBRIST_LO[i]!
    hi ^= ZOBRIST_HI[i]!
    lo ^= TURN_LO[0]!
    hi ^= TURN_HI[0]!
    this.hashLo = lo
    this.hashHi = hi
    this.isRedTurn = !this.isRedTurn
    return captured
  }

  /**
   * 撤销 applyMove（captured 为 applyMove 返回值）；翻转回轮走方。
   * Zobrist 逆序同式异或（异或自逆）：mover@to 出、mover@from 入、
   * captured@to 入（若有）、翻轮走方键——与 applyMove 的异或集合相同，净效果为零。
   */
  undoMove(from: number, to: number, captured: number): void {
    const d = this.data
    const mover = d[to]
    d[from] = mover
    d[to] = captured
    if (mover === KING) this.kings[0] = from
    else if (mover === -KING) this.kings[1] = from
    let lo = this.hashLo
    let hi = this.hashHi
    let i = (mover + 7) * 90 + to
    lo ^= ZOBRIST_LO[i]!
    hi ^= ZOBRIST_HI[i]!
    i = (mover + 7) * 90 + from
    lo ^= ZOBRIST_LO[i]!
    hi ^= ZOBRIST_HI[i]!
    if (captured !== 0) {
      i = (captured + 7) * 90 + to
      lo ^= ZOBRIST_LO[i]!
      hi ^= ZOBRIST_HI[i]!
    }
    lo ^= TURN_LO[0]!
    hi ^= TURN_HI[0]!
    this.hashLo = lo
    this.hashHi = hi
    this.isRedTurn = !this.isRedTurn
  }

  /**
   * isRed 方的将是否正被将军。判定集合与 rules.Board.isCheck 等价：
   * ① 将帅照面（同列无阻）；② 车/炮直线（车 = 第一个子，炮 = 隔一子）；
   * ③ 马位反查（含蹩腿）；④ 兵（正面 + 过河横走）。
   * 士象活动范围不超出己方半场，攻击不到敌方九宫内的将，无需检查。
   */
  isCheck(isRed: boolean): boolean {
    const d = this.data
    const k = this.kings[isRed ? 0 : 1]
    if (k < 0) return false
    const kCol = k % 9
    const kRow = (k / 9) | 0
    // ① 照面。
    const ek = this.kings[isRed ? 1 : 0]
    if (ek >= 0 && ek % 9 === kCol) {
      const lo = Math.min(k, ek)
      const hi = Math.max(k, ek)
      let blocked = false
      for (let sq = lo + 9; sq < hi; sq += 9) {
        if (d[sq] !== 0) {
          blocked = true
          break
        }
      }
      if (!blocked) return true
    }
    const foe = isRed ? -1 : 1 // 敌子编码符号
    // ② 直线：第一个子 = 敌车；隔一子后 = 敌炮。敌王仅能攻击相邻格，
    //   将帅分处两个九宫永不同行（不同列相邻不存在），同列情形已被照面覆盖。
    for (const [dc, dr] of DIRS_ORTHO) {
      let col = kCol + dc
      let row = kRow + dr
      let screen = false
      while (col >= 0 && col <= 8 && row >= 0 && row <= 9) {
        const p = d[row * 9 + col] * foe
        if (p !== 0) {
          if (!screen) {
            if (p === ROOK) return true
            screen = true
          } else {
            if (p === CANNON) return true
            break
          }
        }
        col += dc
        row += dr
      }
    }
    // ③ 马位反查：马在 k−delta 且蹩腿位（马位 + leg）为空。
    //   腿位与马位/目标同处一个矩形，二者都在盘内则腿位必在盘内。
    for (const [dc, dr, lc, lr] of KNIGHT_PATTERNS) {
      const sc = kCol - dc
      const sr = kRow - dr
      if (sc < 0 || sc > 8 || sr < 0 || sr > 9) continue
      if (d[sr * 9 + sc] === KNIGHT * foe && d[(sr + lr) * 9 + sc + lc] === 0) return true
    }
    // ④ 兵：正面（兵在将的行进反向一格）+ 横走（兵已过河才能横走；
    //   将在九宫 ⇒ 与将同行的敌兵必已过河，无需再判）。
    if (isRed) {
      if (kRow >= 1 && d[k - 9] === -PAWN) return true
      if (kCol >= 1 && d[k - 1] === -PAWN) return true
      if (kCol <= 7 && d[k + 1] === -PAWN) return true
    } else {
      if (kRow <= 8 && d[k + 9] === PAWN) return true
      if (kCol >= 1 && d[k - 1] === PAWN) return true
      if (kCol <= 7 && d[k + 1] === PAWN) return true
    }
    return false
  }

  /**
   * 生成某格棋子的全部伪合法走法（不检查自将），打包写入 buf[offset..]，
   * 返回数量。语义与 rules.Board.pseudoMovesFor 1:1。
   */
  generateMovesFor(buf: Int32Array, offset: number, from: number, capturesOnly: boolean): number {
    const d = this.data
    const piece = d[from]
    if (piece === 0) return 0
    const kind = piece > 0 ? piece : -piece
    const isRed = piece > 0
    const col = from % 9
    const row = (from / 9) | 0
    let n = offset

    /**
     * 记录一步到 buf（capturesOnly 时跳过非吃子）。
     * 返回是否"到此停止滑动"（遇到任何棋子即停，供车/炮滑行用）。
     */
    const emit = (to: number): boolean => {
      const t = d[to]
      if (t !== 0 && t > 0 === isRed) return true // 己方子占据：停，不记录
      if (!(capturesOnly && t === 0)) {
        const capCode = t === 0 ? 0 : t > 0 ? t : 8 - t
        const rank = t === 0 ? RANK_QUIET : RANK[(t > 0 ? t : -t) * 8 + kind]
        buf[n++] = packMove(rank, capCode, to, from)
      }
      return t !== 0
    }

    switch (kind) {
      case 1: {
        // 帅：九宫内 4 直向 ×1 格（九宫 col 3-5，row 红 7-9 / 黑 0-2）。
        const lo = isRed ? 7 : 0
        const hi = isRed ? 9 : 2
        if (row > lo) emit(from - 9)
        if (row < hi) emit(from + 9)
        if (col > 3) emit(from - 1)
        if (col < 5) emit(from + 1)
        break
      }
      case 2: {
        // 士：九宫内 4 斜向 ×1 格。
        const lo = isRed ? 7 : 0
        const hi = isRed ? 9 : 2
        for (const [dc, dr] of DIRS_DIAGONAL) {
          const c = col + dc
          const r = row + dr
          if (c < 3 || c > 5 || r < lo || r > hi) continue
          emit(r * 9 + c)
        }
        break
      }
      case 3: {
        // 象：田字 ×2 格，象眼 = 田字中心，不能过河。
        const lo = isRed ? 5 : 0
        const hi = isRed ? 9 : 4
        for (const [dc, dr] of DIRS_ELEPHANT) {
          const c = col + dc
          const r = row + dr
          if (c < 0 || c > 8 || r < lo || r > hi) continue
          if (d[(row + dr / 2) * 9 + col + dc / 2] !== 0) continue
          emit(r * 9 + c)
        }
        break
      }
      case 4: {
        // 马：8 个 delta+leg 模式，马腿 = 起点往该方向先走一步的格子。
        for (const [dc, dr, lc, lr] of KNIGHT_PATTERNS) {
          const c = col + dc
          const r = row + dr
          if (c < 0 || c > 8 || r < 0 || r > 9) continue
          if (d[(row + lr) * 9 + col + lc] !== 0) continue
          emit(r * 9 + c)
        }
        break
      }
      case 5: {
        // 车：4 方向滑动，遇子停止（敌子已由 emit 记录）。
        for (const [dc, dr] of DIRS_ORTHO) {
          let c = col + dc
          let r = row + dr
          while (c >= 0 && c <= 8 && r >= 0 && r <= 9) {
            if (emit(r * 9 + c)) break
            c += dc
            r += dr
          }
        }
        break
      }
      case 6: {
        // 炮：直线滑空格；越过炮架（第一个非空格）后吃第一个子（敌子）。
        for (const [dc, dr] of DIRS_ORTHO) {
          let c = col + dc
          let r = row + dr
          while (c >= 0 && c <= 8 && r >= 0 && r <= 9 && d[r * 9 + c] === 0) {
            emit(r * 9 + c)
            c += dc
            r += dr
          }
          if (c < 0 || c > 8 || r < 0 || r > 9) continue
          c += dc // 越过炮架
          r += dr
          while (c >= 0 && c <= 8 && r >= 0 && r <= 9) {
            if (d[r * 9 + c] !== 0) {
              emit(r * 9 + c)
              break
            }
            c += dc
            r += dr
          }
        }
        break
      }
      default: {
        // 兵：前进 1 格；已过河可横走；底线后仍仅平移，无升变。
        const fwd = isRed ? -1 : 1
        const crossed = isRed ? row <= 4 : row >= 5
        const r = row + fwd
        if (r >= 0 && r <= 9) emit(r * 9 + col)
        if (crossed) {
          if (col >= 1) emit(row * 9 + col - 1)
          if (col <= 7) emit(row * 9 + col + 1)
        }
      }
    }
    return n - offset
  }

  /**
   * 生成走子方全部伪合法走法（全盘扫描，格序与 rules 一致：row 0→9、col 0→8），
   * 写入 buf[offset..]，返回数量。排序由调用方完成（等级在高位）。
   */
  generateMoves(buf: Int32Array, offset: number, capturesOnly: boolean): number {
    let n = offset
    for (let sq = 0; sq < 90; sq++) {
      const p = this.data[sq]
      if (p === 0) continue
      if (p > 0 !== this.isRedTurn) continue
      n += this.generateMovesFor(buf, n, sq, capturesOnly)
    }
    return n - offset
  }

  /** from 格是否有伪合法走法到 to（几何合法性，evaluateMove 前置校验用）。 */
  hasPseudoMove(from: number, to: number): boolean {
    const buf = new Int32Array(32)
    const n = this.generateMovesFor(buf, 0, from, false)
    for (let i = 0; i < n; i++) {
      if (((buf[i] >>> PACK_TO_SHIFT) & PACK_FROM_MASK) === to) return true
    }
    return false
  }

  /**
   * 静态评估（厘兵，红方为正 → 按轮走方视角取正负，03 §4）：
   * Σ(红子价值+修正) − Σ(黑子价值+修正)，黑子修正查行镜像表。
   */
  evaluate(): number {
    const d = this.data
    let score = 0
    for (let sq = 0; sq < 90; sq++) {
      const p = d[sq]
      if (p === 0) continue
      if (p > 0) {
        score += PIECE_VALUE[p] + PSQ[p * 90 + sq]
      } else {
        const kind = -p
        score -= PIECE_VALUE[kind] + PSQ[kind * 90 + mirrorSq(sq)]
      }
    }
    return this.isRedTurn ? score : -score
  }
}
