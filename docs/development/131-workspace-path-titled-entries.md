# 侧栏「以目录路径为标题的条目」与「点击后消失」：机制、判定与取向

> 调查任务 R2（只读调查，未改任何源码）。结论分「已确认」（源码级或真实数据复现）与「待验证假设」。
> 时间快照：2026-09-27，仓库 `6725e9c`，本机运行的是 `/opt/ZCode-CE` 的 `3.14.3-ce.3.fix.1`。

## 0. 读了什么 / 结论是否与既有文档一致

| 文档                                                     | 结论                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/development/workspace-registry.md`（全文 142 行）  | **一致**（枚举两源、默认视图 30 天、补列行不物化、远端条目排除、路径原样展示、§6「只有会话没有任务行的工作区尚不在册」都实测对上）。**但发现护栏覆盖缺口**：§5 的护栏④只钉住「**列出**不改变设置里的工作区列表」，没有钉住「**打开（点击）**不改变」—— 实测点击会物化并写回设置，见 §3(d)。 |
| 根 `AGENTS.md`                                           | 一致（workspaceIdentity 口径、状态所有者、UI 不直接调 Repo）。                                                                                                                                                                                                                              |
| `.reverse/40-remote-control/E2E-MOBILE-WEB.md`（106 行） | **一致**：手机 Web 端侧栏确实以「注册表补列行 + 路径标题 + 未启动态」呈现（§2 原文），本文给出该现象的代码级链路。                                                                                                                                                                          |
| `.reverse/42-mobile-ux/STAGE2-P0.md`                     | 补充一条与「条目移出视野」相关的既有行为：窄屏（<768px）**首次进入自动收起侧栏**（`WorkspaceShellLayout.tsx:590-616`），与桌面场景无关，但会影响手机端观感。                                                                                                                                |
| `docs/development/` 其余                                 | 未找到以「路径标题条目」为主题的其他文档；`backlog.md` 无相关条目。                                                                                                                                                                                                                         |

## 1. 结论（两个现象各一段）

**现象 1（为什么出现以目录路径为标题的条目）**：侧栏那个列表是 **工作区行列表**（不是会话列表），它的数据源在 M1.4 之后是「本客户端 tab ∪ 服务端注册表」的**派生并集**（`packages/ui/src/WorkspaceSidebar.tsx:394-414`）。注册表条目里那些本客户端设置里没有的（`source === "registry"`）会以**补列行**渲染；补列行不是真 tab，只能借用同一套行渲染，而它的 `label` 被**显式赋成完整 `workspacePath`**（`packages/ui/src/hooks/workspaceSidebarRows.ts:113-127`，第 122 行 `label: row.workspacePath`）——因为注册表条目只有 key 与路径，没有任何用户可读标题。真正的会话标题走的是另一条链路（sessions-index summary / tasks-index 行 → `TaskList` 里的任务行），与这些行标题无关。

**现象 2（为什么点击后大概率消失）**：点击补列行会走「打开这个 workspace」的既有交互（`WorkspaceSidebarItem.tsx:301-330` → `onStartDraftInWorkspace` → `App.tsx:712-791`），而补列行**不是 tab**，于是 `activateTabByPath` 必然未命中、必然走 `addTab`（`App.tsx:758-767`）。`addTab` 把它**物化成真 tab**（`store/tabStore.ts:257-306`），下一帧 `buildWorkspaceSidebarRows` 的 `tabKeys` 就命中该 key，派生行随即被过滤掉（`hooks/workspaceSidebarRows.ts:68-71`）——同一条目从「注册表补列行」变成「tab 行」，**并且新 tab 被插到列表最前**（`tabStore.ts:293-296`），所以看起来是「原地消失」。这个物化还会被 `useTabPersistence` 写回设置里的 `lastWorkspaceSession`（`hooks/useTabPersistence.ts:90-104, 281-297`），因此是**永久**的：该路径此后不再以补列行出现。换句话说，**「消失」不是运行时/加载的结果，而是客户端把补列行物化成 tab 的副作用**。

## 2. 数据来源与标题生成链路

### 2.1 侧栏列表 = 工作区行列表（本客户端 tab ∪ 服务端注册表）

| 环节                                              | 落点                                                                                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册表 RPC（唯一枚举源，只读、不拉 runtime）      | `packages/services/src/session/workspaceRegistry.ts:56-78`；入口注册 `packages/services/src/node.ts:2534-2542`                                                                     |
| 条目来源（两源合并；**实际只有任务索引源**）      | `packages/services/src/session/taskIndexRepo.ts:1745-1759`（幂等回填 + 合并）；`workspaceRegistryRepo.ts:124-142`（`tasks` 表 distinct `workspace_key`，无 archived 过滤）         |
| 默认视图（30 天窗口 ∪ 置顶，服务端算）            | `packages/shared/src/workspace-registry.ts:75-85`                                                                                                                                  |
| 客户端消费（模块级缓存 + `useSyncExternalStore`） | `packages/ui/src/hooks/useWorkspaceRegistry.ts:82-154`                                                                                                                             |
| 行派生（tab 行 + 注册表补列行）                   | `packages/ui/src/hooks/workspaceSidebarRows.ts:43-85`                                                                                                                              |
| 渲染                                              | `packages/ui/src/WorkspaceSidebar.tsx:397-414`（rows/派生行/隐藏计数）、`1637-1678`（补列行渲染，`taskItems` 恒为空数组，1653 行）、`1706-1728`（「显示全部工作区（还有 N 个）」） |
| 补列行不是 tab                                    | `workspaceSidebarRows.ts:113-127`（`id: \`registry:\${workspaceKey}\``，注释明说「不得进入 tab store」）                                                                           |

