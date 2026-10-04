/**
 * 残局演示播放器状态机测试（T6.5，puzzle_vm 9 用例等价集，09 §1/06 §7）：
 * 初始化/推进高亮/completed/慢速倍率/自定义间隔/速度保留/停止重置/
 * 暂停续播/循环重播 + 失步跳过 + 初始化失败 error 态。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import {
  DEMO_INTERVAL_MAX_MS,
  DEMO_INTERVAL_MIN_MS,
  PuzzleDemoPlayer,
  demoIntervalOf
} from '@renderer/stores/puzzleDemo'

afterEach(() => {
  vi.useRealTimers()
})

const PUZZLE = {
  id: 'test',
  initialFen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
  moves: ['h2e2', 'h9g7', 'e3e4']
}

/** 默认参数与间隔换算（慢速 1600 / 正常 800 / 快速 400）。 */
describe('演示参数（puzzle_data.dart:225-278）', () => {
  it('① interval = round(基准间隔 / 倍率)；自定义间隔 clamp 200–4000', () => {
    expect(demoIntervalOf({ speedMultiplier: 0.5, moveInterval: 800, loop: false })).toBe(1600)
    expect(demoIntervalOf({ speedMultiplier: 1, moveInterval: 800, loop: false })).toBe(800)
    expect(demoIntervalOf({ speedMultiplier: 2, moveInterval: 800, loop: false })).toBe(400)
    expect(DEMO_INTERVAL_MIN_MS).toBe(200)
    expect(DEMO_INTERVAL_MAX_MS).toBe(4000)
  })
})

