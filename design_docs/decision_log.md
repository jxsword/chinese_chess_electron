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

## DR-012 2026-10-04 大模型对战空配置一侧运行时跟随对方（不落盘） [状态: 生效]
- 背景: 用户需求"双方可以用同一个大模型对战——当一方所有参数为空时，使用另一方的大模型配置"。三槽位凭据存储下需要决定"跟随"的落点。
- 选项:
  - A. 运行时解析（已采纳）：开始校验与每手棋构造棋手时按 resolveLlmSideConfig 取生效配置（自身 baseUrl/apiKey/model 全空 → 用对方配置与对方槽位）；配置卡下方显示"未配置——对局时将使用X方的模型配置"提示。优点: 空侧动态跟随，对方改动即时生效；不写空槽位，语义清晰（"空=跟随"可随时反向修改）；掩码 Key 的 authSlot 随生效配置来源槽位（与 DR-010 闭环）。缺点: 每手解析一次（微不足道）。
  - B. 保存时把对方配置复制进空槽位: 两槽从此独立，后续改动不同步，"跟随"关系丢失；用户想解除跟随需手动清空。弃。
  - C. 配置卡加"跟随对方"显式开关: 语义最明确，但增加 UI 复杂度，超出需求（"全空=跟随"规则本身已足够直观）。弃。
- 边界: 仅"三字段全空（含纯空白）"触发镜像；填了部分字段（如只填 Key）是独立无效配置，仍由开始校验拦截并提示；双方全空 → 相互镜像后仍空，照旧拦截。附带修复: HumanVsLlmPage/LlmVsLlmPage 构造 HybridLlmPlayer 时漏传 authSlot（DR-010 闭环缺口）——重启后掩码 Key 回读场景对局请求会全部失败，此前被"手输 Key 未重启"掩盖。
- 影响: packages/llm/config.ts（isEmptyLlmConfig/resolveLlmSideConfig）、LlmVsLlmPage（start/runLoop/提示）、HumanVsLlmPage（authSlot）；测试 config.spec 4 例 + llmVsLlm.spec 07。
- 记录时间 / 会话: 2026-10-04（M4 增量会话）

## DR-013 2026-10-04 凭据掩码 Key 回写合并 + 思考过程透明化 [状态: 生效]
- 背景: 实机反馈两个问题。① 重启后已存 Key 失效——渲染层回读的是掩码 Key（****+末4位），页面防抖保存/卸载回写把整个配置原样写回，掩码字符串覆盖了真实 Key（DR-011/012 之前未暴露，因用户手输 Key 未重启）；② 思考型模型（qwen3.8-max 未勾选"禁用思维链"）每手棋思维链 60s+，单次调用总上限=空闲×4=240s、×3 次重试后才降级，状态栏只有"思考中…"，观感"卡住不动"。
- 选项（掩码回写）:
  - A. 主进程 set 合并（已采纳）：apiKey 呈掩码形态时沿用存储中的原 Key，仅更新其余字段；无原 Key 可恢复按空 Key 处理。优点: 渲染层零改动、语义"掩码=未修改"符合凭据管理惯例; 缺点: 用户真实 Key 以 **** 开头的极端情形会被误判（实际不存在）。
  - B. 渲染层跟踪"Key 未修改"标记、跳过 Key 字段回写: 需要跨渲染层传递修改状态，页面增多后易漏。弃。
- 附加（透明化，不改协议）:
  - testConnection 事件回调参数遮蔽修复（sendError 首参 requestId 被当作错误消息显示）+ 构建期错误（端点未配置）直接包装为失败消息；
  - LlmPlayer/HybridLlmPlayer 增加 onAttempt(attempt,total) 进度回调，两页状态栏显示"第 N/M 次尝试 · 已等待 N 秒"——不改变 05 §3.2 超时协议与重试语义，仅消除"卡住"观感。
