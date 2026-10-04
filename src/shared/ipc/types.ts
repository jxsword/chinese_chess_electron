// IPC 载荷与领域类型（00 文档 §3.1 + 07 文档 §1/§4 + 05 文档 §3/§7）
// 纯类型层：不得引入 electron / DOM / Node 任何符号（AGENTS 铁律 #1 同等纪律）

/** 事件订阅反注册函数 */
export type Unsubscribe = () => void

/** 对局模式（07 文档 §1.1 game_records.mode 注释的六值枚举） */
export type GameMode = 'humanVsAi' | 'humanVsHuman' | 'aiVsAi' | 'humanVsLlm' | 'llmVsLlm' | 'endgame'

/** 自动存档模式桶：5 个 GameMode，残局闯关不存档（07 文档 §1.2） */
export type AutoSaveMode = Exclude<GameMode, 'endgame'>

/** 对局结果（07 文档 §1.1 result 注释） */
export type GameResult = 'redWins' | 'blackWins' | 'draw'

/** 求解状态（07 文档 §1.1 solve_status 注释） */
export type SolveStatus = 'none' | 'solved' | 'noSolution' | 'timeout'

/** LLM 端点配置（07 文档 §4 三槽位整体 JSON；05 文档 §3.1 请求字段由此组装） */
export interface LlmEndpointConfig {
  baseUrl: string
  apiKey: string
  model: string
  disableThinking: boolean
}

/** safeStorage 三槽位名（07 文档 §4） */
export type SecureSlot = 'llm_config_red' | 'llm_config_black' | 'llm_config_assistant'

// ---------- cc:llm:* ----------

/**
 * cc:llm:chat 请求载荷（00 文档 §3.1；url/body/headers 由渲染层 packages/llm 组装）。
 * authSlot（DR-010）：渲染层只见掩码 Key，携带本槽位时由主进程注入真实
 * Authorization；渲染层持完整 Key（用户刚输入未回读）时直接内联鉴权头、省略本字段。
 */
export interface LlmChatRequest {
  requestId: string
  url: string
  headers: Record<string, string>
  body: string
  authSlot?: SecureSlot
}

/** SSE 增量（00 文档 §3.1 delta：content?/reasoning?） */
export interface LlmDelta {
  content?: string
  reasoning?: string
}

export interface LlmChunkEvent {
  requestId: string
  delta: LlmDelta
}

/** 流结束：正文为空时 text=思维链全文（05 文档 §3.2） */
export interface LlmDoneEvent {
  requestId: string
  text: string
}

export interface LlmErrorEvent {
  requestId: string
  message: string
}

export interface LlmTestConnectionResult {
  ok: boolean
  message: string
}

/** cc:secure:set 结果（DR-011）：主进程如实回报凭据落盘方式 */
export interface SecureSetResult {
  /** encrypted = safeStorage 加密；plainFallback = 系统安全存储不可用，明文回退（0600） */
  stored: 'encrypted' | 'plainFallback'
}

// ---------- cc:vision:* ----------

/** 识图请求（00 文档 §3.1；魔数判 MIME 仅 PNG/JPEG，05 文档 §7） */
export interface VisionReadBoardRequest {
  config: LlmEndpointConfig
  imageBase64: string
  mime: 'image/png' | 'image/jpeg'
}

/** 识图结果：组装 10×9 矩阵后经 Fen.build 得到的盘面（05 文档 §7） */
export interface VisionReadBoardResult {
  fen: string
}

// ---------- cc:db:* ----------

/** cc:db:saveGame 载荷（00 文档 §3.1 {mode, fen, moves}；moves 为裸四元组，07 文档 §1.1/§1.3） */
export interface SaveGameRequest {
  mode: AutoSaveMode
  fen: string
  moves: number[][]
}

/** saved_games 行（每模式一局 upsert，07 文档 §1.1） */
export interface SavedGame {
  id: number
  mode: AutoSaveMode
  fen: string
  moves: number[][]
  createdAt: number
  updatedAt: number
}

/** 棋谱库着法记录（含棋子/被吃 FEN 字符，07 文档 §1.3 moves_json） */
export interface RecordMove {
  f: [number, number]
  t: [number, number]
  p: string
  x: string | null
}

/** game_records 全量行（07 文档 §1.1 表结构驼峰化） */
export interface GameRecord {
  id: number
  title: string
  mode: GameMode
  initialFen: string
  moves: RecordMove[]
  result: GameResult | null
  solveStatus: SolveStatus | null
  /** [["b2e2","h0g2",…], …] ICCS 解法数组的数组（07 文档 §1.1） */
  solutions: string[][] | null
  llmNote: string | null
  note: string | null
  createdAt: number
}

/** 棋谱库列表行（列表筛选 SolveStatus，07 文档 §5） */
export interface GameRecordSummary {
  id: number
  title: string
  mode: GameMode
  result: GameResult | null
  solveStatus: SolveStatus | null
  createdAt: number
}

// ---------- cc:corpus:* ----------

/** cc:corpus:download 载荷（00 文档 §3.1；安全设计见 06 文档 §5，M5 落地） */
export interface CorpusDownloadRequest {
  requestId: string
  url: string
  targetDir: string
}

export interface CorpusProgressEvent {
  requestId: string
  received: number
  total: number
}

/** 语料分类：目录即分类 / 多局合一 .pgns 每文件一分类（06 文档 §1/§4） */
export interface CorpusCategory {
  name: string
  path: string
}

// ---------- cc:dialog:* ----------

/** 导出 PGN 等存文件请求（对应 FilePicker.saveFile） */
export interface SaveFileRequest {
  defaultName: string
  content: string
}

export interface FileContent {
  path: string
  content: string
}

// ---------- cc:app:lifecycle ----------

/** 生命周期相位（00 文档 §3.1 + 07 文档 §2 映射表补充 minimize） */
export type AppLifecyclePhase = 'before-quit' | 'close' | 'blur' | 'minimize'

export interface AppLifecycleEvent {
  phase: AppLifecyclePhase
}
