/**
 * 解析后的棋谱数据模型（对应 puzzle_data.dart ParsedPuzzle）。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号。
 */

/** 标准开局盘面部分（用于区分全局对局与残局/排局，puzzle_data.dart:65-66）。 */
const STANDARD_INITIAL_BOARD =
  'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR'

/** 解析后的棋谱（残局题或全局对局，puzzle_data.dart:8-48）。 */
export interface ParsedPuzzle {
  /** 唯一标识符（`xqf/<source>/<title>` 或 `pgn/<source>/<title>/<n>`）。 */
  id: string
  /** 初始局面 FEN。 */
  initialFen: string
  /** 破解/对局走法序列（ICCS 坐标）。 */
  solutionMoves: string[]
  /** 残局标题。 */
  title: string | null
  /** 描述（对局双方/日期/赛事）。 */
  description: string | null
  /** 来源（如"残局/适情雅趣"）。 */
  source: string
  /** 格式（"xqf" / "pgn"）。 */
  format: string
  /** 难度等级（1-5）。 */
  difficulty: number
}

/** 残局步数（puzzle_data.dart:51）。 */
export const moveCountOf = (p: ParsedPuzzle): number => p.solutionMoves.length

/** 是否有破解走法（puzzle_data.dart:92）。 */
export const hasSolution = (p: ParsedPuzzle): boolean => p.solutionMoves.length > 0

/**
 * 按总步数推算难度分档（XQF/PGN 棋谱本身没有难度字段，puzzle_data.dart:56-62）：
 * ≤20 步入门(1)、21-40 初级(2)、41-80 中级(3)、81-150 高级(4)、>150 职业(5)。
 */
export function difficultyFromMoveCount(moveCount: number): number {
  if (moveCount <= 20) return 1
  if (moveCount <= 40) return 2
  if (moveCount <= 80) return 3
  if (moveCount <= 150) return 4
  return 5
}

/** 难度显示文本（puzzle_data.dart:95-109）。 */
export function difficultyText(difficulty: number): string {
  switch (difficulty) {
    case 1:
      return '入门'
    case 2:
      return '初级'
    case 3:
      return '中级'
    case 4:
      return '高级'
    case 5:
      return '职业'
    default:
      return '未知'
  }
}

/**
 * 是否为残局/排局题（区别于全局对局，puzzle_data.dart:74-86）。
 * 判定顺序：来源分类名关键词优先（"让子局"盘面非标准开局但属对局），
 * 否则按初始盘面是否为标准开局。
 */
export function isEndgamePuzzle(source: string, initialFen: string): boolean {
  if (
    source.includes('残局') ||
    source.includes('排局') ||
    source.includes('杀势')
  ) {
    return true
  }
  const fullGameKeywords = ['全局', '大师', '比赛', '布局', '中局', '名局', '让子']
  for (const keyword of fullGameKeywords) {
    if (source.includes(keyword)) return false
  }
  return initialFen.split(' ')[0] !== STANDARD_INITIAL_BOARD
}

/** 类型标签文案（puzzle_data.dart:89）。 */
export function kindLabel(source: string, initialFen: string): string {
  return isEndgamePuzzle(source, initialFen) ? '残局题' : '全局对局'
}

/**
 * 创建副本并覆盖指定字段（puzzle_data.dart:118-138 copyWith；
 * TS 侧只覆盖门面校验会改动的三个字段，其余字段引用原值）。
 */
export function copyPuzzleWith(
  puzzle: ParsedPuzzle,
  overrides: Partial<Pick<ParsedPuzzle, 'id' | 'solutionMoves' | 'difficulty'>>
): ParsedPuzzle {
  return { ...puzzle, ...overrides }
}