会话行（任务行）是**另一条链路**：`packages/ui/src/v4/buildTaskListResultFromSessions.ts:170-196`（tasks-index 为左表 + sessions-index 补 activity），标题来自 `packages/ui/src/v4/mapSessionSummaryToTaskMeta.ts:49-54`，兜底文案是「无标题」；补列行没有会话，所以永远不产生任务行。

### 2.2 标题为什么落到「显示路径」

`buildWorkspaceSidebarRows` 的补列分支只把 `workspacePath` 带出来（`workspaceSidebarRows.ts:72-83`），`buildRegistryRowRenderTab` 再把它当 `label`：

```ts
// packages/ui/src/hooks/workspaceSidebarRows.ts:119-126
return {
  id: `registry:${row.workspaceKey}`,
  kind: "workspace",
  label: row.workspacePath, // ← 兜底即「完整路径」
  workspacePath: row.workspacePath,
  workspacePurpose: "project",
} as WorkspaceTabState;
```

对比真 tab：`createWorkspaceTab` 的 label 是 `labelFromPath()`（`store/tabStore.ts:143-147, 149-165`，取 basename）。渲染侧统一走 `formatRemoteWorkspaceDisplayLabel(tab.label, ...)`（`WorkspaceSidebarItem.tsx:251, 762-764`），它只对 SSH 目标加后缀，不做路径→名称的转换 ⇒ **补列行必然以完整路径显示**。这与 `workspace-registry.md` §9.5「路径展示口径：原样展示」一致（是已记录的产品选择，不是实现事故）。

### 2.3 本机真实数据复现（可执行）

```bash
# 注册表现状（只读打开，勿写）
node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.zcode/v2/tasks-index.sqlite",{readOnly:true});
const r=db.prepare("SELECT COUNT(*) c FROM workspace_registry").get();
const cut=Date.now()-30*864e5;
const d=db.prepare("SELECT COUNT(*) c FROM workspace_registry WHERE last_activity_at>=?").get(cut);
console.log("registry total",r.c,"defaultView(30d)",d.c);'
```

实测（本机 `~/.zcode/v2/tasks-index.sqlite`）：注册表 **52** 条、默认视图 **23** 条；设置 `lastWorkspaceSession` **38** 条（37 project + 1 conversation）。
用**真实源文件**跑派生逻辑（`node_modules/.bin/tsx` 直接 import `packages/ui/src/hooks/workspaceSidebarRows.ts`）：

