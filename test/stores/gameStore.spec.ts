import { describe, it, expect } from 'vitest'
import { createGameStore } from '@renderer/stores/createGameStore'
import { pos } from '@packages/rules'

// 等价集：test/features/board/viewmodel/board_vm_test.dart（12 例，09 §1 映射 board_vm 12）
// 通过 createGameStore 工厂驱动（同时覆盖 Zustand 包装层）；每例独立实例（铁律 #6）。

const FEN_START = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'
const FEN_DOUBLE_CANNON = '4k4/9/9/9/9/9/4C4/9/4C4/4K4 w - - 0 1'

describe('BoardViewModel 等价集（board_vm_test.dart）', () => {
  it('初始局面：红方先行，无选中，无走法历史', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const state = store.getState()
    expect(state.isRedTurn).toBe(true)
    expect(state.selected).toBeNull()
    expect(state.legalTargets).toEqual([])
    expect(state.moveHistory).toEqual([])
    expect(state.result).toBeNull()
  })

  it('点击红车（col=0,row=9）能选中并产生合法走法', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    store.getState().vm.onTap(0, 9)
    const state = store.getState()
    expect(state.selected).not.toBeNull()
    expect(state.legalTargets.length).toBeGreaterThan(0)
  })

  it('走子后切换轮走方，记录走法历史', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const vm = store.getState().vm
    vm.onTap(0, 9)
    vm.onTap(0, 8)
    const state = store.getState()
    expect(state.isRedTurn).toBe(false)
    expect(state.moveHistory.length).toBe(1)
    expect(state.lastMove).not.toBeNull()
  })

  it('悔棋后走法历史减少，轮走方回退', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const vm = store.getState().vm
    vm.onTap(0, 9)
    vm.onTap(0, 8)
    vm.undo()
    const state = store.getState()
    expect(state.moveHistory).toEqual([])
    expect(state.isRedTurn).toBe(true)
  })

  it('新游戏后恢复初始局面', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const vm = store.getState().vm
    vm.onTap(0, 9)
    vm.onTap(0, 8)
    vm.newGame()
    const state = store.getState()
    expect(state.moveHistory).toEqual([])
    expect(state.isRedTurn).toBe(true)
  })

  it('newGameFromFen：以残局 FEN 开局，轮走方随 FEN', () => {
    const store = createGameStore({ mode: 'humanVsAi' })
    const vm = store.getState().vm
    vm.newGameFromFen(FEN_DOUBLE_CANNON)
    const state = store.getState()
    expect(state.fen).toBe(FEN_DOUBLE_CANNON)
    expect(state.isRedTurn).toBe(true)
    expect(state.moveHistory).toEqual([])
    expect(state.result).toBeNull()
  })

  it('newGameFromFen：黑先 FEN 时轮走方为黑', () => {
    const store = createGameStore({ mode: 'humanVsAi' })
    store.getState().vm.newGameFromFen('4k4/9/9/9/9/9/4C4/9/4C4/4K4 b - - 0 1')
    expect(store.getState().isRedTurn).toBe(false)
  })

  it('newGameFromFen：无效 FEN 回退标准初始局面', () => {
    const store = createGameStore({ mode: 'humanVsAi' })
    store.getState().vm.newGameFromFen('不是 FEN 的字符串')
    const state = store.getState()
    expect(state.fen).toBe(FEN_START)
    expect(state.isRedTurn).toBe(true)
  })

  it('newGameFromFen 后走子正常：红炮进一更新局面', () => {
    const store = createGameStore({ mode: 'humanVsAi' })
    const vm = store.getState().vm
    vm.newGameFromFen(FEN_DOUBLE_CANNON)
    const applied = vm.playMove(pos(4, 6), pos(4, 5))
    expect(applied).toBe(true)
    expect(store.getState().isRedTurn).toBe(false)
    expect(store.getState().moveHistory).toHaveLength(1)
  })

  it('undoRound：黑方玩家语义（先撤红方 AI 一手，再撤黑方玩家一手）', () => {
    const store = createGameStore({ mode: 'humanVsAi' })
    const vm = store.getState().vm
    // 红先残局：AI(红)先行 1 着，黑方玩家应手 1 着
    vm.newGameFromFen(FEN_DOUBLE_CANNON)
    const aiApplied = vm.playMove(pos(4, 9), pos(5, 9))
    expect(aiApplied).toBe(true) // 红帅 e0→f0 合法
    const playerApplied = vm.playMove(pos(4, 0), pos(3, 0))
    expect(playerApplied).toBe(true) // 黑将 e9→d9 合法（离开红炮纵线）
    expect(store.getState().moveHistory).toHaveLength(2)
    vm.undoRound('black')
    // 一轮 = 撤黑方玩家 + 撤红方 AI 各一手
    expect(store.getState().moveHistory).toEqual([])
    expect(store.getState().isRedTurn).toBe(true)
  })

  it('困毙判负：黑方无子可动且未被将军 → 红方胜（非和棋）', () => {
    const store = createGameStore({ mode: 'humanVsAi' })
    store.getState().vm.newGameFromFen('4k4/3P1P3/4P4/9/9/9/9/9/9/3K5 b - - 0 1')
    expect(store.getState().result).toBe('redWins') // 困毙方判负
  })

  it('困毙判负：红方无子可动且未被将军 → 黑方胜', () => {
    const store = createGameStore({ mode: 'humanVsAi' })
    store.getState().vm.newGameFromFen('4k4/9/9/9/9/9/9/4p4/3p1p3/4K4 w - - 0 1')
    expect(store.getState().result).toBe('blackWins') // 困毙方判负
  })
})

