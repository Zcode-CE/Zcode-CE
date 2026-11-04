# workspace-maintenance

工作区删除与数据清理（spec：`.local/reports/planning/workspace-purge/SPEC.md`）。

单元 = `workspaceKey`（`workspaceIdentity?.trim() || workspacePath`），不建 project 表。

## 三个方法

- `measureWorkspace(ref)`：纯读。返回每项计数（驱动确认框与测试）、`running`、以及**不删项及原因**。
- `purgeWorkspace(ref)`：彻底删除（不可撤销）。顺序固定：**先删数据，注册表行最后删**。
  中途失败时数据已删、行还在 ⇒ 重试幂等；反过来会留下不可见孤儿（不可枚举但占盘）。
- `removeWorkspaceFromList(ref)`：只删注册表行，数据保留；重新打开目录即回来。

## 清理清单

| 项                                                     | 位置                                                                 | 可删           |
| ------------------------------------------------------ | -------------------------------------------------------------------- | -------------- |
| tasks / automations / automation_runs / off_peak_tasks | `tasks-index.sqlite`（`workspace_key`）                              | 是             |
| task_group_members + 因此变空的组 + 组的排序记录       | 同上                                                                 | 是             |
| 旧版任务快照                                           | `v2/sessions/<workspaceHash>`                                        | 是             |
| 检查点                                                 | `v2/checkpoints/<workspaceHash>`                                     | 是             |
| 展示名 / 附加目录 / 上次活动任务                       | AppSettings（键 = workspaceKey）                                     | 是             |
| 工作区 Hook 信任                                       | `<storageRoot>/security/workspace-hook-trust-v1.json`（按 identity） | 是             |
| workspace_registry 行                                  | `tasks-index.sqlite`                                                 | 是（**最后**） |

**不删**（measure 里逐条列原因，结果里不伪装成已完成）：

- CLI 会话库（`~/.zcode/cli/db/db.sqlite`）：CLI 自有库，注册表当前不从它枚举（`node.ts` 未传 `extraEntries`）。
- 子代理 transcript（CLI agent 目录）：按会话 id 组织，本机没有 workspace→会话目录的权威映射。
- 记忆文件：位于**用户工作区目录内**（`<workspace>/memory`），删它等于删用户仓库里的文件。
- 工作区 MCP 信任：store 只存声明摘要（内容哈希），无法按 workspaceKey 精确命中。

## 不变量

- 运行中的工作区拒绝删除（运行态由 `activity` 端口给出），不提供强制删除。
- 进程内全局互斥：同一时刻只允许一个 purge。
- 每次 purge / removeFromList 写一条本地审计记录（不上报）。
- 失败语义：返回 `deleted`（本次）+ `remaining`（删后复测）；重试幂等。
