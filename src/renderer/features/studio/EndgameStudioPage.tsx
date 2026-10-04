/**
 * 残局工作室（对应 endgame_studio_page.dart，08 文档 §4 三 Tab）：
 * 摆盘 / FEN 导入 / 图片识图 → 整体校验五条 → 保存棋局（未求解）/ AI 求破解。
 *
 * 摆放即时校验（九宫/士象斜线田字/兵卒底线/数量上限）逐条对齐 board_setup_rules.dart；
 * 识图结果载入棋盘后必须人工核对才可求解（05 文档 §7 管线尾段）；
 * 求解完成后（含无解/超时）三种结论全部自动入库为棋谱（04 文档 §7 状态机）。
 * 求解在 solver.worker 内运行（04 §2），进度弹窗不可误关（TC-SOL-007）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  buildFen,
  isValidFen,
  parseBoardFen,
  parseTurnFen,
  pieceFromFenChar,
  pieceLabel,
  FEN_INITIAL,
  type BoardGrid,
  type Piece,
  type PieceKind
} from '@packages/rules'
import { formatIccs } from '@packages/parsers'
import { chineseNotations } from '@packages/storage-schema'
import { detectImageMime } from '@packages/llm'
import type { SolveResult } from '@packages/solver'
import { placementIssue, countIssueForPlacement } from './setupRules'
import {
  solveLabelOf,
  studioRecordTitle,
  studioUnsolvedTitle,
  validateStudioPosition
} from './studioValidate'
import { SolverClient } from '@renderer/workers/solverClient'
import { BoardViewStatic } from '@renderer/features/board/BoardViewStatic'
import { api } from '@renderer/ipc/client'

const SOLVE_TIME_OPTIONS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: '10 秒', ms: 10_000 },
  { label: '30 秒', ms: 30_000 },
  { label: '1 分钟', ms: 60_000 },
  { label: '3 分钟', ms: 180_000 }
]

const SOLVE_DEPTH_OPTIONS: ReadonlyArray<{ label: string; plies: number }> = [
  { label: '浅（3 着内）', plies: 5 },
  { label: '标准（5 着内）', plies: 9 },
  { label: '深（7 着内，较慢）', plies: 13 }
]

/** 结果 BottomSheet 的状态（一次求解一张）。 */
interface SolveSheet {
  fen: string
  result: SolveResult
  /** 入库返回的棋谱 id；null = 保存失败 */
  recordId: number | null
}

const emptyGrid = (): BoardGrid => Array.from({ length: 10 }, () => Array<Piece | null>(9).fill(null))

const initialGrid = (): BoardGrid => parseBoardFen(FEN_INITIAL)

const PALETTE_KINDS: readonly PieceKind[] = ['king', 'advisor', 'minister', 'knight', 'rook', 'cannon', 'pawn']

/** 棋子种类 → 小写 FEN 字符（红方大写化；注意象为 b 非 m，piece.dart:31-49）。 */
const KIND_FEN_CHAR: Readonly<Record<PieceKind, string>> = {
  king: 'k',
  advisor: 'a',
  minister: 'b',
  knight: 'n',
  rook: 'r',
  cannon: 'c',
  pawn: 'p'
}

const pieceOf = (kind: PieceKind, side: 'red' | 'black'): Piece => {
  const char = side === 'red' ? KIND_FEN_CHAR[kind]!.toUpperCase() : KIND_FEN_CHAR[kind]!
  const p = pieceFromFenChar(char)
  if (p === null) throw new Error(`bad piece kind: ${kind}`)
  return p
}

