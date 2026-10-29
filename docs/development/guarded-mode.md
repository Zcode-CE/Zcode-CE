# 170 · F3 自主模式危险命令确认：guarded 模式 core 侧移植

> 状态：**已实现（core 侧，2026-10-13）**。覆盖公告「更新『自主模式』，危险命令执行前会先征求确认」在 `apps/zcode-cli/packages/core` 内的全部落点。contracts 侧依赖（guarded 枚举）由 task-6 落地；本文档 §4 列出的范围外接线（bootstrap/adapters/cli 的模式开关）归各范围所有者。
> 上游来源：`zai-org/ZCode` tag `v3.15.1`（`aac47556`，Apache-2.0，相对 CE fork 点 `872ad96`）。

## 0. 读了什么 / 结论一致性

| 材料                                                                       | 结论                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PORT-MATRIX F3 行「CE 21 处 permission-capability 相关，无 guarded/ 实现」 | **证实**：CE 无 `handlers/guarded/`、无 `guarded` 模式枚举、无 `userApprovalRule`。但矩阵漏报了关键事实：**CE 有自研清单制危险命令系统**（`bash-command-dangerous-policy.ts` + `bash-command-wrapper.ts` + `@zcode/shared/dangerousCommands`，task-67/72/73 的安全债修复）。因此 F3 不是「从零搬入」，而是「在上游 AST 匹配器与 CE 清单制之间做组合设计」。                                                                                                       |
| 上游 `handlers/guarded/` 8 文件                                            | AST 定位的命令匹配器：`matchDangerousCommand(command, dialect)` → `{status:"matched", ruleId}` 或 `notMatched`/`unsupported`。规则：`remove-critical-path`/`system-storage`/`rsync-delete`/`find-delete`/`git-reset-hard`/`git-clean-force`/`git-push-force`/`git-discard-tree`/`git-stash-clear`/`git-worktree-force-remove`/`cmd-remove-tree`/`cmd-delete-files`/`robocopy-delete`。带源位置（start/end）与三态语义（false=已支持未命中；undefined=超出文法）。 |
| 上游接线点（grep 全树）                                                    | 唯一 src 调用点 `bash.ts:122` 的 `resolveBashPermissionCapability`：`context.mode === "guarded"` 时匹配，命中返回 `{ userApprovalRule: ruleId }`；`permission/service.ts:136` 在 guarded 下跳过 yolo 放行，直接 `ask` + `approvalMode: "user-once"`；`permission/broker.ts:26` 的 `DenyPermissionBroker` 在 guarded 下抛 ConfigurationError（guarded 必须有真实客户端可问）。                                                                                     |
| 上游 guarded 语义（`session.port.ts`）                                     | `CollaborationMode` 增加 `"guarded"`：**guarded ≈ yolo（其余一律放行），但命中的危险命令逐次 ask**；Plan 优先于 guarded；`resolveParentMode` 在父 guarded 时把子 yolo 归一为 guarded。                                                                                                                                                                                                                                                                            |
| CE 当前语义（`contracts/session.port.ts`）                                 | `CollaborationMode = "plan"                                                                                                                                                                                                                                                                                                                                                                                                                                       | "build" | "edit" | "yolo" | "auto"`——**无 guarded**；`permission/service.ts`只有`mode === "yolo" && !planEnabled → allow`。CE 的危险命令清单只影响**授权规则卫生**（降级为精确规则、过滤 allow、no-always-allow），**不影响自主模式下的逐次确认**——这正是 F3 的产品缺口。 |

## 1. 产品规则

1. **自主模式（guarded）下，命中危险规则的命令每次执行都要用户确认**；未命中的命令与 yolo 一致直接放行，不新增多余确认。
2. **确认不可被会话级 allow 规则绕过**：上游用结构化字段 `userApprovalRule` 识别「不可抹掉的确认」（`permission/service.ts` 的注释明确「不是去匹配 ruleId 字符串」）；CE 实现须保持这一性质——危险规则的 ask 不因 `sessionRules`/持久 allow 规则被覆盖。
3. **匹配失败要降级而非放过**：上游的 `unsupported` 语义（解析失败/超出文法）在 guarded 下**不产生 userApprovalRule**，回到普通 yolo 放行路径——即「无法判定危险时不假装判定」。CE 复核后采纳该语义，**不**把 unsupported 变成 ask（会把大量普通命令变成确认噪声）。
4. **UBSD/Windows 语义由 dialect 决定**：`matchDangerousCommand` 的第二参 `dialect` 取 `ExecutionShellSelection["dialect"]`（posix/cmd/git-bash/legacy-shell）；selection 缺席时用 `GUARDED_DEFAULT_DIALECT = "posix"`（上游注释：缺失是基础设施状态，不能静默退回 YOLO——与 `isRuntimeReadOnlyBashCommand` 一致）。
5. **危险命令的两套机制各司其职**：CE 既有清单制（规则卫生：永不生成 `:*`、加严后撤销已落盘授权——见 `test/dangerousCommandPolicy.test.ts` 的 task-73 断言）继续服务授权链路；上游 AST 匹配器**只**服务 guarded 逐次确认。两套机制的状态 owner 不同，互不写对方的状态。

