/** 单步走法（对应 move.dart Move）。 */
import type { Position } from './position'
import type { Piece } from './piece'

/**
 * 单步走法：含起点/终点/走子棋子/被吃棋子，便于悔棋与走法记录展示。
 * `piece` 供记谱/悔棋展示；`captured` 供 undo 恢复（02 文档 §1.3）。
 */
export interface Move {
  from: Position
  to: Position
  /** 走子棋子（走子方可选填）。 */
  piece?: Piece
  /** 被吃棋子；走空格时省略。 */
  captured?: Piece
}
