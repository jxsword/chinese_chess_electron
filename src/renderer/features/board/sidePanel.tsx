/**
 * 右侧操作面板组件族（对应 side_panel.dart）：回合指示/结果横幅/走法记录/悔棋新游戏。
 * 公开组件供各对弈页面复用。
 */
import { useState } from 'react'
import { useStore } from 'zustand'
import { chineseNotation } from '@packages/rules'
import type { Move } from '@packages/rules'
import type { GameResult } from '@shared/ipc/types'
import type { GameStore } from '@renderer/stores/createGameStore'

/** 回合指示（含"将军！"，side_panel.dart:94-137） */
export function TurnIndicator({ isRedTurn, isCheck, isFinished }: { isRedTurn: boolean; isCheck: boolean; isFinished: boolean }) {
  const cls = isRedTurn ? 'cc-turn cc-turn-red' : 'cc-turn cc-turn-black'
  return (
    <div className={cls}>
      <span className="cc-turn-dot" />
      <strong>{isRedTurn ? '红方走棋' : '黑方走棋'}</strong>
      {isCheck && !isFinished && <span className="cc-check-mark">将军！</span>}
    </div>
  )
}

/** 对局结果横幅（side_panel.dart:142-175）；result 为 null 不显示 */
export function ResultBanner({ result }: { result: GameResult | null }) {
  if (result === null) return null
  const text = result === 'redWins' ? '红方胜！' : result === 'blackWins' ? '黑方胜！' : '和棋'
  return <div className={`cc-result-banner cc-result-${result}`}>{text}</div>
}

/** 走法格式化：优先中文记法；棋子信息缺失时退回简易记法（side_panel.dart:210-222） */
export function formatMove(m: Move): string {
  if (m.piece !== undefined) return chineseNotation(m.piece, m.from, m.to)
  const han = ['九', '八', '七', '六', '五', '四', '三', '二', '一']
  const isRed = m.from.row >= 5
  const fc = isRed ? han[m.from.col]! : String(m.from.col + 1)
  const tc = isRed ? han[m.to.col]! : String(m.to.col + 1)
  if (m.from.row === m.to.row) return `?${fc} 平 ${tc}`
  const ahead = isRed ? m.to.row < m.from.row : m.to.row > m.from.row
  const steps = Math.abs(m.to.row - m.from.row)
  const target = isRed ? han[9 - steps]! : String(steps)
  return `?${fc} ${ahead ? '进' : '退'} ${target}`
}

/** 走法记录双列列表（红/黑 分列，side_panel.dart:178-207） */
export function MoveRecordsList({ moves }: { moves: readonly Move[] }) {
  if (moves.length === 0) {
    return <div className="cc-move-records-empty">暂无走法</div>
  }
  const rows: React.JSX.Element[] = []
  for (let i = 0; i < moves.length; i += 2) {
    const round = Math.floor(i / 2) + 1
    const redMove = moves[i]
    const blackMove = i + 1 < moves.length ? (moves[i + 1] ?? null) : null
    rows.push(
      <div key={round} className="cc-move-row">
        <span className="cc-move-round">{round}.</span>
        {redMove !== undefined && <span className="cc-move-red">{formatMove(redMove)}</span>}
        {blackMove !== null ? <span className="cc-move-black">{formatMove(blackMove)}</span> : <span />}
      </div>
    )
  }
  return <div className="cc-move-records">{rows}</div>
}

export interface SidePanelProps {
  store: GameStore
  /** 新游戏确认后的回调（页面可注入重置计时器等）；缺省仅重置棋盘 */
  onNewGame?: () => void
  /** 悔棋回调；缺省 vm.undo（单手） */
  onUndo?: () => void
}

/** 面板：回合指示 + 结果横幅 + 悔棋/新游戏 + 走法记录（side_panel.dart:11-92） */
export function SidePanel({ store, onNewGame, onUndo }: SidePanelProps): React.JSX.Element {
  const isRedTurn = useStore(store, (s) => s.isRedTurn)
  const isCheck = useStore(store, (s) => s.isCheck)
  const result = useStore(store, (s) => s.result)
  const moveHistory = useStore(store, (s) => s.moveHistory)
  const [confirming, setConfirming] = useState(false)

  const handleNewGame = (): void => {
    if (onNewGame !== undefined) {
      onNewGame()
    } else {
      store.getState().vm.newGame()
    }
  }

  return (
    <div className="cc-card cc-side-panel">
      <TurnIndicator isRedTurn={isRedTurn} isCheck={isCheck} isFinished={result !== null} />
      <ResultBanner result={result} />
      <div className="cc-button-row">
        <button type="button" className="cc-btn" disabled={moveHistory.length === 0} onClick={() => (onUndo !== undefined ? onUndo() : store.getState().vm.undo())}>
          悔棋
        </button>
        <button type="button" className="cc-btn cc-btn-primary" onClick={() => setConfirming(true)}>
          新游戏
        </button>
      </div>
      <div className="cc-side-panel-records">
        <div className="cc-section-title">走法记录</div>
        <MoveRecordsList moves={moveHistory} />
      </div>
      {/* 新游戏确认对话框（side_panel.dart:70-91，防错 #3） */}
      {confirming && (
        <ConfirmDialog
          title="开始新游戏"
          content="当前棋局将被清空，确定要开始新游戏吗？"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            handleNewGame()
          }}
        />
      )}
    </div>
  )
}

/** 通用确认对话框（AlertDialog 最小实现） */
export function ConfirmDialog({
  title,
  content,
  confirmLabel = '确定',
  cancelLabel = '取消',
  onConfirm,
  onCancel
}: {
  title: string
  content: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="cc-dialog-mask" data-testid="confirm-dialog">
      <div className="cc-dialog" role="dialog" aria-modal="true">
        <div className="cc-dialog-title">{title}</div>
        <div className="cc-dialog-content">{content}</div>
        <div className="cc-dialog-actions">
          <button type="button" className="cc-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="cc-btn cc-btn-primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

