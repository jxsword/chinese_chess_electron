/**
 * LLM 对局设置（非敏感，electron-store；05 文档 §9 + llm_settings.dart:121-169）。
 * 读：逐键取值 → llmSettingsFromRaw（缺省/越界回落）；写：按字段子集逐键写入
 * （electron-store 键值存储下 Dart 的 copyWith 只覆盖本页字段语义结构性成立）。
 */
import { api } from '@renderer/ipc/client'
import {
  LLM_SETTING_KEYS,
  llmSettingsFromRaw,
  llmSettingsToMap,
  type LlmGameSettings
} from '@packages/llm'

/** 读全部对局设置（单键读失败按缺省处理，等价 Dart load 的 try/catch）。 */
export async function loadLlmSettings(): Promise<LlmGameSettings> {
  const keys = Object.values(LLM_SETTING_KEYS)
  const values = await Promise.all(
    keys.map(async (k) => {
      try {
        return await api.store.get<unknown>(k)
      } catch {
        return undefined
      }
    })
  )
  const raw: Record<string, unknown> = {}
  keys.forEach((k, i) => {
    raw[k] = values[i]
  })
  return llmSettingsFromRaw(raw)
}

/** 写全部或指定字段（页面回写只传自己的字段，防清空共享设置）。 */
export async function saveLlmSettings(
  settings: LlmGameSettings,
  fields?: ReadonlyArray<keyof LlmGameSettings>
): Promise<void> {
  const map = llmSettingsToMap(settings)
  const keyOf: Record<keyof LlmGameSettings, string> = {
    timeoutSeconds: LLM_SETTING_KEYS.timeoutSeconds,
    maxAttempts: LLM_SETTING_KEYS.maxAttempts,
    fallback: LLM_SETTING_KEYS.fallbackIndex,
    intervalSeconds: LLM_SETTING_KEYS.intervalSeconds,
    advisorMode: LLM_SETTING_KEYS.advisorModeIndex,
    strengthBlend: LLM_SETTING_KEYS.strengthBlend,
    advisorDifficulty: LLM_SETTING_KEYS.advisorDifficulty,
    redStrengthBlend: LLM_SETTING_KEYS.redStrengthBlend,
    blackStrengthBlend: LLM_SETTING_KEYS.blackStrengthBlend,
    redSideType: LLM_SETTING_KEYS.redSideType,
    blackSideType: LLM_SETTING_KEYS.blackSideType,
    humanVsLlmOpponentType: LLM_SETTING_KEYS.humanVsLlmOpponentType
  }
  const keys = fields ?? (Object.keys(keyOf) as Array<keyof LlmGameSettings>)
  const entries = keys.map((f) => [keyOf[f], map[keyOf[f]]] as const)
  for (const [key, value] of entries) {
    await api.store.set(key, value)
  }
}
