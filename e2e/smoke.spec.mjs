/**
 * Playwright 冒烟链路（09 文档 §2.5 / T7.3）：
 * 启动 → 主页 7 入口可见 → 双人走一着（点击棋盘）→ 悔棋 → 新游戏 → 棋谱库打开。
 * LLM/E2E 一律 mock（不依赖外部服务）：本链路只用本地规则内核与真实主进程 IPC，
 * 不触网；产物为 `npm run build` 的 out/**（生产加载路径）。
 *
 * 运行：npm run e2e（= electron-vite build + node --test e2e/）。
 * Runner 用 node:test + playwright-core 的 _electron 启动器（直启本仓库 electron
 * 二进制与打包前产物，无需下载浏览器）。
 * 注：应用按真实行为在 ~/Documents 建库（chinese_chess_electron.sqlite）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { _electron } from 'playwright-core'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

/**
 * 棋盘网格交点 (col,row) → svg 内坐标（boardLayout.ts computeBoardLayout+offsetOf
 * 的等价复算：cell = min(w/9.6, h/10.6)，交点 = 原点 + col/row × cell）。
 * 点击 position 相对元素盒，与 handleClick 的 rect 缩放换算一致。
 */
function boardPoint(rect, col, row) {
  const cell = Math.min(rect.width / 9.6, rect.height / 10.6)
  const originX = (rect.width - 8 * cell) / 2
  const originY = (rect.height - 9 * cell) / 2
  return { x: originX + col * cell, y: originY + row * cell }
}

/** 点击棋盘交点（先取 svg 实时盒，再按比例定位） */
async function clickBoardPoint(page, col, row) {
  const rect = await page.$eval('[data-testid=board-svg]', (el) => {
    const r = el.getBoundingClientRect()
    return { width: r.width, height: r.height }
  })
  await page.click('[data-testid=board-svg]', { position: boardPoint(rect, col, row) })
}

test('冒烟链路：主页 → 双人走一着 → 悔棋 → 新游戏 → 棋谱库', { timeout: 120_000 }, async () => {
  const app = await _electron.launch({
    args: ['.'],
    cwd: root
  })
  try {
    const page = await app.firstWindow()

    // ---- ① 主页 7 入口可见 ----
    await page.waitForSelector('.cc-home-btn')
    const entries = await page.$$eval('button.cc-home-btn', (btns) =>
      btns.map((b) => b.textContent?.trim())
    )
    assert.deepEqual(entries, [
      '残局选关',
      '人机对战',
      '人机对战（大模型）',
      '大模型对战',
      '双人对弈',
      '残局工作室（摆盘/导入/求解）',
      '棋谱库'
    ])

    // ---- ② 进入双人对弈，棋盘就绪 ----
    await page.click('button.cc-home-btn:has-text("双人对弈")')
    await page.waitForSelector('[data-testid=board-svg]')
    const turnLabel = () => page.$eval('.cc-turn-label-red, .cc-turn-label-black', (el) => el.textContent?.trim())

    // 双人页会恢复上次自动保存的棋局（07 §2）；先新游戏清场，保证冒烟从初始局面开始。
    await page.click('button:has-text("新游戏")')
    await page.waitForSelector('text=开始新游戏', { timeout: 5000 })
    await page.click('button:has-text("确定")')
    await page.waitForFunction(
      () =>
        document.querySelector('.cc-turn-label-red') !== null &&
        (document.querySelector('.cc-game-info')?.textContent ?? '').includes('步数: 0'),
      undefined,
      { timeout: 5000 }
    )
    assert.equal(await turnLabel(), '红方')

    // ---- ③ 双人走一着：炮二平五（h7-e7，点击选中 + 点击目标）----
    await clickBoardPoint(page, 7, 7)
    await clickBoardPoint(page, 4, 7)
    // 220ms 走子动画结束后落子，轮黑方、步数 1。
    await page.waitForFunction(
      () =>
        document.querySelector('.cc-turn-label-black') !== null &&
        (document.querySelector('.cc-game-info')?.textContent ?? '').includes('步数: 1'),
      undefined,
      { timeout: 5000 }
    )
    assert.equal(await turnLabel(), '黑方')

    // ---- ④ 悔棋：回到初始局面，红先、步数 0 ----
    await page.click('button:has-text("悔棋")')
    await page.waitForFunction(
      () =>
        document.querySelector('.cc-turn-label-red') !== null &&
        (document.querySelector('.cc-game-info')?.textContent ?? '').includes('步数: 0'),
      undefined,
      { timeout: 5000 }
    )
    assert.equal(await turnLabel(), '红方')

    // ---- ⑤ 走回一着 → 新游戏（确认对话框）→ 清空 ----
    await clickBoardPoint(page, 7, 7)
    await clickBoardPoint(page, 4, 7)
    await page.waitForSelector('.cc-turn-label-black', { timeout: 5000 })
    await page.click('button:has-text("新游戏")')
    await page.waitForSelector('text=开始新游戏', { timeout: 5000 })
    await page.click('button:has-text("确定")')
    await page.waitForFunction(
      () => (document.querySelector('.cc-game-info')?.textContent ?? '').includes('步数: 0'),
      undefined,
      { timeout: 5000 }
    )
    assert.equal(await turnLabel(), '红方')

    // ---- ⑥ 返回主页 → 棋谱库打开 ----
    await page.click('button[aria-label="返回"]')
    await page.waitForSelector('.cc-home-btn', { timeout: 5000 })
    await page.click('button.cc-home-btn:has-text("棋谱库")')
    await page.waitForSelector('h2:has-text("棋谱库")', { timeout: 5000 })
    assert.ok(await page.$('button[aria-label="返回"]'))
  } finally {
    await app.close()
  }
})
