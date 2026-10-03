/**
 * 棋谱库走法条目（game_records.moves_json，07 文档 §1.1/§1.3）。
 * 与 saved_games 的裸四元组不同：每条含走子方棋子 FEN 字符与被吃棋子 FEN 字符。
 * 纯 TypeScript，不依赖任何环境 API。
 */
import {
  pieceFenChar,
  pieceFromFenChar,
  inBoard,
  pos,
  type Move,
  type Piece
} from '../rules'
import type { RecordMove } from '@shared/ipc/types'

/**
 * 落盘原始形状。p/x 允许 null（与 Flutter 版逐字段一致：piece 缺失写 null；
 * shared/ipc/types.RecordMove 契约面 p 为 string，渲染层组装时恒有棋子）。
 */
export interface RawRecordMove {
  f: [number, number]
  t: [number, number]
  p: string | null
  x: string | null
}

const pieceToFenOrNull = (piece?: Piece): string | null =>
  piece === undefined ? null : pieceFenChar(piece)

const pieceFromFenOrNull = (ch: string | null | undefined): Piece | undefined =>
  ch === null || ch === undefined ? undefined : (pieceFromFenChar(ch) ?? undefined)

/** 领域走法 → 存档条目（game_record.dart:_encodeMove） */
export function encodeRecordMove(m: Move): RawRecordMove {
  return {
    f: [m.from.col, m.from.row],
    t: [m.to.col, m.to.row],
    p: pieceToFenOrNull(m.piece),
    x: pieceToFenOrNull(m.captured)
  }
}

/** RecordMove（IPC 契约面，p 恒 string）→ 原始条目 */
export function recordMoveToRaw(m: RecordMove): RawRecordMove {
  return { f: m.f, t: m.t, p: m.p, x: m.x }
}

/**
 * 存档条目 → 领域走法（game_record.dart:decodeMoveJson）。
 * 字段缺失 / 坐标越界 / FEN 字符非法返回 null（防御旧库脏数据）。
 */
export function decodeRecordMove(raw: unknown): Move | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Partial<RawRecordMove>
  if (!Array.isArray(r.f) || !Array.isArray(r.t)) return null
  const [fc, fr] = r.f
  const [tc, tr] = r.t
  if (typeof fc !== 'number' || typeof fr !== 'number') return null
  if (typeof tc !== 'number' || typeof tr !== 'number') return null
  if (!inBoard(fc, fr) || !inBoard(tc, tr)) return null
  const piece = pieceFromFenOrNull(r.p)
  if (r.p !== null && r.p !== undefined && piece === undefined) return null
  const captured = pieceFromFenOrNull(r.x)
  if (r.x !== null && r.x !== undefined && captured === undefined) return null
  return { from: pos(fc, fr), to: pos(tc, tr), piece, captured }
}
