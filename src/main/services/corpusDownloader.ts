/**
 * 棋谱语料包下载器（主进程，对应 corpus_downloader.dart，06 文档 §5 安全清单）。
 *
 * 安全约束：
 * - 下载前用 isDownloadUrlAllowed 校验 URL（仅 https 公网地址，SSRF 防护）；
 * - 重定向手动跟随（≤5 跳），每一跳都重新校验；
 * - zip 解压防路径穿越：符号链接/绝对路径/../盘符/Windows 保留名条目跳过
 *   （zip-slip 防护）；
 * - zip 魔数 PK\x03\x04 与大小区间（1MB~512MB）校验。
 *
 * 健壮性约束：
 * - 连接 15s 超时 + 响应流 30s 块间停滞超时（AbortController，主进程侧计时）；
 * - 临时 zip 写系统临时目录；解压先落 `corpus.tmp-<ts>` 临时目录，
 *   全部成功后原子替换目标目录，失败整体清理，不残留半成品；
 * - 无断点续传（失败/取消整体重来），与原版语义一致。
 */
import { createHash } from 'crypto'
import { createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, closeSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { readZipEntries, ZipFormatError } from './corpusZip'

/** TCP 连接与响应头等待超时（corpus_downloader.dart:48）。 */
export const CONNECT_TIMEOUT_MS = 15_000
/** 响应流块间超时：超过该时长无新数据即判定下载停滞（corpus_downloader.dart:51）。 */
export const CHUNK_TIMEOUT_MS = 30_000
/** 下载临时 zip 的确定性路径（URL SHA-1 命名，Range 续传依赖同名可寻）。 */
export function corpusTempZipPath(url: string): string {
  return join(tmpdir(), `corpus-download-${createHash('sha1').update(url).digest('hex')}.zip`)
}

/** 语料 zip 合法大小下限/上限（当前包约 45.8MB，留足余量防炸弹/空文件）。 */
export const MIN_ZIP_BYTES = 1 << 20
export const MAX_ZIP_BYTES = 512 << 20
/** 最大重定向跳数（含 0 号初始请求共 6 次机会）。 */
const MAX_REDIRECTS = 5

/** Windows 保留设备名（不区分大小写，含 `CON.txt` 扩展名形式）。 */
const RESERVED_SEGMENT = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i

/** 用户取消下载时抛出（corpus_downloader.dart:26-31）。 */
export class CorpusDownloadCancelled extends Error {
  constructor() {
    super('下载已取消')
    this.name = 'CorpusDownloadCancelled'
  }
}

/** 下载解压结果：解压成功的文件数与跳过的条目数。 */
export interface CorpusDownloadResult {
  extracted: number
  skipped: number
}

// ---------------------------------------------------------------------------
// SSRF 校验（corpus_paths.dart:41-148 逐条等价）
// ---------------------------------------------------------------------------

/** 校验下载 URL 是否允许（仅 https；拒绝 localhost/环回/私有/保留地址/mDNS）。 */
export function isDownloadUrlAllowed(url: string): boolean {
  let uri: URL
  try {
    uri = new URL(url)
  } catch {
    return false
  }
  if (uri.protocol.toLowerCase() !== 'https:') return false
  const host = uri.hostname.toLowerCase()
  if (host.length === 0) return false
  return !isBlockedHost(host)
}

function isBlockedHost(host: string): boolean {
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true
  }
  // IPv4 字面量：拒绝环回/私有/链路本地/保留段。
  const ipv4Match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (ipv4Match !== null) {
    const groups = [ipv4Match[1], ipv4Match[2], ipv4Match[3], ipv4Match[4]]
    // 八进制分段（多段前导 0，如 0177.0.0.1）语义有歧义，一律拒绝。
    if (groups.some((g) => g.length > 1 && g.startsWith('0'))) return true
    const octets = groups.map((g) => Number.parseInt(g, 10))
    if (octets.some((o) => o < 0 || o > 255)) return true
    return isBlockedV4(octets)
  }
  // 纯十进制 / 0x 十六进制整数形式的 IPv4（如 2130706433 / 0x7f000001）。
  const asInt = parseIntegerHost(host)
  if (asInt !== null) {
    if (asInt > 0xffffffff) return true
    return isBlockedV4([(asInt >>> 24) & 0xff, (asInt >>> 16) & 0xff, (asInt >>> 8) & 0xff, asInt & 0xff])
  }
  // IPv6 字面量：拒绝环回、链路本地（fe80::/10）、唯一本地（fc00::/7）。
  if (host.includes(':')) {
    const h = host.replace(/^\[/, '').replace(/\]$/, '')
    if (h === '::' || h === '::1') return true
    // IPv4-mapped IPv6（::ffff:0:0/96）：还原成 v4 判段。
    if (h.toLowerCase().startsWith('::ffff:')) {
      const mapped = parseMappedV4(h.slice('::ffff:'.length))
      if (mapped === null) return true // 形式存疑的 mapped 段一律拒绝
      return isBlockedV4(mapped)
    }
    if (['fe8', 'fe9', 'fea', 'feb'].some((p) => h.startsWith(p))) return true
    if (h.startsWith('fc') || h.startsWith('fd')) return true
  }
  return false
}

