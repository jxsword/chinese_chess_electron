/**
 * L3 规则裁决金标准测试（T3.9，DR-018，final 设计 §5）。
 *
 * judgeRepetition 为无状态纯函数：以完整 fenHistory 调用，悔棋/读档即截断重算。
 * 局面序列为手工构造的 FEN 环（车摇摆成环 / 照面王互将环 / 无将军闲着环）。
 * 行坐标：row0 = 黑方底线（王 e10 = row0 col4），row9 = 红方底线（王 h1 = row9 col8）。
 */
import { describe, expect, it } from 'vitest'
import { judgeRepetition } from '../../src/packages/rules/repetitionJudge'

/** 车摇摆成环（红方每手将军，黑王 e10↔e9 摇摆）：
 *  P0(w) →Ra10+→ P1(b) →Ke9→ P2(w) →Ra9+→ P3(b) →Ke10→ P4(w)=P0 */
const SWING = [
  '4k4/R8/9/9/9/9/9/9/9/8K w - - 0 1', // P0：车 a9，黑王 e10
  'R3k4/9/9/9/9/9/9/9/9/8K b - - 0 1', // P1：Ra10+（将军）
  'R8/4k4/9/9/9/9/9/9/9/8K w - - 0 1', // P2：黑 Ke9
  '9/R3k4/9/9/9/9/9/9/9/8K b - - 0 1', // P3：Ra9+（将军）
  '4k4/R8/9/9/9/9/9/9/9/8K w - - 0 1' // P4 = P0
]

/** 无将军闲着环（车在 a9↔a8 摆动，双方王闲走）：
 *  P0(w) →Ra8→ P1(b) →Kd10→ P2(w) →Ra9→ P3(b) →Ke10→ P4(w)=P0 */
const QUIET = [
  '4k4/R8/9/9/9/9/9/9/9/8K w - - 0 1', // P0：车 a9，黑王 e10
  '4k4/9/R8/9/9/9/9/9/9/8K b - - 0 1', // P1：Ra8（不将军：黑王 row0 不在车 row2 攻击线）
  '3k5/9/R8/9/9/9/9/9/9/8K w - - 0 1', // P2：黑 Kd10
  '3k5/R8/9/9/9/9/9/9/9/8K b - - 0 1', // P3：Ra9（不将军）
  '4k4/R8/9/9/9/9/9/9/9/8K w - - 0 1' // P4 = P0
]

/** 照面王互将环（双王同列照面 = 双方互相"将军"，每手王沿列进退维持照面）：
 *  P0(w) →Kd1-d2→ P1(b) →Kd10-d9→ P2(w) →Kd2-d1→ P3(b) →Kd9-d10→ P4(w)=P0
 *  注：P3 与 P0 同盘面但轮走方不同（重复键含轮走方），故重现点为 P4/P8。 */
const FACING = [
  '3k5/9/9/9/9/9/9/9/9/3K5 w - - 0 1', // P0：双王 d 列照面（红先行，红王亦被"将"）
  '3k5/9/9/9/9/9/9/9/3K5/9 b - - 0 1', // P1：红 Kd2（照面维持 → 红这手"将军"黑）
  '9/3k5/9/9/9/9/9/9/3K5/9 w - - 0 1', // P2：黑 Kd9（照面维持 → 黑这手"将军"红）
  '3k5/9/9/9/9/9/9/9/9/3K5 b - - 0 1', // P3：同 P0 盘面、轮走方 b
  '3k5/9/9/9/9/9/9/9/9/3K5 w - - 0 1' // P4 = P0
]

describe('judgeRepetition 金标准（DR-018）', () => {
  it('无重复（<2 次）→ null', () => {
    expect(judgeRepetition([SWING[0]!])).toBeNull()
    expect(judgeRepetition(SWING.slice(0, 4))).toBeNull() // P0..P3 无重现
    expect(judgeRepetition([SWING[0]!, SWING[2]!])).toBeNull() // 不同局面
  })

  it('k=2 单方全程将军 → perpetualCheckWarning（长将方 = red）', () => {
    expect(judgeRepetition(SWING)).toEqual({ type: 'perpetualCheckWarning', side: 'red' })
  })

  it('k=2 双方全程将军（照面环）→ 不警告（k=3 才裁决）', () => {
    expect(judgeRepetition(FACING)).toBeNull()
  })

  it('k=3 单方全程将军 → perpetualCheckLoss（违规方 = red）', () => {
    // 再走一轮摇摆：P5..P7 = P1..P3，P8 = P0
    const seq = [...SWING, ...SWING.slice(1, 4), SWING[0]!]
    expect(judgeRepetition(seq)).toEqual({ type: 'perpetualCheckLoss', side: 'red' })
  })

  it('k=3 双方全程将军（照面环）→ bothPerpetualCheckDraw（不变作和）', () => {
    const seq = [...FACING, ...FACING.slice(1, 4), FACING[0]!]
    expect(judgeRepetition(seq)).toEqual({ type: 'bothPerpetualCheckDraw' })
  })

  it('k=3 无人全程将军（闲着环）→ repetitionDraw', () => {
    const seq = [...QUIET, ...QUIET.slice(1, 4), QUIET[0]!]
    expect(judgeRepetition(seq)).toEqual({ type: 'repetitionDraw' })
  })

  it('k=4 → forcedRepetitionDraw（玩家拒绝和棋后再次重复）', () => {
    const seq = [
      ...SWING,
      ...SWING.slice(1, 4),
      SWING[0]!, // k=3
      ...SWING.slice(1, 4),
      SWING[0]! // k=4
    ]
    expect(judgeRepetition(seq)).toEqual({ type: 'forcedRepetitionDraw' })
  })

  it('无状态：悔棋（截断）后重算立即回到 k=2 警告', () => {
    const full = [...SWING, ...SWING.slice(1, 4), SWING[0]!] // k=3 loss
    expect(judgeRepetition(full)).toEqual({ type: 'perpetualCheckLoss', side: 'red' })
    expect(judgeRepetition(full.slice(0, 5))).toEqual({ type: 'perpetualCheckWarning', side: 'red' })
  })

  it('k=2 闲着环（无人全程将军）→ null（仅长将形态才警告）', () => {
    expect(judgeRepetition(QUIET)).toBeNull()
  })
})
