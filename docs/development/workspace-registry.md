# 工作区注册表与「能全看、不默认全看」的加载策略（spec，未实施）

> 状态：**只有 spec 与证据，未改任何产品代码**。目标读者：手机批次（M1/M2）的实施者与产品决策者。
> 相关证据：`.reverse/40-remote-control/MOBILE-ACCESS-AUDIT.md`（可见集合的定位）、`PUBLISHER-SCALE-MEASUREMENT.md`（task-23 实测数字）、`WEB-REMOTE-CONTROL-M1.md`（断线自愈与版本配套）、`docs/development/web-remote-control.md`（网页远控 M1 的既有 spec）。

## 0. 读了什么，结论与它们一致还是不一致

读了：`packages/services/src/session/taskIndexRepo.ts`（`queryGroupedTaskView` / `queryGroupedTaskViewStructure`）、`packages/services/src/zcode-agent/zcodeAgent.ts` 与 `zcodeAgentService.ts`（`subscribeSessionsIndexV4` 与 `runtimePolicy`）、`packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/{v4-gateway,sessions-index-publisher,sessions-index-publisher-registry}.ts` 与 `zcode-protocol/{server-operations,v4-bridge}.ts`、`packages/ui/src/hooks/{useGroupedTaskView,useWorkspaceTaskLists}.ts`、`packages/ui/src/WorkspaceSidebarItem.tsx`、`packages/web/src/main.tsx`、`packages/server/src/http.ts`、`AGENTS.md`（进程/协议/远程控制 + Workspace Identity）、`NOTICE.md:37,43`。三份既有报告（见上）与本文一致；**不一致处**见 §1 引用的实测：既有文档从未写明「可见工作区集合由客户端设置决定」，这正是本轮要改成服务端持有的原因。

## 1. 问题定义（实测）

| 事实                           | 数字                                                                                                             | 证据                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 手机侧栏显示的 workspace       | **22**（= 设置里 22 条 `workspacePurpose: project`）                                                             | DOM 计数 22 组 / 23 行；设置文件 `~/.zcode/v2/setting.json` 的 `lastWorkspaceSession` 23 条（22 project + 1 conversation）                      |
| 服务端任务索引库里的 workspace | **52**（其中 28 个有未归档任务行）                                                                               | `~/.zcode/v2/tasks-index.sqlite`：`tasks` 117 行 / distinct `workspace_path` 52 / 未归档行落在 28 个                                            |
| 会话库里的 workspace           | **53** 个目录、119 条任务列表可见会话                                                                            | `~/.zcode/cli/db/db.sqlite`（`task_type in (interactive, fork, workflow_parent)`）                                                              |
| 可见集合由谁决定               | **客户端**：侧栏列表来自传入的 workspace tabs；服务端只在被请求的 workspace 上懒建 publisher                     | `useGroupedTaskView.ts:586,620-625,757`；`v4-gateway.ts:1148-1169`（从 client 的 topic 里 `parseSessionsIndexTopic` 再 `ensureIndexPublisher`） |
| 全量枚举能力                   | **今天不存在**：`includeAllWorkspaces` 全仓零调用方；侧栏走的 `queryGroupedTaskViewStructure` 签名里没有这个参数 | `zcodeTaskListTypes.ts:77`；`taskIndexRepo.ts:2075-2152` 与 `:2264-2266`                                                                        |

⇒ 「会话看起来丢了」与「多客户端不一致」是同一个根因：**可见范围由每个客户端自己的设置决定**，而服务端的真实数据范围更大且对所有客户端相同。

## 2. 唯一真相源：**服务端持有工作区注册表**（客户端设置降级为显示偏好）

### 2.1 所有者与读写面

