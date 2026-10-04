/**
 * 提示词逐字快照测试（T4.2，09 §2 llm_prompt_v2；05 文档 §2 协议铁律）：
 * 任何对提示词文本的改动必须在此显式 review diff——禁止意译改写、"优化"措辞。
 * 金标准 = Flutter 版 llm_move_source.dart / hybrid_llm_move_source.dart 原文。
 */
import { describe, it, expect } from 'vitest'
import { Board, type Move } from '@packages/rules'
import {
  systemV1,
  userV1,
  retryFeedback,
  systemV2,
  userV2,
  retryFeedbackV2,
  looksLikeRepetition,
  historyTextV2
} from '@packages/llm'

/** 黑王 e0、红帅 d9、红马 e9 的小局面（双方不照面） */
const FEN_KNIGHT = '4k4/9/9/9/9/9/9/9/9/3KN4 w - - 0 1'

const cannonB2E2: Move = {
  piece: { kind: 'cannon', side: 'red' },
  from: { col: 1, row: 7 },
  to: { col: 4, row: 7 }
}
const knightH0G2: Move = {
  piece: { kind: 'knight', side: 'black' },
  from: { col: 7, row: 0 },
  to: { col: 6, row: 2 }
}

describe('Prompt v1 逐字快照（llm_move_source.dart:19-69）', () => {
  it('system（红方）', () => {
    expect(systemV1('red')).toBe(
      '你是中国象棋对弈引擎的着法接口，本局执红方。\n' +
        '坐标约定：列用字母 a-i（从左到右），行用数字 0-9' +
        '（0 为黑方底线、棋盘顶部，9 为红方底线、棋盘底部）。\n' +
        '你只能从用户提供的「合法着法清单」中选择一步，禁止编造清单之外的着法。\n' +
        '\n' +
        '【回复格式（唯一允许的格式，违反即视为无效）】\n' +
        '整个回复只包含一行，形式为：\n' +
        '着法: 起点-终点\n' +
        '示例：着法: b2-e2\n' +
        '\n' +
        '禁止输出：任何解释、推理过程、心理活动、道歉、开场白、' +
        'markdown、代码块、引号、多行文本。你的回复将被程序逐字解析，' +
        '任何多余字符都会导致这步棋作废。'
    )
  })

  it('system（黑方）仅执方变化', () => {
    expect(systemV1('black')).toContain('本局执黑方。')
    expect(systemV1('black')).not.toContain('红方。')
  })

  it('user（开局无历史）：【最近着法】占位与两步清单', () => {
    const board = Board.fromFen('3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1')
    expect(userV1(board, [], ['e9-e8', 'e9-f9'])).toBe(
      '【当前局面 FEN】3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1\n' +
        '【轮走方】红方（该方是你）\n' +
        '【最近着法】（开局，暂无历史）\n' +
        '【合法着法清单（共 2 条，必须从中选择一条）】\n' +
        'e9-e8, e9-f9\n' +
        '【输出】仅一行，格式：着法: 起点-终点（起点与终点均取自上方清单）'
    )
  })

  it('user（有历史）：中文记法最新在最后，仅取最近 12 手', () => {
    const board = Board.fromFen('3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1')
    expect(userV1(board, [cannonB2E2, knightH0G2], ['e9-e8'])).toContain(
      '【最近着法（中文记法，最新在最后）】炮八平五  马8进7\n'
    )
    const thirteen: Move[] = Array.from({ length: 13 }, (_, i) => ({
      piece: { kind: 'rook', side: i % 2 === 0 ? 'red' : 'black' },
      from: { col: 0, row: i % 2 === 0 ? 9 : 0 },
      to: { col: 1, row: i % 2 === 0 ? 9 : 0 }
    }))
    const text = userV1(board, thirteen, ['e9-e8'])
    const line = text.split('\n').find((l) => l.startsWith('【最近着法'))
    const expectedLast12 = thirteen
      .slice(-12)
      .map((m) => (m.piece!.side === 'red' ? '车九平八' : '车1平2'))
      .join('  ')
    expect(line).toBe(`【最近着法（中文记法，最新在最后）】${expectedLast12}`)
  })

  it('retryFeedback 逐字', () => {
    expect(retryFeedback('着法 b2-e2 不在合法清单中')).toBe(
      '\n\n你上一次的回复无效（着法 b2-e2 不在合法清单中）。' +
        '请重新回答：整个回复只含一行「着法: 起点-终点」，' +
        '着法必须取自合法着法清单，不要输出任何其他文字。'
    )
  })
})

