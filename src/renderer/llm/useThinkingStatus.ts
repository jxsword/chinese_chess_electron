/**
 * 思考状态透明化（思考型模型单次调用可达数分钟，05 §3.2/§7）：
 * 状态栏显示已等待秒数与"第 N/M 次尝试"，避免"卡住不动"的观感。
 */
import { useEffect, useState } from 'react'

/** 思考已等待秒数：active 期间每秒自增，重新激活时归零。 */
export function useThinkingElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!active) {
      setSeconds(0)
      return
    }
    setSeconds(0)
    const timer = setInterval(() => setSeconds((v) => v + 1), 1000)
    return () => clearInterval(timer)
  }, [active])
  return seconds
}

export interface AttemptProgress {
  n: number
  total: number
}

/** 思考状态后缀：尝试数 >1 时附"第 N/M 次尝试"；≥3s 显示已等待秒数；无则空串。 */
export function formatThinkingSuffix(
  elapsedSec: number,
  attempt?: AttemptProgress | null
): string {
  const parts: string[] = []
  if (attempt !== undefined && attempt !== null && attempt.n > 1) {
    parts.push(`第 ${attempt.n}/${attempt.total} 次尝试`)
  }
  if (elapsedSec >= 3) parts.push(`已等待 ${elapsedSec} 秒`)
  return parts.length === 0 ? '' : `（${parts.join(' · ')}）`
}
