/**
 * 只读棋盘（对应 static_board_widget.dart / demo_board_widget.dart，08 文档 §2.1）。
 * 用于棋谱详情重放与残局演示：无点击交互，仅渲染局面 + lastMove 高亮。
 * 工作室摆盘传入 onCellTap（static_board_widget.dart 的同款可选交互）。
 */
import type { Move } from '@packages/rules'
import { BoardArt, HighlightsLayer, PiecesLayer } from './boardArt'
import { computeBoardLayout, hitTest } from './boardLayout'
import { useElementSize, type Size } from './useElementSize'

export interface BoardViewStaticProps {
  fen: string
  lastMove?: Move | null
  sizeOverride?: Size
  /** 点击棋盘交叉点回调（工作室摆盘；缺省即纯只读） */
  onCellTap?: (col: number, row: number) => void
}

export function BoardViewStatic({ fen, lastMove, sizeOverride, onCellTap }: BoardViewStaticProps): React.JSX.Element {
  const [containerRef, size] = useElementSize(sizeOverride)
  const layout = computeBoardLayout(size.width, size.height)
  const last = lastMove ?? null

  const handleClick = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (onCellTap === undefined) return
    const rect = e.currentTarget.getBoundingClientRect()
    const scaleX = rect.width > 0 ? layout.width / rect.width : 1
    const scaleY = rect.height > 0 ? layout.height / rect.height : 1
    const hit = hitTest(layout, (e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY)
    if (hit === null) return
    onCellTap(hit.col, hit.row)
  }

  return (
    <div ref={containerRef} className="cc-board-view" style={{ width: '100%', height: '100%' }}>
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        onClick={handleClick}
        data-testid="board-static-svg"
      >
        <rect x={0} y={0} width={layout.width} height={layout.height} fill="var(--cc-board-bg)" />
        <BoardArt layout={layout} />
        <HighlightsLayer layout={layout} fen={fen} lastMove={last} selected={null} legalTargets={[]} />
        <PiecesLayer fen={fen} layout={layout} animatingFrom={null} />
      </svg>
    </div>
  )
}
