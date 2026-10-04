/**
 * PGN（中国象棋变体）棋谱解析器（对应 pgn_parser.dart，06 文档 §4）。
 *
 * 支持两种着法文本：
 * - ICCS 坐标：`H2-E2` / `h2e2`（列 a-i、行 0-9，0 为红方底线）；
 * - 中文纵线记谱：`炮二平五`、`马8进7`、`前炮退二` 等，随局面逐着消解。
 *
 * 标签对支持 `[FEN]`（自定义起始局面）、`[Event]`、`[Red]`、`[Black]` 等；
 * 无 `[FEN]` 时使用标准初始局面。注释 `{...}`、行注释 `;...`、NAG `$n`、
 * 变着 `(...)` 被跳过；多局文件按局切分。
 *
 * 大文件（多局合一 `.pgns`，可达百 MB）不要整读内存：用 scanGameOffsets
 * 流式建立按局偏移索引，再按需读取单局交给 parseGame。文件访问经
 * PgnFileSource 注入（本包不接触 fs，Dart 侧 RandomAccessFile 的等价抽象）。
 */
import {
  Board,
  FenFormatError,
  buildFen,
  parseBoardFen,
  parseTurnFen,
  type Piece,
  type Position
} from '../rules'
import { parseIccs, formatIccs } from './iccs'
import type { ParsedPuzzle } from './parsedPuzzle'
import { difficultyFromMoveCount } from './parsedPuzzle'

/** 标签行：`[Key "Value"]`（pgn_parser.dart:34）。 */
const TAG_PATTERN = /^\s*\[(\w+)\s+"(.*)"\]\s*$/
/** 步数序号：`1.` `12...`（pgn_parser.dart:35）。 */
const MOVE_NUMBER_PATTERN = /\d+\s*\.+/g
/** 结果标记（pgn_parser.dart:36）。 */
const RESULT_PATTERN = /(1-0|0-1|1\/2-1\/2|\*)/g
/** NAG（pgn_parser.dart:37）。 */
const NAG_PATTERN = /\$\d+/g
/** 最内层变着括号（pgn_parser.dart:38）。 */
const INNERMOST_VAR_PATTERN = /\([^()]*\)/g

/** 着法 token（ICCS 与中文纵线记谱交替扫描，pgn_parser.dart:44-46）。 */
const MOVE_PATTERN =
  /([a-iA-I]\d{1,2}-?[a-iA-I]\d{1,2})|([前后中]?[车马炮兵卒帅将仕士相象砲][一二三四五六七八九\d０-９]?[平进退][一二三四五六七八九\d０-９])/g

/** 红方汉字数字（一~九，pgn_parser.dart:49-52）。 */
const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
}

/** 棋子中文字符 → 种类（颜色由轮走方决定，车/马/炮等红黑同形；pgn_parser.dart:55-61）。 */
const PIECE_KIND_BY_CHAR: Record<string, Piece['kind']> = {
  车: 'rook',
  马: 'knight',
  炮: 'cannon',
  砲: 'cannon',
  兵: 'pawn',
  卒: 'pawn',
  帅: 'king',
  将: 'king',
  仕: 'advisor',
  士: 'advisor',
  相: 'minister',
  象: 'minister'
}

/** 直线走子（进/退后跟格数）；其余为斜走子（进/退后跟目标纵线）。 */
const LINEAR_KINDS: ReadonlySet<Piece['kind']> = new Set([
  'rook',
  'cannon',
  'king',
  'pawn'
])

/** 多局 PGN 文件中单局的索引条目（偏移 + 摘要，pgn_parser.dart:580-597）。 */
export interface PgnGameIndex {
  offset: number
  length: number
  event: string | null
  red: string | null
  black: string | null
}

/** 单局标题（event 优先，缺省 `红 vs 黑`）。 */
export function pgnGameIndexTitle(index: PgnGameIndex): string {
  return index.event ?? `${index.red ?? '?'} vs ${index.black ?? '?'}`
}

/**
 * 大文件按局索引的文件源抽象（本包零 fs 依赖；主进程用 fs 实现）。
 * read 语义：返回 [offset, min(offset+length, byteLength)) 的字节；
 * offset ≥ byteLength 时返回空数组（同 Dart readSync 的 EOF 行为）。
 */
export interface PgnFileSource {
  readonly byteLength: number
  read(offset: number, length: number): Uint8Array
}

/** 单字节序非空白的行内字节判断（pgn_parser.dart:449-450/482-483）。 */
function hasNonWhitespaceByte(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if (b !== 0x0d && b !== 0x0a && b !== 0x20 && b !== 0x09) return true
  }
  return false
}

