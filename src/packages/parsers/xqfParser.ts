/**
 * XQF（象棋演播室）二进制棋谱解析器（对应 xqf_parser.dart，06 文档 §3）。
 *
 * 格式参考 XQF 规范（www.xqbase.com/protocol/cchess_xqf.htm）与
 * walker8088/cchess 的 `io_xqf.py` 实现（已对原项目语料实测）。
 *
 * 要点：
 * - 魔数为前两字节 `XQ`（0x58 0x51），第 3 字节是格式版本号，语料中分布
 *   在 0x0A–0x12；版本 <= 0x0A 的旧格式无加密，之后的版本对棋子布局与
 *   走子数据做字节变换加密。
 * - 32 个棋子的存放顺序固定（车马相仕帅仕相马车 + 炮炮 + 兵×5，红大写黑小写），
 *   每子 1 字节位置，编码为 `x*10 + y`（x=列 0-8，y=行，0 为红方底线），
 *   0xFF 表示让子（无此子）。
 * - 字符串字段为 GB18030（GBK 超集，iconv-lite 解码），按长度前缀存放。
 * - 走子数据是一棵记录树（每条记录 4 字节 + 可选注解），本解析器只取
 *   主线（变着分支仅存在于主线结束之后，不影响缓冲区对齐）。
 */
import * as iconv from 'iconv-lite'
import {
  FenFormatError,
  buildFen,
  pieceFromFenChar,
  type BoardGrid,
  type Piece
} from '../rules'
import { formatIccs, parseIccs } from './iccs'
import type { ParsedPuzzle } from './parsedPuzzle'
import { difficultyFromMoveCount } from './parsedPuzzle'

/** XQF 格式常量（xqf_parser.dart:38-49）。 */
export const XQF_HEADER_SIZE = 0x400

const MOVE_FROM_OFFSET = 0x18
const MOVE_TO_OFFSET = 0x20
const STEP_FLAG_MASK = 0xe0
const STEP_HAS_ANNO = 0x20
const STEP_HAS_NEXT = 0x80

/** 旧格式（版本 <= 0x0A）分界。 */
const LEGACY_VERSION_MAX = 0x0a

/**
 * 32 个棋子位次的 FEN 字符（红方大写、黑方小写，xqf_parser.dart:51-60）。
 * XQF 存放顺序为对称回文序：车马相仕帅仕相马车（9）+ 炮炮（2）+ 兵×5（16 子），
 * 黑方同序小写（已用语料实证校准，非部分文档所写的帅仕相马车序）。
 */
const PIECE_CHARS = [
  'R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R', 'C', 'C',
  'P', 'P', 'P', 'P', 'P',
  'r', 'n', 'b', 'a', 'k', 'a', 'b', 'n', 'r', 'c', 'c',
  'p', 'p', 'p', 'p', 'p'
] as const

/** 解密变换的种子串（XQF 作者版权串，用于生成 32 字节密钥表，xqf_parser.dart:63）。 */
const KEY_SEED = '[(C) Copyright Mr. Dong Shiwei.]'

/** XQF 解密密钥集（xqf_parser.dart:367-381）。 */
interface XqfKeys {
  keyXY: number
  keyXYf: number
  keyXYt: number
  keyRmkSize: number
  f32: number[]
}

/** 从 GB18030 字节解码字符串；解码失败返回 null（xqf_parser.dart:169-178）。 */
function decodeGbString(bytes: Uint8Array): string | null {
  try {
    return iconv.decode(bytes, 'gb18030')
  } catch {
    return null
  }
}

/** 读长度前缀字符串（1 字节长度 + 内容，xqf_parser.dart:169-178）。 */
function readString(bytes: Uint8Array, lenOffset: number, maxLen: number): string | null {
  const len = bytes[lenOffset]
  if (len <= 0 || len > maxLen) return null
  return decodeGbString(bytes.subarray(lenOffset + 1, lenOffset + 1 + len))
}

function defaultXqfTitle(red: string | null, black: string | null): string {
  if (red !== null || black !== null) return `${red ?? '?'} 对 ${black ?? '?'}`
  return '未命名对局'
}

/**
 * 密钥派生（xqf_parser.dart:187-225）：
 * 单字节变换基数 formula(x) = ((((x²*3+9)*3+8)*2+1)*3+8)（无尾因子）；
 * KeyXY 多乘一次自身头字节；KeyXYf/KeyXYt 依次链乘前一把钥匙；
 * FKeyBytes 由头部原始字节（而非派生密钥）与掩码/或值组合而成。
 */
