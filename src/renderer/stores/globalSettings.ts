/**
 * 全局设置 store（对应 global_settings.dart，07 文档 §3）。
 * 应用级设置（非对局状态），允许单例；对局状态仍必须走 createGameStore 工厂（铁律 #6）。
 */
import { create } from 'zustand'
import { api } from '@renderer/ipc/client'
import { SETTING_KEYS } from '@shared/constants'

interface GlobalSettingsState {
  /** 离开棋盘/应用切后台时自动保存当前棋局。默认开启（07 §3） */
  autoSave: boolean
  /** 是否完成首次加载（设置弹窗每次打开前重新 load，08 §6） */
  loaded: boolean
  load: () => Promise<void>
  setAutoSave: (value: boolean) => Promise<void>
}

export const useGlobalSettings = create<GlobalSettingsState>()((set) => ({
  autoSave: true,
  loaded: false,
  load: async () => {
    try {
      const stored = await api.store.get<boolean>(SETTING_KEYS.globalAutoSave)
      set({ autoSave: stored ?? true, loaded: true })
    } catch {
      // 读失败按默认值（开启）处理（global_settings.dart:22-25）
      set({ autoSave: true, loaded: true })
    }
  },
  setAutoSave: async (value) => {
    set({ autoSave: value })
    try {
      await api.store.set(SETTING_KEYS.globalAutoSave, value)
    } catch {
      // 写失败保留内存值；下次进入设置弹窗会重新 load（global_settings.dart:30-35）
    }
  }
}))
