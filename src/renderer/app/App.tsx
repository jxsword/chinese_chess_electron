/**
 * 应用根组件（对应 app.dart，08 文档 §1）：
 * 内存路由（桌面应用，无全局路由表）+ 主导航页 + 生命周期事件桥接。
 */
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { HomePage } from './HomePage'
import { HumanVsHumanPage } from '@renderer/features/board/HumanVsHumanPage'
import { api } from '@renderer/ipc/client'
import { notifyLifecycle } from '@renderer/stores/lifecycleRegistry'

/** 主进程生命周期事件 → 渲染层注册表（blur/minimize/close/before-quit → 自动保存） */
function LifecycleBridge(): null {
  useEffect(() => api.app.onLifecycle((e) => notifyLifecycle(e.phase)), [])
  return null
}

/** 未交付里程碑的入口占位 */
function PlaceholderPage({ title, milestone }: { title: string; milestone: string }): React.JSX.Element {
  const navigate = useNavigate()
  return (
    <div className="cc-game-page">
      <header className="cc-game-header">
        <h2>{title}</h2>
      </header>
      <div className="cc-placeholder">
        <div style={{ fontSize: 18 }}>{title}</div>
        <div>本入口将在 {milestone} 里程碑交付</div>
        <button type="button" className="cc-btn" onClick={() => navigate('/')}>
          返回主页
        </button>
      </div>
    </div>
  )
}

/**
 * 初始路由：内存路由默认主页；dev:web/深链场景支持 `?fen=` 直达棋谱续战
 * （对齐 record_battle_launcher 的 initialFen 入口参数，M5 棋谱库将改为路由跳转传参）。
 * Electron 生产加载 index.html 无 query，恒为 '/'。
 */
function initialRoute(): string {
  if (typeof window === 'undefined') return '/'
  const search = window.location.search
  if (search.includes('fen=')) return `/human-vs-human${search}`
  return '/'
}

export default function App(): React.JSX.Element {
  return (
    <MemoryRouter initialEntries={[initialRoute()]}>
      <LifecycleBridge />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/human-vs-human" element={<HumanVsHumanPage />} />
        <Route path="/puzzle" element={<PlaceholderPage title="残局选关" milestone="M5/M6" />} />
        <Route path="/human-vs-ai" element={<PlaceholderPage title="人机对战" milestone="M3" />} />
        <Route path="/human-vs-llm" element={<PlaceholderPage title="人机对战（大模型）" milestone="M4" />} />
        <Route path="/llm-vs-llm" element={<PlaceholderPage title="大模型对战" milestone="M4" />} />
        <Route path="/endgame-studio" element={<PlaceholderPage title="残局工作室" milestone="M6" />} />
        <Route path="/record-library" element={<PlaceholderPage title="棋谱库" milestone="M5" />} />
      </Routes>
    </MemoryRouter>
  )
}
