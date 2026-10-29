# 项目模型：CE 现状与三条落地路线

> 状态：**路线 A 已落地（2026-10-30，AppSettings 版）**；B 未启动、C 明确不做。上游 3.16.2 引入
> project-storage 后，X16 附加目录、多根项目（F1）、归档分组（F4）都以「项目」为状态所有者；
> CE 没有这个实体，直接照搬会把一张新表连迁移、协议、UI 三层一起塞进来。本文记录当前现状、
> 三条路线的取舍与 A 的验收/未覆盖清单。

## 1. CE 现状（按源码）

| 事实                                                                                               | 位置                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 身份键 = `workspaceIdentity?.trim() \|\| workspacePath`                                            | `packages/shared/src/workspace-registry.ts` 的 `resolveWorkspaceRegistryKey`                                          |
| 可见工作区集合 = 服务端注册表（只读 RPC），跨客户端一致                                            | `packages/services/src/session/workspaceRegistry.ts` + `workspaceRegistryRepo.ts`（tasks DB 表 `workspace_registry`） |
| 注册表条目字段：key/path/identity/firstSeen/lastActivity/sessionCount/activeSessionCount/sources   | `workspaceRegistryEntrySchema`                                                                                        |
| 会话与任务按 `workspacePath`/`workspaceIdentity` 落库；窗口内一个 Local Host 服务多个 workspace    | `packages/services/src/session/*`、`packages/desktop/src/host/*`                                                      |
| 迁移机制：tasks DB 的 0001–0005 分支登记在 `tasksDatabase/migrations.ts`，新增迁移必须登记并有测试 | `packages/services/src/session/tasksDatabase/`                                                                        |
| CLI 已支持会话级 `additionalDirectories`（协议 5 处 schema + 环境 prompt + 技能/命令根 + 冷恢复）  | task-45（`f3a7962c`）                                                                                                 |
| 附加目录的存放与下发：`AppSettings.workspaceAdditionalDirectories` + 新建会话注入                  | `packages/shared/src/workspaceAdditionalDirectories.ts`、`packages/ui/src/v4/SessionPane.tsx`（见 §3A）               |
| 调度/机器人仍**没有**附加目录来源                                                                  | 全仓 0 命中（消费方未跟进，见 `upstream-sync.md` X16 行）                                                             |

结论：CE 已有「工作区注册表」这个近似的项目索引，但它**只是索引**（只读、无根集合、无归属编辑），
不能承担上游 `VirtualProject` 的职责；而 `additionalDirectories` 的下发需要一个可编辑、可持久化的
存放点。

## 1.5 CE 已有的分组/organization 能力（先盘点，避免造第四套概念）

| 能力                                      | 事实                                                                                                                   | 位置                                                                                                       | 与上游 Project 的关系                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 工作区注册表                              | 只读索引：key/path/identity/活动时间/会话计数；无根集合、无名称覆盖                                                    | `session/workspaceRegistry*`                                                                               | 对应「项目列表」，但不承载配置                                                                |
| `task_groups` 系                          | 手动任务分组：`group_id/title/color`、成员（跨 workspace 的 task 集合）、视图排序；侧栏已有分组 UI（拖拽、颜色、折叠） | `tasksDatabase/schema-v1.ts`、`taskIndexRepo.ts`、`ui/src/workspace-grouped-tasks/*`、`useGroupedTaskView` | 与上游 Project 的「任务归属」形似但语义不同：分组是用户自建的文件夹式集合，不是任务的项目归属 |
| `recentProjects` / `lastWorkspaceSession` | 打开历史（最多 10 条），不承载根/名称                                                                                  | `AppSettings`                                                                                              | 只是入口历史                                                                                  |
| X16 附加目录                              | 每工作区的额外根（`AppSettings.workspaceAdditionalDirectories`）                                                       | task-51/52/53                                                                                              | 对应 `roots[1..]`（非主根）                                                                   |

因此 CE 的「项目」信息分散在四处：主根 / 附加根 / 名称 / 分组。上游 `VirtualProject` 只是把这些
字段放进一条记录；CE 没有一条记录，但**能力并非全缺**。这直接改变了路线选择（见 §3B′）。

## 2. 上游 3.16.2 的项目模型（参考，不照搬）

