/**
 * 主导航页（对应 app.dart MainNavigationPage，08 文档 §1）：
 * 垂直按钮列表 7 入口 + 右上全局设置齿轮。
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GlobalSettingsDialog } from '@renderer/features/settings/GlobalSettingsDialog'

interface NavEntry {
  title: string
  path: string
}

/** 入口清单（08 §1 表格顺序；未交付里程碑跳占位页） */
const ENTRIES: readonly NavEntry[] = [
  { title: '残局选关', path: '/puzzle' },
  { title: '人机对战', path: '/human-vs-ai' },
  { title: '人机对战（大模型）', path: '/human-vs-llm' },
  { title: '大模型对战', path: '/llm-vs-llm' },
  { title: '双人对弈', path: '/human-vs-human' },
  { title: '残局工作室（摆盘/导入/求解）', path: '/endgame-studio' },
  { title: '棋谱库', path: '/record-library' }
]

export function HomePage(): React.JSX.Element {
  const navigate = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <div className="cc-home">
      <header className="cc-home-bar">
        <h1>中国象棋 Ultra</h1>
        <button type="button" className="cc-icon-btn" title="全局设置" aria-label="全局设置" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
      </header>
      <main className="cc-home-body">
        {ENTRIES.map((entry) => (
          <button key={entry.path} type="button" className="cc-btn cc-home-btn" onClick={() => navigate(entry.path)}>
            {entry.title}
          </button>
        ))}
      </main>
      {settingsOpen && <GlobalSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
