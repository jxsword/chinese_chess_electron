/**
 * LLM 协议错误类型（对应 llm_move_source.dart:535-549）。
 * 纯 TypeScript：禁止 import DOM / Node / React 任何符号（铁律 #1）。
 */

/** 配置缺失类异常（toString 即消息，等价 Dart LlmConfigException）。 */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmConfigError'
  }
  override toString(): string {
    return this.message
  }
}

/** API 调用类异常（HTTP 非 200 / 流式错误 / 超时，等价 Dart LlmApiException）。 */
export class LlmApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmApiError'
  }
  override toString(): string {
    return this.message
  }
}

/**
 * 把"模型类型用错"的典型服务端报错翻译成可操作的提示（llm_move_source.dart:499-523，
 * 公开以便单测）。
 *
 * 两类典型：
 * - 图片生成模型（qwen-image-* 等）：请求被路由到原生生成接口并用
 *   input.messages 的格式校验，报 "Input should be 'user': input.messages ..."；
 * - 翻译模型（qwen-mt-* 等）：不支持流式，报 "Streaming translation is
 *   not supported"——输入虽可多模态，但任务是翻译，不能用于识图。
 *
 * Electron 版差异：主进程代理在 HTTP≠200 路径已附加过提示（05 §3.2），
 * 本函数幂等——消息已含提示时原样返回，避免重复追加。
 */
export function annotateModelHint(message: string): string {
  if (
    message.includes('提示：这是翻译模型') ||
    message.includes('提示：该模型可能不支持 OpenAI 兼容对话接口')
  ) {
    return message
  }
  const lower = message.toLowerCase()
  if (lower.includes('streaming translation') || lower.includes('translation is not supported')) {
    return (
      `${message}\n\n提示：这是翻译模型（qwen-mt-* 系列），` +
      '不支持流式输出、也不能做棋盘识图。识图请改用视觉理解模型' +
      '（如 qwen-vl-max、qwen3-vl-plus、glm-4.5v）。'
    )
  }
  const looksLikeWrongModelType =
    message.includes('invalid_parameter_error') ||
    message.includes("should be 'user'") ||
    message.includes('input.messages')
  if (looksLikeWrongModelType) {
    return (
      `${message}\n\n提示：该模型可能不支持 OpenAI 兼容对话接口` +
      '（图片生成类模型会这样报错）。识图请改用视觉理解模型' +
      '（如 qwen-vl-max、glm-4.5v），对话请改用对应对话模型。'
    )
  }
  return message
}
