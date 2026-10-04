/**
 * LLM 对局设置（非敏感项，05 文档 §9；llm_settings.dart 1:1 移植）。
 *
 * - 持久化走 electron-store（cc:store 通道），Key 前缀 llm_settings_ 原样保留；
 * - 枚举以 Dart 的 index 整数存档（fallbackIndex/advisorModeIndex），缺省/越界回落默认；
 * - 数值越界一律 clamp（timeout 0 会让每次调用秒失败、maxAttempts 0 会跳过全部重试）。
 *
 * 纯 TypeScript：渲染层（设置 UI）与主进程（代理空闲超时）共用。
 */

/** 降级策略（llm_move_source.dart:527-533）。 */
export type LlmFallback = 'builtinAi' | 'resign'

/** 引擎参谋模式（hybrid_llm_move_source.dart:15-23）。 */
export type AdvisorMode = 'off' | 'candidate' | 'gate'

export const LLM_FALLBACK_VALUES: readonly LlmFallback[] = ['builtinAi', 'resign']
export const ADVISOR_MODE_VALUES: readonly AdvisorMode[] = ['off', 'candidate', 'gate']

export interface LlmGameSettings {
  /** 空闲超时（秒），5–600。 */
  timeoutSeconds: number
  /** 无效回复最大请求次数（含首次），1–10。 */
  maxAttempts: number
  /** 模型持续失败时的降级策略。 */
  fallback: LlmFallback
  /** 大模型对战每手之间的等待秒数，0–60。 */
  intervalSeconds: number
  /** 引擎参谋模式。 */
  advisorMode: AdvisorMode
  /** 棋力旋钮 0~100：调节候选名单宽度 / 否决阈值。 */
  strengthBlend: number
  /** 参谋引擎搜索深度档（1~5，映射迭代深度 = 档 + 1）。 */
  advisorDifficulty: number
  /** 大模型对战中红方的参谋强度（仅 llm_vs_llm 使用）。 */
  redStrengthBlend: number
  /** 大模型对战中黑方的参谋强度。 */
  blackStrengthBlend: number
}

/** electron-store Key 前缀（07 文档 §3：Key 原样保留）。 */
export const LLM_SETTINGS_PREFIX = 'llm_settings_'

export const DEFAULT_LLM_SETTINGS: LlmGameSettings = {
  timeoutSeconds: 60,
  maxAttempts: 3,
  fallback: 'builtinAi',
  intervalSeconds: 1,
  advisorMode: 'candidate',
  strengthBlend: 50,
  advisorDifficulty: 5,
  redStrengthBlend: 50,
  blackStrengthBlend: 50
}

/** 持久化字段 → electron-store Key（与 llm_settings.dart:125-164 的键名一致）。 */
export const LLM_SETTING_KEYS = {
  timeoutSeconds: `${LLM_SETTINGS_PREFIX}timeoutSeconds`,
  maxAttempts: `${LLM_SETTINGS_PREFIX}maxAttempts`,
  fallbackIndex: `${LLM_SETTINGS_PREFIX}fallbackIndex`,
  intervalSeconds: `${LLM_SETTINGS_PREFIX}intervalSeconds`,
  advisorModeIndex: `${LLM_SETTINGS_PREFIX}advisorModeIndex`,
  strengthBlend: `${LLM_SETTINGS_PREFIX}strengthBlend`,
  advisorDifficulty: `${LLM_SETTINGS_PREFIX}advisorDifficulty`,
  redStrengthBlend: `${LLM_SETTINGS_PREFIX}redStrengthBlend`,
  blackStrengthBlend: `${LLM_SETTINGS_PREFIX}blackStrengthBlend`
} as const

/** toMap()（llm_settings.dart:72-82）：枚举转 index 整数；键为 electron-store 全名。 */
export function llmSettingsToMap(s: LlmGameSettings): Record<string, number> {
  return {
    [LLM_SETTING_KEYS.timeoutSeconds]: s.timeoutSeconds,
    [LLM_SETTING_KEYS.maxAttempts]: s.maxAttempts,
    [LLM_SETTING_KEYS.fallbackIndex]: LLM_FALLBACK_VALUES.indexOf(s.fallback),
    [LLM_SETTING_KEYS.intervalSeconds]: s.intervalSeconds,
    [LLM_SETTING_KEYS.advisorModeIndex]: ADVISOR_MODE_VALUES.indexOf(s.advisorMode),
    [LLM_SETTING_KEYS.strengthBlend]: s.strengthBlend,
    [LLM_SETTING_KEYS.advisorDifficulty]: s.advisorDifficulty,
    [LLM_SETTING_KEYS.redStrengthBlend]: s.redStrengthBlend,
    [LLM_SETTING_KEYS.blackStrengthBlend]: s.blackStrengthBlend
  }
}

/** 持久化原始值形状（electron-store 键名，llmSettingsFromRaw/toMap 共用同一套键）。 */
export type LlmSettingsRaw = Partial<
  Record<(typeof LLM_SETTING_KEYS)[keyof typeof LLM_SETTING_KEYS], unknown>
>

const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 枚举 index 还原：缺省/非整数/越界一律回落默认（Dart 侧缺 index 走 load()
 * 异常→整体默认、越界走 else 分支默认，两条路终点一致）。 */
const pickEnum = <T>(v: unknown, values: readonly T[], dflt: T): T =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < values.length
    ? values[v]!
    : dflt

/**
 * fromRaw（llm_settings.dart:85-118）：缺省/越界均回落默认值或 clamp。
 * 红黑强度缺省回落到 strengthBlend 原始值（可能越界，再 clamp），与 Dart 一致。
 */
export function llmSettingsFromRaw(raw: LlmSettingsRaw): LlmGameSettings {
  const read = (key: keyof typeof LLM_SETTING_KEYS): unknown => raw[LLM_SETTING_KEYS[key]]
  const intOr = (v: unknown, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : dflt
  const strengthBlend = intOr(read('strengthBlend'), 50)
  return {
    timeoutSeconds: clampInt(intOr(read('timeoutSeconds'), 60), 5, 600),
    maxAttempts: clampInt(intOr(read('maxAttempts'), 3), 1, 10),
    fallback: pickEnum(read('fallbackIndex'), LLM_FALLBACK_VALUES, 'builtinAi'),
    intervalSeconds: clampInt(intOr(read('intervalSeconds'), 1), 0, 60),
    advisorMode: pickEnum(read('advisorModeIndex'), ADVISOR_MODE_VALUES, 'candidate'),
    strengthBlend: clampInt(strengthBlend, 0, 100),
    advisorDifficulty: clampInt(intOr(read('advisorDifficulty'), 5), 1, 5),
    redStrengthBlend: clampInt(intOr(read('redStrengthBlend'), strengthBlend), 0, 100),
    blackStrengthBlend: clampInt(intOr(read('blackStrengthBlend'), strengthBlend), 0, 100)
  }
}

/** 主进程代理用：空闲超时秒数（未配置回落默认，越界 clamp）。 */
export function resolveTimeoutSeconds(raw: unknown): number {
  return llmSettingsFromRaw({ [LLM_SETTING_KEYS.timeoutSeconds]: raw }).timeoutSeconds
}
