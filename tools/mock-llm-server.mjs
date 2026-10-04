#!/usr/bin/env node
/**
 * 本地 OpenAI 兼容 SSE mock 端点（09 文档 §3 tools 约定；T4.7 手测替代端点）。
 *
 * 用途：无真实 API Key 时手动验收 LLM 全链路——从 user 提示词中解析
 * 「合法着法/候选着法清单」的坐标条目，随机回复一条清单内着法（模拟"只在
 * 清单里选"的合规模型），回复格式符合 Prompt v2（分析段 + 着法行）。
 *
 * 启动：node tools/mock-llm-server.mjs [端口]   （默认 8787）
 * 页面配置：端点 http://127.0.0.1:8787/v1 · Key 任意 · 模型 mock-chess
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const port = Number(process.argv[2] ?? 8787)

/** 从 user 提示词提取清单条目的坐标前缀（b2-e2(…) — 分档 或 纯 b2-e2 均可） */
function extractWhitelist(userContent) {
  const codes = new Set()
  const re = /([a-i]\d)-([a-i]\d)/g
  const listIdx = userContent.indexOf('清单')
  const scope = listIdx >= 0 ? userContent.slice(listIdx) : userContent
  for (const m of scope.matchAll(re)) codes.add(`${m[1]}-${m[2]}`)
  return [...codes]
}

/** SSE 一行 data 写出 */
const sse = (res, payload) => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const server = createServer((req, res) => {
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      /* 忽略解析失败 */
    }
    const user = body.messages?.find((m) => m.role === 'user')?.content ?? ''
    const whitelist = extractWhitelist(user)
    const pick = whitelist.length > 0 ? whitelist[Math.floor(Math.random() * whitelist.length)] : null

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })

    if (pick === null) {
      // 模拟"编造/无法解析"失败路径：不含合法坐标（供失败模式手测）
      const reply = '抱歉，我一时想不出着法。'
      for (const piece of reply.match(/.{1,6}/g) ?? []) {
        sse(res, { choices: [{ delta: { content: piece } }] })
      }
      sse(res, { choices: [{ delta: {} }] })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    const text = `分析: 随机选一步清单内着法（本地 mock）。\n着法: ${pick}`
    for (const piece of text.match(/[\s\S]{1,8}/g) ?? []) {
      sse(res, { choices: [{ delta: { content: piece } }] })
    }
    sse(res, { choices: [{ delta: {} }] })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock LLM 端点已启动：http://127.0.0.1:${port}/v1/chat/completions`)
  console.log('页面配置：端点 http://127.0.0.1:8787/v1 · API Key 任意 · 模型 mock-chess')
  console.log(`请求 id 示例：${randomUUID()}`)
})
