import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SettingsService } from '@main/services/settings'
import { SETTING_KEYS } from '@shared/constants'

// T2.2 验收（07 文档 §3）：global_auto_save 默认 true；set/get 往返（对应 cc:store:*）。

describe('SettingsService（electron-store）', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-settings-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('global_auto_save 缺省为 true（07 §3 默认值）', () => {
    const svc = new SettingsService({ cwd: dir })
    expect(svc.get(SETTING_KEYS.globalAutoSave)).toBe(true)
  })

  it('set/get 往返；缺键返回 null（对齐 cc:store 契约与 mock 行为）', () => {
    const svc = new SettingsService({ cwd: dir })
    expect(svc.get('corpus.userPath')).toBeNull()
    svc.set(SETTING_KEYS.globalAutoSave, false)
    expect(svc.get(SETTING_KEYS.globalAutoSave)).toBe(false)
    svc.set('corpus.userPath', '/tmp/corpus')
    expect(svc.get('corpus.userPath')).toBe('/tmp/corpus')
  })

  it('实例间持久化（同 cwd 重开读到已存值）', () => {
    const first = new SettingsService({ cwd: dir })
    first.set(SETTING_KEYS.globalAutoSave, false)
    const second = new SettingsService({ cwd: dir })
    expect(second.get(SETTING_KEYS.globalAutoSave)).toBe(false)
  })

  it('显式 defaults 不覆盖已存值', () => {
    new SettingsService({ cwd: dir }).set(SETTING_KEYS.globalAutoSave, false)
    const reopened = new SettingsService({ cwd: dir })
    expect(reopened.get(SETTING_KEYS.globalAutoSave)).toBe(false)
  })
})