/** IPv4 段判定（环回/私有/链路本地/组播与保留段，corpus_paths.dart:107-115）。 */
function isBlockedV4(octets: number[]): boolean {
  const a = octets[0]
  const b = octets[1]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a >= 224) return true
  return false
}

/** 解析十进制/十六进制整数形式的 host；非整数形式返回 null（corpus_paths.dart:118-129）。 */
function parseIntegerHost(host: string): number | null {
  if (/^\d+$/.test(host)) {
    const n = Number.parseInt(host, 10)
    return Number.isFinite(n) ? n : null
  }
  const lower = host.toLowerCase()
  if (lower.length > 2 && lower.startsWith('0x') && /^0x[0-9a-f]+$/.test(lower)) {
    return Number.parseInt(lower.slice(2), 16)
  }
  return null
}

/** 解析 `::ffff:` 后的 IPv4 部分（点分十进制或两组十六进制，corpus_paths.dart:132-148）。 */
function parseMappedV4(rest: string): number[] | null {
  const dotted = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(rest)
  if (dotted !== null) {
    const octets = [dotted[1], dotted[2], dotted[3], dotted[4]].map((g) => Number.parseInt(g, 10))
    if (octets.some((o) => o > 255)) return null
    return octets
  }
  const hex = /^([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4})$/.exec(rest)
  if (hex !== null) {
    const hi = Number.parseInt(hex[1], 16)
    const lo = Number.parseInt(hex[2], 16)
    return [(hi >>> 8) & 0xff, hi & 0xff, (lo >>> 8) & 0xff, lo & 0xff]
  }
  return null
}

// ---------------------------------------------------------------------------
// 下载 + 校验 + 解压
// ---------------------------------------------------------------------------

export interface DownloadCorpusOptions {
  url: string
  targetDir: string
  onProgress?: (received: number, total: number) => void
  isCancelled?: () => boolean
}

/**
 * 下载 [url] 指向的语料 zip 并解压到 [targetDir]（corpus_downloader.dart:68-108）。
 * 任一步失败/取消整体清理并抛出；成功返回解压统计。
 */
