/**
 * 棋谱库列表页（对应 record_library_page.dart，07 文档 §5 E，TC-LIB-001~007）。
 * 列表 + SolveStatus 筛选 + 详情跳转 + 导出 PGN（复制/存文件）+ 分享文本 + 删除确认。
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  solveStatusLabel,
  modeLabelOf,
  decodeRecordMove,
  type GameRecordData
} from '@packages/storage-schema'
import { writePgn } from '@packages/storage-schema/pgnWriter'
import { writeShareText } from '@packages/storage-schema/shareText'
import { battleStartFen } from '@packages/storage-schema/recordBattle'
import { api } from '@renderer/ipc/client'
import type { GameRecord, GameRecordSummary, SolveStatus } from '@shared/ipc/types'
import { ConfirmDialog } from '@renderer/features/board/sidePanel'
import { RecordLauncherDialog } from './RecordLauncherDialog'

/** IPC 行 → 领域形状（moves 坐标转 Move，供起点计算与导出）。 */
export function toRecordData(record: GameRecord): GameRecordData {
  return {
    id: record.id,
    title: record.title,
    mode: record.mode,
    initialFen: record.initialFen,
    moves: record.moves
      .map(decodeRecordMove)
      .filter((m): m is NonNullable<ReturnType<typeof decodeRecordMove>> => m !== null),
    result: record.result,
    solveStatus: record.solveStatus ?? 'none',
    solutions: record.solutions ?? [],
    llmNote: record.llmNote,
    note: record.note,
    createdAt: record.createdAt
  }
}

const STATUS_FILTERS: SolveStatus[] = ['none', 'solved', 'noSolution', 'timeout']

function dateText(createdAt: number): string {
  const d = new Date(createdAt)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function RecordLibraryPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [records, setRecords] = useState<GameRecordSummary[] | null>(null)
  const [filter, setFilter] = useState<SolveStatus | null>(null)
  const [deleting, setDeleting] = useState<GameRecordSummary | null>(null)
  const [launching, setLaunching] = useState<GameRecord | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = useCallback((text: string): void => {
    setToast(text)
    setTimeout(() => setToast(null), 2200)
  }, [])

  const reload = useCallback((): void => {
    api.db
      .recordsList()
      .then(setRecords)
      .catch(() => setRecords([]))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const fullRecord = async (summary: GameRecordSummary): Promise<GameRecord | null> => {
    try {
      return await api.db.recordsGet(summary.id)
    } catch {
      return null
    }
  }

  const actions = async (value: string, summary: GameRecordSummary): Promise<void> => {
    const record = await fullRecord(summary)
    if (record === null) return
    const data = toRecordData(record)
    switch (value) {
      case 'battle': {
        const fen = battleStartFen(data)
        if (fen !== null) setLaunching(record)
        break
      }
      case 'pgn':
        api.clipboard
          .write(writePgn(data))
          .then(() => showToast('PGN 已复制'))
          .catch(() => showToast('复制失败：剪贴板不可用'))
        break
      case 'share':
        api.clipboard
          .write(writeShareText(data))
          .then(() => showToast('棋谱文本已复制'))
          .catch(() => showToast('复制失败：剪贴板不可用'))
        break
      case 'file': {
        const defaultName = `chess-record-${record.id}.pgn`
        try {
          const saved = await api.dialog.saveFile({ defaultName, content: writePgn(data) })
          showToast(saved === null ? '已取消导出' : 'PGN 文件已导出')
        } catch (e) {
          showToast(`导出失败：${e instanceof Error ? e.message : String(e)}`)
        }
        break
      }
      case 'delete':
        setDeleting(summary)
        break
    }
  }

  const filtered =
    filter === null || records === null
      ? records
      : records.filter((r) => (r.solveStatus ?? 'none') === (filter as Exclude<SolveStatus, null>))

  return (
    <div className="cc-game-page">
      <header className="cc-game-header">
        <button type="button" className="cc-btn" onClick={() => navigate(-1)} aria-label="返回">
          返回
        </button>
        <h2>棋谱库</h2>
      </header>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '0 16px 8px' }}>
        {STATUS_FILTERS.map((status) => (
          <button
            key={status}
            type="button"
            className={filter === status ? 'cc-btn cc-btn-primary' : 'cc-btn'}
            onClick={() => setFilter(filter === status ? null : status)}
          >
            {solveStatusLabel(status)}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px' }}>
        {records === null ? (
          <div>加载中…</div>
        ) : filtered !== null && filtered.length === 0 ? (
          <div>暂无棋谱。可在对局中保存，或在残局工作室求解后自动入库。</div>
        ) : (
          (filtered ?? []).map((summary) => {
            const isEndgame = summary.mode === 'endgame'
            return (
              <div key={summary.id} className="cc-card" style={{ padding: '10px 12px', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    style={{ flex: 1, cursor: 'pointer' }}
                    onClick={() => navigate(`/record-library/${summary.id}`)}
                    data-testid={`record-item-${summary.id}`}
                  >
                    <strong>{summary.title}</strong>
                    <div style={{ fontSize: 12, color: 'var(--cc-seed-dark)' }}>
                      {modeLabelOf(summary.mode)} · {dateText(summary.createdAt)} ·{' '}
                      {isEndgame ? '残局' : '对局'}
                      {summary.solveStatus !== null && summary.solveStatus !== 'none'
                        ? ` · ${solveStatusLabel(summary.solveStatus)}`
                        : ''}
                    </div>
                  </div>
                  <select
                    aria-label={`棋谱操作 ${summary.title}`}
                    value=""
                    onChange={(e) => {
                      const v = e.target.value
                      if (v.length > 0) void actions(v, summary)
                    }}
                  >
                    <option value="">操作…</option>
                    {/* 入口判定与 canLaunchBattle 等价：残局类恒有；对局类仅未分胜负时有
                        （summary 无 moves，不必拉全量记录）。 */}
                    {(summary.mode === 'endgame' || summary.result === null) && (
                      <option value="battle">进入对战</option>
                    )}
                    <option value="pgn">导出 PGN（复制）</option>
                    <option value="share">分享文本（复制）</option>
                    <option value="file">导出 PGN 文件</option>
                    <option value="delete">删除</option>
                  </select>
                </div>
              </div>
            )
          })
        )}
      </div>

      {deleting !== null && (
        <ConfirmDialog
          title="删除棋谱"
          content={`确定删除「${deleting.title}」？不可恢复。`}
          confirmLabel="删除"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            void api.db
              .recordsDelete(deleting.id)
              .catch(() => undefined)
              .then(() => {
                setDeleting(null)
                reload()
              })
          }}
        />
      )}
      {launching !== null && (
        <RecordLauncherDialog
          startFen={battleStartFen(toRecordData(launching)) ?? ''}
          onClose={() => {
            setLaunching(null)
          }}
        />
      )}
      {toast !== null && <div className="cc-snackbar">{toast}</div>}
    </div>
  )
}
