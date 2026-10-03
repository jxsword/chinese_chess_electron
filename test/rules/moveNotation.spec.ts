/**
 * 中文记法快照测试（09 §2.1 之 3：炮二平五/马8进7/兵五进一 等逐字快照）。
 * 覆盖 02 §4 三分支 × 红黑双方：平移 / 进退直线 / 斜走。
 *
 * 红方列号 = HAN[col]（col 0→九 … col 8→一）；黑方列号 = col+1。
 * 经典对照：马二进三（红马 col7→col6）、相三进五（红相 col6→col4）、
 * 仕四进五（红仕 col5→col4）。
 */
import { describe, expect, it } from 'vitest'
import { chineseNotation, pieceFromFenChar, pos } from '@packages/rules'

/** [FEN字符, from, to] → chineseNotation 输出。 */
function notation(fenChar: string, fc: number, fr: number, tc: number, tr: number): string {
  const piece = pieceFromFenChar(fenChar)
  if (piece === null) throw new Error(`非法棋子字符: ${fenChar}`)
  return chineseNotation(piece, pos(fc, fr), pos(tc, tr))
}

describe('chineseNotation 中文纵线记法', () => {
  it('红方平移：炮二平五 / 炮八平五 / 兵九平八', () => {
    expect(notation('C', 7, 7, 4, 7)).toMatchInlineSnapshot(`"炮二平五"`)
    expect(notation('C', 1, 7, 4, 7)).toMatchInlineSnapshot(`"炮八平五"`)
    expect(notation('P', 0, 4, 1, 4)).toMatchInlineSnapshot(`"兵九平八"`)
  })

  it('黑方平移：将5平4', () => {
    expect(notation('k', 4, 0, 3, 0)).toMatchInlineSnapshot(`"将5平4"`)
  })

  it('红方直线进：兵五进一 / 车一进一 / 车九进一 / 炮二进四 / 帅五进一', () => {
    expect(notation('P', 4, 6, 4, 5)).toMatchInlineSnapshot(`"兵五进一"`)
    expect(notation('R', 8, 9, 8, 8)).toMatchInlineSnapshot(`"车一进一"`)
    expect(notation('R', 0, 9, 0, 8)).toMatchInlineSnapshot(`"车九进一"`)
    expect(notation('C', 7, 7, 7, 3)).toMatchInlineSnapshot(`"炮二进四"`)
    expect(notation('K', 4, 9, 4, 8)).toMatchInlineSnapshot(`"帅五进一"`)
  })

  it('红方直线退：车一退二 / 车九退二', () => {
    expect(notation('R', 8, 7, 8, 9)).toMatchInlineSnapshot(`"车一退二"`)
    expect(notation('R', 0, 7, 0, 9)).toMatchInlineSnapshot(`"车九退二"`)
  })

  it('黑方直线进退：卒1进1 / 车1退1', () => {
    expect(notation('p', 0, 3, 0, 4)).toMatchInlineSnapshot(`"卒1进1"`)
    expect(notation('r', 0, 2, 0, 1)).toMatchInlineSnapshot(`"车1退1"`)
  })

  it('红方斜走：马二进三 / 仕四进五 / 仕六进五 / 相三进五 / 相七进九', () => {
    expect(notation('N', 7, 9, 6, 7)).toMatchInlineSnapshot(`"马二进三"`)
    expect(notation('A', 5, 9, 4, 8)).toMatchInlineSnapshot(`"仕四进五"`)
    expect(notation('A', 3, 9, 4, 8)).toMatchInlineSnapshot(`"仕六进五"`)
    expect(notation('B', 6, 9, 4, 7)).toMatchInlineSnapshot(`"相三进五"`)
    expect(notation('B', 2, 9, 0, 7)).toMatchInlineSnapshot(`"相七进九"`)
  })

  it('黑方斜走：马8进7 / 马8退7 / 士4进5 / 士6进5', () => {
    // 黑马在己方底线 row 0 前进（row 增大）为进。
    expect(notation('n', 7, 0, 6, 2)).toMatchInlineSnapshot(`"马8进7"`)
    // 黑马在 row 9 向 row 减小方向移动为退。
    expect(notation('n', 7, 9, 6, 7)).toMatchInlineSnapshot(`"马8退7"`)
    expect(notation('a', 3, 0, 4, 1)).toMatchInlineSnapshot(`"士4进5"`)
    expect(notation('a', 5, 0, 4, 1)).toMatchInlineSnapshot(`"士6进5"`)
  })
})