| 项                                                          | 决定                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **所有者**                                                  | 服务端（服务进程内的 workspace registry；持久化到服务端数据目录，与任务索引库同域）                                                                                                                                                                                                 |
| **枚举来源（两源合并）**                                    | ① 任务索引库的 distinct `workspace_path` + `workspace_identity`（含无未归档行的 workspace）；② 会话库会话的可列举目录（`session.directory`，任务列表可见类型）。合并键 = `workspaceIdentity?.trim() \|\| workspacePath`（与本仓库既有身份口径一致，`AGENTS.md` Workspace Identity） |
| **写入方**                                                  | 服务端自己：新会话/新任务落库时 upsert 一行（记录 `workspacePath`、`workspaceIdentity?`、`firstSeenAt`、`lastActivityAt`、`sources`），并提供一次性回填（迁移）从两源枚举现有数据                                                                                                   |
| **读取方**                                                  | ① 新 RPC（如 `listWorkspaceRegistry`）供侧栏使用；② `/api/server-info.workspaces` 改为返回注册表（或其中的默认可见子集）；③ 桌面端沿用同一注册表（它本来就能看到更多，不应因此变少）                                                                                                |
| **客户端设置（`lastWorkspaceSession` / `recentProjects`）** | 降级为**显示偏好**：排序权重、置顶、默认是否展开、以及「本客户端上次打开的是哪个」；**不再**充当枚举来源，也不参与过滤                                                                                                                                                              |

### 2.2 迁移与兼容

1. **一次性回填**：注册表为空时，从两源枚举并写入；随后每次会话/任务落库时 upsert（幂等键 = workspaceKey）。
2. **老设置并入**：把 `lastWorkspaceSession` 里的路径并入注册表（`sources` 标记 `settings-migrated`），并保留其顺序作为该客户端的显示偏好；不删除老设置字段（向后兼容旧客户端）。
3. **身份缺失的兼容**：只有路径、没有 identity 的条目按本地工作区处理（`workspaceKey = path`），与既有 `resolveWorkspaceKey` 口径一致；远端条目必须带 identity，否则**不合并**（避免同路径不同 authority 互相认领 —— 这正是 `server-operations.ts:1640-1648` 与 `v4-bridge.ts:1358-1400` 已经处理的语义）。

### 2.3 边界：为什么**不做**两条真相源

- 若客户端设置继续参与枚举，则：① 新浏览器/新设备看到的是「空列表」而不是真实集合（实测：设置只有 23 条，而数据侧有 52/53）；② 同一服务器在两个客户端上可见集合不同，用户无法判断「是数据丢了还是客户端没同步」；③ 服务端无法据此做（后续可能需要的）分页/懒订阅决策，因为它不知道全集。
- 因此：**枚举只有一处**（服务端注册表）；客户端设置只影响「怎么显示」。

### 2.4 可行性与替代方案

- **可行**：服务端已能读两个库（任务索引由本进程维护；会话库读取已有 `listSessions` 路径）。缺口只有「按 distinct 目录枚举」这条查询（新增，代价小）与「identity 推导」（本地 = 路径；远端由会话/任务行自带）。
- **替代方案（若坚持客户端持有）**：把设置的作用域从「本机」改为「服务器侧存储 + 每客户端 ID 维度」，即设置本身也做服务端共享/分用户。它仍无法解决「新客户端看到空列表」，且引入第二份可变状态；**不推荐**。

## 3. 加载策略：「能全看、不默认全看」

| 档                    | 默认显示什么                                                                                             | 其余如何进入视野                                        | 订阅                                           | task-23 实测代价                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **默认视图**          | 注册表里「最近活跃窗口内」的 workspace（建议 30 天，或 `pinned` 显式置顶）**∪ 本客户端设置里明确列出的** | —                                                       | 只订阅**默认视图内**的 workspace               | 22-28 个订阅 = 服务端 +0.3-0.4 MB、0 子进程、RPC 合计十几 ms；线上字节 ≈1.37 KB/个（无 runtime 时是错误信封，不是 snapshot） |
| **展开/搜索进入视野** | —                                                                                                        | 点「显示全部」后分页列出注册表全集；搜索按路径/标题过滤 | 订阅**可见或已展开**的 workspace（懒订阅）     | 50 个订阅（不懒）= 服务端 +0.7 MB、RPC 26 ms；懒订阅可把首屏订阅数压到可见数（个位数-几十）                                  |
| **打开工作区（M2）**  | —                                                                                                        | 从列表或「打开路径」入口选中即成为当前 scope            | 该 workspace 的 runtime 被拉起（**仅此一个**） | **单个 live runtime = +20 MB RSS（峰值 +25 MB）+ 1 个子进程**                                                                |

