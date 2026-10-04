/**
 * better-sqlite3 数据访问（07 文档 §1：saved_games 自动存档 + game_records 棋谱库）。
 * 主进程专用（Node API，禁入渲染层/Worker）。
 *
 * 与原版 game_dao.dart 的差异（均有依据）：
 * - 时间戳为 epoch 毫秒 INTEGER（07 §1 DDL 定稿），而非原版 ISO 文本；
 * - 建表 DDL 的 mode 为 NOT NULL（07 §1），无模式的"裸 upsert"写入 'legacy'
 *   ——与原版 NULL 模式一样不可经任何正式模式读出，语义一致；
 * - 读侧对旧库 TEXT 时间戳做兼容解析（Flutter 版库文件可直接换名使用）。
 */
import Database from 'better-sqlite3'
import {
  decodeRecordMove,
  encodeRecordMove,
  recordMoveToRaw,
  type RawRecordMove
} from '@packages/storage-schema'
import type { Move } from '@packages/rules'
import type {
  GameRecord,
  GameRecordSummary,
  GameResult,
  RecordMove,
  SavedGame,
  SolveStatus
} from '@shared/ipc/types'

/** 07 文档 §1.1 两表 Schema（逐字段） */
const SAVED_GAMES_DDL = `
  CREATE TABLE IF NOT EXISTS saved_games (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mode            TEXT NOT NULL,
    fen             TEXT NOT NULL,
    move_stack_json TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  )
`

const GAME_RECORDS_DDL = `
  CREATE TABLE IF NOT EXISTS game_records (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    title          TEXT NOT NULL,
    mode           TEXT NOT NULL,
    initial_fen    TEXT NOT NULL,
    moves_json     TEXT NOT NULL,
    result         TEXT,
    solve_status   TEXT,
    solutions_json TEXT,
    llm_note       TEXT,
    note           TEXT,
    created_at     INTEGER NOT NULL
  )
`

/** V1 迁移（game_dao.dart:123-131）：一期建表无 mode 列 → 补列并标 'legacy'，任何模式读不到 */
function migrateV1(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(saved_games)').all() as Array<{ name: string }>
  const hasMode = cols.some((c) => c.name === 'mode')
  if (!hasMode) {
    db.exec("ALTER TABLE saved_games ADD COLUMN mode TEXT NOT NULL DEFAULT 'legacy'")
  }
}

/** 建表 + 迁移（供测试注入内存库；game_dao.dart:86-100） */
export function initSchema(db: Database.Database): void {
  db.exec(SAVED_GAMES_DDL)
  migrateV1(db)
  db.exec(GAME_RECORDS_DDL)
}

/** 旧库时间戳兼容：epoch 毫秒或 ISO 文本均可 */
function toEpochMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const parsed = Date.parse(String(v ?? ''))
  return Number.isNaN(parsed) ? 0 : parsed
}

function parseMovesJson(json: string): number[][] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (m): m is number[] => Array.isArray(m) && m.length === 4 && m.every((n) => typeof n === 'number')
      )
    }
  } catch {
    // 脏数据按空历史处理（恢复链路还有第二道跳脏闸）
  }
  return []
}

const RESULT_VALUES: readonly GameResult[] = ['redWins', 'blackWins', 'draw']

function parseResult(name: unknown): GameResult | null {
  if (typeof name !== 'string') return null
  return RESULT_VALUES.includes(name as GameResult) ? (name as GameResult) : 'draw'
}

function parseSolveStatus(name: unknown): SolveStatus | null {
  if (typeof name !== 'string') return null
  const values: readonly SolveStatus[] = ['none', 'solved', 'noSolution', 'timeout']
  return values.includes(name as SolveStatus) ? (name as SolveStatus) : 'none'
}

interface SavedGamesRow {
  id: number
  mode: string | null
  fen: string
  move_stack_json: string
  created_at: unknown
  updated_at: unknown
}