- `ProjectStorageContract`：Host 库版本化迁移（`sqlite-migrations`，BEGIN IMMEDIATE 串行、touchedTables
  备份、失败回滚）+ `ProjectRepositoryContract`。
- `VirtualProject`：`id/hostId/name/nameOverridden/roots[{rootPath,position,isPrimary}]/position/pinned/deleted`。
- `ProjectTask`：任务 + `projectId/hostId/pinned/archived`；`ProjectDirectories` 由
  `resolveSessionDirectories(task)` 解析出 `workspacePath/workspaceIdentity/additionalDirectories/projectId`。
- `archiveInactive`：按 CLI 最后活动时间自动归档，置顶与活跃任务除外。
- 消费链：desktop host / scheduler / bots / services 都从项目记录取附加目录（X16 消费方的来源）。

代价：新表 + 新迁移子系统 + 协议/服务/UI 全链；上游 71 个源文件、27 篇规格里相当一部分是这套模型
的周边（source server、远端项目校验），与 CE 的自托管形态并不一一对应。

## 3. 路线

### A. AppSettings 存附加目录（已落地，2026-10-30）

`AppSettings.workspaceAdditionalDirectories`：键 = `workspaceKey`
（`workspaceIdentity?.trim() || workspacePath`），值 = 已归一的绝对路径列表（每工作区 ≤256，
去空白/去空串/去重）。**这就是附加目录的唯一存放点**：

- 写入口：设置页「工作区附加目录」分区（`packages/ui/src/settings/WorkspaceAdditionalDirectoriesSection.tsx`）。
  目录选择复用 `IPlatformService.selectDirectory`，不新增多选 IPC。增删即保存。
- 读出口：`packages/ui/src/v4/SessionPane.tsx` 的草稿首发路径与草稿预热
  （`v4/composer/useDraftSessionPrewarm.ts`）把该工作区的目录放进 v4 `createSession` 的
  `additionalDirectories`；CLI 半边（task-45）已完成，直接生效。
- 不引入：项目实体、多根、改名、归档分组、任务归属迁移；**不改 `workspace_registry`**。
- 生效时机：**新建会话**。CLI 只在创建/恢复期消费该字段，已运行的会话不重新读取 —— 设置页文案
  与 §5 的未覆盖清单据此如实标注。
- 为什么不是「注册表加一列」：注册表的行由**枚举 upsert** 维护（`sources` 只记来源），
  它是「可见工作区集合」的索引。把可变配置放进去，要么被枚举写入覆盖，要么迫使枚举逻辑
  携带配置 —— 二者都会让索引变成半个配置表，也让「配置变了工作区集合要不要变」这种问题
  没有干净答案。AppSettings 归属**宿主**（`setting.json`），同一 Host 的所有客户端读到同一份，
  跨 Host 不同步；而目录路径本来就是每台机器的事实，这个差异是合理的。

### B′. 组合既有能力（推荐，不建新表）

把四处现有事实读成一份「项目投影」，不新增 schema：

- **主根** = `workspacePath`（已是会话执行根）；**附加根** = `AppSettings.workspaceAdditionalDirectories`
  （X16，已落地）；**名称** = 新增 `AppSettings.workspaceDisplayNames?`（仅展示名，不改身份/路径）；
  **置顶/排序** = 客户端设置（与 `pinnedKeys` 同型）；**任务归组** = 既有 `task_groups`（F4 归档分组直接
  复用这套表与侧栏 UI，不引第二套）。
- 缺的只是「一份投影函数 + UI 读它」：`resolveWorkspaceProjectView(workspaceKey)` 聚合上述四处，供侧栏/
  F1 目录编辑器读取。
- F1 多文件夹：`selectDirectories`（多选）写回附加根列表 —— 不需要新表，也不需要项目实体。
- 与上游差异：没有 `projectId`、没有 `hostId`、没有跨 Host 项目库；这些只在需要「任务跨 Host 迁移」或
  「远端项目校验」时才需要（对应 C 的重开条件）。

### B0. 最小项目表（仅当需要任务归属/跨 Host 时）

新建 `projects(id, host_id, name, pinned, position, created_at, updated_at)` +
`project_roots(project_id, root_path, position, is_primary)` + `tasks.project_id`（可空）：

