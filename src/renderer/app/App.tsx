import type { CSSProperties } from 'react'

// M0 工程骨架占位页：验证 Electron（WSLg）与浏览器（mock IPC）双模式可启动，M2 起替换为主页导航
const containerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100vh',
  fontFamily: 'system-ui, "Microsoft YaHei", sans-serif'
}

const titleStyle: CSSProperties = {
  color: '#b71c1c',
  fontSize: 28,
  letterSpacing: 4
}

export default function App() {
  return (
    <div style={containerStyle}>
      <h1 style={titleStyle}>中国象棋 · 工程骨架就绪（M0）</h1>
    </div>
  )
}