function savedGameFromRow(row: SavedGamesRow): SavedGame {
  return {
    id: row.id,
    mode: (row.mode ?? 'legacy') as SavedGame['mode'],
    fen: row.fen,
    moves: parseMovesJson(row.move_stack_json),
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at)
  }
}

interface GameRecordsRow {
  id: number
  title: string
  mode: string
  initial_fen: string
  moves_json: string
  result: unknown
  solve_status: unknown
  solutions_json: string | null
  llm_note: string | null
  note: string | null
  created_at: unknown
}

function recordFromRow(row: GameRecordsRow): GameRecord {
  let moves: RecordMove[] = []
  let solutions: string[][] | null = null
  try {
    const rawMoves: unknown = JSON.parse(row.moves_json)
    if (Array.isArray(rawMoves)) {
      moves = rawMoves
        .map((m) => decodeRecordMove(m))
        .filter((m): m is Move => m !== null)
        .map((m) => {
          const r = encodeRecordMove(m)
          // 契约面 x 允许 null；此处不可把 null 强转 ''——decodeRecordMove 会把
          // 空串视为非法 FEN 字符而丢弃整条走法（实机缺陷：棋谱变新局）。
          return { f: r.f, t: r.t, p: r.p ?? '', x: r.x }
        })
    }
  } catch {
    moves = []
  }
  if (row.solutions_json !== null) {
    try {
      const parsed: unknown = JSON.parse(row.solutions_json)
      if (Array.isArray(parsed) && parsed.every((s) => Array.isArray(s))) {
        solutions = parsed as string[][]
      }
    } catch {
      solutions = null
    }
  }
  return {
    id: row.id,
    title: row.title,
    mode: row.mode as GameRecord['mode'],
    initialFen: row.initial_fen,
    moves,
    result: parseResult(row.result),
    solveStatus: parseSolveStatus(row.solve_status),
    solutions,
    llmNote: row.llm_note,
    note: row.note,
    createdAt: toEpochMs(row.created_at)
  }
}

export class ChessDao {
  constructor(private readonly db: Database.Database) {}

  // ------------------------- saved_games（自动存档） -------------------------

  /** 裸 upsert（原版 game_dao.dart:142-163；Electron 侧固定标 'legacy'，见文件头说明） */
  upsert({ id, fen, moves }: { id?: number; fen: string; moves: number[][] }): number {
    const json = JSON.stringify(moves)
    const now = Date.now()
    if (id === undefined) {
      const info = this.db
        .prepare("INSERT INTO saved_games(mode, fen, move_stack_json, created_at, updated_at) VALUES ('legacy', ?, ?, ?, ?)")
        .run(fen, json, now, now)
      return Number(info.lastInsertRowid)
    }
    this.db
      .prepare('UPDATE saved_games SET fen = ?, move_stack_json = ?, updated_at = ? WHERE id = ?')
      .run(fen, json, now, id)
    return id
  }

  /** 最近一条（按更新时间倒序，game_dao.dart:166-175） */
  latest(): SavedGame | null {
    const row = this.db
      .prepare('SELECT id, mode, fen, move_stack_json, created_at, updated_at FROM saved_games ORDER BY updated_at DESC LIMIT 1')
      .get() as SavedGamesRow | undefined
    return row === undefined ? null : savedGameFromRow(row)
  }

