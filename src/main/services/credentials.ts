/**
 * 凭据存储（Electron safeStorage 三槽位，07 文档 §4）：对应 llm_config_store.dart。
 *
 * - 槽位：llm_config_red / llm_config_black / llm_config_assistant；
 * - 配置整体 JSON 经 safeStorage.encryptString 加密 → base64 落 userData/credentials.enc
 *   （文件格式 = JSON `{槽位: base64 密文}`，DR-006 ①）；
 * - 解密失败 / 文件损坏 / 缺失一律按未配置处理（对齐原版"读失败按未配置"）；
 * - 系统安全存储不可用（WSL 无 Secret Service 等）：明文回退文件
 *   credentials.fallback.json（0600，DR-011），读写/delete 双文件贯通，
 *   加密文件优先；set 返回实际落盘方式供界面如实告知；
 * - 渲染层只见掩码 Key（****+末 4 位），完整 Key 不进渲染层内存、不进日志。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import type { SecureSlot } from '@shared/ipc/types'
import type { LlmEndpointConfig, SecureSetResult } from '@shared/ipc/types'
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
  private plainWarned = false

  constructor(
    private readonly cryptor: Cryptor,
    private readonly filePath: string
  ) {}

  /** 读取槽位：apiKey 已掩码；未配置/损坏返回 null（llm_config_store.dart:42-51）。
   * 读取顺序：加密文件 → 明文回退文件（DR-011）。 */
  get(slot: SecureSlot): LlmEndpointConfig | null {
    const encrypted = this.readEncrypted(slot)
    if (encrypted !== undefined) {
      // 加密文件存在该槽位：null（读失败按未配置）或解密后的配置。
      return encrypted === null ? null : { ...encrypted, apiKey: maskApiKey(encrypted.apiKey) }
    }
    const plain = this.readPlain(slot)
    return plain === null ? null : { ...plain, apiKey: maskApiKey(plain.apiKey) }
  }

  /**
   * 读取槽位完整配置（apiKey 不掩码）——仅供主进程内部使用（DR-010：
   * llm-proxy/testConnection 注入真实 Authorization），任何路径不得把
   * 返回值发给渲染层或写日志。加密文件优先，明文回退文件兜底。
   */
  getRaw(slot: SecureSlot): LlmEndpointConfig | null {
    const encrypted = this.readEncrypted(slot)
    if (encrypted !== undefined && encrypted !== null) return encrypted
    return this.readPlain(slot)
  }

  /** 加密文件单槽位读取：undefined=文件/槽位缺失；null=解密/格式失败（按未配置）。 */
  private readEncrypted(slot: SecureSlot): LlmEndpointConfig | null | undefined {
    try {
      const file = this.readFile()
      const payload = file[slot]
      if (payload === undefined || payload === '') return undefined
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

  /**
   * 整体加密写入槽位；安全存储不可用时走明文回退文件（DR-011）。
   * 返回实际落盘方式，供界面如实告知用户。
   *
   * 掩码合并（DR-013）：渲染层回读的 apiKey 是掩码（****+末4位），页面
   * 防抖保存/卸载回写会把整个配置原样写回——若不合并，掩码字符串会覆盖
   * 真实 Key（重启后 Key 失效）。apiKey 呈掩码形态时保留存储中的原 Key，
   * 仅更新其余字段；无原 Key 可恢复时按空 Key 处理。
   */
  set(slot: SecureSlot, payload: LlmEndpointConfig): SecureSetResult {
    const merged = this.mergeMaskedKey(slot, payload)
    if (this.cryptor.isAvailable()) {
      const file = this.readFile()
      file[slot] = this.cryptor.encrypt(JSON.stringify(merged))
      this.writeFile(file)
      return { stored: 'encrypted' }
    }
    const plain = this.readPlainFile()
    plain[slot] = merged
    this.writePlainFile(plain)
    if (!this.plainWarned) {
      this.plainWarned = true
      console.warn(
        `[credentials] 系统安全存储不可用（如 WSL 未运行 Secret Service），` +
          `凭据已明文写入 ${this.fallbackPath()}（权限 0600，仅当前用户可读）`
      )
    }
    return { stored: 'plainFallback' }
  }

  /** 掩码 Key 合并：掩码形态（**** 前缀）→ 沿用存储中的原 Key；无原 Key → 空。 */
  private mergeMaskedKey(slot: SecureSlot, payload: LlmEndpointConfig): LlmEndpointConfig {
    const key = payload.apiKey.trim()
    if (!key.startsWith('****')) return payload
    const existing = this.getRaw(slot)
    return { ...payload, apiKey: existing?.apiKey ?? '' }
  }

  delete(slot: SecureSlot): void {
    if (existsSync(this.filePath)) {
      const file = this.readFile()
      if (file[slot] !== undefined) {
        delete file[slot]
        this.writeFile(file)
      }
    }
    if (existsSync(this.fallbackPath())) {
      const plain = this.readPlainFile()
      if (plain[slot] !== undefined) {
        delete plain[slot]
        this.writePlainFile(plain)
      }
    }
  }

  /** 明文回退文件路径（DR-011）：<userData>/credentials.fallback.json */
  private fallbackPath(): string {
    return `${this.filePath}.plain.json`
  }

  private readPlain(slot: SecureSlot): LlmEndpointConfig | null {
    const file = this.readPlainFile()
    const cfg = file[slot]
    if (cfg === undefined) return null
    if (typeof cfg.baseUrl !== 'string' || typeof cfg.model !== 'string') return null
    return {
      baseUrl: cfg.baseUrl,
      apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : '',
      model: cfg.model,
      disableThinking: cfg.disableThinking === true
    }
  }

  private readPlainFile(): Partial<Record<SecureSlot, LlmEndpointConfig | undefined>> {
    const path = this.fallbackPath()
    if (!existsSync(path)) return {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Partial<Record<SecureSlot, LlmEndpointConfig | undefined>>
      }
    } catch {
      // 损坏视为无凭据（后续写入重建）
    }
    return {}
  }

  private writePlainFile(file: Partial<Record<SecureSlot, LlmEndpointConfig | undefined>>): void {
    // 原子写 + 0600（仅当前用户可读）
    const tmp = `${this.fallbackPath()}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.fallbackPath())
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
