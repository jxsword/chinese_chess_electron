/**
 * 语料目录扫描与文件访问（主进程，对应 corpus_scanner.dart + corpus_paths.dart，06 文档 §1）。
 *
 * 结构：
 * - `XQF-象棋谱大全/<分类>/.../*.xqf` —— 按一级子目录分类，逐文件懒解析；
 * - `ChessQ-gamebooks/gamebooks` 下任意层级的 *.xqf —— 残局杀势；
 * - `CGLemon-PGN/{wxf,dpxq}/ICCS/*.pgns` —— 多局合一 PGN 大文件，
 *   用 packages/parsers 的 scanGameOffsets 建立按局索引后分页浏览。
 *
 * Electron 分工（对齐 00 文档铁律 #7）：fs 只在主进程；文件字节经 IPC 交给
 * 渲染层 parser.worker 做批量解析；大 PGN 的流式索引在主进程完成（读即扫，
 * 内存占用有 1MB 块 + 8MB 单行上限约束，不整读百 MB 文件）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, sep } from 'path'
import type {
  CorpusCategory,
  CorpusEntry,
  CorpusFileBytes,
  CorpusScanResult,
  PgnIndexEntry
} from '@shared/ipc/types'
import { scanGameOffsets, decodeUtf8Lossy, type PgnFileSource } from '@packages/parsers'

/** 目录解析优先级（corpus_paths.dart:150-172）：用户设置 > legacy 相对目录 > 平台默认。 */
export interface CorpusDirOptions {
  /** 用户设置目录（electron-store `corpus.userPath`，空串视为未设置） */
  userSetting: string | null
  /** 平台默认目录基路径（主进程传 documents；测试传临时目录） */
  documentsPath: string
  /** legacy 相对目录基路径（主进程传 cwd；测试注入，缺省不检查） */
  legacyBasePath?: string
}

/** 按优先级解析语料目录（可能尚不存在，由引导下载/手动放置创建）。 */
export function resolveCorpusDir(options: CorpusDirOptions): string {
  const user = options.userSetting?.trim()
  if (user !== undefined && user !== null && user.length > 0) return user
  if (options.legacyBasePath !== undefined) {
    const legacy = join(options.legacyBasePath, 'corpus')
    if (existsSync(legacy)) return legacy
  }
  return join(options.documentsPath, 'ChineseChessUltra', 'corpus')
}

function baseName(p: string): string {
  const parts = p.split(sep).filter((s) => s.length > 0)
  return parts[parts.length - 1] ?? p
}

function extensionOf(p: string): string {
  const lower = p.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot >= 0 ? lower.slice(dot + 1) : ''
}

/** 文件名去扩展名（CorpusEntry.displayName，corpus_scanner.dart:68-72）。 */
export function displayNameOf(p: string): string {
  const base = baseName(p)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** 递归收集目录下的全部文件（followLinks 语义对齐 corpus_scanner.dart）。 */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return // 权限等读取失败：该子树跳过
    }
    for (const name of entries) {
      const full = join(current, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) walk(full)
      else if (stat.isFile()) out.push(full)
    }
  }
  walk(dir)
  return out
}

/**
 * 扫描语料分类（corpus_scanner.dart:91-126）：XQF 按一级子目录聚合；
 * PGN 大文件每个文件一个分类；忽略 `_` 开头目录。
 */
