/**
 * 棋谱"进入对战"启动器（对应 record_battle_launcher.dart launchBattle 的 UI 部分）。
 * 选择模式 →（内置 AI 时）选择执方 → 携 fen/side query 跳转对应对战页。
 * 各对战页对 fen 来源的续战已做 canSave=false 门控（防污染模式存档桶）。
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BATTLE_MODE_OPTIONS, battleRouteFor, type BattleModeOption } from '@packages/storage-schema/recordBattle'

export interface RecordLauncherDialogProps {
  /** 起点局面（battleStartFen 的结果；null 时不应打开本弹层） */
  startFen: string
  onClose: () => void
}

export function RecordLauncherDialog({ startFen, onClose }: RecordLauncherDialogProps): React.JSX.Element {
  const navigate = useNavigate()
  const [pickingSide, setPickingSide] = useState<BattleModeOption | null>(null)

  const launch = (mode: BattleModeOption, playerSide?: 'red' | 'black'): void => {
    navigate(battleRouteFor(mode.id, startFen, playerSide))
  }

  return (
    <div className="cc-dialog-mask" data-testid="record-launcher-dialog">
      <div className="cc-dialog" role="dialog" aria-modal="true">
        <div className="cc-dialog-title">选择对战模式（从保存局面继续）</div>
        <div className="cc-dialog-content">
          {pickingSide === null ? (
            BATTLE_MODE_OPTIONS.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className="cc-btn"
                style={{ display: 'block', width: '100%', marginBottom: 8, textAlign: 'left' }}
                onClick={() => {
                  if (mode.id === 'humanVsAi') {
                    setPickingSide(mode) // 人机 AI：附执方选择
                  } else {
                    launch(mode)
                  }
                }}
              >
                <strong>{mode.label}</strong>
                <div style={{ fontSize: 12, color: 'var(--cc-seed-dark)' }}>{mode.subtitle}</div>
              </button>
            ))
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>{pickingSide.label} · 选择执方（AI 执另一方）</div>
              <button
                type="button"
                className="cc-btn"
                style={{ display: 'block', width: '100%', marginBottom: 8 }}
                onClick={() => launch(pickingSide, 'red')}
              >
                玩家执红
              </button>
              <button
                type="button"
                className="cc-btn"
                style={{ display: 'block', width: '100%' }}
                onClick={() => launch(pickingSide, 'black')}
              >
                玩家执黑
              </button>
            </>
          )}
        </div>
        <div className="cc-dialog-actions">
          <button
            type="button"
            className="cc-btn"
            onClick={() => {
              if (pickingSide !== null) setPickingSide(null)
              else onClose()
            }}
          >
            {pickingSide !== null ? '返回' : '取消'}
          </button>
        </div>
      </div>
    </div>
  )
}
