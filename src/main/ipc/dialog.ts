/**
 * cc:dialog:saveFile / readFile 通道 handler（00 文档 §3.1：导出 PGN / 导入棋谱）。
 * Linux（含 WSLg）用应用内自绘选择器（dialogPicker，原生对话框在 WSLg 全坏）；
 * Windows/macOS 用原生 dialog。
 */
import { dialog, ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { CC } from '@shared/ipc/channels'
import type { FileContent, SaveFileRequest } from '@shared/ipc/types'
import { pickFileInApp, saveFileInApp } from '../services/dialogPicker'

const IS_LINUX = process.platform === 'linux'

async function nativeSaveFile(req: SaveFileRequest): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    defaultPath: req.defaultName
  })
  if (result.canceled || result.filePath === undefined) return null
  writeFileSync(result.filePath, req.content, 'utf8')
  return result.filePath
}

async function nativeReadFile(): Promise<FileContent | null> {
  const result = await dialog.showOpenDialog({ properties: ['openFile'] })
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]
  return { path, content: readFileSync(path, 'utf8') }
}

export function registerDialogIpc(): void {
  ipcMain.handle(CC.dialog.saveFile, async (_event, req: SaveFileRequest): Promise<string | null> => {
    const target = IS_LINUX
      ? await saveFileInApp({ title: '导出文件', defaultName: req.defaultName })
      : await nativeSaveFile(req)
    if (target === null) return null
    // Linux 自绘选择器只返回路径：内容写盘在此收口（与原生语义对齐）。
    if (IS_LINUX) writeFileSync(target, req.content, 'utf8')
    return target
  })

  ipcMain.handle(CC.dialog.readFile, async (): Promise<FileContent | null> => {
    if (IS_LINUX) {
      const path = await pickFileInApp({ title: '导入棋谱' })
      if (path === null) return null
      return { path, content: readFileSync(path, 'utf8') }
    }
    return nativeReadFile()
  })
}
