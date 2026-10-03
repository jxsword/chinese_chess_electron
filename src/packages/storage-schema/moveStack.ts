/**
 * 自动存档走法栈（saved_games.move_stack_json，07 文档 §1.1/§1.3）。
 * 纯 TypeScript，不依赖任何环境 API。
 */
import type { Move } from '../rules'

/** 裸四元组 [fCol, fRow, tCol, tRow]（无棋子信息） */
export type MoveStack = number[][]

/** 对局走法历史 → 存档四元组（repository.dart:25-27 的序列化语义） */
export function encodeMoveStack(moves: readonly Move[]): MoveStack {
  return moves.map((m) => [m.from.col, m.from.row, m.to.col, m.to.row])
}

/** 防御式校验：数组 of 长度 4 的整数数组（恢复链路跳脏记录前的第一道闸） */
export function isMoveStack(value: unknown): value is MoveStack {
  if (!Array.isArray(value)) return false
  return value.every(
    (m) =>
      Array.isArray(m) &&
      m.length === 4 &&
      m.every((n) => typeof n === 'number' && Number.isInteger(n))
  )
}
