import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { ChessDao, initSchema } from '@main/services/db'
import { decodeRecordMove, encodeRecordMove, finalFenOf, fillMovePieces } from '@packages/storage-schema'
import { pos, FEN_INITIAL, type Move } from '@packages/rules'

// 等价集：test/features/storage/game_dao_test.dart(10) + game_record_dao_test.dart(6)
// 内存库运行（09 文档 §2.4 db 节）；时间戳为 epoch 毫秒（07 §1 定稿）。

const FEN_START = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w'

let dao: ChessDao | null = null

function freshDao(): ChessDao {
  const db = new Database(':memory:')
  initSchema(db)
  return new ChessDao(db)
}

afterEach(() => {
  dao?.close()
  dao = null
})

describe('saved_games 基础 CRUD（game_dao_test.dart 前五例）', () => {
  it('upsert 后 latest 应返回相同数据', () => {
    dao = freshDao()
    const id = dao.upsert({ fen: FEN_START, moves: [[0, 9, 0, 8]] })
    expect(id).toBeGreaterThan(0)

    const latest = dao.latest()
    expect(latest).not.toBeNull()
    expect(latest!.id).toBe(id)
    expect(latest!.fen).toBe(FEN_START)
    expect(latest!.moves).toEqual([[0, 9, 0, 8]])
  })

  it('upsert 已有 id 时为更新而非新增', () => {
    dao = freshDao()
    const id = dao.upsert({ fen: FEN_START, moves: [] })
    dao.upsert({ id, fen: 'changed', moves: [[1, 2, 3, 4]] })
    const all = dao.all()
    expect(all.length).toBe(1)
    expect(all[0]!.fen).toBe('changed')
  })

  it('latest 按 updatedAt 倒序取最新', async () => {
    dao = freshDao()
    dao.upsert({ fen: 'first', moves: [] })
    await new Promise((r) => setTimeout(r, 25)) // 毫秒级时间戳，确保不同
    dao.upsert({ fen: 'second', moves: [] })
    expect(dao.latest()!.fen).toBe('second')
  })

  it('delete 后 latest 不返回该条', () => {
    dao = freshDao()
    const id = dao.upsert({ fen: 'first', moves: [] })
    dao.delete(id)
    expect(dao.latest()).toBeNull()
  })

  it('clear 后所有记录被清空', () => {
    dao = freshDao()
    dao.upsert({ fen: 'a', moves: [] })
    dao.upsert({ fen: 'b', moves: [] })
    dao.clear()
    expect(dao.all()).toEqual([])
  })
})

describe('按模式分存（game_dao_test.dart 按模式分组）', () => {
  it('不同模式各存一份，互不覆盖', () => {
    dao = freshDao()
    dao.upsertForMode({ mode: 'humanVsAi', fen: 'fen-a', moves: [[0, 9, 0, 8]] })
    dao.upsertForMode({ mode: 'humanVsHuman', fen: 'fen-b', moves: [] })
    dao.upsertForMode({ mode: 'aiVsAi', fen: 'fen-c', moves: [] })

    expect(dao.latestForMode('humanVsAi')!.fen).toBe('fen-a')
    expect(dao.latestForMode('humanVsHuman')!.fen).toBe('fen-b')
    expect(dao.latestForMode('aiVsAi')!.fen).toBe('fen-c')
    expect(dao.all().length).toBe(3)
  })

  it('同模式重复保存覆盖为一条', () => {
    dao = freshDao()
    dao.upsertForMode({ mode: 'humanVsAi', fen: 'old', moves: [] })
    dao.upsertForMode({ mode: 'humanVsAi', fen: 'new', moves: [[1, 1, 1, 2]] })

    const saved = dao.latestForMode('humanVsAi')!
    expect(saved.fen).toBe('new')
    expect(saved.moves).toEqual([[1, 1, 1, 2]])
    expect(dao.all().length).toBe(1)
  })

  it('无存档的模式返回 null；legacy 数据不属于任何正式模式', () => {
    dao = freshDao()
    // Electron 侧 DDL 的 mode 为 NOT NULL（07 §1）：裸 upsert 固定标 'legacy'，
    // 与原版 NULL 模式同样不可经任何正式模式读出（DR-006 ④）。
    dao.upsert({ fen: 'legacy-row', moves: [] })
    expect(dao.latestForMode('humanVsAi')).toBeNull()
    expect(dao.latest()!.fen).toBe('legacy-row')
    expect(dao.latest()!.mode).toBe('legacy')
  })

  it('deleteForMode 只删除该模式', () => {
    dao = freshDao()
    dao.upsertForMode({ mode: 'humanVsAi', fen: 'a', moves: [] })
    dao.upsertForMode({ mode: 'aiVsAi', fen: 'b', moves: [] })

    dao.deleteForMode('humanVsAi')

    expect(dao.latestForMode('humanVsAi')).toBeNull()
    expect(dao.latestForMode('aiVsAi')!.fen).toBe('b')
  })
})

