import { mkdirSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow, safeStorage } from 'electron'
import { CC } from '@shared/ipc/channels'
import type { AppLifecyclePhase } from '@shared/ipc/types'
import { registerDbIpc } from './ipc/db'
import { registerCorpusIpc } from './ipc/corpus'
import { registerLlmIpc } from './ipc/llm'
import { registerStoreIpc, registerSecureIpc } from './ipc/store'
import { registerClipboardIpc } from './ipc/clipboard'
import { registerDialogIpc } from './ipc/dialog'
import { openDao, type ChessDao } from './services/db'
import { LlmProxy } from './services/llm-proxy'
import { SettingsService } from './services/settings'
import { CredentialsService, safeStorageCryptor } from './services/credentials'
import { LLM_SETTING_KEYS, resolveTimeoutSeconds } from '@packages/llm'

// M2：业务 IPC（cc:db/store/secure/clipboard/app:lifecycle）接入。
// 生命周期映射（07 §2）：窗口 blur/minimize/close + before-quit → 渲染层自动保存。

// WSLg/ANGLE D3D12 下 Chromium GPU 进程会因 Skia OOM 反复崩溃（整屏黑闪后恢复，
// 路线图风险 R7）；棋盘 UI 无需 GPU 加速，恒用软件渲染消除该类故障。
app.disableHardwareAcceleration()

// Linux 下 Chromium 检测到 xdg-desktop-portal 时，showOpenDialog/saveFile 会委托
// portal 进程弹窗。WSLg 中 portal 的对话框渲染在其自身 Wayland 连接上，输入路由
// 失效——弹窗可见但所有按钮/条目不可点击（M5 实测复现，dbus-monitor 验证：
// 默认环境弹窗走 org.freedesktop.portal.FileChooser；强制 0 后归零，对话框回到
// 本进程 GTK，与主窗口同一输入路径）。须在 app ready / GTK 初始化前设置。
if (process.platform === 'linux') {
  process.env.GTK_USE_PORTAL = '0'
}

/** 单窗口生命周期事件广播（best-effort：send 即返回，不阻塞退出） */
function sendLifecycle(win: BrowserWindow, phase: AppLifecyclePhase): void {
  if (!win.isDestroyed()) win.webContents.send(CC.app.lifecycle, { phase })
}

function wireWindowLifecycle(win: BrowserWindow): void {
  win.on('blur', () => sendLifecycle(win, 'blur'))
  win.on('minimize', () => sendLifecycle(win, 'minimize'))
  win.on('close', () => sendLifecycle(win, 'close'))
}

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
  wireWindowLifecycle(win)

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

  const settings = new SettingsService({ cwd: app.getPath('userData') })
  registerStoreIpc(settings)
  const credentials = new CredentialsService(
    safeStorageCryptor(safeStorage),
    join(app.getPath('userData'), 'credentials.enc')
  )
  registerSecureIpc(credentials)
  registerClipboardIpc()
  registerDialogIpc()
  // 语料库（M5，06 文档）：扫描/读取 + 下载（SSRF/zip-slip 防护在主进程）。
  registerCorpusIpc({
    settings,
    documentsPath: app.getPath('documents'),
    legacyBasePath: process.cwd(),
    webContentsProvider: () => BrowserWindow.getAllWindows()[0]?.webContents ?? null
  })
  // LLM 代理（DR-004/DR-010）：空闲超时读 llm_settings_timeoutSeconds（主进程侧计时），
  // authSlot 经凭据服务注入真实 Key。
  registerLlmIpc(
    new LlmProxy({
      getTimeoutSeconds: () =>
        resolveTimeoutSeconds(settings.get<unknown>(LLM_SETTING_KEYS.timeoutSeconds)),
      resolveApiKey: (slot) => credentials.getRaw(slot)?.apiKey ?? null
    })
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 进程退出（07 §2：同步 best-effort 写入）
app.on('before-quit', () => {
  for (const win of BrowserWindow.getAllWindows()) sendLifecycle(win, 'before-quit')
})

// 桌面应用语义：关窗即退出（与 Flutter 版一致，darwin 亦不驻留）
app.on('window-all-closed', () => {
  app.quit()
})
