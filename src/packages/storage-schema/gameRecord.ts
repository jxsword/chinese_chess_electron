/**
 * 棋谱领域对象与组装逻辑（对应 game_record.dart，07 文档 §1.2/§5）。
 * 纯 TypeScript：只依赖规则内核与纯类型，三端可共用。
 */
import { Board, chineseNotation, pieceFromFenChar, type Move } from '../rules'
import type { GameResult, GameMode, SolveStatus } from '@shared/ipc/types'

/** 棋谱求解状态中文标签（game_record.dart:24-29） */
export function solveStatusLabel(status: SolveStatus): string {
  switch (status) {
    case 'none':
      return '对局'
    case 'solved':
      return '已破解'
    case 'noSolution':
      return '无解'
    case 'timeout':
      return '未决(超时)'
  }
}

/** 残局模式常量（game_record.dart:101） */
export const ENDGAME_MODE: GameMode = 'endgame'

/** 模式中文标签（game_record.dart:103-111） */
export function modeLabelOf(mode: string): string {
  switch (mode) {
    case 'humanVsAi':
      return '人机对战'
    case 'humanVsHuman':
      return '双人对弈'
    case 'aiVsAi':
      return '机机对战'
    case 'humanVsLlm':
      return '人机(大模型)'
    case 'llmVsLlm':
      return '大模型对战'
    case 'endgame':
      return '残局破解'
    default:
      return mode
  }
}

/** 是否残局类棋谱（game_record.dart:82） */
export const isEndgameMode = (mode: string): boolean => mode === ENDGAME_MODE

/** 是否唯一解：solved 且只有一条破解走法（game_record.dart:85-86） */
export const hasUniqueSolution = (status: SolveStatus | null, solutions: string[][] | null): boolean =>
  status === 'solved' && solutions !== null && solutions.length === 1

/** 终局 FEN：从 initialFen 重放 moves；遇到与局面不符的走法即止损（game_record.dart:89-96） */
export function finalFenOf(initialFen: string, moves: readonly Move[]): string {
  const board = Board.fromFen(initialFen)
  for (const m of moves) {
    if (board.pieceAtP(m.from) === null) break
    board.applyMove({ from: m.from, to: m.to })
  }
  return board.toFen()
}

/** 对 moves 重放补齐棋子/吃子信息；局面不符即截断（防御式，game_record.dart:225-240） */
export function fillMovePieces(initialFen: string, moves: readonly Move[]): Move[] {
  const board = Board.fromFen(initialFen)
  const filled: Move[] = []
  for (const m of moves) {
    const piece = board.pieceAtP(m.from)
    if (piece === null) break
    const applied = board.applyMove({ from: m.from, to: m.to })
    filled.push({ from: applied.from, to: applied.to, piece, captured: applied.captured })
  }
  return filled
}

/** 从终局反推初始 FEN：逆序悔棋；数据不一致时尽早止损（game_record.dart:188-195） */
function initialFenFromEnd(finalFen: string, moves: readonly Move[]): string {
  const board = Board.fromFen(finalFen)
  for (const m of [...moves].reverse()) {
    if (board.pieceAtP(m.to) === null) break
    board.undoMove({ from: m.from, to: m.to, captured: m.captured })
  }
  return board.toFen()
}

/** 标题缺省自动生成：`YYYY-MM-DD 模式名`（game_record.dart:181-185） */
export function defaultRecordTitle(mode: string, now: Date = new Date()): string {
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${modeLabelOf(mode)}`
}

/** 一条棋谱记录（game_record.dart:36-80 领域形状；createdAt 为 epoch 毫秒） */
export interface GameRecordData {
  id?: number
  title: string
  mode: string
  initialFen: string
  /** 对局/主变走法，含棋子与吃子信息 */
  moves: Move[]
  result: GameResult | null
  redName?: string | null
  blackName?: string | null
  solveStatus: SolveStatus
  solutions: string[][]
  llmNote?: string | null
  note?: string | null
  createdAt: number | null
}

export interface RecordFromSessionInput {
  title?: string | null
  mode: string
  finalFen: string
  /** BoardViewModel 维护的含棋子信息历史 */
  moves: readonly Move[]
  result?: GameResult | null
  redName?: string | null
  blackName?: string | null
  note?: string | null
  createdAt?: number | null
}

/** 从一局对局的完整走法历史组装棋谱（game_record.dart:157-179） */
export function recordFromSession(input: RecordFromSessionInput): GameRecordData {
  return {
    title: input.title && input.title.trim().length > 0 ? input.title.trim() : defaultRecordTitle(input.mode),
    mode: input.mode,
    initialFen: initialFenFromEnd(input.finalFen, input.moves),
    moves: [...input.moves],
    result: input.result ?? null,
    redName: input.redName ?? null,
    blackName: input.blackName ?? null,
    solveStatus: 'none',
    solutions: [],
    llmNote: null,
    note: input.note ?? null,
    createdAt: input.createdAt ?? Date.now()
  }
}

/** 中文记谱的兜底（走子信息缺失时退回 ICCS，game_record.dart:210-220） */
export function iccsFallbackFormat(m: Move): string {
  const cell = (col: number, row: number): string =>
    `${String.fromCharCode('a'.charCodeAt(0) + col)}${9 - row}`
  return `${cell(m.from.col, m.from.row)}${cell(m.to.col, m.to.row)}`
}

/** 走法的中文记谱序列；以 initialFen 起重放补齐棋子信息（game_record.dart:200-207） */
export function chineseNotations(initialFen: string, moves: readonly Move[]): string[] {
  return fillMovePieces(initialFen, moves).map((m) =>
    m.piece === undefined ? iccsFallbackFormat(m) : chineseNotation(m.piece, m.from, m.to)
  )
}

/** 起始 FEN 是否为标准开局盘面（pgn_writer.dart:121-124，分享文本省略用） */
export function isInitialBoardFen(fen: string): boolean {
  return fen.split(' ')[0] === 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR'
}

/** 对局结果中文标签（pgn_writer.dart:99-103） */
export function resultLabel(result: GameResult): string {
  switch (result) {
    case 'redWins':
      return '红方胜'
    case 'blackWins':
      return '黑方胜'
    case 'draw':
      return '和棋'
  }
}

/** FEN 字符 → 棋子（供 DAO/展示层反查；非法返回 null） */
export const pieceFromFen = pieceFromFenChar
