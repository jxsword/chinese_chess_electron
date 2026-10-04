/**
 * 研究助手模型配置弹窗（对应 assistant_config_dialog.dart）：
 * 残局求解辅助与棋盘识图共用的助手槽位（llm_config_assistant），
 * 预设为视觉理解模型清单（05 文档 §7：qwen-vl-max / glm-4.5v / gpt-4o-mini 等）。
 * Key 经 cc:secure 槽位加密落盘，回显掩码（DR-010）。
 */
import { useEffect, useState } from 'react'
import { VISION_LLM_PRESETS } from '@packages/llm'
import type { LlmEndpointConfig } from '@shared/ipc/types'
import { api } from '@renderer/ipc/client'
import { LlmConfigCard } from '@renderer/features/settings/LlmConfigCard'

const EMPTY_CONFIG: LlmEndpointConfig = { baseUrl: '', apiKey: '', model: '', disableThinking: true }

export function AssistantConfigDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [config, setConfig] = useState<LlmEndpointConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.secure
      .get('llm_config_assistant')
      .then((loaded) => {
        if (!cancelled) setConfig(loaded ?? EMPTY_CONFIG)
      })
      .catch(() => {
        if (!cancelled) setConfig(EMPTY_CONFIG)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = (): void => {
    if (config === null) return
    void api.secure
      .set('llm_config_assistant', config)
      .catch(() => undefined)
      .then(onClose)
  }

  return (
    <div className="cc-dialog-mask" data-testid="assistant-config-dialog">
      <div className="cc-dialog" role="dialog" aria-modal="true" style={{ maxWidth: 460 }}>
        <div className="cc-dialog-title">研究助手模型</div>
        <div className="cc-dialog-content">
          {config === null ? (
            <div>加载中…</div>
          ) : (
            <LlmConfigCard
              title="求解辅助 / 识图（需视觉理解模型）"
              slot="llm_config_assistant"
              config={config}
              onChange={setConfig}
              presets={VISION_LLM_PRESETS}
            />
          )}
        </div>
        <div className="cc-dialog-actions">
          <button type="button" className="cc-btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="cc-btn" disabled={config === null} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
