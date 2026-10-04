/**
 * 语料残局/棋局详情重放视图（06 文档 §4.5 + §7 的查看部分）。
 *
 * M5 范围：局面逐步重放（首/上/下/末、中文记谱芯片跳转）+ 基础播放/暂停；
 * 完整演示播放器（速度档位/循环/状态机）在 M6（T6.5）。
 * XQF 条目与 PGN 大文件单局解析结果共用本视图。
 */
import { useEffect, useMemo, useState } from 'react'
import { Board, type Move } from '@packages/rules'
import { parseIccs } from '@packages/parsers/iccs'
import { difficultyText } from '@packages/parsers'
import { chineseNotations } from '@packages/storage-schema'
import { BoardViewStatic } from '@renderer/features/board/BoardViewStatic'
import type { ParsedPuzzleView } from '@renderer/stores/corpusTypes'

/** 重放第 n 着后的局面 FEN（board_view_replay.dart:106-115 同语义）。 */
function replayFen(initialFen: string, moves: Move[], n: number): string {
  const board = Board.fromFen(initialFen)
  for (let i = 0; i < n && i < moves.length; i++) {
    if (board.pieceAtP(moves[i].from) === null) break
    board.applyMove({ from: moves[i].from, to: moves[i].to })
  }
  return board.toFen()
}

/** 基础播放间隔（06 §7 默认节奏的简化档，完整速度控制在 M6）。 */
const PLAY_INTERVAL_MS = 900

export function PuzzleDetailView({
  puzzle,
  onBack
}: {
  puzzle: ParsedPuzzleView
  onBack: () => void
}): React.JSX.Element {
  const [pos, setPos] = useState(0)
  const [playing, setPlaying] = useState(false)

  const moves = useMemo(
    () =>
      puzzle.solutionMoves.flatMap((code) => {
        const parsed = parseIccs(code)
        return parsed === null ? [] : [{ from: parsed.from, to: parsed.to }]
      }),
    [puzzle]
  )
  const notations = useMemo(() => chineseNotations(puzzle.initialFen, moves), [puzzle, moves])

  const clamped = Math.min(Math.max(pos, 0), moves.length)
  const lastMove = clamped === 0 ? null : moves[clamped - 1]
  const fen = useMemo(() => replayFen(puzzle.initialFen, moves, clamped), [puzzle, moves, clamped])

  // 播放：到末尾自动停；手动跳转即暂停。
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      setPos((p) => {
        const next = Math.min(p + 1, moves.length)
        if (next >= moves.length) setPlaying(false)
        return next
      })
    }, PLAY_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [playing, moves.length])

  const jump = (n: number): void => {
    setPlaying(false)
    setPos(Math.min(Math.max(n, 0), moves.length))
  }

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button type="button" className="cc-btn" onClick={onBack}>
          返回列表
        </button>
        <strong>{puzzle.title ?? '未命名'}</strong>
        <span style={{ fontSize: 12, color: 'var(--cc-seed-dark)' }}>
          {puzzle.source} · {puzzle.moveCount} 着 · 难度 {difficultyText(puzzle.difficulty)} ·{' '}
          {puzzle.endgame ? '残局题' : '全局对局'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ width: 380, maxWidth: '50%', flexShrink: 0 }}>
          <div style={{ height: 420 }}>
            <BoardViewStatic fen={fen} lastMove={lastMove} />
          </div>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 8
            }}
          >
            <button
              type="button"
              className="cc-btn"
              data-testid="puzzle-play"
              onClick={() => {
                if (playing) {
                  setPlaying(false)
                  return
                }
                if (clamped >= moves.length) setPos(0) // 到末尾：从头播放
                setPlaying(true)
              }}
            >
              {playing ? '暂停' : '播放'}
            </button>
            <button
              type="button"
              className="cc-btn"
              aria-label="跳到开局"
              disabled={clamped === 0}
              onClick={() => jump(0)}
            >
              ⇤
            </button>
            <button type="button" className="cc-btn" aria-label="上一着" disabled={clamped === 0} onClick={() => jump(clamped - 1)}>
              ◀
            </button>
            <span data-testid="puzzle-position">
              {clamped} / {moves.length} 着
            </span>
            <button
              type="button"
              className="cc-btn"
              aria-label="下一着"
              disabled={clamped >= moves.length}
              onClick={() => jump(clamped + 1)}
            >
              ▶
            </button>
            <button
              type="button"
              className="cc-btn"
              aria-label="跳到末尾"
              disabled={clamped >= moves.length}
              onClick={() => jump(moves.length)}
            >
              ⇥
            </button>
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
            {notations.map((text, i) => (
              <button
                key={`${i}-${text}`}
                type="button"
                className="cc-btn"
                style={{ fontSize: 12, padding: '2px 8px', opacity: i < clamped ? 1 : 0.55 }}
                onClick={() => jump(i + 1)}
              >
                {`${Math.floor(i / 2) + 1}.${i % 2 === 1 ? '..' : ''} ${text}`}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