- 结论: 方案 A + 透明化附加项。思考型模型的使用建议（勾选"禁用思维链"，或空闲超时 30s + 重试 1 次加速降级）写入用户文档，不改默认协议数值。
- 影响: src/main/services/credentials.ts、llm-proxy.ts（testConnection）、packages/llm（onAttempt）、两页状态栏（useThinkingStatus）；测试 credentials 2 例、llmProxy 2 例、moveSource 1 例、格式化 2 例。
- 记录时间 / 会话: 2026-10-04（M4 实机回归会话）

## DR-014 2026-10-04 黑方配置跨页镜像红方 + 对局引擎类型直接可选 [状态: 生效]
- 背景: 用户需求两条。① "黑方大模型的配置可以共享，若未配置，使用红方的"——两页黑方本就共享 llm_config_black 槽位，缺的是"黑方为空时回退红方"的跨页镜像（DR-012 只有大模型对战页的页内镜像）；② "两个对战模式应支持直接选择：内置AI / 大模型"——目前内置 AI 只是 LLM 失败后的兜底，无法直接选择。
- 需求分析与优先级: R1 跨页镜像（P1，复用 DR-012 机制，改动小）；R2a 大模型对战页红/黑各自可选引擎类型（P2，支持 内置vs大模型/内置vs内置 全组合）；R2b 人机（大模型）页对手可选引擎类型（P3，同一机制）。
- 选项（引擎类型持久化）:
  - A. llm_settings_* 新增三键（redSideType/blackSideType/humanVsLlmOpponentType，枚举 index 存档，缺省 llm）——优点: 与现有设置体系一致、跨会话记忆、兼容旧行为（缺省=大模型）; 缺点: settings schema 扩展（fromRaw/toMap/keyOf 同步）。
  - B. 每局运行时选择不持久化——缺点: 每次进页都要重选，反用户预期。弃。
- 语义与边界:
  - 引擎类型为 builtin 的一侧不参与 LLM 配置校验与镜像，直接 ChessAiPlayer(3) 应手；
  - 黑方槽位为空（三字段全空）时跨页镜像红方配置（人机页与大模型对战页共享 llm_config_red）；镜像为只读视图——人机页镜像态不回写黑槽、"立即保存"提示去红方槽位修改，防一手编辑两处存储；
  - 测试连接在镜像态测真正生效的配置（testOverride 走红方槽位注入）；
  - 大模型对战页 start 未加载完成时开始按钮禁用（修复"点击无反应"）。
- 影响: packages/llm/settings.ts（SideEngineType 三键）、LlmVsLlmPage（类型下拉+统一 runLoop 按侧构造 MoveSource）、HumanVsLlmPage（对手类型+镜像加载/持久化门控）、LlmConfigCard（testOverride）；测试 settings 1 例、humanVsLlm 2 例、llmVsLlm 文案断言修正。
- 记录时间 / 会话: 2026-10-04（M4 增量会话）

## DR-015 2026-10-04 XQF 解密链的验证策略：真实样例锚点 + 测试侧往返构造器 [状态: 生效]
- 背景: T5.2 的解密算法（formula 链乘/FKeyBytes/版本≥12 布局置换/GB18030）必须逐字节与原版 xqf_parser.dart 一致，但 45MB 语料包在本会话环境不可下载，原版 7 条语料对拍用例（corpus 联接）无法直接移植。需要决定等价验证手段。
- 选项:
  - A. 真实样例锚点 + 测试侧往返构造器（已采纳）：① 仓库自带 assets/puzzles/sample_xqf.xqf（真实 v0x0D 文件，覆盖加密+置换+GB18030 全链路）复制进 test/fixtures，断言 FEN/77 着全量重放合法/中文元数据；② 测试侧实现 xqfBuilder（解析器逆变换），对 v0x0A/v0x0C/v0x12 三版本 + 让子盘面 + 黑先行做"构造→解析"往返。优点: 不依赖外部语料、CI 可重复、往返能暴露任何单向笔误。缺点: 往返两侧共享同一理解、无法发现"双方一致但与真格式不符"的系统性错误（由真实样例锚点补位）。代价: builder 约 150 行测试代码。
  - B. 手工构造二进制 hex 夹具: 每版本手拼字节。优点: 与实现完全独立。缺点: 手工易错、覆盖率低、维护成本高。弃。
  - C. 临时跑 Python/JS 独立三方实现对拍: 项目内无第三方 XQF 实现（walker8088/cchess 是 Python 且未装）。弃（环境不可行）。
