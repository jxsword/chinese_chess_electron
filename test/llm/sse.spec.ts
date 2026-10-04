/**
 * SseAssembler 单元测试（T4.1，05 文档 §4 第 1+2 层）：
 * 行过滤 / [DONE] / 增量缓冲 / chunk.error / 正文为空退思维链。
 */
import { describe, it, expect } from 'vitest'
import { SseAssembler } from '@packages/llm'
import { LlmApiError } from '@packages/llm'

describe('SseAssembler（05 §4 第 1 层 · 流重组）', () => {
  it('空行与 ":" 注释心跳丢弃继续', () => {
    const s = new SseAssembler()
    expect(s.handleLine('')).toEqual({ ended: false })
    expect(s.handleLine('   ')).toEqual({ ended: false })
    expect(s.handleLine(': OPENROUTER PROCESSING')).toEqual({ ended: false })
    expect(s.handleLine(': keep-alive')).toEqual({ ended: false })
  })

  it('非 data 行与非 JSON data 行忽略', () => {
    const s = new SseAssembler()
    expect(s.handleLine('event: message')).toEqual({ ended: false })
    expect(s.handleLine('data: {not json')).toEqual({ ended: false })
    expect(s.handleLine('data: plain text')).toEqual({ ended: false })
  })

  it('data: [DONE] 结束流', () => {
    const s = new SseAssembler()
    expect(s.handleLine('data: [DONE]')).toEqual({ ended: true })
  })

  it('delta.content 累积正文并转发增量', () => {
    const s = new SseAssembler()
    const r1 = s.handleLine('data: {"choices":[{"delta":{"content":"着法"}}]}')
    const r2 = s.handleLine('data: {"choices":[{"delta":{"content":": b2-e2"}}]}')
    expect(r1.delta).toEqual({ content: '着法' })
    expect(r2.delta).toEqual({ content: ': b2-e2' })
    expect(r1.ended).toBe(false)
    expect(s.content).toBe('着法: b2-e2')
  })

  it('reasoning_content 优先 reasoning，累积思维链', () => {
    const s = new SseAssembler()
    s.handleLine('data: {"choices":[{"delta":{"reasoning_content":"思考A"}}]}')
    s.handleLine('data: {"choices":[{"delta":{"reasoning":"思考B"}}]}')
    s.handleLine('data: {"choices":[{"delta":{"reasoning_content":"思考C"}}]}')
    expect(s.reasoning).toBe('思考A思考B思考C')
  })

  it('chunk.error 抛 LlmApiError（流式响应错误）', () => {
    const s = new SseAssembler()
    expect(() =>
      s.handleLine('data: {"error":{"code":"x","message":"boom"}}')
    ).toThrowError(LlmApiError)
    expect(() => s.handleLine('data: {"error":{"code":"x","message":"boom"}}')).toThrowError(
      /流式响应错误: .*"boom"/
    )
  })

  it('choices 缺失或为空忽略；delta 非 Map 忽略', () => {
    const s = new SseAssembler()
    expect(s.handleLine('data: {"id":"1"}')).toEqual({ ended: false })
    expect(s.handleLine('data: {"choices":[]}')).toEqual({ ended: false })
    expect(s.handleLine('data: {"choices":[{"delta":"str"}]}')).toEqual({ ended: false })
    expect(s.handleLine('data: {"choices":[{"delta":{"content":123}}]}')).toEqual({ ended: false })
  })

  it('整场流：增量→[DONE]，ended 在 DONE 行返回', () => {
    const s = new SseAssembler()
    const lines = [
      'data: {"choices":[{"delta":{"content":"分"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"析"}}]}',
      'data: {"choices":[{"delta":{"content":"\\n着法: h2-e2"}}]}',
      'data: [DONE]'
    ]
    let ended = false
    const deltas: string[] = []
    for (const line of lines) {
      const r = s.handleLine(line)
      if (r.delta?.content !== undefined) deltas.push(r.delta.content)
      if (r.ended) ended = true
    }
    expect(ended).toBe(true)
    expect(deltas.join('')).toBe('分析\n着法: h2-e2')
  })
})

describe('SseAssembler（05 §4 第 2 层 · 文本提取）', () => {
  it('正文非空取正文', () => {
    const s = new SseAssembler()
    s.handleLine('data: {"choices":[{"delta":{"reasoning_content":"内心独白"}}]}')
    s.handleLine('data: {"choices":[{"delta":{"content":"着法: b2-e2"}}]}')
    expect(s.pickAnswer()).toBe('着法: b2-e2')
  })

  it('正文为空（思考型 token 耗尽）退回思维链全文', () => {
    const s = new SseAssembler()
    s.handleLine('data: {"choices":[{"delta":{"reasoning_content":"先出子力"}}]}')
    s.handleLine('data: {"choices":[{"delta":{"reasoning_content":"，再谋中路 着法: b2-e2"}}]}')
    expect(s.pickAnswer()).toBe('先出子力，再谋中路 着法: b2-e2')
  })

  it('两者皆空返回空串', () => {
    const s = new SseAssembler()
    expect(s.pickAnswer()).toBe('')
  })
})
