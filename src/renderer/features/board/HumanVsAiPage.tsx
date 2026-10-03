/**
 * 人机对战页（对应 human_vs_ai_page.dart，08 文档 §3.1）。
 *
 * - 难度下拉（初级~大师）、执方切换（执红默认/执黑——AI 先行）；
 * - 状态栏四态：对局结束 / AI 思考中（spinner）/ 被将军 / 等待玩家；
 * - AI 调度对齐 _triggerAiMove：gameSeq 作废在途应手（等价 _gameSeq）、
 *   思考前 lockInput、响应后无论作废与否一律 unlockInput（防锁泄漏，P0-1）；
 * - 触发时机：玩家走子完成（BoardView onMoved，仅历史增长才触发，防错 #1）
 *   与开局即轮 AI（执黑/黑先残局）；
 * - 残局来源（initialFen）：新游戏回到始盘、不写存档（防错 #6）、
 *   胜负弹通关/惜败对话框（防重入，防错 #10）。
 * 每次进入页面创建独立 store 实例，离开销毁（铁律 #6）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from 'zustand'
import { opponentOf, type Side } from '@packages/rules'
import type { MoveSource, MoveSourceResult } from '@packages/engine'
import { createGameStore } from '@renderer/stores/createGameStore'
import { GameAutoSave } from '@renderer/stores/gameAutoSave'
import { restoreOrNewGame } from '@renderer/stores/gameRestore'
import { ChessAiPlayer, difficultyName } from '@renderer/players/chessAiPlayer'
import { EngineClient } from '@renderer/workers/engineClient'
import { BoardView } from './BoardView'
import { ConfirmDialog, ResultBanner } from './sidePanel'
import { api } from '@renderer/ipc/client'

const DIFFICULTY_LEVELS = [1, 2, 3, 4, 5] as const

const sideName = (side: Side): string => (side === 'red' ? '红' : '黑')

export function HumanVsAiPage(): React.JSX.Element {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const initialFen = params.get('fen') ?? undefined
  const initialSide: Side = params.get('side') === 'black' ? 'black' : 'red'

  const [playerSide, setPlayerSide] = useState<Side>(initialSide)
  const [difficulty, setDifficulty] = useState(3)
  const [isAiThinking, setAiThinking] = useState(false)
  const [confirmingNewGame, setConfirmingNewGame] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // 每局一实例：进入页面创建，离开丢弃（铁律 #6）
  const store = useMemo(
    () => createGameStore({ mode: 'humanVsAi', initialFen, playerSide: initialSide }),
    // initialSide 仅在挂载时取值；执方切换经 switchSide 内部重开新局。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialFen]
  )

  // AI 思考代数（等价 Dart _gameSeq）：新局/悔棋/卸载时自增作废在途应手
  const gameSeqRef = useRef(0)
  const clientRef = useRef<EngineClient | null>(null)
  const playerRef = useRef<ChessAiPlayer | null>(null)
  /** 残局胜负对话框防重入（防错 #10） */
  const resultDialogShownRef = useRef(false)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((message: string): void => {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = setTimeout(() => setToast(null), 2200)
  }, [])

  // 引擎客户端（每页一实例；卸载作废在途请求并释放 worker）
  useEffect(() => {
    const client = new EngineClient()
    clientRef.current = client
    return () => {
      gameSeqRef.current++
      client.dispose()
      clientRef.current = null
      playerRef.current = null
    }
  }, [])

  // 难度变更即时生效（下一次思考使用新档位）
  useEffect(() => {
    const client = clientRef.current
    if (client !== null) playerRef.current = new ChessAiPlayer(client, difficulty)
  }, [difficulty])

  /**
   * 触发 AI 应手（human_vs_ai_page.dart:_triggerAiMove 的等价移植）：
   * lockInput → 搜索 → 响应后无条件解锁；seq 不匹配（新局/悔棋/离开）则丢弃。
   * side 为 AI 执方（切换执方的过渡帧内可能与 state 不同步，故显式传入）。
   */
  const triggerAiMove = useCallback(
    (side: Side): void => {
      const client = clientRef.current
      const player = playerRef.current
      if (client === null || player === null) return
      const vm = store.getState().vm
      if (vm.isFinished) return
      const seq = ++gameSeqRef.current
      const boardSnapshot = vm.board
      vm.lockInput()
      setAiThinking(true)

      void player.nextMove(boardSnapshot).then(
        (result: MoveSourceResult): void => {
          setAiThinking(false)
          vm.unlockInput() // 无论作废与否一律解锁（防全局输入锁泄漏，P0-1）
          if (seq !== gameSeqRef.current) return // 对局已重开/悔棋/离开页面：丢弃
          if (result.status === 'ok' && result.move !== undefined) {
            // playMove 最终校验（铁律 #3）；拒绝仅防御性记录，不 crash
            if (!vm.playMove(result.move.from, result.move.to)) showToast('AI 应手被拒绝')
            return
          }
          if (result.status === 'failed') {
            // 引擎失败防软死锁：显式判 AI 负（08 防错 #7）
            showToast(result.note ?? '引擎计算失败')
            vm.resign(side)
          }
          // noLegalMove：将死/困毙由棋盘状态呈现胜负
        },
        () => {
          // canceled（对局重开/悔棋/离开）：无条件解锁（P0-1）
          setAiThinking(false)
          vm.unlockInput()
        }
      )
    },
    [store, showToast]
  )

  const newGame = useCallback((): void => {
    gameSeqRef.current++ // 作废在途应手（_gameSeq++）
    resultDialogShownRef.current = false
    const vm = store.getState().vm
    if (initialFen !== undefined) {
      vm.newGameFromFen(initialFen) // 残局：重开回始盘（Dart 等价用例 #2）
    } else {
      vm.newGame()
    }
    setAiThinking(false)
    vm.unlockInput()
    if (vm.current.result === null && vm.isRedTurn !== (playerSide === 'red')) {
      triggerAiMove(opponentOf(playerSide)) // 执黑/黑先残局：AI 先行
    }
  }, [store, initialFen, playerSide, triggerAiMove])

  const switchSide = useCallback(
    (side: Side): void => {
      if (side === playerSide) return
      gameSeqRef.current++ // 作废在途应手
      resultDialogShownRef.current = false
      setPlayerSide(side)
      const vm = store.getState().vm
      if (initialFen !== undefined) {
        vm.newGameFromFen(initialFen)
      } else {
        vm.newGame()
      }
      setAiThinking(false)
      vm.unlockInput()
      if (vm.current.result === null && vm.isRedTurn !== (side === 'red')) {
        triggerAiMove(opponentOf(side)) // AI 先行
      }
    },
    [playerSide, store, initialFen, triggerAiMove]
  )

  const undoRound = useCallback((): void => {
    gameSeqRef.current++ // 作废在途应手（防御性，正常悔棋时 AI 不在思考）
    const vm = store.getState().vm
    vm.undoRound(playerSide)
    // 执黑/黑先残局下整轮悔棋可能回到 AI 先行点：重新触发，防玩家侧死锁。
    if (vm.current.result === null && vm.isRedTurn !== (playerSide === 'red')) {
      triggerAiMove(opponentOf(playerSide))
    }
  }, [store, playerSide, triggerAiMove])

  const saveGame = useCallback((): void => {
    const vm = store.getState().vm
    if (initialFen !== undefined) {
      showToast('残局来源不写入对局存档')
      return
    }
    const data = vm.serialize()
    void api.db
      .saveGame({ mode: 'humanVsAi', fen: data.fen, moves: data.moves })
      .then(() => showToast('棋局已保存'))
      .catch(() => showToast('保存失败：本地存储不可用'))
  }, [store, initialFen, showToast])

  // 页面进入：恢复/新局 + 自动保存挂接；恢复定局后若轮 AI（执黑/黑先残局/
  // 存档保存于 AI 思考前）则 AI 先行——必须等 restore 完成后再触发，
  // 否则 restore 的重置会抹掉已落的 AI 应手（与 Dart initState 顺序一致）。
  useEffect(() => {
    const vm = store.getState().vm
    const autoSave = new GameAutoSave({
      mode: 'humanVsAi',
      vm,
      canSave: () => initialFen === undefined,
      repo: api.db
    })
    autoSave.attach()
    let disposed = false
    void (async () => {
      if (initialFen !== undefined) {
        vm.newGameFromFen(initialFen)
      } else {
        await restoreOrNewGame({ mode: 'humanVsAi', vm, repo: api.db })
      }
      if (disposed) return
      if (vm.current.result === null && vm.isRedTurn !== (initialSide === 'red')) {
        triggerAiMove(opponentOf(initialSide))
      }
    })()
    return () => {
      disposed = true
      autoSave.dispose()
    }
    // 仅在挂载时执行（对齐 Dart initState 语义）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  // 玩家走子完成（BoardView onMoved：仅历史增长才触发，防错 #1）
  const onPlayerMoved = useCallback((): void => {
    const vm = store.getState().vm
    if (vm.current.result !== null) return
    if (vm.isRedTurn === (playerSide === 'red')) return // 仍轮玩家（防御）
    triggerAiMove(opponentOf(playerSide))
  }, [store, playerSide, triggerAiMove])

  // 状态栏四态（human_vs_ai_page.dart:_buildAiStatus）。
  // AI 回合且尚未进入思考态（挂载/恢复瞬态）同样显示思考中，防"等待玩家"闪现。
  const result = useStore(store, (s) => s.result)
  const isCheck = useStore(store, (s) => s.isCheck)
  const isRedTurn = useStore(store, (s) => s.isRedTurn)
  const aiTurnNow = result === null && isRedTurn !== (playerSide === 'red')

  let statusText: string
  let statusClass: string
  if (result !== null) {
    statusText =
      result === 'redWins'
        ? '对局结束：红方获胜'
        : result === 'blackWins'
          ? '对局结束：黑方获胜'
          : '对局结束：和棋'
    statusClass = 'cc-status-end'
  } else if (isAiThinking || aiTurnNow) {
    statusText = 'AI 正在思考...'
    statusClass = 'cc-status-thinking'
  } else if (isCheck) {
    const checkedSide = isRedTurn ? '红' : '黑'
    statusText = `等待玩家（${sideName(playerSide)}方）走棋（${checkedSide}方被将军！）`
    statusClass = 'cc-status-check'
  } else {
    statusText = `等待玩家（${sideName(playerSide)}方）走棋`
    statusClass = 'cc-status-waiting'
  }

  const title = initialFen !== undefined ? `残局人机对战（玩家执${sideName(playerSide)}方）` : '人机对战'

  // 残局胜负对话框（防重入）：胜负已分且尚未弹过
  const playerWon = result !== null && (result === 'redWins') === (playerSide === 'red')
  const showPuzzleDialog =
    initialFen !== undefined && result !== null && !resultDialogShownRef.current
  if (showPuzzleDialog) resultDialogShownRef.current = true

  return (
    <div className="cc-game-page">
      <header className="cc-game-header">
        <button type="button" className="cc-btn" onClick={() => navigate(-1)} aria-label="返回">
          返回
        </button>
        <h2>{title}</h2>
        <select
          aria-label="难度"
          value={difficulty}
          onChange={(e) => setDifficulty(Number(e.target.value))}
        >
          {DIFFICULTY_LEVELS.map((lv) => (
            <option key={lv} value={lv}>
              {difficultyName(lv)}
            </option>
          ))}
        </select>
        <select
          aria-label="执方"
          value={playerSide}
          onChange={(e) => switchSide(e.target.value === 'red' ? 'red' : 'black')}
        >
          <option value="red">执红</option>
          <option value="black">执黑</option>
        </select>
        <button type="button" className="cc-btn" onClick={() => setConfirmingNewGame(true)}>
          新游戏
        </button>
        <button type="button" className="cc-btn" onClick={undoRound}>
          悔棋
        </button>
        {initialFen === undefined && (
          <button type="button" className="cc-btn" onClick={saveGame}>
            保存棋局
          </button>
        )}
      </header>
      <div className={`cc-status-bar ${statusClass}`} role="status">
        <span>{statusText}</span>
        {isAiThinking && <span className="cc-spinner" aria-hidden="true" />}
      </div>
      <div className="cc-game-body">
        <div className="cc-board-area">
          <BoardView store={store} onMoved={onPlayerMoved} />
        </div>
        <div className="cc-panel-area">
          <div className="cc-card cc-game-info">
            <ResultBanner result={result} />
            <div className="cc-section-title">游戏信息</div>
            <div>当前回合：{isRedTurn ? '红方' : '黑方'}</div>
            <div className="cc-section-title">对手</div>
            <div data-testid="ai-display-name">
              {(playerRef.current as MoveSource | null)?.displayName ??
                `内置 AI（${difficultyName(difficulty)}）`}
            </div>
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
      {showPuzzleDialog && (
        <ConfirmDialog
          title={playerWon ? '残局闯关成功！' : '闯关失败'}
          content={
            playerWon
              ? `恭喜你执${sideName(playerSide)}方取得胜利，可再来一局或返回。`
              : '再接再厉，可以重试或换一种攻杀思路。'
          }
          confirmLabel={playerWon ? '再来一局' : '重试'}
          cancelLabel="返回"
          onCancel={() => navigate(-1)}
          onConfirm={() => newGame()}
        />
      )}
      {toast !== null && <div className="cc-snackbar">{toast}</div>}
    </div>
  )
}
