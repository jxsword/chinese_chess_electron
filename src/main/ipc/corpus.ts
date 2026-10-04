/**
 * cc:corpus:* 通道 handler（00 文档 §3.1 通道表 + 06 文档 §1/§4/§5）。
 * 下载（download/progress）在 corpusDownloader.ts（T5.5）；本文件只做扫描与读取。
 */
import { dialog, ipcMain } from 'electron'
import { CC } from '@shared/ipc/channels'
import type {
  CorpusScanResult,
  CorpusEntry,
  CorpusFileBytes,
  PgnIndexEntry
} from '@shared/ipc/types'
import {
  listXqfEntries,
  readCorpusFiles,
  resolveCorpusDir,
  scanCorpus,
  scanPgnIndex,
  readPgnGameText
} from '../services/corpus'
import { downloadCorpus } from '../services/corpusDownloader'
import type { SettingsService } from '../services/settings'

export interface CorpusIpcOptions {
  settings: SettingsService
  /** 平台默认目录基路径（documents）；测试注入临时目录 */
  documentsPath: string
  /** legacy 相对目录基路径（cwd）；测试注入 */
  legacyBasePath: string
  /** 下载进度事件的目标 webContents（主窗口）；可为 null（窗口销毁后静默丢弃） */
  webContentsProvider: () => {
    isDestroyed(): boolean
    send(channel: string, payload: unknown): void
  } | null
}

/** 解析当前生效语料目录（用户设置 > legacy > 默认，corpus_paths.dart:150-172）。 */
export function resolveCurrentCorpusDir(options: CorpusIpcOptions): string {
  const userPath = options.settings.get<string>(CC_USER_PATH_KEY)
  return resolveCorpusDir({
    userSetting: userPath,
    documentsPath: options.documentsPath,
    legacyBasePath: options.legacyBasePath
  })
}

/** electron-store 的语料目录键（07 文档 §3 corpus.userPath）。 */
const CC_USER_PATH_KEY = 'corpus.userPath'

export function registerCorpusIpc(options: CorpusIpcOptions): void {
  ipcMain.handle(CC.corpus.scan, (_event, req: { root: string }): CorpusScanResult => {
    const root = req.root.length > 0 ? req.root : resolveCurrentCorpusDir(options)
    return scanCorpus(root)
  })

  ipcMain.handle(CC.corpus.listEntries, (_event, req: { categoryPath: string; categoryName: string }): CorpusEntry[] =>
    listXqfEntries(req.categoryPath, req.categoryName)
  )

  ipcMain.handle(CC.corpus.readFiles, (_event, req: { paths: string[] }): CorpusFileBytes[] =>
    readCorpusFiles(req.paths)
  )

  ipcMain.handle(CC.corpus.pgnIndex, (_event, req: { path: string; maxGames?: number }): PgnIndexEntry[] =>
    scanPgnIndex(req.path, req.maxGames ?? -1)
  )

  ipcMain.handle(CC.corpus.readPgnGame, (_event, req: { path: string; entry: PgnIndexEntry }): string =>
    readPgnGameText(req.path, req.entry)
  )

  ipcMain.handle(CC.corpus.pickDirectory, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      buttonLabel: '选择此目录'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(CC.corpus.download, async (_event, req: { requestId: string; url: string; targetDir: string }): Promise<void> => {
    const targetDir = req.targetDir.length > 0 ? req.targetDir : resolveCurrentCorpusDir(options)
    await downloadCorpus({
      url: req.url,
      targetDir,
      onProgress: (received, total) => {
        // 进度事件 best-effort：窗口销毁后不再发送
        const wc = options.webContentsProvider()
        if (wc !== null && !wc.isDestroyed()) {
          wc.send(CC.corpus.progress, { requestId: req.requestId, received, total })
        }
      }
    })
  })
}
