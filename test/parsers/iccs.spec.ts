/** ICCS 等价用例集（test/features/puzzle/model/iccs_test.dart 7 条，06 文档 §2） */
import { describe, expect, it } from 'vitest'
import { formatIccs, parseIccs } from '@packages/parsers/iccs'
import { pos } from '@packages/rules'

describe('Iccs', () => {
  it('解析紧凑小写形式 h3e3', () => {
    const r = parseIccs('h3e3')
    expect(r).not.toBeNull()
    expect(r!.from).toEqual(pos(7, 6))
    expect(r!.to).toEqual(pos(4, 6))
  })

  it('解析带分隔的大写形式 H3-E3', () => {
    const r = parseIccs('H3-E3')
    expect(r).not.toBeNull()
    expect(r!.from).toEqual(pos(7, 6))
    expect(r!.to).toEqual(pos(4, 6))
  })

  it('行 0 为红方底线（a0 → (0,9)），行 9 为黑方底线（a9 → (0,0)）', () => {
    expect(parseIccs('a0a9')!.from).toEqual(pos(0, 9))
    expect(parseIccs('a0a9')!.to).toEqual(pos(0, 0))
  })

  it('兼容黑方底线写成 10 的情况（a10a0 → from (0,0)）', () => {
    expect(parseIccs('a10a0')!.from).toEqual(pos(0, 0))
    expect(parseIccs('h10g8')!.from).toEqual(pos(7, 0))
    expect(parseIccs('h10g8')!.to).toEqual(pos(6, 1))
  })

  it('非法输入返回 null', () => {
    expect(parseIccs('')).toBeNull()
    expect(parseIccs('h3')).toBeNull()
    expect(parseIccs('z3e3')).toBeNull()
    expect(parseIccs('炮二平五')).toBeNull()
    expect(parseIccs('h30e3')).toBeNull()
  })

  it('format 与 parse 互逆', () => {
    const from = pos(7, 6)
    const to = pos(4, 6)
    expect(formatIccs(from, to)).toBe('h3e3')
    expect(parseIccs(formatIccs(from, to)!)).toEqual({ from, to })
  })

  it('format 越界返回 null', () => {
    expect(formatIccs(pos(-1, 0), pos(0, 0))).toBeNull()
    expect(formatIccs(pos(0, 0), pos(9, 0))).toBeNull()
  })
})
