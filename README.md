# ChineseChessUltra Electron

中国象棋桌面应用——Flutter 版（ChineseChessUltra，五期全部交付）的 Electron 全栈重写。

> 当前状态：**M0~M7 全部里程碑交付（v1.0 功能完备）**。全套设计文档见 [design_docs/](design_docs/)；开发过程决策见 [design_docs/decision_log.md](design_docs/decision_log.md)（DR-001~020）。

## 功能总览（对齐 Flutter 版全部功能）

- **对弈模式 ×5**：双人对弈（计时器/悔棋/保存分享）、人机对战（内置 AI 五档难度、可执黑）、人机对战（大模型）、大模型对战（红黑双 LLM 自动对局）、残局闯关（从语料进入对战）
- **规则内核**：7 棋种完整规则（马腿/象眼/炮架/将帅照面/过河兵），将死/困毙判定，中文纵线记法；**重复局面裁决**（长将判负/判和/强制和，DR-018 三层递进：搜索内检测 + 根节点历史回避 + UI 重复裁决）
- **内置 AI 引擎**：Negamax + Alpha-Beta + 迭代加深 + 静态搜索（纯 TypeScript，Web Worker），Zobrist 哈希增量局面键
- **大模型对弈**：OpenAI 兼容端点（智谱 GLM/DeepSeek/Kimi/OpenRouter…），SSE 流式 + 空闲超时，回复五层过滤白名单校验；**引擎参谋制**（候选/护航两模式 + 棋力旋钮）；API Key 仅 safeStorage 加密落盘、UI/日志全程掩码
- **残局求解**：迭代加深 AND/OR 杀棋搜索（证明式，可枚举多解/证明无解）；残局工作室（摆盘/FEN 导入/LLM 求解辅助/视觉大模型识图 + 人工校正/求解入库）
- **棋谱生态**：XQF（含解密）/PGN（含中文记谱解析）导入，14 万局级语料库浏览与下载，棋谱库（重放/导出 PGN/进入对战联动）
- **能力评估**：MatchRunner CLI（`npm run eval`）——4 profile（基线/P0 提示词/候选/护航）红黑换边对抗内置 AI，JSON 报告落盘（胜负/手数/耗时/失误率/Top-3 跟随率）
- **打包发布**：electron-builder 三平台（Linux AppImage/deb、Windows NSIS、macOS DMG），tag `v*` 触发 CI 三平台矩阵 + GitHub Release

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Electron ≥ 30 |
| 渲染层 | React 18 + TypeScript(strict) + Vite |
| 引擎/求解器 | 纯 TypeScript 跑渲染进程 Web Worker |
| HTTP | 主进程 undici 代理（LLM SSE / 识图 / 下载） |
| 存储 | better-sqlite3 + electron-store + Electron safeStorage |
| 测试 | Vitest + Playwright（E2E 直启 Electron 产物） |
| 打包 | electron-builder + @electron/rebuild |

技术选型与过程决策记录：[design_docs/decision_log.md](design_docs/decision_log.md)（DR-001~020）。

## 仓库结构

```text
chinese_chess_electron/
├── AGENTS.md            # AI 编码代理常驻指令（铁律/规范/命令）
├── design_docs/         # 设计文档集（14 份，唯一事实源）
├── build/               # electron-builder 构建资源（应用图标）
├── e2e/                 # Playwright 冒烟链路（node:test + _electron 直启产物）
├── src/                 # 代码（结构见 00 文档 §4）
│   ├── main/            # 主进程：SQLite / HTTP 代理 / 凭据 / 对话框
│   ├── renderer/        # React UI + Web Workers
│   ├── shared/          # 主/渲染共享 IPC 协议
│   └── packages/        # 纯 TS 三端共用层：rules/engine/solver/llm/parsers/storage-schema
├── test/                # Vitest 单测（规则金标准对拍/引擎对拍/LLM mock 管线/UI）
└── tools/               # eval CLI / mock LLM 服务器 / 金标准 / 测试引导
```

