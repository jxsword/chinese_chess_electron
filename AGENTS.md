除非显式指定读取当前工作区 tmp/ 目录下的文件，否则默认不读取该目录的任何文件。

# ChineseChessUltra Electron 版 — 项目常驻指令（AGENTS.md）

> 本文件位于项目根目录，AI 编码代理每次会话自动读取。它是所有会话共享的"系统提示词"。
> 各里程碑/子任务提示词（见 design_docs/11-开发执行手册.md）在此基础上叠加，**不重复本文件内容**。

## 项目定位

将 Flutter 版中国象棋应用（源码参考：`/home/ssy/proj/ChineseChessUltra`，五期全部交付）用 Electron 全栈重写。目标平台：Windows / Linux / macOS 桌面端。**设计文档是唯一事实源**，位于 `design_docs/`。

## 技术栈（已定稿，见 design_docs/decision_log.md，不得擅自更换）

- Electron ≥ 30 + React 18 + TypeScript(strict) + Vite
- 引擎/求解器：纯 TypeScript 跑渲染进程 Web Worker（DR-003）
- 对外 HTTP：仅主进程 undici 代理（DR-004），渲染层零外网直连
- 存储：better-sqlite3（主进程）+ electron-store + Electron safeStorage
- 测试：Vitest + Playwright；UI 全中文，注释用中文（对齐原版风格）

## 架构铁律（违反即返工）

1. `src/packages/*`（rules/engine/solver/llm/parsers/storage-schema）是**纯 TypeScript**：禁止 import DOM / Node / React 任何符号——它们要同时在渲染进程、Worker、Node 测试三端运行。
2. `design_docs/05-大模型集成设计.md` §2 的提示词文本、§4 的归一化/正则/过滤管线是**调优过的协议**，必须逐字搬运，禁止意译改写、"优化"措辞。
3. 本地规则内核是着法合法性的**唯一事实源**：LLM 回复必须与本地生成的白名单精确匹配；`playMove` 始终保留最终校验。
4. 渲染层禁止 fetch 外部 URL；LLM/识图/下载一律走主进程 IPC（`cc:llm:chat` 等，通道表见 00 文档 §3）。
5. 所有异步通道带 `requestId`；新局/悔棋/离开页面必须 cancel 且丢弃迟到响应（等价原版 `_gameSeq`）；输入锁在失败/取消/dispose 时必须解锁。
6. 对局状态 store **每局一实例**（Zustand 工厂），禁止全局单例。
7. CPU 密集计算（搜索/求解/批量解析）只在 Worker；Worker 协议统一为 `{id, type, payload}` / `{id, ok, result|error|progress}`。
8. API Key 只经 safeStorage 加密落盘；日志、异常消息、UI 一律掩码（`****`+末4位）。

## 开发规范

- 每个子任务一个 commit，格式 `feat(m1): 描述` / `test(m1): 描述` / `fix(m1): 描述`；涉及技术决策的改动在提交信息末尾加 `Decision: DR-编号`，新决策先追加 `design_docs/decision_log.md`（沿用 DR-001~004 编号顺序）。
- 协议面代码（提示词/PGN 导出/JSON 报告）先写**快照测试**再实现；规则/引擎/求解器先写**金标准对拍测试**（design_docs/09 §2）再实现。
- 不引入新依赖，除非：任务提示词明确列出，或在回复中说明理由并等待确认。
- 迁移对照：任何行为不确定时，先查 01 文档的 Flutter 源码锚点（文件:行号），再读原版源码确认；**禁止凭直觉发明行为**。
- 02 文档 §6 的规则缺口（长将/重复判和/自然限着等）**本期不实现**，保持与原版一致。

## 常用命令

```bash
npm run dev        # WSLg Electron 开发模式
npm run dev:web    # 浏览器模式（mock IPC 层）
npm test           # Vitest 全量
npm run lint       # eslint + tsc --noEmit
npm run e2e        # Playwright（M7 起）
npm run eval       # MatchRunner 能力评估（M7 起）
```

> 注：本文件与 `design_docs/` 是仓库内唯一的"预先存在"内容；代码自 M0 起按里程碑落地。

## 质量门（每个任务收尾前必须全绿）

`npm run lint` 0 error + `npm test` 全量通过。UI 任务另加：dev 模式手测对应交互（对照 08 文档防错清单）。
