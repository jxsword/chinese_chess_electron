/**
 * 视觉识图协议（vision_board_reader.dart 1:1 移植，05 文档 §7）。
 *
 * 只负责"图片 → 候选 FEN"的协议面：提示词强约束输出 JSON、JSON 提取、
 * 坐标/棋子字符校验、双王硬校验（识别结果必须经人工核对界面复核后方可
 * 进入求解流程）。HTTP 部分在主进程 visionReader（DR-004：渲染层零外网直连）。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */
import type { BoardGrid } from '@packages/rules'
import { buildFen, pieceFromFenChar } from '@packages/rules'
import { requestUrl } from './config'
import { LlmConfigError } from './errors'

/** 单次识图请求超时（视觉模型大图/思考型可能超过 1 分钟，实测关闭思维链 6~14s）。 */
export const VISION_TIMEOUT_MS = 120_000

/** 识图最多尝试次数（重试 1 次 = 共 2 次，vision_board_reader.dart:47）。 */
export const VISION_MAX_ATTEMPTS = 2

/** 识图 temperature/max_tokens（vision_board_reader.dart:112-113）。 */
export const VISION_TEMPERATURE = 0.1
export const VISION_MAX_TOKENS = 4096

/** 识图 JSON 解析异常（等价 Dart FormatException 路径，消息面向用户）。 */
export class VisionParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VisionParseError'
  }
}

/** system 提示词（vision_board_reader.dart:99，逐字）。 */
export const VISION_SYSTEM_PROMPT =
  '你是中国象棋棋盘识别器，只输出约定的 JSON，不输出任何其他文字。'

/**
 * 识图提示词：强制输出可程序校验的 JSON（vision_board_reader.dart:140-146，逐字）。
 */
export function visionPrompt(): string {
  return (
    '识别图中中国象棋棋盘上的所有棋子。' +
    '以 JSON 回复，不要输出任何其他文字：\n' +
    '{"turn":"red或black","pieces":[{"col":"a-i","row":"0-9","piece":"棋子FEN字符"}]}\n' +
    '约定：行 0 为棋盘顶部（黑方底线），行 9 为底部（红方底线）；' +
    '列 a 在左、i 在右。棋子 FEN 字符：红方大写 ' +
    'K(帅) A(仕) B(相) N(马) R(车) C(炮) P(兵)，黑方小写 ' +
    'k(将) a(士) b(象) n(马) r(车) c(炮) p(卒)。只列实际出现的棋子。'
  )
}

export interface BuiltVisionRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * 组装一次非流式多模态识图请求（vision_board_reader.dart:82-137）。
 * config 为**已解析真实 Key** 的配置（主进程侧构建，掩码注入在其上游完成）；
 * 未配置（端点/模型缺失）抛 LlmConfigError；空 Key 不带鉴权头（本地网关）。
 */
export function buildVisionRequest(
  config: { baseUrl: string; apiKey: string; model: string; disableThinking: boolean },
  dataUrl: string
): BuiltVisionRequest {
  if (config.baseUrl.trim() === '' || config.model.trim() === '') {
    throw new LlmConfigError('视觉模型未配置（需填写端点与模型 ID）')
  }
  const body: Record<string, unknown> = {
    model: config.model.trim(),
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: visionPrompt() }
        ]
      }
    ],
    temperature: VISION_TEMPERATURE,
    max_tokens: VISION_MAX_TOKENS
  }
  // 思考型模型（qwen3.8-max 等）的思维链会把识图拖到 60s 以上
  // （实测关闭后 115s→6s）；与对弈通道一致，由配置开关控制。
  if (config.disableThinking) {
    body['enable_thinking'] = false
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiKey.trim() !== '') {
    headers['Authorization'] = `Bearer ${config.apiKey.trim()}`
  }
  return { url: requestUrl(config.baseUrl), headers, body: JSON.stringify(body) }
}

