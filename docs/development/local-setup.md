# 本地开发

## 环境

版本以 [mise.toml](../../mise.toml) 为准：Node.js **24.14.0**、pnpm **10.33.2**。

## 初始化

```bash
pnpm install
```

> `pnpm bootstrap` 会额外准备桌面运行资源与远程资源（需要网络下载 Electron / Node 运行时）。仅做源码开发时，`pnpm install` 即可。

## 常用命令

| 用途             | 命令                                    |
| ---------------- | --------------------------------------- |
| 类型检查         | `pnpm typecheck`                        |
| Lint             | `pnpm lint` / `pnpm lint:fix`           |
| 格式检查         | `pnpm fmt:check`                        |
| 测试             | `pnpm test`                             |
| 桌面开发         | `pnpm dev:desktop`                      |
| Web 开发         | `pnpm dev:web`                          |
| 架构检查         | `pnpm architecture:check --changed`     |
| 模块阅读包       | `pnpm architecture:context <module-id>` |
| 未使用依赖与导出 | `pnpm knip`                             |

## 测试

测试运行器是 Node 内置的 `node:test`，配 `tsx` 解析 TypeScript：

```bash
pnpm test                          # 全部
cd packages/ui && node --import tsx --test test/*.test.ts   # 单包
```

**注意**：`packages/ui` 使用 tsconfig paths 的 `@/*` 别名，**必须从包目录内执行**，从仓库根跑会 `ERR_MODULE_NOT_FOUND`。`scripts/run-tests.mjs` 已处理这个差异。

## 类型检查的覆盖范围

`pnpm typecheck` 的工程列表**不含** `packages/desktop/tsconfig.main.json` 与 `tsconfig.renderer.json`。改动 desktop main/renderer 时需额外跑：

```bash
bash scripts/desktop-typecheck-baseline.sh diff
```

它用 `git worktree` 取真实 HEAD 做对比，只报**净增**的错误。
