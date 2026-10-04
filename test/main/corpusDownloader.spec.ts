/** 下载器等价用例集（test/features/puzzle/model/corpus_downloader_test.dart 11 条，06 文档 §5） */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractZip,
  extractZipAtomic,
  isDownloadUrlAllowed,
  verifyZipIntegrity
} from '@main/services/corpusDownloader'
import { buildTestZip } from '@main/services/corpusZip'
import { CORPUS_DOWNLOAD_URL } from '@shared/constants'

const dirs: string[] = []
const makeTemp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'corpus_dl_test_'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)

describe('CorpusPaths 下载 URL 安全校验', () => {
  it('允许 https 公网地址', () => {
    expect(isDownloadUrlAllowed(CORPUS_DOWNLOAD_URL)).toBe(true)
    expect(isDownloadUrlAllowed('https://github.com/jxsword/qp-corpus/releases/download/v1/x.zip')).toBe(true)
  })

  it('拒绝非 https 与非法 URL', () => {
    expect(isDownloadUrlAllowed('http://github.com/jxsword/qp-corpus/releases/download/v1/x.zip')).toBe(false)
    expect(isDownloadUrlAllowed('ftp://example.com/x.zip')).toBe(false)
    expect(isDownloadUrlAllowed('not a url')).toBe(false)
    expect(isDownloadUrlAllowed('')).toBe(false)
  })

  it('拒绝 localhost / 环回 / 私有 / 保留地址 / mDNS', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.1.1',
      '0.0.0.0',
      '224.0.0.1',
      '[::1]',
      '[fe80::1]',
      '[fd00::1]',
      'nas.local'
    ]) {
      expect(isDownloadUrlAllowed(`https://${host}/x.zip`)).toBe(false)
    }
  })

  it('拒绝 IPv4-mapped IPv6 / 整数 IP / 八进制分段等绕过形式（P2-1）', () => {
    // IPv4-mapped IPv6（::ffff:0:0/96）还原成 v4 判段。
    expect(isDownloadUrlAllowed('https://[::ffff:127.0.0.1]/x.zip')).toBe(false)
    expect(isDownloadUrlAllowed('https://[::ffff:7f00:1]/x.zip')).toBe(false)
    expect(isDownloadUrlAllowed('https://[::ffff:10.0.0.1]/x.zip')).toBe(false)
    // 纯十进制 / 十六进制整数 IP。
    expect(isDownloadUrlAllowed('https://2130706433/x.zip')).toBe(false)
    expect(isDownloadUrlAllowed('https://0x7f000001/x.zip')).toBe(false)
    // 超出 v4 范围的整数 host。
    expect(isDownloadUrlAllowed('https://2887685888/x.zip')).toBe(false)
    // 八进制分段（前导 0 歧义）。
    expect(isDownloadUrlAllowed('https://0177.0.0.1/x.zip')).toBe(false)
    // mapped 公网地址仍放行（行为对齐：校验的是内网/保留段）。
    expect(isDownloadUrlAllowed('https://[::ffff:8.8.8.8]/x.zip')).toBe(true)
  })
})

