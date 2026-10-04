/**
 * LlmGameSettings（05 文档 §9，llm_settings.dart 1:1）：clamp / 枚举回落 / 键名。
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LLM_SETTINGS,
  LLM_SETTING_KEYS,
  LLM_SETTINGS_PREFIX,
  llmSettingsFromRaw,
  llmSettingsToMap,
  resolveTimeoutSeconds,
  type LlmSettingsRaw
} from '@packages/llm'

/** 测试便捷：裸字段名 → electron-store 全名 */
const raw = (o: Record<string, unknown>): LlmSettingsRaw =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [`llm_settings_${k}`, v]))

describe('LlmGameSettings.fromRaw（越界一律 clamp 回默认）', () => {
  it('全缺省 → 默认值', () => {
    expect(llmSettingsFromRaw({})).toEqual(DEFAULT_LLM_SETTINGS)
  })

  it('timeoutSeconds 0 → 5（0 会让每次调用秒失败）；700 → 600', () => {
    expect(llmSettingsFromRaw(raw({ timeoutSeconds: 0 })).timeoutSeconds).toBe(5)
    expect(llmSettingsFromRaw(raw({ timeoutSeconds: 700 })).timeoutSeconds).toBe(600)
    expect(llmSettingsFromRaw(raw({ timeoutSeconds: 120 })).timeoutSeconds).toBe(120)
  })

  it('maxAttempts 0 → 1（0 会跳过全部重试）；99 → 10', () => {
    expect(llmSettingsFromRaw(raw({ maxAttempts: 0 })).maxAttempts).toBe(1)
    expect(llmSettingsFromRaw(raw({ maxAttempts: 99 })).maxAttempts).toBe(10)
  })

  it('intervalSeconds 0 合法；61 → 60', () => {
    expect(llmSettingsFromRaw(raw({ intervalSeconds: 0 })).intervalSeconds).toBe(0)
    expect(llmSettingsFromRaw(raw({ intervalSeconds: 61 })).intervalSeconds).toBe(60)
  })

  it('strengthBlend -1 → 0；101 → 100', () => {
    expect(llmSettingsFromRaw(raw({ strengthBlend: -1 })).strengthBlend).toBe(0)
    expect(llmSettingsFromRaw(raw({ strengthBlend: 101 })).strengthBlend).toBe(100)
  })

  it('advisorDifficulty 2 → 2；0 → 1；9 → 5', () => {
    expect(llmSettingsFromRaw(raw({ advisorDifficulty: 2 })).advisorDifficulty).toBe(2)
    expect(llmSettingsFromRaw(raw({ advisorDifficulty: 0 })).advisorDifficulty).toBe(1)
    expect(llmSettingsFromRaw(raw({ advisorDifficulty: 9 })).advisorDifficulty).toBe(5)
  })

  it('fallbackIndex 越界/负数 → builtinAi；1 → resign', () => {
    expect(llmSettingsFromRaw(raw({ fallbackIndex: 1 })).fallback).toBe('resign')
    expect(llmSettingsFromRaw(raw({ fallbackIndex: 7 })).fallback).toBe('builtinAi')
    expect(llmSettingsFromRaw(raw({ fallbackIndex: -1 })).fallback).toBe('builtinAi')
    expect(llmSettingsFromRaw(raw({ fallbackIndex: 1.5 })).fallback).toBe('builtinAi')
  })

  it('advisorModeIndex 0/1/2 → off/candidate/gate；3 → candidate', () => {
    expect(llmSettingsFromRaw(raw({ advisorModeIndex: 0 })).advisorMode).toBe('off')
    expect(llmSettingsFromRaw(raw({ advisorModeIndex: 1 })).advisorMode).toBe('candidate')
    expect(llmSettingsFromRaw(raw({ advisorModeIndex: 2 })).advisorMode).toBe('gate')
    expect(llmSettingsFromRaw(raw({ advisorModeIndex: 3 })).advisorMode).toBe('candidate')
  })

  it('引擎类型（DR-014）：缺省 → llm；index 1 → builtin；越界 → llm', () => {
    expect(llmSettingsFromRaw({}).humanVsLlmOpponentType).toBe('llm')
    const s = llmSettingsFromRaw(
      raw({
        redSideType: 1,
        blackSideType: 1,
        humanVsLlmOpponentType: 1
      })
    )
    expect(s.redSideType).toBe('builtin')
    expect(s.blackSideType).toBe('builtin')
    expect(s.humanVsLlmOpponentType).toBe('builtin')
    const s2 = llmSettingsFromRaw(
      raw({ redSideType: 9, blackSideType: -1, humanVsLlmOpponentType: 2.5 })
    )
    expect(s2.redSideType).toBe('llm')
    expect(s2.blackSideType).toBe('llm')
    expect(s2.humanVsLlmOpponentType).toBe('llm')
  })

  it('红黑强度缺省回落 strengthBlend（原始值 clamp 后）', () => {
    const s = llmSettingsFromRaw(raw({ strengthBlend: 75 }))
    expect(s.redStrengthBlend).toBe(75)
    expect(s.blackStrengthBlend).toBe(75)
    const s2 = llmSettingsFromRaw(raw({ strengthBlend: 999, redStrengthBlend: 30 }))
    expect(s2.strengthBlend).toBe(100)
    expect(s2.redStrengthBlend).toBe(30)
  })

  it('非数值类型按缺省处理', () => {
    const s = llmSettingsFromRaw(
      raw({
        timeoutSeconds: 'abc' as unknown as number,
        maxAttempts: null as unknown as number
      })
    )
    expect(s.timeoutSeconds).toBe(60)
    expect(s.maxAttempts).toBe(3)
  })
})

