/**
 * 视觉识图协议测试（T6.3，vision_board_reader 15 用例等价集，09 §1）：
 * JSON 提取（围栏/杂质）/ 坐标与棋子校验 / 双王硬校验 / turn 解析 / MIME 魔数 /
 * 请求体组装（多模态消息、非流式参数、enable_thinking 开关）。
 */
import { describe, expect, it } from 'vitest'
import { LlmConfigError } from '@packages/llm'
import {
  VISION_SYSTEM_PROMPT,
  buildVisionRequest,
  detectImageMime,
  excerptVisionBody,
  parseVisionPieces,
  parseVisionTurn,
  validateVisionKings,
  visionGridToFen,
  visionPrompt
} from '@packages/llm/vision'

const okContent = (turn = 'red'): string =>
  JSON.stringify({
    turn,
    pieces: [
      { col: 'd', row: '0', piece: 'k' },
      { col: 'e', row: '9', piece: 'K' },
      { col: 'a', row: '4', piece: 'R' }
    ]
  })

describe('visionPrompt 强约束输出（05 §7）', () => {
  it('① 提示词含 JSON 模板与坐标/棋子约定（快照关键片段）', () => {
    const prompt = visionPrompt()
    expect(prompt).toContain('{"turn":"red或black","pieces":[{"col":"a-i","row":"0-9","piece":"棋子FEN字符"}]}')
    expect(prompt).toContain('行 0 为棋盘顶部（黑方底线）')
    expect(prompt).toContain('K(帅) A(仕) B(相) N(马) R(车) C(炮) P(兵)')
    expect(prompt).toContain('只列实际出现的棋子')
    expect(VISION_SYSTEM_PROMPT).toBe('你是中国象棋棋盘识别器，只输出约定的 JSON，不输出任何其他文字。')
  })
})

describe('JSON 提取（extractVisionJson 路径）', () => {
  it('② 纯 JSON 直接解析', () => {
    const grid = parseVisionPieces(okContent())
    expect(grid[0][3]?.side).toBe('black') // k (d,0)
    expect(grid[9][4]?.side).toBe('red') // K (e,9)
    expect(grid[4][0]?.kind).toBe('rook') // R (a,4)
  })

  it('③ markdown 围栏包裹：剥 ``` 后解析成功', () => {
    const wrapped = '```json\n' + okContent('black') + '\n```'
    expect(parseVisionTurn(wrapped)).toBe(false)
    const grid = parseVisionPieces(wrapped)
    expect(grid[0][3]?.kind).toBe('king')
  })

  it('④ 前后杂质文本：取首个 { 到末个 }', () => {
    const noisy = '好的，识别结果如下：\n' + okContent() + '\n以上。'
    expect(parseVisionPieces(noisy)[9][4]?.kind).toBe('king')
  })

  it('⑤ 无 JSON（未找到 {）：抛"回复中未找到 JSON"', () => {
    expect(() => parseVisionPieces('抱歉，我无法识别该图片')).toThrow('回复中未找到 JSON')
  })
})

describe('坐标/棋子条目校验', () => {
  it('⑥ 坐标越界：row=10 抛"坐标越界"；列字母非法（j）按"非法棋子条目"拦截（对齐 Dart）', () => {
    const badRow = JSON.stringify({
      turn: 'red',
      pieces: [
        { col: 'd', row: '10', piece: 'k' },
        { col: 'e', row: '9', piece: 'K' }
      ]
    })
    expect(() => parseVisionPieces(badRow)).toThrow('坐标越界')
    const badCol = JSON.stringify({
      turn: 'red',
      pieces: [
        { col: 'j', row: '0', piece: 'k' },
        { col: 'e', row: '9', piece: 'K' }
      ]
    })
    expect(() => parseVisionPieces(badCol)).toThrow('非法棋子条目')
  })

  it('⑦ 未知棋子/缺失字段：抛"非法棋子条目"', () => {
    const bad = JSON.stringify({
      turn: 'red',
      pieces: [
        { col: 'd', row: '0', piece: 'x' },
        { col: 'e', row: '9', piece: 'K' }
      ]
    })
    expect(() => parseVisionPieces(bad)).toThrow('非法棋子条目')
    const missing = JSON.stringify({
      turn: 'red',
      pieces: [{ col: 'd', row: '0' }, { col: 'e', row: '9', piece: 'K' }]
    })
    expect(() => parseVisionPieces(missing)).toThrow('非法棋子条目')
  })

  it('⑧ 缺少 pieces 数组：抛"JSON 缺少 pieces 数组"', () => {
    expect(() => parseVisionPieces('{"turn":"red"}')).toThrow('JSON 缺少 pieces 数组')
  })

  it('⑨ 行号数字型（0-9 数值而非字符串）兼容解析', () => {
    const numeric = JSON.stringify({
      turn: 'red',
      pieces: [
        { col: 'd', row: 0, piece: 'k' },
        { col: 'e', row: 9, piece: 'K' }
      ]
    })
    const grid = parseVisionPieces(numeric)
    expect(grid[0][3]?.kind).toBe('king')
  })
})

