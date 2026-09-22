# 架构与模块边界

本文件描述 ZCode-CE 的仓库结构、模块职责与依赖约束。约束由 `architecture-policy.yaml` 声明，由 `pnpm architecture:check` 强制执行。

## 仓库结构

```
apps/zcode-cli/          Agent CLI 与运行时（独立 workspace，有自己的 pnpm-workspace.yaml）
  packages/              adapters / bootstrap / cli / contracts / core / i18n / tui …
  packages/*-plugin/     内置插件（browser-use / node-repl-host / documents / presentations /
                         spreadsheets / zcode-cua / plugin-creator / skill-creator / zcode-guide /
                         restore-legacy-sessions）
  packages/bundled-skills/ 内置技能包（非插件：无 plugin.json，运行时原地发现为
                         source:"bundled" / scope:"system" 的技能根，不可卸载）
  tools/                 prompt-trajectory / typescript
packages/
  desktop/               Electron main / host / renderer / preload / scheduler
  web/                   Web 客户端
  server/                服务端
  ui/                    共享 React 组件、hooks 与 Zustand store
  services/              业务服务
  rpc/                   RPC 框架
  shared/                共享协议与类型
  client/                Agent 客户端 SDK
  provider/              模型供应商抽象
  provider-node/         供应商的 Node 侧实现
  zcode-server-cli/      独立服务端 CLI
  zcode-cua/             Computer Use 运行时（适配 MIT 的 @trycua/cua-driver）
  formal-proof/          状态空间枚举器
  model-option-map/      模型选项映射
config/provider/         内置供应商配置（zcode-builtin.json）
scripts/                 构建、检查与工具脚本
docs/                    开发者文档（本目录）
third-party/             第三方组件清单与许可快照
```

## 模块与依赖方向

模块定义在 `architecture-policy.yaml`。每个模块声明 `roots`（源码根）、可选的 `requires`（依赖）、`publicEntrypoints`（公开入口）与 `owner`。

### 模块清单

| 模块               | 源码根                          | 状态        | 公开入口              |
| ------------------ | ------------------------------- | ----------- | --------------------- |
| `rpc`              | `packages/rpc/src`              | legacy      | —                     |
| `shared`           | `packages/shared/src`           | legacy      | —                     |
| `provider`         | `packages/provider/src`         | legacy      | —                     |
| `provider-node`    | `packages/provider-node/src`    | legacy      | —                     |
| `services`         | `packages/services/src`         | legacy      | —                     |
| `session`          | `packages/services/src/session` | legacy      | `session/contract.ts` |
| `storage`          | `packages/services/src/storage` | **managed** | `storage/contract.ts` |
| `client`           | `packages/client/src`           | legacy      | —                     |
| `server`           | `packages/server/src`           | legacy      | —                     |
| `zcode-server-cli` | `packages/zcode-server-cli/src` | legacy      | —                     |
| `ui`               | `packages/ui/src`               | legacy      | —                     |
| `web`              | `packages/web/src`              | legacy      | —                     |
| `desktop`          | `packages/desktop/src`          | legacy      | —                     |
| `formal-proof`     | `packages/formal-proof/src`     | legacy      | —                     |
| `zcode-cli`        | `apps/zcode-cli`                | legacy      | —                     |

**`managed: true`** 的模块受完整架构约束（分层、契约、入口）。**`legacy`** 模块是存量代码，尚未迁移，约束较松。

### 分层（仅 `storage` 已启用）

`storage` 声明了三层与顺序：

| 层         | 目录       | 职责           |
| ---------- | ---------- | -------------- |
| `domain`   | `domain`   | 领域模型与规则 |
| `app`      | `app`      | 应用编排       |
| `adapters` | `adapters` | 外部 I/O 适配  |

`layerOrder: [domain, app, adapters]` —— **依赖只能沿此顺序单向流动**。

## 全局约束

| 约束                | 值      | 含义                                     |
| ------------------- | ------- | ---------------------------------------- |
| `maxFileLines`      | **400** | 单个源文件上限；超过须按高内聚低耦合拆分 |
| `maxContractLines`  | 300     | 契约文件上限                             |
| `maxPublicMethods`  | 12      | 单模块公开方法上限                       |
| `forbidCycles`      | true    | 禁止循环依赖                             |
| `forbidDeepImports` | true    | 禁止跨模块深层导入（须走公开入口）       |
| `managedOnly`       | true    | 检查默认只作用于 `managed` 模块          |

## 跨包导入规则

- **使用公开入口**，遵守现有路径别名（`@zcode/*`、`@/`）
- 不直接导入其他包的内部实现路径
- 禁止循环依赖
- 新增模块间交互时**先补接口契约**，再实现逻辑

## 工具

| 命令                                    | 用途                     |
| --------------------------------------- | ------------------------ |
| `pnpm architecture:check --changed`     | 检查变更文件的架构合规性 |
| `pnpm architecture:check`               | 全量检查                 |
| `pnpm architecture:report`              | 生成报告                 |
| `pnpm architecture:baseline:update`     | 更新基线（存量违规快照） |
| `pnpm architecture:context <module-id>` | 生成该模块的受控阅读包   |
| `pnpm dep:graph`                        | 依赖图                   |
| `pnpm dep:refs`                         | 导出引用查询             |
| `pnpm knip`                             | 未使用依赖与导出         |

### 基线机制

`.architecture-baseline.json` 记录**存量违规**。检查只报**相对基线新增**的违规，避免存量问题淹没新问题。当前基线为 `{ "version": 1, "violations": [] }` —— **无存量违规**。

## 相关文档

- [本地开发](local-setup.md) —— 环境准备与验证命令
- [与上游的差异](upstream-diff.md) —— 本仓库相对官方 ZCode 的改动
- [遥测与隐私](telemetry.md) —— 数据流向与保留的能力边界
- 根目录 [AGENTS.md](../../AGENTS.md) —— 编码代理的工作规则
