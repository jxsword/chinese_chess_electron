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

## DR-005 2026-10-03 cc:llm:chat 的 invoke/事件语义拆分 [状态: 生效]
- 背景: 00 §3.1 定义 `cc:llm:chat` 为 "invoke + 事件流"，但 invoke promise 与 chunk/done/error 事件的分工未在文档中显式规定；M0 T0.2 落地 WindowApi 契约时必须定死，M4 的 LlmPlayer 重试/降级逻辑依赖该语义。
- 选项与权衡:
  - A. invoke 恒 resolve(void)，一切结局走事件（chunk 增量、done 正常结束、error 失败；cancel 后无任何事件）——优点：渲染层单一代码路径、取消后无未处理 rejection、与"迟到丢弃在 store 收口"（00 §3.2）天然对齐；缺点：invoke 返回值无信息量，错误不能直接 try/catch。
  - B. invoke 承载最终结果（成功 resolve 全文、失败 reject、取消 reject 'cancelled'）并保留事件仅传增量——优点：符合 invoke 直觉、可用 try/catch；缺点：错误双重信源（error 事件 vs reject）需在 store 里去重，取消路径易产生 unhandled rejection（对齐原版 _gameSeq 丢弃语义时是负担当）。
- 结论: 方案 A（已在 T0.2 实现并由 contract 测试锁定：取消后事件严格为零）。
- 理由: 00 §3.2 把"迟到响应丢弃"定为渲染层收口，事件单信源让该收口唯一；B 的双信源在 M4 重试/降级场景是缺陷温床。
- 影响: src/shared/ipc/api.ts（JSDoc 契约）、test/ipc/contract.spec.ts、M4 LlmPlayer/HybridLlmPlayer 的取消与错误处理实现。
- 记录时间 / 会话: 2026-10-03（M0 会话）

## DR-006 2026-10-04 M2 依赖落地与 better-sqlite3 双 ABI 策略 [状态: 生效]
- 背景: M2（T2.1~T2.6）需引入设计文档已定稿的依赖（better-sqlite3/electron-store/Zustand/React Router 内存路由 + 测试用 Testing Library/jsdom，出处 00 §1.1/§4、07 §3/§6、08 §1、09 §1）。工程上出现一个 M0 未暴露的问题：better-sqlite3 原生二进制按安装时的 Node ABI 编译，而 Electron 44 主进程要求自己的 NODE_MODULE_VERSION，同一份 node_modules 无法同时服务 Vitest（系统 Node）与 npm run dev（Electron）。
- 选项:
  - A. 统一 Electron ABI + Vitest 跑在 Electron 的 Node 下（`ELECTRON_RUN_AS_NODE=1 electron vitest`）——优点：单一二进制、dev/test/pack 三态一致、无切换脚本；缺点：npm test 依赖 electron 安装、CI 三平台需各装构建链。已实测：单套件与将来的集成测试均正常运行。
  - B. 双二进制共存 + 运行时按 process.versions.electron 选择加载路径（postinstall 同时构建 node/electron 两份）——优点：Vitest 保持纯 Node；缺点：自定义 loader + postinstall 复杂度高，两份二进制易失步。
  - C. 每次切换手跑 electron-rebuild / npm rebuild——优点：零基建；缺点：重建 ~1 分钟且极易忘，属缺陷温床，弃用。
  - D. 改用 node:sqlite 或 sql.js——违反 00 §1.1 选型定稿，弃用。
- 结论: 方案 A。`npm test` 经 tools/run-vitest.mjs 以 ELECTRON_RUN_AS_NODE 拉起 vitest；postinstall 自动 `electron-rebuild -w better-sqlite3`（失败仅告警不阻断安装）。
- 理由: 主进程与测试共用同一 ABI 消除"装完能测、一跑就崩"的经典坑；B 的复杂度换不来实际收益；打包（T7.2）本就要求 electron-rebuild，与其一致。
- 影响: package.json（scripts.test/postinstall、devDependencies.@electron/rebuild）、tools/run-vitest.mjs、CI 矩阵（M7）；M2 其余实现期微决策一并记录：①credentials.enc 文件格式 = JSON `{槽位: base64(密文)}`（07 §4 未定文件内布局）；②主进程→渲染层生命周期分发用模块级回调注册表（仅持有注销函数，不持对局状态，不违铁律 #6）；③走子动画权威结束信号 = 与 CSS transition(220ms easeOutCubic) 并行的 220ms 定时器（jsdom 可测，transitionend 不可靠）；④棋谱来源（initialFen 续战）的"保存棋局"手动按钮同样受 canSave=false 约束（对齐 08 §7 防错 #6，较原版页面直写更严）；⑤数据库文件名固定 `chinese_chess_electron.sqlite`（07 §1 留白的改名决策：不做改名设置，保持实现最简）。
- 记录时间 / 会话: 2026-10-04（M2 会话）