## 设计文档

| 序 | 文档 | 内容 |
|---|---|---|
| 00 | [总体架构与技术选型](design_docs/00-总体架构与技术选型.md) | 进程模型、IPC 协议、目录结构、WSL 工作流 |
| 01 | [需求规格说明书](design_docs/01-需求规格说明书.md) | 全部功能需求（验收标准 + 原版源码锚点） |
| 02 | [规则内核设计](design_docs/02-规则内核设计.md) | 走法生成/胜负判定/中文记法 |
| 03 | [内置AI引擎设计](design_docs/03-内置AI引擎设计.md) | 搜索算法/参谋报告/Worker 模型 |
| 04 | [残局求解器设计](design_docs/04-残局求解器设计.md) | AND/OR 搜索/多解枚举 |
| 05 | [大模型集成设计](design_docs/05-大模型集成设计.md) | 提示词协议/过滤管线/参谋制/评估运行器 |
| 06 | [语料库与棋谱解析设计](design_docs/06-语料库与棋谱解析设计.md) | XQF 解密/PGN 解析/下载安全 |
| 07 | [持久化与状态管理设计](design_docs/07-持久化与状态管理设计.md) | 数据库/自动保存/状态方案 |
| 08 | [UI与交互设计](design_docs/08-UI与交互设计.md) | 页面/动画/交互防错清单 |
| 09 | [测试方案](design_docs/09-测试方案.md) | 用例映射/金标准对拍/质量门 |
| 10 | [实施路线图](design_docs/10-实施路线图.md) | M0~M7 里程碑/风险表/DoD |
| 11 | [开发执行手册](design_docs/11-开发执行手册.md) | AI 提示词全集/40 子任务拆解 |

## 开发（WSL ubuntu2604）

```bash
# 依赖：Node 20 LTS（WSL 内），GUI 经 WSLg 显示
npm install
npm run dev        # Electron 开发模式
npm run dev:web    # 浏览器模式（mock IPC 层）
npm test           # Vitest 全量
npm run lint       # eslint + tsc --noEmit
npm run e2e        # Playwright 冒烟链路（构建产物 + Electron 直启）
npm run eval       # MatchRunner 能力评估（需 LLM_BASE_URL/LLM_MODEL 环境变量）
```

开发流程与 AI 协作方式见 [design_docs/11-开发执行手册.md](design_docs/11-开发执行手册.md)。

## 打包与发布

```bash
npm run dist       # Linux：AppImage + deb（WSL 本地）
npm run dist:win   # Windows：NSIS（建议 CI runner 执行，交叉打包见 10 文档 R1）
npm run dist:mac   # macOS：DMG x64+arm64
```

推送 `v*` tag 触发 [.github/workflows/release.yml](.github/workflows/release.yml)：三平台 runner 各跑质量门 + 打包，产物发布 GitHub Draft Release。better-sqlite3 由 postinstall `electron-rebuild` + 打包期 npmRebuild 双重保障对齐 Electron ABI。

## 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 工程骨架 | ✅ 完成（v0.1.0-m0） |
| M1 | 规则内核 | ✅ 完成（v0.2.0-m1） |
| M2 | 对战页 + 存储 | ✅ 完成（v0.3.0-m2） |
| M3 | 引擎 + Worker | ✅ 完成 |
| M4 | LLM 全链路 | ✅ 完成 |
| M5 | 语料 + 棋谱 | ✅ 完成 |
| M6 | 工作室 + 求解器 + 识图 | ✅ 完成 |
| M7 | 评估 + 打包发布 | ✅ 完成 |

> M3 起里程碑未打 tag（合并记录见 git log）；发布 v1.0 时打 tag 推送即触发三平台 Release。

## 许可

待定（原版基于 GPL-2.0/GPL-3.0 生态素材、非商业定位，重写版许可尚待决策，见 10 文档）。