| 场景                                                                                                                                       | tab 行 | 注册表补列行（= 路径标题行）                                |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------- |
| 桌面（37 个 project tab）                                                                                                                  | 37     | **1**：`/home/sixiao/.zcode/workspace/default`（20 个会话） |
| 同上，但把 conversation tab 也一并传进 rows（对照实验：证明那 1 条补列行**只是因为 App 把 conversation tab 排除在 project 行之外**才出现） | 38     | 0                                                           |
| 空设置的客户端（web/手机远控/新设备）                                                                                                      | 0      | **23**（全部默认视图条目）                                  |

「显示全部」时另有 `countHiddenRegistryRows = 18` 条会被列成路径标题。复现脚本（真实数据，只读）：

```bash
cd packages/ui && ../../node_modules/.bin/tsx /tmp/probe.ts   # probe.ts 见本报告 §7 附录
```

⇒ **用户举的第一个例子 `/home/sixiao/.zcode/wor…` 正是本机桌面唯一的那条补列行**（`/home/sixiao/.zcode/workspace/default`，它是 conversation backing workspace，但注册表与 `tabKeys` 都按 `identity‖path` 口径比较，而它在本客户端是 conversation tab，故仍被判为「设置里没有」）。
⇒ 而「**一堆**路径标题」在本机桌面（38 条设置）下**只可能是两条路径**：① 用户点了「显示全部工作区（还有 18 个）」；② 用户看的是**另一个客户端**（手机 Web / 另一台设备 / 新窗口），它的 `lastWorkspaceSession` 覆盖不到注册表默认视图 ⇒ 23 条全以路径标题出现。`.reverse/40-remote-control/E2E-MOBILE-WEB.md` §2 已记录手机端就是这样。**具体是哪一种属于待验证假设，见 §6。**

## 3. 「点击后消失」逐候选判定

点击链路（已确认）：补列行的整行是 `CollapsibleTrigger`（`WorkspaceSidebarItem.tsx:834-865`，无 `sortableBindings`），展开回调 `handleWorkspaceOpenChange`（`301-330`）在 `nextOpen && !isExpanded` 时调 `onStartDraftInWorkspace`（316 行）→ `App.tsx:712` `handleStartDraftInWorkspace` → `activateTabByPath` 未命中 → `addTab`（758-767）→ `store.startDraft`（773）。

| 候选                                                     | 判定                                                                                 | 证据                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) 点击启动 runtime ⇒ 条目被真实会话替换**            | **排除（作为「被会话替换」）**；但「条目换成 tab 行」成立，且**与 runtime 启动无关** | 补列行**永不写入 tab store**（`workspaceSidebarRows.ts:113-127` 注释 + 护栏 `packages/ui/test/workspaceRegistryWiring.test.ts`），`buildWorkspaceSidebarRows` 只看 `tabKeys`（`48-51, 68-71`），与 runtime/会话数据无关；`TaskList` 的未启动态只改内容不改行存在性。runtime 启动是**并行发生**的副作用（`E2E-MOBILE-WEB.md` §3 已证「打开并启动」会拉起 runtime），不是条目消失的原因。 |
| **(b) 加载失败 / 无任务行 ⇒ 条目被过滤**                 | **排除**                                                                             | 补列行的 `taskItems` 恒为 `EMPTY_WORKSPACE_TASK_ITEMS`（`WorkspaceSidebar.tsx:1653`），列表构建里没有任何按任务行的过滤（`workspaceSidebarRows.ts:68-83` 只有 `tabKeys` 与 identity 两个条件）。加载失败只渲染 `WorkspaceRuntimeNotice` 的 failed 态（`TaskList.tsx:459-472` → `WorkspaceRuntimeNotice.tsx:48-84`），行仍在。                                                           |
| **(c) 去重/排序导致重排、条目移出可视区**                | **部分命中（次要，只改位置不改存在性）**                                             | 派生行按 `lastActivityAt` 降序**追加在 tab 行之后**（`workspaceSidebarRows.ts:71`）；而点击物化出的新 tab 被**插到 tabs 最前**（`tabStore.ts:293-296`）。同一条目因此从列表尾部跳到列表顶部；列表已滚动时视口内容整体位移，产生「不见了」的观感。                                                                                                                                       |
| **(d) 点击后写入客户端设置，改变该客户端的显示偏好集合** | **命中（持久化后果）**；**即时原因是 tab store 物化，不是设置写入**                  | ① `addTab` 立即改 tab store（`tabStore.ts:257-306`）⇒ 派生行当帧消失；② `useTabPersistence` 的 store 订阅在 300ms 防抖后把 `buildDefaultPersistPatch(state)` 写回设置（`hooks/useTabPersistence.ts:281-297`），patch 就是 `lastWorkspaceSession = workspaceTabs.map(...)`（`90-104`）⇒ 该路径**永久**进入设置，跨重启不再作为补列行出现。                                               |

