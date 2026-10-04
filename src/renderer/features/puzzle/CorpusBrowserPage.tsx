/**
 * 语料库浏览页（对应 corpus_browser_page.dart + corpus_pgn_browser_page.dart，06 文档 §6）。
 *
 * 一级入口为分类列表；XQF 分类：搜索/仅残局/难度筛选/三种排序 + 分批解析进度；
 * PGN 大文件分类：按局索引分页浏览（每页 50）+ 单局按需解析预览。
 * 语料缺失时显示引导（期望路径 + 下载按钮约 45MB + 选择其他棋谱目录）。
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@renderer/ipc/client'
import {
  PGN_PAGE_SIZE,
  pgnPageSlice,
  useCorpusBrowser,
  visibleItems,
  type CorpusSortMode
} from '@renderer/stores/corpusBrowser'
import { difficultyText } from '@packages/parsers'
import { CORPUS_DOWNLOAD_URL } from '@shared/constants'
import type { PgnIndexEntry } from '@shared/ipc/types'

const DIFFICULTY_LABELS = ['', '入门', '初级', '中级', '高级', '职业'] as const

/** 语料缺失/为空时的下载引导（corpus_browser_page.dart 缺失分支）。 */
function MissingGuide(): React.JSX.Element {
  const { corpusPath, load } = useCorpusBrowser()
  const [picking, setPicking] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [received, setReceived] = useState(0)
  const [total, setTotal] = useState(-1)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!downloading) return
    const off = api.corpus.onProgress((e) => {
      setReceived(e.received)
      setTotal(e.total)
    })
    return off
  }, [downloading])

  const startDownload = async (): Promise<void> => {
    setMessage(null)
    setDownloading(true)
    setReceived(0)
    try {
      await api.corpus.download({ requestId: crypto.randomUUID(), url: CORPUS_DOWNLOAD_URL, targetDir: '' })
      setMessage('下载完成，正在重新扫描语料目录…')
      await load()
    } catch (e) {
      setMessage(`下载失败：${e instanceof Error ? e.message : String(e)}（可重试）`)
    } finally {
      setDownloading(false)
    }
  }

  const pickDirectory = async (): Promise<void> => {
    setPicking(true)
    try {
      const dir = await api.corpus.pickDirectory()
      if (dir !== null) await useCorpusBrowser.getState().pickCustomDirectory(dir)
    } finally {
      setPicking(false)
    }
  }

  return (
    <div className="cc-placeholder">
      <div style={{ fontSize: 18 }}>未找到本地棋谱语料</div>
      <div style={{ margin: '8px 0', color: 'var(--cc-seed-dark)' }}>期望路径：{corpusPath || '（待解析）'}</div>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
        <button type="button" className="cc-btn cc-btn-primary" disabled={downloading || picking} onClick={() => void startDownload()}>
          {downloading
            ? total > 0
              ? `下载中 ${(received / 1048576).toFixed(1)}MB`
              : '下载中…'
            : '下载语料包（约 45MB）'}
        </button>
        <button type="button" className="cc-btn" disabled={downloading || picking} onClick={() => void pickDirectory()}>
          选择其他棋谱目录
        </button>
      </div>
      {downloading && total > 0 && (
        <progress style={{ marginTop: 12, width: 320 }} value={received} max={total} />
      )}
      {message !== null && <div style={{ marginTop: 8, color: 'var(--cc-error)' }}>{message}</div>}
    </div>
  )
}

