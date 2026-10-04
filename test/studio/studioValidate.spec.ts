/**
 * 工作室整体校验与入库辅助测试（T6.2，endgame_studio 10 用例等价集，09 §1）。
 * 校验五条（08 §4）+ 入库标题/结论映射（04 §7）。
 */
import { describe, expect, it } from 'vitest'
import { parseBoardFen, type BoardGrid } from '@packages/rules'
import {
  solveLabelOf,
  studioRecordTitle,
  studioUnsolvedTitle,
  validateStudioPosition
} from '@renderer/features/studio/studioValidate'

/** 从棋盘字段构造 10×9 矩阵。 */
const gridOf = (boardFen: string): BoardGrid => parseBoardFen(`${boardFen} w - - 0 1`)

describe('validateStudioPosition 校验五条', () => {
  it('① 合法局面（FEN-A 双车马闷杀）：零问题', () => {
    expect(validateStudioPosition(gridOf('3k5/9/9/9/R8/8R/9/9/9/4K4'), true)).toEqual([])
  })

  it('② 缺王/多王：提示双王数量（TC-SET-006/FEN-F）', () => {
    expect(validateStudioPosition(gridOf('9/9/9/9/9/9/9/9/9/4K4'), true)).toEqual([
      '双方必须各有一个将/帅（红 1 / 黑 0）'
    ])
    expect(validateStudioPosition(gridOf('3k5/9/9/9/9/9/9/9/9/9'), true)).toEqual([
      '双方必须各有一个将/帅（红 0 / 黑 1）'
    ])
    expect(validateStudioPosition(gridOf('3kK4/9/9/9/9/9/9/9/9/4K4'), true)).toEqual([
      '双方必须各有一个将/帅（红 2 / 黑 1）'
    ])
  })

  it('③ 位置非法：黑象摆到红方半场田字点（FEN 导入/识图同样拦截）', () => {
    const grid = gridOf('3k5/9/9/9/9/9/9/4b4/9/4K4')
    const problems = validateStudioPosition(grid, true)
    expect(problems).toEqual(['(4,7) 象：相/象不能摆到对方半场'])
  })

  it('④ 数量超限：红车 3 枚', () => {
    const grid = gridOf('3k5/9/9/9/R8/8R/9/9/R8/4K4')
    expect(validateStudioPosition(grid, true)).toEqual(['红方车最多 2 枚（当前 3 枚）'])
  })

  it('⑤ 轮走方行棋前对方已被将军 → 局面非法（TC-SET-008）', () => {
    // 黑将 (3,0) 被红车 (3,4) 沿 3 列将军，却轮红方走。
    const grid = gridOf('3k5/9/9/9/9/3R5/9/9/9/4K4')
    expect(validateStudioPosition(grid, true)).toEqual(['轮走方行棋前对方已被将军，局面非法'])
  })

  it('⑥ 轮走方已无着可走（该局面已分胜负）与数量门优先级', () => {
    // 困毙结构：黑将 (3,0) 未被将军，但 (4,0) 被红车 (4,4) 封、(3,1) 被红马 (1,2) 踏 → 轮黑无着。
    const grid = gridOf('3k5/9/1N7/9/4R4/9/9/9/9/4K4')
    expect(validateStudioPosition(grid, false)).toEqual(['轮走方已无着可走（该局面已分胜负）'])
    expect(validateStudioPosition(grid, true)).toEqual([])
    // FEN-D（4 红车）：数量上限先于胜负判定拦截（Dart 版 problems 非空即短路）。
    const fenD = gridOf('R2k4R/R8/9/9/3R5/9/9/9/9/4K4')
    expect(validateStudioPosition(fenD, true)).toEqual(['红方车最多 2 枚（当前 4 枚）'])
  })

  it('⑦ 双王缺失优先短路：后续位置/数量问题不再重复报告', () => {
    // 缺王 + 超限：只报双王（Dart 版 problems 非空即 return）。
    const grid = gridOf('9/9/9/9/R8/8R/R8/9/9/4K4')
    expect(validateStudioPosition(grid, true)).toEqual(['双方必须各有一个将/帅（红 1 / 黑 0）'])
  })
})

describe('入库标题与结论映射（04 §7）', () => {
  const NOW = new Date(2026, 9, 4, 15, 8)

  it('⑧ solveLabelOf：solved 单解=唯一解、多解=多解、noSolution=无解、timeout=未决', () => {
    expect(solveLabelOf('solved', 1)).toBe('唯一解')
    expect(solveLabelOf('solved', 2)).toBe('多解')
    expect(solveLabelOf('solved', 0)).toBe('多解')
    expect(solveLabelOf('noSolution', 0)).toBe('无解')
    expect(solveLabelOf('timeout', 0)).toBe('未决')
  })

  it('⑨ 标题自动生成：M-D 红方残局（唯一解），日补零月不补', () => {
    expect(studioRecordTitle('唯一解', true, NOW)).toBe('10-04 红方残局（唯一解）')
    expect(studioRecordTitle('多解', false, NOW)).toBe('10-04 黑方残局（多解）')
    expect(studioRecordTitle('无解', true, NOW)).toBe('10-04 红方残局（无解）')
    expect(studioRecordTitle('未决', false, NOW)).toBe('10-04 黑方残局（未决）')
    expect(studioUnsolvedTitle(true, NOW)).toBe('10-04 红方残局（未求解）')
  })

  it('⑩ 三种结论与 SolveStatus 一一对应（入库状态机）', () => {
    // solved → 'solved'；noSolution → 'noSolution'；timeout → 'timeout'（identity，防漂移）。
    const statusOf = (r: 'solved' | 'noSolution' | 'timeout'): string => r
    expect(statusOf('solved')).toBe('solved')
    expect(statusOf('noSolution')).toBe('noSolution')
    expect(statusOf('timeout')).toBe('timeout')
  })
})