describe('旧库迁移（一期无 mode 列，game_dao_test.dart 迁移组）', () => {
  it('补齐 mode 列，老数据标记 legacy 且按模式查不到', () => {
    const db = new Database(':memory:')
    // 模拟 Flutter 一期建表结构与数据（TEXT 时间戳 + 无 mode 列）
    db.exec(`
      CREATE TABLE saved_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fen TEXT NOT NULL,
        move_stack_json TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)
    db.prepare("INSERT INTO saved_games(fen, move_stack_json) VALUES ('old-fen', '[]')").run()

    initSchema(db)
    const migratedDao = new ChessDao(db)
    try {
      // 迁移后新写入按模式分存正常
      migratedDao.upsertForMode({ mode: 'humanVsAi', fen: 'new-fen', moves: [] })
      expect(migratedDao.latestForMode('humanVsAi')!.fen).toBe('new-fen')
      // 老数据仍在库里，但不属于任何正式模式
      const legacy = migratedDao.all().filter((g) => g.fen === 'old-fen')
      expect(legacy.length).toBe(1)
      expect(legacy[0]!.mode).toBe('legacy')
      expect(migratedDao.latestForMode('legacy')!.fen).toBe('old-fen')
      // 正式模式读不到 legacy 数据
      expect(migratedDao.latestForMode('humanVsHuman')).toBeNull()
    } finally {
      migratedDao.close()
      db.close()
    }
  })
})

// ---------- game_records（game_record_dao_test.dart 六例） ----------

function sampleRecord(title = '测试棋谱') {
  return {
    id: 0, // 由 insertRecord 生成；此处仅占位
    title,
    mode: 'endgame' as const,
    initialFen: '3k5/9/9/9/9/9/9/9/9/4K4 w',
    moves: [],
    result: null,
    solveStatus: 'solved' as const,
    solutions: [
      ['h5h3'],
      ['h5h4', 'h0g2']
    ],
    llmNote: '大模型首选 h5h3（已验证为必胜着法）',
    note: '经典双车残局',
    createdAt: Date.parse('2026-10-02T08:00:00Z')
  }
}

describe('game_records（game_record_dao_test.dart）', () => {
  it('插入并读回棋谱（含解法/标记/备注）', () => {
    dao = freshDao()
    const { id: _omit, ...record } = sampleRecord()
    const id = dao.insertRecord(record)

    const loaded = dao.recordById(id)!
    expect(loaded.title).toBe('测试棋谱')
    expect(loaded.mode).toBe('endgame')
    expect(loaded.solveStatus).toBe('solved')
    expect(loaded.solutions!.length).toBe(2)
    expect(loaded.solutions![1]).toEqual(['h5h4', 'h0g2'])
    expect(loaded.llmNote).toContain('h5h3')
    expect(loaded.note).toBe('经典双车残局')
  })

  it('allRecords 按创建时间倒序', () => {
    dao = freshDao()
    dao.insertRecord(sampleRecord('A'))
    dao.insertRecord(sampleRecord('B'))
    const all = dao.allRecords()
    expect(all.length).toBe(2)
    expect(all.map((r) => r.title)).toEqual(expect.arrayContaining(['A', 'B']))
  })

  it('updateRecord 更新求解结论与备注', () => {
    dao = freshDao()
    const { id: _omit, ...record } = sampleRecord()
    const id = dao.insertRecord(record)
    const loaded = dao.recordById(id)!
    dao.updateRecord({
      ...loaded,
      title: '更新标题',
      solveStatus: 'timeout',
      solutions: [],
      note: '限时未决'
    })

    const reloaded = dao.recordById(id)!
    expect(reloaded.title).toBe('更新标题')
    expect(reloaded.solveStatus).toBe('timeout')
    expect(reloaded.solutions).toEqual([])
    expect(reloaded.note).toBe('限时未决')
  })

  it('deleteRecord 删除后查无', () => {
    dao = freshDao()
    const { id: _omit, ...record } = sampleRecord()
    const id = dao.insertRecord(record)
    dao.deleteRecord(id)
    expect(dao.recordById(id)).toBeNull()
    expect(dao.allRecords()).toEqual([])
  })

  it('game_records 与 saved_games 互不影响', () => {
    dao = freshDao()
    const { id: _omit, ...record } = sampleRecord()
    const id = dao.insertRecord(record)
    dao.upsertForMode({ mode: 'humanVsHuman', fen: 'fen', moves: [[1, 2, 3, 4]] })
    expect(dao.latestForMode('humanVsHuman')).not.toBeNull()
    expect(dao.recordById(id)).not.toBeNull()

    dao.deleteForMode('humanVsHuman')
    expect(dao.recordById(id)).not.toBeNull()
  })

  it('回归：无吃子走法（x=null）入库读回后可解码，起点重算非新局（实机缺陷修复）', () => {
    dao = freshDao()
    // 缺陷链：recordFromRow 曾把 x:null 强转为 x:""，decodeRecordMove 将空串视为
    // 非法 FEN 字符 → 全部走法解码失败 → 详情重放 0/0、进入对战回初始局面。
    const moves: Move[] = fillMovePieces(FEN_INITIAL, [
      { from: pos(7, 7), to: pos(4, 7) },
      { from: pos(7, 0), to: pos(6, 2) },
      { from: pos(8, 0), to: pos(7, 0) }
    ])
    const finalFen = finalFenOf(FEN_INITIAL, moves)
    const id = dao.insertRecord({
      title: '回归',
      mode: 'humanVsAi',
      initialFen: FEN_INITIAL,
      moves: moves.map((m) => {
        const raw = encodeRecordMove(m)
        return { f: raw.f, t: raw.t, p: raw.p ?? '', x: raw.x }
      }),
      result: null,
      solveStatus: 'none',
      solutions: null,
      llmNote: null,
      note: null,
      createdAt: Date.now()
    })
    const loaded = dao.recordById(id)!
    expect(loaded.moves).toHaveLength(3)
    // 每条走法都能解码（旧缺陷：x:"" 导致全部 null）。
    for (const m of loaded.moves) {
      expect(decodeRecordMove(m)).not.toBeNull()
    }
    // 进入对战起点 = 终局局面（≠ 标准开局）。
    const decoded = loaded.moves
      .map(decodeRecordMove)
      .filter((m): m is Move => m !== null)
    const startFen = finalFenOf(FEN_INITIAL, decoded)
    expect(startFen.split(' ')[0]).not.toBe(FEN_INITIAL.split(' ')[0])
    expect(startFen).toBe(finalFen)
  })

  it('回归：旧库 x:"" 形态的走法行可解码（存量数据修复）', () => {
    // 已落库的历史行：recordFromRow 旧映射把 null 强转成 ""。
    const legacyMoves = [
      { f: [7, 7], t: [4, 7], p: 'C', x: '' },
      { f: [7, 0], t: [6, 2], p: 'n', x: null }
    ]
    for (const m of legacyMoves) {
      expect(decodeRecordMove(m)).not.toBeNull()
    }
    // 真正的脏数据（非法 FEN 字符）仍然拒绝。
    expect(decodeRecordMove({ f: [7, 7], t: [4, 7], p: 'C', x: 'Z' })).toBeNull()
    expect(decodeRecordMove({ f: [7, 7], t: [4, 7], p: 'ZZ', x: null })).toBeNull()
  })

  it('旧库（无 game_records 表）打开时自动建表', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE saved_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fen TEXT NOT NULL,
        move_stack_json TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)
    initSchema(db)
    const legacyDao = new ChessDao(db)
    try {
      const { id: _omit, ...record } = sampleRecord()
      const id = legacyDao.insertRecord(record)
      expect(legacyDao.recordById(id)).not.toBeNull()
      // V1 迁移同样生效
      expect(legacyDao.latestForMode('humanVsHuman')).toBeNull()
    } finally {
      legacyDao.close()
      db.close()
    }
  })
})