**publisher 护栏（必须做的一件事）**：被动订阅（侧栏/首屏）**必须**使用 `runtimePolicy: 'existing-only'`。实测：默认策略（`start-if-needed`）会为被订阅的 workspace 拉起 Agent runtime（1 个 workspace = +20 MB + 1 进程；50 个外推 ≈1 GB + 50 进程）；代码注释已有这条规矩（`zcodeAgent.ts:522-525`），但**没有测试钉住**。
**LRU / 空闲驱逐**：本轮**不要求**。理由是任务的真正增长维度是 **live workspace 数**（用户实际打开的工作区，通常 1-2 个），而不是列表长度；`SessionsIndexPublisherRegistry` 的无上限 Map（`sessions-index-publisher-registry.ts:9-21`）只有在「同时打开很多工作区」的产品形态下才需要 LRU。若 M2 之后要支持这种形态，再按 §6 的 ④ 排期。**deltaLog 512 帧的实际占用未实测**（合成数据产生不了真实 delta），按未验证对待。

### 3.1 架构不变式（硬约束，不是优化建议）

> **列表 = `existing-only`；打开 = 按需 `start-if-needed`。**

- **列出全部工作区绝不能顺带拉起 Agent runtime**：侧栏/首屏等被动订阅一律 `runtimePolicy: 'existing-only'`；runtime 不存在时返回稳定错误 `ZCode Agent runtime is not running.`（实测 50/50），**不得**改用默认策略「顺手启动」。
- **只有用户主动打开某个 workspace 才允许启动 runtime**：即 M2 的打开动作（以及显式会话入口）走默认策略；这是一条**架构边界**，因为它决定成本模型（列表 ≈14 KB/workspace；每个 live runtime ≈+20 MB 与 1 个子进程，见 `PUBLISHER-SCALE-MEASUREMENT.md` §2）。
- 代码注释里已经有这条规矩（`packages/services/src/zcode-agent/zcodeAgent.ts:522-525`：「task-list 等被动观察者必须使用 existing-only；runtime 不存在时返回稳定 unavailable，禁止为了建立列表订阅而启动 Agent」），但**没有任何测试钉住它** —— 这正是 §6 M1 的护栏项（⑤）要补的。

### 3.2 列出来但没启动 runtime 的 workspace，用户看到什么（UX 定清）

实测背景：非 live workspace 的 sessions-index 订阅会返回稳定错误 `ZCode Agent runtime is not running.`（不是空列表、不是崩溃）。M1 把 28/50 个 workspace 列出来后，**必须**对这种状态给出诚实且可操作的展示：

| 状态                       | 列表项怎么显示                                                                                                      | 点开时                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 有已存会话、runtime 未启动 | 用**服务端注册表/会话库的持久数据**渲染列表项（标题、最近活动时间、会话条数），并标注「未启动」徽标（可点开才启动） | 显示加载态 → 启动 runtime → 载入该 workspace 的会话；加载失败给出可重试的错误，而不是空白 |
| 无任何会话、runtime 未启动 | 显示「暂无任务」并标注「未启动」                                                                                    | 同上（启动后即为空列表态，可新建任务）                                                    |
| runtime 启动中             | 骨架/加载态（不可误报为「暂无任务」）                                                                               | —                                                                                         |
| runtime 启动失败           | 明确的失败态 + 重试入口 + 原因（例如 runtime 不可用/版本不匹配）                                                    | —                                                                                         |

**禁止**：① 「点开是死路」（点了没有任何反应或不给原因）；② 「假装有内容」（用错误信封/占位当会话渲染）；③ 「把未启动当成空列表」而让用户以为会话丢了 —— 这正是本任务要修掉的用户观感。
**据此**，注册表条目要能返回**持久层的**会话计数与最近活动时间（来自会话库/索引库，不依赖 runtime），列表才能在 runtime 未启动时依然如实显示「有什么」。

