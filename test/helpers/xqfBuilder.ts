/**
 * 测试辅助：XQF 字节流构造器（xqfParser 的逆变换）。
 *
 * 用途：语料不可用时，以"构造 → 解析"往返验证各版本（旧格式/加密/位置置换）
 * 的编解码一致性；真实格式锚点由 test/fixtures/sample_xqf.xqf（v0x0D 实文件）承担。
 */
import * as iconv from 'iconv-lite'
import { parseBoardFen, pieceFenChar } from '@packages/rules'

/** 与 xqfParser 一致的常量。 */
const HEADER_SIZE = 0x400
const PIECE_CHARS = [
  'R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R', 'C', 'C',
  'P', 'P', 'P', 'P', 'P',
  'r', 'n', 'b', 'a', 'k', 'a', 'b', 'n', 'r', 'c', 'c',
  'p', 'p', 'p', 'p', 'p'
]
const KEY_SEED = '[(C) Copyright Mr. Dong Shiwei.]'

export interface XqfBuildOptions {
  version: number
  fen: string
  /** ICCS 走法序列。 */
  moves: string[]
  title?: string
  event?: string
  date?: string
  red?: string
  black?: string
  /** 加密头字节（默认非退化值，覆盖掩码/或值/链乘路径）。 */
  head?: { keyMask: number; keyOrA: number; keyOrB: number; keyOrC: number; keyOrD: number; keysSum: number; headKeyXY: number; headKeyXYf: number; headKeyXYt: number }
}

/** 单字节变换基数（与解析器同式）。 */
const formula = (x: number): number => ((((x * x) * 3 + 9) * 3 + 8) * 2 + 1) * 3 + 8

/** GB18030 长度前缀字符串写入（超长截断）。 */
function writeGbString(buf: Buffer, offset: number, maxLen: number, text: string | undefined): void {
  if (text === undefined || text.length === 0) return
  const raw = iconv.encode(text, 'gb18030')
  const len = Math.min(raw.length, maxLen)
  buf[offset] = len
  raw.copy(buf, offset + 1, 0, len)
}

/** 把 FEN 盘面映射到 32 子固定序的位置字节（x*10+y，0xFF=让子）。 */
function positionsFromFen(fen: string): number[] {
  const grid = parseBoardFen(fen)
  const used = Array.from({ length: 10 }, () => new Array<boolean>(9).fill(false))
  const positions: number[] = []
  for (const ch of PIECE_CHARS) {
    let found = 0xff
    for (let row = 0; row < 10 && found === 0xff; row++) {
      for (let col = 0; col < 9; col++) {
        if (used[row][col]) continue
        const piece = grid[row][col]
        if (piece !== null && pieceFenChar(piece) === ch) {
          found = col * 10 + (9 - row)
          used[row][col] = true
          break
        }
      }
    }
    positions.push(found)
  }
  return positions
}

