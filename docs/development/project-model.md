# 项目模型：CE 现状与三条落地路线

> 状态：**设计提案（2026-10-30）**，未实现。上游 3.16.2 引入 project-storage 后，X16 附加目录、
> 多根项目（F1）、归档分组（F4）都以「项目」为状态所有者；CE 目前没有这个实体，直接照搬会把
> 一张新表连迁移、协议、UI 三层一起塞进来。本文把现状、可选路线与推荐写清楚，供决定后再动手。

## 1. CE 现状（按源码）

| 事实                                                                                               | 位置                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 身份键 = `workspaceIdentity?.trim() \|\| workspacePath`                                            | `packages/shared/src/workspace-registry.ts` 的 `resolveWorkspaceRegistryKey`                                          |
| 可见工作区集合 = 服务端注册表（只读 RPC），跨客户端一致                                            | `packages/services/src/session/workspaceRegistry.ts` + `workspaceRegistryRepo.ts`（tasks DB 表 `workspace_registry`） |
| 注册表条目字段：key/path/identity/firstSeen/lastActivity/sessionCount/activeSessionCount/sources   | `workspaceRegistryEntrySchema`                                                                                        |
| 会话与任务按 `workspacePath`/`workspaceIdentity` 落库；窗口内一个 Local Host 服务多个 workspace    | `packages/services/src/session/*`、`packages/desktop/src/host/*`                                                      |
| 迁移机制：tasks DB 的 0001–0005 分支登记在 `tasksDatabase/migrations.ts`，新增迁移必须登记并有测试 | `packages/services/src/session/tasksDatabase/`                                                                        |
| CLI 已支持会话级 `additionalDirectories`（协议 5 处 schema + 环境 prompt + 技能/命令根 + 冷恢复）  | task-45（`f3a7962c`）                                                                                                 |
| 桌面/调度/机器人**没有**附加目录来源                                                               | 全仓 0 命中（协议字段只被 CLI 消费）                                                                                  |

结论：CE 已有「工作区注册表」这个近似的项目索引，但它**只是索引**（只读、无根集合、无归属编辑），
不能承担上游 `VirtualProject` 的职责；而 `additionalDirectories` 的下发需要一个可编辑、可持久化的
存放点。

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

## 3. 三条路线

### A. 注册表加一列（最小，推荐先做）

在 `workspace_registry` 上加 `additional_directories TEXT NOT NULL DEFAULT '[]'`（迁移 0006），
只作为**该工作区的附加目录集合**：

- 写入口：设置页「工作区 → 附加目录」或工作区右键菜单（新增/移除目录，存工作区级）。
- 读出口：desktop host 在 session create/resume 时读取该工作区的列，作为 `additionalDirectories`
  下发给 CLI（CLI 半边已完成，直接生效）。
- 不引入：项目实体、多根、改名、归档分组、任务归属迁移。
- 迁移成本：一次加列迁移 + 三处读写（repo/service/host）+ 一个设置 UI；无协议 breaking。
- 风险：注册表是「索引」而非「配置」，把可变配置塞进索引表是职责扩张；需在表注释与
  `workspace-registry.md` 里写清「列是 host 级配置，不参与枚举语义」。

### B. 最小项目表（中）

新建 `projects(id, host_id, name, pinned, position, created_at, updated_at)` +
`project_roots(project_id, root_path, position, is_primary)` + `tasks.project_id`（可空）：

- 支持 F1（多文件夹、改名）、X15（主根可用性）、F4（归档分组）的基础数据面。
- 代价：一次真正的 schema 设计 + 回填（未归类任务 `project_id = null` 的展示口径）+ 侧栏读取面改造；
  迁移需要在上游 `BEGIN IMMEDIATE` 形态与 CE 现有迁移器之间选一个（不建议两套并存）。
- 与上游差异：不搬 `legacy-single-root` 投影、不搬远端项目校验、不搬 `task-facts`。

### C. 整块搬 project-storage（大，不建议默认做）

按上游把 `ProjectStorageContract`、`sqlite-migrations`、`ProjectTree`、自动归档与消费方全搬。
收益是与上游同构、后续 W4 直接接；代价是引入第二套迁移子系统与大量远端语义，且与 CE 的
「窗口内 Host + 自托管」形态冲突，需要独立的安全/迁移评审。

## 4. 推荐

**先 A 后按需 B，不做 C。**

- A 用最小代价让 X16 从「协议已支持但没人下发」变成真实可用，并验证「附加目录」这个产品点是否
  有人用（用量数据决定要不要继续投 B）。
- 只有在出现「一个项目多个文件夹」「项目改名/归档分组」的真实诉求时，再启动 B；B 的 schema 设计
  应直接参考上游字段名与语义（`roots/isPrimary/pinned/archived`），避免二次改名。
- C 的重开条件：决定跟进 Source Server / 远端项目体系（当前已裁定不跟进，见 backlog 有意不做）。

## 5. A 的验收与非目标

验收：

1. 设置页可为工作区增删附加目录；重启后仍在（迁移 + 持久化）。
2. 新建/恢复会话时 host 把该工作区的附加目录传给 CLI；CLI Environment 段落与技能/命令根能读到。
3. 工作区身份、权限边界、文件执行根不变（`workspacePath/workspaceIdentity` 仍是唯一身份）。
4. 迁移幂等：老库升级后默认 `[]`，无数据丢失；重复启动不重复写。

非目标（A 明确不做）：多根项目、项目改名、归档分组、任务归属迁移、远端项目校验、自动归档。

## 6. 待决定

1. 是否接受「附加目录存在注册表」的职责扩张，还是把它放 `AppSettings`（客户端设置，多端不同步）？
2. A 的 UI 入口放设置页还是工作区右键菜单（后者需要侧栏改动，超出 A 的范围）。
3. 是否为 B 预留 `projectId` 字段（现在加列可避免二次迁移，但会引入未使用的概念）。
