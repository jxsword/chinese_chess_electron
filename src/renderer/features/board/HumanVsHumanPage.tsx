/**
 * 双人对弈页（对应 human_vs_human_page.dart，08 文档 §3.2）。
 *
 * 传入 initialFen（棋谱库"进入对战"）时以该局面开局：轮走方由 FEN 决定，
 * 且不写自动存档（canSave=false，防污染每模式一局的存档桶，08 防错 #6）。
 * 每次进入页面创建独立 store 实例，离开销毁并触发离开保存（铁律 #6 + 07 §2）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from 'zustand'
import { createGameStore } from '@renderer/stores/createGameStore'
import { GameAutoSave } from '@renderer/stores/gameAutoSave'
import { restoreOrNewGame } from '@renderer/stores/gameRestore'
import { recordFromSession, writeShareText } from '@packages/storage-schema'
import { RecordSaveDialog } from '@renderer/features/record/RecordSaveDialog'
import { BoardView } from './BoardView'
import { ConfirmDialog, MoveRecordsList, ResultBanner } from './sidePanel'
import { api } from '@renderer/ipc/client'
import type { GameStore } from '@renderer/stores/createGameStore'

/** 走法记录区（订阅历史变化） */
function MoveRecordsArea({ store }: { store: GameStore }): React.JSX.Element {
  const moveHistory = useStore(store, (s) => s.moveHistory)
  return (
    <div style={{ maxHeight: 260, overflowY: 'auto' }}>
      <MoveRecordsList moves={moveHistory} />
    </div>
  )
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

export function HumanVsHumanPage(): React.JSX.Element {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const initialFen = params.get('fen') ?? undefined

  // 每局一实例：进入页面创建，离开丢弃（铁律 #6）
  const store = useMemo(
    () => createGameStore({ mode: 'humanVsHuman', initialFen }),
    [initialFen]
  )

  const [showMoveRecords, setShowMoveRecords] = useState(false)
  const [savingRecord, setSavingRecord] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [confirmingNewGame, setConfirmingNewGame] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = (message: string): void => {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = setTimeout(() => setToast(null), 2200)
  }

  // 计时器：每秒累计一次；终局后暂停累计（human_vs_human_page.dart:86-99）
  useEffect(() => {
    const timer = setInterval(() => {
      if (store.getState().result !== null) return
      setElapsedSeconds((s) => s + 1)
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [store])

  // 恢复/新局 + 自动保存挂接；路由卸载 cleanup 先 saveOnExit 再注销（07 §2）
  useEffect(() => {
    const vm = store.getState().vm
    const autoSave = new GameAutoSave({
      mode: 'humanVsHuman',
      vm,
      canSave: () => initialFen === undefined,
      repo: api.db
    })
    autoSave.attach()
    if (initialFen !== undefined) {
      vm.newGameFromFen(initialFen)
    } else {
      void restoreOrNewGame({ mode: 'humanVsHuman', vm, repo: api.db })
    }
    return () => {
      autoSave.dispose()
    }
  }, [store, initialFen])

  const newGame = (): void => {
    const vm = store.getState().vm
    if (initialFen !== undefined) {
      vm.newGameFromFen(initialFen)
    } else {
      vm.newGame()
    }
    setElapsedSeconds(0)
  }

  const undoMove = (): void => {
    store.getState().vm.undo() // 双人页悔单手（08 §3.2）
  }

  const saveGame = (): void => {
    // 手动保存同样受 canSave 约束（08 防错 #6；DR-006 ④）
    const vm = store.getState().vm
    if (initialFen !== undefined) {
      showToast('棋谱续战来源不写入对局存档')
      return
    }
    const data = vm.serialize()
    void api.db
      .saveGame({ mode: 'humanVsHuman', fen: data.fen, moves: data.moves })
      .then(() => showToast('棋局已保存'))
      .catch(() => showToast('保存失败：本地存储不可用'))
  }

  const shareGame = (): void => {
    const state = store.getState()
    // 棋谱组装直接用带棋子信息的历史（对齐 record_saver.dart:121-129）
    const record = recordFromSession({
      mode: 'humanVsHuman',
      finalFen: state.fen,
      moves: state.moveHistory,
      result
    })
    let text: string
    try {
      text = writeShareText(record)
    } catch {
      showToast('分享失败：棋谱生成异常')
      return
    }
    api.clipboard
      .write(text)
      .then(() => showToast('棋谱文本已复制到剪贴板'))
      .catch(() => showToast('分享失败：剪贴板不可用'))
  }

  // 页面信息区订阅（BoardView 内部自行订阅棋盘状态）
  const isRedTurn = useStore(store, (s) => s.isRedTurn)
  const isCheck = useStore(store, (s) => s.isCheck)
  const result = useStore(store, (s) => s.result)
  const moveCount = useStore(store, (s) => s.moveHistory.length)

  return (
    <div className="cc-game-page">
      <header className="cc-game-header">
        <button type="button" className="cc-btn" onClick={() => navigate(-1)} aria-label="返回">
          返回
        </button>
        <h2>{initialFen === undefined ? '双人对弈' : '双人对弈（棋谱续战）'}</h2>
        <button type="button" className="cc-btn" onClick={() => setConfirmingNewGame(true)}>
          新游戏
        </button>
        <button type="button" className="cc-btn" onClick={() => setSavingRecord(true)}>
          保存为棋谱
        </button>
        <button type="button" className="cc-btn" onClick={undoMove}>
          悔棋
        </button>
        <button type="button" className="cc-btn" onClick={saveGame}>
          保存棋局
        </button>
        <button type="button" className="cc-btn" onClick={shareGame}>
          分享棋局
        </button>
      </header>
      <div className="cc-game-body">
        <div className="cc-board-area">
          <BoardView store={store} />
        </div>
        <div className="cc-panel-area">
          <div className="cc-card cc-game-info">
            <ResultBanner result={result} />
            <div className="cc-section-title">游戏信息</div>
            <div>
              当前回合:{' '}
              <span className={isRedTurn ? 'cc-turn-label-red' : 'cc-turn-label-black'}>
                {isRedTurn ? '红方' : '黑方'}
              </span>
              {isCheck && result === null && (
                <span className="cc-check-mark" style={{ marginLeft: 12 }}>
                  将军！
                </span>
              )}
            </div>
            <div>步数: {moveCount}</div>
            <div>用时: {formatTime(elapsedSeconds)}</div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <input
                type="checkbox"
                checked={showMoveRecords}
                onChange={(e) => setShowMoveRecords(e.target.checked)}
              />
              显示走法记录
            </label>
            {showMoveRecords && <MoveRecordsArea store={store} />}
          </div>
        </div>
      </div>

      {confirmingNewGame && (
        <ConfirmDialog
          title="开始新游戏"
          content="当前棋局将被清空，确定要开始新游戏吗？"
          onCancel={() => setConfirmingNewGame(false)}
          onConfirm={() => {
            setConfirmingNewGame(false)
            newGame()
          }}
        />
      )}
      {savingRecord && (
        <RecordSaveDialog store={store} mode="humanVsHuman" onClose={() => setSavingRecord(false)} />
      )}
      {toast !== null && <div className="cc-snackbar">{toast}</div>}
    </div>
  )
}