describe('Prompt v2 逐字快照（llm_move_source.dart:79-136）', () => {
  it('systemV2（off/护航：无分档引导）', () => {
    expect(systemV2('red')).toBe(
      '你是中国象棋对弈引擎的着法接口，本局执红方。\n' +
        '坐标约定：列用字母 a-i（从左到右），行用数字 0-9' +
        '（0 为黑方底线、棋盘顶部，9 为红方底线、棋盘底部）。\n' +
        '你只能从用户提供的「合法着法清单」中选择一步，禁止编造清单之外的着法。\n' +
        '\n' +
        '【回复格式（唯一允许的格式，共两段）】\n' +
        '第一段以「分析:」开头，用一两句话（不超过 100 字）说明你的计划' +
        '（进攻目标、需要提防的威胁）。\n' +
        '最后一段为一行，形式为：\n' +
        '着法: 起点-终点\n' +
        '示例：着法: b2-e2\n' +
        '\n' +
        '合法着法清单中每条着法附有括号注解（中文记法/吃子/将军）。'
    )
  })

  it('systemV2（候选：withBucketGuide 分档引导）', () => {
    expect(systemV2('black', true)).toBe(
      '你是中国象棋对弈引擎的着法接口，本局执黑方。\n' +
        '坐标约定：列用字母 a-i（从左到右），行用数字 0-9' +
        '（0 为黑方底线、棋盘顶部，9 为红方底线、棋盘底部）。\n' +
        '你只能从用户提供的「合法着法清单」中选择一步，禁止编造清单之外的着法。\n' +
        '\n' +
        '【回复格式（唯一允许的格式，共两段）】\n' +
        '第一段以「分析:」开头，用一两句话（不超过 100 字）说明你的计划' +
        '（进攻目标、需要提防的威胁）。\n' +
        '最后一段为一行，形式为：\n' +
        '着法: 起点-终点\n' +
        '示例：着法: b2-e2\n' +
        '\n' +
        '合法着法清单中每条着法附有括号注解（中文记法/吃子/将军）' +
        '与「—」后的引擎评估分档，请优先考虑评估为「最佳/均势」的着法，' +
        '避免选择「大亏/致命」档的着法。'
    )
  })

  it('userV2（开局）：棋盘图 + 注解清单全字快照', () => {
    const board = Board.fromFen(FEN_KNIGHT)
    const legal = ['d9-d8', 'e9-f7', 'e9-d7', 'e9-g8'].map((code) => {
      const [f, t] = code.split('-')
      return {
        from: { col: f!.charCodeAt(0) - 97, row: Number(f![1]) },
        to: { col: t!.charCodeAt(0) - 97, row: Number(t![1]) }
      }
    })
    expect(userV2(board, [], legal)).toBe(
      '【当前局面 FEN】4k4/9/9/9/9/9/9/9/9/3KN4 w - - 0 1\n' +
        '【棋盘图】\n' +
        '    a b c d e f g h i\n' +
        '0  . . . . k . . . .\n' +
        '1  . . . . . . . . .\n' +
        '2  . . . . . . . . .\n' +
        '3  . . . . . . . . .\n' +
        '4  . . . . . . . . .\n' +
        '5  . . . . . . . . .\n' +
        '6  . . . . . . . . .\n' +
        '7  . . . . . . . . .\n' +
        '8  . . . . . . . . .\n' +
        '9  . . . K N . . . .\n' +
        '【轮走方】红方（该方是你）\n' +
        '【对局着法（中文记法，最新在最后）】（开局，暂无历史）\n' +
        '【合法着法清单（共 4 条，必须从中选择一条；括号内为中文记法/吃子/将军注解）】\n' +
        'd9-d8(帅六进一)\n' +
        'e9-f7(马五进四)\n' +
        'e9-d7(马五进六)\n' +
        'e9-g8(马五进三)\n' +
        '【输出】先输出「分析:」段，最后一行输出「着法: 起点-终点」（起点与终点均取自上方清单）'
    )
  })

  it('userV2（有历史 + 循环警示）', () => {
    const board = Board.fromFen(FEN_KNIGHT)
    const kingRed: Move = { piece: { kind: 'king', side: 'red' }, from: { col: 3, row: 9 }, to: { col: 3, row: 8 } }
    const kingBlack: Move = { piece: { kind: 'king', side: 'black' }, from: { col: 4, row: 0 }, to: { col: 4, row: 1 } }
    const back1: Move = { piece: { kind: 'king', side: 'red' }, from: { col: 3, row: 8 }, to: { col: 3, row: 9 } }
    const back2: Move = { piece: { kind: 'king', side: 'black' }, from: { col: 4, row: 1 }, to: { col: 4, row: 0 } }
    const history = [cannonB2E2, knightH0G2, kingRed, kingBlack, back1, back2]
    const text = userV2(board, history, [])
    expect(text).toContain('【对局着法（中文记法，最新在最后）】炮八平五  马8进7  帅六进一  将5进1  帅六退一  将5退1\n')
    expect(text).toContain(
      '【警示】最近着法出现来回重复。长将/长捉判负，' +
        '重复局面会被视为无效——请选择打破循环的着法。\n'
    )
  })

  it('userV2 无循环时不加警示；>60 着从最早截断', () => {
    const board = Board.fromFen(FEN_KNIGHT)
    expect(userV2(board, [cannonB2E2, knightH0G2], [])).not.toContain('【警示】')
    const long: Move[] = Array.from({ length: 61 }, (_, i) => ({
      piece: { kind: 'rook', side: i % 2 === 0 ? 'red' : 'black' },
      from: { col: 0, row: i % 2 === 0 ? 9 : 0 },
      to: { col: 1, row: i % 2 === 0 ? 9 : 0 }
    }))
    expect(historyTextV2(long)).toBe(
      long
        .slice(-60)
        .map((m) => (m.piece!.side === 'red' ? '车九平八' : '车1平2'))
        .join('  ')
    )
    const line = userV2(board, long, [])
      .split('\n')
      .find((l) => l.startsWith('【对局着法'))
    expect(line).toBe(
      `【对局着法（中文记法，最新在最后）】${historyTextV2(long)}`
    )
  })

  it('retryFeedbackV2（含/不含上次着法）', () => {
    expect(retryFeedbackV2('无法从回复中解析出着法')).toBe(
      '\n\n你上一次的回复无效（无法从回复中解析出着法）。' +
        '着法必须取自合法着法清单。' +
        '请重新回答：先「分析:」一两句，最后一行「着法: 起点-终点」。'
    )
    expect(retryFeedbackV2('着法 x9-x9 不在合法清单中', 'x9-x9')).toBe(
      '\n\n你上一次的回复的着法 x9-x9无效（着法 x9-x9 不在合法清单中）。' +
        '着法必须取自合法着法清单。' +
        '请重新回答：先「分析:」一两句，最后一行「着法: 起点-终点」。'
    )
  })

  it('looksLikeRepetition：互逆判定（h[n-1]↔h[n-3]、h[n-2]↔h[n-4]）', () => {
    const mk = (fc: number, fr: number, tc: number, tr: number): Move => ({
      from: { col: fc, row: fr },
      to: { col: tc, row: tr }
    })
    // 红 A→B、黑 C→D、红 B→A、黑 D→C → 循环
    const loop = [mk(0, 9, 1, 9), mk(3, 0, 4, 0), mk(1, 9, 0, 9), mk(4, 0, 3, 0)]
    expect(looksLikeRepetition(loop)).toBe(true)
    // 只有最后一手回退（非两两互逆）→ 非循环
    expect(looksLikeRepetition(loop.slice(0, 3))).toBe(false)
    expect(looksLikeRepetition([loop[0]!, loop[1]!, loop[2]!, mk(8, 0, 7, 0)])).toBe(false)
    expect(looksLikeRepetition([])).toBe(false)
  })
})
