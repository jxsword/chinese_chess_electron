/**
 * 最小 ZIP 读取器（主进程专用，06 文档 §5 解压安全设计的载体）。
 *
 * 为什么手写：zip 解压只用到「标准无加密条目 + store/deflate」，Node 内置
 * zlib 即可完成，不必为此引入新依赖（AGENTS 依赖纪律）；同时把 zip-slip
 * 防护收敛在调用方 corpusDownloader 的同一遍历里。
 *
 * 能力：EOCD/中央目录解析（借助中央目录的准确尺寸，规避 local header 的
 * data-descriptor 歧义）、store(0)/deflate(8)、符号链接条目识别（Unix mode）。
 * 不支持：zip64、加密条目、分卷——遇到即抛错（语料包场景不可能出现）。
 */
import { deflateRawSync, inflateRawSync } from 'zlib'

const EOCDD_SIGNATURE = 0x06054b50
const CDE_SIGNATURE = 0x02014b50
const LFH_SIGNATURE = 0x04034b50

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** 单个 zip 条目（名称 / 是否目录 / 是否符号链接 / 内容惰性解压）。 */
export interface ZipEntryLite {
  name: string
  isDirectory: boolean
  isSymlink: boolean
  /** 解码为 UTF-8（与 Dart archive 对非 UTF-8 名称的行为差异可忽略：语料包全为 UTF-8 名称） */
  content(): Uint8Array
}

/** 解析失败（非 zip / 截断 / 不支持特性）。 */
export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipFormatError'
  }
}

function findEocd(buf: Buffer): number {
  // EOCD 最短 22 字节，注释最长 65535：从文件末尾向前扫描签名。
  const minStart = Math.max(0, buf.length - (22 + 0xffff))
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCDD_SIGNATURE) return i
  }
  throw new ZipFormatError('ZIP 结束记录（EOCD）缺失，不是有效的 zip 文件')
}

/**
 * 解析 zip 全部条目（中央目录顺序）。
 * 名称按 UTF-8 解码；调用方负责 zip-slip 校验。
 */
export function readZipEntries(buf: Buffer): ZipEntryLite[] {
  const eocd = findEocd(buf)
  const entryCount = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntryLite[] = []

  for (let i = 0; i < entryCount; i++) {
    if (cdOffset + 46 > buf.length || buf.readUInt32LE(cdOffset) !== CDE_SIGNATURE) {
      throw new ZipFormatError('ZIP 中央目录损坏')
    }
    const flags = buf.readUInt16LE(cdOffset + 8)
    const method = buf.readUInt16LE(cdOffset + 10)
    const compressedSize = buf.readUInt32LE(cdOffset + 20)
    const nameLen = buf.readUInt16LE(cdOffset + 28)
    const extraLen = buf.readUInt16LE(cdOffset + 30)
    const commentLen = buf.readUInt16LE(cdOffset + 32)
    const externalAttrs = buf.readUInt32LE(cdOffset + 38)
    const localOffset = buf.readUInt32LE(cdOffset + 42)
    const name = buf.subarray(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8')
    const unixMode = externalAttrs >>> 16
    const isSymlink = (unixMode & 0xf000) === 0xa000
    const isDirectory = name.endsWith('/') || (unixMode & 0xf000) === 0x4000
    if ((flags & 0x1) !== 0) throw new ZipFormatError('ZIP 条目已加密，不支持')
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipFormatError(`ZIP 压缩方法不支持: ${method}`)
    }

    // 从 local header 定位数据起点（local 头的名称/extra 长度可能不同，须以本条为准）。
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LFH_SIGNATURE) {
      throw new ZipFormatError('ZIP local header 损坏')
    }
    const lfhNameLen = buf.readUInt16LE(localOffset + 26)
    const lfhExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen
    if (dataStart + compressedSize > buf.length) {
      throw new ZipFormatError('ZIP 条目数据越界')
    }
    const raw = buf.subarray(dataStart, dataStart + compressedSize)

    entries.push({
      name,
      isDirectory,
      isSymlink,
      content(): Uint8Array {
        if (method === METHOD_STORE) return new Uint8Array(raw)
        const inflated = inflateRawSync(raw)
        return new Uint8Array(inflated)
      }
    })

    cdOffset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// ---------------------------------------------------------------------------
// 测试辅助：最小 zip 构造器（store/deflate + 可选 Unix mode），供下载器用例搭建恶意包。
// ---------------------------------------------------------------------------

function lfhFor(name: string, method: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8')
  const head = Buffer.alloc(30)
  head.writeUInt32LE(LFH_SIGNATURE, 0)
  head.writeUInt16LE(method, 8)
  head.writeUInt16LE(nameBuf.length, 26)
  head.writeUInt16LE(0, 28)
  return Buffer.concat([head, nameBuf])
}

function cdeFor(
  name: string,
  method: number,
  crc: number,
  compressedSize: number,
  uncompressedSize: number,
  localOffset: number,
  unixMode: number
): Buffer {
  const nameBuf = Buffer.from(name, 'utf8')
  const head = Buffer.alloc(46)
  head.writeUInt32LE(CDE_SIGNATURE, 0)
  head.writeUInt16LE(method, 10)
  head.writeUInt32LE(crc, 16)
  head.writeUInt32LE(compressedSize, 20)
  head.writeUInt32LE(uncompressedSize, 24)
  head.writeUInt16LE(nameBuf.length, 28)
  head.writeUInt32LE(((unixMode & 0xffff) << 16) >>> 0, 38)
  head.writeUInt32LE(localOffset, 42)
  return Buffer.concat([head, nameBuf])
}

function crc32Of(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let b = 0; b < 8; b++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 测试用 zip 条目描述。 */
export interface TestZipEntry {
  name: string
  content: Uint8Array
  /** 0=store（默认）/ 8=deflate */
  method?: number
  /** Unix mode（如 0xa1ff 构造符号链接条目） */
  unixMode?: number
}

/** 构造一个最小合法 zip（供测试；非压缩上限场景）。 */
export function buildTestZip(entries: TestZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const cd: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const method = entry.method ?? METHOD_STORE
    const raw = Buffer.from(entry.content)
    const payload = method === METHOD_DEFLATE ? deflateRawSync(raw) : raw
    const crc = crc32Of(raw)
    const lfh = lfhFor(entry.name, method)
    locals.push(lfh, payload)
    cd.push(
      cdeFor(
        entry.name,
        method,
        crc,
        payload.length,
        raw.length,
        offset,
        entry.unixMode ?? 0x81a4
      )
    )
    offset += lfh.length + payload.length
  }
  const cdBuf = Buffer.concat(cd)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCDD_SIGNATURE, 0)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, eocd])
}