function deriveKeys(header: {
  keyMask: number
  keyOrA: number
  keyOrB: number
  keyOrC: number
  keyOrD: number
  keysSum: number
  headKeyXY: number
  headKeyXYf: number
  headKeyXYt: number
}): XqfKeys {
  const formula = (x: number): number => ((((x * x) * 3 + 9) * 3 + 8) * 2 + 1) * 3 + 8

  const keyXY = (formula(header.headKeyXY) * header.headKeyXY) & 0xff
  const keyXYf = (formula(header.headKeyXYf) * keyXY) & 0xff
  const keyXYt = (formula(header.headKeyXYt) * keyXYf) & 0xff
  const keyRmkSize = (((header.keysSum * 256 + header.headKeyXY) % 32000) + 767) & 0xffff

  const keyBytes = [
    (header.keysSum & header.keyMask) | header.keyOrA,
    (header.headKeyXY & header.keyMask) | header.keyOrB,
    (header.headKeyXYf & header.keyMask) | header.keyOrC,
    (header.headKeyXYt & header.keyMask) | header.keyOrD
  ]
  const f32: number[] = []
  for (let i = 0; i < 32; i++) {
    f32.push(KEY_SEED.charCodeAt(i) & keyBytes[i % 4])
  }
  return { keyXY, keyXYf, keyXYt, keyRmkSize, f32 }
}

/**
 * 棋子布局 → 棋盘矩阵（xqf_parser.dart:229-265）。
 * 仅版本 >= 12 的布局做了位置置换；解密后每字节减 keyXY。
 */
function decodeBoard(boardBytes: Uint8Array, version: number, keys: XqfKeys | null): BoardGrid {
  const positions = new Array<number>(32).fill(0xff)
  if (keys === null) {
    for (let i = 0; i < 32; i++) positions[i] = boardBytes[i]
  } else {
    for (let i = 0; i < 32; i++) {
      if (version >= 12) {
        // 版本 >= 12：布局位置置换（4 段各 8 列重排的等价环形写法）。
        positions[(keys.keyXY + i + 1) & 0x1f] = boardBytes[i]
      } else {
        positions[i] = boardBytes[i]
      }
    }
    for (let i = 0; i < 32; i++) {
      positions[i] = (positions[i] - keys.keyXY) & 0xff
    }
  }

  const board: BoardGrid = Array.from({ length: 10 }, () =>
    Array<Piece | null>(9).fill(null)
  )
  for (let i = 0; i < 32; i++) {
    const v = positions[i]
    if (v > 89) continue // 0xFF 或越界 = 无子
    const col = Math.floor(v / 10)
    const row = v % 10
    if (col > 8 || row > 9) continue
    board[9 - row][col] = pieceFromFenChar(PIECE_CHARS[i])
  }
  return board
}

/**
 * 走子主线（xqf_parser.dart:269-346）。
 * 数据块每字节 (raw − f32[(headerSize+i) % 32]) & 0xFF；from/to 减偏移
 * 0x18/0x20 再减 keyXYf/keyXYt；注解长度 int32 且减 keyRmkSize。
 */
function decodeMainLine(bytes: Uint8Array, _version: number, keys: XqfKeys | null): string[] {
  let buff: Uint8Array
  if (keys === null) {
    buff = bytes.subarray(XQF_HEADER_SIZE)
  } else {
    const raw = bytes.subarray(XQF_HEADER_SIZE)
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) {
      out[i] = (raw[i] - keys.f32[(XQF_HEADER_SIZE + i) % 32]) & 0xff
    }
    buff = out
  }

  let index = 0
  const moves: string[] = []
  // 根记录：代表初始局面的伪走子，只关心其注解位。
  if (buff.length - index < 4) return moves
  const rootFlag = buff[index + 2]
  index += 4
  let annoteLen = 0
  if (keys === null) {
    annoteLen = readInt32(buff, index)
    index += 4
  } else {
    if ((rootFlag & STEP_FLAG_MASK & STEP_HAS_ANNO) !== 0) {
      annoteLen = readInt32(buff, index) - keys.keyRmkSize
      index += 4
    }
  }
  if (annoteLen > 0) index += annoteLen // 注解内容暂不展示，仅跳过

  while (buff.length - index >= 4) {
    const fromRaw = buff[index]
    const toRaw = buff[index + 1]
    const flagRaw = buff[index + 2]
    index += 4

    let hasNext: boolean
    let fromPos: number
    let toPos: number
    if (keys === null) {
      // 旧版本：注解长度总是存在；高 4 位有值 = 有后续走子。
      annoteLen = readInt32(buff, index)
      index += 4
      if (annoteLen > 0) index += annoteLen
      hasNext = (flagRaw & 0xf0) !== 0
      fromPos = (fromRaw - MOVE_FROM_OFFSET) & 0xff
      toPos = (toRaw - MOVE_TO_OFFSET) & 0xff
    } else {
      const flag = flagRaw & STEP_FLAG_MASK
      if ((flag & STEP_HAS_ANNO) !== 0) {
        annoteLen = readInt32(buff, index) - keys.keyRmkSize
        index += 4
        if (annoteLen > 0) index += annoteLen
      }
      hasNext = (flag & STEP_HAS_NEXT) !== 0
      fromPos = (fromRaw - MOVE_FROM_OFFSET - keys.keyXYf) & 0xff
      toPos = (toRaw - MOVE_TO_OFFSET - keys.keyXYt) & 0xff
    }

    const from = decodePosition(fromPos)
    const to = decodePosition(toPos)
    if (from === null || to === null) {
      // XQF 走子位置越界，主线终止（xqf_parser.dart:336-338）。
      break
    }
    const iccs = formatIccs(from, to)
    if (iccs === null) break
    moves.push(iccs)

    if (!hasNext) break
  }
  return moves
}

