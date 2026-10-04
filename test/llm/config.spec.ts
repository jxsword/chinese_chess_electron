/**
 * 请求构建用例（T4.2，05 §3.1 请求格式；llm_config.dart / llm_move_source.dart:_chat）。
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_TOKENS_V1,
  MAX_TOKENS_V2,
  LLM_PRESETS,
  VISION_LLM_PRESETS,
  TEST_CONNECTION_SYSTEM,
  TEST_CONNECTION_USER,
  buildChatRequest,
  buildTestConnectionChat,
  isEmptyLlmConfig,
  isConfigured,
  requestUrl,
  resolveLlmSideConfig,
  LlmConfigError
} from '@packages/llm'
import type { LlmEndpointConfig } from '@shared/ipc/types'

const cfg = (over: Partial<LlmEndpointConfig> = {}): LlmEndpointConfig => ({
  baseUrl: 'https://api.example.com/v1',
  apiKey: '',
  model: 'test-model',
  disableThinking: false,
  ...over
})

describe('requestUrl（去尾斜杠 + 自动补 /chat/completions）', () => {
  it('根地址补全', () => {
    expect(requestUrl('https://a.com/v1')).toBe('https://a.com/v1/chat/completions')
    expect(requestUrl('https://a.com')).toBe('https://a.com/chat/completions')
  })

  it('尾斜杠去除', () => {
    expect(requestUrl('https://a.com/v1/')).toBe('https://a.com/v1/chat/completions')
    expect(requestUrl('https://a.com/v1///')).toBe('https://a.com/v1/chat/completions')
  })

  it('已含 /chat/completions 不重复补', () => {
    expect(requestUrl('https://a.com/v1/chat/completions')).toBe(
      'https://a.com/v1/chat/completions'
    )
    expect(requestUrl('https://a.com/v1/chat/completions/')).toBe(
      'https://a.com/v1/chat/completions'
    )
  })
})

describe('isConfigured（端点与模型齐备即可，Key 可空）', () => {
  it('空端点/空模型/正常', () => {
    expect(isConfigured(cfg({ baseUrl: ' ', model: 'm' }))).toBe(false)
    expect(isConfigured(cfg({ baseUrl: 'https://a.com', model: '  ' }))).toBe(false)
    expect(isConfigured(cfg())).toBe(true)
  })
})

describe('buildChatRequest（05 §3.1 请求体）', () => {
  it('v1 请求体：temperature 0.3 / max_tokens 4096 / stream true', () => {
    const built = buildChatRequest(cfg(), 'SYS', 'USR', { useV2: false })
    expect(built.url).toBe('https://api.example.com/v1/chat/completions')
    expect(JSON.parse(built.body)).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'USR' }
      ],
      temperature: 0.3,
      max_tokens: MAX_TOKENS_V1,
      stream: true
    })
  })

  it('v2 请求体：max_tokens 8192', () => {
    const built = buildChatRequest(cfg(), 'S', 'U', { useV2: true })
    expect(JSON.parse(built.body)['max_tokens']).toBe(MAX_TOKENS_V2)
  })

  it('disableThinking=true 才发送 enable_thinking:false', () => {
    const on = buildChatRequest(cfg({ disableThinking: true }), 'S', 'U', { useV2: false })
    expect(JSON.parse(on.body)['enable_thinking']).toBe(false)
    const off = buildChatRequest(cfg({ disableThinking: false }), 'S', 'U', { useV2: false })
    expect('enable_thinking' in JSON.parse(off.body)).toBe(false)
  })

  it('空 Key：不携带鉴权头（本地网关）', () => {
    const built = buildChatRequest(cfg({ apiKey: '  ' }), 'S', 'U', { useV2: false })
    expect(built.headers['Authorization']).toBeUndefined()
    expect(built.authSlot).toBeUndefined()
    expect(built.headers['Content-Type']).toBe('application/json')
    expect(built.headers['Accept']).toBe('text/event-stream')
  })

  it('完整 Key：内联 Bearer 鉴权头', () => {
    const built = buildChatRequest(cfg({ apiKey: 'sk-full-1234' }), 'S', 'U', { useV2: false })
    expect(built.headers['Authorization']).toBe('Bearer sk-full-1234')
    expect(built.authSlot).toBeUndefined()
  })

  it('掩码 Key（secure 回读）：无鉴权头 + authSlot 待主进程注入', () => {
    const built = buildChatRequest(cfg({ apiKey: '****1234' }), 'S', 'U', {
      useV2: false,
      authSlot: 'llm_config_black'
    })
    expect(built.headers['Authorization']).toBeUndefined()
    expect(built.authSlot).toBe('llm_config_black')
  })

  it('掩码 Key 但未提供槽位 → 抛错（防裸掩码上外网）', () => {
    expect(() => buildChatRequest(cfg({ apiKey: '****1234' }), 'S', 'U', { useV2: false })).toThrow(
      LlmConfigError
    )
  })

  it('未配置端点 → 抛 LlmConfigError（等价 LlmConfigException）', () => {
    expect(() => buildChatRequest(cfg({ baseUrl: '', model: '' }), 'S', 'U', { useV2: false })).toThrow(
      '模型端点未配置（需填写端点与模型 ID）'
    )
  })
})

describe('buildTestConnectionChat（最小请求）', () => {
  it('使用连通性测试提示词与 v1 预算', () => {
    const built = buildTestConnectionChat(cfg())
    const body = JSON.parse(built.body) as Record<string, unknown>
    expect(body['messages']).toEqual([
      { role: 'system', content: TEST_CONNECTION_SYSTEM },
      { role: 'user', content: TEST_CONNECTION_USER }
    ])
    expect(TEST_CONNECTION_SYSTEM).toBe('你是一个连通性测试助手。')
    expect(TEST_CONNECTION_USER).toBe('请回复：ok')
    expect(body['max_tokens']).toBe(MAX_TOKENS_V1)
    expect(body['stream']).toBe(true)
  })
})

describe('双方共用模型：空侧运行时跟随对方（DR-012）', () => {
  const RED_SLOT = 'llm_config_red' as const
  const BLACK_SLOT = 'llm_config_black' as const

  const empty = (): LlmEndpointConfig => ({ baseUrl: '', apiKey: '', model: '', disableThinking: true })

  it('三字段全空（含纯空白）→ 镜像对方配置与对方槽位', () => {
    const other = cfg({ baseUrl: 'https://a.com/v1', apiKey: 'sk-x', model: 'm' })
    expect(isEmptyLlmConfig(empty())).toBe(true)
    expect(isEmptyLlmConfig({ ...empty(), baseUrl: ' ' })).toBe(true)
    const r = resolveLlmSideConfig(empty(), other, RED_SLOT, BLACK_SLOT)
    expect(r.config).toEqual(other)
    expect(r.authSlot).toBe(BLACK_SLOT)
  })

  it('填了任一字段（哪怕只填 Key）→ 不镜像，槽位为自身', () => {
    const own = { ...empty(), apiKey: 'sk-only-key' }
    const other = cfg({ baseUrl: 'https://a.com/v1', model: 'm' })
    expect(isEmptyLlmConfig(own)).toBe(false)
    const r = resolveLlmSideConfig(own, other, RED_SLOT, BLACK_SLOT)
    expect(r.config).toEqual(own)
    expect(r.authSlot).toBe(RED_SLOT)
    expect(isConfigured(r.config)).toBe(false) // 独立无效配置由开始校验拦截
  })

  it('双方都配了同一个模型 → 各用各的（互不影响）', () => {
    const a = cfg({ baseUrl: 'https://a.com/v1', apiKey: 'sk-a', model: 'same-model' })
    const b = cfg({ baseUrl: 'https://a.com/v1', apiKey: 'sk-b', model: 'same-model' })
    expect(resolveLlmSideConfig(a, b, RED_SLOT, BLACK_SLOT).authSlot).toBe(RED_SLOT)
    expect(resolveLlmSideConfig(b, a, BLACK_SLOT, RED_SLOT).authSlot).toBe(BLACK_SLOT)
  })

  it('双方都空 → 相互镜像后仍为空（开始校验拦截）', () => {
    const r = resolveLlmSideConfig(empty(), empty(), RED_SLOT, BLACK_SLOT)
    expect(isConfigured(r.config)).toBe(false)
  })
})

describe('端点预设（仅公开地址与示例模型 ID）', () => {
  it('对话预设含智谱/DeepSeek/Kimi/OpenRouter/OpenAI/自定义', () => {
    expect(LLM_PRESETS.map((p) => p.name)).toEqual([
      '智谱 GLM',
      'DeepSeek',
      'Kimi（Moonshot）',
      'OpenRouter',
      'OpenAI',
      '自定义'
    ])
    expect(LLM_PRESETS[0]).toEqual({
      name: '智谱 GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      exampleModel: 'glm-4-flash'
    })
    expect(LLM_PRESETS[5]!.baseUrl).toBe('')
  })

  it('视觉预设含 qwen-vl-max / glm-4.5v 等（M6 使用）', () => {
    expect(VISION_LLM_PRESETS.map((p) => p.exampleModel)).toContain('qwen-vl-max')
    expect(VISION_LLM_PRESETS.map((p) => p.exampleModel)).toContain('glm-4.5v')
  })
})
