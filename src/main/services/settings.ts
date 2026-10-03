/**
 * 设置存储（electron-store，07 文档 §3）：对应 Flutter shared_preferences。
 * Key 原样保留（global_auto_save / corpus.userPath / llm_settings_*）。
 *
 * electron-store 仅主进程使用（Node API）；测试经 cwd 注入临时目录。
 */
import Store from 'electron-store'
import { SETTING_KEYS } from '@shared/constants'

export interface SettingsOptions {
  /** 存放目录（主进程传 userData；测试传临时目录） */
  cwd?: string
  /** 文件名（默认 settings.json） */
  name?: string
}

export class SettingsService {
  private readonly store: Store<Record<string, unknown>>

  constructor(options: SettingsOptions = {}) {
    this.store = new Store<Record<string, unknown>>({
      name: options.name ?? 'settings',
      cwd: options.cwd,
      // 07 §3 默认值：自动保存开关默认开
      defaults: { [SETTING_KEYS.globalAutoSave]: true }
    })
  }

  get<T = unknown>(key: string): T | null {
    const value = this.store.get(key)
    return value === undefined ? null : (value as T)
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value)
  }

  delete(key: string): void {
    this.store.delete(key)
  }
}
