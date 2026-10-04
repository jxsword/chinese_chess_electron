/**
 * GameVm fenHistory 维护单测（T3.8，DR-018，final 设计 §1/§6）。
 *
 * 四收口点：executeMove push / undoOnceInternal pop / restore 重放逐手采集 /
 * newGame 重置。fenHistory 与 moveHistory 一一对应（长度 = history + 1）。
 */
import { describe, expect, it } from 'vitest'
import { createGameStore } from '@renderer/stores/createGameStore'
import { Board, pos } from '@packages/rules'

const FEN_START = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

/** 走一步炮二平五（(1,7)→(4,7)），返回走后 store 状态。 */
function playCannonMid(store: ReturnType<typeof createGameStore>) {
  store.getState().vm.onTap(1, 7)
  store.getState().vm.onTap(4, 7)
  return store.getState()
}

describe('GameVm fenHistory（DR-018）', () => {
  it('初始快照 fenHistory = [初始局面 FEN]', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const state = store.getState()
    expect(state.fenHistory).toEqual([FEN_START])
  })

  it('落子 push / 悔棋 pop，与 moveHistory 一一对应', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const after = playCannonMid(store)
    expect(after.moveHistory.length).toBe(1)
    expect(after.fenHistory.length).toBe(2)
    expect(after.fenHistory[1]).toBe(after.fen)
    // 落子后 FEN 应等于规则层重放结果。
    const replay = Board.fromFen(FEN_START)
    replay.applyMove({ from: pos(1, 7), to: pos(4, 7) })
    expect(after.fenHistory[1]).toBe(replay.toFen())
    // 悔棋后回到初始。
    store.getState().vm.undo()
    const undone = store.getState()
    expect(undone.moveHistory.length).toBe(0)
    expect(undone.fenHistory).toEqual([FEN_START])
  })

  it('restore 重放逐手采集 fenHistory（含原版跳脏语义）', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    playCannonMid(store)
    const saved = store.getState().vm.serialize()
    // 原版语义：restore 在存档 FEN 之上重放 moves，源格无子的记录被跳过，
    // 恢复后走法历史通常为空（board_vm.dart:87-132，1:1 保留）。
    const restored = createGameStore({ mode: 'humanVsHuman' })
    restored.getState().vm.restore(saved)
    expect(restored.getState().moveHistory).toHaveLength(0)
    expect(restored.getState().fenHistory).toEqual([saved.fen])
    // 重放真正生效的路径：起始 FEN + 从该局面出发的有效四元组。
    const replayed = createGameStore({ mode: 'humanVsHuman' })
    replayed.getState().vm.restore({ fen: FEN_START, moves: [[1, 7, 4, 7]] })
    const state = replayed.getState()
    expect(state.moveHistory).toHaveLength(1)
    expect(state.fenHistory.length).toBe(2)
    expect(state.fenHistory[1]).toBe(state.fen)
  })

  it('restore 跳过脏记录时 fenHistory 保持与有效走法一致', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    // 脏记录：越界坐标 (99,99)→(0,0) 应被跳过。
    store.getState().vm.restore({ fen: FEN_START, moves: [[99, 99, 0, 0], [1, 7, 4, 7]] })
    const state = store.getState()
    expect(state.moveHistory.length).toBe(1)
    expect(state.fenHistory.length).toBe(2)
  })

  it('newGame 重置 fenHistory', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    playCannonMid(store)
    store.getState().vm.newGame()
    expect(store.getState().fenHistory).toEqual([FEN_START])
  })

  it('newGameFromFen 以来源 FEN 为 fenHistory 起点', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const fen = '4k4/9/9/9/9/9/4C4/9/4C4/4K4 w - - 0 1'
    store.getState().vm.newGameFromFen(fen)
    expect(store.getState().fenHistory).toEqual([fen])
  })
})
