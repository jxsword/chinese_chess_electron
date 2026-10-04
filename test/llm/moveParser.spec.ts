/**
 * LlmMoveParser 30 条解析用例（T4.2，09 §2.3 表 + 05 §4 第 3/4 层）：
 * 归一化（围栏/全角/零宽/BOM/小写）与坐标提取（标记优先/最后坐标/越界 null）。
 */
import { describe, it, expect } from 'vitest'
import { extractMove, normalizeReply } from '@packages/llm'

describe('LlmMoveParser.extractMove（30 条用例）', () => {
  it('01 严格单行格式', () => {
    expect(extractMove('着法: b2-e2')).toBe('b2-e2')
  })

  it('02 全角冒号+全角字母数字+全角横线', () => {
    expect(extractMove('着法：ｂ２－ｅ２')).toBe('b2-e2')
  })

  it('03 markdown 围栏（无语言标记）', () => {
    expect(extractMove('```\n着法: b2-e2\n```')).toBe('b2-e2')
  })

  it('04 markdown 围栏（带语言标记）', () => {
    expect(extractMove('```text\n着法: b2-e2\n```')).toBe('b2-e2')
  })

  it('05 零宽字符混入坐标', () => {
    expect(extractMove('着法: b\u200b2-\u200be2')).toBe('b2-e2')
  })

  it('06 BOM 前缀', () => {
    expect(extractMove('\uFEFF着法: b2-e2')).toBe('b2-e2')
  })

  it('07 多坐标对无标记 → 取最后一个', () => {
    expect(extractMove('先看 b2-e2 再看 h2-e2')).toBe('h2-e2')
  })

  it('08 多坐标对 + 「着法:」标记 → 标记后第一个优先', () => {
    expect(extractMove('b2-e2 是错的。着法: h2-e2 另外 h0-g2')).toBe('h2-e2')
  })

  it('09 无分隔符 b2e2', () => {
    expect(extractMove('着法: b2e2')).toBe('b2-e2')
  })

  it('10 中文分隔「到/至」', () => {
    expect(extractMove('着法: b2到e2')).toBe('b2-e2')
    expect(extractMove('着法: b2至e2')).toBe('b2-e2')
  })

  it('11 长破折号 – — 与波浪线 ~', () => {
    expect(extractMove('着法: b2–e2')).toBe('b2-e2')
    expect(extractMove('着法: b2—e2')).toBe('b2-e2')
    expect(extractMove('着法: b2~e2')).toBe('b2-e2')
  })

  it('12 空白分隔', () => {
    expect(extractMove('着法: b2 e2')).toBe('b2-e2')
  })

  it('13 大写字母 → 小写归一', () => {
    expect(extractMove('着法: B2-E2')).toBe('b2-e2')
  })

  it('14 v2 分析段 + 最后一行着法', () => {
    expect(extractMove('分析: 进攻中路，威胁黑炮。\n着法: h2-e2')).toBe('h2-e2')
  })

  it('15 思维链长文本中取最后一个坐标', () => {
    expect(
      extractMove('我先考虑车九平八，然后马二进三，对方可能炮8平5，我决定着法: c3-c4')
    ).toBe('c3-c4')
  })

  it('16 行越界数字 b10 → 无法成对 → null', () => {
    expect(extractMove('着法: b10-e2')).toBeNull()
  })

  it('17 边界行列 a0 / i9 合法', () => {
    expect(extractMove('着法: a0-i9')).toBe('a0-i9')
  })

  it('18 字母越界 j/z → null', () => {
    expect(extractMove('着法: j2-e2')).toBeNull()
    expect(extractMove('着法: z9-a0')).toBeNull()
  })

  it('19 空串 → null', () => {
    expect(extractMove('')).toBeNull()
    expect(extractMove('   ')).toBeNull()
  })

  it('20 纯杂质无坐标 → null', () => {
    expect(extractMove('抱歉，我无法回答。')).toBeNull()
  })

  it('21 全角大写 Ｂ２ → 先小写再转半角', () => {
    expect(extractMove('着法：Ｂ２－Ｅ２')).toBe('b2-e2')
  })

  it('22 相同起点终点也原样提取（白名单层负责拒绝）', () => {
    expect(extractMove('着法: e3-e3')).toBe('e3-e3')
  })

  it('23 无空格冒号「着法:」', () => {
    expect(extractMove('着法:b2-e2')).toBe('b2-e2')
  })

  it('24 冒号后带空白变体', () => {
    expect(extractMove('着法 :   b2-e2')).toBe('b2-e2')
  })

  it('25 引号包裹', () => {
    expect(extractMove('"着法: b2-e2"')).toBe('b2-e2')
  })

  it('26 多个「着法:」标记 → 最后一个标记后优先', () => {
    expect(extractMove('着法: a0-a1\n着法: i9-i8')).toBe('i9-i8')
  })

  it('27 标记前有候选坐标时仍以标记后为准', () => {
    expect(extractMove('候选 b2-e2 与 h2-e2 之间犹豫。最终回答：\n着法: h0-g2')).toBe('h0-g2')
  })

  it('28 归一化为 b2-e2 形式（多余空白压缩）', () => {
    expect(extractMove('着法:  b2 -  e2')).toBe('b2-e2')
  })

  it('29 多行回复含空行', () => {
    expect(extractMove('分析: 稳健出子。\n\n着法: c3-c4\n')).toBe('c3-c4')
  })

  it('30 代码块内零宽+全角混合', () => {
    expect(extractMove('```\n着法：ｂ\u200b２－ｅ２\n```')).toBe('b2-e2')
  })
})

describe('normalizeReply（05 §4 第 3 层）', () => {
  it('剥离 ``` 围栏标记本身', () => {
    expect(normalizeReply('```ts\nx\n```')).toBe('\nx\n')
  })

  it('删除零宽字符与 BOM，保留普通中文', () => {
    expect(normalizeReply('\u200b着\u200c法\uFEFF')).toBe('着法')
  })

  it('全角 ASCII 区平移回半角（！到 ～；先小写故大写亦转小写）', () => {
    expect(normalizeReply('ＡＺａｚ０９！～：－')).toBe('azaz09!~:-')
  })

  it('小写化（保留中文与全角区外字符）', () => {
    expect(normalizeReply('着法: B2-E2')).toBe('着法: b2-e2')
  })
})
