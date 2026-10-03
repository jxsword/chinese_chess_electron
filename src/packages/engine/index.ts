/**
 * 内置 AI 引擎（packages/engine）出口，03 文档。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号。
 * 供 engine.worker、渲染层回退计算与 Vitest 对拍三端共用。
 */
export {
  EngineBoard,
  packedToMove,
  posToIndex,
  indexToPos,
  packedFrom,
  packedTo,
  packedCaptCode,
  PIECE_VALUE
} from './engineBoard'
export {
  Search,
  SearchAbort,
  MATE_SCORE,
  INFINITY,
  type ScoredMove,
  type SearchConfig
} from './search'
export {
  findBestMove,
  findBestMoveEx,
  evaluateMove,
  type EngineReport,
  type EngineInput
} from './chessAi'
