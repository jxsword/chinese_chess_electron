/**
 * 棋谱解析门面（对应 puzzle_parser.dart，06 文档 §4.5）。
 *
 * 按文件扩展名分发到 parseXqf / PGN 解析，并对解析结果做
 * 重放校验（用规则内核 Board 逐着验证合法性，遇到非法着即截断），
 * 保证进入 UI 的棋谱可以在演示器中完整播放。
 */
import { Board } from '../rules'
import { parseIccs } from './iccs'
import type { ParsedPuzzle } from './parsedPuzzle'
import { copyPuzzleWith, difficultyFromMoveCount } from './parsedPuzzle'
import { parseGames } from './pgnParser'
import { parseXqf } from './xqfParser'

/** 大文件导入阈值：超过此大小的多局 PGN 整读内存代价过高（如 101MB 的 .pgns）。 */
export const STREAM_IMPORT_THRESHOLD_BYTES = 8 * 1024 * 1024

/** 判断导入是否应走按局索引流式路径（仅多局 PGN 大文件，puzzle_parser.dart:55-59）。 */
export function shouldStreamImport(fileName: string, byteLength: number): boolean {
  const ext = extensionOf(fileName)
  return (ext === 'pgn' || ext === 'pgns') && byteLength > STREAM_IMPORT_THRESHOLD_BYTES
}

function extensionOf(fileName: string): string {
  const dot = fileName.toLowerCase().lastIndexOf('.')
  return dot >= 0 ? fileName.toLowerCase().slice(dot + 1) : ''
}

/**
 * 解析棋谱字节流为棋局列表（XQF 单局；PGN 可多局）（puzzle_parser.dart:30-48）。
 * [fileName] 仅用于判断格式；[source] 作为来源标注（如语料分类）。
 * 不认识的扩展名抛异常。
 */
export function parsePuzzleFile(
  fileName: string,
  bytes: Uint8Array,
  source = 'import'
): ParsedPuzzle[] {
  const ext = extensionOf(fileName)
  let parsed: ParsedPuzzle[]
  switch (ext) {
    case 'xqf':
      parsed = [parseXqf(bytes, source)]
      break
    case 'pgn':
    case 'pgns':
      parsed = parseGames(decodeUtf8(bytes), source)
      break
    default:
      throw new Error(`不支持的棋谱格式: .${ext}（支持 .xqf / .pgn）`)
  }
  return validateAndDedupe(parsed)
}

/** 有损 UTF-8 解码（与 Dart utf8.decode(allowMalformed: true) 等价）。 */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/**
 * 逐局重放校验；非法着截断（至少保留 1 着，否则丢弃该局），并保证 id 唯一
 * （puzzle_parser.dart:62-101）。
 */
function validateAndDedupe(input: ParsedPuzzle[]): ParsedPuzzle[] {
  const result: ParsedPuzzle[] = []
  const seenIds = new Set<string>()
  for (const puzzle of input) {
    try {
      const board = Board.fromFen(puzzle.initialFen)
      const valid: string[] = []
      for (const iccs of puzzle.solutionMoves) {
        const pos = parseIccs(iccs)
        if (pos === null || board.pieceAtP(pos.from) === null) break
        const legal = board
          .legalMovesFor(pos.from)
          .some(
            (m) =>
              m.from.col === pos.from.col &&
              m.from.row === pos.from.row &&
              m.to.col === pos.to.col &&
              m.to.row === pos.to.row
          )
        if (!legal) break // 非法着：截断
        board.applyMove({ from: pos.from, to: pos.to })
        valid.push(iccs)
      }
      if (valid.length === 0) continue // 无可演示走法，丢弃
      let id = puzzle.id
      while (seenIds.has(id)) {
        id = `${id}#` // id 冲突加 # 后缀（puzzle_parser.dart:88-90）
      }
      seenIds.add(id)
      result.push(
        copyPuzzleWith(puzzle, {
          id,
          solutionMoves: valid,
          difficulty: difficultyFromMoveCount(valid.length)
        })
      )
    } catch {
      // FEN 无效等异常：丢弃该局（puzzle_parser.dart:96-98）。
    }
  }
  return result
}
