/**
 * 棋盘交互层（对应 board_widget.dart）：点击命中 + 220ms 走子动画。
 *
 * 竞态防护逐条对齐 08 §2.2 时序（防错 #1）：
 * 1. 动画期间忽略新点击（board_widget.dart:42）——动画结束才真正落子；
 * 2. 动画棋子 layer 接管，底层棋子层隐藏 from 处棋子（board_painter.dart:266-270）；
 * 3. 动画结束调 vm.onTap(to) 落子（board_widget.dart:99）；
 * 4. 仅当 moveHistory 确实增长才触发 onMoved（board_widget.dart:104）——
 *    动画窗口内被清选/终局/新局时 onTap 未产生走子，不得触发 AI 应手。
 *
 * 权威结束信号 = 220ms 定时器（与 CSS transition 并行；transitionend 在
 * 后台页签不可靠且 jsdom 不可测，DR-006 ③）。
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { Piece, Position } from '@packages/rules'
import { pos } from '@packages/rules'
import type { GameStore } from '@renderer/stores/createGameStore'
import { BoardArt, HighlightsLayer, PieceFigure, PiecesLayer } from './boardArt'
import { computeBoardLayout, hitTest, offsetOf } from './boardLayout'
import { useElementSize, type Size } from './useElementSize'

/** 走子动画时长（board_widget.dart:78） */
export const MOVE_ANIMATION_MS = 220
/** easeOutCubic（Curves.easeOutCubic 的 CSS 贝塞尔等价） */
const EASE_OUT_CUBIC = 'cubic-bezier(0.215, 0.61, 0.355, 1)'

interface FlyingPiece {
  piece: Piece
  from: Position
  to: Position
  /** 递增 id：动画重启时强制两阶段 CSS 重新起跑 */
  seq: number
}

export interface BoardViewProps {
  store: GameStore
  /** 走子完成回调（页面据此触发 AI/LLM 应手或持久化） */
  onMoved?: () => void
  /** 固定尺寸（测试/静态预览）；缺省实测容器，无法实测时 600×600 兜底 */
  sizeOverride?: Size
}

export function BoardView({ store, onMoved, sizeOverride }: BoardViewProps): React.JSX.Element {
  const [containerRef, size] = useElementSize(sizeOverride)
  const layout = computeBoardLayout(size.width, size.height)

  const fen = useStore(store, (s) => s.fen)
  const lastMove = useStore(store, (s) => s.lastMove)
  const selected = useStore(store, (s) => s.selected)
  const legalTargets = useStore(store, (s) => s.legalTargets)

  const [flying, setFlying] = useState<FlyingPiece | null>(null)
  const [flyStarted, setFlyStarted] = useState(false)
  const flyingRef = useRef<FlyingPiece | null>(null)
  const seqRef = useRef(0)
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (endTimerRef.current !== null) clearTimeout(endTimerRef.current)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      flyingRef.current = null
    }
  }, [])

  const startAnimation = (mover: Piece, from: Position, to: Position): void => {
    // 历史长度在动画起点捕获（board_widget.dart:96）
    const historyBefore = store.getState().moveHistory.length
    const flyingPiece: FlyingPiece = { piece: mover, from, to, seq: ++seqRef.current }
    flyingRef.current = flyingPiece
    setFlying(flyingPiece)
    setFlyStarted(false)

    // 两阶段启动：先落在 from，下一帧移向 to，让 CSS transition 起跑
    if (typeof requestAnimationFrame === 'function') {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        setFlyStarted(true)
      })
    } else {
      setFlyStarted(true)
    }

    if (endTimerRef.current !== null) clearTimeout(endTimerRef.current)
    endTimerRef.current = setTimeout(() => {
      endTimerRef.current = null
      const vm = store.getState().vm
      vm.onTap(to.col, to.row) // 动画结束才真正落子（board_widget.dart:99）
      flyingRef.current = null
      setFlying(null)
      // 仅当历史确实增长才通知（board_widget.dart:104，防重复触发 AI）
      const historyAfter = store.getState().moveHistory.length
      if (historyAfter > historyBefore) onMoved?.()
    }, MOVE_ANIMATION_MS)
  }

  const handleClick = (e: React.MouseEvent<SVGSVGElement>): void => {
    // ① 动画期间忽略新点击（board_widget.dart:42）
    if (flyingRef.current !== null) return
    const rect = e.currentTarget.getBoundingClientRect()
    const scaleX = rect.width > 0 ? layout.width / rect.width : 1
    const scaleY = rect.height > 0 ? layout.height / rect.height : 1
    const hit = hitTest(layout, (e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY)
    if (hit === null) return

    const state = store.getState()
    const { selected: sel, legalTargets: targets } = state
    const isLegalTarget =
      sel !== null && targets.some((p) => p.col === hit.col && p.row === hit.row)

    if (sel !== null && isLegalTarget) {
      // ② 合法目标：先动画后落子
      const mover = state.vm.board.pieceAtP(sel)
      if (mover !== null) {
        startAnimation(mover, sel, pos(hit.col, hit.row))
      } else {
        state.vm.onTap(hit.col, hit.row) // 防御：选中棋子意外丢失时退化为普通点击
      }
    } else {
      state.vm.onTap(hit.col, hit.row)
    }
  }

  const animatingFrom = flying !== null ? flying.from : null

  return (
    <div ref={containerRef} className="cc-board-view" style={{ width: '100%', height: '100%' }}>
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        onClick={handleClick}
        data-testid="board-svg"
      >
        <rect x={0} y={0} width={layout.width} height={layout.height} fill="var(--cc-board-bg)" />
        <BoardArt layout={layout} />
        <HighlightsLayer layout={layout} fen={fen} lastMove={lastMove} selected={selected} legalTargets={legalTargets} />
        <PiecesLayer fen={fen} layout={layout} animatingFrom={animatingFrom} />
        {/* 飞行棋子层（动画期间渲染，忽略指针） */}
        {flying !== null && (() => {
          const from = offsetOf(layout, flying.from.col, flying.from.row)
          const to = offsetOf(layout, flying.to.col, flying.to.row)
          const p = flyStarted ? to : from
          return (
            <g
              className="cc-flying"
              style={{
                transform: `translate(${p.x}px, ${p.y}px)`,
                transition: flyStarted ? `transform ${MOVE_ANIMATION_MS}ms ${EASE_OUT_CUBIC}` : 'none',
                pointerEvents: 'none'
              }}
            >
              <PieceFigure piece={flying.piece} x={0} y={0} radius={layout.pieceRadius} />
            </g>
          )
        })()}
      </svg>
    </div>
  )
}
