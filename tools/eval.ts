#!/usr/bin/env node
// 五期能力评估 CLI（05 文档 §8.2，llm_match_runner.dart 1:1 移植）。
//
// 用法（真实 LLM 对抗赛，密钥只从环境变量读取，不落仓库）：
//   LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
//   LLM_MODEL=qwen3-max \
//   LLM_API_KEY=sk-xxx \
//   npm run eval -- --games 2 --profile hybrid-candidate
//
// 或一条命令跑四档对比（基线/P0/候选/护航，每档红黑各一局对抗内置 AI 难度 3）：
//   LLM_BASE_URL=... LLM_MODEL=... npm run eval -- --suite
//
// 场景：
//   - profile vs 内置 AI（"人 vs 大模型"，引擎代打人类侧）
//   - profile vs profile（"大模型对战"，可用 --red/--black 组合）
//
// 输出 JSON 报告到 stdout 并落盘（--out，默认 tmp/eval-report-<时间戳>.json）：
// 胜负/手数/每手耗时/失误率/兜底率，可直接归档对比。
// 实现走 Node 直连 packages/*（无需窗口）；SSE 复用主进程 LlmProxy 已测路径（DR-004 精神）。
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  findBestMove,
  findBestMoveEx,
  evaluateMove,
  runMatch
} from '@packages/engine'
import type { MoveSource } from '@packages/engine'
import {
  HybridLlmPlayer,
  LlmPlayer
} from '@packages/llm'
import type { AdvisorEngine, LlmTransport } from '@packages/llm'
import { LlmProxy } from '@main/services/llm-proxy'
import type { LlmEndpointConfig } from '@shared/ipc/types'
import type { MatchReport } from '@packages/engine'

/** Dart MatchReport.toJson 的等价映射：movesIccs → moves 键。 */
export function reportToJson(r: MatchReport): Record<string, unknown> {
  const { movesIccs, ...rest } = r
  return { ...rest, moves: movesIccs }
}

// ---------------------------------------------------------------------------
// Node 侧 MoveSource 构造（渲染层 ChessAiPlayer / EngineClient 的 Node 直连版）
// ---------------------------------------------------------------------------

/** Node 直连引擎的内置 AI 棋手（镜像 ChessAiMoveSource，同步计算包成 async）。 */
export function chessAiSource(difficulty: number): MoveSource {
  return {
    displayName: `内置 AI（难度 ${difficulty}）`,
    nextMove: async (board) => {
      const move = findBestMove(board, { difficulty })
      if (move === null) return { status: 'noLegalMove' }
      return { status: 'ok', move }
    }
  }
}

/** Node 直连引擎的参谋适配器（AdvisorEngine 接口实现）。 */
export function nodeAdvisorEngine(): AdvisorEngine {
  return {
    findBestMoveEx: async (fen, options) =>
      findBestMoveEx(fen, {
        depth: options?.depth,
        topK: options?.topK,
        timeLimitMs: options?.timeLimitMs
      }),
    evaluateMove: async (fen, move, options) => evaluateMove(fen, move, { depth: options?.depth })
  }
}

/** LlmProxy 的传输适配器（主进程已测 SSE 路径；CLI 进程内直连）。 */
export function nodeTransport(llmTimeoutSeconds: number): LlmTransport {
  const proxy = new LlmProxy({ getTimeoutSeconds: () => llmTimeoutSeconds })
  return {
    chat: async (req, handlers) => {
      await proxy.chat(
        {
          requestId: req.requestId,
          url: req.url,
          headers: req.headers,
          body: req.body,
          authSlot: req.authSlot
        },
        {
          sendChunk: (_id, delta) => handlers.onChunk?.(delta),
          sendDone: (_id, text) => handlers.onDone(text),
          sendError: (_id, message) => handlers.onError(message)
        }
      )
    },
    cancel: async (requestId) => {
      proxy.cancel(requestId)
    }
  }
}

// ---------------------------------------------------------------------------
// profile 集（llm_match_runner.dart:41-59 的 1:1 移植）
// ---------------------------------------------------------------------------

export function buildProfiles(
  config: LlmEndpointConfig,
  transport: LlmTransport,
  blend: number,
  builtinAi: () => MoveSource
): Record<string, () => MoveSource> {
  return {
    'baseline-v1': () =>
      new LlmPlayer(config, transport, {
        usePromptV2: false,
        maxAttempts: 3,
        fallback: 'builtinAi',
        builtinAiSource: builtinAi
      }),
    'p0-prompt-v2': () =>
      new LlmPlayer(config, transport, {
        usePromptV2: true,
        maxAttempts: 3,
        fallback: 'builtinAi',
        builtinAiSource: builtinAi
      }),
    'hybrid-candidate': () =>
      new HybridLlmPlayer(config, transport, nodeAdvisorEngine(), {
        advisorMode: 'candidate',
        strengthBlend: blend,
        advisorDifficulty: 5,
        maxAttempts: 3,
        fallback: 'builtinAi',
        builtinAiSource: builtinAi
      }),
    'hybrid-gate': () =>
      new HybridLlmPlayer(config, transport, nodeAdvisorEngine(), {
        advisorMode: 'gate',
        strengthBlend: blend,
        advisorDifficulty: 5,
        maxAttempts: 3,
        fallback: 'builtinAi',
        builtinAiSource: builtinAi
      })
  }
}

