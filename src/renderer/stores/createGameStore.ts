/**
 * 对局 store 工厂（07 文档 §6.1/§6.2，铁律 #6）：进入页面时创建，离开时随组件销毁。
 * 替代原版 Riverpod 全局单例 boardViewModelProvider（切页互相污染的结构性缺陷）。
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import { GameVm, type GameSnapshot } from './gameVm'
import type { GameMode } from '@shared/ipc/types'
import type { Side } from '@packages/rules'

export interface GameStoreConfig {
  /** 归属模式（自动存档桶 / 棋谱入库模式） */
  mode: GameMode
  /** 棋谱续战/残局来源 FEN（canSave 通常应为 false，08 防错 #6） */
  initialFen?: string
  /** 执方（人机/LLM 页使用；默认红） */
  playerSide?: Side
  /** 页面级保存门控（07 §2：棋谱/残局续战来源不写模式存档桶） */
  canSave?: () => boolean
}

export interface GameStoreState extends GameSnapshot {
  /** 每局持有各自 VM 实例（走子/动画层需读棋盘实况） */
  readonly vm: GameVm
  readonly config: GameStoreConfig
}

export type GameStore = StoreApi<GameStoreState>

export function createGameStore(config: GameStoreConfig): GameStore {
  const vm = new GameVm({ initialFen: config.initialFen })
  const store = createStore<GameStoreState>(() => ({
    ...vm.current,
    vm,
    config
  }))
  // VM 快照每次变化整体替换；React 侧经 selector 订阅，避免整树重渲染
  vm.subscribe(() => {
    store.setState({ ...vm.current })
  })
  return store
}
