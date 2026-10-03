# 决策记录（ChineseChessUltra Electron 重写）

## DR-001 2026-10-03 用 Electron 全栈重写 Flutter 版全部功能 [状态: 生效]
- 背景: 现有 Flutter 版五期交付完整（规则引擎/内置 AI/LLM 对战/求解器/语料库），决定以 Electron 技术栈重写全部功能，先在 WSL ubuntu2604 开发。
- 选项与权衡: Electron 重写(跨平台一致、复用现有纯 Dart 逻辑 1:1 移植为 TS、Web 生态测试/打包成熟); 继续 Flutter(桌面端窗口/托盘/系统集成弱, 已有重写诉求, 弃用)。
- 结论: Electron 全量重写，代码位于 /home/ssy/proj/chinese_chess_electron，设计文档于 design_docs/。
- 理由: 功能盘点显示核心逻辑（规则/引擎/求解/解析）均为零框架依赖纯代码，移植风险集中在 UI 与持久化两端，可控。
- 影响: 全部模块；规格见 01-需求规格说明书.md。
- 记录时间 / 会话: 2026-10-03

## DR-002 2026-10-03 渲染层采用 React 18 + TypeScript + Vite [状态: 生效]
- 背景: 渲染层框架需在 React / Vue / 原生 DOM 之间选择。
- 选项与权衡: React 18+TS+Vite(生态最成熟、组件库/虚拟列表/测试工具最全、状态映射 Zustand 对齐 Riverpod 心智); Vue 3+TS+Pinia(模板语法开发效率高但团队生态与可复用样例少, 弃用); 原生 DOM+轻量库(包体最小但棋盘动画/列表/弹窗全手写工作量过大, 弃用)。
- 结论: React 18 + TypeScript(strict) + Vite。
- 理由: 迁移工程的主要工作量在 UI 还原（08 文档 10 项防错交互），生态成熟度直接决定工期与质量。
- 影响: renderer 全部；00 文档 §1.1。
- 记录时间 / 会话: 2026-10-03

## DR-003 2026-10-03 引擎与求解器用 TypeScript 跑 Web Worker [状态: 生效]
- 背景: ChessAi（Negamax+αβ）与 AND/OR 求解器需要后台线程，语言可选 TS/Rust/WASM。
- 选项与权衡: TypeScript+Web Worker(零构建工具链、与规则层共享类型、可金标准对拍; 性能弱于原生 3~10 倍); Rust napi-rs(性能最优, 但跨平台编译工具链重、WSL 开发调试复杂, 弃用); C++→WASM(性能好且免编译分发, 但调试体验最差、与 TS 侧类型割裂, 弃用)。
- 结论: 首发纯 TS（Int8Array 棋盘 + 零分配优化），跑渲染进程 Web Worker；MoveSource/求解器接口按可替换设计，性能不达标时再引入原生实现。
- 理由: 原版 Dart 引擎同为托管语言，TS 优化后预计同数量级（验收门：难度5 ≤7.5s），先保交付面后保极限性能。
- 影响: packages/engine、packages/solver、engine.worker、solver.worker；03/04 文档。
- 记录时间 / 会话: 2026-10-03

## DR-004 2026-10-03 对外 HTTP 全部走主进程 undici 代理 [状态: 生效]
- 背景: LLM 对弈（SSE 流式）、视觉识图、语料下载均需访问外部 API；Electron 渲染进程受 Chromium CORS 约束（Flutter 无此约束）。
- 选项与权衡: 主进程 undici 代理+SSE 经 IPC 转发(规避 CORS、Key 不进渲染层、计时器单点); 渲染进程 fetch+关闭 webSecurity(实现最省, 但破坏沙箱安全模型, 弃用); 渲染进程 fetch 碰运气依赖端点 CORS 头(不可控, 弃用)。
- 结论: main 进程持 undici 流式客户端 + 空闲/总上限计时器，SSE 增量经 `cc:llm:chunk` 事件转发；渲染层 CSP connect-src 'self'。
- 理由: 与安全清单（00 §5）一致：Key 与外呼全部收敛在主进程，渲染层保持零外网能力。
- 影响: main/services/llm-proxy.ts、vision.ts、downloader.ts；05 文档 §3。
- 记录时间 / 会话: 2026-10-03