**「大概率」而不是「每次」的原因**：若该路径在本客户端设置里**已有** tab（`activateTabByPath` 命中，`tabStore.ts:544-572`），它本来就不是补列行，点击只是激活——不存在「消失」。所以观感是「大部分点击后消失」。

**与既有护栏的关系（这是本轮最有价值的一条）**：`workspace-registry.md` §5 护栏④「补列行不得改变设置里的工作区列表」由 `packages/ui/test/workspaceRegistryWiring.test.ts` 承担，实际覆盖两件事：① 纯函数断言 `buildWorkspaceSidebarRows` 的派生行 `tab === null`（第 76-86 行，注释原文「列出注册表工作区不得改变设置里的工作区列表」）；② 源码扫描，禁止 `useWorkspaceRegistry.ts` / `useWorkspaceRuntimeStates.ts` / `workspaceSidebarRows.ts` 三个文件里出现 `addTab(` / `ensureWorkspaceTab` / `startDraft` 等字样（第 166-186 行）。两条都只约束「**列出**」这条路径；**点击路径**位于 `WorkspaceSidebarItem.tsx` → `WorkspaceSidebar.tsx` → `App.tsx`（经 `onStartDraftInWorkspace` 回调，是刻意的间接层），**不在扫描范围内、也没有任何断言覆盖**。于是设计意图（§2.3「枚举只有一处，客户端设置只影响怎么显示」）在**点击路径**上被绕过：一次点击就把「注册表条目」变成「第二份真相源里的一条」，而且不可逆（补列行故意不提供「移除」入口，`WorkspaceSidebarItem.tsx:960-982`）。这不是文档写错，而是**护栏覆盖不全**（文档如实描述了目标，实现只保证了一半）。

## 4. 这是设计问题还是缺陷

**判定：主要是设计问题（取向未定），其中包含一条应算缺陷的护栏缺口。**

依据（对照 `workspace-registry.md` 的设计意图）：

1. **设计问题**：注册表枚举的**目标**是「能全看、不默认全看」（§3），而「全看」的实现方式就是把这些从未在界面出现过的工作区**列出来**。它们的条目里**没有任何用户可读标题**（注册表 schema 只有 `workspaceKey/workspacePath/identity/firstStart/lastActivity/sessionCount/sources`，`packages/shared/src/workspace-registry.ts:20-30`），所以「以路径为标题」是**该设计的必然结果**，文档 §9.5 也已把它记为产品选择（原样展示、不脱敏）。⇒ 现象 1 **不是缺陷**，是「枚举扩容」与「条目无标题」之间的产品空缺；缺的是**呈现取向**（要不要分组/标注来源/是否只显示有会话的），不是代码错误。
2. **缺陷成分**：`workspace-registry.md` §2.3 明确「客户端设置**不再**充当枚举来源，也不参与过滤」，§5 护栏④也要求「补列行不得改变设置里的工作区列表」。但点击一条补列行会通过 `addTab` + `useTabPersistence` **把它写进设置**，且不可逆（没有移除入口：补列行故意隐藏「移除」菜单项，`WorkspaceSidebarItem.tsx:960-982`）。这与文档意图**不一致**，且既有护栏只覆盖「列出」不覆盖「点击」（见 §3 末尾）⇒ 按「文档与实现不一致即缺陷」的口径，这一条应判缺陷（或至少是需要立即补齐的护栏 + 明确取舍）。
3. **另一条与现象 1 耦合的实现不一致（待确认产品口径）**：注册表条目 `sessionCount` 含**归档**任务，而本机 `/home/sixiao/.zcode/workspace/default` 显示 20 个会话；用户点开它看到的是「对话」区的真实会话。若产品意图是「补列行展示真实会话」，则「无用户可读标题 + 完整路径」的组合在**多客户端**场景下会被放大（手机端一屏 23 条路径），这正是用户描述的现象。

