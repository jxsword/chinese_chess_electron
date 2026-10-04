/**
 * 语料库视图模型类型（渲染层投影，06 文档 §6）。
 * ParsedPuzzle 的 UI 投影：预计算 moveCount 与 isEndgamePuzzle（避免渲染期重复判定）。
 */
export interface ParsedPuzzleView {
  id: string
  initialFen: string
  solutionMoves: string[]
  title: string | null
  description: string | null
  source: string
  format: string
  difficulty: number
  moveCount: number
  /** 残局/排局题 = true；全局对局 = false（puzzle_data.dart:74-86） */
  endgame: boolean
}