/** XQF 分类面板：筛选/排序/进度/列表（corpus_browser_vm.dart:71 的 UI 呈现）。 */
function XqfPanel(): React.JSX.Element {
  const state = useCorpusBrowser()
  const items = useMemo(
    () =>
      visibleItems({
        entries: state.entries,
        puzzles: state.puzzles,
        query: state.query,
        onlyEndgame: state.onlyEndgame,
        difficultyFilter: state.difficultyFilter,
        sortMode: state.sortMode
      }),
    [state.entries, state.puzzles, state.query, state.onlyEndgame, state.difficultyFilter, state.sortMode]
  )
  const parsedCount = state.puzzles.filter((p) => p !== null).length

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
        <input
          type="search"
          placeholder="搜索棋谱名称"
          value={state.query}
          onChange={(e) => state.setQuery(e.target.value)}
          style={{ flex: '1 1 160px' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={state.onlyEndgame}
            onChange={(e) => state.setOnlyEndgame(e.target.checked)}
          />
          仅看残局
        </label>
        <select
          value={state.difficultyFilter}
          onChange={(e) => state.setDifficultyFilter(Number(e.target.value))}
          aria-label="难度筛选"
        >
          <option value={0}>全部难度</option>
          {DIFFICULTY_LABELS.slice(1).map((label, i) => (
            <option key={label} value={i + 1}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={state.sortMode}
          onChange={(e) => state.setSortMode(e.target.value as CorpusSortMode)}
          aria-label="排序"
        >
          <option value="name">按名称</option>
          <option value="moves">按步数</option>
          <option value="difficulty">按难度</option>
        </select>
      </div>
      {state.progress >= 0 && (
        <div style={{ marginBottom: 8 }}>
          解析进度：
          <progress value={state.progress} max={1} /> 已解析 {parsedCount}/{state.entries.length}
        </div>
      )}
      <div style={{ overflowY: 'auto', maxHeight: '62vh' }}>
        {items.map(({ entry, puzzle }) => (
          <div key={entry.path} className="cc-card" style={{ padding: '8px 12px', marginBottom: 6 }}>
            <strong>{puzzle.title ?? entry.displayName}</strong>
            <div style={{ fontSize: 12, color: 'var(--cc-seed-dark)' }}>
              {entry.source} · {puzzle.moveCount} 着 · 难度 {difficultyText(puzzle.difficulty)} ·{' '}
              {puzzle.endgame ? '残局题' : '全局对局'}
            </div>
          </div>
        ))}
        {items.length === 0 && state.progress < 0 && <div>该分类暂无已解析棋谱</div>}
      </div>
    </div>
  )
}

/** 单局预览（点击分页条目后按需解析，M6 演示播放器的占位呈现）。 */
function PgnGamePreview({ path, entry }: { path: string; entry: PgnIndexEntry }): React.JSX.Element | null {
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setPreview(null)
    void (async () => {
      try {
        const text = await api.corpus.readPgnGame(path, entry)
        if (cancelled) return
        setPreview(text.split('\n').filter((l) => l.length > 0 && !l.startsWith('[')).join(' ').slice(0, 400))
      } catch {
        if (!cancelled) setPreview('（单局读取失败）')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path, entry])
  if (preview === null) return null
  return <div style={{ fontSize: 12, color: 'var(--cc-seed-dark)', marginBottom: 6 }}>{preview}…</div>
}

/** PGN 大文件分类面板：搜索 + 分页浏览（corpus_pgn_browser_page.dart:172-223）。 */
function PgnPanel(): React.JSX.Element | null {
  const state = useCorpusBrowser()
  const [openEntry, setOpenEntry] = useState<number>(-1)
  const { slice, totalPages, total } = useMemo(
    () => pgnPageSlice(state.pgnIndex, state.pgnQuery, state.pgnPage),
    [state.pgnIndex, state.pgnQuery, state.pgnPage]
  )
  if (state.pgnPath === null) return null
  const pgnPath: string = state.pgnPath
  const pageEntries = slice

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <input
          type="search"
          placeholder="按赛事/棋手搜索"
          value={state.pgnQuery}
          onChange={(e) => state.setPgnQuery(e.target.value)}
          style={{ flex: '1 1 160px' }}
        />
        <span style={{ fontSize: 12 }}>共 {total} 局</span>
      </div>
      {state.pgnLoading && <div>索引扫描中…</div>}
      <div style={{ overflowY: 'auto', maxHeight: '56vh' }}>
        {pageEntries.map((entry, i) => {
          const globalIdx = state.pgnPage * PGN_PAGE_SIZE + i
          const title = entry.event ?? `${entry.red ?? '?'} vs ${entry.black ?? '?'}`
          return (
            <div key={`${entry.offset}-${i}`}>
              {openEntry === globalIdx && <PgnGamePreview path={pgnPath} entry={entry} />}
              <button
                type="button"
                className="cc-card"
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', marginBottom: 4, cursor: 'pointer' }}
                onClick={() => setOpenEntry(openEntry === globalIdx ? -1 : globalIdx)}
              >
                <strong>{title}</strong>
                <span style={{ fontSize: 12, marginLeft: 8, color: 'var(--cc-seed-dark)' }}>
                  {entry.red ?? '?'} vs {entry.black ?? '?'}
                </span>
              </button>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button type="button" className="cc-btn" disabled={state.pgnPage === 0} onClick={() => state.setPgnPage(state.pgnPage - 1)}>
          上一页
        </button>
        <span style={{ fontSize: 12 }}>
          第 {state.pgnPage + 1} / {totalPages} 页
        </span>
        <button
          type="button"
          className="cc-btn"
          disabled={state.pgnPage >= totalPages - 1}
          onClick={() => state.setPgnPage(state.pgnPage + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  )
}

/** 语料库浏览页主组件。 */
export function CorpusBrowserPage(): React.JSX.Element {
  const navigate = useNavigate()
  const state = useCorpusBrowser()

  useEffect(() => {
    void state.load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="cc-game-page">
      <header className="cc-game-header">
        <h2>语料库浏览</h2>
        <button type="button" className="cc-btn" onClick={() => navigate('/')}>
          返回主页
        </button>
      </header>
      {!state.corpusExists ? (
        <MissingGuide />
      ) : (
        <div style={{ display: 'flex', gap: 16, padding: '0 16px' }}>
          <div style={{ width: 200, flexShrink: 0 }}>
            <div className="cc-section-title">分类</div>
            <div style={{ overflowY: 'auto', maxHeight: '62vh' }}>
              {state.categories.map((category, i) => (
                <button
                  key={category.path}
                  type="button"
                  className={i === state.selectedCategory ? 'cc-btn cc-btn-primary' : 'cc-btn'}
                  style={{ display: 'block', width: '100%', marginBottom: 6, textAlign: 'left' }}
                  onClick={() => {
                    if (category.kind === 'pgnFile') void state.openPgnCategory(i)
                    else void state.selectCategory(i)
                  }}
                >
                  {category.name}
                </button>
              ))}
            </div>
          </div>
          {state.pgnPath !== null ? <PgnPanel /> : <XqfPanel />}
        </div>
      )}
    </div>
  )
}