- 支持上游式「任务归属项目」与跨 Host 项目库；代价是一次真正的 schema 设计 + 回填（未归类任务
  `project_id = null` 的展示口径）+ 侧栏读取面改造；迁移只能选一套迁移器（不建议两套并存）。
- 与上游差异：不搬 `legacy-single-root` 投影、不搬远端项目校验、不搬 `task-facts`。
- 重开条件：出现「任务需要跟着项目走（跨 Host/远端）」的真实诉求。

### C. 整块搬 project-storage（大，不建议默认做）

按上游把 `ProjectStorageContract`、`sqlite-migrations`、`ProjectTree`、自动归档与消费方全搬。
收益是与上游同构、后续 W4 直接接；代价是引入第二套迁移子系统与大量远端语义，且与 CE 的
「窗口内 Host + 自托管」形态冲突，需要独立的安全/迁移评审。

## 4. 推荐

**A 已落地（AppSettings 版）；下一步做 B′（组合既有能力）；B0 仅在需要任务归属/跨 Host 时启动；不做 C。**

- A 用最小代价让 X16 从「协议已支持但没人下发」变成真实可用（不新增表、不新增迁移、无协议
  breaking），并验证「附加目录」这个产品点是否有人用（用量数据决定要不要继续投 B）。
- B′ 用既有表/设置组合出「项目投影」，W4 的多文件夹（F1）、改名、归档分组（F4）都可在其上实现；
  `task_groups` 已有的拖拽/颜色/折叠 UI 直接复用，**不要再造一套 project 分组**。
- 若未来需要任务随项目跨 Host 迁移，再按 B0 建表；字段名仍对齐上游（`roots/isPrimary/pinned/archived`）。
- C 的重开条件：决定跟进 Source Server / 远端项目体系（当前已裁定不跟进，见 backlog 有意不做）。

## 5. A 的验收与非目标

**已落地并验证的部分**：

1. 设置页可为工作区增删附加目录；值落在 `setting.json` 的 `workspaceAdditionalDirectories`，
   重启后仍在。旧配置没有该字段时解析结果也不出现该键（不伪造空表、不产生写放大）。
2. 新建会话时把该工作区的目录放进 v4 `createSession` 的 `additionalDirectories`，CLI 用它填
   Environment 段落与技能/命令/子代理根（task-45）。
3. 工作区身份、权限边界、文件执行根不变（`workspacePath/workspaceIdentity` 仍是唯一身份）。

**已覆盖**：冷恢复 / 重启后重新打开历史会话由 `subscribeConversationV4` 按 workspaceKey
从设置解析 `additionalDirectories` 并随订阅参数下发（`packages/services` 注入窄能力，
`services/node.ts` 用 `settingService` 实现）；desktop-attached-remote 不注入 —— 远端 Host
自己持有设置，本地路径对远端无意义。2. 中枢入口已接：`useSavedWorkflowLauncher` / `useSavedWorkflowPromote` 的 `createSession`
会带上该工作区的附加目录（2026-10-30 补齐）。Automation 派生的会话仍由对应消费方决定。3. 已打开的草稿预热会话：目录变化会让预热会话按 owner key 换代（未提升的 draft 会话被回收重建），
已预传到旧会话的附件需要重新添加；已运行的会话不受影响。

非目标（A 明确不做）：多根项目、项目改名、归档分组、任务归属迁移、远端项目校验、自动归档。

远端工作区：设置页只允许**移除**已有条目、不允许添加 —— 目录选择器只返回本机路径，给远端工作区
选出来的本机路径在远端没有意义。

写入语义：设置页只提交被改的**单个工作区键**，服务端按 key 合并（空列表 = 删除该键），
两个客户端同时编辑不同工作区不会互相覆盖；不再依赖整表读改写。

## 6. 待决定

1. 是否为 B 预留 `projectId` 字段（现在加列可避免二次迁移，但会引入未使用的概念）。
2. 冷恢复在 desktop-attached-remote（远端 Host）下的下发方式：需要远端侧注入而不是本地设置。
3. scheduler / bots 派发的会话如何拿到附加目录（服务侧消费方，等 B 或显式注入）。
