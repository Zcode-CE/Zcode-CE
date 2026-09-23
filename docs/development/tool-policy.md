# 工具与权限：按资源/工具精细启停（spec）

> 状态：**方向已由 Lead 裁决通过**（2026-09-23，见任务板 task-3）。
> 本文是「先更新 spec 再实现」的落点，先于代码。
> 实现证据与实测命令见 `.reverse/39-permgran/PERMISSION-GRANULARITY-2.md`。
> 范围：**MCP 子工具级启停**（以下简称「工具启停」）。插件整包启停、危险命令清单（`.reverse/33-tool-policy/SPEC.md`）不变。

---

## 0. 这份 spec 回答什么

README「后续计划」记的「工具精细化管理」当时未提供：**插件与 MCP 只能整包启停，无法单独控制其中某个命令或工具**。
本文定义**第一刀**：让一个 MCP server 提供的**单个工具**可以关闭，并且关闭后它**真的不再被提供、也不再执行**。

本文**不**定义：插件内单个内置工具的启停（见 §7 开放项）、MCP 设置页的工具开关控件（见 §6.2）。

---

## 1. 现状取证（file:line，改动前）

### 1.1 「整包启停」今天由谁实现

| 资源       | 状态载体                                               | 落点                                                                 | 消费者                                                                                                               |
| ---------- | ------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 插件       | `plugins.enabledPlugins: Record<pluginId, boolean>`    | `apps/zcode-cli/packages/adapters/src/config/schema.ts:166`          | 只从 enabled 分支解析组件 `adapters/src/plugins/index.ts:182-209`；插件 MCP 只在启用时进入 `resolvePluginMcpServers` |
| MCP server | server 配置对象内的 `enabled`（`McpServerConfigBase`） | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts:16-23` | 跳过连接：`adapters/src/mcp/index.ts:320`、`adapters/src/mcp/pool.ts:315`                                            |

**MCP server 配置的持久化位置（唯一）**：`~/.zcode/cli/config.json` 的 `mcp.servers`，或 `~/.agents/mcp.json` 的 `mcpServers`（`packages/services/src/mcp-sync/mcpSyncService.ts:43-59`）。两处都是**同一个 server 配置对象**，`enabled` 就写在该对象内（`:386-413`），**不是**另一个键或另一张表。

### 1.2 工具清单从哪来

- 注册表：`apps/zcode-cli/packages/core/src/tool/registry.ts:96-129`（`list()` / `toContracts()`）。
- MCP 工具投影：`apps/zcode-cli/packages/core/src/mcp/index.ts:60-100` `registerMcpTools` 把 `McpToolDescriptor` 变成 `ToolEntry`。
  **它今天已经能按工具过滤**：`allowedTools`（白名单）与 `disallowedTools`（黑名单），来自 session 参数的 `toolAllowlist` / `toolDisallowlist`（`core/src/runtime/methods/mcp.ts:138-145`）。
- 权限系统读声明：`McpToolEntry.permission`（`core/src/mcp/index.ts:189-197`）。

### 1.3 一个必须记录的缺口：`toolDisallowlist` ≠ 关闭工具

`toolDisallowlist` **只影响「这一轮发给模型的工具表」**（`core/src/runtime/methods/turn-loop.ts:110-118` 的 `filter`），
**不影响注册**：工具仍在 `ToolRegistry` 里。模型如果自己发出该工具名（越狱、prompt injection、旧对话历史、或另一次 session 的历史），
`core/src/tool/executor/call-runner.ts:99` 仍会 `registry.get(name)` 命中并**照常执行**（走 hook → 权限 → handler）。

⇒ **「不发给模型」与「不许执行」是两件事**。把 `toolDisallowlist` 当成「关闭工具」是误读；它是本轮可见性开关。
本 spec 的 `disabledTools` 走的是**注册面**，语义是后者。二者关系见 §4.4。

---

## 2. 产品规则

### 2.1 定义

> **一个 MCP 工具被关闭，当且仅当它所属 server 的配置对象里 `disabledTools` 精确包含它的原始工具名。**

- **原始工具名** = MCP server 自己 `tools/list` 返回的 `name`（即 `McpToolDescriptor.toolName`），例：`get_issue`。
  不是模型可见名（`mcp__github__get_issue`）——同一个 server 内原始名唯一，而模型可见名会随 server 名变化。
- **作用域 = 单个 server**：`mcp.servers["github"].disabledTools` 只影响 server `github`。不同 server 的同名工具互不影响。

### 2.2 行为表

| 状态                          | 模型能看到吗                                   | 调用能执行吗              | 说明                                                   |
| ----------------------------- | ---------------------------------------------- | ------------------------- | ------------------------------------------------------ |
| 未列在 `disabledTools`        | 能（不进 provider 工具表的唯一原因是另有过滤） | 能                        | 与今天完全一致                                         |
| 列在 `disabledTools`          | **不能**                                       | **不能** ⇒ `ToolNotFound` | 见 §3.3 的失败语义                                     |
| server `enabled: false`       | 不能（该 server 全部工具）                     | 不能                      | 整包关，`disabledTools` 无意义（不重复生效、也不冲突） |
| server 未配置 `disabledTools` | 能                                             | 能                        | 缺省 = 不关闭任何工具，**老配置零迁移**                |

### 2.3 生效时机

**新建会话生效**（`registerMcpTools` 只在 session 启动时调用一次：`core/src/runtime/methods/mcp.ts:122-168`）。
这与既有 MCP 配置（增删 server、`enabled` 整包开关）**语义一致**，与「工具与权限」页的裁决 1（B 方案）也一致：**不在运行中的会话里换工具面**。
理由不是实现偷懒，而是**工具面是 provider 请求前缀缓存与模型契约的一部分**：中途改动会让同一会话里的工具声明前后不一致。

---

## 3. 状态所有者、接口与失败语义

### 3.1 唯一真相源

| 事实                   | 唯一所有者                                                                         | 消费者                          |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------- |
| 单个工具是否对模型可用 | **MCP server 配置对象的 `disabledTools`**（与 `enabled` 同对象、同文件、同写入者） | 仅 `registerMcpTools`（注册面） |
| 生效清单（进程内）     | session `runtimeConfig.mcp.servers[serverName].disabledTools`                      | 同上                            |

**明确不新增**：全局工具 deny 列表、`AppSettings` 里的第二份清单、独立 sqlite 表。
任何「再记一份」都会让「UI 显示的状态」与「真正生效的状态」有两条真相源 —— 这正是本仓库最在意的失败模式。

`toolDisallowlist`（session/turn 级）**不是**这只字段的替代品，也不与它合并（§1.3、§4.4）。

### 3.2 接口

```ts
// contracts（McpServerConfigBase，三种 transport 共有）
disabledTools?: string[];
```

- **归一化与上限各只有一份实现**：唯一所有者是 `packages/shared/src/mcpDisabledTools.ts`
  （`@zcode/shared/mcpDisabledTools` 子路径导出的叶子模块，**不 import 任何本仓模块**）。
  它同时导出 `MCP_SERVER_MAX_DISABLED_TOOLS`（200）与 `normalizeMcpDisabledTools`（含三个诊断计数字段）。
- 各层**消费**同一份（而不是各写一份同值副本）：
  | 消费点 | 取用方式 |
  | --- | --- |
  | wire schema（`@zcode/shared/zcode-protocol`） | 直接 import 该常量 |
  | Agent DTO 投影（`@zcode/shared/mcp`） | 直接调该归一化函数（丢弃诊断计数） |
  | CLI 配置 schema / 插件 MCP 归一化 / 协议还原 | `@zcode/contracts` 的 `mcp.port` **重新导出**同名常量/类型/函数，既有调用点 import 路径不变 |
  依赖方向是单向的 `contracts → shared`，所以常量住在 shared、由 contracts 重导出；这条不变式有回归测试钉住（`core/test/mcpDisabledToolsSingleSource.test.ts` 断言两处拿到的是**同一个函数对象**，而不是同值副本）。
- 归一化行为：逐项 `trim()`、丢弃空串、去重、超上限截断（**不整条丢弃** --- 丢弃会让用户整个 MCP 不可用，代价远大于收益）；非数组视为未设置。
- 告警归 CLI 配置层：`invalidShape` / `droppedEntryCount` / `blankCount` / `truncatedCount` 由
  `adapters/src/config/schema.ts` 映射成 `mcp.servers.<name>.disabledTools` 路径下的诊断。
- **API 请求（协议 session/create）不是通道**：工具启停只从**配置**读。原因见 §3.4。

### 3.3 失败语义（fail closed）

被关闭的工具在 `registerMcpTools` 的循环里被 **`continue` 掉，从不进注册表**。由此：

1. 不进 `toContracts()` ⇒ 模型**看不到**（`registry.ts:104-129` 从注册表投影）；
2. 不进 `list()` ⇒ `/mcp` 一类的清单页也不展示（`core/src/runtime/methods/plugin-reference.ts:28-44` 以注册名求交）；
3. 模型仍然直呼时，`call-runner.ts:121-153` 的 `registry miss` 分支返回 `CoreErrorType.ToolNotFound`（`Tool not found: <name>`），**早于** PreToolUse hook、权限弹窗和 handler ⇒ **不会执行、不会弹窗、不会落规则**；
4. **没有静默降级**：不存在「关闭失败但照常执行」的分支。配置写错（非法项）时是**告警 + 该项不生效**，不是「整条配置被忽略的同时工具照旧可用」。

### 3.4 为什么不做成「协议参数」

协议 `session/create` 已经能带 `toolDenylist`。若把它当成工具启停的通道：

- 它**不持久化** —— 用户在设置页关掉一个工具，重启后又打开，没有任何地方记录「用户关过它」；
- 它会和 `mcp.servers[].disabledTools` 形成两个可写入口，谁生效取决于调用顺序；
- 它天然是 session 级而工具启停的资源归属是 **server**，粒度对不上。

⇒ 工具启停只从 server 配置读。`toolDenylist` 保持它既有的「本轮/本会话临时收窄」语义，不被复用（§1.3）。

---

## 4. 事件顺序与状态图

### 4.1 写入 → 生效（唯一路径）

```
用户/文件改 ~/.zcode/cli/config.json 的 mcp.servers[<s>].disabledTools
   │   （Desktop 设置页的 MCP 卡片也写同一个键；services/src/mcp-sync 是它的写盘实现）
   ▼
