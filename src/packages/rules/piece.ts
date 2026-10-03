/**
 * 棋子类型（对应 piece.dart）：中国象棋共 7 种棋子，红黑两方共用同一个
 * PieceKind，颜色由 Side 区分。纯数据 + 纯函数，三端（renderer/Worker/Vitest）共用。
 */

/** 棋子类型（piece.dart:5-13）。 */
export type PieceKind =
  | 'king' // 将/帅
  | 'advisor' // 士/仕
  | 'minister' // 象/相
  | 'knight' // 马
  | 'rook' // 车
  | 'cannon' // 炮
  | 'pawn' // 兵/卒

/** 棋子归属方（piece.dart:16-28）。 */
export type Side = 'red' | 'black'

/** 对手方（piece.dart:21）。 */
export const opponentOf = (side: Side): Side => (side === 'red' ? 'black' : 'red')

/** 是否为红方（piece.dart:24）。 */
export const isRedSide = (side: Side): boolean => side === 'red'

/** 该方"前进方向"：红方从下往上走（行号减小），黑方反之（piece.dart:27）。 */
export const forwardOf = (side: Side): number => (side === 'red' ? -1 : 1)

/** 一个具体棋子（种类 + 归属方）。 */
export interface Piece {
  readonly kind: PieceKind
  readonly side: Side
}

/** FEN 字符映射（红大写、黑小写；象用 B 非 E，piece.dart:31-49）。 */
const KIND_TO_FEN_RED: Record<PieceKind, string> = {
  king: 'K',
  advisor: 'A',
  minister: 'B',
  knight: 'N',
  rook: 'R',
  cannon: 'C',
  pawn: 'P'
}

const KIND_TO_FEN_BLACK: Record<PieceKind, string> = {
  king: 'k',
  advisor: 'a',
  minister: 'b',
  knight: 'n',
  rook: 'r',
  cannon: 'c',
  pawn: 'p'
}

/** 棋子的 FEN 字符（piece.dart:67）。 */
export const pieceFenChar = (piece: Piece): string =>
  piece.side === 'red' ? KIND_TO_FEN_RED[piece.kind] : KIND_TO_FEN_BLACK[piece.kind]

/** FEN 字符反查表（两套大小写均收录）。 */
const FEN_TO_PIECE = new Map<string, Piece>()
for (const [kind, ch] of Object.entries(KIND_TO_FEN_RED)) {
  FEN_TO_PIECE.set(ch, { kind: kind as PieceKind, side: 'red' })
}
for (const [kind, ch] of Object.entries(KIND_TO_FEN_BLACK)) {
  FEN_TO_PIECE.set(ch, { kind: kind as PieceKind, side: 'black' })
}

/** 从 FEN 字符解析单个棋子；非法字符返回 null（piece.dart:104-108）。 */
export function pieceFromFenChar(char: string): Piece | null {
  return FEN_TO_PIECE.get(char) ?? null
}

/** 中文 label：红 帅仕相马车炮兵；黑 将士象马车炮卒（piece.dart:70-90）。 */
const LABEL_RED: Record<PieceKind, string> = {
  king: '帅',
  advisor: '仕',
  minister: '相',
  knight: '马',
  rook: '车',
  cannon: '炮',
  pawn: '兵'
}

const LABEL_BLACK: Record<PieceKind, string> = {
  king: '将',
  advisor: '士',
  minister: '象',
  knight: '马',
  rook: '车',
  cannon: '炮',
  pawn: '卒'
}

/** 中文字符（用于走法记录展示，piece.dart:70）。 */
export const pieceLabel = (piece: Piece): string =>
  piece.side === 'red' ? LABEL_RED[piece.kind] : LABEL_BLACK[piece.kind]

/** 值相等（piece.dart:93-94）。 */
export const samePiece = (a: Piece | null, b: Piece | null): boolean =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.side === b.side)