  /** 按模式 upsert：每模式只保留最近一局（game_dao.dart:180-205） */
  upsertForMode({ mode, fen, moves }: { mode: string; fen: string; moves: number[][] }): number {
    const json = JSON.stringify(moves)
    const now = Date.now()
    const existing = this.db.prepare('SELECT id FROM saved_games WHERE mode = ? LIMIT 1').get(mode) as
      | { id: number }
      | undefined
    if (existing === undefined) {
      const info = this.db
        .prepare('INSERT INTO saved_games(mode, fen, move_stack_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(mode, fen, json, now, now)
      return Number(info.lastInsertRowid)
    }
    this.db
      .prepare('UPDATE saved_games SET fen = ?, move_stack_json = ?, updated_at = ? WHERE id = ?')
      .run(fen, json, now, existing.id)
    return existing.id
  }

  /** 指定模式最近一局；legacy 数据不属于任何模式（game_dao.dart:208-218） */
  latestForMode(mode: string): SavedGame | null {
    const row = this.db
      .prepare('SELECT id, mode, fen, move_stack_json, created_at, updated_at FROM saved_games WHERE mode = ? ORDER BY updated_at DESC LIMIT 1')
      .get(mode) as SavedGamesRow | undefined
    return row === undefined ? null : savedGameFromRow(row)
  }

  deleteForMode(mode: string): void {
    this.db.prepare('DELETE FROM saved_games WHERE mode = ?').run(mode)
  }

  all(): SavedGame[] {
    const rows = this.db
      .prepare('SELECT id, mode, fen, move_stack_json, created_at, updated_at FROM saved_games ORDER BY updated_at DESC')
      .all() as SavedGamesRow[]
    return rows.map(savedGameFromRow)
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM saved_games WHERE id = ?').run(id)
  }

  clear(): void {
    this.db.exec('DELETE FROM saved_games')
  }

  // ------------------------- game_records（棋谱库） -------------------------

  /** 插入棋谱，返回 id（game_dao.dart:250-274） */
  insertRecord(record: Omit<GameRecord, 'id'> & { id?: number }): number {
    const info = this.db
      .prepare(
        `INSERT INTO game_records(
          title, mode, initial_fen, moves_json, result,
          solve_status, solutions_json, llm_note, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.title,
        record.mode,
        record.initialFen,
        JSON.stringify(record.moves.map(recordMoveToRaw)),
        record.result,
        record.solveStatus,
        record.solutions === null ? null : JSON.stringify(record.solutions),
        record.llmNote,
        record.note,
        record.createdAt ?? Date.now()
      )
    return Number(info.lastInsertRowid)
  }

  /** 全部棋谱（按创建时间倒序，game_dao.dart:284-289） */
  allRecords(): GameRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM game_records ORDER BY created_at DESC, id DESC')
      .all() as GameRecordsRow[]
    return rows.map(recordFromRow)
  }

  recordById(id: number): GameRecord | null {
    const row = this.db.prepare('SELECT * FROM game_records WHERE id = ?').get(id) as
      | GameRecordsRow
      | undefined
    return row === undefined ? null : recordFromRow(row)
  }

  recordSummaries(): GameRecordSummary[] {
    return this.allRecords().map((r) => ({
      id: r.id,
      title: r.title,
      mode: r.mode,
      result: r.result,
      solveStatus: r.solveStatus,
      createdAt: r.createdAt
    }))
  }

  deleteRecord(id: number): void {
    this.db.prepare('DELETE FROM game_records WHERE id = ?').run(id)
  }

  /** 更新可变字段（标题/备注/求解结论，game_dao.dart:306-326） */
  updateRecord(record: GameRecord): void {
    this.db
      .prepare(
        `UPDATE game_records SET
          title = ?, moves_json = ?, result = ?, solve_status = ?,
          solutions_json = ?, llm_note = ?, note = ?
        WHERE id = ?`
      )
      .run(
        record.title,
        JSON.stringify(record.moves.map(recordMoveToRaw) as RawRecordMove[]),
        record.result,
        record.solveStatus,
        record.solutions === null ? null : JSON.stringify(record.solutions),
        record.llmNote,
        record.note,
        record.id
      )
  }

  close(): void {
    this.db.close()
  }
}

/** 打开并初始化数据库（07 §1：文件位于 documents/chinese_chess_electron.sqlite） */
export function openDao(dbPath: string): ChessDao {
  const db = new Database(dbPath)
  initSchema(db)
  return new ChessDao(db)
}

/** 测试辅助：内存库 */
export function openDaoInMemory(): ChessDao {
  const db = new Database(':memory:')
  initSchema(db)
  return new ChessDao(db)
}
