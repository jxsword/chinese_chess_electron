/**
 * 分享文本（对应 pgn_writer.dart writeShareText，07 文档 §5 F3）。
 * 协议面：输出经快照测试锁定（test/storage/shareText.spec.ts），改动须显式 review。
 */
import { modeLabelOf, resultLabel, isInitialBoardFen, hasUniqueSolution, chineseNotations } from './gameRecord'
import type { GameRecordData } from './gameRecord'

export function writeShareText(record: GameRecordData): string {
  const lines: string[] = []
  lines.push(`【中国象棋 Ultra 棋谱】${record.title}`)
  const redName = record.redName !== null && record.redName !== undefined ? `  红方: ${record.redName}` : ''
  const blackName = record.blackName !== null && record.blackName !== undefined ? `  黑方: ${record.blackName}` : ''
  lines.push(`模式: ${modeLabelOf(record.mode)}${redName}${blackName}`)
  if (record.result !== null) {
    lines.push(`结果: ${resultLabel(record.result)}`)
  }
  if (!isInitialBoardFen(record.initialFen)) {
    lines.push(`起始 FEN: ${record.initialFen}`)
  }
  if (record.note !== null && record.note !== undefined && record.note.trim().length > 0) {
    lines.push(`备注: ${record.note}`)
  }
  if (record.moves.length > 0) {
    lines.push('着法（中文记谱）:')
    const notations = chineseNotations(record.initialFen, record.moves)
    for (let i = 0; i < notations.length; i += 2) {
      const round = Math.floor(i / 2) + 1
      const red = notations[i] ?? ''
      const black = i + 1 < notations.length ? (notations[i + 1] ?? '') : ''
      lines.push(`${round}. ${red}  ${black}`)
    }
  }
  const solutions = record.solutions ?? []
  if (solutions.length > 0) {
    const unique = hasUniqueSolution(record.solveStatus, record.solutions) ? '，唯一解' : ''
    lines.push(`破解之法（${solutions.length} 条${unique}）:`)
    solutions.forEach((solution, i) => {
      lines.push(`解法${i + 1}: ${solution.join(' ')}`)
    })
  } else if (record.solveStatus === 'noSolution') {
    lines.push('求解结论: 无解（深度上界内已证明）')
  } else if (record.solveStatus === 'timeout') {
    lines.push('求解结论: 限时内未找到解法')
  }
  if (record.llmNote !== null && record.llmNote !== undefined && record.llmNote.trim().length > 0) {
    lines.push(`大模型注释: ${record.llmNote}`)
  }
  return lines.join('\n') // 等价 Dart writeln 序列 + trimRight
}
