/**
 * 棋盘几何布局（对应 board_layout.dart）：绘制/命中/动画共用同一几何。
 *
 * 尺寸推导（board_layout.dart:13-45）：画布四周留白比例 0.8（外框外扩 0.5
 * + 边框线宽与 ICCS 坐标余量 0.3），故 cell = min(w/9.6, h/10.6)。
 * 注：08 §2.3 写作 min(width/8.6, height/9.6) 系文档笔误（9.6/10.6 才与
 * board_layout.dart 一致），以"对齐 board_layout.dart"的原版公式为准。
 */
export const PIECE_RATIO = 0.86 // 棋子直径/格边长（constants.dart:15）
const BORDER_MARGIN_RATIO = 0.5
const CANVAS_PADDING_RATIO = BORDER_MARGIN_RATIO + 0.3

export interface BoardLayout {
  cell: number
  originX: number
  originY: number
  width: number
  height: number
  pieceRadius: number
  borderMargin: number
}

export function computeBoardLayout(width: number, height: number): BoardLayout {
  const byWidth = width / (8 + 2 * CANVAS_PADDING_RATIO)
  const byHeight = height / (9 + 2 * CANVAS_PADDING_RATIO)
  const cell = Math.min(byWidth, byHeight)
  return {
    cell,
    originX: (width - 8 * cell) / 2,
    originY: (height - 9 * cell) / 2,
    width,
    height,
    pieceRadius: (cell * PIECE_RATIO) / 2,
    borderMargin: cell * BORDER_MARGIN_RATIO
  }
}

/** 网格交点 (col,row) 的画布坐标（board_layout.dart:48-51） */
export const offsetOf = (layout: BoardLayout, col: number, row: number): { x: number; y: number } => ({
  x: layout.originX + col * layout.cell,
  y: layout.originY + row * layout.cell
})

/** 画布坐标 → 最近交点；越界返回 null（board_widget.dart:47-49 的命中换算） */
export function hitTest(layout: BoardLayout, x: number, y: number): { col: number; row: number } | null {
  const col = Math.round((x - layout.originX) / layout.cell)
  const row = Math.round((y - layout.originY) / layout.cell)
  if (col < 0 || col > 8 || row < 0 || row > 9) return null
  return { col, row }
}
