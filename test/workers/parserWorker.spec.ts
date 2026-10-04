/** parser.worker 协议与客户端用例（06 文档 §6：分批 128 + 进度 + 取消 + 迟到丢弃） */
import { describe, expect, it } from 'vitest'
import {
  CANCELED_ERROR,
  createParserWorkerCore,
  type ParseBatchPayload,
  type ParserRequestMsg,
  type ParserResponseMsg
} from '@renderer/workers/parserProtocol'
import { ParserClient } from '@renderer/workers/parserClient'
import { FEN_INITIAL } from '@packages/rules'
import { buildXqf } from '../helpers/xqfBuilder'

const encoder = new TextEncoder()

function makeFiles(count: number): ParseBatchPayload['files'] {
  const bytes = buildXqf({
    version: 0x0a,
    fen: FEN_INITIAL,
    moves: ['h2e2', 'h9g7']
  })
  return Array.from({ length: count }, (_, i) => ({
    name: i % 4 === 3 ? `file-${i}.pgn` : `file-${i}.xqf`,
    source: '测试谱',
    bytes: i % 4 === 3 ? new Uint8Array(encoder.encode('1. 炮二平五 马8进7\n')) : bytes
  }))
}

describe('parserProtocol 核心', () => {
  it('parseBatch：逐文件回报进度，最终结果与输入等长且有序', () => {
    const core = createParserWorkerCore()
    const responses: ParserResponseMsg[] = []
    const msg: ParserRequestMsg = { id: 'r1', type: 'parseBatch', payload: { files: makeFiles(5) } }
    core.handleRequest(msg, (resp) => responses.push(resp))

    const progresses = responses.filter((r) => r.progress !== undefined)
    expect(progresses.map((r) => r.progress?.done)).toEqual([1, 2, 3, 4, 5])
    const final = responses[responses.length - 1]
    expect(final.ok).toBe(true)
    expect(final.progress).toBeUndefined()
    const result = final.result as { puzzles: Array<{ id: string } | null> }
    expect(result.puzzles).toHaveLength(5)
    // 3 个 XQF 成功 + 1 个 PGN 成功 + 1 个 XQF 成功（i=3 是 PGN）。
    expect(result.puzzles.filter((p) => p !== null)).toHaveLength(5)
  })

  it('损坏文件位为 null，不中断批次', () => {
    const core = createParserWorkerCore()
    const files = makeFiles(2)
    files[0] = { ...files[0], bytes: new Uint8Array([0x00, 0x01, 0x02]) } // 坏魔数
    const responses: ParserResponseMsg[] = []
    core.handleRequest({ id: 'r2', type: 'parseBatch', payload: { files } }, (r) => responses.push(r))
    const final = responses[responses.length - 1]
    const result = final.result as { puzzles: Array<unknown> }
    expect(result.puzzles[0]).toBeNull()
    expect(result.puzzles[1]).not.toBeNull()
  })

  it('cancel：请求到达前已取消直接回 canceled', () => {
    const core = createParserWorkerCore()
    const responses: ParserResponseMsg[] = []
    core.handleRequest({ id: 'r3', type: 'cancel' }, () => {})
    core.handleRequest({ id: 'r3', type: 'parseBatch', payload: { files: makeFiles(1) } }, (r) =>
      responses.push(r)
    )
    expect(responses).toEqual([{ id: 'r3', ok: false, error: CANCELED_ERROR }])
  })
})

describe('ParserClient（同步兜底后端）', () => {
  it('Node 环境无 DOM Worker：走同步后端，进度与结果正常回调', async () => {
    const client = new ParserClient()
    const progress: Array<[number, number]> = []
    const result = await client.parseBatch(makeFiles(3), (done, total) => progress.push([done, total]))
    expect(result.puzzles).toHaveLength(3)
    expect(result.puzzles.every((p) => p !== null)).toBe(true)
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3]
    ])
    client.dispose()
  })

  it('注入 fake worker：消息往返 + 迟到响应按 id 丢弃', async () => {
    const sent: ParserRequestMsg[] = []
    const fakeWorker = {
      postMessage(msg: ParserRequestMsg): void {
        sent.push(msg)
      },
      terminate(): void {},
      onmessage: null as ((e: { data: ParserResponseMsg }) => void) | null,
      onerror: null as ((e: unknown) => void) | null
    }
    const client = new ParserClient(() => fakeWorker, (() => `id-${sent.length + 1}`) as () => string)
    expect(fakeWorker.onmessage).not.toBeNull()
    const deliver = fakeWorker.onmessage as (e: { data: ParserResponseMsg }) => void

    const promise = client.parseBatch(makeFiles(1))
    // 模拟 worker 协议核心响应（同步核心处理请求消息）。
    const core = createParserWorkerCore()
    for (const msg of sent) core.handleRequest(msg, (resp) => deliver({ data: resp }))
    const result = await promise
    expect(result.puzzles).toHaveLength(1)

    // 迟到响应：id 不在 pending 表，不抛错（丢弃语义）。
    expect(() => deliver({ data: { id: 'id-1', ok: true, result: { puzzles: [] } } })).not.toThrow()
    client.dispose()
  })

  it('取消：pending 立即以 canceled 结算', async () => {
    const sent: ParserRequestMsg[] = []
    const fakeWorker = {
      postMessage(msg: ParserRequestMsg): void {
        sent.push(msg)
      },
      terminate(): void {},
      onmessage: null as ((e: { data: ParserResponseMsg }) => void) | null,
      onerror: null as ((e: unknown) => void) | null
    }
    const client = new ParserClient(() => fakeWorker)
    const promise = client.parseBatch(makeFiles(10))
    const cancelId = sent[0].id
    client.cancel(cancelId)
    await expect(promise).rejects.toThrow(CANCELED_ERROR)
    client.dispose()
  })
})
