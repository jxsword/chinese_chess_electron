/**
 * 可编程 mock SSE 服务器（09 文档 §2.3 / tools 约定）：
 * LlmProxy 走真实 undici（Node fetch）路径连 127.0.0.1，本服务器按脚本逐块推送。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'

export interface MockSseRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

/** 写出/收尾 API：默认 200 + text/event-stream 头在首次 write 懒发送；
 * 需要自定义状态码（如 HTTP 4xx/5xx 场景）时在首次 write 前调用 respond()。 */
export interface MockSseApi {
  write(text: string): Promise<void>
  /** 结束响应；可附带最终数据（如非 200 响应体） */
  end(data?: string): void
  respond(status: number, headers?: Record<string, string>): void
  res: ServerResponse
}

export type MockSseHandler = (req: MockSseRequest, api: MockSseApi) => void | Promise<void>

export interface MockSseServer {
  /** 形如 http://127.0.0.1:PORT 的根地址 */
  url: string
  requests: MockSseRequest[]
  close(): Promise<void>
}

/** SSE data 行便捷构造 */
export const sseData = (payload: string): string => `data: ${payload}\n\n`

/** 延时工具 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function startMockSseServer(handler: MockSseHandler): Promise<MockSseServer> {
  const requests: MockSseRequest[] = []
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })

      let responded = false
      const ensureHead = (): void => {
        if (!responded && !res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          responded = true
        }
      }
      const api: MockSseApi = {
        write: (text) => {
          ensureHead()
          return new Promise<void>((resolve, reject) => {
            res.write(text, (err) => (err ? reject(err) : resolve()))
          })
        },
        end: (data?: string) => {
          ensureHead()
          res.end(data)
        },
        respond: (status, headers) => {
          res.writeHead(status, headers)
          responded = true
        },
        res
      }
      await handler(requests[requests.length - 1]!, api)
      if (!res.writableEnded) api.end()
    })().catch(() => {
      try {
        res.end()
      } catch {
        /* 连接已断开 */
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.close()
      await once(server, 'close')
    }
  }
}