- 结论: 方案 A。实现期发现并修正一处真实偏差：初版 TS 解析器把"布局置换"应用到了所有加密版本（Dart 原版仅版本≥12 置换，v0x0B/C 仅减 keyXY）——往返用例对 v0x0C 的强断言（置换与不置换必须产生不同字节序）在该偏差下仍会假绿，最终靠"样例锚点 v0x0D + 按版本分治的往返断言"共同锁定。
- 影响: src/packages/parsers/xqfParser.ts、test/helpers/xqfBuilder.ts、test/fixtures/sample_xqf.xqf、test/parsers/xqfParser.spec.ts（9 条）；iconv-lite 依赖由任务提示词明确授权（GB18030 解码，packages 纯 TS 三端可用——decode 直接收 Uint8Array，不经 Buffer）。
- 记录时间 / 会话: 2026-10-04（M5 T5.1-T5.3 会话）

## DR-016 2026-10-05 语料文件的进程分工与 zip 解压零依赖方案 [状态: 生效]
- 背景: T5.4/5.5 落地时,原版 CorpusRepository（Dart isolate 有 fs 权限,读+解析同处一线程）在 Electron 沙箱下不可直接映射:渲染层 Worker 无 fs,主进程有 fs 但不该做批量 CPU。zip 解压还需决定依赖方案（Dart 用 package:archive）。
- 选项（进程分工）:
  - A. fs 全收敛主进程 + 字节过 IPC + CPU 在渲染层 Worker（已采纳）：cc:corpus:readFiles 批量读 128 个 .xqf 字节 → parser.worker 解析（06 §6 分批图 1:1）；大 PGN 流式索引（scanGameOffsets）留在主进程（读即扫,1MB 块 + 8MB 单行上限,内存有界）。优点: 与 06 §6 时序图一致、铁律 #7 兼顾（Worker 管批量解析,主进程只做 IO 型扫描）。缺点: 字节结构化克隆一次拷贝（每批 ≤2MB,可忽略）。
  - B. 主进程 utilityProcess 做全部解析: 优点: 单进程内闭环。缺点: 新增一类进程形态、协议面膨胀,与 00 §3.2 Worker 协议冲突。弃。
  - C. 渲染层直接持有字节列表一次读入: 违背 06 §4.4"不整读内存"。弃。
- 选项（zip 依赖）:
  - A. 内置 zlib + 手写最小中央目录解析器（已采纳）：只支持 store/deflate + 符号链接 mode 识别（zip64/加密条目显式抛错）。优点: 零新依赖（AGENTS 纪律）、zip-slip 防护与遍历同层可控; 缺点: ~200 行自维护代码（测试侧自带构造器往返覆盖）。
  - B. adm-zip / fflate 等库: 优点: 省代码。缺点: 新依赖未经任务提示词列出,且 adm-zip 历史 zip-slip CVE 需要额外审计。弃。
- 结论: 进程分工取 A、zip 取 A。附带约束: cc:corpus:readFiles 仅放行 .xqf/.pgn/.pgns 扩展名（渲染层路径不可信的最低防线）。
- 影响: src/main/services/corpus.ts、corpusDownloader.ts、corpusZip.ts、src/renderer/workers/parser.worker.ts/parserProtocol.ts/parserClient.ts、src/renderer/stores/corpusBrowser.ts、features/puzzle/CorpusBrowserPage.tsx、cc:corpus 四通道（00 §3.1 已同步）。
- 记录时间 / 会话: 2026-10-05（M5 T5.4/5.5 会话）