export async function downloadCorpus(options: DownloadCorpusOptions): Promise<CorpusDownloadResult> {
  if (!isDownloadUrlAllowed(options.url)) {
    throw new Error('下载地址不合法（仅允许 https 公网地址）')
  }
  throwIfCancelled(options.isCancelled)
  const zipFile = await downloadZip(options.url, options.onProgress, options.isCancelled)
  try {
    verifyZipIntegrity(zipFile)
    throwIfCancelled(options.isCancelled)

    // Windows legacy 目录联接：不删除/替换联接本身（保留开发期行为），退化为直接解压。
    const isLink = isSymlink(options.targetDir)
    const result = isLink
      ? extractZip(zipFile, options.targetDir)
      : await extractZipAtomic(zipFile, options.targetDir, options.isCancelled)
    return result
  } finally {
    try {
      if (existsSync(zipFile)) rmSync(zipFile)
    } catch {
      // 临时 zip 清理失败不掩盖主流程结果
    }
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function throwIfCancelled(isCancelled?: () => boolean): void {
  if (isCancelled !== undefined && isCancelled()) throw new CorpusDownloadCancelled()
}

/**
 * 下载 zip 到系统临时目录；手动跟随重定向并逐跳校验（corpus_downloader.dart:144-211）。
 * 块间停滞超时经 AbortController 实现（主进程侧计时，00 文档 TIMER 职责铁律）。
 *
 * Range 续传（06 §5 Electron 增强项）：临时文件名对 URL 确定性命名（SHA-1），
 * 中断残留的半成品与 ETag sidecar 配对；重试时带 `If-Range: <etag>` + `Range`，
 * 服务器资源未变则 206 续写，否则按 200 整体重下（失败安全保留原语义）。
 */
export async function downloadZip(
  url: string,
  onProgress?: (received: number, total: number) => void,
  isCancelled?: () => boolean,
  /** 供测试注入（本地 http 服务器）；生产恒为 isDownloadUrlAllowed */
  urlValidator: (candidate: string) => boolean = isDownloadUrlAllowed
): Promise<string> {
  // 续传状态：半成品 + ETag sidecar（仅服务器返回强 ETag 时启用）。
  const tempFile = corpusTempZipPath(url)
  const etagFile = `${tempFile}.etag`
  let resumeOffset = 0
  let resumeEtag: string | null = null
  if (existsSync(etagFile) && existsSync(tempFile)) {
    resumeEtag = readFileSync(etagFile, 'utf8')
    resumeOffset = statSync(tempFile).size
  } else {
    try {
      if (existsSync(tempFile)) rmSync(tempFile)
    } catch {
      // 残留清理失败：200 路径会整体覆盖
    }
  }

  let current = url
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    throwIfCancelled(isCancelled)
    if (!urlValidator(current)) {
      throw new Error('重定向地址不合法（仅允许 https 公网地址）')
    }
    const controller = new AbortController()
    let stalled = false
    // 连接超时：15s 内未收到响应头即中止。
    const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
    const headers: Record<string, string> = {}
    if (resumeEtag !== null && resumeOffset > 0) {
      headers['If-Range'] = resumeEtag
      headers.Range = `bytes=${resumeOffset}-`
    }
    let response: globalThis.Response
    try {
      response = await fetch(current, { redirect: 'manual', signal: controller.signal, headers })
    } catch {
      clearTimeout(connectTimer)
      throw new Error('连接超时（15 秒无响应）')
    }
    clearTimeout(connectTimer)

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (location === null) throw new Error('重定向缺少 Location 头')
      current = new URL(location, current).toString()
      void response.body?.cancel()
      continue
    }
    // 206 = 续传命中；200 = 服务器忽略 Range 或资源已变（If-Range 未通过）→ 整体重下。
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`下载失败：HTTP ${response.status}`)
    }
    const resuming = response.status === 206 && resumeOffset > 0
    if (!resuming) {
      resumeOffset = 0
      try {
        if (existsSync(tempFile)) rmSync(tempFile)
      } catch {
        // 旧半成品无法清理：写入模式会覆盖
      }
    }
    // 服务器返回新 ETag 且本次为整段下载：登记 sidecar 供中断后续传。
    const etag = response.headers.get('etag')
    if (etag !== null && !resuming) {
      try {
        writeFileSync(etagFile, etag)
        resumeEtag = etag
      } catch {
        // sidecar 写失败：仅失去续传能力
      }
    }

    const totalHeader = response.headers.get('content-length')
    const contentLength = totalHeader === null ? -1 : Number.parseInt(totalHeader, 10)
    const total = resuming && contentLength >= 0 ? resumeOffset + contentLength : contentLength
    const sink = createWriteStream(tempFile, { flags: resuming ? 'a' : 'w' })
    let received = 0
    try {
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error('下载流不可读')
      // 块间超时：每收到一块重置；停滞即中止（stalled 标记区分错误文案）。
      let chunkTimer: NodeJS.Timeout | null = null
      const armChunkTimer = (): void => {
        if (chunkTimer !== null) clearTimeout(chunkTimer)
        chunkTimer = setTimeout(() => {
          stalled = true
          controller.abort()
        }, CHUNK_TIMEOUT_MS)
      }
      armChunkTimer()
      for (;;) {
        throwIfCancelled(isCancelled)
        const { done, value } = await reader.read()
        if (done) break
        armChunkTimer()
        if (value !== undefined) {
          received += value.byteLength
          sink.write(Buffer.from(value))
          onProgress?.(resumeOffset + received, total)
        }
      }
      if (chunkTimer !== null) clearTimeout(chunkTimer)
      await new Promise<void>((resolve, reject) => {
        sink.on('error', reject)
        sink.end(resolve)
      })
      // 下载完成：不再续传（本次将完整消费该 zip），清 sidecar。
      try {
        if (existsSync(etagFile)) rmSync(etagFile)
      } catch {
        // 清理失败无碍结果
      }
    } catch (e) {
      sink.close()
      // 中断：保留半成品 + sidecar（若服务器未给 ETag 则无从续传，清残留）。
      if (resumeEtag === null) {
        try {
          if (existsSync(tempFile)) rmSync(tempFile)
        } catch {
          // 清理失败不掩盖主流程
        }
      }
      if (stalled) throw new Error('下载停滞（30 秒无新数据）', { cause: e })
      throw e instanceof Error ? e : new Error(String(e), { cause: e })
    }
    return tempFile
  }
  throw new Error('重定向次数过多')
}