export function scanCorpus(root: string): CorpusScanResult {
  const result: CorpusScanResult = { root, exists: false, categories: [] }
  if (!existsSync(root) || !statSync(root).isDirectory()) return result
  result.exists = true
  const categories: CorpusCategory[] = []
  for (const name of readdirSync(root)) {
    const dirPath = join(root, name)
    let stat
    try {
      stat = statSync(dirPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    if (name.startsWith('_')) continue // 忽略 _ref 等辅助目录
    if (name === 'CGLemon-PGN') {
      // PGN 大文件：递归找 .pgn / .pgns。
      for (const f of listFilesRecursive(dirPath)) {
        const ext = extensionOf(f)
        if (ext !== 'pgn' && ext !== 'pgns') continue
        const rel = f.slice(root.length)
        const parts = rel.split(sep).filter((s) => s.length > 0)
        parts.shift()
        const source = parts.slice(0, 2).join('/')
        categories.push({
          name: `PGN · ${parts[parts.length - 1]}（多局合一）`,
          kind: 'pgnFile',
          path: f,
          source
        })
      }
    } else {
      categories.push({ name, kind: 'xqfDirectory', path: dirPath, source: name })
    }
  }
  categories.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  result.categories = categories
  return result
}

/**
 * 从文件相对路径推导来源标注（前两级子目录，corpus_scanner.dart:151-161）：
 * 去文件名、去 ChessQ 的通用目录层 gamebooks。
 */
function sourceOf(categoryPath: string, filePath: string): string {
  const rel = filePath.slice(categoryPath.length)
  const parts = rel.split(sep).filter((p) => p.length > 0)
  parts.pop() // 文件名
  const filtered = parts.filter((p) => p !== 'gamebooks')
  return filtered.slice(0, 2).join('/')
}

/**
 * 列出 XQF 分类下的全部棋谱文件（不做解析，corpus_scanner.dart:132-149）。
 * 来源标注取相对分类目录的前两级子目录（如"残局/适情雅趣"）。
 */
export function listXqfEntries(categoryPath: string, categoryName: string): CorpusEntry[] {
  if (!existsSync(categoryPath)) return []
  const entries: CorpusEntry[] = []
  for (const f of listFilesRecursive(categoryPath)) {
    if (extensionOf(f) !== 'xqf') continue
    entries.push({
      path: f,
      category: categoryName,
      source: sourceOf(categoryPath, f),
      displayName: displayNameOf(f)
    })
  }
  entries.sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0))
  return entries
}

/** 渲染层可请求读取的棋谱扩展名（路径安全约束：防任意文件读取）。 */
const READABLE_EXTS = new Set(['xqf', 'pgn', 'pgns'])

/** 批量读取棋谱文件字节（供 parser.worker 解析；越界/非法扩展名条目跳过）。 */
export function readCorpusFiles(paths: string[]): CorpusFileBytes[] {
  const out: CorpusFileBytes[] = []
  for (const p of paths) {
    if (!READABLE_EXTS.has(extensionOf(p))) continue
    try {
      out.push({ path: p, bytes: new Uint8Array(readFileSync(p)) })
    } catch {
      // 单文件读取失败：跳过（批量解析以 null 结果呈现）
    }
  }
  return out
}

/**
 * 扫描大 PGN 文件的按局索引（corpus_scanner.dart:203-208 的主进程等价：
 * Isolate.run → 主进程流式扫描；文件读取与字节扫描同进程，避免跨进程搬运）。
 */
export function scanPgnIndex(path: string, maxGames = -1): PgnIndexEntry[] {
  const fd = readFd(path)
  try {
    const size = fstatSize(fd)
    const source: PgnFileSource = {
      byteLength: size,
      read: (offset, length) => readAt(fd, offset, length)
    }
    return scanGameOffsets(source, maxGames)
  } finally {
    closeFd(fd)
  }
}

/** 读取索引指向的单局文本并解析返回（corpus_scanner.dart:210-230 主进程侧读取部分）。 */
export function readPgnGameText(path: string, entry: PgnIndexEntry): string {
  if (entry.offset < 0 || entry.length < 0) throw new Error('PGN 索引越界')
  const fd = readFd(path)
  try {
    const size = fstatSize(fd)
    const length = Math.min(entry.length, Math.max(size - entry.offset, 0))
    if (entry.offset >= size) throw new Error('PGN 索引越界')
    const bytes = readAt(fd, entry.offset, length)
    return decodeUtf8Lossy(bytes)
  } finally {
    closeFd(fd)
  }
}

// ---- fs 原语（收敛在此便于测试注入替换） ----
import { closeSync, fstatSync, openSync, readSync } from 'fs'

function readFd(path: string): number {
  return openSync(path, 'r')
}

function fstatSize(fd: number): number {
  return fstatSync(fd).size
}

function readAt(fd: number, offset: number, length: number): Uint8Array {
  if (offset < 0 || length < 0) return new Uint8Array(0)
  const buf = Buffer.alloc(length)
  const bytesRead = readSync(fd, buf, 0, length, offset)
  return new Uint8Array(buf.subarray(0, Math.max(bytesRead, 0)))
}

function closeFd(fd: number): void {
  closeSync(fd)
}
