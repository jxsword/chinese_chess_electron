/**
 * 对局页面的"自动保存"挂接（对应 game_auto_save.dart）。
 *
 * 触发时机：离开页面（dispose）与窗口 blur/minimize/进程退出，
 * 且全局设置"自动保存"开启时，把当前棋局静默落入 mode 存档桶。
 * 全局开关关闭时不做任何自动保存，持久化只来自"保存棋局"按钮（saveManual）。
 * canSave（棋谱续战来源 = false）对自动与手动保存同样生效（08 防错 #6）。
 */
import type { AutoSaveMode } from '@shared/ipc/types'
import type { WindowApi } from '@shared/ipc/api'
import type { GameVm } from './gameVm'
import { useGlobalSettings } from './globalSettings'
import { subscribeLifecycle } from './lifecycleRegistry'

export interface GameAutoSaveOptions {
  mode: AutoSaveMode
  /** 序列化来源（传当局 GameVm） */
  vm: GameVm
  /** 页面级附加条件（棋谱/残局续战来源不写模式存档桶）。返回 false 时不保存 */
  canSave?: () => boolean
  /** 保存实现（页面传 api.db；测试注入 mock） */
  repo: Pick<WindowApi['db'], 'saveGame' | 'deleteForMode'>
}

export class GameAutoSave {
  private readonly options: GameAutoSaveOptions
  private unsubscribe: (() => void) | null = null

  constructor(options: GameAutoSaveOptions) {
    this.options = options
  }

  /** 页面挂载后调用：注册生命周期监听（blur/minimize/close/before-quit → saveOnExit） */
  attach(): void {
    if (this.unsubscribe !== null) return
    this.unsubscribe = subscribeLifecycle(() => this.saveOnExit())
  }

  /** 手动保存（"保存棋局"按钮）：不受全局开关限制（game_auto_save.dart:55） */
  saveManual(): boolean {
    return this.write()
  }

  /** 自动保存（离开/后台/退出触发）：受全局开关与页面条件限制（game_auto_save.dart:58-61） */
  saveOnExit(): void {
    if (!useGlobalSettings.getState().autoSave) return
    this.write()
  }

  private write(): boolean {
    const { canSave, repo, vm, mode } = this.options
    if (canSave !== undefined && !canSave()) return false
    const data = vm.serialize()
    void repo.saveGame({ mode, fen: data.fen, moves: data.moves })
    return true
  }

  /** 页面卸载：先触发离开保存，再注销生命周期监听（game_auto_save.dart:73-79） */
  dispose(): void {
    this.saveOnExit()
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}