config 载入（adapters/src/config）── schema 校验 + 归一化（非法项告警，不丢弃 server）
   ▼
runtimeConfig.mcp.servers[<s>].disabledTools      ← 进程内冻结快照
   ▼
registerMcpTools(snapshot.tools)  ── 按 server 取 disabledTools，命中的 descriptor 直接 continue
   ▼
ToolRegistry（缺席 = 关闭）──► ① provider 工具表看不到  ② 直呼 ⇒ ToolNotFound
```

**顺序不变量**：`disabledTools` 的判定**先于** `allowedTools` / `disallowedTools` 判定（三者都是「收窄」，取并集才安全）。
**幂等**：同一份配置重复注册结果相同；`initializeMcp` 本身由 `mcpToolsRegistered` 保证只注册一次。

### 4.2 不做「超时掩盖」

本能力**不引入任何超时或轮询**：它是**纯函数式**的（配置 → 注册结果）。不存在「等 MCP 连上再决定要不要关」这类同步问题 ——
server 连不上时它的工具本来就不在快照里，也就无所谓关闭。

### 4.3 三种「收窄」的职责边界

| 机制                      | 所有者                       | 作用面                      | 直呼还能执行吗                      |
| ------------------------- | ---------------------------- | --------------------------- | ----------------------------------- |
| `disabledTools`（本能力） | **server 配置对象**（持久）  | 注册面：工具根本不进注册表  | **不能**（`ToolNotFound`）          |
| `toolDisallowlist`        | session/turn 参数（不持久）  | provider 请求边界：本轮不发 | **能**（§1.3）                      |
| 权限规则（allow/deny）    | sessionStore project ruleset | 执行前的授权判定            | 能执行到权限层，由规则决定放行/拒绝 |

三者叠加时**最严者胜**（`disabledTools` 在最上游）。

---

## 5. 验收场景

| #   | 场景                                           | 期望                                  | 判据（打到最终消费点）                       |
| --- | ---------------------------------------------- | ------------------------------------- | -------------------------------------------- |
| D1  | 关掉 `github.get_issue`                        | 注册表**没有**该名                    | `registry.list()` 不含；`toContracts()` 不含 |
| D2  | 直呼被关的工具                                 | `ToolNotFound`，handler **未执行**    | 执行结果 error + handler 调用计数为 0        |
| D3  | 同 server 未关的工具                           | 照常注册、照常执行                    | `registry.has()` + 执行结果                  |
| D4  | 另一 server 的同名工具                         | **不受影响**                          | 两个 server 同名 `search`，只关一个          |
| D5  | 条目写成模型可见名（`mcp__github__get_issue`） | **不生效**（契约是原始名）            | 该工具仍注册                                 |
| D6  | server `enabled: false` + 有 `disabledTools`   | 工具不可用（整包关），无异常          | 连接被跳过                                   |
| D7  | 同时命中 session `toolAllowlist`               | **仍关闭**（注册面权威）              | 该工具不在注册表                             |
| D8  | 老配置（无该键）                               | 行为不变                              | 全部工具照常注册                             |
| D9  | 非法输入（非数组 / 非字符串项 / 空串 / 超限）  | server **保留**、告警、非法部分不生效 | 配置解析结果 + 诊断项                        |
| D10 | 所有会写这份配置的路径                         | 往返**不丢**该键                      | 见 §6.1 的写入者清单，逐条实测               |
| D11 | 会话中期改配置                                 | 不即时生效，新建会话生效              | 与 §2.3 一致                                 |

---

## 6. 写入者清单（`disabledTools` 往返）

**硬要求（Lead 补充要求 A）**：**所有**写这份配置的路径都必须保住该键并共用同一套归一化，漏一条就是「用户一存就丢」。

| #   | 写入者                | 文件                                                                        | 保住键的机制                                                            |
| --- | --------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| W1  | CLI 配置文件读取      | `adapters/src/config/schema.ts`（`mcpServerBaseSchema`）                    | schema 显式声明该键，否则 `.strict()` 会拒/丢                           |
| W2  | Desktop 设置页保存    | `services/src/mcp-sync/mcpSyncService.ts` `upsert`                          | `nextServers[name] = payload.config`（整对象替换，非字段白名单）        |
| W3  | Desktop 启用/停用开关 | 同上 `writeServerEnabledToFile`                                             | 基于**既有对象**改 `enabled`（`:462-470` 只删 `enable`/`enabled`）      |
| W4  | Desktop 表单往返      | `packages/ui/src/settings/mcpSettingsShared.ts`                             | **必须显式保键**（`formToConfig` 是字段白名单，漏了就在用户点保存时丢） |
| W5  | UI → Agent DTO        | `packages/shared/src/mcp.ts` `convertToZCodeAgentMcpServer`                 | **必须显式保键**（白名单投影）                                          |
| W6  | 配置 merge            | `config/config-merger.ts:66-75`、`config/project-config.adapter.ts:132-155` | 整对象 spread，天然保住                                                 |
| W7  | 插件 MCP 归一化       | `adapters/src/plugins/mcp.ts` `resolveMcpServerConfig`                      | **必须显式保键**（三个 transport 分支各自白名单）                       |
| W8  | 协议 DTO → runtime    | `bootstrap/src/zcode-protocol/protocol-mcp-config.ts`                       | **必须显式保键**                                                        |

### 6.1 「如何在不连上 MCP 服务器的情况下列出可关闭的工具」——**建议形态**

难点是真的：**工具清单只能从活连接 `tools/list` 得到**。三种候选：

| 形态                               | 机制                                                      | 代价 / 风险                                                                                                                          | 结论                                                                                             |
| ---------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| (a) 连上后枚举（实时）             | 设置页对已连接的 server 调 `mcpPort.listTools()` 渲染开关 | 需要**已连接**；未连/连不上的 server 无法展示（用户最想关的往往正是那个话多的 server）；每次打开设置页会拉起 MCP 子进程              | 作为**主路径**，但**必须**标注「仅显示已连接 server 的工具」                                     |
| (b) 上次会话注册表快照（持久缓存） | 会话启动注册后把 `server → toolNames` 落盘，设置页读快照  | 快照会**漂移**（server 升级后新增/改名工具）；必须显示快照时刻并允许刷新；等于引入第二份状态（但是**只读派生缓存**，不是可写真相源） | ✅ **建议采纳**（作为离线回退），前提是**明确标注为快照 + 时刻**，且**不**允许从快照写回任何状态 |
| (c) 手输名字 + 校验                | 用户手输工具名，保存时若未连接则只做**格式**校验          | 拼错 ⇒ 关闭一个不存在的工具（静默无效，用户以为关了）；体验最差，但**永远可用**                                                      | 作为兜底，且**必须**在未连接时明说「未校验，工具名拼错不会生效」                                 |

**建议组合**：(a) 已连接 ⇒ 开关列表；(b) 未连接 ⇒ 读上次快照并显示「快照时刻 + 工具数」；(c) 都没有 ⇒ 手输 + 明说不校验。
**共同要求**：删除/改名后的**孤儿条目**（`disabledTools` 里指向已不存在的工具）必须**可见**（灰显 + 可清理），
否则用户会以为某个工具被关着而其实那条配置早已失效。

### 6.2 本轮交付到哪 / UI 缺口（如实声明）

**本轮交付**：配置契约（W1/W4/W5/W7/W8 全部保住该键）+ 注册面落实启停 + 端到端测试 + 本文档。
**本轮不交付**：MCP 设置页的**工具开关控件**（§6.1 的 (a)/(b)/(c) 都不做）。
**因此今天的实际用法是**：手工编辑 `~/.zcode/cli/config.json`（或 `~/.agents/mcp.json`）的 server 配置，写 `disabledTools`。
这不是「功能不可用」，而是**入口只有配置文件**；但**不能**说成「设置页可关工具」。

---

## 7. 开放项（本轮明确不做，不许写成已完成）

1. **插件内单个内置工具的启停**：插件工具是**内置工具**（`registerBuiltInTools` 的 `include*` 门），
   当前能表达「整包」的是 `enabledPlugins`，能表达「本轮收窄」的是 `toolDisallowlist`，**中间那层（按插件关掉某个内置工具、持久）不存在**。
   建议下一步：把工具启停收敛到**同一个所有者形状**（资源配置对象内的 `disabledTools`），而不是新设全局清单。
2. **MCP 设置页的工具开关 UI**：见 §6.1/§6.2。
3. **孤儿条目清理**：见 §6.1 末段（需要 UI，且需要快照才能识别）。
4. **`toolDisallowlist` 的注册面缺口**（§1.3）：本轮**不改行为**。若将来要把它变成真正的关闭，
   应在**同一个注册边界**落地（与 `disabledTools` 共用一处判定），而不是再加一层每轮过滤。
5. **插件声明的 `disabledTools`**：插件 `.mcp.json` 里写该键会让插件自己的工具默认关闭（契约上允许，语义自洽）。
   本轮**只保证不丢**，不鼓励插件使用；是否需要拒绝插件来源的该键，留待产品决定。
6. **远端 workspace**：配置经同一个 `mcp.servers` 形状下发，但**未做远端端到端实测**（见实现报告的未验证项）。

---

## 8. 与既有文档的关系

- `.reverse/33-tool-policy/SPEC.md` §2.7 把「资源启停（MCP/插件）」的所有者记为**各资源页**，本文落实为**该 server 配置对象内的 `disabledTools`**：**结论一致**（仍是资源页所有者），本文把「资源页能表达什么」从整包 `enabled` 精确到工具级。
- `.reverse/33-tool-policy/SPEC.md` §6.1「本页不实现 MCP 等资源的精细化管理」：**一致**，本文就是那一项的落地，两者不冲突（该页仍不提供资源级开关）。
- README「后续计划」的「工具精细化管理」：本文是其**第一刀**，条目应在本能力可用后**收窄**（插件内工具级启停仍未提供，不应删除该行）。