describe('播放状态机（fake timers）', () => {
  function setup(): PuzzleDemoPlayer {
    vi.useFakeTimers()
    const player = new PuzzleDemoPlayer()
    player.initializePuzzle(PUZZLE)
    return player
  }

  it('② 初始化：idle、局面为残局初始局面、无 lastMove', () => {
    const player = setup()
    const s = player.snapshot
    expect(s.status).toBe('idle')
    expect(s.fen).toBe(PUZZLE.initialFen)
    expect(s.lastMove).toBeNull()
    expect(s.currentMoveIndex).toBe(-1)
    expect(s.currentSide).toBe('red')
    player.dispose()
  })

  it('③ 播放推进：走法应用并高亮 lastMove；播完进入 completed（停在末着）', () => {
    const player = setup()
    player.startDemo()
    expect(player.snapshot.status).toBe('playing')

    vi.advanceTimersByTime(850) // 第 1 步 h2e2（红炮平中）
    let s = player.snapshot
    expect(s.currentMoveIndex).toBe(0)
    expect(s.lastMove?.from.col).toBe(7)
    expect(s.lastMove?.from.row).toBe(7)
    expect(s.lastMove?.to.col).toBe(4)
    expect(s.fen).not.toBe(PUZZLE.initialFen)

    vi.advanceTimersByTime(4000) // 播完剩余步 + 心跳越界 → completed
    s = player.snapshot
    expect(s.status).toBe('completed')
    expect(s.currentMoveIndex).toBe(PUZZLE.moves.length - 1)
    player.dispose()
  })

  it('④ 慢速档位按倍率放慢：850ms 未走子，1650ms 才走第 1 步', () => {
    const player = setup()
    player.setSpeedMultiplier(0.5)
    player.startDemo()
    vi.advanceTimersByTime(850)
    expect(player.snapshot.currentMoveIndex).toBe(-1)
    vi.advanceTimersByTime(800)
    expect(player.snapshot.currentMoveIndex).toBe(0)
    expect(player.snapshot.lastMove).not.toBeNull()
    player.dispose()
  })

  it('⑤ 自定义间隔（滑块）按设定毫秒数走子', () => {
    const player = setup()
    player.setCustomInterval(3000)
    player.startDemo()
    vi.advanceTimersByTime(1600)
    expect(player.snapshot.currentMoveIndex).toBe(-1)
    vi.advanceTimersByTime(1500)
    expect(player.snapshot.currentMoveIndex).toBe(0)
    expect(player.snapshot.params.moveInterval).toBe(3000)
    player.dispose()
  })

  it('⑥ 重新初始化保留用户已设速度（点播放不重置速度）', () => {
    const player = setup()
    player.setCustomInterval(4000)
    player.initializePuzzle(PUZZLE)
    player.startDemo()
    expect(player.snapshot.params.moveInterval).toBe(4000)
    vi.advanceTimersByTime(1600)
    expect(player.snapshot.currentMoveIndex).toBe(-1) // 若被重置为 800ms 已走两步
    vi.advanceTimersByTime(2500)
    expect(player.snapshot.currentMoveIndex).toBe(0)
    player.dispose()
  })

  it('⑦ 停止演示：棋盘重置到初始局面（idle、清 lastMove）', () => {
    const player = setup()
    player.startDemo()
    vi.advanceTimersByTime(850)
    player.stopDemo()
    const s = player.snapshot
    expect(s.status).toBe('idle')
    expect(s.currentMoveIndex).toBe(-1)
    expect(s.lastMove).toBeNull()
    expect(s.fen).toBe(PUZZLE.initialFen)
    player.dispose()
  })

  it('⑧ 暂停/续播：暂停不再推进，续播从当前进度继续', () => {
    const player = setup()
    player.startDemo()
    vi.advanceTimersByTime(850) // 1 步
    player.pauseDemo()
    expect(player.snapshot.status).toBe('paused')
    vi.advanceTimersByTime(3000)
    expect(player.snapshot.currentMoveIndex).toBe(0) // 暂停期间不走子
    player.resumeDemo()
    expect(player.snapshot.status).toBe('playing')
    vi.advanceTimersByTime(850)
    expect(player.snapshot.currentMoveIndex).toBe(1)
    player.dispose()
  })

  it('⑨ 循环播放：播完自动重置棋盘从头重播', () => {
    const player = setup()
    player.setDemoLoop(true)
    player.startDemo()
    vi.advanceTimersByTime(2500) // 3 步全部走完
    expect(player.snapshot.currentMoveIndex).toBe(2)
    vi.advanceTimersByTime(800) // 完成心跳 → 循环重置
    const s = player.snapshot
    expect(s.status).toBe('playing')
    expect(s.currentMoveIndex).toBe(-1)
    expect(s.fen).toBe(PUZZLE.initialFen)
    vi.advanceTimersByTime(800)
    expect(player.snapshot.currentMoveIndex).toBe(0) // 第二轮第 1 步
    player.dispose()
  })

  it('⑩ 失步跳过：坐标非法/起点无子的步被跳过不崩溃', () => {
    vi.useFakeTimers()
    const player = new PuzzleDemoPlayer()
    player.initializePuzzle({
      initialFen: '4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1',
      moves: ['a0a9', 'e9e8', 'e0e1']
    })
    player.startDemo()
    vi.advanceTimersByTime(2500) // 三步心跳已过，末着已应用（completed 心跳在 3200ms）
    const s = player.snapshot
    // a0a9 起点 (0,9) 无子 → 跳过；e9e8 应用黑将；e0e1 应用红帅。
    expect(s.lastMove).not.toBeNull()
    expect(s.currentMoveIndex).toBe(2)
    expect(s.status).toBe('playing')
    vi.advanceTimersByTime(800)
    expect(player.snapshot.status).toBe('completed')
    player.dispose()
  })

  it('⑪ 初始化失败（坏 FEN）→ error 态且不可播放', () => {
    vi.useFakeTimers()
    const player = new PuzzleDemoPlayer()
    player.initializePuzzle({ initialFen: 'not-a-fen', moves: [] })
    const s = player.snapshot
    expect(s.status).toBe('error')
    expect(s.error).toContain('初始化残局失败')
    player.startDemo()
    expect(player.snapshot.status).toBe('error')
    player.dispose()
  })
})
