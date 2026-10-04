/**
 * 残局求解器（packages/solver）出口，04 文档。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 * 供 solver.worker、渲染层回退计算与 Vitest 对拍三端共用。
 */
export {
  MAX_SOLUTIONS,
  isWinningFirstMove,
  solveEndgame,
  solveIsUnique,
  type EndgameSolveStatus,
  type SolveOptions,
  type SolveResult,
  type SolverSolution
} from './endgameSolver'
