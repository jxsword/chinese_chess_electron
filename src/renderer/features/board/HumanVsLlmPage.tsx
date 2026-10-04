/**
 * 人机对战（大模型）页（对应 human_vs_llm_page.dart，08 文档 §3.3）。
 *
 * - 玩家执红，黑方 LLM（HybridLlmPlayer：off/candidate/gate 三模式）；
 * - LlmConfigCard（黑方）+ 对局设置区（800ms 防抖保存，卸载时兜底回写）；
 * - 状态栏：对局结束 / 黑方模型思考中 / 模型思路·参谋评分·否决说明 / 将军 / 等待玩家；
 * - 调度对齐 _triggerLlmMove：gameSeq 作废在途应手 + cancelCurrent；
 *   失败（resign 策略）显式判负防软死锁（08 防错 #7）；
 * - 配置未加载完成不回写（防错 #4）；残局来源不写模式存档（防错 #6）。
 * 每次进入页面创建独立 store 实例，离开销毁（铁律 #6）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from 'zustand'
import type { MoveSourceResult } from '@packages/engine'
import type { AdvisorMode, LlmFallback, LlmGameSettings, SideEngineType } from '@packages/llm'
import { HybridLlmPlayer } from '@packages/llm'
import type { LlmEndpointConfig } from '@shared/ipc/types'
import { createGameStore } from '@renderer/stores/createGameStore'
import { GameAutoSave } from '@renderer/stores/gameAutoSave'
import { restoreOrNewGame } from '@renderer/stores/gameRestore'
import { loadLlmSettings, saveLlmSettings } from '@renderer/stores/llmSettings'
import { EngineClient } from '@renderer/workers/engineClient'
import { ChessAiPlayer } from '@renderer/players/chessAiPlayer'
import { createIpcLlmTransport } from '@renderer/llm/llmTransport'
import { formatThinkingSuffix, useThinkingElapsed, type AttemptProgress } from '@renderer/llm/useThinkingStatus'
import { LlmConfigCard } from '@renderer/features/settings/LlmConfigCard'
import { BoardView } from './BoardView'
import { ConfirmDialog, ResultBanner } from './sidePanel'
import { api } from '@renderer/ipc/client'

const BLACK_SLOT = 'llm_config_black'

const TIMEOUT_OPTIONS: Record<number, string> = {
  30: '30 秒',
  60: '60 秒',
  120: '120 秒',
  180: '180 秒',
  300: '300 秒'
}
const ATTEMPT_OPTIONS: Record<number, string> = { 1: '1 次', 3: '3 次', 5: '5 次' }
const FALLBACK_NAMES: Record<LlmFallback, string> = { builtinAi: '内置 AI 代走', resign: '该方判负' }
const ADVISOR_NAMES: Record<AdvisorMode, string> = {
  off: '关闭（纯大模型）',
  candidate: '候选模式（引擎出名单）',
  gate: '护航模式（引擎否决）'
}
const BLEND_OPTIONS: Record<number, string> = {
  0: '0（最严/最稳）',
  25: '25',
  50: '50（均衡）',
  75: '75',
  100: '100（最自由）'
}
const DIFFICULTY_OPTIONS: Record<number, string> = { 1: '快（2 层）', 3: '中（4 层）', 5: '强（6 层）' }
const OPPONENT_TYPE_NAMES: Record<SideEngineType, string> = {
  llm: '大模型',
  builtin: '内置 AI'
}

interface PageSettings {
  timeoutSeconds: number
  maxAttempts: number
  fallback: LlmFallback
  advisorMode: AdvisorMode
  strengthBlend: number
  advisorDifficulty: number
  opponentType: SideEngineType
}

/** 红方槽位（跨页镜像来源，DR-014：黑方未配置时使用红方配置） */
const RED_SLOT = 'llm_config_red'

const DEFAULT_CONFIG: LlmEndpointConfig = { baseUrl: '', apiKey: '', model: '', disableThinking: true }

