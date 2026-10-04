import { describe, it, expect, expectTypeOf } from 'vitest'
import { CC, WORKER_MESSAGE_TYPES } from '@shared/ipc/channels'
import type { WindowApi } from '@shared/ipc/api'
import type { LlmEndpointConfig, GameMode, SavedGame, GameRecord } from '@shared/ipc/types'
import { createMockApi } from '@renderer/ipc/mock-api'

// 00 文档 §3.1 通道清单的字面锁定：任何改名必须先改本测试与设计文档
describe('IPC 通道契约（00 §3.1）', () => {
  it('llm 通道', () => {
    expect(CC.llm.chat).toBe('cc:llm:chat')
    expect(CC.llm.chunk).toBe('cc:llm:chunk')
    expect(CC.llm.done).toBe('cc:llm:done')
    expect(CC.llm.error).toBe('cc:llm:error')
    expect(CC.llm.cancel).toBe('cc:llm:cancel')
    expect(CC.llm.testConnection).toBe('cc:llm:testConnection')
  })

  it('vision 通道', () => {
    expect(CC.vision.readBoard).toBe('cc:vision:readBoard')
  })

  it('db 通道（自动存档 + 棋谱库）', () => {
    expect(CC.db.saveGame).toBe('cc:db:saveGame')
    expect(CC.db.loadLatest).toBe('cc:db:loadLatest')
    expect(CC.db.deleteForMode).toBe('cc:db:deleteForMode')
    expect(CC.db.recordsList).toBe('cc:db:records:list')
    expect(CC.db.recordsGet).toBe('cc:db:records:get')
    expect(CC.db.recordsSave).toBe('cc:db:records:save')
    expect(CC.db.recordsDelete).toBe('cc:db:records:delete')
  })

  it('store / secure 通道', () => {
    expect(CC.store.get).toBe('cc:store:get')
    expect(CC.store.set).toBe('cc:store:set')
    expect(CC.secure.get).toBe('cc:secure:get')
    expect(CC.secure.set).toBe('cc:secure:set')
    expect(CC.secure.delete).toBe('cc:secure:delete')
  })

  it('corpus / dialog / clipboard / app 通道', () => {
    expect(CC.corpus.download).toBe('cc:corpus:download')
    expect(CC.corpus.progress).toBe('cc:corpus:progress')
    expect(CC.corpus.scan).toBe('cc:corpus:scan')
    expect(CC.corpus.pickDirectory).toBe('cc:corpus:pickDirectory')
    expect(CC.dialog.saveFile).toBe('cc:dialog:saveFile')
    expect(CC.dialog.readFile).toBe('cc:dialog:readFile')
    expect(CC.clipboard.write).toBe('cc:clipboard:write')
    expect(CC.app.lifecycle).toBe('cc:app:lifecycle')
  })

  it('Worker 消息类型枚举（00 §3.2，不经 IPC）', () => {
    expect(WORKER_MESSAGE_TYPES).toEqual([
      'findBestMoveEx',
      'evaluateMove',
      'solve',
      'parseBatch',
      'cancel'
    ])
  })
})

// 类型层契约：mock 与真实 preload 都必须精确满足 WindowApi
describe('WindowApi 类型契约', () => {
  it('createMockApi 返回值即 WindowApi', () => {
    expectTypeOf(createMockApi).returns.toEqualTypeOf<WindowApi>()
  })

  it('关键载荷类型形状（07 §1/§4）', () => {
    expectTypeOf<LlmEndpointConfig>().toEqualTypeOf<{
      baseUrl: string
      apiKey: string
      model: string
      disableThinking: boolean
    }>()
    expectTypeOf<GameMode>().toEqualTypeOf<
      'humanVsAi' | 'humanVsHuman' | 'aiVsAi' | 'humanVsLlm' | 'llmVsLlm' | 'endgame'
    >()
    expectTypeOf<SavedGame['moves']>().toEqualTypeOf<number[][]>()
    expectTypeOf<GameRecord['moves'][number]['p']>().toEqualTypeOf<string>()
  })
})