/** 有损 UTF-8 解码（等价 Dart utf8.decode(allowMalformed: true)）。 */
export function decodeUtf8Lossy(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function nonEmpty(s: string | null): string | null {
  if (s === null || s.trim().length === 0) return null
  return s.trim()
}

// ---------------------------------------------------------------------------
// 多局切分与整段解析
// ---------------------------------------------------------------------------

/** 解析整段 PGN 文本（可含多局），返回全部棋局；单局失败跳过不影响其余（pgn_parser.dart:73-84）。 */
export function parseGames(content: string, source = 'pgn'): ParsedPuzzle[] {
  const games: ParsedPuzzle[] = []
  for (const gameText of splitGames(content)) {
    try {
      games.push(parseGame(gameText, source))
    } catch (e) {
      if (e instanceof FenFormatError) continue // PGN 局解析失败，已跳过
      throw e
    }
  }
  return games
}

/** 把多局 PGN 文本按局切分：以"出现着法之后再次遇到标签行"作为新一局的开始（pgn_parser.dart:89-105）。 */
export function splitGames(content: string): string[] {
  const games: string[] = []
  const lines: string[] = []
  let inMoves = false
  for (const line of content.split(/\r?\n/)) {
    const isTag = line.startsWith('[') && TAG_PATTERN.test(line)
    if (isTag && inMoves) {
      games.push(lines.join('\n') + '\n')
      lines.length = 0
      inMoves = false
    }
    lines.push(line)
    if (!isTag && line.trim().length > 0) inMoves = true
  }
  if (lines.join('\n').trim().length > 0) games.push(lines.join('\n') + '\n')
  return games
}

/** 读取标签对（key 小写化；pgn_parser.dart:179-188）。 */
export function readPgnTags(gameText: string): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const line of gameText.split(/\r?\n/)) {
    const m = TAG_PATTERN.exec(line)
    if (m !== null) {
      tags[m[1].toLowerCase()] = m[2]
    }
  }
  return tags
}

// ---------------------------------------------------------------------------
// 单局解析
// ---------------------------------------------------------------------------

/**
 * 解析单局 PGN 文本为 ParsedPuzzle（pgn_parser.dart:113-168）。
 * [source] 为来源标注（如语料子目录名）。着法无法消解或局面非法时抛
 * FenFormatException（等价 Dart FormatException）。
 */
export function parseGame(gameText: string, source = 'pgn'): ParsedPuzzle {
  const tags = readPgnTags(gameText)
  const moveSection = extractMoveSection(gameText)

  // 起始局面：优先 FEN 标签，否则标准初始局面。
  const fenTag = nonEmpty(tags['fen'] ?? null)
  let initialBoard = Board.initial()
  let isRedTurn = true
  if (fenTag !== null) {
    initialBoard = Board.fromFen(fenTag)
    isRedTurn = parseTurnFen(fenTag)
  }
  const initialFen = buildFen({
    board: parseBoardFen(initialBoard.toFen()),
    isRedTurn
  })

  // 逐着消解（在棋盘上验证合法性）。
  const board = Board.fromFen(initialFen)
  const moves: string[] = []
  for (const token of moveSection) {
    const resolved = resolveToken(token, board, isRedTurn)
    if (resolved === null) {
      // 着法无法消解：停在当前处，保留已解析的合法前缀（pgn_parser.dart:136-141）。
      break
    }
    const iccs = formatIccs(resolved.from, resolved.to)
    if (iccs === null) break
    moves.push(iccs)
    board.applyMove({ from: resolved.from, to: resolved.to })
    isRedTurn = !isRedTurn
  }
  if (moves.length === 0) {
    throw new FenFormatError('PGN 局不含任何可解析着法')
  }

  const title = nonEmpty(tags['event'] ?? null) ?? defaultPgnTitle(tags['red'], tags['black'])
  const red = nonEmpty(tags['red'] ?? null)
  const black = nonEmpty(tags['black'] ?? null)
  const date = nonEmpty(tags['date'] ?? null)
  const site = nonEmpty(tags['site'] ?? null)
  const descParts: string[] = []
  if (red !== null || black !== null) descParts.push(`${red ?? '?'} vs ${black ?? '?'}`)
  if (date !== null) descParts.push(date)
  if (site !== null) descParts.push(site)

  return {
    id: `pgn/${source}/${title}/${moves.length}`,
    initialFen,
    solutionMoves: moves,
    title,
    description: descParts.join(' · '),
    source,
    format: 'pgn',
    difficulty: difficultyFromMoveCount(moves.length)
  }
}

