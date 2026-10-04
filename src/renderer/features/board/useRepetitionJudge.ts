/**
 * 重复裁决接线 hook（DR-018，final 设计 §6；08 防错 #11/#12）。
 *
 * 监听 moveHistory 增长 → judgeRepetition(fenHistory) → 按裁决驱动：
 * - 长将第 2 次出现 → toast 非阻塞警告（不锁输入、不打断思考）；
 * - 长将第 3 次 → 违规方判负（vm.resign，结算由既有结果组件呈现）；
 * - 双方长将 / 第 4 次重复 → 判和（vm.agreeDraw）；
 * - 三次重复判和 → 面对和棋的一方为玩家时弹确认框（可变着继续），
 *   为 AI/LLM 时自动接受。
 * 仅在历史增长时裁决（悔棋/新局不触发，且重置拒绝状态）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { judgeRepetition, type Side } from '@packages/rules'
import type { GameStore } from '@renderer/stores/createGameStore'

const sideName = (side: Side): string => (side === 'red' ? '红' : '黑')

export interface RepetitionJudgeHandle {
  /** 待玩家确认的三次重复和棋（面对方），null = 无待确认 */
  drawOffer: Side | null
  /** 接受和棋 */
  acceptDraw: () => void
  /** 拒绝（变着继续；下次重复即 k=4 强制判和） */
  declineDraw: () => void
}

export function useRepetitionJudge(
  store: GameStore,
  isHuman: (side: Side) => boolean,
  showToast: (message: string) => void
): RepetitionJudgeHandle {
  const historyLen = useStore(store, (s) => s.moveHistory.length)
  const [drawOffer, setDrawOffer] = useState<Side | null>(null)
  const prevLenRef = useRef(0)
  const declinedRef = useRef(false)
  // 回调经 ref 取最新值：effect 仅依赖 historyLen，页面重渲染不重触发裁决。
  const isHumanRef = useRef(isHuman)
  const showToastRef = useRef(showToast)
  isHumanRef.current = isHuman
  showToastRef.current = showToast

  useEffect(() => {
    const vm = store.getState().vm
    const prev = prevLenRef.current
    prevLenRef.current = historyLen
    if (historyLen <= prev) {
      if (historyLen < prev) {
        declinedRef.current = false // 悔棋/重开：拒绝状态一并重置
        setDrawOffer(null)
      }
      return
    }
    if (historyLen < 2) return
    const verdict = judgeRepetition(vm.current.fenHistory)
    if (verdict === null) return
    const sideToMove: Side = vm.isRedTurn ? 'red' : 'black'
    switch (verdict.type) {
      case 'perpetualCheckWarning':
        showToastRef.current(`${sideName(verdict.side)}方连续将军重复，再次将判负`)
        break
      case 'perpetualCheckLoss':
        showToastRef.current(`${sideName(verdict.side)}方长将，判负`)
        vm.resign(verdict.side)
        break
      case 'bothPerpetualCheckDraw':
        showToastRef.current('双方长将，不变作和')
        vm.agreeDraw()
        break
      case 'repetitionDraw':
        if (isHumanRef.current(sideToMove)) {
          setDrawOffer(sideToMove) // 玩家确认（08 防错 #12：拒绝后 k=4 强制判和）
        } else {
          showToastRef.current('三次重复局面，判和')
          vm.agreeDraw()
        }
        break
      case 'forcedRepetitionDraw':
        showToastRef.current('再次重复局面，强制判和')
        declinedRef.current = false
        vm.agreeDraw()
        break
    }
  }, [historyLen, store])

  const acceptDraw = useCallback((): void => {
    setDrawOffer(null)
    store.getState().vm.agreeDraw()
  }, [store])

  const declineDraw = useCallback((): void => {
    setDrawOffer(null)
    declinedRef.current = true
  }, [])

  return { drawOffer, acceptDraw, declineDraw }
}