// mock 层行为：浏览器模式（dev:web）下的可开发性，语义对齐主进程将来的实现
describe('mock api 行为', () => {
  it('llm.chat：chunk 按序到达，done 文本为全量拼接，promise 静默 resolve', async () => {
    const api = createMockApi()
    const chunks: string[] = []
    let doneText: string | null = null
    api.llm.onChunk((e) => chunks.push(e.delta.content ?? ''))
    api.llm.onDone((e) => {
      doneText = e.text
    })
    await api.llm.chat({ requestId: 'r1', url: 'https://mock.local/v1', headers: {}, body: '{}' })
    expect(chunks.join('')).toBe(doneText)
    expect(doneText!.length).toBeGreaterThan(0)
  })

  it('llm.chat 并发多 requestId 互不串流', async () => {
    const api = createMockApi()
    const gotA: string[] = []
    const gotB: string[] = []
    api.llm.onChunk((e) => {
      if (e.requestId === 'a') gotA.push(e.delta.content ?? '')
      if (e.requestId === 'b') gotB.push(e.delta.content ?? '')
    })
    const pa = api.llm.chat({ requestId: 'a', url: '', headers: {}, body: '{}' })
    const pb = api.llm.chat({ requestId: 'b', url: '', headers: {}, body: '{}' })
    await Promise.all([pa, pb])
    expect(gotA.join('').length).toBeGreaterThan(0)
    expect(gotB.join('').length).toBeGreaterThan(0)
  })

  it('llm.cancel：取消后不再有任何 chunk/done/error 事件', async () => {
    const api = createMockApi()
    const events: string[] = []
    api.llm.onChunk(() => events.push('chunk'))
    api.llm.onDone(() => events.push('done'))
    api.llm.onError(() => events.push('error'))
    void api.llm.chat({ requestId: 'r2', url: '', headers: {}, body: '{}' })
    await api.llm.cancel('r2')
    await new Promise((r) => setTimeout(r, 80))
    expect(events).toEqual([])
  })

  it('llm.testConnection：返回 ok', async () => {
    const api = createMockApi()
    const res = await api.llm.testConnection({
      baseUrl: 'https://mock.local',
      apiKey: 'sk-test-abcd',
      model: 'mock-model',
      disableThinking: true
    })
    expect(res.ok).toBe(true)
  })

  it('db：saved_games 每模式一局 upsert，loadLatest/deleteForMode 语义', async () => {
    const api = createMockApi()
    await api.db.saveGame({ mode: 'humanVsAi', fen: 'FEN-A1', moves: [[0, 0, 1, 1]] })
    await new Promise((r) => setTimeout(r, 5))
    await api.db.saveGame({ mode: 'humanVsAi', fen: 'FEN-A2', moves: [] })
    await new Promise((r) => setTimeout(r, 5))
    await api.db.saveGame({ mode: 'humanVsLlm', fen: 'FEN-B', moves: [] })
    await new Promise((r) => setTimeout(r, 5))
    const latestAi = await api.db.loadLatest('humanVsAi')
    expect(latestAi?.fen).toBe('FEN-A2') // 同模式覆盖而非新增
    const latestLlm = await api.db.loadLatest('humanVsLlm')
    expect(latestLlm?.fen).toBe('FEN-B')
    await api.db.deleteForMode('humanVsAi')
    expect(await api.db.loadLatest('humanVsAi')).toBeNull()
    expect((await api.db.loadLatest('humanVsLlm'))?.fen).toBe('FEN-B')
  })

  it('db：records CRUD 与 get 未知 id 返回 null', async () => {
    const api = createMockApi()
    const record: GameRecord = {
      id: 0,
      title: '测试对局',
      mode: 'humanVsAi',
      initialFen: 'FEN0',
      moves: [{ f: [4, 9], t: [4, 8], p: 'K', x: null }],
      result: 'redWins',
      solveStatus: null,
      solutions: null,
      llmNote: null,
      note: null,
      createdAt: Date.now()
    }
    const id = await api.db.recordsSave(record)
    expect(id).toBeGreaterThan(0)
    expect((await api.db.recordsList()).length).toBe(1)
    const got = await api.db.recordsGet(id)
    expect(got?.title).toBe('测试对局')
    expect(got?.moves[0]?.f).toEqual([4, 9])
    await api.db.recordsDelete(id)
    expect(await api.db.recordsGet(id)).toBeNull()
    expect(await api.db.recordsGet(999)).toBeNull()
  })

  it('store：set/get 往返，缺键返回 null', async () => {
    const api = createMockApi()
    expect(await api.store.get('global_auto_save')).toBeNull()
    await api.store.set('global_auto_save', false)
    expect(await api.store.get('global_auto_save')).toBe(false)
  })

  it('secure：三槽位 set/get/delete', async () => {
    const api = createMockApi()
    const cfg: LlmEndpointConfig = {
      baseUrl: 'https://mock.local',
      apiKey: 'sk-test-abcd',
      model: 'm',
      disableThinking: true
    }
    expect(await api.secure.get('llm_config_red')).toBeNull()
    expect(await api.secure.set('llm_config_red', cfg)).toEqual({ stored: 'encrypted' })
    expect(await api.secure.get('llm_config_red')).toEqual(cfg)
    await api.secure.delete('llm_config_red')
    expect(await api.secure.get('llm_config_red')).toBeNull()
  })

  it('corpus：download 发进度事件后完成；scan 返回分类列表；pickDirectory 可为 null', async () => {
    const api = createMockApi()
    const progress: Array<{ received: number; total: number }> = []
    api.corpus.onProgress((e) => progress.push({ received: e.received, total: e.total }))
    await api.corpus.download({ requestId: 'r3', url: 'https://mock.local/corpus.zip', targetDir: '/tmp/mock' })
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1]?.received).toBe(progress[progress.length - 1]?.total)
    const cats = await api.corpus.scan('/tmp/mock')
    expect(Array.isArray(cats)).toBe(true)
    expect(await api.corpus.pickDirectory()).toBeNull()
  })

  it('dialog / clipboard / app：浏览器 mock 不抛错', async () => {
    const api = createMockApi()
    expect(await api.dialog.saveFile({ defaultName: 'out.pgn', content: '*' })).toBeNull()
    expect(await api.dialog.readFile()).toBeNull()
    await expect(api.clipboard.write('1. 炮二平五')).resolves.toBeUndefined()
    const off = api.app.onLifecycle(() => {})
    expect(typeof off).toBe('function')
    off()
  })
})
