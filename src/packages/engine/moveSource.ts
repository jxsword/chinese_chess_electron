/**
 * 棋手接口（03 文档 §7，move_source.dart 的 1:1 移植）：
 * 内置引擎与大模型是两个可互换的实现（M4 LlmPlayer/HybridLlmPlayer 复用）。
 * 纯 TypeScript：仅类型与纯函数，禁止 import DOM/Node/React（铁律 #1）。
 */
import type { Board, Move } from '../rules'

/** 棋手一步棋的结果状态。 */
export type MoveSourceStatus = 'ok' | 'noLegalMove' | 'failed'

export interface MoveSourceResult {
  status: MoveSourceStatus
  move?: Move
  /** 思路/解说/失败原因，供状态栏展示。 */
  note?: string
  /** true 表示着法来自兜底而非模型本身（M4 兜底链使用）。 */
  fromFallback?: boolean
}

/**
 * "棋手"抽象。
 * 接口契约：实现必须保证返回的 move 是合法着法；
 * 页面侧的 playMove 仍做最终校验（双保险，move_source.dart:75-86，铁律 #3）。
 */
export interface MoveSource {
  /** 展示名，用于状态栏，如 "内置 AI（高级）" / "glm-4-flash"。 */
  readonly displayName: string

  /** 为 board 的当前走子方寻求一步棋。history 为对局走法记录，可组装上下文。 */
  nextMove(board: Board, history?: readonly Move[]): Promise<MoveSourceResult>
}