## DR-007 2026-10-04 引擎内部棋盘表示采用 Int8Array(90)+整数打包走法 [状态: 生效]
- 背景: T3.1 落地 03 §8"Int8Array 替代 Dart 二维数组"的性能注意。需决定引擎内部是否复用 rules.Board 对象图（Piece 对象 + 二维数组）还是自建整数编码层。
- 选项:
  - A. 引擎内部自建 Int8Array(90) + 棋子整数编码（正红负黑 1..7）+ packed 整数走法（位段: 排序等级|captured|to|from）——优点: copy=零分配、apply/undo 栈式回退零对象、走法生成/排序零分配（TypedArray.sort），是拿回性能的最大单项（03 §8 明示）；缺点: 与 rules.Board 需一层对拍锁定语义等价。
  - B. 直接复用 rules.Board 跑搜索——优点: 单一事实源零对拍成本; 缺点: 每节点大量对象分配（Move/Piece/数组），JS GC 压力下深层搜索预计慢数倍，性能门（难度5 ≤7.5s）风险高。
- 结论: 方案 A。语义等价由 test/engine/engineBoard.spec.ts 对拍锁定（走法集合/apply-undo 往返/isCheck/评估逐项）。
- 理由: 03 §8 将该表示列为"TS 下拿回性能的最大单项"；实测性能门 2.3s（门 7.5s），且 isCheck 反向探测（车炮直线/马位反查/兵/照面，士象因活动范围攻击不到敌方九宫而免检）判定集与 rules 版等价。
- 影响: src/packages/engine/engineBoard.ts、search.ts；金标准对拍口径（tools/golden/engine.json）。
- 记录时间 / 会话: 2026-10-04（M3 会话）

## DR-008 2026-10-04 MVV-LVA 排序键内嵌 packed 走法高位 [状态: 生效]
- 背景: Dart 版走法排序用 (move, key) 对象数组 + List.sort（不稳定排序）；TS 需决定排序实现与同分语义。
- 选项:
  - A. 排序等级压缩映射（Dart key=victim×10−attacker 全集降序去重 → 6bit 等级）内嵌 packed 高位，TypedArray 数值升序 + 正序遍历——优点: 零比较器零分配、顺序完全确定、与 Dart 排序键数值序一致; 缺点: 需保证等级映射单调（已用例锁定）。
  - B. 平行 key 数组 + 比较器 sort——优点: 直白; 缺点: 每节点比较器调用/闭包开销，热路径劣化。
- 结论: 方案 A。附带修复: 三处递归（negamax/quiescence/evasions）曾漏排序与方向写反（倒序遍历=最差着法优先），导致深层剪枝崩坏、TS 深度6超 60s deadline 截断而与 Dart 完整层分数分歧；正序修复后 midgame d6 2.4s（Dart 25.5s 的 1/10）且金标准全绿。
- 理由: 根节点全窗口下分数是精确 minimax 值（与走法顺序无关，跨语言可复现），但搜索效率完全依赖排序质量；同分着法间顺序 Dart 不稳定排序本就不可复现，对拍以分数序列+逐着法分数为准。
- 影响: src/packages/engine/search.ts；09 §2.2 对拍断言口径说明（spec 注释）。
- 记录时间 / 会话: 2026-10-04（M3 会话）

## DR-009 2026-10-04 Worker 取消以渲染层丢弃语义收口，同步搜索不中断 [状态: 生效]
- 背景: 03 §6 要求"搜索循环每 64 节点检查取消标志"。engine.worker 内搜索是同步计算，单线程 Worker 在计算期间收不到 cancel 消息；真正中断需 SharedArrayBuffer（Electron 默认非 crossOriginIsolated，不可用）或 worker 套 worker terminate。
- 选项:
  - A. 渲染层丢弃收口：client.cancel 立即以 canceled 结算并移出 pending（迟到响应按 id 丢弃），worker 端保留"排队请求取消"防御检查 + shouldAbort 探针全链路接通（机制在，同步模型下标志在搜索期间不变），长搜索由 deadline（≤5s）兜底——优点: 与 00 §3.2 主语义（丢弃在渲染层收口，等价 _gameSeq）及原版 Isolate.run 行为（同样不可中断）一致；缺点: 已开始的搜索会跑满到 deadline。
  - B. SharedArrayBuffer + Atomics 标志——优点: 真 64 节点粒度中断; 缺点: 需 COOP/COEP 头隔离整个渲染进程，兼容性风险大。
  - C. worker 内 spawn 子 worker 搜索、cancel 时 terminate——优点: 真中断; 缺点: worker 套 worker 打包/协议透传复杂度高，M3 收益比低。
- 结论: 方案 A。09 §2.4 验收口径"取消（cancel 后响应 discarded）"由 client 侧满足；若 M4 参谋链需要真中断再评估方案 C。
- 理由: 原版 Isolate.run 同样不可中断且体验达标；05 §5 参谋报告 timeLimit ≤5s 使最坏延迟有界。
- 影响: src/renderer/workers/engineProtocol.ts、engineClient.ts、HumanVsAiPage 的 gameSeq 作废逻辑；M4 HybridLlmPlayer。
- 记录时间 / 会话: 2026-10-04（M3 会话）

