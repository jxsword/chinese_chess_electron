/**
 * 大模型集成（packages/llm）出口，05 文档。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号。
 * 协议编排（Prompt/解析/参谋/重试/降级）渲染层调用；SSE 重组主进程代理复用。
 */
export { LlmConfigError, LlmApiError, annotateModelHint } from './errors'
export { SseAssembler, type SseDelta, type SseLineResult } from './sse'
export {
  DEFAULT_LLM_SETTINGS,
  LLM_FALLBACK_VALUES,
  LLM_SETTING_KEYS,
  LLM_SETTINGS_PREFIX,
  ADVISOR_MODE_VALUES,
  llmSettingsFromRaw,
  llmSettingsToMap,
  resolveTimeoutSeconds,
  type AdvisorMode,
  type LlmFallback,
  type LlmGameSettings,
  type LlmSettingsRaw
} from './settings'
