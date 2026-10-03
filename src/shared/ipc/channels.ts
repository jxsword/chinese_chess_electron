// IPC 通道名常量（00 文档 §3.1 通道清单，字面锁定，改动须同步 contract 测试与设计文档）
export const CC = {
  llm: {
    chat: 'cc:llm:chat',
    chunk: 'cc:llm:chunk',
    done: 'cc:llm:done',
    error: 'cc:llm:error',
    cancel: 'cc:llm:cancel',
    testConnection: 'cc:llm:testConnection'
  },
  vision: {
    readBoard: 'cc:vision:readBoard'
  },
  db: {
    saveGame: 'cc:db:saveGame',
    loadLatest: 'cc:db:loadLatest',
    deleteForMode: 'cc:db:deleteForMode',
    recordsList: 'cc:db:records:list',
    recordsGet: 'cc:db:records:get',
    recordsSave: 'cc:db:records:save',
    recordsDelete: 'cc:db:records:delete'
  },
  store: {
    get: 'cc:store:get',
    set: 'cc:store:set'
  },
  secure: {
    get: 'cc:secure:get',
    set: 'cc:secure:set',
    delete: 'cc:secure:delete'
  },
  corpus: {
    download: 'cc:corpus:download',
    progress: 'cc:corpus:progress',
    scan: 'cc:corpus:scan',
    pickDirectory: 'cc:corpus:pickDirectory'
  },
  dialog: {
    saveFile: 'cc:dialog:saveFile',
    readFile: 'cc:dialog:readFile'
  },
  clipboard: {
    write: 'cc:clipboard:write'
  },
  app: {
    lifecycle: 'cc:app:lifecycle'
  }
} as const

// Worker 消息类型（00 文档 §3.2：cc:engine:*/cc:solver:*/cc:parser:* 不经 IPC，走 postMessage）
export const WORKER_MESSAGE_TYPES = [
  'findBestMoveEx',
  'evaluateMove',
  'solve',
  'parseBatch',
  'cancel'
] as const

export type WorkerMessageType = (typeof WORKER_MESSAGE_TYPES)[number]

/** Worker 请求信封（00 文档 §3.2） */
export interface WorkerRequest<T = unknown> {
  id: string
  type: WorkerMessageType
  payload: T
}

/** Worker 响应信封（00 文档 §3.2） */
export interface WorkerResponse<T = unknown> {
  id: string
  ok: boolean
  result?: T
  error?: string
  progress?: { done: number; total: number }
}
