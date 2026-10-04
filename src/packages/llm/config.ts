/**
 * LLM 端点配置与请求构建（llm_config.dart + llm_move_source.dart:_chat 1:1 移植）。
 *
 * 请求格式（05 文档 §3.1）：OpenAI 兼容 /chat/completions，temperature 0.3、
 * 流式；enable_thinking=false 仅在 disableThinking=true 时发送（其他端点会
 * 忽略未知参数）。Key 只经主进程注入（DR-010）：渲染层持掩码 Key 时走 authSlot。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */
import type { LlmEndpointConfig, SecureSlot } from '@shared/ipc/types'
import { LlmConfigError } from './errors'

/** v1 单次回复的最大 token 数（思考型模型的思维链也计入，需留足预算）。 */
export const MAX_TOKENS_V1 = 4096

/** Prompt v2 的 token 预算（分析段 + 更长历史/清单）。 */
export const MAX_TOKENS_V2 = 8192

/** 端点与模型齐备即认为可调用（部分本地网关允许空 Key，llm_config.dart:27）。 */
export function isConfigured(config: Pick<LlmEndpointConfig, 'baseUrl' | 'model'>): boolean {
  return config.baseUrl.trim() !== '' && config.model.trim() !== ''
}

/**
 * 归一化后的 chat/completions 请求地址（llm_config.dart:32-39）：
 * 用户填根地址（推荐）或完整路径均可——去尾斜杠，无 /chat/completions 则自动补。
 */
export function requestUrl(baseUrl: string): string {
  let url = baseUrl.trim()
  while (url.endsWith('/')) {
    url = url.slice(0, -1)
  }
  if (url.endsWith('/chat/completions')) return url
  return `${url}/chat/completions`
}

export interface BuiltChatRequest {
  url: string
  headers: Record<string, string>
  body: string
  /**
   * 渲染层只见掩码 Key（****+末4位）时携带槽位，由主进程注入真实
   * Authorization（DR-010）；渲染层持完整 Key 时直接内联鉴权头、省略本字段。
   */
  authSlot?: SecureSlot
}

export interface BuildChatOptions {
  /** Prompt v2（max_tokens 8192）或 v1（4096）。 */
  useV2: boolean
  /** 掩码 Key 回读场景下主进程注入鉴权的凭据槽位。 */
  authSlot?: SecureSlot
}

/**
 * 组装一次流式对话请求（llm_move_source.dart:355-374）。
 * 未配置（端点/模型缺失）抛 LlmConfigError（等价 Dart LlmConfigException）。
 */
export function buildChatRequest(
  config: LlmEndpointConfig,
  system: string,
  user: string,
  options: BuildChatOptions
): BuiltChatRequest {
  if (!isConfigured(config)) {
    throw new LlmConfigError('模型端点未配置（需填写端点与模型 ID）')
  }
  const body: Record<string, unknown> = {
    model: config.model.trim(),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.3,
    max_tokens: options.useV2 ? MAX_TOKENS_V2 : MAX_TOKENS_V1,
    stream: true
  }
  // 思考型模型（Qwen3 等）的关闭开关；其他端点会忽略未知参数，
  // 因此仅在用户显式开启时发送（llm_move_source.dart:367-369）。
  if (config.disableThinking) {
    body['enable_thinking'] = false
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream'
  }
  const built: BuiltChatRequest = { url: requestUrl(config.baseUrl), headers, body: JSON.stringify(body) }

  const key = config.apiKey.trim()
  if (key === '') {
    // 本地网关等允许空 Key：不携带鉴权头（llm_move_source.dart:371-373）。
    return built
  }
  if (key.startsWith('****')) {
    // secure.get 回读的掩码 Key：完整 Key 不回渲染层内存（07 §4），走主进程注入。
    if (options.authSlot === undefined) {
      throw new LlmConfigError('模型 API Key 尚未加载完成，请稍候重试或重新保存配置')
    }
    built.authSlot = options.authSlot
    return built
  }
  headers['Authorization'] = `Bearer ${key}`
  return built
}

/** 测试连接的最小请求文本（llm_move_source.dart:488-497）。 */
export const TEST_CONNECTION_SYSTEM = '你是一个连通性测试助手。'
export const TEST_CONNECTION_USER = '请回复：ok'

/** 配置卡"测试连接"请求（单次流式，v1 预算；authSlot 供主进程注入，DR-010）。 */
export function buildTestConnectionChat(
  config: LlmEndpointConfig,
  authSlot?: SecureSlot
): BuiltChatRequest {
  return buildChatRequest(config, TEST_CONNECTION_SYSTEM, TEST_CONNECTION_USER, {
    useV2: false,
    authSlot
  })
}

/** 常用 OpenAI 兼容端点预设（仅公开地址与示例模型 ID，不含任何凭据；llm_config.dart:88-104）。 */
export interface LlmPreset {
  name: string
  baseUrl: string
  exampleModel: string
}

export const LLM_PRESET_CUSTOM: LlmPreset = { name: '自定义', baseUrl: '', exampleModel: '' }

export const LLM_PRESETS: readonly LlmPreset[] = [
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', exampleModel: 'glm-4-flash' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', exampleModel: 'deepseek-chat' },
  { name: 'Kimi（Moonshot）', baseUrl: 'https://api.moonshot.cn/v1', exampleModel: 'moonshot-v1-8k' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', exampleModel: 'openai/gpt-4o-mini' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', exampleModel: 'gpt-4o-mini' },
  LLM_PRESET_CUSTOM
]

/**
 * 视觉理解模型预设（研究助手/识图专用，M6 使用；llm_config.dart:106-137）。
 * 注意区分：qwen-image-*、各类"图片生成"模型走的是原生多模态生成接口，
 * qwen-mt-* 是翻译模型，均不支持 OpenAI 兼容 chat/completions 识图用途。
 */
export const VISION_LLM_PRESETS: readonly LlmPreset[] = [
  {
    name: '通义千问 3.8-Max（旗舰视觉，阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    exampleModel: 'qwen3.8-max'
  },
  {
    name: '通义千问 VL（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    exampleModel: 'qwen-vl-max'
  },
  { name: '智谱 GLM-4.5V（视觉）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', exampleModel: 'glm-4.5v' },
  { name: 'OpenAI GPT-4o mini（视觉）', baseUrl: 'https://api.openai.com/v1', exampleModel: 'gpt-4o-mini' },
  { name: 'OpenRouter（视觉）', baseUrl: 'https://openrouter.ai/api/v1', exampleModel: 'openai/gpt-4o-mini' },
  LLM_PRESET_CUSTOM
]
