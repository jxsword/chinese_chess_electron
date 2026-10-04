/**
 * 残局演示播放器状态机（06 文档 §7，puzzle_vm.dart 1:1 移植）。
 *
 * 演示时内部持有一块独立于对局的 Board，按定时器逐条把破解走法
 * （ICCS 字符串，行 0 为红方底线约定）应用到棋盘上，经 snapshot 通知 UI 刷新。
 * 状态机 idle → playing → paused/completed/error；循环播放重置棋盘重播；
 * 走子数据与局面不一致（坐标越界、起点无子）时跳过该步防崩溃。
 * 纯 TypeScript：无框架依赖，定时器为真实 setInterval（测试用 fake timers）。
 */
import { Board, type Move } from '@packages/rules'
import { parseIccs } from '@packages/parsers'

/** 演示状态（puzzle_data.dart:207-220）。 */
export type PuzzleDemoStatus = 'idle' | 'playing' | 'paused' | 'completed' | 'error'

/** 演示参数：速度倍率 × 基准间隔（puzzle_data.dart:225-278）。 */
export interface PuzzleDemoParams {
  /** 速度倍率：0.5 慢速 / 1 正常 / 2 快速。 */
  speedMultiplier: number
  /** 基准走子间隔毫秒数（默认 800；滑块自定义 200–4000）。 */
  moveInterval: number
  /** 循环播放。 */
  loop: boolean
}

/** 实际生效间隔 = 基准间隔 / 倍率（慢速 1600 / 正常 800 / 快速 400）。 */
export function demoIntervalOf(params: PuzzleDemoParams): number {
  return Math.round(params.moveInterval / params.speedMultiplier)
}

export const DEMO_SLOW = 0.5
export const DEMO_NORMAL = 1
export const DEMO_FAST = 2

/** 自定义间隔滑块范围（puzzle_detail_page.dart:352-355）。 */
export const DEMO_INTERVAL_MIN_MS = 200
export const DEMO_INTERVAL_MAX_MS = 4000

/** 播放器对 UI 暴露的快照（PuzzleState 对应形状）。 */
export interface PuzzleDemoSnapshot {
  status: PuzzleDemoStatus
  /** 最近一次已应用到棋盘的走法下标；-1 = 尚未走子。 */
  currentMoveIndex: number
  currentSide: 'red' | 'black'
  error: string | null
  /** 当前局面 FEN（未初始化时为 null）。 */
  fen: string | null
  /** 最近一步演示走法（棋盘高亮用，含棋子/被吃信息）。 */
  lastMove: Move | null
  params: PuzzleDemoParams
}

export interface DemoPuzzleInput {
  initialFen: string
  moves: readonly string[]
}

export class PuzzleDemoPlayer {
  private puzzle: DemoPuzzleInput | null = null
  private board: Board | null = null
  private status: PuzzleDemoStatus = 'idle'
  private index = -1
  private side: 'red' | 'black' = 'red'
  private error: string | null = null
  private lastMove: Move | null = null
  private params: PuzzleDemoParams = { speedMultiplier: DEMO_NORMAL, moveInterval: 800, loop: false }
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<(s: PuzzleDemoSnapshot) => void>()