export function HumanVsLlmPage(): React.JSX.Element {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const initialFen = params.get('fen') ?? undefined

  const [config, setConfig] = useState<LlmEndpointConfig | null>(null)
  const [settings, setSettings] = useState<PageSettings | null>(null)
  const [isLlmThinking, setLlmThinking] = useState(false)
  const [attempt, setAttempt] = useState<AttemptProgress | null>(null)
  const [llmNote, setLlmNote] = useState('')
  const [confirmingNewGame, setConfirmingNewGame] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // 每局一实例（铁律 #6）
  const store = useMemo(
    () => createGameStore({ mode: 'humanVsLlm', initialFen, playerSide: 'red' }),
    [initialFen]
  )

  const gameSeqRef = useRef(0)
  const clientRef = useRef<EngineClient | null>(null)
  const transportRef = useRef<ReturnType<typeof createIpcLlmTransport> | null>(null)
  const playerRef = useRef<HybridLlmPlayer | null>(null)
  /** 思考中镜像（ref：maybeTrigger 的同步判断用，state 有渲染时差） */
  const thinkingRef = useRef(false)
  /** 最近一次从存储加载的完整设置（回写 copyWith 基底，防清空共享字段）。 */
  const lastLoadedRef = useRef<LlmGameSettings | null>(null)
  /** 当前配置是跨页镜像（黑方槽位为空、借用红方配置）：镜像时禁用本页回写黑槽（DR-014）。 */
  const mirroredRef = useRef(false)
  const configRef = useRef(config)
  const settingsRef = useRef(settings)
  const triggerRef = useRef<(() => void) | null>(null)
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  configRef.current = config
  settingsRef.current = settings

  const elapsed = useThinkingElapsed(isLlmThinking)

  const showToast = useCallback((message: string): void => {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = setTimeout(() => setToast(null), 2200)
  }, [])

  /** 配置 + 本页设置字段落盘（防抖与卸载兜底共用）。 */
  const persist = useCallback((): void => {
    const cfg = configRef.current
    const st = settingsRef.current
    const base = lastLoadedRef.current
    if (cfg === null || st === null || base === null) return
    // 镜像状态下的编辑属于"红方配置的本地视图"，不回写黑方槽位（DR-014）。
    if (!mirroredRef.current) void api.secure.set(BLACK_SLOT, cfg).catch(() => {})
    // copyWith 只覆盖本页字段（intervalSeconds/红黑强度归 llm_vs_llm 页，防错 #4）。
    void saveLlmSettings({ ...base, timeoutSeconds: st.timeoutSeconds, maxAttempts: st.maxAttempts, fallback: st.fallback, advisorMode: st.advisorMode, strengthBlend: st.strengthBlend, advisorDifficulty: st.advisorDifficulty }).catch(() => {})
  }, [])

  const scheduleAutosave = useCallback((): void => {
    if (autosaveTimerRef.current !== null) clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = setTimeout(persist, 800)
  }, [persist])

  // 引擎客户端 + IPC 传输（每页一实例；卸载作废在途请求并兜底回写配置）
  useEffect(() => {
    clientRef.current = new EngineClient()
    transportRef.current = createIpcLlmTransport()
    return () => {
      gameSeqRef.current++
      void playerRef.current?.cancelCurrent()
      if (autosaveTimerRef.current !== null) clearTimeout(autosaveTimerRef.current)
      persist()
      clientRef.current?.dispose()
      clientRef.current = null
    }
  }, [persist])

  // 配置/设置加载（未加载完成不回写，防错 #4）
  useEffect(() => {
    let disposed = false
    void (async () => {
      let loaded: LlmEndpointConfig | null
      try {
        loaded = await api.secure.get(BLACK_SLOT)
      } catch {
        loaded = null
      }
      // DR-014：黑方未配置时跨页镜像红方配置（与大模型对战页共享红方槽位）。
      let redLoaded: LlmEndpointConfig | null
      try {
        redLoaded = await api.secure.get(RED_SLOT)
      } catch {
        redLoaded = null
      }
      const gameSettings = await loadLlmSettings()
      if (disposed) return
      const blackEmpty =
        loaded === null ||
        (loaded.baseUrl.trim() === '' && loaded.apiKey.trim() === '' && loaded.model.trim() === '')
      const nextConfig = blackEmpty && redLoaded !== null ? redLoaded : (loaded ?? { ...DEFAULT_CONFIG })
      const nextSettings: PageSettings = {
        timeoutSeconds: gameSettings.timeoutSeconds,
        maxAttempts: gameSettings.maxAttempts,
        fallback: gameSettings.fallback,
        advisorMode: gameSettings.advisorMode,
        strengthBlend: gameSettings.strengthBlend,
        advisorDifficulty: gameSettings.advisorDifficulty,
        opponentType: gameSettings.humanVsLlmOpponentType
      }
      // ref 先于 state 同步：maybeTrigger 在下次渲染前就要读到就绪值。
      configRef.current = nextConfig
      settingsRef.current = nextSettings
      lastLoadedRef.current = gameSettings
      mirroredRef.current = blackEmpty && redLoaded !== null
      setConfig(nextConfig)
      setSettings(nextSettings)
      maybeTriggerRef.current?.() // 配置就绪：黑先残局/恢复轮黑时模型先行
    })()
    return () => {
      disposed = true
    }
  }, [])

  /** 触发黑方模型应手（human_vs_llm_page.dart:_triggerLlmMove）。 */
  const triggerLlmMove = useCallback((): void => {
    const client = clientRef.current
    const transport = transportRef.current
    const cfg = configRef.current
    const st = settingsRef.current
    if (client === null || transport === null || cfg === null || st === null) return
    const vm = store.getState().vm
    if (vm.isFinished) return
    const seq = ++gameSeqRef.current
    // await 前快照棋盘与历史。
    const boardSnapshot = vm.board.copy()
    const history = [...vm.current.moveHistory]
    vm.lockInput()
    thinkingRef.current = true
    setLlmThinking(true)
    setAttempt(null)
    setLlmNote('')

    // DR-014：对手引擎类型可直接选内置 AI（大模型失败兜底之外的独立选项）。
    if (st.opponentType === 'builtin') {
      const builtin = new ChessAiPlayer(client, 3)
      void builtin.nextMove(boardSnapshot, history).then(
        (result: MoveSourceResult): void => {
          thinkingRef.current = false
          setLlmThinking(false)
          vm.unlockInput()
          if (seq !== gameSeqRef.current) return
          if (result.status === 'ok' && result.move !== undefined) {
            if (!vm.playMove(result.move.from, result.move.to)) setLlmNote('黑方着法未通过校验，被拒绝')
            return
          }
          if (result.status === 'failed') {
            vm.resign('black')
            setLlmNote(`黑方走子失败：${result.note ?? '未知原因'}，判红方胜`)
          }
          // noLegalMove：胜负由棋盘状态呈现
        },
        () => {
          thinkingRef.current = false
          setLlmThinking(false)
          vm.unlockInput()
        }
      )
      return
    }

    const player = new HybridLlmPlayer(
      cfg,
      transport,
      client,
      {
        advisorMode: st.advisorMode,
        strengthBlend: st.strengthBlend,
        advisorDifficulty: st.advisorDifficulty,
        maxAttempts: st.maxAttempts,
        fallback: st.fallback,
        builtinAiSource: () => new ChessAiPlayer(client, 3),
        onAttempt: (n, total) => setAttempt({ n, total })
      },
      { authSlot: BLACK_SLOT } // 掩码 Key 回读时主进程按槽位注入（DR-010）
    )
    playerRef.current = player
    void player.nextMove(boardSnapshot, history).then(
      (result: MoveSourceResult): void => {
        thinkingRef.current = false
        setLlmThinking(false)
        vm.unlockInput() // 无论作废与否一律解锁（P0-1）
        if (seq !== gameSeqRef.current) return // 新局/悔棋/离开：丢弃
        switch (result.status) {
          case 'ok': {
            if (result.move === undefined) return
            const applied = vm.playMove(result.move.from, result.move.to)
            if (result.fromFallback) setLlmNote(result.note ?? '已由内置 AI 兜底走子')
            else if (!applied) setLlmNote('黑方着法未通过校验，被拒绝')
            else if (result.note !== undefined && result.note !== '') setLlmNote(result.note)
            else setLlmNote('黑方走子完成')
            return
          }
          case 'noLegalMove':
            // 已分出胜负，结果由棋盘状态呈现。
            setLlmNote('')
            return
          case 'failed':
            // resign 策略：显式写入胜负防软死锁（防错 #7）。
            vm.resign('black')
            setLlmNote(`黑方走子失败：${result.note ?? '未知原因'}，判红方胜`)
            return
        }
      },
      () => {
        // canceled（新局/悔棋/离开）：无条件解锁（P0-1）
        thinkingRef.current = false
        setLlmThinking(false)
        vm.unlockInput()
      }
    )
  }, [store])
  triggerRef.current = triggerLlmMove

  /**
   * 恢复完成且配置/设置就绪后触发黑方应手（两路异步的汇合点）：
   * 黑先残局/恢复存档轮黑时由模型先行；已触发或非黑回合则跳过。
   */
  const maybeTriggerRef = useRef<(() => void) | null>(null)
  maybeTriggerRef.current = (): void => {
    if (thinkingRef.current) return
    const vm = store.getState().vm
    if (vm.isFinished || vm.isRedTurn) return
    if (configRef.current === null || settingsRef.current === null) return // 未就绪
    triggerLlmMove()
  }

  const newGame = useCallback((): void => {
    gameSeqRef.current++ // 作废在途应手
    void playerRef.current?.cancelCurrent()
    thinkingRef.current = false
    setLlmThinking(false)
    setLlmNote('')
    const vm = store.getState().vm
    if (initialFen !== undefined) {
      vm.newGameFromFen(initialFen)
      vm.unlockInput()
      maybeTriggerRef.current?.()
      return
    }
    vm.newGame()
  }, [store, initialFen])

  const undoRound = useCallback((): void => {
    gameSeqRef.current++
    void playerRef.current?.cancelCurrent()
    setLlmThinking(false)
    setLlmNote('')
    store.getState().vm.undoRound('red')
    store.getState().vm.unlockInput()
  }, [store])

  const onPlayerMoved = useCallback((): void => {
    const vm = store.getState().vm
    if (vm.current.result !== null) return
    if (vm.isRedTurn) return // 仍轮玩家（防御）
    triggerLlmMove()
  }, [store, triggerLlmMove])

  const saveGame = useCallback((): void => {
    const vm = store.getState().vm
    if (initialFen !== undefined) {
      showToast('残局来源不写入对局存档')
      return
    }
    const data = vm.serialize()
    void api.db
      .saveGame({ mode: 'humanVsLlm', fen: data.fen, moves: data.moves })
      .then(() => showToast('棋局已保存'))
      .catch(() => showToast('保存失败：本地存储不可用'))
  }, [store, initialFen, showToast])

  // 页面进入：恢复/新局 + 自动保存挂接；恢复后轮黑则续上模型思考。
  useEffect(() => {
    const vm = store.getState().vm
    const autoSave = new GameAutoSave({
      mode: 'humanVsLlm',
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
        await restoreOrNewGame({ mode: 'humanVsLlm', vm, repo: api.db })
      }
      if (disposed) return
      maybeTriggerRef.current?.() // 恢复完成：轮黑则模型先行（配置未就绪时由加载侧再触发）
    })()
    return () => {
      disposed = true
      autoSave.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  // 状态栏（human_vs_llm_page.dart:_statusOf）
  const result = useStore(store, (s) => s.result)
  const isCheck = useStore(store, (s) => s.isCheck)
  const isRedTurn = useStore(store, (s) => s.isRedTurn)
  const modelLabel =
    settings?.opponentType === 'builtin'
      ? '内置 AI'
      : (config?.model.trim() ?? '') === ''
        ? '大模型'
        : config!.model.trim()

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
  } else if (isLlmThinking) {
    statusText = `黑方 ${modelLabel} 正在思考…${formatThinkingSuffix(elapsed, attempt)}`
    statusClass = 'cc-status-thinking'
  } else if (llmNote !== '') {
    statusText = llmNote
    statusClass = 'cc-status-note'
  } else if (isCheck && isRedTurn) {
    statusText = '轮到你走棋（红方被将军！）'
    statusClass = 'cc-status-check'
  } else if (isCheck) {
    // 轮黑但尚未进入思考态的瞬态（黑先残局/恢复轮黑）
    statusText = '黑方被将军！'
    statusClass = 'cc-status-check'
  } else {
    statusText = '轮到你走棋（红方）'
    statusClass = 'cc-status-waiting'
  }

  const st = settings
  const updateSettings = (patch: Partial<PageSettings>): void => {
    setSettings((prev) => (prev === null ? prev : { ...prev, ...patch }))
    scheduleAutosave()
  }

  return (
    <div className="cc-game-page">
      <header className="cc-game-header">
        <button type="button" className="cc-btn" onClick={() => navigate(-1)} aria-label="返回">
          返回
        </button>
        <h2>人机对战（大模型）</h2>
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
        <span data-testid="llm-status">{statusText}</span>
        {isLlmThinking && <span className="cc-spinner" aria-hidden="true" />}
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
            <div data-testid="llm-display-name">{modelLabel}</div>
          </div>
          {st !== null && (
            <label className="cc-llm-field">
              <span>对手引擎</span>
              <select
                aria-label="对手引擎"
                value={st.opponentType}
                disabled={isLlmThinking}
                onChange={(e) => updateSettings({ opponentType: e.target.value as SideEngineType })}
              >
                {(Object.entries(OPPONENT_TYPE_NAMES) as Array<[SideEngineType, string]>).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {config !== null && (
            <div>
              <LlmConfigCard
                title="黑方模型（对手）"
                slot={BLACK_SLOT}
                config={config}
                onChange={(c) => {
                  setConfig(c)
                  scheduleAutosave()
                }}
                testOverride={
                  mirroredRef.current
                    ? { config, slot: RED_SLOT }
                    : undefined
                }
              />
              {mirroredRef.current && (
                <div className="cc-settings-hint" data-testid="black-crosspage-hint">
                  黑方未配置——已使用红方的模型配置（修改请在红方槽位或大模型对战页进行）
                </div>
              )}
            </div>
          )}
          {st !== null && (
            <div className="cc-card" data-testid="llm-game-settings">
              <div className="cc-section-title">对局设置</div>
              <label className="cc-llm-field">
                <span>空闲超时</span>
                <select
                  aria-label="空闲超时"
                  value={st.timeoutSeconds}
                  disabled={isLlmThinking}
                  onChange={(e) => updateSettings({ timeoutSeconds: Number(e.target.value) })}
                >
                  {Object.entries(TIMEOUT_OPTIONS).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cc-llm-field">
                <span>无效回复重试</span>
                <select
                  aria-label="无效回复重试"
                  value={st.maxAttempts}
                  disabled={isLlmThinking}
                  onChange={(e) => updateSettings({ maxAttempts: Number(e.target.value) })}
                >
                  {Object.entries(ATTEMPT_OPTIONS).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cc-llm-field">
                <span>模型持续失败时</span>
                <select
                  aria-label="模型持续失败时"
                  value={st.fallback}
                  disabled={isLlmThinking}
                  onChange={(e) => updateSettings({ fallback: e.target.value as LlmFallback })}
                >
                  {(Object.entries(FALLBACK_NAMES) as Array<[LlmFallback, string]>).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cc-llm-field">
                <span>引擎参谋</span>
                <select
                  aria-label="引擎参谋"
                  value={st.advisorMode}
                  disabled={isLlmThinking}
                  onChange={(e) => updateSettings({ advisorMode: e.target.value as AdvisorMode })}
                >
                  {(Object.entries(ADVISOR_NAMES) as Array<[AdvisorMode, string]>).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {st.advisorMode !== 'off' && (
                <>
                  <label className="cc-llm-field">
                    <span>参谋强度</span>
                    <select
                      aria-label="参谋强度"
                      value={st.strengthBlend}
                      disabled={isLlmThinking}
                      onChange={(e) => updateSettings({ strengthBlend: Number(e.target.value) })}
                    >
                      {Object.entries(BLEND_OPTIONS).map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="cc-llm-field">
                    <span>参谋深度</span>
                    <select
                      aria-label="参谋深度"
                      value={st.advisorDifficulty}
                      disabled={isLlmThinking}
                      onChange={(e) => updateSettings({ advisorDifficulty: Number(e.target.value) })}
                    >
                      {Object.entries(DIFFICULTY_OPTIONS).map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>
          )}
          <div className="cc-button-row">
            <button
              type="button"
              className="cc-btn"
              data-testid="llm-save-now"
              onClick={() => {
                if (config === null) return
                if (mirroredRef.current) {
                  showToast('当前为红方配置的镜像视图，请在红方一侧修改配置')
                  return
                }
                void api.secure
                  .set(BLACK_SLOT, config)
                  .then((res) =>
                    showToast(
                      res.stored === 'plainFallback'
                        ? '模型配置已保存（系统安全存储不可用，已明文保存到本地）'
                        : '模型配置已保存'
                    )
                  )
                  .catch(() => showToast('保存失败：本地存储不可用'))
                if (st !== null && lastLoadedRef.current !== null) {
                  void saveLlmSettings({ ...lastLoadedRef.current, ...st })
                }
              }}
            >
              立即保存
            </button>
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
      {toast !== null && <div className="cc-snackbar">{toast}</div>}
    </div>
  )
}
