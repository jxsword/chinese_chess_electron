import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CredentialsService, type Cryptor } from '@main/services/credentials'

// T2.2 验收（07 文档 §4）：掩码不泄 Key；读失败按未配置。
// safeStorage 依赖 Electron 运行时，单测注入伪加密器（base64 代加密）。

function fakeCryptor(broken = false): Cryptor {
  return {
    isAvailable: () => !broken,
    encrypt: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: (payload) => {
      if (broken) throw new Error('解密失败（模拟 DPAPI/keychain 异常）')
      return Buffer.from(payload, 'base64').toString('utf8')
    }
  }
}

const CONFIG = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-secret-1234567890abcd',
  model: 'glm-4-flash',
  disableThinking: true
}

describe('CredentialsService（safeStorage 三槽位语义）', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-credentials-'))
    filePath = join(dir, 'credentials.enc')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('set 后 get 返回掩码 Key（****+末 4 位），完整 Key 不回渲染层', () => {
    const svc = new CredentialsService(fakeCryptor(), filePath)
    svc.set('llm_config_red', CONFIG)
    const got = svc.get('llm_config_red')!
    expect(got.baseUrl).toBe(CONFIG.baseUrl)
    expect(got.model).toBe(CONFIG.model)
    expect(got.disableThinking).toBe(true)
    expect(got.apiKey).toBe('****abcd')
    expect(got.apiKey).not.toBe(CONFIG.apiKey)
    expect(JSON.stringify(got)).not.toContain(CONFIG.apiKey)
  })

  it('落盘文件不含明文 Key', () => {
    const svc = new CredentialsService(fakeCryptor(), filePath)
    svc.set('llm_config_black', CONFIG)
    const raw = readFileSync(filePath, 'utf8')
    expect(raw).not.toContain(CONFIG.apiKey)
  })

  it('文件缺失 / 未写入槽位 → 未配置（null）', () => {
    const svc = new CredentialsService(fakeCryptor(), filePath)
    expect(svc.get('llm_config_red')).toBeNull()
    svc.set('llm_config_black', CONFIG)
    expect(svc.get('llm_config_red')).toBeNull()
    expect(svc.get('llm_config_black')).not.toBeNull()
  })

  it('解密失败按未配置处理（对齐原版"读失败按未配置"）', () => {
    const svc = new CredentialsService(fakeCryptor(), filePath)
    svc.set('llm_config_assistant', CONFIG)
    const brokenReader = new CredentialsService(fakeCryptor(true), filePath)
    expect(brokenReader.get('llm_config_assistant')).toBeNull()
  })

  it('密文被篡改 / 文件损坏 → 未配置', () => {
    const svc = new CredentialsService(fakeCryptor(), filePath)
    svc.set('llm_config_red', CONFIG)
    // 篡改：覆盖为非法 base64 JSON
    writeFileSync(filePath, JSON.stringify({ llm_config_red: '@@@not-base64@@@' }), 'utf8')
    expect(svc.get('llm_config_red')).toBeNull()
    // 整个文件损坏
    writeFileSync(filePath, '{corrupt', 'utf8')
    expect(svc.get('llm_config_red')).toBeNull()
  })

  it('Key 长度 ≤4 掩码为 ****；空 Key 掩码为空', () => {
    const svc = new CredentialsService(fakeCryptor(), filePath)
    svc.set('llm_config_red', { ...CONFIG, apiKey: 'abc' })
    expect(svc.get('llm_config_red')!.apiKey).toBe('****')
    svc.set('llm_config_red', { ...CONFIG, apiKey: '' })
    expect(svc.get('llm_config_red')!.apiKey).toBe('')
  })

  it('delete 移除槽位后按未配置；其余槽位不受影响', () => {
    const svc = new CredentialsService(fakeCryptor(), filePath)
    svc.set('llm_config_red', CONFIG)
    svc.set('llm_config_black', CONFIG)
    svc.delete('llm_config_red')
    expect(svc.get('llm_config_red')).toBeNull()
    expect(svc.get('llm_config_black')).not.toBeNull()
    // 重复 delete 幂等
    expect(() => svc.delete('llm_config_red')).not.toThrow()
  })

  it('安全存储不可用：明文回退文件落盘且读取掩码（DR-011）', () => {
    const svc = new CredentialsService(fakeCryptor(true), filePath)
    expect(svc.set('llm_config_red', CONFIG)).toEqual({ stored: 'plainFallback' })
    // 回退文件路径与内容（明文本就是回退的目的，含完整 Key）
    const plainPath = `${filePath}.plain.json`
    const raw = readFileSync(plainPath, 'utf8')
    expect(raw).toContain(CONFIG.apiKey)
    // 渲染层仍只见掩码
    const got = svc.get('llm_config_red')!
    expect(got.model).toBe(CONFIG.model)
    expect(got.apiKey).toBe('****abcd')
    expect(JSON.stringify(got)).not.toContain(CONFIG.apiKey)
    // getRaw（主进程注入鉴权用）拿到完整 Key
    expect(svc.getRaw('llm_config_red')!.apiKey).toBe(CONFIG.apiKey)
  })

  it('加密文件优先于明文回退文件（双文件贯通）', () => {
    // 先明文保存（安全存储不可用）
    const plainSvc = new CredentialsService(fakeCryptor(true), filePath)
    expect(plainSvc.set('llm_config_red', { ...CONFIG, model: 'plain-model' })).toEqual({
      stored: 'plainFallback'
    })
    // 再加密保存同槽位（安全存储恢复可用）
    const encSvc = new CredentialsService(fakeCryptor(), filePath)
    expect(encSvc.set('llm_config_red', { ...CONFIG, model: 'enc-model' })).toEqual({
      stored: 'encrypted'
    })
    // 读取以加密文件为准
    const reader = new CredentialsService(fakeCryptor(), filePath)
    expect(reader.get('llm_config_red')!.model).toBe('enc-model')
    // delete 清理双文件
    reader.delete('llm_config_red')
    expect(reader.get('llm_config_red')).toBeNull()
    // 明文文件仍保留 black 槽位（如曾写入）→ 单独验证 black 明文写入/读取/删除
    expect(plainSvc.set('llm_config_black', { ...CONFIG, model: 'plain-b' })).toEqual({
      stored: 'plainFallback'
    })
    expect(reader.get('llm_config_black')!.model).toBe('plain-b')
    reader.delete('llm_config_black')
    expect(reader.get('llm_config_black')).toBeNull()
  })

  it('回退文件损坏 → 按未配置（不抛错）', () => {
    const svc = new CredentialsService(fakeCryptor(true), filePath)
    writeFileSync(`${filePath}.plain.json`, '{corrupt', 'utf8')
    expect(svc.get('llm_config_red')).toBeNull()
    // 损坏后写入重建
    expect(svc.set('llm_config_red', CONFIG)).toEqual({ stored: 'plainFallback' })
    expect(svc.get('llm_config_red')!.model).toBe(CONFIG.model)
  })
})