describe('双王硬校验（_validateKings）', () => {
  it('⑩ 双王非各恰一：硬校验失败（红 1 / 黑 0）', () => {
    const grid = parseVisionPieces(
      JSON.stringify({
        turn: 'red',
        pieces: [
          { col: 'e', row: '9', piece: 'K' },
          { col: 'd', row: '0', piece: 'k' },
          { col: 'a', row: '0', piece: 'r' }
        ]
      })
    )
    // 人工构造"黑王丢失"的矩阵（识别漏检将的典型场景）。
    grid[0][3] = null
    expect(() => validateVisionKings(grid)).toThrow('双方王数量异常（红 1 / 黑 0）')
    // 识别管线整体也在 parse 尾部执行该校验。
    expect(() =>
      parseVisionPieces(
        JSON.stringify({
          turn: 'red',
          pieces: [
            { col: 'e', row: '9', piece: 'K' },
            { col: 'a', row: '0', piece: 'r' }
          ]
        })
      )
    ).toThrow('双方王数量异常')
  })

  it('⑪ 双红王 / 三王同样拒绝', () => {
    const twoRed = JSON.stringify({
      turn: 'red',
      pieces: [
        { col: 'e', row: '9', piece: 'K' },
        { col: 'e', row: '8', piece: 'K' },
        { col: 'd', row: '0', piece: 'k' }
      ]
    })
    expect(() => parseVisionPieces(twoRed)).toThrow('双方王数量异常（红 2 / 黑 1）')
  })
})

describe('turn 解析', () => {
  it('⑫ red/缺失/坏 JSON → 红方；black → 黑方', () => {
    expect(parseVisionTurn(okContent('red'))).toBe(true)
    expect(parseVisionTurn(okContent('black'))).toBe(false)
    expect(parseVisionTurn(okContent('BLACK'))).toBe(false) // 大小写不敏感
    expect(parseVisionTurn('{"pieces":[]}')).toBe(true) // 缺 turn → 红方
    expect(parseVisionTurn('不是 JSON')).toBe(true) // 解析失败 → 红方兜底
  })
})

describe('MIME 魔数（_mimeOf）', () => {
  it('⑬ PNG 头 89 50 4E → image/png；其余一律 image/jpeg', () => {
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png')
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectImageMime(new Uint8Array([0x00, 0x01, 0x02]))).toBe('image/jpeg')
    expect(detectImageMime(new Uint8Array([0x89]))).toBe('image/jpeg') // 不足 3 字节
  })
})

describe('请求体组装（buildVisionRequest）', () => {
  const config = {
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'sk-test',
    model: 'glm-4.5v',
    disableThinking: true
  }

  it('⑭ 多模态消息 + 非流式参数 + enable_thinking=false + Bearer 头 + URL 补全', () => {
    const built = buildVisionRequest(config, 'data:image/png;base64,AAA')
    expect(built.url).toBe('https://api.example.com/v1/chat/completions')
    expect(built.headers['Authorization']).toBe('Bearer sk-test')
    const body = JSON.parse(built.body) as Record<string, unknown>
    expect(body['stream']).toBeUndefined() // 非流式
    expect(body['temperature']).toBe(0.1)
    expect(body['max_tokens']).toBe(4096)
    expect(body['enable_thinking']).toBe(false)
    const messages = body['messages'] as Array<{ role: string; content: unknown }>
    expect(messages[0]!.role).toBe('system')
    expect(messages[1]!.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'text', text: visionPrompt() }
    ])
  })

  it('⑮ 空 Key 不带鉴权头；端点/模型缺失抛 LlmConfigError；开关关闭不发送 enable_thinking', () => {
    const noKey = buildVisionRequest({ ...config, apiKey: '' }, 'data:image/jpeg;base64,BBB')
    expect(noKey.headers['Authorization']).toBeUndefined()
    const thinkingOn = buildVisionRequest({ ...config, disableThinking: false }, 'x')
    expect((JSON.parse(thinkingOn.body) as Record<string, unknown>)['enable_thinking']).toBeUndefined()
    expect(() =>
      buildVisionRequest({ ...config, baseUrl: ' ', model: '' }, 'x')
    ).toThrow(LlmConfigError)
  })
})

describe('FEN 组装', () => {
  it('识图矩阵 → 完整 FEN（轮走方随识别结果）', () => {
    const grid = parseVisionPieces(okContent('black'))
    expect(visionGridToFen(grid, false)).toBe('3k5/9/9/9/R8/9/9/9/9/4K4 b - - 0 1')
  })
})

describe('excerptVisionBody', () => {
  it('超 160 字符截断加省略号', () => {
    const long = 'x'.repeat(200)
    const out = excerptVisionBody(long)
    expect(out).toHaveLength(161)
    expect(out.endsWith('…')).toBe(true)
  })
})