## 2. 状态所有者

| 状态                       | 唯一所有者                                                                                                 | 读取方                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 当前会话模式（含 guarded） | runtime config（`runtime/methods/config.ts` `getMode`），经 `ToolExecutorDeps.getMode()` 读                | permission service（`PermissionContext.mode`）、tool capability context |
| 危险命令匹配结论           | `handlers/guarded/command.ts` `matchDangerousCommand`（纯函数，无状态）                                    | `bash.ts` 的 `resolveBashPermissionCapability`                          |
| shell dialect              | `bashShellSelection`（`runtime/methods/session-shell-environment.ts` 已有）                                | capability context                                                      |
| 确认结果                   | permission broker（客户端 ask 的应答）+ `PermissionService.checkPermission` 的 `approvalMode: "user-once"` | executor                                                                |

数据流（所有者视角）：

```
executeTurn → tool executor
  ├─ deps.getMode() → PermissionContext.mode（含 "guarded"）
  ├─ resolveBashPermissionCapability(input, {mode, bashShellSelection})
  │     └─ mode === "guarded" → matchDangerousCommand(cmd, dialect)
  │           matched → capability.userApprovalRule = ruleId
  └─ PermissionService.checkPermission(context, capability)
        guarded + userApprovalRule → ask(ruleId, "user-once")
        guarded 无规则 → allow（mode.yolo 语义）
  └─ broker.requestPermission → 客户端确认 → 执行/拒绝
```

## 3. 接口（core 内）

新增/修改（全部在 `apps/zcode-cli/packages/core/src`）：

| 文件                                                                                   | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------ |
| `tool/handlers/guarded/{command,options,wrappers,word,cmd,find,git,windows-delete}.ts` | **逐字节搬运**上游 8 文件（Apache-2.0，文件头加 `Modified by ZCode:` 标记）。依赖 `analyzeBashCommand`（CE 已有，`bash-command-parser.ts`）与 `@zcode/contracts` 的 `ExecutionShellSelection`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tool/handlers/bash.ts`                                                                | 新增 `GUARDED_DEFAULT_DIALECT`；`resolveBashPermissionCapability` 增加 guarded 分支（上游 119-127 行形态）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tool/types.ts`                                                                        | `ToolRuntimePermissionCapability` 加 `userApprovalRule?: string`；`ToolRuntimePermissionCapabilityContext` 加 `mode?: CollaborationMode` 与 `bashShellSelection?: ExecutionShellSelection`（CE 现有 `dangerousCommandPolicy` 字段保留不动）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `permission/service.ts`                                                                | `PermissionToolCapability` 加 `userApprovalRule`；`checkPermission` 在 plan 之后、alwaysAsk 之前插 guarded 分支（上游 134-146 行形态：ask + approvalMode "user-once"）；yolo 分支扩展为 `mode === "yolo"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |     | "guarded"`。 |
| `permission/broker.ts`                                                                 | `DenyPermissionBroker` 在 `request.mode === "guarded"` 时抛 ConfigurationError（guarded 必须有可问的客户端）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `tool/handlers/bash-command-parser.ts`                                                 | **合并（非搬运）**：上游 3 处加法（diff 全为 `+` 行，CE 解析器是上游的严格子集）：① import `literalPosixWord, CommandWord` 自 `./guarded/word.js`（依赖方向 parser → guarded/word，**非循环**：word.ts 不 import parser）；② `BashCommandInvocation` 加 `readonly words: CommandWord[]`（guarded/command.ts 消费 `analysis.commands[].words`，带 start/end 位置与 hasUnquotedGlob/dynamic 标记——CE 现有 parser 只产 argv 字符串，无位置信息，这是 170 的**必要前置合并**）；③ `collectPipelineCommands` 加 time 关键字恢复（unbash 把 `time` 从 argv 提升为 `Pipeline.time`，不恢复则 `time -o file` 的参数被误当 executable）；④ `collectSimpleCommand` 加 words 映射（`literalPosixWord(word.text, word.pos, word.end)`，glob 只取顶层字面片段）。 |

## 4. 范围外依赖（需建子任务，不由本成员写）

