/**
 * 主进程 → 渲染层生命周期事件分发（07 文档 §2 映射表的渲染侧收口）。
 *
 * 模块级回调注册表：仅持有"保存"回调（不持任何对局状态，不违铁律 #6）。
 * 等价原版 WidgetsBindingObserver 机制：窗口 blur/minimize/close 与 before-quit
 * 经 cc:app:lifecycle 到达 App 级桥接组件后广播给各页面的 GameAutoSave。
 */
import type { AppLifecyclePhase } from '@shared/ipc/types'
import type { Unsubscribe } from '@renderer/stores/gameVm'

const listeners = new Set<(phase: AppLifecyclePhase) => void>()

export function subscribeLifecycle(listener: (phase: AppLifecyclePhase) => void): Unsubscribe {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyLifecycle(phase: AppLifecyclePhase): void {
  for (const listener of [...listeners]) listener(phase)
}
