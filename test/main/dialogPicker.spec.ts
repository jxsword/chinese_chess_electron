/** 应用内选择器纯函数用例（dialogPicker 的 HTML 渲染 / 导航解析 / 目录列举） */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listPickerEntries,
  parsePickerNav,
  renderPickerHtml
} from '@main/services/dialogPicker'

const dirs: string[] = []
const makeTemp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'picker_test_'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('parsePickerNav', () => {
  it('解析 open/select/save/cancel 四种动作；非本 scheme 返回 null', () => {
    const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')
    expect(parsePickerNav(`cc-picker://open?e=${b64('/home')}&name=x`)).toEqual({
      action: 'open',
      path: '/home',
      name: 'x'
    })
    expect(parsePickerNav(`cc-picker://select?e=${b64('/a b/谱')}`)).toEqual({
      action: 'select',
      path: '/a b/谱'
    })
    expect(parsePickerNav(`cc-picker://save?e=${b64('/out')}&name=a.pgn`)).toEqual({
      action: 'save',
      path: '/out',
      name: 'a.pgn'
    })
    expect(parsePickerNav('cc-picker://cancel')).toEqual({ action: 'cancel' })
    expect(parsePickerNav('cc-picker://unknown?x=1')).toBeNull()
    expect(parsePickerNav('https://example.com')).toBeNull()
  })
})

describe('renderPickerHtml', () => {
  const state = {
    title: '选择语料目录',
    currentPath: '/home/ssy',
    entries: [
      { name: '残局', path: '/home/ssy/残局' },
      { name: '全局', path: '/home/ssy/全局' }
    ],
    mode: 'directory' as const,
    buttonLabel: '选择此目录'
  }

  it('目录模式：含主按钮/上级/取消与子目录链接，无文件名表单', () => {
    const html = renderPickerHtml(state)
    expect(html).toContain('选择此目录')
    expect(html).toContain('cc-picker://select?e=')
    expect(html).toContain('cc-picker://cancel')
    expect(html).toContain('上级目录')
    const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64url')
    expect(html).toContain(`cc-picker://open?e=${b64('/home/ssy/残局')}`)
    expect(html).not.toContain('<form')
  })

  it('save 模式：含文件名表单且无 select 链接', () => {
    const html = renderPickerHtml({ ...state, mode: 'save', fileName: '对局.pgn' })
    expect(html).toContain('<form method="get" action="cc-picker://save">')
    expect(html).toContain('value="对局.pgn"')
    expect(html).not.toContain('cc-picker://select')
  })

  it('file 模式：无表单无 select，仅浏览文件', () => {
    const html = renderPickerHtml({ ...state, mode: 'file' })
    expect(html).not.toContain('<form')
    expect(html).not.toContain('cc-picker://select')
  })

  it('空目录显示占位文案', () => {
    const html = renderPickerHtml({ ...state, entries: [] })
    expect(html).toContain('此目录下无可浏览的子目录')
  })
})

describe('listPickerEntries', () => {
  it('directory 模式仅列目录并按名称排序；file 模式仅列文件', () => {
    const root = makeTemp()
    mkdirSync(join(root, '乙目录'))
    mkdirSync(join(root, '甲目录'))
    writeFileSync(join(root, 'b.xqf'), 'x')
    writeFileSync(join(root, 'a.pgn'), 'x')

    const dirList = listPickerEntries(root, 'directory')
    expect(dirList.entries.map((e) => e.name)).toEqual(['乙目录', '甲目录'].sort((a, b) => a.localeCompare(b, 'zh')))
    expect(dirList.entries.every((e) => e.name.includes('目录'))).toBe(true)

    const fileList = listPickerEntries(root, 'file')
    expect(fileList.entries).toHaveLength(2)
    expect(fileList.entries.every((e) => e.name.includes('.'))).toBe(true)
  })

  it('不存在/不可读目录返回错误提示不抛出', () => {
    const result = listPickerEntries('/nonexistent-path-xyz', 'directory')
    expect(result.entries).toEqual([])
    expect(result.error).toContain('无法读取目录')
  })
})