| 依赖                                               | 落点                                                                                                                                                                                                                                                                                                                                                                                       | 说明                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CollaborationMode` 加 `"guarded"` + 相关 zod 枚举 | `apps/zcode-cli/packages/contracts/src/interfaces/session.port.ts`、`tools/{plan-mode,automation,off-peak}.ts`、`interfaces/permission-full-access.ts`                                                                                                                                                                                                                                     | **contracts 包当前不在任何成员写范围内**——需 Lead 指派（建议归 core-services-port，与其协议职责一致）。纯加法、向后兼容。                                  |
| 模式开关与持久化                                   | `bootstrap/src/zcode-protocol-v4/commands/handlers/{session-mgmt,model-config}.ts`、`bootstrap/src/zcode-protocol/{automation-port,interaction-broker,server-operations,v4-bridge}.ts`、`bootstrap/src/app/workflow-facade.ts`、`adapters/src/config/schema.ts`、`adapters/src/storage/session-store/codecs.ts`、`cli/src/{cli-types,command-center/{handlers/expert,modes,types},run}.ts` | guarded 可切换、可持久化、可在确认窗/子会话传播（`resolveParentMode`）。bootstrap 部分在 core-services 范围；`adapters`/`cli` **同样无主**，需 Lead 指派。 |
| UI 模式选择器露出 guarded                          | `packages/ui/`                                                                                                                                                                                                                                                                                                                                                                             | ui-features-port。                                                                                                                                         |

**范围策略**：core 侧可先于上述接线落地（guarded 分支在 mode 缺失时自然不触发，类型层面 `mode?: CollaborationMode` 使 contracts 未加 `"guarded"` 时 core 无法引用字面量——因此 **contracts 改动必须先行**，core 实现依赖它；这也意味着本任务实际开工点在 task-1 及 contracts 子任务之后）。

## 5. 验收场景

| #   | 场景                                                                       | 期望                                                                                  |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A1  | guarded 模式执行 `rm -rf /tmp/x`                                           | matched(`safety.bash.remove-critical-path`) → ask(user-once)，不被会话 allow 规则覆盖 |
| A2  | guarded 模式执行 `git reset --hard` / `git clean -fd` / `git push --force` | 分别命中 `git-reset-hard`/`git-clean-force`/`git-push-force` → ask                    |
| A3  | guarded 模式执行 `ls -la` / `echo hi`                                      | 无 userApprovalRule → 直接放行（与 yolo 一致）                                        |
| A4  | guarded 模式执行 `sudo rm -rf /x`（wrapper 链）                            | wrapper 解开后仍命中（`unwrapCommand` 处理 env/time/sudo）                            |
| A5  | 解析失败（`rm -rf ${X}` 动态词、超 10k 字符、legacy-shell）                | `unsupported` → 不 ask、不放行危险判定，回退 yolo 放行（规则 R3）                     |
| A6  | windows dialect：`rd /s /q X`、`robocopy /MIR a b`                         | 命中 `cmd-remove-tree`/`robocopy-delete`                                              |
| A7  | Plan 模式 + guarded                                                        | Plan 优先：plan 的执行限制不被 guarded 的放行语义解除                                 |
| A8  | 无权限客户端（DenyPermissionBroker）+ guarded                              | 抛 ConfigurationError 而非静默 deny（上游 broker 语义）                               |
| A9  | yolo 模式下上述危险命令                                                    | 行为不变（回归断言：CE 现有 dangerousCommandPolicy 测试全绿）                         |

## 6. 测试（CE 口径）

上游 vitest 测试（`guarded-command/approval/deletion/mode/subagent/user-interaction.test.ts` + `fixtures/guarded-deletion-oracle.mjs`）CE 不照搬（CE 无 vitest、`test/` 目录、node:test 风格——见 `test/dangerousCommandPolicy.test.ts`）。移植为 CE 风格的 `test/guarded-command.test.ts` + `test/guarded-mode.test.ts`：

- `guarded-command.test.ts`：A1/A2/A4/A5/A6 的纯函数判定（直接断言 `matchDangerousCommand`，含上游 `guarded-deletion-oracle.mjs` 的判据表核心 case）。
- `guarded-mode.test.ts`：A3/A7/A9 的权限语义（`PermissionService.checkPermission` + capability，断言 `approvalMode: "user-once"` 与 yolo 放行不被改变）。
- 复用 CE 既有断言：`test/dangerousCommandPolicy.test.ts` 全绿（两套机制共存不冲突）。

## 7. 验证

- `pnpm --dir apps/zcode-cli typecheck`、`pnpm --dir apps/zcode-cli lint`；`cd apps/zcode-cli/packages/core && node --import tsx --test test/guarded-*.test.ts test/dangerousCommandPolicy.test.ts`。
- 门禁真实结果回传（未跑≠通过）。

## 8. 搬运清单（Apache-2.0，交 release-integrator 登记）

| CE 文件                                                                                         | 上游路径           |
| ----------------------------------------------------------------------------------------------- | ------------------ |
| `apps/zcode-cli/packages/core/src/tool/handlers/guarded/command.ts`                             | 同名（`aac47556`） |
| `...`/options.ts` `/wrappers.ts` `/word.ts` `/cmd.ts` `/find.ts` `/git.ts` `/windows-delete.ts` | 同名               |

合并（非搬运，按本地修改登记）：`tool/handlers/bash-command-parser.ts`——上游 3 处加法合并入 CE 既有文件（diff 全为 `+` 行，CE 为上游严格子集，无冲突项）。

本地修改（`Modified by ZCode:` 标记位）：`tool/handlers/bash.ts`、`tool/types.ts`、`permission/service.ts`、`permission/broker.ts` 为 CE 既有文件的功能性修改，按修改登记；guarded/ 8 文件为逐字节搬运 + 文件头标记。