## DR-010 2026-10-04 cc:llm:chat 载荷扩展可选 authSlot，真实 Key 仅主进程注入 [状态: 生效]
- 背景: 07 §4 铁律"完整 Key 不回渲染层内存"（secure.get 只回掩码 ****+末4位）与 05 §3.1"Authorization: Bearer {apiKey} 由调用方组装"在 Electron 双进程下冲突：渲染层持掩码 Key，拼不出有效鉴权头。
- 选项:
  - A. 载荷扩展可选 authSlot 字段——渲染层持完整 Key（用户刚输入未回读）时内联 Bearer 头、省略该字段；持掩码 Key（secure 回读）时带 authSlot，主进程从凭据槽位注入真实 Authorization（CredentialsService.getRaw，仅主进程内部使用）。优点: 协议最小扩展、向后兼容（可省略）、Key 不出主进程、dev:web mock 不受影响; 缺点: 00 §3.1 通道表载荷描述需加注、契约测试同步。
  - B. 渲染层永不发鉴权头，主进程一律按槽位注入——优点: 渲染层零鉴权知识; 缺点: "刚输入未保存的 Key"无法用于对局（必须先落盘再开局），且槽位与请求的绑定关系仍需载荷字段表达，扩展量相同。
  - C. secure.get 返回完整 Key 给渲染层——优点: 协议零改动; 缺点: 直接违反 07 §4 与 credentials.ts 安全语义（掩码不泄 Key），弃。
- 结论: 方案 A。LlmChatRequest 增加可选 authSlot?: SecureSlot；主进程 llm-proxy 经 resolveApiKey(slot) 注入；掩码 Key 但缺槽位时构建请求直接抛错（防裸掩码上外网）。
- 理由: 兼顾安全铁律与"保存即生效"的使用流；B 的唯一增益（渲染层零鉴权）牺牲即时可用性，而掩码检测（**** 前缀）由 buildChatRequest 统一收口，两态都有测试锁定。
- 影响: src/shared/ipc/types.ts、src/main/services/llm-proxy.ts、credentials.ts（getRaw）、packages/llm/config.ts、llmPlayer.ts、renderer/llm/llmTransport.ts；M6 cc:vision:readBoard 沿用同方案。
- 记录时间 / 会话: 2026-10-04（M4 会话）
- 追记（2026-10-04, M4 会话）: cc:llm:testConnection 载荷同样扩展可选 authSlot（{config, authSlot?}），掩码 Key 场景测试连接经主进程注入；原理与方案 A 一致。

## DR-011 2026-10-04 安全存储不可用时凭据明文回退文件（0600）+ 保存结果如实回报 [状态: 生效]
- 背景: 实机（WSLg 未运行 Secret Service）上 safeStorage.isEncryptionAvailable()=false，T2.2 的"set 抛错"语义使 LLM 配置完全无法保存（cc:secure:set 连续报"安全存储不可用"），M4 全链路在该类环境不可用；测试连接不受影响（完整 Key 内联鉴权，不落盘）。
- 选项:
  - A. 应用层明文回退文件 credentials.fallback.json（0600，仅当前用户可读），get/set/delete/getRaw 双文件贯通（加密优先），set 返回 {stored: 'encrypted'|'plainFallback'}，界面如实提示——优点: 立即可用、不降级有 keyring 的桌面端、行为诚实; 缺点: Key 落盘明文（强度等同 Chromium basic_text）。
  - B. 启动强制 --password-store=basic——优点: 一行改动走 Chromium 通路; 缺点: 全局降级（有 gnome-keyring 的桌面用户也被降为混淆明文），且 isEncryptionAvailable() 变 true 有误导性。
  - C. 要求用户安装/启动 gnome-keyring + dbus——优点: 真加密; 缺点: 环境不可控，普通用户无法完成。
  - D. 维持 set 抛错——优点: 安全语义最严; 缺点: 该类环境功能不可用，弃。
- 结论: 方案 A。回退文件原子写 + 0600；主进程首次回退打 console.warn；cc:secure:set 返回 SecureSetResult，页面「立即保存」toast 如实标注"已明文保存到本地"。
- 理由: A 与 B 的落盘强度实际相同（混淆明文），但 A 只影响回退场景且向用户明示；C/D 在目标环境不可行。真实加密路径（safeStorage 可用）行为不变，00 §3.1 的 secure 通道响应本就未锁定，扩展返回值无协议破坏。
- 影响: src/main/services/credentials.ts、shared/ipc/types.ts（SecureSetResult）、api.ts/preload/mock-api/ipc/store、两个人机 LLM 页保存反馈；07 §4 文档描述需同步（明文回退分支）。
- 记录时间 / 会话: 2026-10-04（M4 实机会话）
