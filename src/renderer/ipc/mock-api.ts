import type { WindowApi } from '@shared/ipc/api'
import type {
  Unsubscribe,
  LlmChunkEvent,
  LlmDoneEvent,
  LlmErrorEvent,
  CorpusProgressEvent,
  AppLifecycleEvent,
  LlmEndpointConfig,
  SecureSlot,
  AutoSaveMode,
  SavedGame,
  SaveGameRequest,
  GameRecord,
  GameRecordSummary
} from '@shared/ipc/types'

// 浏览器 mock 实现（00 文档 §6）：LLM 用本地模拟 SSE、DB/存储用内存实现。
// 仅服务于 dev:web 的 UI 开发，不做任何真实 IO；
// 主进程侧的安全语义（safeStorage 加密、apiKey 掩码回读、SSRF 防护）不在此模拟。

const MOCK_REPLY = '您好！这是浏览器模式的模拟回复（mock SSE）。每一句都会按增量分块推送，用于验证流式 UI。'

const CHUNK_INTERVAL_MS = 12
const IO_DELAY_MS = 2

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function splitReply(text: string, size: number): string[] {
  const parts: string[] = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts
}

interface LlmSession {
  timers: Set<ReturnType<typeof setTimeout>>
  cancelled: boolean
}

export function createMockApi(): WindowApi {
  const chunkListeners = new Set<(e: LlmChunkEvent) => void>()
  const doneListeners = new Set<(e: LlmDoneEvent) => void>()
  const errorListeners = new Set<(e: LlmErrorEvent) => void>()
  const progressListeners = new Set<(e: CorpusProgressEvent) => void>()
  const lifecycleListeners = new Set<(e: AppLifecycleEvent) => void>()
  const sessions = new Map<string, LlmSession>()

  const savedGames = new Map<AutoSaveMode, SavedGame>()
  let nextSavedId = 1
  const records: GameRecord[] = []
  let nextRecordId = 1
  const storeMap = new Map<string, unknown>()
  const secureMap = new Map<SecureSlot, LlmEndpointConfig>()

  const api: WindowApi = {
    llm: {
      chat: (req) => {
        return new Promise<void>((resolve) => {
          const session: LlmSession = { timers: new Set(), cancelled: false }
          sessions.set(req.requestId, session)
          const chunks = splitReply(MOCK_REPLY, 16)
          chunks.forEach((piece, i) => {
            const timer = setTimeout(() => {
              session.timers.delete(timer)
              if (session.cancelled) return
              for (const l of chunkListeners) l({ requestId: req.requestId, delta: { content: piece } })
              if (i === chunks.length - 1) {
                for (const l of doneListeners) l({ requestId: req.requestId, text: MOCK_REPLY })
                sessions.delete(req.requestId)
                resolve()
              }
            }, CHUNK_INTERVAL_MS * (i + 1))
            session.timers.add(timer)
          })
        })
      },
      cancel: async (requestId) => {
        const session = sessions.get(requestId)
        if (session) {
          session.cancelled = true
          for (const t of session.timers) clearTimeout(t)
          sessions.delete(requestId)
        }
      },
      testConnection: async () => {
        await delay(IO_DELAY_MS)
        return { ok: true, message: 'mock 连接成功（浏览器模式，未发起真实网络请求）' }
      },onChunk: (listener) => {
        chunkListeners.add(listener)
        return () => chunkListeners.delete(listener)
      },
      onDone: (listener) => {
        doneListeners.add(listener)
        return () => doneListeners.delete(listener)
      },
      onError: (listener) => {
        errorListeners.add(listener)
        return () => errorListeners.delete(listener)
      }
    },
    vision: {
      readBoard: async () => {
        throw new Error('浏览器 mock 不提供识图能力（05 文档 §7，需真实多模态端点）')
      }
    },
    db: {
      saveGame: async (req: SaveGameRequest) => {
        await delay(IO_DELAY_MS)
        const now = Date.now()
        const existing = savedGames.get(req.mode)
        if (existing) {
          existing.fen = req.fen
          existing.moves = req.moves
          existing.updatedAt = now
        } else {
          savedGames.set(req.mode, {
            id: nextSavedId++,
            mode: req.mode,
            fen: req.fen,
            moves: req.moves,
            createdAt: now,
            updatedAt: now
          })
        }
      },
      loadLatest: async (mode) => {
        await delay(IO_DELAY_MS)
        return savedGames.get(mode) ?? null
      },
      deleteForMode: async (mode) => {
        await delay(IO_DELAY_MS)
        savedGames.delete(mode)
      },
      recordsList: async () => {
        await delay(IO_DELAY_MS)
        return records.map<GameRecordSummary>((r) => ({
          id: r.id,
          title: r.title,
          mode: r.mode,
          result: r.result,
          solveStatus: r.solveStatus,
          createdAt: r.createdAt
        }))
      },
      recordsGet: async (id) => {
        await delay(IO_DELAY_MS)
        return records.find((r) => r.id === id) ?? null
      },
      recordsSave: async (record) => {
        await delay(IO_DELAY_MS)
        const withId: GameRecord = { ...record, id: nextRecordId++ }
        records.push(withId)
        return withId.id
      },
      recordsDelete: async (id) => {
        await delay(IO_DELAY_MS)
        const idx = records.findIndex((r) => r.id === id)
        if (idx >= 0) records.splice(idx, 1)
      }
    },
    store: {
      get: async <T>(key: string) => {
        await delay(IO_DELAY_MS)
        return (storeMap.has(key) ? (storeMap.get(key) as T) : null) ?? null
      },
      set: async (key, value) => {
        await delay(IO_DELAY_MS)
        storeMap.set(key, value)
      }
    },
    secure: {
      get: async (slot) => {
        await delay(IO_DELAY_MS)
        return secureMap.get(slot) ?? null
      },
      set: async (slot, payload) => {
        await delay(IO_DELAY_MS)
        secureMap.set(slot, payload)
      },
      delete: async (slot) => {
        await delay(IO_DELAY_MS)
        secureMap.delete(slot)
      }
    },
    corpus: {
      download: (req) => {
        return new Promise<void>((resolve) => {
          const total = 1024 * 512
          const steps = [0.25, 0.5, 0.75, 1]
          steps.forEach((ratio, i) => {
            setTimeout(() => {
              for (const l of progressListeners) {
                l({ requestId: req.requestId, received: Math.round(total * ratio), total })
              }
              if (i === steps.length - 1) resolve()
            }, 8 * (i + 1))
          })
        })
      },
      onProgress: (listener): Unsubscribe => {
        progressListeners.add(listener)
        return () => progressListeners.delete(listener)
      },
      scan: async () => {
        await delay(IO_DELAY_MS)
        return []
      },
      pickDirectory: async () => {
        await delay(IO_DELAY_MS)
        return null
      }
    },
    dialog: {
      saveFile: async () => {
        await delay(IO_DELAY_MS)
        return null
      },
      readFile: async () => {
        await delay(IO_DELAY_MS)
        return null
      }
    },
    clipboard: {
      write: async () => {
        await delay(IO_DELAY_MS)
      }
    },
    app: {
      onLifecycle: (listener) => {
        lifecycleListeners.add(listener)
        return () => lifecycleListeners.delete(listener)
      }
    }
  }

  return api
}
