import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { CC } from '@shared/ipc/channels'
import type { WindowApi } from '@shared/ipc/api'
import type {
  LlmChunkEvent,
  LlmDoneEvent,
  LlmErrorEvent,
  CorpusProgressEvent,
  AppLifecycleEvent,
  Unsubscribe,
  SecureSlot,
  LlmEndpointConfig,
  SaveGameRequest,
  AutoSaveMode,
  GameRecord,
  LlmChatRequest,
  VisionReadBoardRequest,
  CorpusDownloadRequest,
  SaveFileRequest
} from '@shared/ipc/types'

// Preload 层（00 文档 §2 职责铁律）：仅把 WindowApi 逐通道转发到 ipcRenderer，
// 不做业务、不泄露 ipcRenderer 原始对象。事件订阅统一返回反注册函数。

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: WindowApi = {
  llm: {
    chat: (req: LlmChatRequest) => ipcRenderer.invoke(CC.llm.chat, req),
    cancel: (requestId: string) => ipcRenderer.invoke(CC.llm.cancel, { requestId }),
    testConnection: (config: LlmEndpointConfig) => ipcRenderer.invoke(CC.llm.testConnection, { config }),
    onChunk: (listener: (e: LlmChunkEvent) => void) => subscribe<LlmChunkEvent>(CC.llm.chunk, listener),
    onDone: (listener: (e: LlmDoneEvent) => void) => subscribe<LlmDoneEvent>(CC.llm.done, listener),
    onError: (listener: (e: LlmErrorEvent) => void) => subscribe<LlmErrorEvent>(CC.llm.error, listener)
  },
  vision: {
    readBoard: (req: VisionReadBoardRequest) => ipcRenderer.invoke(CC.vision.readBoard, req)
  },
  db: {
    saveGame: (req: SaveGameRequest) => ipcRenderer.invoke(CC.db.saveGame, req),
    loadLatest: (mode: AutoSaveMode) => ipcRenderer.invoke(CC.db.loadLatest, { mode }),
    deleteForMode: (mode: AutoSaveMode) => ipcRenderer.invoke(CC.db.deleteForMode, { mode }),
    recordsList: () => ipcRenderer.invoke(CC.db.recordsList),
    recordsGet: (id: number) => ipcRenderer.invoke(CC.db.recordsGet, { id }),
    recordsSave: (record: Omit<GameRecord, 'id'>) => ipcRenderer.invoke(CC.db.recordsSave, { record }),
    recordsDelete: (id: number) => ipcRenderer.invoke(CC.db.recordsDelete, { id })
  },
  store: {
    get: <T>(key: string) => ipcRenderer.invoke(CC.store.get, { key }) as Promise<T | null>,
    set: (key: string, value: unknown) => ipcRenderer.invoke(CC.store.set, { key, value })
  },
  secure: {
    get: (slot: SecureSlot) => ipcRenderer.invoke(CC.secure.get, { slot }),
    set: (slot: SecureSlot, payload: LlmEndpointConfig) => ipcRenderer.invoke(CC.secure.set, { slot, payload }),
    delete: (slot: SecureSlot) => ipcRenderer.invoke(CC.secure.delete, { slot })
  },
  corpus: {
    download: (req: CorpusDownloadRequest) => ipcRenderer.invoke(CC.corpus.download, req),
    onProgress: (listener: (e: CorpusProgressEvent) => void) =>
      subscribe<CorpusProgressEvent>(CC.corpus.progress, listener),
    scan: (root: string) => ipcRenderer.invoke(CC.corpus.scan, { root }),
    pickDirectory: () => ipcRenderer.invoke(CC.corpus.pickDirectory)
  },
  dialog: {
    saveFile: (req: SaveFileRequest) => ipcRenderer.invoke(CC.dialog.saveFile, req),
    readFile: () => ipcRenderer.invoke(CC.dialog.readFile)
  },
  clipboard: {
    write: (text: string) => ipcRenderer.invoke(CC.clipboard.write, { text })
  },
  app: {
    onLifecycle: (listener: (e: AppLifecycleEvent) => void) =>
      subscribe<AppLifecycleEvent>(CC.app.lifecycle, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
