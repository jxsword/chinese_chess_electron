/**
 * 棋谱"进入对战"的起点计算（对应 record_battle_launcher.dart:23-35 的纯函数部分）。
 * UI 弹层（模式/执方选择）在渲染层 features/record/RecordLauncherDialog.tsx。
 * 纯 TypeScript：只依赖规则内核与纯类型。
 */
import { finalFenOf, isEndgameMode, type GameRecordData } from './gameRecord'

/**
 * 计算棋谱"从保存局面继续"的起点 FEN（record_battle_launcher.dart:29-32）。
 * - 对局类（有走法）：起点 = 终局局面（initialFen 重放 moves）；
 * - 残局类（无走法）：起点 = initialFen（行棋方由 FEN 决定）；
 * - 已分胜负的对局：无对战入口，返回 null。
 */
export function battleStartFen(record: GameRecordData): string | null {
  if (!isEndgameMode(record.mode) && record.result !== null) return null
  return isEndgameMode(record.mode) ? record.initialFen : finalFenOf(record.initialFen, record.moves)
}

/** 棋谱是否提供"进入对战"入口（record_battle_launcher.dart:35）。 */
export function canLaunchBattle(record: GameRecordData): boolean {
  return battleStartFen(record) !== null
}

/** "进入对战"的模式选项（record_battle_launcher.dart:11-15）。 */
export interface BattleModeOption {
  id: 'humanVsAi' | 'humanVsHuman' | 'humanVsLlm' | 'llmVsLlm'
  label: string
  subtitle: string
}

export const BATTLE_MODE_OPTIONS: readonly BattleModeOption[] = [
  { id: 'humanVsAi', label: '人机对战（内置 AI）', subtitle: '可选难度与执方，AI 自动应手' },
  { id: 'humanVsHuman', label: '双人对弈', subtitle: '同屏轮流走子' },
  { id: 'humanVsLlm', label: '人机对战（大模型）', subtitle: '玩家执红，大模型执黑' },
  { id: 'llmVsLlm', label: '大模型对战', subtitle: '红黑双模型自动对弈' }
]

/** 各模式的续战路由（拼 fen/side query，页面侧 canSave=false 门控已就绪）。 */
export function battleRouteFor(mode: BattleModeOption['id'], fen: string, playerSide?: 'red' | 'black'): string {
  const query = `?fen=${encodeURIComponent(fen)}`
  switch (mode) {
    case 'humanVsAi':
      return `/human-vs-ai${query}&side=${playerSide === 'black' ? 'black' : 'red'}`
    case 'humanVsHuman':
      return `/human-vs-human${query}`
    case 'humanVsLlm':
      return `/human-vs-llm${query}`
    case 'llmVsLlm':
      return `/llm-vs-llm${query}`
  }
}
