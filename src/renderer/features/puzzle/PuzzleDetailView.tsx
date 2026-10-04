/**
 * 语料残局/棋局详情重放视图（06 文档 §4.5 + §7 的查看部分）。
 *
 * M6 完整演示播放器：播放/暂停/停止状态机（idle→playing→paused→completed）、
 * 速度档位 0.5x/1x/2x + 自定义间隔滑块 200–4000ms、循环播放；步进与
 * 中文记谱芯片跳转保留（跳转即停止播放回到手动浏览）。
 * XQF 条目与 PGN 大文件单局解析结果共用本视图。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Board, type Move } from '@packages/rules'
import { parseIccs } from '@packages/parsers'
import { difficultyText } from '@packages/parsers'
import { chineseNotations } from '@packages/storage-schema'
import {
  DEMO_FAST,
  DEMO_INTERVAL_MAX_MS,
  DEMO_INTERVAL_MIN_MS,
  DEMO_NORMAL,
  DEMO_SLOW,
  PuzzleDemoPlayer,
  type PuzzleDemoSnapshot
} from '@renderer/stores/puzzleDemo'
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

const SPEED_OPTIONS: ReadonlyArray<{ multiplier: number; label: string }> = [
  { multiplier: DEMO_SLOW, label: '0.5x' },
  { multiplier: DEMO_NORMAL, label: '1x' },
  { multiplier: DEMO_FAST, label: '2x' }
]

export function PuzzleDetailView({
  puzzle,
  onBack
}: {
  puzzle: ParsedPuzzleView
  onBack: () => void
}): React.JSX.Element {
  const [pos, setPos] = useState(0)
  const playerRef = useRef<PuzzleDemoPlayer | null>(null)
  const [demo, setDemo] = useState<PuzzleDemoSnapshot | null>(null)

  const moves = useMemo(
    () =>
      puzzle.solutionMoves.flatMap((code) => {
        const parsed = parseIccs(code)
        return parsed === null ? [] : [{ from: parsed.from, to: parsed.to }]
      }),
    [puzzle]
  )
  const notations = useMemo(() => chineseNotations(puzzle.initialFen, moves), [puzzle, moves])

  // 演示播放器：每残局一实例，初始化局面并订阅快照。
  useEffect(() => {
    const player = new PuzzleDemoPlayer()
    playerRef.current = player
    const unsubscribe = player.subscribe(setDemo)
    player.initializePuzzle({ initialFen: puzzle.initialFen, moves: puzzle.solutionMoves })
    setDemo(player.snapshot)
    return () => {
      unsubscribe()
      player.dispose()
      playerRef.current = null
    }
  }, [puzzle])

  // 播放中由播放器驱动显示位置；空闲（手动浏览）用本地 pos。
  const demoActive = demo !== null && demo.status !== 'idle' && demo.status !== 'error'
  const clamped = demoActive
    ? Math.min(demo!.currentMoveIndex + 1, moves.length)
    : Math.min(Math.max(pos, 0), moves.length)
  const lastMove =
    demoActive && demo !== null ? demo.lastMove : clamped === 0 ? null : moves[clamped - 1]
  const fen =
    demoActive && demo !== null && demo.fen !== null
      ? demo.fen
      : replayFen(puzzle.initialFen, moves, clamped)
  const status = demo?.status ?? 'idle'

  const jump = (n: number): void => {
    playerRef.current?.stopDemo()
    setPos(Math.min(Math.max(n, 0), moves.length))
  }

  const togglePlay = (): void => {
    const player = playerRef.current
    if (player === null) return
    if (status === 'playing') {
      player.pauseDemo()
    } else if (status === 'paused') {
      player.resumeDemo()
    } else {
      // idle / completed：从头播放（completed 先重置棋盘）。
      player.stopDemo()
      player.startDemo()
    }
  }

  const demoInterval = demo?.params.moveInterval ?? 800

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <button type="button" className="cc-btn" onClick={onBack}>
          返回列表
        </button>
        <strong>{puzzle.title ?? '未命名'}</strong>
        <span style={{ fontSize: 12, color: 'var(--cc-seed-dark)' }}>
          {puzzle.source} · {puzzle.moveCount} 着 · 难度 {difficultyText(puzzle.difficulty)} ·{' '}
          {puzzle.endgame ? '残局题' : '全局对局'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ width: 380, maxWidth: '100%', flexShrink: 0 }}>
          <div style={{ height: 420 }}>
            <BoardViewStatic fen={fen} lastMove={lastMove} />
          </div>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 8,
              flexWrap: 'wrap'
            }}
          >
            <button type="button" className="cc-btn" data-testid="puzzle-play" onClick={togglePlay}>
              {status === 'playing' ? '暂停' : status === 'paused' ? '继续' : '播放'}
            </button>
            <button
              type="button"
              className="cc-btn"
              data-testid="puzzle-stop"
              onClick={() => playerRef.current?.stopDemo()}
            >
              停止
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
            <button
              type="button"
              className="cc-btn"
              aria-label="上一着"
              disabled={clamped === 0}
              onClick={() => jump(clamped - 1)}
            >
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
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 8,
              flexWrap: 'wrap',
              fontSize: 12
            }}
          >
            <span>速度:</span>
            {SPEED_OPTIONS.map((o) => {
              const active = demo?.params.speedMultiplier === o.multiplier
              return (
                <button
                  key={o.label}
                  type="button"
                  className="cc-btn"
                  data-testid={`puzzle-speed-${o.multiplier}`}
                  style={{ fontWeight: active ? 700 : 400, borderColor: active ? 'var(--cc-seed-dark)' : undefined }}
                  onClick={() => playerRef.current?.setSpeedMultiplier(o.multiplier)}
                >
                  {o.label}
                </button>
              )
            })}
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              自定义
              <input
                type="range"
                data-testid="puzzle-interval"
                min={DEMO_INTERVAL_MIN_MS}
                max={DEMO_INTERVAL_MAX_MS}
                step={100}
                value={demoInterval}
                onChange={(e) => playerRef.current?.setCustomInterval(Number(e.target.value))}
              />
              <span data-testid="puzzle-interval-value">{demoInterval}ms/步</span>
            </label>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="checkbox"
                data-testid="puzzle-loop"
                checked={demo?.params.loop ?? false}
                onChange={(e) => playerRef.current?.setDemoLoop(e.target.checked)}
              />
              循环
            </label>
            {(status === 'completed' || status === 'error') && (
              <span style={{ color: 'var(--cc-seed-dark)' }} role="status">
                {status === 'completed' ? '演示完毕' : (demo?.error ?? '演示出错')}
              </span>
            )}
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