## 4. 多客户端一致性

| 问题                            | 结论                                                                                                                                                                                                        | 证据 / 未测项                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 两个浏览器今天为什么不同步      | 因为**各自设置决定可见集合**；数据侧其实一致（同一服务端、同一索引/会话库）                                                                                                                                 | §1；实测同一服务端下「新 origin 无 cookie」与「有 cookie」看到的是同一数据，差异只在授权                        |
| 改成服务端注册表后              | 可见集合对所有客户端**逐条一致**（同一 RPC、同一注册表）；设置只影响排序/置顶/默认展开                                                                                                                      | 设计结论，实施后有验收判据 ④                                                                                    |
| publisher 是否按 workspace 复用 | **是**：按 `workspaceId` 在 CLI runtime 内建一次并复用（`SessionsIndexPublisherRegistry` 的 `publishers` Map）；同一 topic 的多次订阅由 `(connectionId, topic)` 决定是否替换代际（`zcodeAgent.ts:515-520`） | `v4-gateway.ts:1189-1241`、`sessions-index-publisher-registry.ts:9-21`                                          |
| 每连接是否独立                  | **是**：每个 WS 连接在服务端拿到独立 `createZCodeAgentConnectionScope(connectionId: server-ws-<uuid>, role: terminal-client)`；订阅/退订按连接记账                                                          | `packages/server/src/http.ts:91-101`                                                                            |
| owner/lease 与 scope            | web 恒为 **terminal-client**，**不持 lease**；lease 属于桌面 host 路径（`desktop-continuous`）。web 只消费快照/流，不参与 owner 裁决                                                                        | `packages/server/src/http.ts:96-101`、`packages/desktop/src/host/index.ts:1277-1300`、`AGENTS.md` 进程/协议一节 |
| 用户会看到什么                  | 两个浏览器/手机与桌面打开**同一个** workspace 时，列表与流内容一致；**并发写入**的行为由 runtime 的 `CommandInbox` 串行 admission 决定，**本轮未测**（不要在文案里承诺）                                    | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts`                                      |
| 未测项                          | ① 多客户端同 workspace 并发写的实际表现；② 两个客户端订阅同一 workspace 时的帧扇出开销；③ 注册表在多进程（桌面 + 服务端同时写）下的并发写语义（需要选一个写者，见 §6 依赖顺序）                             | —                                                                                                               |

## 5. 能力对齐边界（产品口径基线）

**web 与桌面应保持一致（对齐清单）**：workspace 枚举与选择；会话列表语义（`taskTypes` 白名单、归档过滤、分页/上限口径）；打开/继续会话与流式更新（`web-remote-replayable` 恢复语义）；终端；设置（模型/权限/工具与权限页）；插件与 MCP 的启停；Git/文件操作（通过服务）；搜索；分享落地页。

**桌面壳专有、web 不承诺（明确排除）**：系统托盘与开机自启；原生窗口/多窗口与 macOS 交通灯区；原生文件对话框与「在编辑器打开」（`getInstalledEditors`/`openInEditor` 在 web 是空实现）；窗口截图与日志导出（`captureWindowScreenshot`/`exportLogs` 在 web 返回不支持）；Chrome 数据导入；Computer Use（`node_repl`/CUA，`NOTICE.md:37` 明确「远端工作区与 Web 不承载该能力」）；嵌入式浏览器（`supportsEmbeddedBrowser={false}`）；自动更新与代码签名；SSH/Docker/WSL 远程工作区（`allowRemoteWorkspace={false}` 且 `connectRemote` 在 web 暂不支持）。

> 依据：`packages/web/src/main.tsx` 的平台实现（多处显式 no-op）与 `NOTICE.md:37,43`。**这份清单即手机批次的验收基线**：清单内的项要一致，清单外的项不得在文案里暗示「和桌面一样」。

## 6. M1 / M2 落地拆解（文件级 + 代价 + 依赖顺序）

**M1：看得到（≥ 注册表默认视图）**

1. 服务端枚举查询：在任务索引侧新增「distinct workspace（含无未归档行）+ 会话库 distinct directory」的合并查询（`packages/services/src/session/taskIndexRepo.ts` 或新的 registry 模块）。
2. 持久化注册表：在**任务索引库既有迁移机制内**加表（见下方修正），列 `workspace_registry(workspace_key, workspace_path, workspace_identity, first_seen_at, last_activity_at, session_count, sources, pinned)`；幂等 upsert + 一次性回填。
   - **修正（本轮落实）**：表必须作为 `packages/services/src/session/tasksDatabase/migrations.ts` 的**新迁移定义**加入（`id` 形如 `0004_workspace_registry`、`checksumInput: [WORKSPACE_REGISTRY_MIGRATION_SQL]`，DDL 常量放新的 `workspace-registry-v1.ts`，与 `schema-v1.ts` 同构），由 `runTasksDatabaseMigrations` 统一执行与校验 —— **不要**在注册表模块里自创第二套 schema 版本策略或裸 `CREATE TABLE IF NOT EXISTS`（既有机制带 id + checksum + 升级判定）。
   - 理由：`packages/services/src/session/tasksDatabase/migrations.ts:46-68` 的 `definitions` 是任务索引库唯一的 schema 演进入口（`tasks_schema_migration` 表 + checksum 校验，`:86-115`）。
3. RPC 与 server-info：`listWorkspaceRegistry`（`packages/services` + `packages/shared` 的协议类型）；`/api/server-info.workspaces` 改由注册表驱动（`packages/server/src/http.ts:158-180`）。
4. 客户端列表来源切换：`packages/ui/src/hooks/{useGroupedTaskView,useWorkspaceTaskLists}.ts` 的 scopes 从「设置」改为「注册表默认视图 ∪ 设置置顶」；设置降级为显示偏好（排序/置顶/默认展开）。
5. **护栏（纳入 M1 范围，0.5-1 天）**：一条自动化断言 —— 「列出 N 个（含 50 个）列表项**不产生任何子进程**」，并断言被动订阅调用携带 `runtimePolicy: 'existing-only'`。它防的是「有人把被动订阅改成默认 `start-if-needed`」这种灾难式回归（外推 50 个 live runtime ≈1 GB + 50 进程）。建议放在已有测试入口（例如 `packages/server/test/` 的 HTTP/鉴权覆盖面附近，或 `packages/web/test/`），断言方式：以隔离 HOME 起服务端 → 订阅 N 个 workspace → 断言服务端进程**子进程数恒为 0**（task-23 的测量脚本可直接改造成断言）。
6. 懒订阅与分页：**可选（不阻塞 M1）**。task-23 实测表明「列出 50 个」本身极便宜（服务端 +0.7 MB、0 子进程、50 次 RPC 26 ms），因此懒订阅（只订阅可见/展开项）与列表分页/首屏延后都**不是必须**；只有在实测到首屏耗时或错误信封流量成为问题（例如列表长到数百项）时再做（各 1-3 天）。

代价：**3-5 天**（服务端枚举+持久化+RPC 约 2 天；客户端列表来源与懒订阅 1.5-2 天；测试与文档 0.5 天）。风险：中（改的是列表口径，需要与桌面端同时验证；桌面端读取同一注册表时不得变少）。

**M2：打得开（含 web 侧入口与写回设置）**

1. web 平台实现：`activateOrSetWorkspace` 真正切换当前 scope、`onOpenWorkspace` 打开目录选择（`preferDirectoryBrowser` 已为 true，`packages/web/src/main.tsx:204,295,385-465`）。
2. 打开后写回：把新工作区并入注册表（服务端）+ 写回本客户端显示偏好（设置）。
3. 身份与路由：打开远端/同名路径工作区时按 `workspaceIdentity` 分组与传递（`zcodeAgentConnectionScope.ts:112-121`）。

代价：**3-5 天**（依赖 M1 的注册表与列表来源）。风险：中高（引入跨 workspace 切换的 UI 分叉；必须保证「点开即为该 scope」）。

**依赖顺序**：M1.1 → M1.2 → M1.3 → M1.5（护栏）→ M1.4（列表来源）→ M2。注册表的**写者唯一性**必须先定：建议服务端（服务进程）为唯一写者，桌面端只读；否则要引入版本/冲突规则（未测项 ③）。

## 7. 验收判据（手机批次）

1. **侧栏项数 ≥ 当次「注册表默认视图」**：默认视图 = 最近活跃窗口 ∪ 置顶；「显示全部」后能列到注册表全集（≥ 当次数据里「设置列表 ∪ 索引未归档」的并集数）。
2. **能打开一个不在设置列表里的 workspace 并看到会话**，且会话条数与 `~/.zcode/cli/db/db.sqlite` 中该目录的可见会话数一致。
3. **断线重连后列表仍在**：复用 `web-remote-replayable` 的恢复语义（`docs/development/web-remote-control.md` §4）。
4. **多客户端一致**：两个独立浏览器（不同 cookie/设备）对同一服务器看到的**可见集合**与各 workspace 的**会话数**逐条一致；设置差异只影响排序/置顶/默认展开，不影响集合。
5. **架构不变式（护栏）**：列出 N 个（含 50 个）列表项**不产生任何子进程**；被动订阅全部走 `existing-only`；只有「打开工作区」这一步才允许出现该 workspace 的 runtime 子进程（断言方式见 §6 M1 第 5 项）。
6. **诚实的未启动态**：非 live workspace 的列表项显示持久层的会话计数/最近活动 + 「未启动」标识；点开显示加载态并启动 runtime；失败有原因与重试。**不得**出现「点开无反应」或「把错误当内容渲染」（§3.2）。

## 8. 未验证 / 需人工决定

1. **未测**：多客户端同 workspace 并发写；同 workspace 双订阅的帧扇出；注册表双写者的冲突语义；live workspace 的真实 snapshot 字节与 deltaLog 512 帧占用（见 task-23 §5）。
2. **需产品决定**：默认视图的「最近活跃窗口」取值（建议 30 天）与「显示全部」的交互（分页 vs 滚动加载）；桌面端是否也切到同一注册表口径（若不切，两端口径仍会不同，需要写明）。

## 9. 实施约束（架构治理，2026-09-24 追加）

以下四条是**硬约束**（Lead 拍定），实施时必须逐条满足；Unit 1 的状态见 §9.5。

1. **开工前读受控上下文**：先跑 `pnpm architecture:check --changed` 定位模块，再 `pnpm architecture:context <module-id>` 读目标契约与相邻契约。**本轮记录**：`architecture:check --changed` → `architecture: OK（violations 0 / baseline 0 / new 0）`；`architecture:context` 需要 module-id，我用 `node scripts/architecture/architecture-check.mjs context` 与 `scripts/architecture/policy.mjs` 都未列出可用的 id 清单，**尚未读到 context package** —— 这一点按未完成记录，下一个单元开工前先补（不得假装已读）。
2. **分层边界**：注册表所有者是服务端；`domain` 保持纯（不 IO、不 await 世界），落库与网络走 `adapters`；UI 不得直接调用 Repo/Service 实现，列表来源必须经新 RPC + 公开类型。
   - **与本 spec 的偏差（需 Lead 裁定）**：约束原文提到「经 `@zcode/contracts` 的公开类型」，但 `@zcode/contracts` 实际在 `apps/zcode-cli/packages/contracts`，且**不是** `packages/shared` / `packages/services` / `packages/ui` 的依赖（`grep @zcode/contracts` 于三者 package.json → 0 命中）。本仓库既有的服务端 RPC 契约类型放在 `packages/shared`（如 `server-remote.ts` 的 `ServerRemoteInfo`）与 `packages/services`（如 `session/zcodeTaskListTypes.ts`），故 M1.1 的纯类型与规则先落在 `packages/shared/src/workspace-registry.ts`。若必须走 `@zcode/contracts`，需要新增跨包依赖，请确认。
3. **不做第二条写入路径**：注册表只由服务端写，桌面只读；回填只做一次性幂等迁移；**不得**在客户端补写兜底。
4. **交互改动要 E2E 证据**：M1.4（列表来源切换）与 §3.2（诚实未启动态）除单测外必须有真浏览器/真机场景证据（可用 task-23 的隔离 HOME + 真实客户端，或手机尺寸 Playwright），覆盖「runtime 未启动 → 点开 → 加载 → 载入」与「启动失败 → 原因 + 重试」两条路径。
5. **Unit 1 状态（如实）**：M1.1 的**纯契约与默认视图规则**已落地并验证 —— `packages/shared/src/workspace-registry.ts`（`workspaceRegistryEntrySchema`、`resolveWorkspaceRegistryKey`、`WORKSPACE_REGISTRY_DEFAULT_VIEW_WINDOW_DAYS = 30`、`selectWorkspaceRegistryDefaultView`）+ `packages/shared/test/workspaceRegistry.test.ts`（4 条断言，含身份键回落、30 天窗口 ∪ 置顶、窗口可调且不改入参、schema 拒绝空 key/空来源），**反向验证**：去掉置顶分支 → 默认视图断言变红；恢复后 4/4 绿。门禁：typecheck exit 0、lint exit 0（71 既有 warning）、suite 52 文件 0 包失败、architecture OK。**M1.1（两源枚举）与 M1.2（迁移加表 + 回填 + upsert）已完成并验证**；**M1.3（RPC / server-info 惰性接线）尚未实现**，第 2 单元（M1.4 列表来源切换 + §3.2 诚实未启动态 + E2E）尚未开工。
   - M1.2 落点：迁移 `packages/services/src/session/tasksDatabase/workspace-registry-v1.ts`（`WORKSPACE_REGISTRY_MIGRATION_SQL`）+ 在 `migrations.ts` 的 `definitions` 注册 `0004_workspace_registry`；仓储与回填 `packages/services/src/session/workspaceRegistryRepo.ts`（`createWorkspaceRegistryRepo` / `enumerateTaskIndexWorkspaceEntries` / `mergeWorkspaceRegistryEntries` / `backfillWorkspaceRegistry`）。
   - **顺带硬化（需 Lead 知悉，属共享关键路径）**：迁移分派原本是 `if 0001 / else if 0002 / else 执行 0003 SQL` —— 任何新增 id（包括本次 0004）都会被静默执行成官方 GLM 迁移。现已改为按 id 显式分派，未知 id 显式抛错（fail-closed）。这不是「只增不改」，而是修掉一条静默数据污染路径。
   - 反向验证（护栏确实咬得住）：① 给枚举加 `archived = 0` → 「归档-only 的 workspace 必须在册」断言变红（3 pass / 1 fail），恢复后 4/4 绿；② 去掉 0004 的显式分派（改回兜底 else）→ 3 条变红（迁移建表、回填、真实库副本），恢复后 4/4 绿，且两文件与备份逐字节一致。
   - 真实库接触声明：未对 `~/.zcode/v2/tasks-index.sqlite` 执行任何写操作；测试只把它（含 -wal/-shm）copyFile 到 /tmp 后打开副本跑迁移与回填，断言既有任务行数不变、checksum 不冲突。
6. **路径展示**：注册表会出现用户从未在本机打开过的目录名（可能含敏感信息）—— 按 Lead 决定**先原样展示、不自创脱敏或隐藏**；若实现中发现牵动其它界面（分享页、日志），记入报告不动手。

7. **需人工判断**：把枚举真相源搬到服务端后，注册表里会出现用户从未在本机打开过的目录名（路径可能包含敏感信息），是否需要在手机上做隐藏/脱敏由用户决定 —— 这是产品选择，不是技术限制。

8. **配置漂移（本轮只记录，不改 policy）**：`architecture-policy.yaml` 里 `session` 声明 `publicEntrypoints: [packages/services/src/session/contract.ts]`，但该文件**不存在**；且 `session` 为 `managed: false`，policy 的 `global.managedOnly: true` 使这条边界今天既无从落地也未被强制。证据：`pnpm architecture:context session` 输出 `public: packages/services/src/session/contract.ts`（另有 `module.ts: missing`），而该路径在仓库里不存在。一句话修法建议（二选一，由 Lead 统一决定）：① 删掉这条 `publicEntrypoints`（文件本就不存在）；② 补 `session/contract.ts` 作为真正的公共入口，再把 `session` 转为 `managed: true`。**本轮不改 policy**，也不自创新 contract 文件。
9. **services 侧公共入口的落地方式（Lead 决定，已实施）**：跨包访问 `@zcode/services` 的真实出口是 `packages/services/package.json` 的 `exports` 子路径（既有：`.`, `./node`, `./storage-startup`, `./process/processTreeTerminator`, `./cua-permission-broker`）。本轮新增子路径 `./workspace-registry`（指向 `./src/session/workspaceRegistryRepo.ts`）；已验证可解析 —— 用 `@zcode/services/workspace-registry` 导入成功，导出 `createWorkspaceRegistryRepo` 与 `backfillWorkspaceRegistry`。后续 `packages/server` 与 RPC 层应从该子路径导入。
10. **交接状态（Unit 1 收尾，一句话版：已完成 M1.1+M1.2，未完成 M1.3 与第 2 单元，证据在测试文件，下一步先做 task-27）**：
    - 已完成：M1.1 两源枚举、M1.2 迁移/回填/幂等 upsert、迁移分派 fail-closed 硬化（含「未知 id 必须抛错」断言）。
    - 证据：`packages/services/test/workspaceRegistryRepo.test.ts`（5 条）与 `packages/shared/test/workspaceRegistry.test.ts`（4 条）；门禁 = typecheck 0 error / lint 0 error（71 条基线 warning）/ `fmt:check` exit 0 / `architecture:check --changed` OK。
    - 反向验证：① 给枚举加 `archived = 0` → 归档-only 断言变红；② 去掉 `0004` 显式分派 → 3 条变红；③ 未知 id 退回兜底执行 `0003` → 1 条变红；三次均从备份恢复且逐字节一致。
    - 未完成：M1.3（RPC + `server-info` 惰性接线）、M1.4（web 与桌面列表来源切换 + §3.2 诚实未启动态）、E2E 两条路径（未启动→点开→加载→载入；启动失败→原因+重试）。
    - 下一步：先 task-27（暴露检查：启动期与运行期告警，只动 `packages/server/src`），再做第 2 单元；第 2 单元里 M1.3/M1.4/§3.2 必须同批交付（只切列表来源而不给未启动态，会比现状更糟），E2E 可溢出到下一轮但必须在报告里显式声明未做。

11. **task-27 已完成（暴露检查）**：启动期 + 运行期各一次 `warn`，只告警不拒绝、未新增环境变量、未改既有拒绝规则。证据 = `packages/server/test/httpExposureWarning.test.ts`（7 条）+ 反向验证（删启动期/运行期告警各让 1 条变红）；门禁 = typecheck 0 error / lint 0 error（71 基线 warning）/ fmt:check exit 0 / architecture OK / `packages/server` 21/21 pass；文档 = `docs/development/local-setup.md` 的「暴露面告警」小节 + `.reverse/40-remote-control/SECURITY-SERVER-DEFAULTS.md` §9。
12. **交接状态（截至本轮结束）**：已完成 M1.1 + M1.2（含迁移分派 fail-closed 硬化的测试）与 task-27；**未完成 M1.3 / M1.4 / §3.2 与两条 E2E**（本会话预算已尽，按 Lead 的预算纪律在此停，不留半成品）。下一次开工的入口顺序：M1.3（RPC + `server-info` 惰性接线，服务端侧，从 `@zcode/services/workspace-registry` 导入）→ M1.4（`packages/ui/src/hooks/**` 列表来源切换，web 与桌面同批）→ §3.2 诚实未启动态（持久层会话计数/最近活动 + 「未启动」标识，点开才启动 runtime）→ E2E 两条路径（未启动→点开→加载→载入；启动失败→原因+重试）。**M1.3/M1.4/§3.2 必须同批**；E2E 可溢出但必须显式声明未做。
