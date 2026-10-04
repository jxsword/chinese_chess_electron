/**
 * "保存为棋谱"对话框（对应 record_saver.dart saveCurrentGame，07 文档 §5）。
 * 所有对战模式页面共用：标题/备注输入 → recordFromSession 落库。
 * 与自动存档（saved_games，每模式一局）互不影响，棋谱库保留全部历史。
 */
import { useState } from 'react'
import { recordFromSession, encodeRecordMove, type GameRecordData } from '@packages/storage-schema'
import { api } from '@renderer/ipc/client'
import type { GameMode, GameRecord, GameResult } from '@shared/ipc/types'
import type { GameStore } from '@renderer/stores/createGameStore'

/** GameRecordData（领域形状）→ IPC 契约面（moves_json 条目 p/x 规范化为 string|null）。 */
export function recordDataToApiRecord(record: GameRecordData): Omit<GameRecord, 'id'> {
  return {
    title: record.title,
    mode: record.mode as GameMode,
    initialFen: record.initialFen,
    moves: record.moves.map((m) => {
      const raw = encodeRecordMove(m)
      return { f: raw.f, t: raw.t, p: raw.p ?? '', x: raw.x }
    }),
    result: record.result,
    solveStatus: record.solveStatus,
    solutions: record.solutions,
    llmNote: record.llmNote ?? null,
    note: record.note ?? null,
    createdAt: record.createdAt ?? Date.now()
  }
}

export interface RecordSaveDialogProps {
  store: GameStore
  mode: GameMode
  /** 大模型对战页传入模型名等署名信息（record_saver.dart:21-27） */
  redName?: string | null
  blackName?: string | null
  onClose: () => void
}

export function RecordSaveDialog({
  store,
  mode,
  redName,
  blackName,
  onClose
}: RecordSaveDialogProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = (): void => {
    const state = store.getState()
    const result: GameResult | null = state.result
    const record = recordFromSession({
      title: title.trim().length > 0 ? title.trim() : null,
      mode,
      finalFen: state.fen,
      moves: state.moveHistory,
      result,
      redName: redName ?? null,
      blackName: blackName ?? null,
      note: note.trim().length > 0 ? note.trim() : null
    })
    setSaving(true)
    api.db
      .recordsSave(recordDataToApiRecord(record))
      .then(() => {
        onClose()
      })
      .catch(() => {
        setMessage('保存失败：本地存储不可用')
        setSaving(false)
      })
  }

  const moveCount = store.getState().moveHistory.length

  return (
    <div className="cc-dialog-mask" data-testid="record-save-dialog">
      <div className="cc-dialog" role="dialog" aria-modal="true">
        <div className="cc-dialog-title">保存为棋谱</div>
        <div className="cc-dialog-content">
          <label style={{ display: 'block', marginBottom: 12 }}>
            <div>棋谱标题（留空自动生成）</div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ width: '100%' }}
              data-testid="record-title-input"
            />
          </label>
          <label style={{ display: 'block' }}>
            <div>备注（可选）</div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              style={{ width: '100%' }}
              data-testid="record-note-input"
            />
          </label>
          {message !== null && <div style={{ color: 'var(--cc-error)', marginTop: 8 }}>{message}</div>}
        </div>
        <div className="cc-dialog-actions">
          <button type="button" className="cc-btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="cc-btn cc-btn-primary" onClick={save} disabled={saving}>
            保存（共 {moveCount} 着）
          </button>
        </div>
      </div>
    </div>
  )
}