/** 魔数判 MIME：PNG 头 89 50 4E；其余一律按 JPEG（vision_board_reader.dart:221-229）。 */
export function detectImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e
  ) {
    return 'image/png'
  }
  return 'image/jpeg'
}

/** 剥 markdown 围栏后提取首个 { 到末个 } 的 JSON 对象（vision_board_reader.dart:187-197）。 */
export function extractVisionJson(content: string): Record<string, unknown> {
  let text = content.replaceAll(/```[a-zA-Z]*/g, '').replaceAll('```', '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new VisionParseError('回复中未找到 JSON')
  }
  text = text.slice(start, end + 1)
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new VisionParseError('回复中的 JSON 不是对象')
    }
    return parsed as Record<string, unknown>
  } catch (e) {
    if (e instanceof VisionParseError) throw e
    throw new VisionParseError(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** turn 字段 → 是否红方（解析失败按红方处理，vision_board_reader.dart:178-185）。 */
export function parseVisionTurn(content: string): boolean {
  try {
    const turn = extractVisionJson(content)['turn']
    return `${turn}`.toLowerCase() !== 'black'
  } catch {
    return true
  }
}

/** 单列字母 a-i → 列下标；非法返回 null（vision_board_reader.dart:215-219）。 */
function colIndex(col: unknown): number | null {
  if (typeof col !== 'string' || col.length === 0) return null
  const c = col.toLowerCase().charCodeAt(0) - 97
  return c >= 0 && c <= 8 ? c : null
}

/**
 * 解析模型 JSON 回复为 10×9 棋盘矩阵（vision_board_reader.dart:151-176）。
 * JSON 坏损、坐标越界、未知棋子均抛 VisionParseError；通过后执行双王硬校验。
 */
export function parseVisionPieces(content: string): BoardGrid {
  const json = extractVisionJson(content)
  const pieces = json['pieces']
  if (!Array.isArray(pieces)) {
    throw new VisionParseError('JSON 缺少 pieces 数组')
  }
  const grid: BoardGrid = Array.from({ length: 10 }, () =>
    Array<ReturnType<typeof pieceFromFenChar>>(9).fill(null)
  )
  for (const item of pieces) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const col = colIndex(record['col'])
    const rowRaw = `${record['row'] ?? ''}`
    const row = /^\d+$/.test(rowRaw) ? Number.parseInt(rowRaw, 10) : null
    const piece = typeof record['piece'] === 'string' ? pieceFromFenChar(record['piece']) : null
    if (col === null || row === null || piece === null) {
      throw new VisionParseError(`非法棋子条目: ${JSON.stringify(record)}`)
    }
    if (row < 0 || row > 9 || col < 0 || col > 8) {
      throw new VisionParseError(`坐标越界: col=${String(record['col'])} row=${row}`)
    }
    grid[row][col] = piece
  }
  validateVisionKings(grid)
  return grid
}

/** 双王硬校验：红黑王必须各恰一（vision_board_reader.dart:199-213）。 */
export function validateVisionKings(grid: BoardGrid): void {
  let redKing = 0
  let blackKing = 0
  for (const row of grid) {
    for (const piece of row) {
      if (piece === null || piece.kind !== 'king') continue
      if (piece.side === 'red') redKing++
      else blackKing++
    }
  }
  if (redKing !== 1 || blackKing !== 1) {
    throw new VisionParseError(`双方王数量异常（红 ${redKing} / 黑 ${blackKing}）`)
  }
}

/** 识图成功结果：组装后的完整 FEN（轮走方来自模型识别，可在校正界面修改）。 */
export function visionGridToFen(grid: BoardGrid, isRedTurn: boolean): string {
  return buildFen({ board: grid, isRedTurn })
}

/** 截取响应体前 160 字符（vision_board_reader.dart:231-234）。 */
export function excerptVisionBody(body: string): string {
  const text = body.trim()
  return text.length <= 160 ? text : `${text.slice(0, 160)}…`
}
