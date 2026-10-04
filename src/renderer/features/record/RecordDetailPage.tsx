/**
 * 棋谱详情页（对应 record_detail_page.dart + board_view_replay.dart，TC-DET-001~005）。
 * 主变（对局走法）与各条破解之法均可逐步演示：线路切换独立重放、中文记谱芯片
 * 跳转、无解/超时结论文案、进入对战。
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Board, type Move } from '@packages/rules'
import { parseIccs } from '@packages/parsers/iccs'
import {
  chineseNotations,
  decodeRecordMove,
  fillMovePieces,
  hasUniqueSolution,
  modeLabelOf,
  resultLabel,
  solveStatusLabel,
  type GameRecordData
} from '@packages/storage-schema'
import { writePgn, solveVerdictLines } from '@packages/storage-schema/pgnWriter'
import { writeShareText } from '@packages/storage-schema/shareText'
import { canLaunchBattle, battleStartFen } from '@packages/storage-schema/recordBattle'
import { api } from '@renderer/ipc/client'
import type { GameRecord } from '@shared/ipc/types'
import { BoardViewStatic } from '@renderer/features/board/BoardViewStatic'
import { ConfirmDialog } from '@renderer/features/board/sidePanel'
import { RecordLauncherDialog } from './RecordLauncherDialog'
import { toRecordData } from './RecordLibraryPage'

/** IPC 行 → 领域走法（脏数据防御：非法条目跳过）。 */
function recordMoves(record: GameRecord): Move[] {
  return record.moves
    .map(decodeRecordMove)
    .filter((m): m is NonNullable<ReturnType<typeof decodeRecordMove>> => m !== null)
}

/** 解法 ICCS 序列 → 裸走法。 */
function solutionRawMoves(solution: string[]): Move[] {
  return solution.flatMap((code) => {
    const parsed = parseIccs(code)
    return parsed === null ? [] : [{ from: parsed.from, to: parsed.to }]
  })
}

/** 当前线路走法（board_view_replay.dart:92-103）：主变直接用；解法补棋子信息。 */
function lineMoves(record: GameRecord, line: number): Move[] {
  if (line < 0) return recordMoves(record)
  const solution = record.solutions?.[line] ?? []
  return fillMovePieces(record.initialFen, solutionRawMoves(solution))
}

/** 重放第 n 着后的局面 FEN（board_view_replay.dart:106-115）。 */
function replayFen(initialFen: string, moves: Move[], n: number): string {
  const board = Board.fromFen(initialFen)
  for (let i = 0; i < n && i < moves.length; i++) {
    if (board.pieceAtP(moves[i].from) === null) break
    board.applyMove({ from: moves[i].from, to: moves[i].to })
  }
  return board.toFen()
}

/** 线路的中文记谱序列（整线重放补棋子；缺失时退回 ICCS，game_record.dart:200-207）。 */
function lineNotations(record: GameRecord, moves: Move[]): string[] {
  return chineseNotations(record.initialFen, moves)
}

const FEN_STANDARD_INITIAL = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR'

