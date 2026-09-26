# 「未启动」的语义、设计意图与体验缺口

> 调查任务 R3（**只读调查，未改任何源码**）。每条结论给 文件:行号 + 可复现命令；区分**已确认**与**待验证假设**。
> 时间快照：2026-09-27，仓库 `6725e9c`（工作区干净部分为 R1/R4 的改动，与本报告无关）。

## 0. 读了什么 / 结论是否与既有文档一致

| 文档                                                               | 结论                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/development/workspace-registry.md`（全文 142 行，逐节读）    | **主体一致**：§3.1 的两档 runtimePolicy、§3.2 的四种状态与三条禁止项、§5 的实现落点、§6 的未实施项，都能在源码里逐条对上。**发现 3 处不一致/缺口**：① §3.2 表格「无任何会话」一行承诺的文案与实现不同（见 §5.1）；② §3.2 承诺未启动行「用持久数据渲染列表项（标题、最近活动时间、会话条数）」，但**注册表补列行永远拿不到会话标题**（见 §5.2，源码级已确认）；③ 章节号从 §6 跳到 §8（**§7 不存在**），而 `packages/ui/src/hooks/useWorkspaceRegistry.ts:12` 正引用「§7.3」——悬空引用。 |
| 根 `AGENTS.md`                                                     | 一致（唯一所有者、不做第二条写入路径、UI 不直接调 Repo/Service 实现、Workspace Identity 口径）。                                                                                                                                                                                                                                                                                                                                                                                       |
| `.reverse/40-remote-control/PUBLISHER-SCALE-MEASUREMENT.md`        | 一致：`existing-only` 是「列出 50 个不产生子进程」的前提；`start-if-needed` 才会每项拉起一个 runtime。                                                                                                                                                                                                                                                                                                                                                                                 |
| `.reverse/40-remote-control/E2E-MOBILE-WEB.md`                     | **部分不一致**：§2 称「有会话的 workspace 直接列出持久层会话标题」，但当前源码里**注册表补列行的 taskItems 恒为空数组**（`WorkspaceSidebar.tsx:1653`），不可能列出会话标题。该句要么描述的是 tab 行（另一条链路），要么是陈旧观察。见 §5.2。                                                                                                                                                                                                                                           |
| `.reverse/40-remote-control/M1-CRITERIA-3-4.md`                    | 一致，且给出本报告最关键的量化事实：**29 个工作区行 / 28 个「未启动」徽标**（§1 表格）。                                                                                                                                                                                                                                                                                                                                                                                               |
| `docs/development/131-workspace-path-titled-entries.md`（R2 报告） | 一致，可对账：R2 的「点击后消失」= `addTab` 把补列行物化成 tab ⇒ 派生行当帧被过滤。本报告 §4 给出该点击的**完整事件顺序**（含 runtime 启动与徽标消失），与 R2 的结论互补、不冲突。                                                                                                                                                                                                                                                                                                     |

---

## 1. 结论：「未启动」的精确语义 + 设计动机

**「未启动」= 服务端（host/服务进程）里，这个工作区当前没有 live 的 ZCode Agent runtime 进程。**
它不是「服务端没有为该工作区建立索引发布器」，不是「客户端没连上」，也不是「该工作区没有会话」。

精确链路（三段，缺一不可）：

1. **事实来源**：sessions-index 订阅在 `runtimePolicy: "existing-only"` 下，若该 workspaceKey 没有活跃 client，服务端返回**稳定错误** `ZCode Agent runtime is not running.`（`code = ZCODE_AGENT_RUNTIME_UNAVAILABLE`），而**不是**空列表、也不是超时。
2. **客户端收敛**：renderer 的 `SessionsIndexStore` 捕获这个错误码，把自身 status 置为 **`dormant`**（稳定态，不设重试定时器）。
3. **渲染判定**：`useWorkspaceRuntimeStates` 把 `dormant` 映射为 **`not-started`**，行上渲染「未启动」徽标、列表区渲染「未启动（点开即启动，不影响其它工作区）」+「打开并启动」。

**设计动机（一句话）**：工作区枚举从「本客户端设置」扩到「服务端注册表」后，被列出的工作区数量从 23 涨到 52（默认视图 23），而 Agent runtime 是**按工作区懒启动、每个约 +20 MB RSS 与 1 个子进程**的昂贵资源；若列表订阅顺手把它们都拉起来，50 个 ≈ 1 GB + 50 进程。因此确立硬不变式 **「列表 = `existing-only`；打开 = 按需 `start-if-needed`」**，代价就是**列表里必然存在一批「数据在、runtime 没起」的工作区**。「未启动」就是这批工作区的**诚实命名**——它存在的唯一目的，是让用户不要把「runtime 没起」误读成「会话丢了」。

**没有它会退化成什么（三条，对应文档 §1 的现象表）**：
① 列表项没有 runtime 就渲染空列表 ⇒ 用户看到「暂无任务」⇒ 以为会话丢了（正是 M1 要消灭的观感）；
② 或者反过来：为了不显示空列表而让被动订阅走 `start-if-needed` ⇒ 每列一次就拉起 N 个进程（成本爆炸，且有护栏测试钉住）；
③ 或者把错误信封当会话渲染 ⇒ 界面出现幽灵条目。
⇒ **「未启动」不是妥协的产物，是「不假装已就绪」这条产品原则的实现**（原文见 §3）。

---

## 2. 定义与判定代码位置（文件:行号）

### 2.1 状态定义与映射（判定「未启动」的唯一权威）

| 环节                             | 位置                                                                      | 内容                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 五态联合类型                     | `packages/ui/src/hooks/useWorkspaceRuntimeStates.ts:24-34`                | `"unknown" \| "not-started" \| "starting" \| "live" \| "failed"`；注释明写 `not-started` = 「runtime 未启动（dormant）：点开才启动」    |
| store 状态机                     | `packages/ui/src/v4/sessionsIndexStore.ts:35`                             | `"idle" \| "dormant" \| "connecting" \| "live" \| "error"`                                                                              |
| **dormant → not-started 的映射** | `packages/ui/src/hooks/useWorkspaceRuntimeStates.ts:44-50`                | `if (status === "dormant") return "not-started";`                                                                                       |
| 取状态                           | `packages/ui/src/hooks/useWorkspaceRuntimeStates.ts:117-127`（第 124 行） | `states.set(key, binding ? mapStatus(binding.store.getStatus()) : "unknown")`；**没有 binding（未订阅成功）时为 `unknown`，不显示徽标** |
| store 读状态                     | `packages/ui/src/v4/sessionsIndexStore.ts:186-188`                        | `getStatus()`                                                                                                                           |

### 2.2 置为 dormant 的判定（「未启动」从哪来）

| 触发点                           | 位置                                                               | 说明                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 稳定错误码定义                   | `packages/services/src/zcode-agent/zcodeAgent.ts:180`              | `ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE = "ZCODE_AGENT_RUNTIME_UNAVAILABLE"`                                                                                                                 |
| 错误构造                         | `packages/services/src/zcode-agent/zcodeAgentService.ts:891-902`   | `new Error("ZCode Agent runtime is not running.")` + `code` + `workspaceKey`                                                                                                               |
| **产生该错误的服务端判定**       | `packages/services/src/zcode-agent/zcodeAgentService.ts:3377-3405` | `getReadOnlyClient(params, "existing-only")`：查 `activeClientsByWorkspaceKey` 与 `processManager.getExistingClient`，**都不命中就 throw**（3393-3395 行注释：「绝不为观察者拉起新进程」） |
| 两档策略类型                     | `packages/services/src/zcode-agent/zcodeAgent.ts:200`              | `type ZCodeAgentRuntimePolicy = "start-if-needed" \| "existing-only"`                                                                                                                      |
| 策略契约注释                     | `packages/services/src/zcode-agent/zcodeAgent.ts:565-568`          | 「task-list 等被动观察者**必须**使用 existing-only；runtime 不存在时返回稳定 unavailable，禁止为了建立列表订阅而启动 Agent」                                                               |
| **客户端识错**                   | `packages/ui/src/v4/sessionsIndexStore.ts:61-68`                   | `isRuntimeUnavailableError()`：只按 **code** 判定，不按错误文本（符合 AGENTS.md「不依赖错误文本做流程判断」）                                                                              |
| **置 dormant（subscribe 失败）** | `packages/ui/src/v4/sessionsIndexStore.ts:268-273`                 | catch 命中 → `handleRuntimeUnavailable()`；注释：「dormant 等待 lifecycle，不设 timer」                                                                                                    |
| **置 dormant（resync 失败）**    | `packages/ui/src/v4/sessionsIndexStore.ts:495-498`                 | 同上                                                                                                                                                                                       |
| **置 dormant 的实现**            | `packages/ui/src/v4/sessionsIndexStore.ts:677-697`（695 行）       | 清空投影、`this.status = "dormant"`、`emit()`                                                                                                                                              |

### 2.3 谁在「被动订阅」（决定哪些行会显示未启动）

| 位置                                                                   | 说明                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/ui/src/v4/agentSessionsIndexTransport.ts:123, 139, 169, 182` | subscribe / unsubscribe / resync **四处全部硬编码** `runtimePolicy: "existing-only"`                                                                                     |
| `packages/ui/src/v4/sessionsIndexRegistry.ts:101-158`                  | `acquireSessionsIndex`：按 endpoint+workspaceKey 引用计数共享一条订阅；首次 acquire 即 `store.connect(...)`（147 行）⇒ **侧栏每列一个工作区就发一条 existing-only 订阅** |
| `packages/ui/src/hooks/useWorkspaceRuntimeStates.ts:79-115`            | 侧栏对**所有**非远端行逐 key acquire；远端行（`isRemote`）被过滤掉，永远 `unknown`（64-67 行）——**「未启动」（本地）与「未连接」（远端）是两套状态，不得混淆**           |
| `packages/ui/src/WorkspaceSidebar.tsx:415-427`                         | `runtimeStateInputs` = 所有行（tab 行 ∪ 注册表补列行）                                                                                                                   |
| 服务端侧同一口径                                                       | `packages/services/src/zcode-agent/zcodeAgentService.ts:5780-5785`；`packages/desktop/src/host/windowHostSessionsIndexObserver.ts:185,224,292,299,353`                   |

