/**
 * 内置 AI 棋手（对应 move_source.dart ChessAiMoveSource，03 文档 §7）：
 * 包装引擎三接口，经 EngineClient 走 Web Worker（或同步兜底）。
 * 接口契约：返回的 move 必为合法着法（playMove 仍做最终校验，铁律 #3）。
 * 取消（对局重开/悔棋）以页面 gameSeq 丢弃语义收口；canceled 异常原样上抛。
 */
import type { Board, Move } from '@packages/rules'
import type { MoveSource, MoveSourceResult } from '@packages/engine'
import { EngineClient } from '@renderer/workers/engineClient'
import { CANCELED_ERROR } from '@renderer/workers/engineProtocol'

/** 难度显示名（move_source.dart:96-99）。 */
const DIFFICULTY_NAMES: Record<number, string> = {
  1: '初级',
  2: '中级',
  3: '高级',
  4: '专家',
  5: '大师'
}

export const difficultyName = (difficulty: number): string =>
  DIFFICULTY_NAMES[difficulty] ?? String(difficulty)

export class ChessAiPlayer implements MoveSource {
  constructor(
    private readonly client: EngineClient,
    public readonly difficulty: number = 3
  ) {}

  get displayName(): string {
    return `内置 AI（${difficultyName(this.difficulty)}）`
  }

  async nextMove(board: Board, _history?: readonly Move[]): Promise<MoveSourceResult> {
    let move: Move | null
    try {
      move = await this.client.findBestMove(board.toFen(), { difficulty: this.difficulty })
    } catch (e) {
      if (e instanceof Error && e.message === CANCELED_ERROR) throw e
      const note = e instanceof Error ? e.message : String(e)
      return { status: 'failed', note: `引擎计算失败：${note}` }
    }
    if (move === null) return { status: 'noLegalMove' }
    return { status: 'ok', move }
  }
}
