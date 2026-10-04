/**
 * 从模型回复中提取着法（纯函数，便于单测；llm_move_source.dart:162-216 1:1 移植）。
 *
 * 模型即使被严格约束也可能输出杂质（markdown 代码块、全角字符、
 * 零宽字符、多余空白），这里全部归一化后再解析。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */
import { decodeCell, encodeMove } from './moveCodes'

/** 坐标对：列字母 + 行数字 + 可选分隔符（含中文"到/至"与长破折号）。 */
const MOVE_PATTERN = /([a-i])\s*(\d)\s*[-–—~到至]?\s*([a-i])\s*(\d)/g

/** 「着法:」标记（允许冒号前空白；全角冒号已在归一化时转半角）。 */
const LABELED_PATTERN = /着法\s*:/g

/**
 * 返回归一化的 "b2-e2" 形式；无法解析返回 null。
 *
 * 若回复含多个坐标对，优先取「着法:」标记之后的，否则取最后一个
 * （llm_move_source.dart:178-199）。
 */
export function extractMove(rawContent: string): string | null {
  const content = normalizeReply(rawContent)
  if (content.trim() === '') return null
  const matches = [...content.matchAll(MOVE_PATTERN)]
  if (matches.length === 0) return null

  let pick = matches[matches.length - 1]!
  const labeled = [...content.matchAll(LABELED_PATTERN)]
  if (labeled.length > 0) {
    const lastLabeled = labeled[labeled.length - 1]!
    const labeledPos = lastLabeled.index! + lastLabeled[0].length
    for (const m of matches) {
      if ((m.index ?? 0) >= labeledPos) {
        pick = m
        break
      }
    }
  }
  const from = decodeCell(`${pick[1]}${pick[2]}`)
  const to = decodeCell(`${pick[3]}${pick[4]}`)
  if (from === null || to === null) return null
  return encodeMove({ from, to })
}

/**
 * 解析前的清洗（llm_move_source.dart:201-215）：剥离代码块围栏、
 * 去零宽字符与 BOM、小写化、全角 ASCII 区（！到 ～，U+FF01–U+FF5E）
 * 逐码位平移 −0xFEE0 转半角。
 */
export function normalizeReply(raw: string): string {
  let text = raw.replace(/```[a-zA-Z]*/g, '').replaceAll('```', '')
  text = text.replace(/[\u200b-\u200f\uFEFF\u2060]/g, '')
  text = text.toLowerCase()
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const u = text.charCodeAt(i)
    // 全角 ASCII 区平移回半角（与 Dart 逐 UTF-16 码元处理等价）。
    out += u >= 0xff01 && u <= 0xff5e ? String.fromCharCode(u - 0xfee0) : (text[i] as string)
  }
  return out
}