/** profile vs 内置 AI（难度 3）：红黑换边各一局，evaluateQuality 开（Dart _matchVsEngine）。 */
export async function matchVsEngine(
  source: MoveSource,
  options: { games: number; maxPlies: number; qualityDepth: number }
): Promise<Array<Record<string, unknown>>> {
  const reports: Array<Record<string, unknown>> = []
  for (let i = 0; i < options.games; i++) {
    // 红黑换边：偶数局 LLM 执红，奇数局执黑。
    const llmIsRed = i % 2 === 0
    const report = await runMatch(
      llmIsRed ? source : chessAiSource(3),
      llmIsRed ? chessAiSource(3) : source,
      { maxPlies: options.maxPlies, evaluateQuality: true, qualityDepth: options.qualityDepth }
    )
    const json = reportToJson(report)
    json['llmSide'] = llmIsRed ? 'red' : 'black'
    reports.push(json)
  }
  return reports
}

const intArg = (args: string[], name: string, def: number): number => {
  const idx = args.indexOf(name)
  if (idx < 0 || idx + 1 >= args.length) return def
  const v = Number.parseInt(args[idx + 1]!, 10)
  return Number.isNaN(v) ? def : v
}

const stringArg = (args: string[], name: string, def: string): string => {
  const idx = args.indexOf(name)
  if (idx < 0 || idx + 1 >= args.length) return def
  return args[idx + 1]!
}

export async function main(args: string[]): Promise<void> {
  const baseUrl = process.env['LLM_BASE_URL']
  const model = process.env['LLM_MODEL']
  const apiKey = process.env['LLM_API_KEY'] ?? ''
  if (baseUrl === undefined || model === undefined || baseUrl === '' || model === '') {
    console.error('请设置环境变量 LLM_BASE_URL、LLM_MODEL（可选 LLM_API_KEY）。')
    process.exitCode = 2
    return
  }
  const config: LlmEndpointConfig = { baseUrl, model, apiKey, disableThinking: false }

  const suite = args.includes('--suite')
  const games = intArg(args, '--games', 2)
  const maxPlies = intArg(args, '--max-plies', 120)
  const blend = intArg(args, '--blend', 50)
  const llmTimeoutSeconds = intArg(args, '--llm-timeout', 60)
  const outPath = resolve(stringArg(args, '--out', `tmp/eval-report-${Date.now()}.json`))

  const transport = nodeTransport(llmTimeoutSeconds)
  const profiles = buildProfiles(config, transport, blend, () => chessAiSource(3))

  const report: Record<string, unknown> = { games, maxPlies }

  if (suite) {
    // 四档对比：每档以红/黑两视角各对抗内置 AI（难度 3）一局。
    for (const name of Object.keys(profiles)) {
      report[name] = await matchVsEngine(profiles[name]!(), { games: 2, maxPlies, qualityDepth: 4 })
    }
  } else {
    const profileName = stringArg(args, '--profile', 'hybrid-candidate')
    const build = profiles[profileName]
    if (build === undefined) {
      console.error(`未知 profile: ${profileName}（可选：${Object.keys(profiles).join(', ')}）`)
      process.exitCode = 2
      return
    }
    const redName = stringArg(args, '--red', profileName)
    const blackName = stringArg(args, '--black', 'chessai-3')
    if (redName === profileName && blackName === 'chessai-3') {
      report['match'] = await matchVsEngine(build(), { games, maxPlies, qualityDepth: 4 })
    } else {
      // 大模型对战：profile vs profile。
      const redBuild = profiles[redName]
      const blackBuild = profiles[blackName]
      if (redBuild === undefined || blackBuild === undefined) {
        console.error(`未知 profile: ${redBuild === undefined ? redName : blackName}（可选：${Object.keys(profiles).join(', ')}、chessai-3）`)
        process.exitCode = 2
        return
      }
      const reports: Array<Record<string, unknown>> = []
      for (let i = 0; i < games; i++) {
        reports.push(
          reportToJson(
            await runMatch(
              i % 2 === 0 ? redBuild() : blackBuild(),
              i % 2 === 0 ? blackBuild() : redBuild(),
              { maxPlies }
            )
          )
        )
      }
      report['match'] = reports
    }
  }

  const text = JSON.stringify(report, null, 2)
  console.log(text)
  await mkdir(resolve(outPath, '..'), { recursive: true })
  await writeFile(outPath, `${text}\n`, 'utf8')
  console.error(`报告已落盘：${outPath}`)
}
