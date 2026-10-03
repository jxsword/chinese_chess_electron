/**
 * 全局设置弹窗（对应 app.dart _showGlobalSettings，08 文档 §6）。
 * 仅"自动保存棋局"开关；每次打开重新读取（防多入口失步），改动即写 electron-store。
 */
import { useEffect } from 'react'
import { useGlobalSettings } from '@renderer/stores/globalSettings'

export function GlobalSettingsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const autoSave = useGlobalSettings((s) => s.autoSave)
  const setAutoSave = useGlobalSettings((s) => s.setAutoSave)

  // 打开前加载持久化值，避免展示过期缓存（app.dart:164-167）
  useEffect(() => {
    void useGlobalSettings.getState().load()
  }, [])

  return (
    <div className="cc-dialog-mask" data-testid="global-settings-dialog" onClick={onClose}>
      <div className="cc-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="cc-dialog-title">全局设置</div>
        <label className="cc-settings-switch">
          <input
            type="checkbox"
            checked={autoSave}
            onChange={(e) => {
              void setAutoSave(e.target.checked)
            }}
          />
          <div>
            <div>自动保存棋局</div>
            <div className="cc-settings-hint">
              离开棋盘或应用切后台时自动保存当前棋局；关闭后仅点击棋盘页"保存棋局"按钮才保存。
            </div>
          </div>
        </label>
        <div className="cc-dialog-actions">
          <button type="button" className="cc-btn cc-btn-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