function defaultPgnTitle(red: string | undefined, black: string | undefined): string {
  const r = nonEmpty(red ?? null) ?? '?'
  const b = nonEmpty(black ?? null) ?? '?'
  return `${r} 对 ${b}`
}

/**
 * 抽取着法文本并切分为 token 列表（pgn_parser.dart:194-217）。
 * 处理顺序：剔标签行 → 去块注释 → 去变着（嵌套）→ 去序号/NAG/结果 → 全文匹配着法。
 */
export function extractMoveSection(gameText: string): string[] {
  // 先剔除标签行（FEN 棋盘串里的字母数字会被误认为着法）。
  const text = gameText
    .split(/\r?\n/)
    .filter((l) => !TAG_PATTERN.test(l))
    .join('\n')
  // 单遍扫描去注释：{} 块注释内可含 ;，; 行注释内可有未闭合 {。
  const noComments = stripComments(text)
  // 变着：反复删除最内层括号以处理嵌套。
  let stripped = noComments
  for (;;) {
    const next = stripped.replace(INNERMOST_VAR_PATTERN, ' ')
    if (next === stripped) break
    stripped = next
  }
  const cleaned = stripped
    .replace(MOVE_NUMBER_PATTERN, ' ')
    .replace(NAG_PATTERN, ' ')
    .replace(RESULT_PATTERN, ' ')
    .replace(/\s+/g, '')

  return Array.from(cleaned.matchAll(MOVE_PATTERN), (m) => m[0])
}

/** 单遍扫描去注释：块注释 `{...}` 与行注释 `;...`（到行尾）（pgn_parser.dart:222-245）。 */
function stripComments(text: string): string {
  let out = ''
  let inBrace = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inBrace) {
      if (ch === '}') inBrace = false
    } else if (ch === '{') {
      inBrace = true
      out += ' '
    } else if (ch === ';') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += ' '
      continue // '\n' 本身留给下一轮正常写入
    } else {
      out += ch
    }
    i += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// 着法消解（pgn_parser.dart:253-422）
// ---------------------------------------------------------------------------

export interface ResolvedFromTo {
  from: Position
  to: Position
}

/** 把单个着法 token 消解为棋盘上的起止坐标；ICCS 直查、中文按候选+合法走法唯一匹配。 */
export function resolveToken(
  token: string,
  board: Board,
  isRedTurn: boolean
): ResolvedFromTo | null {
  const iccs = parseIccs(token)
  if (iccs !== null) {
    return board.pieceAtP(iccs.from) !== null ? iccs : null
  }
  return resolveChineseMove(token, board, isRedTurn)
}

/** 解析数字字符（汉字、半角或全角阿拉伯数字——部分生成器黑方用全角；pgn_parser.dart:378-385）。 */
function parseNumberChar(ch: string): number | null {
  const cn = CN_DIGITS[ch]
  if (cn !== undefined) return cn
  // 全角 ０-９ → 半角。
  const code = ch.charCodeAt(0)
  if (code >= 0xff10 && code <= 0xff19) return code - 0xff10
  return /^\d+$/.test(ch) ? Number.parseInt(ch, 10) : null
}

/** 纵线号 → 列号：红方从右起一~九（col = 9-n），黑方从其右手起 1~9（col = n-1）。 */
function numberToCol(n: number, side: 'red' | 'black'): number {
  return side === 'red' ? 9 - n : n - 1
}