/** 校验下载产物完整性：zip 魔数 + 大小区间（corpus_downloader.dart:215-236）。 */
export function verifyZipIntegrity(zipPath: string): void {
  const size = statSync(zipPath).size
  if (size < MIN_ZIP_BYTES || size > MAX_ZIP_BYTES) {
    throw new Error(
      `语料包大小异常（${size} 字节，允许 ${MIN_ZIP_BYTES}-${MAX_ZIP_BYTES}），可能不是有效的语料包`
    )
  }
  const head = readHeadBytes(zipPath, 4)
  const isZip =
    head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
  if (!isZip) {
    throw new Error('语料包格式异常（缺少 zip 魔数 PK\\x03\\x04）')
  }
}

function readHeadBytes(path: string, length: number): Uint8Array {
  // 读取文件前 length 字节（corpus_downloader.dart 用 RAF；此处等效轻实现）。
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, 0)
    return new Uint8Array(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
}

/**
 * 把 [zipPath] 解压并原子替换 [targetDir]（corpus_downloader.dart:116-141）。
 * 先解压到目标目录旁的 `corpus.tmp-<ts>` 临时目录（同 parent，rename 不跨设备），
 * 全部成功后删除旧目标目录并 rename 替换；任何失败整体删除临时目录。
 */
export async function extractZipAtomic(
  zipPath: string,
  targetDir: string,
  isCancelled?: () => boolean
): Promise<CorpusDownloadResult> {
  const stagingDir = join(targetDir, '..', `corpus.tmp-${Date.now()}`)
  mkdirSync(stagingDir, { recursive: true })
  try {
    const counts = extractZip(zipPath, stagingDir)
    throwIfCancelled(isCancelled)
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true })
    renameSync(stagingDir, targetDir)
    return counts
  } catch (e) {
    try {
      if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true })
    } catch {
      // 临时解压目录清理失败不掩盖原始异常
    }
    throw e
  }
}

/**
 * 解压本地 zip 文件到 [targetDir]（含 zip-slip 防护，corpus_downloader.dart:253-311）。
 * Windows 保留名/尾随点空格条目与写入异常条目跳过并计数，不中断整体解压。
 */
export function extractZip(zipPath: string, targetDir: string): CorpusDownloadResult {
  const buf = readFileSync(zipPath)
  const entries = readZipEntries(buf)
  let count = 0
  let skipped = 0
  const skip = (): void => {
    skipped += 1
  }

  for (const entry of entries) {
    const name = entry.name.replaceAll('\\', '/')
    // 符号链接条目一律拒绝；绝对路径与 .. 段一律拒绝。
    if (entry.isSymlink || name.startsWith('/') || name.split('/').includes('..')) {
      skip()
      continue
    }
    const segments = name.split('/').filter((s) => s.length > 0)
    if (segments.length === 0 || segments.some((s) => s.includes(':') || s === '.')) {
      skip()
      continue
    }
    // Windows 保留设备名与尾随 `.`/空格：写入必失败，直接跳过。
    if (segments.some((s) => s.endsWith('.') || s.endsWith(' ') || RESERVED_SEGMENT.test(s))) {
      skip()
      continue
    }
    // 词法重组（已拒绝 .. / 盘符，不可能逃出目标目录）。
    const outPath = `${targetDir}${sep}${segments.join(sep)}`
    try {
      if (entry.isDirectory) {
        mkdirSync(outPath, { recursive: true })
      } else {
        mkdirSync(join(outPath, '..'), { recursive: true })
        writeFileSync(outPath, entry.content())
        count += 1
      }
    } catch {
      // 同名冲突（先文件后目录）、权限、磁盘满等单条目异常：跳过并计数，不中断整体。
      skip()
    }
  }
  return { extracted: count, skipped }
}

export { ZipFormatError }