/** 解码位置字节 `x*10 + y` 为内部坐标（row 与 y 上下颠倒，xqf_parser.dart:349-355）。 */
function decodePosition(posByte: number): { col: number; row: number } | null {
  if (posByte > 89) return null
  const col = Math.floor(posByte / 10)
  const row = 9 - (posByte % 10)
  if (col < 0 || col > 8 || row < 0 || row > 9) return null
  return { col, row }
}

function readInt32(b: Uint8Array, offset: number): number {
  if (offset + 4 > b.length) return 0
  return b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16) | (b[offset + 3] << 24)
}

/**
 * 解析 XQF 字节流为 ParsedPuzzle（xqf_parser.dart:71-165）。
 * [source] 为来源标注（如语料分类路径），缺省 `xqf`。
 * 魔数错误 / 文件过短 / 无将帅时抛 FenFormatException（等价 Dart FormatException）。
 */
export function parseXqf(bytes: Uint8Array, source = 'xqf'): ParsedPuzzle {
  if (bytes.length < XQF_HEADER_SIZE + 8) {
    throw new FenFormatError(`XQF 文件过短: ${bytes.length} 字节`)
  }
  if (bytes[0] !== 0x58 || bytes[1] !== 0x51) {
    throw new FenFormatError(
      `XQF 魔数错误: 0x${bytes[0].toString(16)}0x${bytes[1].toString(16)}`
    )
  }
  const version = bytes[2]

  // 头部字段（与 cchess io_xqf.py 的 struct 布局一致）。
  const keys =
    version > LEGACY_VERSION_MAX
      ? deriveKeys({
          keyMask: bytes[3],
          keyOrA: bytes[8],
          keyOrB: bytes[9],
          keyOrC: bytes[10],
          keyOrD: bytes[11],
          keysSum: bytes[12],
          headKeyXY: bytes[13],
          headKeyXYf: bytes[14],
          headKeyXYt: bytes[15]
        })
      : null

  const boardBytes = bytes.subarray(16, 48)
  const title = readString(bytes, 80, 63)
  const event = readString(bytes, 208, 63)
  const date = readString(bytes, 272, 15)
  const redName = readString(bytes, 352, 15)
  const blackName = readString(bytes, 368, 15)

  // 棋子布局 → 棋盘矩阵 + 缺将帅校验。
  const board = decodeBoard(boardBytes, version, keys)
  let hasRedKing = false
  let hasBlackKing = false
  for (const row of board) {
    for (const p of row) {
      if (p !== null && p.kind === 'king') {
        if (p.side === 'red') hasRedKing = true
        else hasBlackKing = true
      }
    }
  }
  if (!hasRedKing || !hasBlackKing) {
    throw new FenFormatError('XQF 局面缺少将/帅')
  }

  // 走子主线。
  const moves = decodeMainLine(bytes, version, keys)

  // 走子方：有走法则看第一着起点棋子颜色，否则默认红先。
  let isRedTurn = true
  if (moves.length > 0) {
    const first = parseIccs(moves[0])
    if (first !== null) {
      const mover = board[first.from.row][first.from.col]
      if (mover !== null) isRedTurn = mover.side === 'red'
    }
  }
  const fen = buildFen({ board, isRedTurn })

  // 元数据组装。
  const titleText =
    title === null || title.trim().length === 0 ? defaultXqfTitle(redName, blackName) : title.trim()
  const players = `${redName ?? '?'} vs ${blackName ?? '?'}`
  const descParts: string[] = []
  if (event !== null && event.trim().length > 0) descParts.push(event.trim())
  if (date !== null && date.trim().length > 0) descParts.push(date.trim())
  descParts.push(players)

  return {
    id: `xqf/${source}/${titleText}`,
    initialFen: fen,
    solutionMoves: moves,
    title: titleText,
    description: descParts.join(' · '),
    source,
    format: 'xqf',
    difficulty: difficultyFromMoveCount(moves.length)
  }
}