/** Uint8Array → base64（分块拼接避免 String.fromCharCode 爆栈）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function EndgameStudioPage(): React.JSX.Element {
  const navigate = useNavigate()

  // 摆盘编辑（endgame_studio_page.dart 字段一一对应）
  const [grid, setGrid] = useState<BoardGrid>(emptyGrid)
  const [redTurn, setRedTurn] = useState(true)
  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null)
  const [eraser, setEraser] = useState(false)
  const [tab, setTab] = useState<'setup' | 'fen' | 'vision'>('setup')

  // FEN 导入
  const [fenInput, setFenInput] = useState('')

  // 图片识图
  const [readingImage, setReadingImage] = useState(false)
  const [visionMessage, setVisionMessage] = useState<string | null>(null)
  const [visionElapsed, setVisionElapsed] = useState(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const visionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 求解
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [timeLimitMs, setTimeLimitMs] = useState(30_000)
  const [maxPlies, setMaxPlies] = useState(9)
  const [solving, setSolving] = useState(false)
  const [solveElapsed, setSolveElapsed] = useState(0)
  const [sheet, setSheet] = useState<SolveSheet | null>(null)

  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const solveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const solverRef = useRef<SolverClient | null>(null)
  useEffect(() => {
    const client = new SolverClient()
    solverRef.current = client
    return () => {
      client.dispose()
      solverRef.current = null
    }
  }, [])

  useEffect(
    () => () => {
      if (visionTimerRef.current !== null) clearInterval(visionTimerRef.current)
      if (solveTimerRef.current !== null) clearInterval(solveTimerRef.current)
      if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
    },
    []
  )

  const showToast = useCallback((message: string): void => {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = setTimeout(() => setToast(null), 2600)
  }, [])

  const currentFen = useMemo(() => buildFen({ board: grid, isRedTurn: redTurn }), [grid, redTurn])

  // ---------------------------------------------------------------------------
  // 摆盘编辑
  // ---------------------------------------------------------------------------

  const countKind = (piece: Piece): number => {
    let count = 0
    for (const row of grid) {
      for (const p of row) {
        if (p !== null && p.kind === piece.kind && p.side === piece.side) count++
      }
    }
    return count
  }

  const handleCellTap = (col: number, row: number): void => {
    if (eraser) {
      setGrid((g) => {
        const next = g.map((r) => [...r])
        next[row][col] = null
        return next
      })
      return
    }
    const piece = selectedPiece
    if (piece !== null) {
      const occupant = grid[row][col]
      // 位置合法性：放置时即校验（九宫/士象斜线/兵卒底线等）。
      const issue = placementIssue(piece, col, row)
      if (issue !== null) {
        showToast(issue)
        return
      }
      // 数量合法性：同格同子为替换（数量不变），否则校验上限。
      const countIssue = countIssueForPlacement(piece, countKind(piece), occupant)
      if (countIssue !== null) {
        showToast(countIssue)
        return
      }
      setGrid((g) => {
        const next = g.map((r) => [...r])
        next[row][col] = piece
        return next
      })
      return
    }
    // 未选棋子：点击已有棋子为取走。
    setGrid((g) => {
      const next = g.map((r) => [...r])
      next[row][col] = null
      return next
    })
  }

  // ---------------------------------------------------------------------------
  // FEN 导入
  // ---------------------------------------------------------------------------

  const importFen = (): void => {
    let fen = fenInput.trim()
    if (fen === '') return
    if (fen.split(/\s+/).length === 1) {
      fen = `${fen} ${redTurn ? 'w' : 'b'}`
    }
    if (!isValidFen(fen)) {
      showToast('FEN 无效，请检查格式')
      return
    }
    setGrid(parseBoardFen(fen))
    setRedTurn(parseTurnFen(fen))
    showToast(`已载入（${parseTurnFen(fen) ? '红' : '黑'}方行棋），可在摆盘页微调`)
  }

  // ---------------------------------------------------------------------------
  // 图片识图（多模态大模型）
  // ---------------------------------------------------------------------------

  const readImageFile = async (file: File): Promise<void> => {
    setReadingImage(true)
    setVisionMessage(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // 计时从"图片已选中"开始：文件浏览期间不计入。
      setVisionElapsed(0)
      if (visionTimerRef.current !== null) clearInterval(visionTimerRef.current)
      visionTimerRef.current = setInterval(() => setVisionElapsed((v) => v + 1), 1000)

      const config = await api.secure.get('llm_config_assistant')
      if (config === null || config.baseUrl.trim() === '' || config.model.trim() === '') {
        setVisionMessage('请先配置研究助手模型（需视觉模型）')
        return
      }
      const result = await api.vision.readBoard({
        config,
        imageBase64: bytesToBase64(bytes),
        mime: detectImageMime(bytes),
        authSlot: 'llm_config_assistant'
      })
      const loaded = parseBoardFen(result.fen)
      const turn = parseTurnFen(result.fen)
      setGrid(loaded)
      setRedTurn(turn)
      const pieceCount = loaded.flat().filter((p) => p !== null).length
      setVisionMessage(
        `识别到 ${pieceCount} 枚棋子（${turn ? '红' : '黑'}方行棋），已载入棋盘，请人工核对后再求解`
      )
    } catch (e) {
      setVisionMessage(`识图失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (visionTimerRef.current !== null) clearInterval(visionTimerRef.current)
      visionTimerRef.current = null
      setReadingImage(false)
    }
  }

  // ---------------------------------------------------------------------------
  // 求解与入库
  // ---------------------------------------------------------------------------

  const problems = useMemo(() => validateStudioPosition(grid, redTurn), [grid, redTurn])

  const saveUnsolvedRecord = async (): Promise<void> => {
    if (problems.length > 0) {
      showToast(problems.join('；'))
      return
    }
    try {
      await api.db.recordsSave({
        title: studioUnsolvedTitle(redTurn),
        mode: 'endgame',
        initialFen: currentFen,
        moves: [],
        result: null,
        solveStatus: 'none',
        solutions: [],
        llmNote: null,
        note: null,
        createdAt: Date.now()
      })
      showToast('棋局已保存到棋谱库（未求解）')
    } catch {
      showToast('保存失败：本地存储不可用')
    }
  }

  const startSolve = (): void => {
    if (problems.length > 0) {
      showToast(problems.join('；'))
      return
    }
    setOptionsOpen(true)
  }

  const persistRecord = async (fen: string, result: SolveResult): Promise<number | null> => {
    try {
      const solutions = result.solutions.map((s) =>
        s.moves
          .map((m) => formatIccs(m.from, m.to) ?? '')
          .filter((code) => code !== '')
      )
      return await api.db.recordsSave({
        title: studioRecordTitle(solveLabelOf(result.status, result.solutions.length), redTurn),
        mode: 'endgame',
        initialFen: fen,
        moves: [],
        result: null,
        solveStatus: result.status,
        solutions,
        llmNote: null,
        note: null,
        createdAt: Date.now()
      })
    } catch {
      return null
    }
  }

  const confirmSolve = async (): Promise<void> => {
    const fen = currentFen
    setOptionsOpen(false)
    setSolving(true)
    setSolveElapsed(0)
    if (solveTimerRef.current !== null) clearInterval(solveTimerRef.current)
    solveTimerRef.current = setInterval(() => setSolveElapsed((v) => v + 0.2), 200)
    try {
      const result = await solverRef.current?.solve(fen, { timeLimitMs, maxPlies })
      if (result === undefined) return // 页面已卸载
      const recordId = await persistRecord(fen, result)
      setSheet({ fen, result, recordId })
    } catch (e) {
      showToast(`求解失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (solveTimerRef.current !== null) clearInterval(solveTimerRef.current)
      solveTimerRef.current = null
      setSolving(false)
    }
  }

  // ---------------------------------------------------------------------------

  const boardArea = (
    <div style={{ height: 'min(52vh, 480px)', margin: '0 auto', maxWidth: 520, width: '100%' }}>
      <BoardViewStatic fen={currentFen} onCellTap={handleCellTap} />
    </div>
  )

  const setupTab = (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
        <span>行棋方:</span>
        <button
          type="button"
          className="cc-btn"
          style={{ fontWeight: redTurn ? 700 : 400 }}
          onClick={() => setRedTurn(true)}
        >
          红方
        </button>
        <button
          type="button"
          className="cc-btn"
          style={{ fontWeight: !redTurn ? 700 : 400 }}
          onClick={() => setRedTurn(false)}
        >
          黑方
        </button>
      </div>
      {(['red', 'black'] as const).map((side) => (
        <div key={side} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, width: 32 }}>{side === 'red' ? '红子' : '黑子'}</span>
          {PALETTE_KINDS.map((kind) => {
            const piece = pieceOf(kind, side)
            const selected = !eraser && selectedPiece !== null && selectedPiece.kind === kind && selectedPiece.side === side
            return (
              <button
                key={kind}
                type="button"
                className="cc-btn"
                style={{ minWidth: 36, fontWeight: selected ? 700 : 400, borderColor: selected ? 'var(--cc-seed-dark)' : undefined }}
                onClick={() => {
                  setSelectedPiece(selected ? null : piece)
                  if (!selected) setEraser(false)
                }}
              >
                {pieceLabel(piece)}
              </button>
            )
          })}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="cc-btn"
          style={{ fontWeight: eraser ? 700 : 400 }}
          onClick={() => {
            setEraser(!eraser)
            if (!eraser) setSelectedPiece(null)
          }}
        >
          橡皮
        </button>
        <button
          type="button"
          className="cc-btn"
          onClick={() => {
            setGrid(emptyGrid())
            showToast('已清空棋盘')
          }}
        >
          清空棋盘
        </button>
        <button
          type="button"
          className="cc-btn"
          onClick={() => {
            setGrid(initialGrid())
            setRedTurn(true)
          }}
        >
          初始局面
        </button>
      </div>
      <div style={{ fontSize: 12, marginTop: 6, wordBreak: 'break-all' }}>
        当前 FEN: {currentFen.split(' ')[0]}（{redTurn ? '红' : '黑'}方行棋）
      </div>
    </div>
  )

  const fenTab = (
    <div>
      <textarea
        value={fenInput}
        onChange={(e) => setFenInput(e.target.value)}
        rows={3}
        placeholder="rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w"
        style={{ width: '100%', boxSizing: 'border-box' }}
      />
      <button type="button" className="cc-btn" style={{ marginTop: 8 }} onClick={importFen}>
        解析并载入棋盘
      </button>
      <div style={{ fontSize: 12, marginTop: 8 }}>
        说明：完整 FEN 或仅棋盘字段均可；轮走方取 FEN 第二字段，缺省按当前行棋方处理。载入后可在摆盘页微调。
      </div>
    </div>
  )

  const visionTab = (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = '' // 允许重复选择同一文件
          if (file !== undefined) void readImageFile(file)
        }}
      />
      <button
        type="button"
        className="cc-btn"
        disabled={readingImage}
        onClick={() => fileInputRef.current?.click()}
      >
        {readingImage ? `识别中… 已用时 ${visionElapsed} 秒` : '选择棋盘图片并识别'}
      </button>
      {readingImage && (
        <div style={{ fontSize: 12, marginTop: 6 }}>
          一般 5~20 秒；大图或思考型模型会更久，单次超时 120 秒 × 最多 2 次
        </div>
      )}
      {visionMessage !== null && (
        <div style={{ fontSize: 12, marginTop: 8, color: 'var(--cc-seed-dark)' }} role="status">
          {visionMessage}
        </div>
      )}
      <div style={{ fontSize: 12, marginTop: 8 }}>
        识别结果会载入上方棋盘，请人工核对每个棋子后再求解（模型可能漏识别或错认棋子）。建议使用棋盘截图或正俯拍照片。
      </div>
    </div>
  )

  return (
    <div className="cc-game-page">
      <header className="cc-game-header">
        <button type="button" className="cc-btn" onClick={() => navigate('/')}>
          返回
        </button>
        <h2>残局工作室</h2>
      </header>
      <div className="cc-game-body" style={{ flexDirection: 'column', gap: 8, padding: 12 }}>
        {boardArea}
        <div style={{ display: 'flex', gap: 4 }}>
          {(
            [
              ['setup', '摆盘'],
              ['fen', 'FEN 导入'],
              ['vision', '图片识图']
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="cc-btn"
              style={{ fontWeight: tab === id ? 700 : 400, borderColor: tab === id ? 'var(--cc-seed-dark)' : undefined }}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ width: '100%', maxWidth: 640 }}>
          {tab === 'setup' && setupTab}
          {tab === 'fen' && fenTab}
          {tab === 'vision' && visionTab}
        </div>
        <div style={{ display: 'flex', gap: 12, width: '100%', maxWidth: 640, marginTop: 4 }}>
          <button type="button" className="cc-btn" style={{ flex: 1 }} onClick={() => void saveUnsolvedRecord()}>
            保存棋局
          </button>
          <button type="button" className="cc-btn" style={{ flex: 1, fontWeight: 700 }} onClick={startSolve}>
            AI 求破解
          </button>
        </div>
      </div>

      {optionsOpen && (
        <div className="cc-dialog-mask">
          <div className="cc-dialog" role="dialog" aria-modal="true" data-testid="solve-options-dialog">
            <div className="cc-dialog-title">求解设置</div>
            <div className="cc-dialog-content">
              <label style={{ display: 'block', marginBottom: 12 }}>
                限时:{' '}
                <select value={timeLimitMs} onChange={(e) => setTimeLimitMs(Number(e.target.value))}>
                  {SOLVE_TIME_OPTIONS.map((o) => (
                    <option key={o.ms} value={o.ms}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'block' }}>
                搜索深度（求解方着数）:{' '}
                <select value={maxPlies} onChange={(e) => setMaxPlies(Number(e.target.value))}>
                  {SOLVE_DEPTH_OPTIONS.map((o) => (
                    <option key={o.plies} value={o.plies}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="cc-dialog-actions">
              <button type="button" className="cc-btn" onClick={() => setOptionsOpen(false)}>
                取消
              </button>
              <button type="button" className="cc-btn" onClick={() => void confirmSolve()}>
                开始求解
              </button>
            </div>
          </div>
        </div>
      )}

      {solving && (
        <div className="cc-dialog-mask" data-testid="solve-progress">
          <div className="cc-dialog" role="alertdialog" aria-modal="true">
            <div className="cc-dialog-title">求解中…</div>
            <div className="cc-dialog-content">已用时 {solveElapsed.toFixed(1)}s</div>
          </div>
        </div>
      )}

      {sheet !== null && <SolveResultSheet sheet={sheet} redTurn={redTurn} onClose={() => setSheet(null)} />}
      {toast !== null && (
        <div className="cc-snackbar" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}

/** 结果 BottomSheet（endgame_studio_page.dart:_showSolveResult 1:1）。 */
function SolveResultSheet({
  sheet,
  redTurn,
  onClose
}: {
  sheet: SolveSheet
  redTurn: boolean
  onClose: () => void
}): React.JSX.Element {
  const { fen, result, recordId } = sheet
  const statusText =
    result.status === 'solved'
      ? result.solutions.length === 1
        ? '已破解（唯一解）'
        : `已破解（${result.solutions.length} 条破解走法）`
      : result.status === 'noSolution'
        ? `无解（${result.searchedPlies} 半着内已证明）`
        : '限时内未找到解法'

  return (
    <div className="cc-dialog-mask" data-testid="solve-result-sheet">
      <div
        className="cc-dialog"
        role="dialog"
        aria-modal="true"
        style={{ position: 'fixed', bottom: 0, left: 0, right: 0, maxWidth: 640, margin: '0 auto', maxHeight: '72vh', overflowY: 'auto' }}
      >
        <div className="cc-dialog-title">{statusText}</div>
        <div className="cc-dialog-content">
          <div style={{ fontSize: 12 }}>
            用时 {(result.elapsed / 1000).toFixed(1)}s，已保存到棋谱库{recordId === null ? '失败' : ''}
          </div>
          {result.status === 'solved' && result.solutions.length === 0 && (
            <div style={{ marginTop: 8 }}>对方已被将死/困毙，无需再走。</div>
          )}
          {result.solutions.map((solution, i) => (
            <div key={i} style={{ marginTop: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>解法 {i + 1}（{redTurn ? '红' : '黑'}方先行）:</div>
              <div style={{ lineHeight: 1.4 }}>{chineseNotations(fen, solution.moves).join('  ')}</div>
            </div>
          ))}
        </div>
        <div className="cc-dialog-actions">
          <button type="button" className="cc-btn" onClick={onClose} data-testid="solve-result-close">
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