  /** 订阅快照变化；返回反注册函数。 */
  subscribe(listener: (s: PuzzleDemoSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get snapshot(): PuzzleDemoSnapshot {
    return {
      status: this.status,
      currentMoveIndex: this.index,
      currentSide: this.side,
      error: this.error,
      fen: this.board?.toFen() ?? null,
      lastMove: this.lastMove,
      params: { ...this.params }
    }
  }

  /**
   * 初始化残局：重置演示进度与棋盘，但**保留**用户已选的速度与循环
   * （避免每次点"播放"都把速度悄悄重置回默认，puzzle_vm.dart:46-64）。
   */
  initializePuzzle(puzzle: DemoPuzzleInput): void {
    this.puzzle = puzzle
    this.status = 'idle'
    this.index = -1
    this.side = 'red'
    this.error = null
    this.lastMove = null
    this.stopTimer()
    try {
      this.board = Board.fromFen(puzzle.initialFen)
    } catch (e) {
      this.board = null
      this.status = 'error'
      this.error = `初始化残局失败: ${e instanceof Error ? e.message : String(e)}`
    }
    this.emit()
  }

  /** 开始演示。 */
  startDemo(): void {
    if (this.puzzle === null || this.status === 'playing') return
    if (this.board === null) return // 初始化失败（error 态）不可播放
    this.status = 'playing'
    this.emit()
    this.startTimer()
  }

  /** 暂停演示。 */
  pauseDemo(): void {
    if (this.status !== 'playing') return
    this.status = 'paused'
    this.stopTimer()
    this.emit()
  }

  /** 继续演示。 */
  resumeDemo(): void {
    if (this.status !== 'paused' || this.puzzle === null) return
    this.status = 'playing'
    this.emit()
    this.startTimer()
  }

  /** 停止演示：重置进度并回到初始局面。 */
  stopDemo(): void {
    this.status = 'idle'
    this.index = -1
    this.side = 'red'
    this.lastMove = null
    this.stopTimer()
    const puzzle = this.puzzle
    if (puzzle !== null) {
      try {
        this.board = Board.fromFen(puzzle.initialFen)
      } catch {
        this.board = null
      }
    }
    this.emit()
  }

  /** 设置速度倍率（0.5/1/2），播放中即时生效。 */
  setSpeedMultiplier(multiplier: number): void {
    this.params = { ...this.params, speedMultiplier: multiplier }
    this.emit()
    if (this.status === 'playing') this.startTimer()
  }

  /**
   * 设置自定义走子间隔（毫秒/步，速度滑块用；puzzle_vm.dart:122-128 的语义：
   * 覆盖倍率回 1x，播放中即时生效）。
   */
  setCustomInterval(intervalMs: number): void {
    const clamped = Math.min(
      DEMO_INTERVAL_MAX_MS,
      Math.max(DEMO_INTERVAL_MIN_MS, Math.round(intervalMs))
    )
    this.params = { speedMultiplier: DEMO_NORMAL, moveInterval: clamped, loop: this.params.loop }
    this.emit()
    if (this.status === 'playing') this.startTimer()
  }

  /** 设置循环播放。 */
  setDemoLoop(loop: boolean): void {
    this.params = { ...this.params, loop }
    this.emit()
  }

  /** 释放定时器（页面卸载时调用）。 */
  dispose(): void {
    this.stopTimer()
    this.listeners.clear()
  }

  /** 启动（或以新速度重启）走子定时器（puzzle_vm.dart:138-145）。 */
  private startTimer(): void {
    if (this.puzzle === null) return
    this.stopTimer()
    this.timer = setInterval(() => this.onTick(), demoIntervalOf(this.params))
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 定时器心跳：应用下一步走法，或结束/循环演示（puzzle_vm.dart:148-160）。 */
  private onTick(): void {
    const puzzle = this.puzzle
    if (puzzle === null || this.status !== 'playing') return
    if (this.index + 1 < puzzle.moves.length) {
      this.index++
      this.side = this.side === 'red' ? 'black' : 'red'
      this.applyCurrentMove()
      this.emit()
    } else {
      this.completeDemo()
    }
  }

  /**
   * 把当前步的 ICCS 走法应用到演示棋盘；
   * 数据与局面不一致（解析失败、起点无棋子）时跳过该步，避免崩溃。
   */
  private applyCurrentMove(): void {
    const board = this.board
    const puzzle = this.puzzle
    if (board === null || puzzle === null) return
    if (this.index >= puzzle.moves.length) return

    const parsed = parseIccs(puzzle.moves[this.index] ?? '')
    if (parsed === null) return

    const mover = board.pieceAtP(parsed.from)
    if (mover === null) return

    const applied = board.applyMove({ from: parsed.from, to: parsed.to })
    this.lastMove = {
      from: applied.from,
      to: applied.to,
      piece: mover,
      captured: applied.captured
    }
  }

  /** 完成演示：循环则重置棋盘重启定时器重播，否则停在 completed（puzzle_vm.dart:195-217）。 */
  private completeDemo(): void {
    this.status = 'completed'
    this.stopTimer()
    if (this.params.loop) {
      this.index = -1
      this.side = 'red'
      this.lastMove = null
      this.status = 'playing'
      const puzzle = this.puzzle
      if (puzzle !== null) {
        try {
          this.board = Board.fromFen(puzzle.initialFen)
        } catch {
          this.board = null
        }
      }
      this.emit()
      this.startTimer() // 循环播放：重置后立即续跑（06 §7 "循环播放重置棋盘重播"）
      return
    }
    this.emit()
  }

  private emit(): void {
    const snapshot = this.snapshot
    for (const listener of [...this.listeners]) listener(snapshot)
  }
}
