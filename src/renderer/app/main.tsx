import { createRoot } from 'react-dom/client'
import App from './App'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('缺少 #root 挂载点')

createRoot(rootEl).render(<App />)
