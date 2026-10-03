/**
 * API Key 掩码（对齐 llm_config.dart:80-84 maskedApiKey 语义）。
 * 纯函数：主进程 secure.get 回读掩码、渲染层配置卡回显共用。
 * 完整 Key 不得进入日志/异常消息/UI。
 */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length === 0) return ''
  if (apiKey.length <= 4) return '****'
  return `****${apiKey.slice(-4)}`
}
