/**
 * 工作室整体校验与入库辅助（endgame_studio_page.dart _validate/_recordTitle 移植）。
 *
 * 校验五条（08 文档 §4）：FEN 格式 / 双王各一 / 位置合法 / 数量上限 /
 * 对手不可正被将军 + 轮走方有着可走——FEN 导入与识图载入的棋盘同样过此门。
 */
import { Board, buildFen, isValidFen, pieceLabel, type BoardGrid, type Piece } from '@packages/rules'
import { countIssue, placementIssue } from './setupRules'

/** 工作室当前局面的整体校验：返回全部问题（空数组 = 通过）。 */
export function validateStudioPosition(grid: BoardGrid, redTurn: boolean): string[] {
  const problems: string[] = []
  const fen = buildFen({ board: grid, isRedTurn: redTurn })
  if (!isValidFen(fen)) {
    problems.push('FEN 格式非法（每行列数必须为 9）')
    return problems
  }
  let redKing = 0
  let blackKing = 0
  for (const row of grid) {
    for (const piece of row) {
      if (piece?.kind === 'king') {
        if (piece.side === 'red') redKing++
        else blackKing++
      }
    }
  }
  if (redKing !== 1 || blackKing !== 1) {
    problems.push(`双方必须各有一个将/帅（红 ${redKing} / 黑 ${blackKing}）`)
  }
  if (problems.length > 0) return problems

  // 全盘棋子位置与数量合法性（FEN 导入/识图载入的棋盘同样校验）。
  const counts = new Map<Piece, number>()
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 9; col++) {
      const piece = grid[row][col]
      if (piece === null) continue
      counts.set(piece, (counts.get(piece) ?? 0) + 1)
      const issue = placementIssue(piece, col, row)
      if (issue !== null) {
        problems.push(`(${col},${row}) ${pieceLabel(piece)}：${issue}`)
      }
    }
  }
  const countIssueMsg = countIssue(counts)
  if (countIssueMsg !== null) problems.push(countIssueMsg)
  if (problems.length > 0) return problems

  const board = Board.fromFen(fen)
  // 轮走方的对手不应正被将军（否则说明上一手未解除将军，局面非法）。
  if (board.isCheck(board.turn === 'red' ? 'black' : 'red')) {
    problems.push('轮走方行棋前对方已被将军，局面非法')
  }
  if (!board.hasAnyLegalMoveFor(board.turn)) {
    problems.push('轮走方已无着可走（该局面已分胜负）')
  }
  return problems
}

// ---------------------------------------------------------------------------
// 入库辅助（endgame_studio_page.dart:_recordTitle，04 文档 §7）
// ---------------------------------------------------------------------------

/** 求解结论的入库标注（唯一解/多解/无解/未决）。 */
export type StudioSolveLabel = '唯一解' | '多解' | '无解' | '未决'

/** SolveResult → 入库标注。 */
export function solveLabelOf(
  status: 'solved' | 'noSolution' | 'timeout',
  solutionCount: number
): StudioSolveLabel {
  switch (status) {
    case 'solved':
      return solutionCount === 1 ? '唯一解' : '多解'
    case 'noSolution':
      return '无解'
    case 'timeout':
      return '未决'
  }
}

/** 自动生成棋谱标题：`M-D 红方残局（唯一解/多解/无解/未决）`（:726-735）。 */
export function studioRecordTitle(label: StudioSolveLabel, redTurn: boolean, now: Date = new Date()): string {
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${now.getMonth() + 1}-${pad(now.getDate())} ${redTurn ? '红' : '黑'}方残局（${label}）`
}

/** 未求解保存的标题：`M-D 红方残局（未求解）`（:526-528）。 */
export function studioUnsolvedTitle(redTurn: boolean, now: Date = new Date()): string {
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${now.getMonth() + 1}-${pad(now.getDate())} ${redTurn ? '红' : '黑'}方残局（未求解）`
}
