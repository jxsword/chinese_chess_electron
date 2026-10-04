/**
 * 对局 VM（对应 board_vm.dart，02 文档 §5；07 文档 §6.2）。
 *
 * 纯 TypeScript（仅依赖 packages/rules）：既被 Zustand 工厂包装供 React 使用，
 * 也可直接在 Vitest/Node 中测试。每局一个实例（铁律 #6），禁止全局单例。
 *
 * 与原版的差异：restore() 原版经 Future.microtask 延迟更新 state，这里改为
 * 同步一次性通知（Zustand 无需规避 uninitialized provider，语义等价）。
 */
import {
  Board,
  samePos,
  inBoard,
  opponentOf,
  type Move,
  type Position,
  type Side
} from '@packages/rules'
import { encodeMoveStack } from '@packages/storage-schema'
import type { GameResult } from '@shared/ipc/types'

/** 对局状态快照（对应 board_state.dart，不可变） */
export interface GameSnapshot {
  fen: string
  /** 走法历史（含棋子/吃子信息，供悔棋与记谱） */
  moveHistory: readonly Move[]
  /** 逐手局面 FEN 序列（初始局面→当前，含轮走方；DR-018 供 L2/L3 使用） */
  fenHistory: readonly string[]
  isRedTurn: boolean
  isCheck: boolean
  /** 对局结果，null 表示进行中 */
  result: GameResult | null
  /** 选中位置 */
  selected: Position | null
  /** 选中棋子的合法走法目标 */
  legalTargets: readonly Position[]
  /** 最近一步（高亮起止点） */
  lastMove: Move | null
}

export interface GameVmConfig {
  /** 棋谱续战/残局来源 FEN；无效回退标准初始局面 */
  initialFen?: string
}

export type Unsubscribe = () => void

function safeBoardFromFen(fen: string | undefined): Board {
  if (fen !== undefined) {
    try {
      return Board.fromFen(fen)
    } catch {
      // FEN 无效回退初始局面，避免崩溃（board_vm.dart:283-287）
    }
  }
  return Board.initial()
}

export class GameVm {
  private _board: Board
  private history: Move[] = []
  /** 逐手局面 FEN（含初始局面，与 history 一一对应+1；executeMove push / undo pop / restore 重放重建） */
  private _fenHistory: string[] = []
  /** 输入锁：AI/LLM 思考期间禁止点击棋盘（board_vm.dart:21） */
  private inputLocked = false
  private readonly listeners = new Set<Unsubscribe>()
  private snap: GameSnapshot

  constructor(config: GameVmConfig = {}) {
    this._board = safeBoardFromFen(config.initialFen)
    this._fenHistory = [this._board.toFen()]
    this.snap = this.buildSnapshot()
  }

  subscribe(listener: Unsubscribe): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** 当前棋盘（board_vm.dart:42；供动画层查询起点棋子等） */
  get board(): Board {
    return this._board
  }

  /** 当前状态快照（board_vm.dart:46） */
  get current(): GameSnapshot {
    return this.snap
  }

  get isRedTurn(): boolean {
    return this._board.isRedTurn
  }

  get isFinished(): boolean {
    return this.snap.result !== null
  }

  /** 用当前棋盘生成快照（board_vm.dart:55-80：终局判定在此统一计算） */
  private buildSnapshot(
    selected: Position | null = null,
    legalTargets: readonly Position[] = [],
    lastMove: Move | null = null
  ): GameSnapshot {
    const turn = this._board.turn
    const isCheck = this._board.isCheck(turn)
    let result: GameResult | null = null
    if (this._board.isCheckmate(turn)) {
      result = turn === 'red' ? 'blackWins' : 'redWins'
    } else if (this._board.isStalemate(turn)) {
      // 困毙（无子可动且未被将军）判困毙方负，中国象棋无逼和（02 §3）
      result = turn === 'red' ? 'blackWins' : 'redWins'
    }
    return {
      fen: this._board.toFen(),
      moveHistory: [...this.history],
      fenHistory: [...this._fenHistory],
      isRedTurn: this._board.isRedTurn,
      isCheck,
      result,
      selected,
      legalTargets,
      lastMove
    }
  }

  private commit(snapshot: GameSnapshot): void {
    this.snap = snapshot
    this.notify()
  }

  /** 恢复历史走法，逐手 replay（board_vm.dart:87-132）。
   * 跳脏记录：长度≠4 / 非整数 / 越界 / 源格无子；完成后仅保留 lastMove 高亮。 */
  restore({ fen, moves }: { fen: string; moves: number[][] }): void {
    try {
      this._board = Board.fromFen(fen)
    } catch {
      this._board = Board.initial()
    }
    this.history = []
    this._fenHistory = [this._board.toFen()]
    for (const m of moves) {
      if (m.length !== 4 || !m.every((n) => Number.isInteger(n))) continue // 跳过不完整的数据
      const from = { col: m[0]!, row: m[1]! }
      const to = { col: m[2]!, row: m[3]! }
      if (!inBoard(from.col, from.row) || !inBoard(to.col, to.row)) continue // 越界跳过
      const piece = this._board.pieceAtP(from)
      if (piece === null) continue // 源格无棋子（数据不一致），跳过
      const applied = this._board.applyMove({ from, to })
      this.history.push({ from: applied.from, to: applied.to, piece, captured: applied.captured })
      this._fenHistory.push(this._board.toFen())
    }
    const lastMove = this.history.length > 0 ? (this.history[this.history.length - 1] ?? null) : null
    this.commit(this.buildSnapshot(null, [], lastMove))
  }