function resolveChineseMove(
  token: string,
  board: Board,
  isRedTurn: boolean
): ResolvedFromTo | null {
  if (token.length === 0) return null
  const side = isRedTurn ? ('red' as const) : ('black' as const)

  // 结构解析：[前后中]? 棋子 [列号?] 平/进/退 数字
  let idx = 0
  let modifier: string | undefined
  if (token[idx] === '前' || token[idx] === '后' || token[idx] === '中') {
    modifier = token[idx]
    idx += 1
  }
  const kind = PIECE_KIND_BY_CHAR[token[idx]]
  if (kind === undefined) return null
  idx += 1

  let colNumber: number | null = null // 列号（可能省略）
  if (idx < token.length) {
    colNumber = parseNumberChar(token[idx])
    if (colNumber !== null) idx += 1
  }
  if (idx >= token.length) return null
  const action = token[idx] // 平 / 进 / 退
  if (action !== '平' && action !== '进' && action !== '退') return null
  idx += 1
  if (idx >= token.length) return null
  const targetNumber = parseNumberChar(token[idx])
  if (targetNumber === null) return null
  idx += 1
  if (idx !== token.length) return null // 应恰好消费完

  const isLinear = LINEAR_KINDS.has(kind)

  // 候选棋子：按列号或前/后/中修饰筛选。
  const candidates: Position[] = []
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 9; col++) {
      const p = board.pieceAt(col, row)
      if (p !== null && p.kind === kind && p.side === side) {
        candidates.push({ col, row })
      }
    }
  }
  if (candidates.length === 0) return null

  const fromChoices: Position[] = []
  if (modifier !== undefined && colNumber !== null) {
    // 非标准组合"前兵九平八"：先限定列，再在同列多子中取前/后/中。
    const col = numberToCol(colNumber, side)
    const inCol = candidates.filter((p) => p.col === col)
    inCol.sort((a, b) => a.row - b.row)
    if (inCol.length < 2) return null
    const rows = inCol.map((p) => p.row)
    const ordered = side === 'red' ? rows : [...rows].reverse()
    const pick = pickByModifier(modifier, ordered)
    if (pick === null) return null
    const chosen = inCol.find((p) => p.row === pick)
    if (chosen === undefined) return null
    fromChoices.push(chosen)
  } else if (modifier !== undefined) {
    // 前/后/中：用于同列同类多子，省略列号；找到有多个同类子的列。
    const byCol = new Map<number, Position[]>()
    for (const c of candidates) {
      const list = byCol.get(c.col)
      if (list === undefined) byCol.set(c.col, [c])
      else list.push(c)
    }
    for (const entry of byCol.values()) {
      if (entry.length < 2) continue
      const rows = entry.map((p) => p.row)
      rows.sort((a, b) => a - b)
      // 红方 row 小者为"前"，黑方相反。
      const ordered = side === 'red' ? rows : [...rows].reverse()
      const pick = pickByModifier(modifier, ordered)
      if (pick !== null) {
        const chosen = entry.find((p) => p.row === pick)
        if (chosen !== undefined) fromChoices.push(chosen)
      }
    }
  } else if (colNumber !== null) {
    const col = numberToCol(colNumber, side)
    for (const p of candidates) {
      if (p.col === col) fromChoices.push(p)
    }
  } else {
    return null // 无列号也无前后修饰，无法消解
  }

  // 在候选棋子的合法走法中寻找唯一匹配。
  const matches = new Map<string, ResolvedFromTo>()
  for (const from of fromChoices) {
    for (const move of board.legalMovesFor(from)) {
      if (
        matchesAction(move.to, from, action, targetNumber, isLinear, side)
      ) {
        matches.set(`${move.to.col},${move.to.row}`, { from, to: move.to })
      }
    }
  }
  if (matches.size !== 1) return null
  return matches.values().next().value ?? null
}

/** 前→排首；后→排尾；中→中间位（≥3 子才有意义，pgn_parser.dart:322-327）。 */
function pickByModifier(modifier: string, ordered: number[]): number | null {
  if (modifier === '前') return ordered[0] ?? null
  if (modifier === '后') return ordered[ordered.length - 1] ?? null
  if (modifier === '中') {
    return ordered.length >= 3 ? ordered[Math.floor(ordered.length / 2)] : null
  }
  return null
}

function matchesAction(
  to: Position,
  from: Position,
  action: string,
  number: number,
  isLinear: boolean,
  side: 'red' | 'black'
): boolean {
  const red = side === 'red'
  switch (action) {
    case '平':
      // 平移：目标纵线，行不变。
      return to.col === numberToCol(number, side) && to.row === from.row
    case '进':
      if (isLinear) {
        // 直线子进：列不变，前进 number 格。
        return to.col === from.col && to.row === from.row + (red ? -number : number)
      }
      // 斜走子进：数字为目标纵线，行向前。
      return (
        to.col === numberToCol(number, side) &&
        (red ? to.row < from.row : to.row > from.row)
      )
    case '退':
      if (isLinear) {
        return to.col === from.col && to.row === from.row + (red ? number : -number)
      }
      return (
        to.col === numberToCol(number, side) &&
        (red ? to.row > from.row : to.row < from.row)
      )
  }
  return false
}

// ---------------------------------------------------------------------------
// 大文件按局索引（pgn_parser.dart:430-559）
// ---------------------------------------------------------------------------

/** 块大小 1MB（pgn_parser.dart:435）。 */
const CHUNK_SIZE = 1 << 20
/** 单行字节缓冲上限：超过后该行按非标签行（moves 行）处理并丢弃剩余内容（pgn_parser.dart:438）。 */
const MAX_PENDING_BYTES = 8 << 20

