// window.api 类型化 IPC 契约（00 文档 §2 Preload 层职责：仅暴露类型化 API，不做业务）
// 实现方有两处，类型上都必须精确满足本接口：
//   1. src/main/preload/index.ts（Electron，经 contextBridge + ipcRenderer）
//   2. src/renderer/ipc/mock-api.ts（浏览器 dev:web 模式，00 文档 §6）
import type {
  Unsubscribe,
  LlmChatRequest,
  LlmChunkEvent,
  LlmDoneEvent,
  LlmErrorEvent,
  LlmEndpointConfig,
  LlmTestConnectionResult,
  VisionReadBoardRequest,
  VisionReadBoardResult,
  SaveGameRequest,
  SavedGame,
  AutoSaveMode,
  GameRecord,
  GameRecordSummary,
  CorpusDownloadRequest,
  CorpusProgressEvent,
  CorpusScanResult,
  CorpusEntry,
  CorpusFileBytes,
  PgnIndexEntry,
  SaveFileRequest,
  FileContent,
  AppLifecycleEvent,
  SecureSlot,
  SecureSetResult
} from './types'

export interface WindowApi {
  llm: {
    /**
     * 发起 LLM 流式对话（对应 cc:llm:chat，invoke + 事件流）。
     * 契约：本 promise 仅表示"请求已被受理并处理完毕"，恒 resolve(void)、永不 reject；
     * 一切结局经事件传递——增量 onChunk、正常结束 onDone、失败 onError（消息可能含掩码后的端点信息）。
     * 取消：调 cancel(requestId)，之后不再有任何事件（迟到丢弃在渲染层 store 收口，00 文档 §3.2）。
     */
    chat(req: LlmChatRequest): Promise<void>
    /** 取消在途请求（主进程 AbortController.abort，00 文档 §3.2） */
    cancel(requestId: string): Promise<void>
    /** 配置卡"测试连接"（单次非流式，标准 promise 语义）；authSlot 供主进程注入掩码 Key（DR-010） */
    testConnection(config: LlmEndpointConfig, authSlot?: SecureSlot): Promise<LlmTestConnectionResult>
    onChunk(listener: (e: LlmChunkEvent) => void): Unsubscribe
    onDone(listener: (e: LlmDoneEvent) => void): Unsubscribe
    onError(listener: (e: LlmErrorEvent) => void): Unsubscribe
  }
  vision: {
    /** 视觉识图（非流式 120s×2 重试，05 文档 §7；失败走 promise reject） */
    readBoard(req: VisionReadBoardRequest): Promise<VisionReadBoardResult>
  }
  db: {
    saveGame(req: SaveGameRequest): Promise<void>
    loadLatest(mode: AutoSaveMode): Promise<SavedGame | null>
    deleteForMode(mode: AutoSaveMode): Promise<void>
    recordsList(): Promise<GameRecordSummary[]>
    recordsGet(id: number): Promise<GameRecord | null>
    recordsSave(record: Omit<GameRecord, 'id'>): Promise<number>
    recordsDelete(id: number): Promise<void>
  }
  store: {
    get<T = unknown>(key: string): Promise<T | null>
    set(key: string, value: unknown): Promise<void>
  }
  secure: {
    /** 读取槽位：apiKey 已按 maskedApiKey 语义掩码（****+末4位），完整 Key 不回渲染层（07 文档 §4） */
    get(slot: SecureSlot): Promise<LlmEndpointConfig | null>
    /** 写入槽位；返回实际落盘方式（DR-011：明文回退时界面如实提示） */
    set(slot: SecureSlot, payload: LlmEndpointConfig): Promise<SecureSetResult>
    delete(slot: SecureSlot): Promise<void>
  }
  corpus: {
    /** 语料下载（进度经 onProgress 事件；SSRF/zip-slip 防护在主进程，06 文档 §5） */
    download(req: CorpusDownloadRequest): Promise<void>
    onProgress(listener: (e: CorpusProgressEvent) => void): Unsubscribe
    /** 扫描语料分类（root 为空串时主进程按 用户设置>legacy>默认 解析，06 文档 §1） */
    scan(root: string): Promise<CorpusScanResult>
    /** 列出 XQF 分类下的全部 .xqf 文件（不解析） */
    listEntries(categoryPath: string, categoryName: string): Promise<CorpusEntry[]>
    /** 批量读取 .xqf 文件字节（转交 parser.worker 解析） */
    readFiles(paths: string[]): Promise<CorpusFileBytes[]>
    /** 大 PGN 文件按局偏移索引（流式扫描，06 文档 §4.4） */
    pgnIndex(path: string, maxGames?: number): Promise<PgnIndexEntry[]>
    /** 读取大 PGN 文件中索引指向的单局文本 */
    readPgnGame(path: string, entry: PgnIndexEntry): Promise<string>
    /** 桌面端"选择其他棋谱目录" */
    pickDirectory(): Promise<string | null>
  }
  dialog: {
    /** 存文件：返回所选路径；用户取消返回 null */
    saveFile(req: SaveFileRequest): Promise<string | null>
    /** 读文件（导入棋谱）；用户取消返回 null */
    readFile(): Promise<FileContent | null>
  }
  clipboard: {
    write(text: string): Promise<void>
  }
  app: {
    /** 主进程 → 渲染层生命周期事件（07 文档 §2 映射表） */
    onLifecycle(listener: (e: AppLifecycleEvent) => void): Unsubscribe
  }
}
