/**
 * cc:store:*（electron-store 设置）与 cc:secure:*（凭据三槽位）通道 handler。
 */
import { ipcMain } from 'electron'
import { CC } from '@shared/ipc/channels'
import type { SecureSlot, LlmEndpointConfig } from '@shared/ipc/types'
import type { SettingsService } from '../services/settings'
import type { CredentialsService } from '../services/credentials'

export function registerStoreIpc(settings: SettingsService): void {
  ipcMain.handle(CC.store.get, (_event, req: { key: string }) => settings.get(req.key))
  ipcMain.handle(CC.store.set, (_event, req: { key: string; value: unknown }) => {
    settings.set(req.key, req.value)
  })
}

export function registerSecureIpc(credentials: CredentialsService): void {
  ipcMain.handle(CC.secure.get, (_event, req: { slot: SecureSlot }) => credentials.get(req.slot))
  ipcMain.handle(CC.secure.set, (_event, req: { slot: SecureSlot; payload: LlmEndpointConfig }) => {
    credentials.set(req.slot, req.payload)
  })
  ipcMain.handle(CC.secure.delete, (_event, req: { slot: SecureSlot }) => {
    credentials.delete(req.slot)
  })
}
