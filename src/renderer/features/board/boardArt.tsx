/**
 * 棋盘静态绘制与棋子绘制（对应 board_painter.dart，SVG 实现，08 文档 §2.3）。
 * 颜色经 CSS 变量（global.css，对齐 shared/constants.dart AppColors）。
 */
import { memo } from 'react'
import { parseBoardFen, pieceLabel } from '@packages/rules'
import type { Piece } from '@packages/rules'
import { computeBoardLayout, offsetOf, type BoardLayout } from './boardLayout'

/** 兵/炮位十字角标（board_painter.dart:111-116） */
const CROSS_MARKS: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [7, 2],
  [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
  [0, 6], [2, 6], [4, 6], [6, 6], [8, 6],
  [1, 7], [7, 7]
]

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] as const

/** 棋盘线层：外框/横线/竖线(河界断开)/九宫斜线/楚河汉界/兵炮位标记/ICCS 坐标 */
export const BoardArt = memo(function BoardArt({ layout }: { layout: BoardLayout }) {
  const { cell, originX, originY } = layout
  const at = (c: number, r: number): { x: number; y: number } => offsetOf(layout, c, r)
  const riverY = originY + 4.5 * cell
  const centerX = originX + 4 * cell
  const gap = cell * 0.65

  return (
    <g className="cc-board-art">
      {/* 外框（外扩 borderMargin，board_painter.dart:58-63） */}
      <rect
        x={at(0, 0).x - layout.borderMargin}
        y={at(0, 0).y - layout.borderMargin}
        width={8 * cell + 2 * layout.borderMargin}
        height={9 * cell + 2 * layout.borderMargin}
        fill="none"
        stroke="var(--cc-board-line)"
        strokeWidth={4}
      />
      {/* 横线 10 条 */}
      {Array.from({ length: 10 }, (_, r) => {
        const p = at(0, r)
        const q = at(8, r)
        return <line key={`h${r}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--cc-board-line)" strokeWidth={2} />
      })}
      {/* 竖线 9 条：中间 7 条被楚河汉界打断 */}
      {Array.from({ length: 9 }, (_, c) => {
        if (c === 0 || c === 8) {
          const p = at(c, 0)
          const q = at(c, 9)
          return <line key={`v${c}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--cc-board-line)" strokeWidth={2} />
        }
        const t1 = at(c, 0)
        const t2 = at(c, 4)
        const b1 = at(c, 5)
        const b2 = at(c, 9)
        return (
          <g key={`v${c}`}>
            <line x1={t1.x} y1={t1.y} x2={t2.x} y2={t2.y} stroke="var(--cc-board-line)" strokeWidth={2} />
            <line x1={b1.x} y1={b1.y} x2={b2.x} y2={b2.y} stroke="var(--cc-board-line)" strokeWidth={2} />
          </g>
        )
      })}
      {/* 九宫斜线 */}
      {([[3, 0, 5, 2], [5, 0, 3, 2], [3, 7, 5, 9], [5, 7, 3, 9]] as const).map(([c1, r1, c2, r2]) => {
        const p = at(c1, r1)
        const q = at(c2, r2)
        return <line key={`d${c1}${r1}${c2}${r2}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--cc-board-line)" strokeWidth={2} />
      })}
      {/* 楚河汉界 */}
      <text className="cc-river-text" x={centerX - cell * 2} y={riverY} fontSize={cell * 0.55}>
        楚 河
      </text>
      <text className="cc-river-text" x={centerX + cell * 2} y={riverY} fontSize={cell * 0.55}>
        漢 界
      </text>
      {/* 兵/炮位十字角标 */}
      {CROSS_MARKS.map(([c, r]) => {
        const center = at(c, r)
        const radius = cell * 0.08
        const len = radius * 1.4
        return (
          <g key={`m${c}-${r}`} stroke="var(--cc-board-line)" strokeWidth={2}>
            {([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([dx, dy]) => {
              const cx = center.x + dx * radius
              const cy = center.y + dy * radius
              return (
                <g key={`${dx}${dy}`}>
                  <line x1={cx} y1={cy} x2={cx} y2={cy + dy * len} />
                  <line x1={cx} y1={cy} x2={cx + dx * len} y2={cy} />
                </g>
              )
            })}
          </g>
        )
      })}
      {/* ICCS 坐标标注（列 a-i 上下、行 0-9 左右；0 = 红方底线，board_painter.dart:129-172） */}
      <g className="cc-coord-text">
        {FILES.map((f, c) => {
          const x = originX + c * cell
          return (
            <g key={`cf${c}`}>
              <text x={x} y={originY - gap} fontSize={cell * 0.28}>{f}</text>
              <text x={x} y={originY + 9 * cell + gap} fontSize={cell * 0.28}>{f}</text>
            </g>
          )
        })}
        {Array.from({ length: 10 }, (_, row) => {
          const rank = 9 - row
          const y = originY + row * cell
          return (
            <g key={`cr${row}`}>
              <text x={originX - gap} y={y} fontSize={cell * 0.28}>{rank}</text>
              <text x={originX + 8 * cell + gap} y={y} fontSize={cell * 0.28}>{rank}</text>
            </g>
          )
        })}
      </g>
    </g>
  )
})

/** 单枚棋子（board_painter.dart drawPiece：阴影/盘面/描边/文字） */
export function PieceFigure({ piece, x, y, radius }: { piece: Piece; x: number; y: number; radius: number }) {
  const colorVar = piece.side === 'red' ? 'var(--cc-piece-red)' : 'var(--cc-piece-black)'
  return (
    <g className="cc-piece-figure" transform={`translate(${x}, ${y})`}>
      <circle cy={radius * 0.08} r={radius * 1.02} fill="rgba(0,0,0,0.25)" />
      <circle r={radius} fill="var(--cc-piece-face)" />
      <circle r={radius * 0.92} fill="none" stroke={colorVar} strokeWidth={radius * 0.1} />
      <text className="cc-piece-text" fontSize={radius * 1.05} fill={colorVar}>
        {pieceLabel(piece)}
      </text>
    </g>
  )
}

/** 棋子层：从 FEN 解析盘面逐格渲染；animatingFrom 非空时跳过该格（飞行层接管，board_painter.dart:254-279） */
export function PiecesLayer({
  fen,
  layout,
  animatingFrom
}: {
  fen: string
  layout: BoardLayout
  animatingFrom: { col: number; row: number } | null
}) {
  const grid = parseBoardFen(fen)
  const figures: React.ReactNode[] = []
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const piece = grid[r][c]
      if (piece === null) continue
      if (animatingFrom !== null && animatingFrom.col === c && animatingFrom.row === r) continue
      const p = offsetOf(layout, c, r)
      figures.push(
        <g key={`p${c}-${r}`} data-piece={`${piece.side}-${piece.kind}`}>
          <PieceFigure piece={piece} x={p.x} y={p.y} radius={layout.pieceRadius} />
        </g>
      )
    }
  }
  return <g className="cc-pieces-layer">{figures}</g>
}

/** 高亮层（棋子层之下）：lastMove 两圆 + 选中圈 + 合法目标点/吃子外环 */
export function HighlightsLayer({
  layout,
  fen,
  lastMove,
  selected,
  legalTargets
}: {
  layout: BoardLayout
  fen: string
  lastMove: { from: { col: number; row: number }; to: { col: number; row: number } } | null
  selected: { col: number; row: number } | null
  legalTargets: ReadonlyArray<{ col: number; row: number }>
}) {
  const grid = parseBoardFen(fen)
  return (
    <g className="cc-highlights-layer">
      {lastMove !== null &&
        ([lastMove.from, lastMove.to] as const).map((p, i) => {
          const c = offsetOf(layout, p.col, p.row)
          return (
            <circle
              key={`lm${i}`}
              data-lastmove={i}
              cx={c.x}
              cy={c.y}
              r={layout.pieceRadius}
              fill="var(--cc-last-move)"
            />
          )
        })}
      {selected !== null && (() => {
        const c = offsetOf(layout, selected.col, selected.row)
        return <circle data-selected="true" cx={c.x} cy={c.y} r={layout.pieceRadius} fill="var(--cc-selected)" />
      })()}
      {legalTargets.map((t) => {
        const c = offsetOf(layout, t.col, t.row)
        const occupant = grid[t.row][t.col]
        return occupant !== null ? (
          <circle
            key={`h${t.col}-${t.row}`}
            className="cc-hint-ring"
            cx={c.x}
            cy={c.y}
            r={layout.pieceRadius + layout.cell * 0.05}
            fill="none"
            stroke="var(--cc-legal-hint)"
            strokeWidth={layout.cell * 0.08}
          />
        ) : (
          <circle key={`h${t.col}-${t.row}`} className="cc-hint-dot" cx={c.x} cy={c.y} r={layout.cell * 0.16} fill="var(--cc-legal-hint)" />
        )
      })}
    </g>
  )
}

/** 由容器尺寸推导布局的小工具（供页面/测试复用） */
export function layoutForSize(width: number, height: number): BoardLayout {
  return computeBoardLayout(width, height)
}
