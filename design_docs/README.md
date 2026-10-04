# ChineseChessUltra Electron 版 — 设计文档集

> 基于 Flutter 版（`/home/ssy/proj/ChineseChessUltra`，WSL，五期全部交付）的完整重写设计。
> 目标代码位置：`/home/ssy/proj/chinese_chess_electron`（WSL ubuntu2604 开发）。

## 文档索引与阅读顺序

| 序 | 文档 | 内容 | 图数 |
|---|---|---|---|
| 00 | [总体架构与技术选型](00-总体架构与技术选型.md) | 选型矩阵、进程模型、IPC 协议、目录结构、WSL 工作流、安全清单 | 3 |
| 01 | [需求规格说明书](01-需求规格说明书.md) | E-F01~F42 全部功能需求（验收标准 + Flutter 源码锚点）+ 非功能需求 | 0 |
| 02 | [规则内核设计](02-规则内核设计.md) | 走法生成/合法性/胜负/中文记法 + 规则缺口决策项 | 5 |
| 03 | [内置AI引擎设计](03-内置AI引擎设计.md) | Negamax+αβ+迭代加深+静态搜索、参谋报告、Worker 模型 | 5 |
| 04 | [残局求解器设计](04-残局求解器设计.md) | AND/OR 迭代加深、多解枚举、验证接口、状态机 | 5 |
| 05 | [大模型集成设计](05-大模型集成设计.md) | Prompt v1/v2 原文、HTTP/SSE、五层过滤、参谋制、LLM vs LLM、求解辅助、识图 | 6 |
| 06 | [语料库与棋谱解析设计](06-语料库与棋谱解析设计.md) | XQF 解密、PGN 中文消解、流式索引、下载安全 | 5 |
| 07 | [持久化与状态管理设计](07-持久化与状态管理设计.md) | SQLite 双表 Schema、自动保存状态机、三层存储、Zustand 方案 | 2 |
| 08 | [UI与交互设计](08-UI与交互设计.md) | 导航、棋盘动画时序、各页面交互、防错清单 | 4 |
| 09 | [测试方案](09-测试方案.md) | 289 用例映射、金标准对拍、mock SSE、E2E、质量门 | 1 |
| 10 | [实施路线图](10-实施路线图.md) | M0~M7 里程碑、风险表、验收基线 | 1 |
| 附 | [重复变招优化设计（final）](built-in-ai-move-repetition-optimization-design-final.md) | Zobrist/L1 搜索内检测/L2 历史回避/L3 规则裁决（DR-018/019，T3.5~T3.10） | 5 |
| — | [decision_log.md](decision_log.md) | DR-001~004 决策记录 | — |

**合计 37 张 mermaid 图（约 2100 行）。**

## 角色化阅读路径

- **架构师**：00 → 10 → 01
- **规则/引擎实现者**：02 → 03 → 04 → 09（金标准对拍）
- **LLM 集成实现者**：05 → 03（参谋报告接口）→ 00 §3（IPC）→ 09 §2.3
- **前端实现者**：08 → 07 → 00 §4（目录）
- **测试/CI**：09 → 10 §3

## 术语表

| 术语 | 含义 |
|---|---|
| 厘兵（cp） | 引擎评分单位，100 厘兵 ≈ 一个兵的价值 |
| 内部坐标 | col 0-8、row 0-9；**row 0 = 黑方底线（顶部）**，row 9 = 红方底线 |
| ICCS | 棋谱交换坐标：列 a-i（红方视角左→右）、行 0-9（**0 为红底线**），与内部坐标 row 镜像（row=9−rank） |
| LLM 坐标 | 走子源协议坐标：列 a-i、行 0-9（0 为黑底线）——与内部坐标同构，与 ICCS 不同 |
| 参谋制 | 引擎为大模型提供候选名单（candidate）或否决权（gate）的混合决策架构 |
| strengthBlend | 棋力旋钮 0~100：候选模式控制名单宽度 K=3+blend/20；护航模式控制否决阈值 80+3.2×blend 厘兵 |
| 五层过滤 | LLM 回复处理管线：流重组→文本提取→归一化→坐标提取→白名单校验 |
| MoveSource | "棋手"抽象接口：内置引擎与 LLM 的可互换实现，返回必须为合法着法 |
| requestId | Electron 版取消机制，等价 Flutter `_gameSeq` 代数作废 |
| FEN | 局面串行化格式：10 行 `/` 分隔（黑底线在前）+ `w/b` 轮走方 |

## 与 Flutter 版模块映射总表

| Flutter | Electron |
|---|---|
| lib/features/board/model/* | packages/rules |
| lib/features/shared/engine/ai_engine.dart | packages/engine + engine.worker |
| lib/features/solver/endgame_solver.dart | packages/solver + solver.worker |
| lib/features/shared/engine/{llm_move_source,hybrid_llm_move_source}.dart | packages/llm + 主进程 llm-proxy |
| lib/features/puzzle/* | packages/parsers + parser.worker + features/puzzle |
| lib/features/record/* | features/record + cc:db:records IPC |
| lib/features/storage/* | main/services/db.ts + electron-store + safeStorage |
| lib/features/board/view/*、lib/app/app.dart | renderer/features/* + React Router |

> 完整映射与不迁移清单见 00 文档；需求追溯锚点见 01 文档。