export function RecordDetailPage(): React.JSX.Element {
  const navigate = useNavigate()
  const params = useParams()
  const recordId = Number(params.id)
  const [record, setRecord] = useState<GameRecord | null | 'loading'>('loading')
  const [line, setLine] = useState(-1) // -1 = 主变，>=0 = 解法序号
  const [pos, setPos] = useState(0)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.db
      .recordsGet(recordId)
      .then((r) => {
        if (!cancelled) setRecord(r)
      })
      .catch(() => {
        if (!cancelled) setRecord(null)
      })
    return () => {
      cancelled = true
    }
  }, [recordId])

  const moves = useMemo(() => (record === null || record === 'loading' ? [] : lineMoves(record, line)), [record, line])

  // 残局类（无对局走法、有解法）默认进入第一条解法，便于直接演示（board_view_replay.dart:43-46）。
  useEffect(() => {
    if (record !== null && record !== 'loading' && record.moves.length === 0 && (record.solutions?.length ?? 0) > 0) {
      setLine(0)
    }
  }, [record])

  if (record === 'loading') {
    return (
      <div className="cc-game-page">
        <header className="cc-game-header">
          <button type="button" className="cc-btn" onClick={() => navigate(-1)}>
            返回
          </button>
          <h2>棋谱详情</h2>
        </header>
        <div>加载中…</div>
      </div>
    )
  }
  if (record === null) {
    return (
      <div className="cc-game-page">
        <header className="cc-game-header">
          <button type="button" className="cc-btn" onClick={() => navigate(-1)}>
            返回
          </button>
          <h2>棋谱详情</h2>
        </header>
        <div className="cc-placeholder">棋谱不存在或读取失败</div>
      </div>
    )
  }

  const data: GameRecordData = toRecordData(record)
  const solutions = record.solutions ?? []
  const verdictLines = solveVerdictLines(data)
  const clamped = Math.min(Math.max(pos, 0), moves.length)
  const lastMove = clamped === 0 ? null : moves[clamped - 1]
  const fen = replayFen(record.initialFen, moves, clamped)
  const notations = lineNotations(record, moves)
  const startFen = canLaunchBattle(data) ? battleStartFen(data) : null

  return (
    <div className="cc-game-page">
      <header className="cc-game-header">
        <button type="button" className="cc-btn" onClick={() => navigate(-1)}>
          返回
        </button>
        <h2>{record.title}</h2>
        {startFen !== null && (
          <button type="button" className="cc-btn" onClick={() => setLaunching(true)}>
            进入对战
          </button>
        )}
        <button
          type="button"
          className="cc-btn"
          onClick={() => {
            api.clipboard
              .write(writePgn(data))
              .then(() => setToast('PGN 已复制'))
              .catch(() => setToast('复制失败：剪贴板不可用'))
          }}
        >
          导出 PGN（复制）
        </button>
        <button
          type="button"
          className="cc-btn"
          onClick={() => {
            api.clipboard
              .write(writeShareText(data))
              .then(() => setToast('棋谱文本已复制'))
              .catch(() => setToast('复制失败：剪贴板不可用'))
          }}
        >
          分享文本（复制）
        </button>
        <button type="button" className="cc-btn" onClick={() => setConfirmingDelete(true)}>
          删除
        </button>
      </header>
      <div className="cc-game-body">
        <div className="cc-board-area" style={{ maxWidth: 560 }}>
          <div data-testid="board-static-wrapper" style={{ height: '100%' }}>
            <BoardViewStatic fen={fen} lastMove={lastMove} />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', marginTop: 8 }}>
            <button
              type="button"
              className="cc-btn"
              aria-label="跳到开局"
              disabled={clamped === 0}
              onClick={() => setPos(0)}
            >
              ⇤
            </button>
            <button
              type="button"
              className="cc-btn"
              aria-label="上一着"
              disabled={clamped === 0}
              onClick={() => setPos(clamped - 1)}
            >
              ◀
            </button>
            <span data-testid="replay-position">
              {clamped} / {moves.length} 着
            </span>
            <button
              type="button"
              className="cc-btn"
              aria-label="下一着"
              disabled={clamped >= moves.length}
              onClick={() => setPos(clamped + 1)}
            >
              ▶
            </button>
            <button
              type="button"
              className="cc-btn"
              aria-label="跳到末尾"
              disabled={clamped >= moves.length}
              onClick={() => setPos(moves.length)}
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
                onClick={() => setPos(i + 1)}
              >
                {`${Math.floor(i / 2) + 1}.${i % 2 === 1 ? '..' : ''} ${text}`}
              </button>
            ))}
          </div>
        </div>
        <div className="cc-panel-area">
          <div className="cc-card cc-game-info">
            <div className="cc-section-title">棋谱信息</div>
            <div>
              {modeLabelOf(record.mode)} · {solveStatusLabel(record.solveStatus ?? 'none')}
              {solutions.length > 0
                ? `（${solutions.length} 条解法${hasUniqueSolution(record.solveStatus ?? 'none', record.solutions) ? '，唯一' : ''}）`
                : ''}
            </div>
            {record.result !== null && <div>结果: {resultLabel(record.result)}</div>}
            {record.initialFen.split(' ')[0] !== FEN_STANDARD_INITIAL && (
              <div style={{ fontSize: 12, wordBreak: 'break-all' }}>起始 FEN: {record.initialFen}</div>
            )}
            {record.note !== null && record.note.length > 0 && <div>备注: {record.note}</div>}
            {record.llmNote !== null && record.llmNote.length > 0 && <div>大模型注释: {record.llmNote}</div>}
            <div style={{ marginTop: 12 }}>
              <label>
                线路:{' '}
                <select
                  value={line}
                  onChange={(e) => {
                    setLine(Number(e.target.value))
                    setPos(0)
                  }}
                >
                  <option value={-1}>
                    {record.moves.length === 0 ? '主变（无着法）' : `主变（${record.moves.length} 着）`}
                  </option>
                  {solutions.map((s, i) => (
                    <option key={i} value={i}>
                      解法 {i + 1}（{s.length} 着）
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {verdictLines.length > 0 && (
              <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }} data-testid="solve-verdicts">
                {verdictLines.join('\n')}
              </div>
            )}
          </div>
        </div>
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title="删除棋谱"
          content={`确定删除「${record.title}」？不可恢复。`}
          confirmLabel="删除"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            void api.db
              .recordsDelete(record.id)
              .catch(() => undefined)
              .then(() => navigate('/record-library'))
          }}
        />
      )}
      {launching && <RecordLauncherDialog startFen={startFen ?? ''} onClose={() => setLaunching(false)} />}
      {toast !== null && <div className="cc-snackbar">{toast}</div>}
    </div>
  )
}
