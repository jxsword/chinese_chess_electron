/**
 * 摆盘规则集测试（T6.2，board_setup_rules_test 7 用例等价集，09 §1）。
 * 逐条覆盖：九宫/士斜线点/象田字点/兵卒底线/数量上限/替换不计增。
 */
import { describe, expect, it } from 'vitest'
import { pieceFromFenChar } from '@packages/rules'
import {
  MAX_COUNT_PER_KIND,
  countIssue,
  countIssueForPlacement,
  placementIssue
} from '@renderer/features/studio/setupRules'

const piece = (fen: string) => {
  const p = pieceFromFenChar(fen)
  if (p === null) throw new Error(`bad fen char: ${fen}`)
  return p
}

describe('placementIssue 摆放位置规则', () => {
  it('① 帅/将只能放九宫：红帅 (3,9) 合法、(4,5) 拒绝', () => {
    expect(placementIssue(piece('K'), 3, 9)).toBeNull()
    expect(placementIssue(piece('K'), 5, 7)).toBeNull()
    expect(placementIssue(piece('K'), 4, 5)).toBe('帅/将只能放在九宫内的 9 个位置')
    expect(placementIssue(piece('k'), 3, 0)).toBeNull()
    expect(placementIssue(piece('k'), 4, 3)).toBe('帅/将只能放在九宫内的 9 个位置')
  })

  it('② 士限九宫 5 个斜线点：(3,9)/(4,8) 合法，(4,9)/(3,8) 直线点拒绝，过河 (4,1) 为黑士合法', () => {
    // 红方九宫斜线点 (col+row) 为偶数：(3,7)(5,7)(4,8)(3,9)(5,9)。
    expect(placementIssue(piece('A'), 3, 9)).toBeNull()
    expect(placementIssue(piece('A'), 4, 8)).toBeNull()
    expect(placementIssue(piece('A'), 4, 9)).toBe('士/仕只能放在九宫的 5 个斜线位置上')
    expect(placementIssue(piece('A'), 3, 8)).toBe('士/仕只能放在九宫的 5 个斜线位置上')
    // 黑方九宫斜线点 (col+row) 为奇数：(3,0)(5,0)(4,1)(3,2)(5,2)。
    expect(placementIssue(piece('a'), 4, 1)).toBeNull()
    expect(placementIssue(piece('a'), 4, 0)).toBe('士/仕只能放在九宫的 5 个斜线位置上')
  })

  it('③ 相/象限己方半场田字点：(2,9) 合法、(4,7) 合法、过河 (2,3) 拒绝、奇数列 (3,8) 拒绝', () => {
    expect(placementIssue(piece('B'), 2, 9)).toBeNull()
    expect(placementIssue(piece('B'), 4, 7)).toBeNull()
    expect(placementIssue(piece('B'), 0, 5)).toBeNull()
    expect(placementIssue(piece('B'), 2, 3)).toBe('相/象不能摆到对方半场')
    expect(placementIssue(piece('B'), 3, 8)).toBe('相/象只能落在偶数列的田字点上')
    expect(placementIssue(piece('B'), 2, 8)).toBe('相只能放在己方半场 5/7/9 排的田字点上')
    expect(placementIssue(piece('b'), 2, 0)).toBeNull()
    expect(placementIssue(piece('b'), 6, 2)).toBeNull()
    expect(placementIssue(piece('b'), 6, 1)).toBe('象只能放在己方半场 0/2/4 排的田字点上')
  })

  it('④ 兵/卒不能放本方底线三排：红兵 row≤6、黑卒 row≥3；车马炮任意空位', () => {
    expect(placementIssue(piece('P'), 0, 6)).toBeNull()
    expect(placementIssue(piece('P'), 8, 0)).toBeNull()
    expect(placementIssue(piece('P'), 4, 7)).toBe('兵/卒不能放在本方底线三排')
    expect(placementIssue(piece('p'), 0, 3)).toBeNull()
    expect(placementIssue(piece('p'), 4, 2)).toBe('兵/卒不能放在本方底线三排')
    expect(placementIssue(piece('R'), 0, 0)).toBeNull()
    expect(placementIssue(piece('n'), 8, 9)).toBeNull()
    expect(placementIssue(piece('C'), 4, 4)).toBeNull()
  })
})

describe('数量上限规则', () => {
  it('⑤ 每种棋子每方上限：王1 士象马车炮2 兵5', () => {
    expect(MAX_COUNT_PER_KIND.king).toBe(1)
    expect(MAX_COUNT_PER_KIND.advisor).toBe(2)
    expect(MAX_COUNT_PER_KIND.minister).toBe(2)
    expect(MAX_COUNT_PER_KIND.knight).toBe(2)
    expect(MAX_COUNT_PER_KIND.rook).toBe(2)
    expect(MAX_COUNT_PER_KIND.cannon).toBe(2)
    expect(MAX_COUNT_PER_KIND.pawn).toBe(5)
  })

  it('⑥ countIssue：红车 3 枚报首个超限原因，5 卒合法', () => {
    const redRook = piece('R')
    expect(countIssue([[redRook, 3]])).toBe('红方车最多 2 枚（当前 3 枚）')
    expect(countIssue([[piece('P'), 5], [piece('p'), 5]])).toBeNull()
    expect(countIssue([[piece('k'), 1]])).toBeNull()
  })

  it('⑦ countIssueForPlacement：替换同子不算新增、超限拒绝', () => {
    const redRook = piece('R')
    // 已有 2 枚红车，同格替换不新增 → 合法；换到空格 → 超限。
    expect(countIssueForPlacement(redRook, 2, redRook)).toBeNull()
    expect(countIssueForPlacement(redRook, 2, null)).toBe('红方车最多 2 枚')
    expect(countIssueForPlacement(redRook, 2, piece('P'))).toBe('红方车最多 2 枚')
    expect(countIssueForPlacement(redRook, 1, null)).toBeNull()
  })
})
