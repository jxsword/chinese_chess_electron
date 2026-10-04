/**
 * 大模型求解辅助测试（T6.4，05 文档 §6，llm_solve_assist 用例等价集）：
 * 提示词逐字（协议面，改动必须显式 review）、三行格式解析、
 * 首着不在清单 → 追加失败原因重试（≤2 次）、未配置/无着短路。
 */
import { describe, expect, it } from 'vitest'
import { Board } from '@packages/rules'
import {
  SOLVE_ASSIST_SYSTEM,
  parseSolveProposal,
  proposeSolveFirstMove,
  solveAssistUser,
  type LlmTransport
} from '@packages/llm'

/** 双车马闷杀残局（红方 5 条合法着法左右，含两路杀着）。 */
const FEN_A = '3k5/9/9/9/R8/8R/9/9/9/4K4 w - - 0 1'

/** 可编程 fake 传输（收集请求、按脚本回包）。 */
function fakeTransport(responses: Array<string | Error>): { transport: LlmTransport; users: string[] } {
  const users: string[] = []
  let call = 0
  const transport: LlmTransport = {
    chat(req, handlers) {
      users.push(JSON.parse(req.body).messages.find((m: { role: string }) => m.role === 'user').content)
      const idx = call++
      const script = responses[idx]
      queueMicrotask(() => {
        if (script instanceof Error) handlers.onError(script.message)
        else handlers.onDone(script)
      })
      return Promise.resolve()
    },
    cancel: () => Promise.resolve()
  }
  return { transport, users }
}

describe('提示词逐字（llm_solve_assist.dart:17-40，协议面快照）', () => {
  it('system：三行固定格式约束', () => {
    expect(SOLVE_ASSIST_SYSTEM).toBe(
      '你是中国象棋残局研究助手，协助分析一个残局是否有强制将死的杀法。\n' +
        '坐标约定：列用字母 a-i（从左到右），行用数字 0-9' +
        '（0 为黑方底线、棋盘顶部，9 为红方底线、棋盘底部）。\n' +
        '你只能从「合法着法清单」中选择首着，禁止编造清单之外的着法。\n' +
        '\n' +
        '【回复格式（唯一允许的格式，共三行）】\n' +
        '首选着法: 起点-终点\n' +
        '备选着法: 起点-终点（没有则写 无）\n' +
        '思路: 一句话说明攻击目标与关键点\n' +
        '禁止输出其他任何内容。'
    )
  })

  it('user：FEN + ASCII 棋盘图 + 轮走方 + 任务 + 合法着法清单', () => {
    const board = Board.fromFen(FEN_A)
    const user = solveAssistUser(board, ['a4-d4', 'i5-d5'])
    expect(user).toContain(`【局面 FEN】${FEN_A}`)
    expect(user).toContain('【棋盘图（大写为红方、小写为黑方，第一行是黑方底线）】')
    expect(user).toContain('    a b c d e f g h i\n') // ASCII 列标行
    expect(user).toContain('【轮走方】红方（求解方）')
    expect(user).toContain('【任务】判断该局面求解方是否有强制将死的杀法')
    expect(user).toContain('【合法着法清单（共 2 条）】\na4-d4, i5-d5')
  })
})

describe('parseSolveProposal 三行格式解析', () => {
  it('标准三行：首选/备选/思路（备选"无"→null）', () => {
    const p = parseSolveProposal('首选着法: a4-d4\n备选着法: 无\n思路: 双车错，平车闷杀')
    expect(p.firstMoveCode).toBe('a4-d4')
    expect(p.alternateCode).toBeNull()
    expect(p.idea).toBe('双车错，平车闷杀')
  })

  it('备选存在 + 全角冒号 + 坐标杂质容错（复用 extractMove 归一化）', () => {
    const p = parseSolveProposal(
      '首选着法：分析后我选择 a5—d5。\n备选着法: i5-d5\n思路: 控制肋线'
    )
    expect(p.firstMoveCode).toBe('a5-d5')
    expect(p.alternateCode).toBe('i5-d5')
    expect(p.idea).toBe('控制肋线')
  })

  it('缺字段/无坐标 → null（不抛错）', () => {
    expect(parseSolveProposal('我不知道').firstMoveCode).toBeNull()
    expect(parseSolveProposal('首选着法: 无\n思路: 无').firstMoveCode).toBeNull()
  })
})

describe('proposeSolveFirstMove 调用链（Hybrid：提议→验证由调用方负责）', () => {
  const config = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk', model: 'glm-4.5v', disableThinking: true }

  it('成功：提议首着在合法清单 → 返回提议与思路', async () => {
    const { transport } = fakeTransport(['首选着法: a4-d4\n备选着法: 无\n思路: 平车闷杀'])
    const result = await proposeSolveFirstMove(Board.fromFen(FEN_A), config, transport)
    expect(result.proposal?.firstMoveCode).toBe('a4-d4')
    expect(result.message).toBe('平车闷杀')
  })

  it('首着不在清单 → user 末尾追加失败原因重试；第二次通过', async () => {
    const { transport, users } = fakeTransport([
      '首选着法: h0-g2\n思路: 马跳',
      '首选着法: a4-d4\n备选着法: 无\n思路: 闷杀'
    ])
    const result = await proposeSolveFirstMove(Board.fromFen(FEN_A), config, transport)
    expect(result.proposal?.firstMoveCode).toBe('a4-d4')
    expect(users).toHaveLength(2)
    expect(users[1]).toContain('（上次回复无效：回复 h0-g2 不在合法清单中，请严格按三行格式重新回答）')
  })

  it('连续 2 次无效 → 提议 null，说明为最后一次原因', async () => {
    const { transport } = fakeTransport(['好的，我来分析', '首选着法: z9-z9'])
    const result = await proposeSolveFirstMove(Board.fromFen(FEN_A), config, transport)
    expect(result.proposal).toBeNull()
    expect(result.message).toContain('不在合法清单中')
  })

  it('调用失败（onError）→ 重试后仍失败给出错误消息', async () => {
    const { transport } = fakeTransport([new Error('HTTP 500'), new Error('HTTP 502')])
    const result = await proposeSolveFirstMove(Board.fromFen(FEN_A), config, transport)
    expect(result.proposal).toBeNull()
    expect(result.message).toBe('HTTP 502')
  })

  it('未配置短路 / 无合法着法短路', async () => {
    const { transport } = fakeTransport([])
    const unconfigured = await proposeSolveFirstMove(
      Board.fromFen(FEN_A),
      { ...config, baseUrl: '' },
      transport
    )
    expect(unconfigured.proposal).toBeNull()
    expect(unconfigured.message).toBe('研究助手模型未配置')

    // 黑方行棋且无子的局面不存在于工作室（校验拦截），此处用困毙局面验证短路。
    const noMoves = await proposeSolveFirstMove(
      Board.fromFen('R2k1R3/R8/9/9/9/9/9/9/9/4K4 b - - 0 1'),
      config,
      transport
    )
    expect(noMoves.proposal).toBeNull()
    expect(noMoves.message).toBe('当前局面无合法着法')
  })
})
