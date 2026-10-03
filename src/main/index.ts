import { join } from 'path'
import { app, BrowserWindow } from 'electron'

// M0 工程骨架：空窗口 + 00 文档 §5 安全基线。业务 IPC（cc:*）自 T0.2/M2 起接入。

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: '中国象棋',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // electron-vite dev 注入 ELECTRON_RENDERER_URL；生产加载构建产物
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 桌面应用语义：关窗即退出（与 Flutter 版一致，darwin 亦不驻留）
app.on('window-all-closed', () => {
  app.quit()
})
