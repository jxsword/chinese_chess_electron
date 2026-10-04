/**
 * cc:vision:readBoard 通道 handler（00 文档 §3.1，05 文档 §7）。
 * 非流式多模态请求在主进程执行（DR-004）；失败以 promise reject 传递错误消息。
 */
import { ipcMain } from 'electron'
import { CC } from '@shared/ipc/channels'
import type { VisionReadBoardRequest, VisionReadBoardResult } from '@shared/ipc/types'
import type { VisionReader } from '../services/visionReader'

export function registerVisionIpc(reader: VisionReader): void {
  ipcMain.handle(
    CC.vision.readBoard,
    (_event, req: VisionReadBoardRequest): Promise<VisionReadBoardResult> => reader.readBoard(req)
  )
}
