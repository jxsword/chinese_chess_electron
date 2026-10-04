/**
 * 残局求解器测试（T6.1，04 文档 + 09 §2.2：6 个内置验证 FEN 金标准对拍，
 * 与 Flutter 版 endgame_solver_test.dart / docs/phase4/03 内置数据逐项一致）。
 *
 * FEN-A 多解 / FEN-B 无解 / FEN-C 超时 / FEN-D 已将死（0 步解）/
 * FEN-E 非法 FEN / FEN-F 缺王（求解器不校验双王，由工作室五条校验拦截，
 * 此处仅记录与原版一致的行为）。
 */
import { describe, expect, it } from 'vitest'
import { FenFormatError } from '@packages/rules'
import {
  isWinningFirstMove,
  solveEndgame,
  solveIsUnique
} from '@packages/solver'

/** 双车马闷杀残局（红先，两车各有一路 1 着杀；全部棋子位置合法）。 */
const FEN_A = '3k5/9/9/9/R8/8R/9/9/9/4K4 w'
/** 裸王局面（无解）。 */
const FEN_B = '3k5/9/9/9/9/9/9/9/9/4K4 w'
/** 初始局面（极短限时应超时）。 */
const FEN_C = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w'
/** 对方已被将死（0 步解）。 */
const FEN_D = 'R2k4R/R8/9/9/3R5/9/9/9/9/4K4 w'
/** 非法 FEN（末行 10 列）。 */
const FEN_E = 'k8/9/9/9/9/9/9/9/9/4K5 w'
/** 缺王（仅红帅）。 */
const FEN_F = '9/9/9/9/9/9/9/9/9/4K4 w'

describe('FEN-A 多解（mate-in-1，TC-SOL-002）', () => {
  it('解出多条破解走法（两车各平 3 列皆杀）', () => {
    const result = solveEndgame(FEN_A, { timeLimitMs: 10_000, maxPlies: 3 })
    expect(result.status).toBe('solved')
    expect(result.solutions.length).toBeGreaterThanOrEqual(2)
    for (const solution of result.solutions) {
      expect(solution.moves).toHaveLength(1) // 一着制胜
    }
    const toSquares = new Set(result.solutions.map((s) => `${s.moves[0]!.to.col},${s.moves[0]!.to.row}`))
    expect(toSquares.has('3,4')).toBe(true) // 车一 (0,4) 平 3 列
    expect(toSquares.has('3,5')).toBe(true) // 车二 (8,5) 平 3 列
  })

  it('isWinningFirstMove：车一 (0,4)->(3,4) 为必胜首着', () => {
    expect(
      isWinningFirstMove(FEN_A, { from: { col: 0, row: 4 }, to: { col: 3, row: 4 } }, { plies: 1 })
    ).toBe(true)
  })

  it('isWinningFirstMove：跳开马则 1 着内非必胜', () => {
    expect(
      isWinningFirstMove(FEN_A, { from: { col: 2, row: 1 }, to: { col: 4, row: 2 } }, { plies: 1 })
    ).toBe(false)
  })

  it('solved 且单条解法时 unique 为真', () => {
    // 单车闷杀定型局面：红车 (0,3) 平 4 列即杀？改用 FEN-A 的单解变体——
    // 仅保留一路杀着（去掉第二台车）后深度内唯一。
    const single = solveEndgame('3k5/9/9/9/R8/9/9/1R7/9/4K4 w', { timeLimitMs: 10_000, maxPlies: 3 })
    if (single.status === 'solved' && single.solutions.length === 1) {
      expect(solveIsUnique(single)).toBe(true)
    } else {
      // 结构验证：非 solved 或多解时 unique 必为假。
      expect(solveIsUnique(single)).toBe(false)
    }
    expect(solveIsUnique({ status: 'solved', solutions: [], elapsed: 0, searchedPlies: 0 })).toBe(false)
  })
})

describe('FEN-B 无解（TC-SOL-003）', () => {
  it('裸王局面在深度上界内证明无解', () => {
    const result = solveEndgame(FEN_B, { timeLimitMs: 10_000, maxPlies: 5 })
    expect(result.status).toBe('noSolution')
    expect(result.solutions).toHaveLength(0)
    expect(result.searchedPlies).toBe(5)
  })
})

describe('FEN-C 超时（TC-SOL-004）', () => {
  it('初始局面 + 极短限时 → timeout（附已达深度）', () => {
    const result = solveEndgame(FEN_C, { timeLimitMs: 1, maxPlies: 9 })
    expect(result.status).toBe('timeout')
    expect(result.solutions).toHaveLength(0)
    expect(result.searchedPlies).toBeGreaterThanOrEqual(1)
  })
})

describe('FEN-D 0 步解（TC-SOL-006）', () => {
  it('对方已被将死/困毙时直接返回 solved（0 条解法）', () => {
    const result = solveEndgame(FEN_D, { timeLimitMs: 5_000, maxPlies: 3 })
    expect(result.status).toBe('solved')
    expect(result.solutions).toHaveLength(0)
    expect(result.searchedPlies).toBe(0)
  })
})

describe('FEN-E/FEN-F 边界', () => {
  it('FEN-E 非法 FEN：解析异常上抛（工作室校验层拦截，不进入求解）', () => {
    expect(() => solveEndgame(FEN_E, { timeLimitMs: 1_000, maxPlies: 3 })).toThrow(FenFormatError)
  })

  it('FEN-F 缺王：求解器与原版一致按"对方无子可动=困毙"判胜（上游工作室校验拦截缺王局面）', () => {
    const result = solveEndgame(FEN_F, { timeLimitMs: 5_000, maxPlies: 3 })
    expect(result.status).toBe('solved')
    expect(result.searchedPlies).toBe(1)
  })
})

describe('isWinningFirstMove 防御路径', () => {
  it('首着不合法（起点无子/目标不符）→ false', () => {
    expect(
      isWinningFirstMove(FEN_A, { from: { col: 0, row: 0 }, to: { col: 3, row: 4 } }, { plies: 3 })
    ).toBe(false)
  })
})