## 5. 若为设计问题：可选产品取向与代价

| 取向                                    | 做法                                                                                                                                                                                                       | 代价 / 风险                                                                                                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. 只显示「有会话」的工作区**         | 补列前过滤 `sessionCount > 0`（并可加阈值，如「≥1 个非归档会话」）                                                                                                                                         | 实现最小（一处 filter）；但**与 §3「能全看」冲突**：只有归档任务/零任务的工作区会从列表消失，回到「会话是不是丢了」的老问题。且本机 52 条里几乎都有会话（仅少数为 0），**收益有限**。                                                            |
| **B. 分组显示（有会话 / 仅数据）**      | 侧栏把补列行分成两组：「最近用过（有会话）」与「仅有数据（N）」折叠在「显示全部」下                                                                                                                        | 观感最好，且保留「能全看」；代价是要动 `WorkspaceSidebar` 的分组结构与 i18n（新文案 2-4 条），并新增分组不变量断言；同时要决定分组是否参与既有拖拽/排序语义（补列行本就不可拖拽，影响可控）。                                                    |
| **C. 保留但标注来源**                   | 给补列行加来源徽标（「来自数据，未在本机打开」）并用**路径的可读化展示**（`~/…` 缩写 + 尾部两段 + `title` 全路径）替代整条路径                                                                             | 改动最小（渲染层），可读性显著提升；但「点击后消失」这条**仍未解决**（取向 C 不动物化行为），只解决现象 1 的一半。                                                                                                                               |
| **D. 修掉物化（无论选哪种取向都应做）** | 让「打开补列行」不再 `addTab`：或标记为 `registry:` 前缀的**临时 tab**（不进 `lastWorkspaceSession`，见 `buildPersistPatch` 过滤），或把「打开」建模成显式的「固定到本客户端」动作（用户显式操作才写设置） | 是唯一能兑现 §2.3 意图的做法；代价是要在 `tabStore`/`useTabPersistence` 引入「非持久 tab」概念（新状态位 + 序列化过滤 + 重启恢复语义），并补一条护栏：**点击补列行后 `lastWorkspaceSession` 逐字不变**。风险中等，涉及状态所有者边界，需先对齐。 |

**推荐：D + C（先 D 后 C）**，把 B 作为后续可选。
理由：① 用户实际痛点有两个（看不懂的路径标题、点了就没了），C 只治第一个，D 才治第二个，而第二个是**与文档意图冲突**的那一条，优先级最高；② D 的护栏可写成纯函数断言（点击后设置不变），成本低、回归可见；③ C 是渲染层小改动，可与 D 同批交付；④ B 的价值在手机端最大（23 条路径），但需要新的分组语义与 i18n，建议等 A/D 落地、确认真实使用频次后再做。
**不建议选 A**：它以牺牲「能全看」为代价换取列表整洁，正好退回本能力要修掉的那个问题。

## 6. 未验证部分（如实）