describe('键名与映射（Key 原样保留，07 §3）', () => {
  it('llm_settings_ 前缀 + Dart 字段名', () => {
    expect(LLM_SETTINGS_PREFIX).toBe('llm_settings_')
    expect(LLM_SETTING_KEYS.timeoutSeconds).toBe('llm_settings_timeoutSeconds')
    expect(LLM_SETTING_KEYS.fallbackIndex).toBe('llm_settings_fallbackIndex')
    expect(LLM_SETTING_KEYS.advisorModeIndex).toBe('llm_settings_advisorModeIndex')
    expect(LLM_SETTING_KEYS.redStrengthBlend).toBe('llm_settings_redStrengthBlend')
    expect(LLM_SETTING_KEYS.redSideType).toBe('llm_settings_redSideType')
    expect(LLM_SETTING_KEYS.humanVsLlmOpponentType).toBe('llm_settings_humanVsLlmOpponentType')
  })

  it('toMap → fromRaw 往返（枚举转 index，键为 electron-store 全名）', () => {
    const s = llmSettingsFromRaw(
      raw({
        fallbackIndex: 1,
        advisorModeIndex: 2,
        strengthBlend: 80,
        redStrengthBlend: 20,
        blackStrengthBlend: 40
      })
    )
    const map = llmSettingsToMap(s)
    expect(map[LLM_SETTING_KEYS.fallbackIndex]).toBe(1)
    expect(map[LLM_SETTING_KEYS.advisorModeIndex]).toBe(2)
    expect(llmSettingsFromRaw(map)).toEqual(s)
  })
})

describe('resolveTimeoutSeconds（主进程代理空闲超时）', () => {
  it('未配置 → 60；越界 clamp 到 5~600', () => {
    expect(resolveTimeoutSeconds(undefined)).toBe(60)
    expect(resolveTimeoutSeconds(null)).toBe(60)
    expect(resolveTimeoutSeconds(0)).toBe(5)
    expect(resolveTimeoutSeconds(10000)).toBe(600)
    expect(resolveTimeoutSeconds(90)).toBe(90)
  })
})