/** 构造 XQF 文件字节流。 */
export function buildXqf(options: XqfBuildOptions): Uint8Array {
  const { version, fen, moves, title, event, date, red, black } = options
  const head = options.head ?? {
    keyMask: 0x3c, keyOrA: 0x2a, keyOrB: 0x51, keyOrC: 0x7e, keyOrD: 0x19,
    keysSum: 0x12, headKeyXY: 0x34, headKeyXYf: 0x56, headKeyXYt: 0x78
  }
  const encrypted = version > 0x0a

  let keyXY = 0
  let keyXYf = 0
  let keyXYt = 0
  let f32 = new Array<number>(32).fill(0)
  if (encrypted) {
    keyXY = (formula(head.headKeyXY) * head.headKeyXY) & 0xff
    keyXYf = (formula(head.headKeyXYf) * keyXY) & 0xff
    keyXYt = (formula(head.headKeyXYt) * keyXYf) & 0xff
    const keyBytes = [
      (head.keysSum & head.keyMask) | head.keyOrA,
      (head.headKeyXY & head.keyMask) | head.keyOrB,
      (head.headKeyXYf & head.keyMask) | head.keyOrC,
      (head.headKeyXYt & head.keyMask) | head.keyOrD
    ]
    f32 = []
    for (let i = 0; i < 32; i++) f32.push(KEY_SEED.charCodeAt(i) & keyBytes[i % 4])
  }

  // 32 子布局（仅版本 >= 12 做位置置换；加密时加 keyXY）。
  const positions = positionsFromFen(fen)
  const boardBytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    if (!encrypted) {
      boardBytes[i] = positions[i]
    } else if (version >= 12) {
      // 解析侧：pos[(keyXY+i+1)&0x1F] = boardBytes[i]，逆写为取该槽位的解密值。
      const slot = (keyXY + i + 1) & 0x1f
      boardBytes[i] = (positions[slot] + keyXY) & 0xff
    } else {
      boardBytes[i] = (positions[i] + keyXY) & 0xff
    }
  }

  // 走子树明文缓冲。
  const plain: number[] = []
  // 根记录：flag 无注解位。
  plain.push(0, 0, 0, 0)
  if (!encrypted) plain.push(0, 0, 0, 0) // 旧格式根记录也带注解长度
  moves.forEach((iccs, idx) => {
    const from = parseSquare(iccs)
    const to = parseSquare(iccs.slice(2))
    const hasNext = idx < moves.length - 1
    let fromRaw: number
    let toRaw: number
    let flag = 0
    if (!encrypted) {
      fromRaw = (from + 0x18) & 0xff
      toRaw = (to + 0x20) & 0xff
      if (hasNext) flag |= 0x80 // 高 4 位有值 = 有后续
    } else {
      fromRaw = (from + 0x18 + keyXYf) & 0xff
      toRaw = (to + 0x20 + keyXYt) & 0xff
      if (hasNext) flag |= 0x80
    }
    plain.push(fromRaw, toRaw, flag, 0)
    if (!encrypted) plain.push(0, 0, 0, 0) // 旧格式注解长度恒存在
  })

  // 组装文件。
  const dataLen = encrypted ? plain.length : plain.length
  const buf = Buffer.alloc(HEADER_SIZE + dataLen + 8)
  buf[0] = 0x58
  buf[1] = 0x51
  buf[2] = version
  buf[3] = encrypted ? head.keyMask : 0
  buf[8] = encrypted ? head.keyOrA : 0
  buf[9] = encrypted ? head.keyOrB : 0
  buf[10] = encrypted ? head.keyOrC : 0
  buf[11] = encrypted ? head.keyOrD : 0
  buf[12] = encrypted ? head.keysSum : 0
  buf[13] = encrypted ? head.headKeyXY : 0
  buf[14] = encrypted ? head.headKeyXYf : 0
  buf[15] = encrypted ? head.headKeyXYt : 0
  Buffer.from(boardBytes).copy(buf, 16)
  writeGbString(buf, 80, 63, title)
  writeGbString(buf, 208, 63, event)
  writeGbString(buf, 272, 15, date)
  writeGbString(buf, 352, 15, red)
  writeGbString(buf, 368, 15, black)

  if (!encrypted) {
    Buffer.from(plain).copy(buf, HEADER_SIZE)
  } else {
    // 明文块逐字节加 f32（解析侧减回）。
    for (let i = 0; i < plain.length; i++) {
      buf[HEADER_SIZE + i] = (plain[i] + f32[(HEADER_SIZE + i) % 32]) & 0xff
    }
  }
  return new Uint8Array(buf)
}

function parseSquare(s: string): number {
  // XQF 位置字节 = x*10 + y，y=0 为红方底线（= ICCS rank）。
  const col = s.charCodeAt(0) - 'a'.charCodeAt(0)
  const rank = Number.parseInt(s[1], 10)
  return col * 10 + rank
}