1. **用户当时在哪个客户端看到「一堆」路径标题**：本机桌面（38 条设置 tab）实测只有 1 条补列行 + 18 条隐藏；「一堆」需要「点了显示全部」或「另一台/另一个客户端设置覆盖不到默认视图」。**未在真实 web/手机客户端上复现计数**，也未拿到用户当时的截图/客户端信息。
2. **点击后消失的真机复现**：本文是**代码级 + 真实数据派生**的结论（`addTab` → `tabKeys` 命中 → 派生行消失），**没有**在运行中的 Electron/Web 上做「点击前后 DOM 行数比对」。建议的验收方式：`data-testid=workspace-registry-show-all` 展开 → 记录 `TID_WORKSPACE_ITEM` 数量 → 点击一条 `/home/sixiao/.zcode/workspace/default` → 断言该 testid 行数不变、而 `lastWorkspaceSession` **逐字不变**（当前会变）。
3. **设置写入的时序**：`useTabPersistence` 的 300ms 防抖 + `initialRestoreFullyCompletedRef` 门禁（`hooks/useTabPersistence.ts:281-286`）意味着「启动恢复未完成时的点击」可能不写设置；该边界未实测。
4. **注册表 `sessionCount` 的口径**（含归档、来自 `tasks` 表）与补列行 `WorkspaceRuntimeNotice` 里「N 个会话」的文案是否会让用户误解（点开后看到的是「对话」区的真实会话），未做可用性验证。
5. **桌面端是否也切到注册表口径**（`workspace-registry.md` §6「待产品决定」）未决，因此桌面/手机两端「可见集合」的口径差异未验证。
6. **多客户端并发**：两台客户端同时点击同一补列行会各自写自己的设置（设置是客户端侧偏好），是否会产生跨端观感差异，未测。

## 7. 附录：派生复现脚本（只读，临时文件用后即删）

```ts
// /tmp/probe.ts —— 用真实源文件 + 真实库/设置复现侧栏行派生
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import {
  buildWorkspaceSidebarRows,
  countHiddenRegistryRows,
} from "/home/sixiao/aicode/fix/ZCode-CE/packages/ui/src/hooks/workspaceSidebarRows.ts";
const db = new DatabaseSync(process.env.HOME + "/.zcode/v2/tasks-index.sqlite", { readOnly: true });
const entries: any[] = (
  db
    .prepare(
      "SELECT workspace_key, workspace_path, workspace_identity, first_seen_at, last_activity_at, session_count, sources FROM workspace_registry ORDER BY last_activity_at DESC",
    )
    .all() as any[]
).map((r) => ({
  workspaceKey: r.workspace_key,
  workspacePath: r.workspace_path,
  firstSeenAt: r.first_seen_at,
  lastActivityAt: r.last_activity_at,
  sessionCount: r.session_count,
  sources: JSON.parse(r.sources),
}));
const s = JSON.parse(fs.readFileSync(process.env.HOME + "/.zcode/v2/setting.json", "utf8"));
const allTabs = (s.lastWorkspaceSession ?? []).map((e: any, i: number) => ({
  id: "t" + i,
  kind: "workspace",
  workspacePath: e.workspacePath,
  label: String(e.workspacePath).replace(/\\/g, "/").split("/").filter(Boolean).pop(),
  workspacePurpose: e.workspacePurpose,
}));
const projectTabs = allTabs.filter((t: any) => t.workspacePurpose !== "conversation");
const dv = entries.filter((e) => e.lastActivityAt >= Date.now() - 30 * 864e5);
for (const [name, tabs] of [
  ["desktop", projectTabs],
  ["fresh-client", []],
] as const) {
  const rows = buildWorkspaceSidebarRows({
    tabs: tabs as any,
    registryEntries: dv,
    showAll: false,
  });
  const derived = rows.filter((r) => r.source === "registry");
  console.log(
    name,
    "rows=",
    rows.length,
    "derived=",
    derived.length,
    derived.map((d) => d.workspacePath),
  );
}
console.log("hidden(显示全部) =", countHiddenRegistryRows({ tabs: projectTabs as any, entries }));
```

运行：`cd packages/ui && ../../node_modules/.bin/tsx /tmp/probe.ts`