### 2.4 渲染落点

| 位置                                                 | 内容                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/ui/src/WorkspaceRuntimeNotice.tsx:137-159` | `WorkspaceRuntimeBadge`：`not-started` → 文案 key `workspaceRuntime.badge.notStarted`，`data-workspace-runtime-badge="not-started"`              |
| `packages/ui/src/WorkspaceRuntimeNotice.tsx:86-118`  | `not-started` 的列表区画面：标题 + 「已有 {count} 个会话，最近活动 {activity} 前」/「还没有会话；打开后可新建任务」+「打开并启动」按钮           |
| `packages/ui/src/WorkspaceSidebarItem.tsx:792`       | 徽标挂在**工作区行标题**上（不是会话行）                                                                                                         |
| `packages/ui/src/TaskList.tsx:35-37`                 | `isHonestRuntimePlaceholder`：只有 `not-started/starting/failed` 才占空列表位；`unknown`/`live` 落回「暂无任务」                                 |
| `packages/ui/src/TaskList.tsx:461-472`               | 该分支**先于**「暂无任务」分支                                                                                                                   |
| 文案                                                 | `packages/ui/src/i18n/locales/zh-CN.ts:1259-1270`（`未启动` / `未启动（点开即启动，不影响其它工作区）` / `打开并启动`）；en-US 对应 `:1350-1363` |

**可复现命令**（只读，源码级断言，实测 7 pass / 0 fail）：

```bash
cd packages/ui && node --import tsx --test test/workspaceRegistryWiring.test.ts
# ✔ 侧栏把 runtime 状态接到行上，且未启动不再落到「暂无任务」
# ✔ 被动订阅必须携带 existing-only：列出 50 个工作区不得拉起 runtime
```

---

## 3. 设计意图（文档原文引用）与「没有它会怎样」

### 3.1 原文引用（`docs/development/workspace-registry.md`）

**§3.1 架构不变式（52-56 行）** —— 这是「未启动」存在的前提：

> **列表 = `existing-only`；打开 = 按需 `start-if-needed`。**
>
> - **列出全部工作区不得同时拉起 Agent runtime**：侧栏/首屏等被动订阅一律 `runtimePolicy: 'existing-only'`；runtime 不存在时返回稳定错误 `ZCode Agent runtime is not running.`。
> - **只有用户主动打开某个工作区才允许启动 runtime**。这条是成本模型的一部分：列表 ≈14 KB/工作区，而每个 live runtime ≈+20 MB 与 1 个子进程（外推 50 个 ≈1 GB + 50 进程）。
> - 该规矩由自动化护栏钉住（见 §5），不是注释级约定。

**§3.2 的定位句（60 行）**：

> 被列出来但没有 live runtime 的工作区，其索引订阅会返回稳定错误（不是空列表、不是崩溃）。对这种情况必须给出**诚实且可操作的展示**：

**§3.2 三条禁止项（69 行）** —— 这就是「有意设计，不是妥协」的直接原文：

> **禁止**：① 点开没有任何反应或不给原因；② 把错误信封/占位当会话渲染；③ **把「未启动」当成「空列表」而让用户以为会话丢了**。

**§8 验收判据第 6 条（126 行）**：

> 6. **诚实的未启动态**：非 live workspace 的列表项显示持久层的会话计数/最近活动 + 「未启动」标识；点开显示加载态并启动 runtime；失败有原因与重试。**不得**出现「点开无反应」或「把错误当内容渲染」（§3.2）。

**§1 要解决的三条现象（10-16 行）**：换客户端看到空列表 / 两个客户端集合不同 / 无法判断会话是不是丢了。实测：客户端设置 23 条 vs 服务端 52 个 workspace。

### 3.2 「没有它会怎样」（把上面的意图反推）

| 若不显示「未启动」，而是…                              | 退化结果                                                          | 被哪条禁止项/护栏拦住                                                                                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 显示「暂无任务」                                       | 用户以为会话丢了 —— 比 M1 之前更糟（M1 之前这些工作区根本不出现） | §3.2 禁止 ③；`TaskList.tsx:461` 的分支顺序 + `workspaceRegistryWiring.test.ts` 断言                                                                                               |
| 什么都不显示 / 点开无反应                              | 「点开是死路」                                                    | §3.2 禁止 ①                                                                                                                                                                       |
| 把错误信封当会话渲染                                   | 幽灵条目                                                          | §3.2 禁止 ②                                                                                                                                                                       |
| 让被动订阅走 `start-if-needed`（这样列表总是"有数据"） | 列 50 个 ⇒ ≈1 GB + 50 进程                                        | §3.1 不变式；`workspaceRegistryWiring.test.ts`（传输面三处调用必须带 existing-only）、`workspaceRegistryService.test.ts` / `serverInfoRegistry.test.ts`（列 50 前后子进程数相等） |

**结论：有意设计。** 它不是「先这样凑合」——它有成文的禁止项、验收判据与四条自动化护栏，且护栏做过反向验证（把 `existing-only` 改回默认策略 ⇒ 对应用例变红，见 `workspaceRegistryWiring.test.ts:154-164` 与 `.reverse/40-remote-control/PUBLISHER-SCALE-MEASUREMENT.md:58`）。

---

## 4. 用户可感知行为：点击一个「未启动」的工作区会发生什么（事件顺序）

**先回答一个关键事实**：用户说的「每个都标注未启动」是**必然结果**，不是异常。徽标挂在**工作区行**上（`WorkspaceSidebarItem.tsx:792`），只要该工作区没有 live runtime 就显示；而 runtime 是按工作区懒启动的昂贵资源（§3.1）。因此首屏**几乎所有行**都带这个徽标。量化证据：`.reverse/40-remote-control/M1-CRITERIA-3-4.md:37` 实测 **29 行 / 28 个未启动徽标**（唯一不带徽标的那行是当时 live 的工作区）。

### 4.1 点击后的事件顺序（已确认，源码级）

以**注册表补列行**（`tab === null`）为例，点击整行触发 `CollapsibleTrigger`：

| #   | 事件                                                                                                                           | 位置                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 1   | 展开回调判定 `nextOpen && !isExpanded` → `onStartDraftInWorkspace(path, identity)`                                             | `WorkspaceSidebarItem.tsx:301-330`（316 行）                                                                          |
| 2   | `App.handleStartDraftInWorkspace`：`activateTabByPath` **必然未命中**（补列行不在 tab store）→ `addTab`                        | `packages/ui/src/App.tsx:712-800`（`addTab` 在 757/766，`startDraft` 在 773）                                         |
| 3   | `addTab` 把该路径**物化成真 tab 并插到列表最前**                                                                               | `packages/ui/src/store/tabStore.ts:257-306`（插入在 293-296）                                                         |
| 4   | **同一帧**：`buildWorkspaceSidebarRows` 的 `tabKeys` 命中该 key ⇒ 该条**补列行被过滤掉**，改由 tab 行承载                      | `packages/ui/src/hooks/workspaceSidebarRows.ts:48-51, 68-71`                                                          |
| 5   | 该 workspace 成为 active scope ⇒ `SessionPane` 挂载 ⇒ 草稿目录水合调用 `readWorkspacePresentation`                             | `packages/ui/src/v4/composer/useDraftConfigControl.ts:325-408`（363 行）                                              |
| 6   | **这一步才真正启动 runtime**：`readWorkspacePresentation` 内部用 `getReadOnlyClient(params)`，**默认策略是 `start-if-needed`** | `packages/services/src/zcode-agent/zcodeAgentService.ts:4024-4071`（4033 行）→ `3379`（默认值）→ `3404`（走启动路径） |
| 7   | CLI 进程 `spawn` → 发布 lifecycle `available`                                                                                  | `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:1137-1155`（1148-1154）                                |
| 8   | renderer 收到 `available` → `handleRuntimeAvailable` → `handleRuntimeRestart` → 重订阅                                         | `packages/ui/src/v4/agentSessionsIndexTransport.ts:220-245`；`sessionsIndexStore.ts:672-675, 631-670`                 |
| 9   | 重订阅成功 ⇒ `status = "live"` ⇒ **徽标消失**，改渲染真实会话列表                                                              | `packages/ui/src/v4/sessionsIndexStore.ts:251`；`WorkspaceRuntimeNotice.tsx:139-141`（非三态即返回 null）             |
| 10  | 副作用（300ms 防抖）：该路径被写回设置 `lastWorkspaceSession` ⇒ **永久**不再是补列行                                           | `packages/ui/src/hooks/useTabPersistence.ts:281-297` + `90-104`                                                       |

**与 R2 对账**：R2 的结论「点击后消失 = 客户端把补列行物化成 tab 的副作用，与 runtime 启动无关」**与本报告一致且互补**——本报告补充了同一次点击里**并行发生**的第二件事（第 5-9 步：真的把 runtime 拉起来了，徽标随之消失）。两者合起来解释了用户看到的两件事：**行消失了**（第 4 步，R2 的结论）+ **它不再是「未启动」**（第 9 步）。第 10 步是 R2 指出的护栏缺口（`workspace-registry.md` §5 护栏④只钉住「列出不物化」，没钉住「打开不物化」）——本报告独立复核：`packages/ui/test/workspaceRegistryWiring.test.ts:166-186` 只在纯函数/源码层面断言，确实没有覆盖点击路径。

### 4.2 三条过渡/失败路径

| 状态           | 用户看到                                                                                                                                                  | 位置                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 点开后、ACK 前 | 短暂「启动中」（`connecting`→`starting`）。`.reverse/40-remote-control/M1-CRITERIA-3-4.md:27-30` 明确把这条列为**允许的过渡态**，不算「未启动被错乱标记」 | `useWorkspaceRuntimeStates.ts:47`；`WorkspaceRuntimeNotice.tsx:36-46`                                   |
| 启动失败       | 「「{workspace}」启动失败」+ 原因 + 「重试」按钮                                                                                                          | `WorkspaceRuntimeNotice.tsx:48-84`                                                                      |
| 重试           | 复用同一个 `onStartDraftInWorkspace`（**与「打开并启动」是同一个回调**）                                                                                  | `WorkspaceSidebarItem.tsx:1176-1177`                                                                    |
| 离开该工作区   | best-effort 回收预热态 runtime（`disposeWorkspace`）⇒ 下次回来又是「未启动」                                                                              | `packages/ui/src/app-shell/useWorkspaceShellLifecycle.ts:44-92`；`zcodeTaskServiceAdapter.ts:1778-1781` |

**一条重要边界（已确认）**：`runtimeFailureReason` 目前**没有任何生产调用方传值**（全仓 grep 只命中 `TaskList.tsx` 的形参与透传，见 §6 命令），因此「启动失败」画面实际总是显示兜底文案「没有拿到具体原因，可重试一次；若持续失败请查看日志。」（`zh-CN.ts:1264-1265`）。§3.2 要求「失败有原因」，**当前只做到了半个**。

---

## 5. 未实施项清单与它们造成的体验缺口

### 5.1 文档 §6 明列的「未实施」（3 条）

| #   | 文档原文（`workspace-registry.md:105-107`）                               | 复核结果                                                                                                                                                                                                                                                                                    | 是否解释用户的不适                                                       |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | 工作区「置顶」显示偏好（服务端已支持 `pinnedKeys`，尚未暴露为设置）       | **已确认**：`packages/ui/src/WorkspaceSidebar.tsx:394` 调 `useWorkspaceRegistry()` **不传参**；`pinnedKeys` 只存在于 `useWorkspaceRegistry.ts:131-137` 的签名与测试里                                                                                                                       | **间接**：没有置顶，用户无法把常用的几个工作区从「未启动大名单」里拎出来 |
| 2   | web 端的「打开工作区」入口（`activateOrSetWorkspace` 真正切换当前 scope） | **已确认**：`packages/web/src/main.tsx:204` `activateOrSetWorkspace: () => Promise.resolve({ activated: false })`                                                                                                                                                                           | **间接**：web/手机端「打开路径」入口缺失，用户只能从侧栏点               |
| 3   | 只有会话、没有任务行的工作区尚不在册 —— 枚举目前以任务索引为主源          | **已确认**：`extraEntries`（会话库源）在生产路径**从未传入**（全仓只命中 `workspaceRegistryRepo.ts:148` 与测试）。本机实测：会话库 `session.directory` 去重 **62** 个（归一化后），其中 **10 个不在注册表**（如 `/home/sixiao/aicode/分析/Quaver汉化/_patch_old`、`/tmp/skill-gate-probe`） | **不解释**用户当前看到的不适（漏的是少数），但它意味着「能全看」仍不完整 |

**复现命令（只读）**：

```bash
# 注册表总数 / 30 天默认视图 / 会话库中不在册的目录
node -e '
const {DatabaseSync}=require("node:sqlite");
const reg=new DatabaseSync(process.env.HOME+"/.zcode/v2/tasks-index.sqlite",{readOnly:true});
const ses=new DatabaseSync(process.env.HOME+"/.zcode/cli/db/db.sqlite",{readOnly:true});
console.log("registry", reg.prepare("SELECT COUNT(*) c FROM workspace_registry").get().c);
console.log("defaultView(30d)", reg.prepare("SELECT COUNT(*) c FROM workspace_registry WHERE last_activity_at>=?").get(Date.now()-30*864e5).c);
const k=new Set(reg.prepare("SELECT workspace_key FROM workspace_registry").all().map(r=>r.workspace_key.replace(/\/+$/,"")));
const d=[...new Set(ses.prepare("SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL").all().map(r=>r.directory.replace(/\/+$/,"")))];
console.log("session dirs", d.length, "not in registry", d.filter(x=>!k.has(x)).length);'
```

实测输出：`registry 52 / defaultView(30d) 23 / session dirs 62 not in registry 10`。

### 5.2 文档**没有**列出、但本轮新发现的实现缺口（这才是用户不适的主因）

| #   | 缺口                                                        | 证据                                                                                                                                                                                                                                                                                                                                                                                                      | 用户体验后果                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **注册表补列行永远拿不到会话标题**                          | `packages/ui/src/WorkspaceSidebar.tsx:1653` `taskItems={EMPTY_WORKSPACE_TASK_ITEMS}`；`useWorkspaceTaskLists` 只遍历 `workspaceTabs: projectWorkspaceTabs`（`WorkspaceSidebar.tsx:682-689` → `useWorkspaceTaskLists.ts:286-288`），补列行不在 tab store                                                                                                                                                   | §3.2 表格承诺「用**持久数据**渲染列表项（**标题**、最近活动时间、会话条数）」，实际只做到「会话条数 + 最近活动」。用户看到「未启动 / 已有 20 个会话」，**看不到是哪 20 个**，只能点开才知道。这直接放大 R2 的「点击后消失」挫败感：点开=行换位置+写进设置，而点之前拿不到任何辨识信息 |
| B   | **`sessionCount` 含归档任务，与列表可见集合口径不一致**     | `packages/services/src/session/workspaceRegistryRepo.ts:124-142` 枚举 `tasks WHERE deleted = 0`（**不过滤 archived**，注释明写「保证只有归档任务的 workspace 也在注册表里」）；而侧栏 timeline 视图只显示 `!pinned && !archived`（`packages/shared/src/zcode-protocol-v4/controller.ts:134-135`）。本机实测：52 个在册工作区中 **24 个的可见(active 非置顶)任务数为 0**，但注册表仍报 `session_count > 0` | 用户可能看到「未启动 / 已有 10 个会话」，点开后列表却是空的（那些会话全被归档了）。**R2 §3 第 3 条已独立指出同一件事**，本报告从注册表枚举 SQL 侧给出了根因                                                                                                                           |
| C   | **「启动失败」的原因恒为兜底文案**                          | `runtimeFailureReason` 全仓无生产调用方（见 §6 命令）                                                                                                                                                                                                                                                                                                                                                     | §3.2 的「失败有原因」未兑现                                                                                                                                                                                                                                                           |
| D   | **§3.2 表格第 2 行与实现不一致（文档缺陷）**                | 文档 65 行说「无任何会话、runtime 未启动 → 显示**「暂无任务」**并标注「未启动」」；实现是 `TaskList.tsx:461` 命中未启动分支 ⇒ 渲染 `WorkspaceRuntimeNotice`（文案「还没有会话；打开后可新建任务」+「打开并启动」），**不会**出现「暂无任务」                                                                                                                                                              | 无用户可见损害（实现比文档更诚实），但文档不可信；按 AGENTS.md「判据：让读者做错决定即缺陷」应改文档                                                                                                                                                                                  |
| E   | **§7 章节缺失 + 悬空引用**                                  | `workspace-registry.md` 标题只有 §1-6、§8、§9；`packages/ui/src/hooks/useWorkspaceRegistry.ts:12` 引用「§7.3」                                                                                                                                                                                                                                                                                            | 文档缺陷                                                                                                                                                                                                                                                                              |
| F   | **文档 §5 护栏④只覆盖「列出不物化」，未覆盖「打开不物化」** | `packages/ui/test/workspaceRegistryWiring.test.ts:166-186` 断言的是三个 hook 源文件不得出现 `addTab(`/`startDraft` 等；而 `App.tsx:712-800` 不在其列                                                                                                                                                                                                                                                      | R2 已判为缺陷；本报告独立复核成立                                                                                                                                                                                                                                                     |

### 5.3 文档 §6「未测」里与本次问题直接相关的两条

- **手机尺寸下「未启动 → 点开 → 加载 → 载入」与「启动失败 → 原因 + 重试」两条端到端路径未做**（`workspace-registry.md:111`；`.reverse/40-remote-control/E2E-MOBILE-WEB.md:105` 亦如实声明）。现有护栏是**进程内/源码级断言**，不等价于真浏览器证据。
- **§6「待产品决定」**：默认视图 30 天窗口的取值与「显示全部」的交互形态（分页 vs 滚动加载）；**桌面端是否也切到同一注册表口径**（不切则两端可见集合口径不同）。后者与用户的观感直接相关：手机端 23 条补列行全部是「路径标题 + 未启动」，桌面端只有 1 条。

---

## 6. 我的判断：这是合理设计 / 需要改进 / 需要重新讨论

### 6.1 判定

**「未启动」这个状态本身：合理设计，应保留。**
它精确命名了一个真实且不可避免的事实（runtime 没起 ≠ 会话丢了），有成文禁止项、验收判据与四条会变红的护栏。撤掉它只会退回「列表项看起来像空列表」的老问题。文档 §3.1/§3.2/§8.6 的取舍（宁可显示未启动，也不假装已就绪）是正确的，**不建议推翻**。

**但它的「呈现方式」需要改进，且当前有一个必须重谈的产品缺口。**
用户的不适来自三处叠加，且都不是「未启动」这个概念本身的错：

1. **徽标密度**：首屏 28/29 行都带「未启动」（M1-CRITERIA 实测）。一个恒亮、几乎人人有份的徽标**不携带信息**，只会变成噪音——这正是用户说「我们的会话每个都标注未启动」的原因。徽标的**信息量**应该来自「相对基线」（只有异常的行才标），而不是「绝对状态」。
2. **缺口的 A + B 叠加**：补列行既看不到会话标题（A），报的会话数又可能包含归档（B），于是「未启动 / 已有 N 个会话」这句话**既不可信也不可操作**。这是文档 §3.2 想避免的「信息丢失」的另一种形态——不是丢了「有没有会话」，而是丢了「是哪些会话」。
3. **缺口的 F（R2 的结论）**：点开一次就把补列行物化成 tab 并永久写进设置，与 §2.3「枚举只有一处」的设计意图冲突，且护栏没覆盖。

### 6.2 2-3 个可选取向（供决策，含代价）

| 取向                                                         | 做法                                                                                                                                                                                                                                             | 代价 / 风险                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **① 把「未启动」从「状态徽标」改成「按需提示」**（推荐先做） | 行上不再常驻徽标；仅在**展开该行**时给出 `WorkspaceRuntimeNotice`（已有实现），或把徽标降级为 hover/title。列表层的「未启动」信息改由**分组**承载（「已打开」/「未打开（N）」）                                                                  | 改动集中在 `WorkspaceSidebarItem.tsx:792` 与 `WorkspaceRuntimeBadge`；但**与 §3.2 禁止项 ③ 有张力**：不显示徽标时，用户可能又把折叠行误读成空列表。需同步补一条断言：**展开未启动行必须出现 notice**（现状已有），并明确「折叠态不承诺状态」。属产品取舍，须先对齐                                                     |
| **② 让「未启动」行真的有内容可看**（补齐缺口 A + B）         | ① 让注册表补列行也走 `useWorkspaceTaskLists`（把 `workspaceTabs` 从 `projectWorkspaceTabs` 扩到「含派生行的只读 scope 列表」），从而渲染持久层会话标题；② 把注册表 `sessionCount` 拆成「可见会话数」与「含归档总数」，或至少与 timeline 口径对齐 | ① 是**结构性改动**：`useWorkspaceTaskLists` 的 scope 集合目前由 tab store 派生，扩到派生行会牵动 membership 缓存键、分页、乐观更新与多 endpoint 分片，风险中等偏高，需先做架构对齐；② 只改枚举 SQL + 一处文案，成本低，但会让「只有归档任务的 workspace」在注册表里显示为 0 会话——需确认这是否又退回「会话丢了」的观感 |
| **③ 修掉点击物化（R2 的取向 D）**                            | 「打开补列行」不再 `addTab`：引入「非持久 tab」（`registry:` 前缀的临时 tab，不进 `lastWorkspaceSession`），或把「打开」与「固定到本客户端」拆成两个显式动作                                                                                     | 唯一能兑现 §2.3 意图的做法；代价是 `tabStore`/`useTabPersistence` 引入新状态位 + 序列化过滤 + 重启恢复语义，涉及状态所有者边界，需先对齐。护栏可写成纯函数断言（点击后 `lastWorkspaceSession` 逐字不变），成本低                                                                                                       |

**建议顺序：③ → ②(②-b 先行) → ①。** 理由：③ 是**与既有文档意图冲突**的那一条（按 AGENTS.md「文档与实现不一致即缺陷」），优先级最高且护栏成本最低；②-b（口径对齐）改动最小、直接消除「说了 N 个会话点开是空的」这种**可被判为错误信息**的展示；②-a（补列行渲染标题）价值最大但风险最高，应在 ③ 落地、架构边界明确后再做；① 是纯呈现取舍，需要用户拍板「折叠行到底该不该带状态标识」，建议放在最后。

### 6.3 待验证假设（如实声明，未实测）

1. **用户是在哪个客户端看到「每个都标注未启动」**：本机桌面实测只有 1 条补列行（R2 报告 §2.3），因此「每个」更可能是**手机 Web / 新客户端**（23 条补列行全带徽标）或**桌面点开「显示全部」后**。我**没有**在运行中的 Electron/Web 上做徽标计数实测。
2. **§5.2 缺口 A 的用户可见性**：结论是**源码级已确认**（`taskItems` 恒为空数组），但**未做真浏览器截图**验证「用户确实看不到会话标题」。同时这与 `.reverse/40-remote-control/E2E-MOBILE-WEB.md:15` 的记载矛盾——需要重跑一次手机端 E2E 才能定论是文档陈旧还是我读漏了一条渲染路径。
3. **徽标是否会在某些时序下抖动**（`starting ↔ not-started`）：M1-CRITERIA §1 已把该过渡态列为允许并解释；`TaskList.tsx:35-37` 的 `idle → starting` 映射（`useWorkspaceRuntimeStates.ts:47`）在 store 刚创建、首次 subscribe 尚未落定时会短暂显示「启动中」而非「未启动」——该窗口的实际时长未测。
4. **缺口 B 的实际影响面**：本机 52 个在册工作区中 24 个「可见任务数为 0」，但**其中有多少会在 UI 上显示为「已有 N 个会话」取决于它们是否进入默认视图（23 条）**，我没有逐条比对这 23 条与那 24 条的交集。

---

## 7. 附录：本报告用到的复核命令（全部只读）

```bash
# ① 未启动态的护栏测试（7 pass / 0 fail，实测）
cd packages/ui && node --import tsx --test test/workspaceRegistryWiring.test.ts

# ② dormant 的全部产生点与消费点
grep -rn 'dormant' --include='*.ts' --include='*.tsx' packages apps | grep -v node_modules | grep -v '/dist/'

# ③ 稳定错误码的判定链
grep -rn 'ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE' --include='*.ts' packages | grep -v '/dist/'

# ④ existing-only 的全部调用点
grep -rn 'existing-only' --include='*.ts' --include='*.tsx' packages apps | grep -v node_modules | grep -v '/dist/'

# ⑤ 缺口 C：runtimeFailureReason 是否有生产调用方（无输出 ⇒ 没有）
grep -rn 'runtimeFailureReason' --include='*.ts' --include='*.tsx' packages | grep -v node_modules | grep -v '/dist/'

# ⑥ 缺口 A：补列行的 taskItems 恒为空数组
grep -n 'taskItems=' packages/ui/src/WorkspaceSidebar.tsx

# ⑦ 缺口 B：注册表枚举 SQL 不过滤 archived
sed -n '124,142p' packages/services/src/session/workspaceRegistryRepo.ts
sed -n '125,140p' packages/shared/src/zcode-protocol-v4/controller.ts
```
