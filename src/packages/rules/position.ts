/**
 * 坐标（对应 move.dart Position）：列 0..8（从左到右），行 0..9（红方在下）。
 *
 * 注意：作为方向向量使用时 col/row 可能为负数或越界（如马腿偏移），
 * 因此不做范围断言，由调用方用 [inBoard] 校验（02 文档 §1.1）。
 */
export interface Position {
  readonly col: number
  readonly row: number
}

/** 构造坐标。 */
export const pos = (col: number, row: number): Position => ({ col, row })

/** 加法运算（结果可能越界，调用方需检查）。 */
export const addPos = (a: Position, b: Position): Position => ({
  col: a.col + b.col,
  row: a.row + b.row
})

/** 值相等（move.dart operator==）。 */
export const samePos = (a: Position, b: Position): boolean =>
  a.col === b.col && a.row === b.row

/** 是否在棋盘内（board.dart:50-51）。 */
export const inBoard = (col: number, row: number): boolean =>
  col >= 0 && col < 9 && row >= 0 && row < 10