  /**
   * 点击处理（board_vm.dart:140-170）。
   * 输入锁期间/终局后忽略；选中→换选→走子→取消。
   */
  onTap(col: number, row: number): void {
    if (this.inputLocked || this.isFinished) return
    const tapped = this._board.pieceAt(col, row)
    const selected = this.snap.selected

    if (selected !== null) {
      const isLegalTarget = this.snap.legalTargets.some((p) => p.col === col && p.row === row)
      if (isLegalTarget) {
        this.executeMove({ from: selected, to: { col, row } })
        return
      }
      // 点击己方另一棋子 → 切换选中
      if (tapped !== null && tapped.side === this._board.turn) {
        this.select(col, row)
        return
      }
      // 否则取消选中
      this.commit({ ...this.snap, selected: null, legalTargets: [] })
      return
    }

    // 未选中：必须点击己方棋子
    if (tapped !== null && tapped.side === this._board.turn) {
      this.select(col, row)
    }
  }

  private select(col: number, row: number): void {
    const p = { col, row }
    const legal = this._board.legalMovesFor(p).map((m) => m.to)
    this.commit({ ...this.snap, selected: p, legalTargets: legal })
  }

  private executeMove({ from, to }: { from: Position; to: Position }): void {
    const piece = this._board.pieceAtP(from)!
    const applied = this._board.applyMove({ from, to })
    this.history.push({ from: applied.from, to: applied.to, piece, captured: applied.captured })
    this._fenHistory.push(this._board.toFen())
    this.commit({
      ...this.buildSnapshot(),
      selected: null,
      legalTargets: [],
      lastMove: { from: applied.from, to: applied.to, captured: applied.captured }
    })
  }

  /**
   * 强校验走子入口（供 AI/LLM 应手，board_vm.dart:208-217）。
   * 起点须有轮走方棋子且目标 ∈ legalMovesFor；非法返回 false 不改状态——
   * 这是对弈链路的最终裁决点（铁律 #3 的本地落点）。
   */
  playMove(from: Position, to: Position): boolean {
    if (this.isFinished) return false
    const piece = this._board.pieceAtP(from)
    if (piece === null || piece.side !== this._board.turn) return false
    const isLegal = this._board
      .legalMovesFor(from)
      .some((m) => samePos(m.to, to))
    if (!isLegal) return false
    this.executeMove({ from, to })
    return true
  }

  /** 输入锁（AI/LLM 思考期间锁定，board_vm.dart:220-221） */
  lockInput(): void {
    this.inputLocked = true
  }

  unlockInput(): void {
    this.inputLocked = false
  }

  /** 悔一整轮（人机模式：同时撤 AI 应手与玩家最近一手，board_vm.dart:230-244） */
  undoRound(playerSide: Side = 'red'): void {
    if (this.inputLocked || this.history.length === 0) return
    const aiSide = opponentOf(playerSide)
    const lastSide = (): Side | undefined => this.history[this.history.length - 1]?.piece?.side
    if (lastSide() === aiSide) {
      this.undoOnceInternal()
    }
    if (lastSide() === playerSide) {
      this.undoOnceInternal()
      if (lastSide() === aiSide) {
        this.undoOnceInternal()
      }
    }
  }

  /** 悔棋一步（board_vm.dart:249-252） */
  undo(): void {
    if (this.history.length === 0) return
    this.undoOnceInternal()
  }

  private undoOnceInternal(): void {
    const last = this.history.pop()
    if (last === undefined) return
    this._board.undoMove(last)
    this._fenHistory.pop()
    const lastMove = this.history.length > 0 ? (this.history[this.history.length - 1] ?? null) : null
    this.commit({ ...this.buildSnapshot(), selected: null, legalTargets: [], lastMove })
  }

  /** 重置为新游戏（board_vm.dart:266-275） */
  newGame(): void {
    this.inputLocked = false
    this._board = Board.initial()
    this.history = []
    this._fenHistory = [this._board.toFen()]
    this.commit(this.buildSnapshot())
  }

  /** 以指定 FEN 开始新对局；FEN 无效回退初始局面（board_vm.dart:281-294） */
  newGameFromFen(fen: string): void {
    this.inputLocked = false
    this._board = safeBoardFromFen(fen)
    this.history = []
    this._fenHistory = [this._board.toFen()]
    this.commit(this.buildSnapshot())
  }

  /** 认输/判负（loser 方负）：显式终局，防软死锁（board_vm.dart:298-305） */
  resign(loser: Side): void {
    this.inputLocked = false
    this.commit({
      ...this.buildSnapshot(),
      result: loser === 'red' ? 'blackWins' : 'redWins',
      selected: null,
      legalTargets: []
    })
  }

  /** 序列化为可保存数据（board_vm.dart:308-310；moves 为裸四元组） */
  serialize(): { fen: string; moves: number[][] } {
    return { fen: this.current.fen, moves: encodeMoveStack(this.history) }
  }
}
