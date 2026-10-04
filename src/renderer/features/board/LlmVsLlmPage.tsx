/**
 * 大模型对战页（对应 llm_vs_llm_page.dart，08 文档 §3.4 + 05 文档 §8.1）。
 *
 * - 红黑双方各接一个可独立配置的 LLM（HybridLlmPlayer），页面对局循环驱动互弈；
 * - 控制按钮：开始 / 暂停·继续（同一按钮）/ 停止 / 新游戏；棋盘全自动无点击；
 * - 循环经 gameSeq 代数取消；暂停在两手之间生效（在途回复 cancel + 作废）；
 * - 走棋间隔 0/1/2/5s；红黑参谋强度各自独立；
 * - 一方 failed（resign 策略）→ 显式判负终止循环（防错 #7）；
 * - 恢复存档后不自动续跑，由用户点"开始"从当前局面继续。
 * 每次进入页面创建独立 store 实例，离开销毁（铁律 #6）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from 'zustand'
import { chineseNotation } from '@packages/rules'
import {
  isEmptyLlmConfig,
  isConfigured,
  resolveLlmSideConfig,
  type AdvisorMode,
  type LlmFallback,
  type LlmGameSettings,
  type SideEngineType
} from '@packages/llm'
import { HybridLlmPlayer } from '@packages/llm'
import type { LlmEndpointConfig } from '@shared/ipc/types'
import type { MoveSource, MoveSourceResult } from '@packages/engine'
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

const RED_SLOT = 'llm_config_red'
const BLACK_SLOT = 'llm_config_black'
const DEFAULT_CONFIG: LlmEndpointConfig = { baseUrl: '', apiKey: '', model: '', disableThinking: true }

const TIMEOUT_OPTIONS: Record<number, string> = { 30: '30 秒', 60: '60 秒', 120: '120 秒', 180: '180 秒', 300: '300 秒' }
const ATTEMPT_OPTIONS: Record<number, string> = { 1: '1 次', 3: '3 次', 5: '5 次' }
const INTERVAL_OPTIONS: Record<number, string> = { 0: '不等待', 1: '1 秒', 2: '2 秒', 5: '5 秒' }
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
const SIDE_TYPE_NAMES: Record<SideEngineType, string> = {
  llm: '大模型',
  builtin: '内置 AI'
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function LlmVsLlmPage(): React.JSX.Element {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const initialFen = params.get('fen') ?? undefined

  const [redConfig, setRedConfig] = useState<LlmEndpointConfig | null>(null)
  const [blackConfig, setBlackConfig] = useState<LlmEndpointConfig | null>(null)
  const [settings, setSettings] = useState<LlmGameSettings | null>(null)
  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState(false)
  const [moveActive, setMoveActive] = useState(false)
  const [attempt, setAttempt] = useState<AttemptProgress | null>(null)
  const [statusText, setStatusText] = useState('等待开始')
  const [redNote, setRedNote] = useState('')
  const [blackNote, setBlackNote] = useState('')
  const [lastMoveText, setLastMoveText] = useState('')
  const [confirmingNewGame, setConfirmingNewGame] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const store = useMemo(
    () => createGameStore({ mode: 'llmVsLlm', initialFen, playerSide: 'red' }),
    [initialFen]
  )

  const gameSeqRef = useRef(0)
  const clientRef = useRef<EngineClient | null>(null)
  const transportRef = useRef<ReturnType<typeof createIpcLlmTransport> | null>(null)
  const playerRef = useRef<HybridLlmPlayer | null>(null)
  const runningRef = useRef(false)
  const pausedRef = useRef(false)
  const lastLoadedRef = useRef<LlmGameSettings | null>(null)
  const redRef = useRef(redConfig)
  const blackRef = useRef(blackConfig)
  const settingsRef = useRef(settings)
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  redRef.current = redConfig
  blackRef.current = blackConfig
  settingsRef.current = settings

  const elapsed = useThinkingElapsed(moveActive)

  const showToast = useCallback((message: string): void => {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = setTimeout(() => setToast(null), 2200)
  }, [])

  /** 配置 + 全部设置字段落盘（本页显示并拥有全部字段，Dart 同款整对象回写）。 */
  const persist = useCallback((): void => {
    const red = redRef.current
    const black = blackRef.current
    const st = settingsRef.current
    if (red === null || black === null || st === null) return
    void api.secure.set(RED_SLOT, red).catch(() => {})
    void api.secure.set(BLACK_SLOT, black).catch(() => {})
    void saveLlmSettings(st).catch(() => {})
  }, [])

  const scheduleAutosave = useCallback((): void => {
    if (autosaveTimerRef.current !== null) clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = setTimeout(persist, 800)
  }, [persist])

  useEffect(() => {
    clientRef.current = new EngineClient()
    transportRef.current = createIpcLlmTransport()
    return () => {
      gameSeqRef.current++
      runningRef.current = false
      pausedRef.current = false
      void playerRef.current?.cancelCurrent()
      if (autosaveTimerRef.current !== null) clearTimeout(autosaveTimerRef.current)
      persist()
      clientRef.current?.dispose()
      clientRef.current = null
    }
  }, [persist])

  // 配置/设置加载（未加载完成不回写，防错 #4；ref 先于 state 同步供循环读取）
  useEffect(() => {
    let disposed = false
    void (async () => {
      let red: LlmEndpointConfig
      let black: LlmEndpointConfig
      try {
        red = (await api.secure.get(RED_SLOT)) ?? { ...DEFAULT_CONFIG }
        black = (await api.secure.get(BLACK_SLOT)) ?? { ...DEFAULT_CONFIG }
      } catch {
        red = { ...DEFAULT_CONFIG }
        black = { ...DEFAULT_CONFIG }
      }
      const gameSettings = await loadLlmSettings()
      if (disposed) return
      lastLoadedRef.current = gameSettings
      redRef.current = red
      blackRef.current = black
      settingsRef.current = gameSettings
      setRedConfig(red)
      setBlackConfig(black)
      setSettings(gameSettings)
    })()
    return () => {
      disposed = true
    }
  }, [])

  const setNote = useCallback((isRed: boolean, note: string): void => {
    if (isRed) setRedNote(note)
    else setBlackNote(note)
  }, [])

  /** 一方走子失败：显式判负终止循环（llm_vs_llm_page.dart:_onSideFailed，防错 #7）。 */
  const onSideFailed = useCallback(
    (isRed: boolean, reason: string): void => {
      gameSeqRef.current++
      runningRef.current = false
      pausedRef.current = false
      const vm = store.getState().vm
      vm.resign(isRed ? 'red' : 'black')
      vm.unlockInput()
      setRunning(false)
      setPaused(false)
      setStatusText(`${isRed ? '红方' : '黑方'}走子失败，对局终止`)
      setNote(isRed, reason)
    },
    [store, setNote]
  )

  /** 对局主循环：红黑交替请模型应手（llm_vs_llm_page.dart:_runLoop）。 */
  const runLoop = useCallback(async (): Promise<void> => {
    const seq = gameSeqRef.current
    while (seq === gameSeqRef.current && runningRef.current && !pausedRef.current) {
      const vm = store.getState().vm
      if (vm.isFinished) {
        runningRef.current = false
        vm.unlockInput()
        setRunning(false)
        return
      }
      const client = clientRef.current
      const transport = transportRef.current
      const red = redRef.current
      const black = blackRef.current
      const st = settingsRef.current
      if (client === null || transport === null || red === null || black === null || st === null) {
        return
      }
      const isRedTurn = vm.isRedTurn
      // await 前快照棋盘与历史。
      const boardSnapshot = vm.board.copy()
      const history = [...vm.current.moveHistory]

      // DR-014：按该侧引擎类型构造走子来源（内置AI 直接应手，非失败兜底）。
      let source: MoveSource
      let sideLabel: string
      if ((isRedTurn ? st.redSideType : st.blackSideType) === 'builtin') {
        source = new ChessAiPlayer(client, 3)
        sideLabel = '内置 AI'
      } else {
        // 空配置一侧运行时跟随对方（DR-012）；authSlot 随生效配置来源（DR-010）。
        const resolved = isRedTurn
          ? resolveLlmSideConfig(red, black, RED_SLOT, BLACK_SLOT)
          : resolveLlmSideConfig(black, red, BLACK_SLOT, RED_SLOT)
        source = new HybridLlmPlayer(
          resolved.config,
          transport,
          client,
          {
            advisorMode: st.advisorMode,
            strengthBlend: isRedTurn ? st.redStrengthBlend : st.blackStrengthBlend,
            advisorDifficulty: st.advisorDifficulty,
            maxAttempts: st.maxAttempts,
            fallback: st.fallback,
            builtinAiSource: () => new ChessAiPlayer(client, 3),
            onAttempt: (n, total) => setAttempt({ n, total })
          },
          { authSlot: resolved.authSlot }
        )
        playerRef.current = source as HybridLlmPlayer
        sideLabel = resolved.config.model.trim()
      }
      setStatusText(`${isRedTurn ? '红方' : '黑方'}（${sideLabel}）思考中…`)

      let result: MoveSourceResult
      setMoveActive(true)
      setAttempt(null)
      try {
        result = await source.nextMove(boardSnapshot, history)
      } catch (e) {
        setMoveActive(false)
        if (e instanceof Error && (e.message === 'llm chat canceled' || e.message === 'engine canceled')) return
        if (seq !== gameSeqRef.current) return
        onSideFailed(isRedTurn, `走子来源异常：${String(e instanceof Error ? e.message : e)}`)
        return
      }
      setMoveActive(false)

      // 请求在途期间可能已停止/暂停/重开：作废本次结果。
      if (seq !== gameSeqRef.current) return
      if (pausedRef.current) {
        setStatusText('已暂停（模型回复已作废，继续后重新思考）')
        return
      }

      if (result.status === 'ok' && result.move !== undefined) {
        const applied = vm.playMove(result.move.from, result.move.to)
        if (!applied) {
          // nextMove 内部已按合法清单校验，此处为极端兜底：终止本方。
          onSideFailed(isRedTurn, '着法未通过最终校验')
          return
        }
        const piece = result.move.piece
        const notation =
          piece !== undefined
            ? chineseNotation(piece, result.move.from, result.move.to)
            : `${result.move.from.col},${result.move.from.row}→${result.move.to.col},${result.move.to.row}`
        setLastMoveText(`${isRedTurn ? '红方' : '黑方'} ${notation}`)
        if (result.fromFallback) setNote(isRedTurn, result.note ?? '已由内置 AI 兜底走子')
        else if (result.note !== undefined && result.note !== '') setNote(isRedTurn, result.note)
        const interval = st.intervalSeconds
        if (interval > 0) {
          await sleep(interval * 1000)
          if (seq !== gameSeqRef.current || pausedRef.current) return
        }
      } else if (result.status === 'noLegalMove') {
        // 棋局已分出胜负，下一轮循环检测 isFinished 后退出。
        setStatusText('该方已无合法着法')
        return
      } else {
        onSideFailed(isRedTurn, result.note ?? '未知原因')
        return
      }
    }
  }, [store, onSideFailed, setNote])

  const start = useCallback((): void => {
    const red = redRef.current
    const black = blackRef.current
    const st = settingsRef.current
    if (red === null || black === null || st === null) {
      // 配置/设置未加载完成：不可对局，如实提示（此前静默 return 会被误解为"没反应"）。
      showToast('配置加载中，请稍候再开始')
      return
    }
    // DR-014：引擎类型为"内置 AI"的一侧不要求 LLM 配置；DR-012 镜像校验仅对大模型侧。
    const redMirror = st.redSideType === 'llm'
    const blackMirror = st.blackSideType === 'llm'
    const redEff = redMirror ? resolveLlmSideConfig(red, black, RED_SLOT, BLACK_SLOT).config : red
    const blackEff = blackMirror ? resolveLlmSideConfig(black, red, BLACK_SLOT, RED_SLOT).config : black
    if ((redMirror && !isConfigured(redEff)) || (blackMirror && !isConfigured(blackEff))) {
      showToast('大模型一侧需填写端点地址与模型 ID（或把该侧切换为内置 AI）')
      return
    }
    runningRef.current = true
    pausedRef.current = false
    setRunning(true)
    setPaused(false)
    store.getState().vm.lockInput() // 自动对局期间锁定棋盘点击
    void runLoop()
  }, [store, runLoop, showToast])

  const togglePause = useCallback((): void => {
    if (!runningRef.current) return
    if (pausedRef.current) {
      // 继续：作废旧循环的在途回复，重新驱动循环。
      pausedRef.current = false
      gameSeqRef.current++
      void playerRef.current?.cancelCurrent()
      setPaused(false)
      setStatusText('继续对局…')
      void runLoop()
    } else {
      pausedRef.current = true
      gameSeqRef.current++
      void playerRef.current?.cancelCurrent()
      setPaused(true)
      setStatusText('已暂停')
    }
  }, [runLoop])

  const stop = useCallback((): void => {
    gameSeqRef.current++
    runningRef.current = false
    pausedRef.current = false
    void playerRef.current?.cancelCurrent()
    store.getState().vm.unlockInput()
    setRunning(false)
    setPaused(false)
    setStatusText('已停止')
  }, [store])

  const newGame = useCallback((): void => {
    gameSeqRef.current++
    runningRef.current = false
    pausedRef.current = false
    void playerRef.current?.cancelCurrent()
    setRunning(false)
    setPaused(false)
    setStatusText('等待开始')
    setRedNote('')
    setBlackNote('')
    setLastMoveText('')
    const vm = store.getState().vm
    vm.unlockInput()
    if (initialFen !== undefined) vm.newGameFromFen(initialFen)
    else vm.newGame()
  }, [store, initialFen])

  // 页面进入：恢复/新局 + 自动保存挂接；恢复后不自动续跑。
  useEffect(() => {
    const vm = store.getState().vm
    const autoSave = new GameAutoSave({ mode: 'llmVsLlm', vm, canSave: () => initialFen === undefined, repo: api.db })
    autoSave.attach()
    void (async () => {
      if (initialFen !== undefined) vm.newGameFromFen(initialFen)
      else await restoreOrNewGame({ mode: 'llmVsLlm', vm, repo: api.db })
    })()
    return () => autoSave.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  const result = useStore(store, (s) => s.result)
  const resultText =
    result === 'redWins' ? '对局结束：红方获胜' : result === 'blackWins' ? '对局结束：黑方获胜' : result === 'draw' ? '对局结束：和棋' : null

  const st = settings
  const updateSettings = (patch: Partial<LlmGameSettings>): void => {
    setSettings((prev) => (prev === null ? prev : { ...prev, ...patch }))
    scheduleAutosave()
  }

  return (
    <div className="cc-game-page">
      <header className="cc-game-header">
        <button type="button" className="cc-btn" onClick={() => navigate(-1)} aria-label="返回">
          返回
        </button>
        <h2>大模型对战</h2>
        <button
          type="button"
          className="cc-btn"
          data-testid="llm-loop-toggle"
          disabled={settings === null}
          title={settings === null ? '配置加载中' : undefined}
          onClick={() => (running ? togglePause() : start())}
        >
          {!running ? '开始对战' : paused ? '继续' : '暂停'}
        </button>
        <button type="button" className="cc-btn" disabled={!running} onClick={stop}>
          停止
        </button>
        <button type="button" className="cc-btn" onClick={() => setConfirmingNewGame(true)}>
          新游戏
        </button>
      </header>
      <div className="cc-status-bar cc-status-note" role="status" data-testid="llm-loop-status">
        <span>
          {resultText ?? statusText}
          {moveActive && formatThinkingSuffix(elapsed, attempt)}
        </span>
        {running && !paused && <span className="cc-spinner" aria-hidden="true" />}
      </div>
      <div className="cc-game-body">
        <div className="cc-board-area">
          <BoardView store={store} />
        </div>
        <div className="cc-panel-area">
          <div className="cc-card cc-game-info">
            <ResultBanner result={result} />
            {redNote !== '' && <div data-testid="llm-red-note">红方：{redNote}</div>}
            {blackNote !== '' && <div data-testid="llm-black-note">黑方：{blackNote}</div>}
            {lastMoveText !== '' && <div data-testid="llm-last-move">{lastMoveText}</div>}
          </div>
          {redConfig !== null && (
            <div>
              <LlmConfigCard
                title="红方模型"
                slot={RED_SLOT}
                config={redConfig}
                onChange={(c) => {
                  setRedConfig(c)
                  scheduleAutosave()
                }}
              />
              {isEmptyLlmConfig(redConfig) && blackConfig !== null && isConfigured(blackConfig) && (
                <div className="cc-settings-hint" data-testid="red-mirror-hint">
                  未配置——对局时将使用黑方的模型配置
                </div>
              )}
              {isEmptyLlmConfig(redConfig) && (blackConfig === null || !isConfigured(blackConfig)) && (
                <div className="cc-settings-hint">
                  未配置——保存后其他页面（如人机对战）黑方未配置时将使用本侧
                </div>
              )}
            </div>
          )}
          {blackConfig !== null && (
            <div>
              <LlmConfigCard
                title="黑方模型"
                slot={BLACK_SLOT}
                config={blackConfig}
                onChange={(c) => {
                  setBlackConfig(c)
                  scheduleAutosave()
                }}
                testOverride={
                  isEmptyLlmConfig(blackConfig) && redConfig !== null && isConfigured(redConfig)
                    ? { config: redConfig, slot: RED_SLOT }
                    : undefined
                }
              />
              {isEmptyLlmConfig(blackConfig) && redConfig !== null && isConfigured(redConfig) && (
                <div className="cc-settings-hint" data-testid="black-mirror-hint">
                  本页未配置——对局时将使用红方的模型配置
                </div>
              )}
              {isEmptyLlmConfig(blackConfig) && (redConfig === null || !isConfigured(redConfig)) && (
                <div className="cc-settings-hint" data-testid="black-crosspage-hint">
                  未配置——人机对战（大模型）的黑方也将使用红方配置（保存后生效）
                </div>
              )}
            </div>
          )}
          {st !== null && (
            <div className="cc-card" data-testid="llm-game-settings">
              <div className="cc-section-title">对局设置</div>
              <label className="cc-llm-field">
                <span>红方引擎</span>
                <select
                  aria-label="红方引擎"
                  value={st.redSideType}
                  onChange={(e) => updateSettings({ redSideType: e.target.value as SideEngineType })}
                >
                  {(Object.entries(SIDE_TYPE_NAMES) as Array<[SideEngineType, string]>).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cc-llm-field">
                <span>黑方引擎</span>
                <select
                  aria-label="黑方引擎"
                  value={st.blackSideType}
                  onChange={(e) => updateSettings({ blackSideType: e.target.value as SideEngineType })}
                >
                  {(Object.entries(SIDE_TYPE_NAMES) as Array<[SideEngineType, string]>).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cc-llm-field">
                <span>空闲超时</span>
                <select aria-label="空闲超时" value={st.timeoutSeconds} onChange={(e) => updateSettings({ timeoutSeconds: Number(e.target.value) })}>
                  {Object.entries(TIMEOUT_OPTIONS).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cc-llm-field">
                <span>无效回复重试</span>
                <select aria-label="无效回复重试" value={st.maxAttempts} onChange={(e) => updateSettings({ maxAttempts: Number(e.target.value) })}>
                  {Object.entries(ATTEMPT_OPTIONS).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cc-llm-field">
                <span>模型持续失败时</span>
                <select aria-label="模型持续失败时" value={st.fallback} onChange={(e) => updateSettings({ fallback: e.target.value as LlmFallback })}>
                  {(Object.entries(FALLBACK_NAMES) as Array<[LlmFallback, string]>).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cc-llm-field">
                <span>走棋间隔</span>
                <select aria-label="走棋间隔" value={st.intervalSeconds} onChange={(e) => updateSettings({ intervalSeconds: Number(e.target.value) })}>
                  {Object.entries(INTERVAL_OPTIONS).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cc-llm-field">
                <span>引擎参谋</span>
                <select aria-label="引擎参谋" value={st.advisorMode} onChange={(e) => updateSettings({ advisorMode: e.target.value as AdvisorMode })}>
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
                    <span>红方强度</span>
                    <select aria-label="红方强度" value={st.redStrengthBlend} onChange={(e) => updateSettings({ redStrengthBlend: Number(e.target.value) })}>
                      {Object.entries(BLEND_OPTIONS).map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="cc-llm-field">
                    <span>黑方强度</span>
                    <select aria-label="黑方强度" value={st.blackStrengthBlend} onChange={(e) => updateSettings({ blackStrengthBlend: Number(e.target.value) })}>
                      {Object.entries(BLEND_OPTIONS).map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="cc-llm-field">
                    <span>参谋深度</span>
                    <select aria-label="参谋深度" value={st.advisorDifficulty} onChange={(e) => updateSettings({ advisorDifficulty: Number(e.target.value) })}>
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
                const red = redRef.current
                const black = blackRef.current
                if (red === null || black === null) return
                void Promise.all([api.secure.set(RED_SLOT, red), api.secure.set(BLACK_SLOT, black)])
                  .then(([r, b]) =>
                    showToast(
                      r.stored === 'plainFallback' || b.stored === 'plainFallback'
                        ? '双方模型配置已保存（系统安全存储不可用，已明文保存到本地）'
                        : '双方模型配置已保存'
                    )
                  )
                  .catch(() => showToast('保存失败：本地存储不可用'))
                if (st !== null) void saveLlmSettings(st)
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
