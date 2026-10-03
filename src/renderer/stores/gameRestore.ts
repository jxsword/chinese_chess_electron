/**
 * 进入对局页面时按模式恢复存档（对应 game_restore.dart，07 文档 §2）。
 *
 * - 有该模式存档且 FEN 有效：replay 重放到 VM，返回 'restored'；
 * - 重放后已分胜负：视为死局，删除该存档并开新局（game_restore.dart:32-37）；
 * - 无存档 / FEN 无效 / 存储异常：开新局。
 */
import type { AutoSaveMode } from '@shared/ipc/types'
import type { WindowApi } from '@shared/ipc/api'
import { isValidFen } from '@packages/rules'
import type { GameVm } from './gameVm'

export type RestoreOutcome = 'restored' | 'newGame'

export interface RestoreOptions {
  mode: AutoSaveMode
  vm: GameVm
  /** 存取实现（页面传 api.db；测试注入 mock） */
  repo: Pick<WindowApi['db'], 'loadLatest' | 'deleteForMode'>
}

export async function restoreOrNewGame({ mode, vm, repo }: RestoreOptions): Promise<RestoreOutcome> {
  try {
    const saved = await repo.loadLatest(mode)
    if (saved !== null && isValidFen(saved.fen)) {
      vm.restore({ fen: saved.fen, moves: saved.moves })
      // restore 同步完成，可直接检查终局（原版经 microtask 后检查）
      if (vm.current.result !== null) {
        // 已分胜负 = 死局：删存档开新局，避免每次进入都恢复同一盘已结束的棋
        await repo.deleteForMode(mode)
        vm.newGame()
        return 'newGame'
      }
      return 'restored'
    }
  } catch {
    // 存储不可用：退化为新局（human_vs_human_page.dart:59-65 同语义）
  }
  vm.newGame()
  return 'newGame'
}