describe('extractZip（本地构造包，不走网络）', () => {
  it('正常解压：文件与子目录落位，返回文件数', () => {
    const tmp = makeTemp()
    const zip = join(tmp, 'ok.zip')
    writeFileSync(
      zip,
      buildTestZip([
        { name: 'XQF-象棋谱大全/残局/适情雅趣/a.xqf', content: bytes('data-a') },
        { name: 'XQF-象棋谱大全/全局/b.xqf', content: bytes('data-b') },
        { name: 'README.md', content: bytes('readme') }
      ])
    )
    const target = join(tmp, 'corpus')
    const count = extractZip(zip, target)
    expect(count.extracted).toBe(3)
    expect(count.skipped).toBe(0)
    expect(
      existsSync(join(target, 'XQF-象棋谱大全', '残局', '适情雅趣', 'a.xqf'))
    ).toBe(true)
  })

  it('deflate 压缩条目正确解压', () => {
    const tmp = makeTemp()
    const zip = join(tmp, 'deflate.zip')
    writeFileSync(
      zip,
      buildTestZip([{ name: 'data.bin', content: bytes('compress-me-compress-me-compress-me'), method: 8 }])
    )
    const target = join(tmp, 'corpus')
    const count = extractZip(zip, target)
    expect(count.extracted).toBe(1)
  })

  it('zip-slip 防护：.. 越界、绝对路径、盘符条目被跳过', () => {
    const tmp = makeTemp()
    const zip = join(tmp, 'evil.zip')
    writeFileSync(
      zip,
      buildTestZip([
        { name: '../escape.txt', content: bytes('evil') },
        { name: '/abs/evil.txt', content: bytes('evil') },
        { name: 'C:/evil.txt', content: bytes('evil') },
        { name: 'XQF-象棋谱大全/安全.xqf', content: bytes('safe') }
      ])
    )
    const target = join(tmp, 'corpus')
    const count = extractZip(zip, target)
    expect(count.extracted).toBe(1) // 只有安全条目被解压
    expect(existsSync(join(target, 'XQF-象棋谱大全', '安全.xqf'))).toBe(true)
    expect(existsSync(join(tmp, 'escape.txt'))).toBe(false) // 越界文件不存在于临时目录
  })

  it('zip-slip 探针：反斜杠归一、嵌套 ..、UNC、符号链接全拦截', () => {
    const tmp = makeTemp()
    const zip = join(tmp, 'probes.zip')
    writeFileSync(
      zip,
      buildTestZip([
        { name: '..\\escape.txt', content: bytes('evil') },
        { name: 'a/../../escape2.txt', content: bytes('evil2') },
        { name: '\\\\evil\\share\\f.txt', content: bytes('evil3') },
        { name: 'link/evil.xqf', content: bytes('evil'), unixMode: 0xa1ff }, // S_IFLNK
        { name: 'ok.txt', content: bytes('hi') }
      ])
    )
    const target = join(tmp, 'corpus')
    const count = extractZip(zip, target)
    expect(count.extracted).toBe(1) // 只允许 ok.txt 落地
    expect(existsSync(join(target, 'ok.txt'))).toBe(true)
    expect(existsSync(join(tmp, 'escape.txt'))).toBe(false)
    expect(existsSync(join(tmp, 'escape2.txt'))).toBe(false)
    expect(existsSync(join(tmp, 'evil'))).toBe(false)
    expect(existsSync(join(target, 'link'))).toBe(false)
  })

  it('Windows 保留名（含扩展名形式）与尾随点/空格条目被跳过', () => {
    const tmp = makeTemp()
    const zip = join(tmp, 'reserved.zip')
    writeFileSync(
      zip,
      buildTestZip([
        { name: 'CON', content: bytes('x') },
        { name: 'NUL.txt', content: bytes('x') },
        { name: 'com1', content: bytes('x') },
        { name: 'aux/inner.txt', content: bytes('x') },
        { name: 'LPT2', content: bytes('x') },
        { name: 'bad.', content: bytes('x') },
        { name: 'bad. ', content: bytes('x') },
        { name: 'good.txt', content: bytes('ok') }
      ])
    )
    const target = join(tmp, 'corpus')
    const result = extractZip(zip, target)
    expect(result.extracted).toBe(1) // 只有 good.txt 落地
    expect(result.skipped).toBe(7)
    expect(existsSync(join(target, 'good.txt'))).toBe(true)
  })

  it('同名冲突（先文件后目录）跳过冲突条目，不中断整体解压', () => {
    const tmp = makeTemp()
    const zip = join(tmp, 'conflict.zip')
    writeFileSync(
      zip,
      buildTestZip([
        { name: 'conflict', content: bytes('file') },
        { name: 'conflict/inner.txt', content: bytes('dir-entry') },
        { name: 'ok.txt', content: bytes('ok') }
      ])
    )
    const target = join(tmp, 'corpus')
    const result = extractZip(zip, target)
    expect(result.extracted).toBe(2) // conflict 文件与 ok.txt 落地
    expect(result.skipped).toBe(1) // conflict/inner.txt 因同名冲突被跳过
    expect(existsSync(join(target, 'ok.txt'))).toBe(true)
  })

  it('extractZipAtomic：失败时清理临时目录且旧目录不被破坏', async () => {
    const parent = makeTemp()
    const target = join(parent, 'corpus')
    mkdirSync(target)
    writeFileSync(join(target, 'old.txt'), 'old')

    // 非 zip 垃圾字节：解压必然抛异常（先过魔数校验才到解压，直接测 atomic 对坏 zip 的容错）。
    const corrupt = join(parent, 'corrupt.zip')
    writeFileSync(corrupt, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff]))

    await expect(extractZipAtomic(corrupt, target)).rejects.toThrow()

    expect(existsSync(join(target, 'old.txt'))).toBe(true)
    const leftovers = readdirSync(parent).filter(
      (d) => statSync(join(parent, d)).isDirectory() && d.startsWith('corpus.tmp')
    )
    expect(leftovers).toEqual([]) // 失败的临时解压目录应被整体删除
  })

  it('extractZipAtomic：成功后原子替换旧目录', async () => {
    const parent = makeTemp()
    const target = join(parent, 'corpus')
    mkdirSync(target)
    writeFileSync(join(target, 'old.txt'), 'old')

    const zip = join(parent, 'replace.zip')
    writeFileSync(zip, buildTestZip([{ name: 'new.txt', content: bytes('new') }]))

    const result = await extractZipAtomic(zip, target)
    expect(result.extracted).toBe(1)
    expect(result.skipped).toBe(0)
    expect(existsSync(join(target, 'new.txt'))).toBe(true)
    expect(existsSync(join(target, 'old.txt'))).toBe(false) // 旧目录被整体替换
    const leftovers = readdirSync(parent).filter((d) => d.startsWith('corpus.tmp'))
    expect(leftovers).toEqual([])
  })
})

describe('verifyZipIntegrity（魔数 + 大小区间）', () => {
  it('非 zip 魔数抛错', () => {
    const tmp = makeTemp()
    const f = join(tmp, 'bad.zip')
    writeFileSync(f, Buffer.alloc(2 << 20, 0x00))
    expect(() => verifyZipIntegrity(f)).toThrow(/魔数/)
  })

  it('大小越界抛错（<1MB）', () => {
    const tmp = makeTemp()
    const f = join(tmp, 'small.zip')
    writeFileSync(f, Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(() => verifyZipIntegrity(f)).toThrow(/大小异常/)
  })
})