/**
 * 流式扫描多局合一 PGN 文件，返回每局的偏移与摘要信息（pgn_parser.dart:430-547）。
 *
 * 不把文件读入内存；按字节定位行（UTF-8 多字节字符跨块安全），以
 * "出现着法后再次遇到标签行"分界。仅标签行被解码，其余保持字节。
 */
export function scanGameOffsets(source: PgnFileSource, maxGames = -1): PgnGameIndex[] {
  const result: PgnGameIndex[] = []
  const processLine = (
    lineBytes: Uint8Array,
    lineStart: number,
    state: {
      gameStart: number
      gameTags: Record<string, string>
      inMoves: boolean
      pendingTruncated: boolean
    }
  ): void => {
    if (state.pendingTruncated) {
      // 超长行按非标签行处理（计为 moves 行），不解析内容。
      if (hasNonWhitespaceByte(lineBytes)) {
        state.inMoves = true
        if (state.gameStart < 0) state.gameStart = lineStart
      }
      return
    }
    const isTagLine = lineBytes.length > 0 && lineBytes[0] === 0x5b // '['
    if (isTagLine) {
      if (state.inMoves) {
        result.push({
          offset: state.gameStart,
          length: lineStart - state.gameStart,
          event: nonEmpty(state.gameTags['event'] ?? null),
          red: nonEmpty(state.gameTags['red'] ?? null),
          black: nonEmpty(state.gameTags['black'] ?? null)
        })
        state.gameTags = {}
        state.inMoves = false
        state.gameStart = lineStart
      } else if (state.gameStart < 0) {
        state.gameStart = lineStart
      }
      const lineText = decodeUtf8Lossy(lineBytes)
      const m = TAG_PATTERN.exec(lineText)
      if (m !== null) {
        state.gameTags[m[1].toLowerCase()] = m[2]
      }
    } else if (hasNonWhitespaceByte(lineBytes)) {
      state.inMoves = true
    }
  }

  let filePos = 0 // 已读完的字节数
  let pendingStart = 0 // pending[0] 在文件中的位置
  const state = {
    gameStart: -1,
    gameTags: {} as Record<string, string>,
    inMoves: false,
    pendingTruncated: false
  }
  let pending = new Uint8Array(0) // 未成行的剩余字节

  for (;;) {
    // read 语义：返回 [offset, min(offset+length, byteLength)) 的字节；EOF 返回空。
    const chunk = source.read(filePos, CHUNK_SIZE)
    if (chunk.length === 0) break
    let segStart = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a) {
        let lineBytes: Uint8Array
        let lineStart: number
        if (pending.length > 0) {
          lineBytes = new Uint8Array(pending.length + (i - segStart))
          lineBytes.set(pending, 0)
          lineBytes.set(chunk.subarray(segStart, i), pending.length)
          lineStart = pendingStart
        } else {
          lineBytes = chunk.subarray(segStart, i)
          lineStart = filePos + segStart
        }
        processLine(lineBytes, lineStart, state)
        pending = new Uint8Array(0)
        state.pendingTruncated = false
        segStart = i + 1
        if (maxGames > 0 && result.length >= maxGames) return result
      }
    }
    if (pending.length === 0) pendingStart = filePos + segStart
    if (segStart < chunk.length) {
      const remainder = chunk.subarray(segStart)
      const room = MAX_PENDING_BYTES - pending.length
      if (remainder.length > room) {
        if (room > 0) {
          const grown = new Uint8Array(pending.length + room)
          grown.set(pending, 0)
          grown.set(remainder.subarray(0, room), pending.length)
          pending = grown
        }
        state.pendingTruncated = true
      } else {
        const grown = new Uint8Array(pending.length + remainder.length)
        grown.set(pending, 0)
        grown.set(remainder, pending.length)
        pending = grown
      }
    }
    filePos += chunk.length
  }
  // 文件末尾最后一行（若非空）。
  if (pending.length > 0) {
    processLine(pending, pendingStart, state)
    state.pendingTruncated = false
  }
  if (state.gameStart >= 0) {
    const end = source.byteLength
    if (end > state.gameStart) {
      result.push({
        offset: state.gameStart,
        length: end - state.gameStart,
        event: nonEmpty(state.gameTags['event'] ?? null),
        red: nonEmpty(state.gameTags['red'] ?? null),
        black: nonEmpty(state.gameTags['black'] ?? null)
      })
    }
  }
  return result
}
