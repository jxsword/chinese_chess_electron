/**
 * cc:db:* 通道 handler（00 文档 §3.1）：自动存档 + 棋谱库 CRUD。
 * DAO 打开失败（磁盘/权限等）时 invoke 拒绝，渲染层按"存储不可用"降级。
 */
import { ipcMain } from 'electron'
import { CC } from '@shared/ipc/channels'
import type { AutoSaveMode, GameRecord, SaveGameRequest } from '@shared/ipc/types'
import type { ChessDao } from '../services/db'

export function registerDbIpc(getDao: () => ChessDao): void {
  ipcMain.handle(CC.db.saveGame, (_event, req: SaveGameRequest) => {
    getDao().upsertForMode({ mode: req.mode, fen: req.fen, moves: req.moves })
  })
  ipcMain.handle(CC.db.loadLatest, (_event, req: { mode: AutoSaveMode }) =>
    getDao().latestForMode(req.mode)
  )
  ipcMain.handle(CC.db.deleteForMode, (_event, req: { mode: AutoSaveMode }) => {
    getDao().deleteForMode(req.mode)
  })
  ipcMain.handle(CC.db.recordsList, () => getDao().recordSummaries())
  ipcMain.handle(CC.db.recordsGet, (_event, req: { id: number }) => getDao().recordById(req.id))
  ipcMain.handle(CC.db.recordsSave, (_event, req: { record: Omit<GameRecord, 'id'> }) =>
    getDao().insertRecord(req.record)
  )
  ipcMain.handle(CC.db.recordsDelete, (_event, req: { id: number }) => {
    getDao().deleteRecord(req.id)
  })
}
