/**
 * 应用内文件/目录选择器（主进程自绘，替代 Linux 原生对话框）。
 *
 * 为什么自绘：WSLg 实测（2026-10，M5 手测回归）原生对话框两条路径全坏——
 * ① Chromium 默认委托 xdg-desktop-portal，portal 对话框渲染在自己进程的
 * Wayland 连接上，输入路由失效（弹窗可见但整体不可点击）；
 * ② GTK_USE_PORTAL=0 回退本进程 GTK 对话框后连 surface 都不创建（promise 永挂）。
 * 本选择器是普通 BrowserWindow（sandbox、无 Node），与主窗口同一输入路径，恒可用。
 *
 * 实现约束：窗口内容为 data: URL 的纯 HTML，无渲染层 JS——目录导航/确认/取消
 * 全部用 `<a>`/`<form>` 触发到 `cc-picker://` 的顶级导航，主进程 will-navigate
 * 拦截后重渲染或结算（00 文档 §2：preload 之外不再开新 IPC 面）。
 */
import { readdirSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { BrowserWindow } from 'electron'

/** 导航动作（cc-picker://action?params）。 */
export type PickerNav =
  | { action: 'open'; path: string; name: string }
  | { action: 'select'; path: string }
  | { action: 'save'; path: string; name: string }
  | { action: 'cancel' }

/** 解析 will-navigate 的 URL；非本 scheme 返回 null。 */
export function parsePickerNav(rawUrl: string): PickerNav | null {
  if (!rawUrl.startsWith('cc-picker://')) return null
  const rest = rawUrl.slice('cc-picker://'.length)
  const qIndex = rest.indexOf('?')
  const action = qIndex === -1 ? rest : rest.slice(0, qIndex)
  const query = qIndex === -1 ? '' : rest.slice(qIndex + 1)
  const params = new URLSearchParams(query)
  const decodePath = (): string => {
    const e = params.get('e') ?? ''
    return Buffer.from(e, 'base64url').toString('utf8')
  }
  switch (action) {
    case 'open':
      return { action: 'open', path: decodePath(), name: params.get('name') ?? '' }
    case 'select':
      return { action: 'select', path: decodePath() }
    case 'save':
      return { action: 'save', path: decodePath(), name: params.get('name') ?? '' }
    case 'cancel':
      return { action: 'cancel' }
    default:
      return null
  }
}

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')

const STYLE = `
  body { font-family: 'Microsoft YaHei','PingFang SC',sans-serif; margin: 0; background: #faf7f2; color: #2b2320; }
  header { padding: 12px 16px; background: #efe8de; }
  header .title { font-size: 15px; font-weight: bold; margin-bottom: 4px; }
  header .path { font-size: 12px; color: #6d4c41; word-break: break-all; }
  .actions { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #e0d5c8; }
  .actions a { display: inline-block; padding: 6px 14px; border-radius: 16px; text-decoration: none; font-size: 13px;
               border: 1px solid #8d6e63; color: #6d4c41; }
  .actions a.primary { background: #8d6e63; color: #fff; }
  ul { list-style: none; margin: 0; padding: 8px; max-height: calc(100vh - 150px); overflow-y: auto; }
  li a { display: block; padding: 8px 12px; text-decoration: none; color: #2b2320; border-radius: 6px; font-size: 14px; }
  li a:hover { background: #f3e9dd; }
  form { display: flex; gap: 8px; padding: 0 16px 12px; }
  form input[type=text] { flex: 1; padding: 6px 10px; border: 1px solid #8d6e63; border-radius: 4px; font-size: 14px; }
  form button { padding: 6px 14px; background: #8d6e63; color: #fff; border: none; border-radius: 16px; font-size: 13px; cursor: pointer; }
  .empty { padding: 24px 16px; color: #8a6a3f; font-size: 13px; }
`

interface PickerPageState {
  title: string
  currentPath: string
  /** 目录条目（仅当浏览模式需要列出） */
  entries: Array<{ name: string; path: string }>
  /** 选择模式：directory=选目录 / file=选文件 / save=存文件（带文件名表单） */
  mode: 'directory' | 'file' | 'save'
  /** 存文件模式的文件名（跨导航保持） */
  fileName?: string
  buttonLabel: string
  hint?: string
}

/** 生成 picker 页面 HTML（data URL 之外的纯函数部分，供测试）。 */
export function renderPickerHtml(state: PickerPageState): string {
  const openLink = (p: string, label: string): string =>
    `<a href="cc-picker://open?e=${b64url(p)}&name=${encodeURIComponent(state.fileName ?? '')}">${label}</a>`
  const parent = dirname(state.currentPath)
  const items =
    state.entries.length === 0
      ? `<div class="empty">此目录下无可浏览的${state.mode === 'directory' ? '子目录' : '文件'}</div>`
      : `<ul>${state.entries
          .map((e) => `<li>${openLink(e.path, `▸ ${e.name}`)}</li>`)
          .join('')}</ul>`
  const saveForm =
    state.mode !== 'save'
      ? ''
      : `<form method="get" action="cc-picker://save">
           <input type="hidden" name="e" value="${b64url(state.currentPath)}" />
           <input type="text" name="name" value="${state.fileName ?? ''}" placeholder="文件名" />
           <button type="submit">${state.buttonLabel}</button>
         </form>`
  const selectLink =
    state.mode === 'directory'
      ? `<a class="primary" href="cc-picker://select?e=${b64url(state.currentPath)}">${state.buttonLabel}</a>`
      : ''
  const parentLink =
    parent !== state.currentPath
      ? openLink(parent, '↩ 上级目录')
      : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
    <header>
      <div class="title">${state.title}</div>
      <div class="path">${state.currentPath}</div>
    </header>
    <div class="actions">
      ${selectLink}
      ${parentLink}
      <a href="cc-picker://cancel">取消</a>
    </div>
    ${saveForm}
    ${items}
    ${state.hint !== undefined ? `<div class="empty">${state.hint}</div>` : ''}
  </body></html>`
}

function toDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** 列出目录下按模式过滤的条目（目录名排序；异常返回空 + 错误提示）。 */
export function listPickerEntries(
  dir: string,
  mode: 'directory' | 'file' | 'save'
): { entries: Array<{ name: string; path: string }>; error?: string } {
  try {
    const dirents = readdirSync(dir, { withFileTypes: true })
    // save 模式同样浏览目录（文件名由表单输入）。
    const filtered = dirents.filter((d) =>
      mode === 'file' ? d.isFile() : d.isDirectory()
    )
    filtered.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    return {
      entries: filtered.slice(0, 500).map((d) => ({ name: d.name, path: join(dir, d.name) })),
      ...(filtered.length > 500 ? { error: `条目过多，仅显示前 500 项` } : {})
    }
  } catch (e) {
    return { entries: [], error: `无法读取目录：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 通用选择器窗口会话（内部）。 */
class PickerSession {
  private win: BrowserWindow | null = null
  private settled = false
  private state: PickerPageState
  constructor(
    private readonly parent: BrowserWindow | null,
    state: PickerPageState,
    private readonly settle: (result: string | null) => void
  ) {
    this.state = state
  }

  /** 打开窗口并进入导航循环；用户确认/取消/关窗后结算。 */
  run(): void {
    const win = new BrowserWindow({
      parent: this.parent ?? undefined,
      modal: this.parent !== null,
      width: 520,
      height: 620,
      title: this.state.title,
      autoHideMenuBar: true,
      show: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true }
    })
    this.win = win
    win.on('ready-to-show', () => win.show())
    win.on('closed', () => this.finish(null))
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      const nav = parsePickerNav(url)
      if (nav === null) return // 未知导航：忽略（内容全是自产链接）
      this.handle(nav)
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    void win.loadURL(toDataUrl(this.renderCurrent()))
  }

  private handle(nav: PickerNav): void {
    switch (nav.action) {
      case 'cancel':
        this.finish(null)
        this.win?.close()
        break
      case 'select':
        this.finish(nav.path)
        this.win?.close()
        break
      case 'save': {
        const dir = nav.path
        const name = nav.name.trim()
        if (name.length === 0) {
          this.rerender(dir, '请输入文件名')
          break
        }
        try {
          statSync(dir) // 目录须存在
        } catch {
          this.rerender(dirname(dir), '目录不存在，请重新选择')
          break
        }
        this.finish(join(dir, name))
        this.win?.close()
        break
      }
      case 'open': {
        const target = nav.path
        try {
          const st = statSync(target)
          if (!st.isDirectory()) return
        } catch {
          return
        }
        this.rerender(target, undefined, nav.name)
        break
      }
    }
  }

  private currentState(currentPath: string, fileName?: string, hint?: string): PickerPageState {
    const mode = this.state.mode
    const { entries, error } = listPickerEntries(currentPath, mode)
    return {
      title: this.state.title,
      currentPath,
      entries,
      mode,
      fileName: fileName ?? this.state.fileName,
      buttonLabel: this.state.buttonLabel,
      hint: hint ?? error
    }
  }

  private renderCurrent(): string {
    return renderPickerHtml(this.currentState(this.state.currentPath))
  }

  private rerender(currentPath: string, hint?: string, fileName?: string): void {
    const next = this.currentState(currentPath, fileName, hint)
    this.state = next
    void this.win?.loadURL(toDataUrl(renderPickerHtml(next)))
  }

  private finish(result: string | null): void {
    if (this.settled) return
    this.settled = true
    this.settle(result)
  }
}

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

/**
 * 应用内目录选择（Linux，替代 dialog.showOpenDialog openDirectory）。
 * 返回所选目录绝对路径；取消/关窗返回 null。
 */
export function pickDirectoryInApp(options: {
  title: string
  buttonLabel: string
  initialPath?: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    const session = new PickerSession(
      focusedWindow(),
      {
        title: options.title,
        currentPath: options.initialPath ?? homedir(),
        entries: [],
        mode: 'directory',
        buttonLabel: options.buttonLabel
      },
      resolve
    )
    session.run()
  })
}

/**
 * 应用内存文件选择（Linux，替代 dialog.showSaveDialog）。
 * [defaultName] 为预填文件名；返回「所选目录/文件名」，取消返回 null。
 */
export function saveFileInApp(options: {
  title: string
  defaultName: string
  initialPath?: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    const session = new PickerSession(
      focusedWindow(),
      {
        title: options.title,
        currentPath: options.initialPath ?? homedir(),
        entries: [],
        mode: 'save',
        fileName: options.defaultName,
        buttonLabel: '保存'
      },
      resolve
    )
    session.run()
  })
}

/**
 * 应用内选文件（Linux，替代 dialog.showOpenDialog openFile）。
 * 返回所选文件绝对路径；取消返回 null。
 */
export function pickFileInApp(options: {
  title: string
  buttonLabel?: string
  initialPath?: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    const session = new PickerSession(
      focusedWindow(),
      {
        title: options.title,
        currentPath: options.initialPath ?? homedir(),
        entries: [],
        mode: 'file',
        buttonLabel: options.buttonLabel ?? '打开'
      },
      resolve
    )
    session.run()
  })
}
