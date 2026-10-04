/**
 * 凭据存储（Electron safeStorage 三槽位，07 文档 §4）：对应 llm_config_store.dart。
 *
 * - 槽位：llm_config_red / llm_config_black / llm_config_assistant；
 * - 配置整体 JSON 经 safeStorage.encryptString 加密 → base64 落 userData/credentials.enc
 *   （文件格式 = JSON `{槽位: base64 密文}`，DR-006 ①）；
 * - 解密失败 / 文件损坏 / 缺失一律按未配置处理（对齐原版"读失败按未配置"）；
 * - 渲染层只见掩码 Key（****+末 4 位），完整 Key 不进渲染层内存、不进日志；
 * - safeStorage 不可用（Linux 无 libsecret 等）时：set 抛错、get 按未配置。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import type { SecureSlot } from '@shared/ipc/types'
import type { LlmEndpointConfig } from '@shared/ipc/types'
import { maskApiKey } from '@shared/mask'

/** 加密器抽象：默认实现用 Electron safeStorage；测试注入伪加密器 */
export interface Cryptor {
  isAvailable(): boolean
  /** 明文 → 可落盘字符串（base64 密文） */
  encrypt(plain: string): string
  /** 可落盘字符串 → 明文；失败抛错 */
  decrypt(payload: string): string
}

interface CredentialFile {
  [slot: string]: string | undefined
}

export class CredentialsService {
  constructor(
    private readonly cryptor: Cryptor,
    private readonly filePath: string
  ) {}

  /** 读取槽位：apiKey 已掩码；未配置/损坏返回 null（llm_config_store.dart:42-51） */
  get(slot: SecureSlot): LlmEndpointConfig | null {
    const cfg = this.getRaw(slot)
    if (cfg === null) return null
    return { ...cfg, apiKey: maskApiKey(cfg.apiKey) }
  }

  /**
   * 读取槽位完整配置（apiKey 不掩码）——仅供主进程内部使用（DR-010：
   * llm-proxy 注入真实 Authorization），任何路径不得把返回值发给渲染层或写日志。
   */
  getRaw(slot: SecureSlot): LlmEndpointConfig | null {
    try {
      const file = this.readFile()
      const payload = file[slot]
      if (payload === undefined || payload === '') return null
      const parsed: unknown = JSON.parse(this.cryptor.decrypt(payload))
      if (typeof parsed !== 'object' || parsed === null) return null
      const cfg = parsed as Partial<LlmEndpointConfig>
      if (typeof cfg.baseUrl !== 'string' || typeof cfg.model !== 'string') return null
      return {
        baseUrl: cfg.baseUrl,
        apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : '',
        model: cfg.model,
        disableThinking: cfg.disableThinking === true
      }
    } catch {
      // 解密失败按未配置处理（07 §4）
      return null
    }
  }

  /** 整体加密写入槽位；安全存储不可用时抛错（由 invoke 拒绝传达给渲染层） */
  set(slot: SecureSlot, payload: LlmEndpointConfig): void {
    if (!this.cryptor.isAvailable()) {
      throw new Error('安全存储不可用，无法保存凭据')
    }
    const file = this.readFile()
    file[slot] = this.cryptor.encrypt(JSON.stringify(payload))
    this.writeFile(file)
  }

  delete(slot: SecureSlot): void {
    const file = this.readFile()
    if (file[slot] === undefined) return
    delete file[slot]
    this.writeFile(file)
  }

  private readFile(): CredentialFile {
    if (!existsSync(this.filePath)) return {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) return parsed as CredentialFile
    } catch {
      // 文件损坏视为无凭据（后续写入会重建文件）
      return {}
    }
    return {}
  }

  private writeFile(file: CredentialFile): void {
    // 原子写：临时文件 + rename，避免中断产生半截密文
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(file), 'utf8')
    renameSync(tmp, this.filePath)
  }
}

/**
 * Electron safeStorage 实现（密文 = base64(encryptString(明文))）。
 * safeStorage 由调用方注入（避免测试加载 electron）。
 */
export function safeStorageCryptor(safeStorage: {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}): Cryptor {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, 'base64'))
  }
}
