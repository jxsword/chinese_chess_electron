import { mkdirSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow, safeStorage } from 'electron'
import { registerDbIpc } from './ipc/db'
import { registerStoreIpc, registerSecureIpc } from './ipc/store'
import { openDao, type ChessDao } from './services/db'
import { SettingsService } from './services/settings'
import { CredentialsService, safeStorageCryptor } from './services/credentials'

// M2：业务 IPC（cc:db/store/secure）接入。生命周期事件（cc:app:lifecycle）在 T2.5 接入。

/** 打开数据库（07 §1：documents/chinese_chess_electron.sqlite）；失败由调用方降级 */
function openDatabase(): ChessDao {
  const dir = app.getPath('documents')
  mkdirSync(dir, { recursive: true })
  return openDao(join(dir, 'chinese_chess_electron.sqlite'))
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: '中国象棋 Ultra',
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
  // 懒打开：磁盘异常时 invoke 拒绝，渲染层按"本地存储不可用"降级（新局兜底）
  let dao: ChessDao | null = null
  registerDbIpc(() => {
    if (dao === null) dao = openDatabase()
    return dao
  })

  registerStoreIpc(new SettingsService({ cwd: app.getPath('userData') }))
  registerSecureIpc(
    new CredentialsService(
      safeStorageCryptor(safeStorage),
      join(app.getPath('userData'), 'credentials.enc')
    )
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 桌面应用语义：关窗即退出（与 Flutter 版一致，darwin 亦不驻留）
app.on('window-all-closed', () => {
  app.quit()
})