describe('GameVm 扩展（输入锁/强校验/序列化/恢复，board_vm.dart:140,220 等锚点）', () => {
  it('playMove 非法走子返回 false 且状态不变', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const vm = store.getState().vm
    // 起点无子
    expect(vm.playMove(pos(4, 4), pos(4, 5))).toBe(false)
    // 起点有子但非本方
    expect(vm.playMove(pos(4, 0), pos(4, 1))).toBe(false)
    // 目标不合法（红帅不能出九宫/一步跨多格）
    expect(vm.playMove(pos(4, 9), pos(4, 6))).toBe(false)
    expect(store.getState().moveHistory).toEqual([])
    expect(store.getState().fen).toBe(FEN_START)
  })

  it('输入锁：锁定期间 onTap 无效；newGame/resign 解锁（防错 #2 VM 半边）', () => {
    const store = createGameStore({ mode: 'humanVsAi' })
    const vm = store.getState().vm
    vm.lockInput()
    vm.onTap(0, 9)
    expect(store.getState().selected).toBeNull()
    vm.unlockInput()
    vm.onTap(0, 9)
    expect(store.getState().selected).not.toBeNull()

    // resign 解锁（终局后本就无法点击，锁不应残留）
    const store2 = createGameStore({ mode: 'humanVsLlm' })
    store2.getState().vm.lockInput()
    store2.getState().vm.resign('black')
    expect(store2.getState().result).toBe('redWins')
    expect(store2.getState().vm.isFinished).toBe(true)
    // 终局后 onTap/playMove 忽略（防错 #3 的 VM 半边）
    store2.getState().vm.onTap(0, 9)
    expect(store2.getState().selected).toBeNull()
    expect(store2.getState().vm.playMove(pos(0, 9), pos(0, 8))).toBe(false)
  })

  it('undoRound 在输入锁期间不动作（对齐 board_vm.dart:231）', () => {
    const store = createGameStore({ mode: 'humanVsAi' })
    const vm = store.getState().vm
    vm.playMove(pos(0, 9), pos(0, 8))
    vm.lockInput()
    vm.undoRound()
    expect(store.getState().moveHistory).toHaveLength(1)
    vm.unlockInput()
    vm.undoRound('red')
    // 一轮：撤红方玩家一手；若之前还有黑方一手一并撤（此处仅 1 着）
    expect(store.getState().moveHistory).toHaveLength(0)
  })

  it('serialize 返回终局 FEN 与裸四元组', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const vm = store.getState().vm
    vm.onTap(0, 9)
    vm.onTap(0, 8)
    const data = vm.serialize()
    expect(data.moves).toEqual([[0, 9, 0, 8]])
    expect(data.fen).toBe(store.getState().fen)
    expect(data.fen.split(' ')[1]).toBe('b')
  })

  it('restore 重放四元组并跳过脏记录（长度≠4/越界/源格无子）', () => {
    const store = createGameStore({ mode: 'humanVsHuman' })
    const vm = store.getState().vm
    vm.restore({
      fen: FEN_START,
      moves: [
        [7, 7, 4, 7], // 炮二平五
        [1], // 长度≠4 → 跳过
        [4, 4, 4, 5], // 源格无子 → 跳过
        [0, -1, 0, 8], // 越界 → 跳过
        [7, 0, 6, 2] // 马8进7
      ]
    })
    const state = store.getState()
    expect(state.moveHistory).toHaveLength(2)
    expect(state.isRedTurn).toBe(true)
    expect(state.lastMove).not.toBeNull()
    expect(state.selected).toBeNull()
    // 重放后的 FEN 与真实走两步一致
    const reference = createGameStore({ mode: 'humanVsHuman' })
    reference.getState().vm.playMove(pos(7, 7), pos(4, 7))
    reference.getState().vm.playMove(pos(7, 0), pos(6, 2))
    expect(state.fen).toBe(reference.getState().fen)
  })

  it('restore 后已分胜负可直接从快照读出（供恢复流程死局清理，game_restore.dart:32）', () => {
    const store = createGameStore({ mode: 'humanVsAi' })
    store.getState().vm.restore({ fen: '4k4/3P1P3/4P4/9/9/9/9/9/9/3K5 b', moves: [] })
    expect(store.getState().result).toBe('redWins')
  })

  it('每局一实例：两个 store 互不影响（铁律 #6）', () => {
    const a = createGameStore({ mode: 'humanVsHuman' })
    const b = createGameStore({ mode: 'humanVsHuman' })
    a.getState().vm.onTap(0, 9)
    expect(a.getState().selected).not.toBeNull()
    expect(b.getState().selected).toBeNull()
  })
})
