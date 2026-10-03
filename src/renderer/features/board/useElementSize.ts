/** 容器尺寸测量（无 override 时用 ResizeObserver；jsdom/无观察器兜底 600×600） */
import { useEffect, useRef, useState, type RefObject } from 'react'

export const FALLBACK_SIZE = { width: 600, height: 600 } as const

export interface Size {
  width: number
  height: number
}

export function useElementSize(override?: Size): [RefObject<HTMLDivElement>, Size] {
  const [size, setSize] = useState<Size>(override ?? FALLBACK_SIZE)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (override !== undefined) {
      setSize(override)
      return
    }
    const el = ref.current
    if (el === null) return
    if (typeof ResizeObserver === 'undefined') return // 兜底尺寸（board_widget.dart:119-121 的 600 语义）
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect !== undefined) setSize({ width: rect.width, height: rect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [override])

  return [ref, override ?? size]
}
