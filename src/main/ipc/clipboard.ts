/**
 * cc:clipboard:write 通道 handler（00 文档 §3.1）：主进程 Electron clipboard 写入。
 * M2 双人页"分享棋局"使用；曾遗漏注册导致 invoke 拒绝（运行期缺陷修复）。
 */
import { clipboard, ipcMain } from 'electron'
import { CC } from '@shared/ipc/channels'

export function registerClipboardIpc(): void {
  ipcMain.handle(CC.clipboard.write, (_event, req: { text: string }) => {
    clipboard.writeText(req.text)
  })
}
