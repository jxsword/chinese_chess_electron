/**
 * 应用根组件（对应 app.dart，08 文档 §1）：
 * 内存路由（桌面应用，无全局路由表）+ 主导航页 + 生命周期事件桥接。
 */
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { HomePage } from './HomePage'
import { HumanVsHumanPage } from '@renderer/features/board/HumanVsHumanPage'
import { HumanVsAiPage } from '@renderer/features/board/HumanVsAiPage'
import { HumanVsLlmPage } from '@renderer/features/board/HumanVsLlmPage'
import { LlmVsLlmPage } from '@renderer/features/board/LlmVsLlmPage'
import { CorpusBrowserPage } from '@renderer/features/puzzle/CorpusBrowserPage'
import { RecordLibraryPage } from '@renderer/features/record/RecordLibraryPage'
import { RecordDetailPage } from '@renderer/features/record/RecordDetailPage'
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
        <Route path="/puzzle" element={<CorpusBrowserPage />} />
        <Route path="/human-vs-ai" element={<HumanVsAiPage />} />
        <Route path="/human-vs-llm" element={<HumanVsLlmPage />} />
        <Route path="/llm-vs-llm" element={<LlmVsLlmPage />} />
        <Route path="/endgame-studio" element={<PlaceholderPage title="残局工作室" milestone="M6" />} />
        <Route path="/record-library" element={<RecordLibraryPage />} />
        <Route path="/record-library/:id" element={<RecordDetailPage />} />
      </Routes>
    </MemoryRouter>
  )
}
