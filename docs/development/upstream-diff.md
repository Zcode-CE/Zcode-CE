# 与上游的差异

> 状态：草稿 · 数据来自本仓库的改造记录

## 上游

ZCode-CE 基于 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0，创建于 2026-09-20）。
本仓库是它的 fork，**保持 fork 关系**以保留溯源与同步能力。

## 改动概览

（待补充：按「移除遥测」「补齐权益能力」「社区插件」三类整理，含文件级清单）

## 同步上游

```bash
git remote add upstream https://github.com/zai-org/ZCode.git   # 仅首次
git fetch upstream
git merge upstream/main
```

**同步注意**：

- 本仓库的改动**大部分是删除**（遥测相关），删除类改动在上游未触碰同文件时冲突面小
- 新增内容尽量集中在独立目录（如 `apps/zcode-cli/packages/*-plugin/`），减少对上游文件的侵入
- 同步后必须跑 `pnpm typecheck` / `pnpm lint` / `pnpm test` 与 `pnpm architecture:check --changed`

## 已知的技术债

| #   | 项                                                                                                   | 严重度 |
| --- | ---------------------------------------------------------------------------------------------------- | ------ |
| 1   | `tsconfig.main.json` 的 `rootDir` 越界（`tsc -b` 会把编译产物写进 `src/`）                           | 高     |
| 2   | `pnpm typecheck` 的工程列表不含 desktop main/renderer                                                | 中     |
| 3   | desktop main/renderer 存在既有类型错误                                                               | 中     |
| 4   | `packages/ui` 的 `@/*` 别名导致测试必须从包目录内执行                                                | 低     |
| 5   | `third-party-npm.mjs` 的 `unsupportedCanvas` 排除集不完整，`pnpm licenses:check` 在 linux/x64 下失败 | 中     |
| 6   | 三方许可声明（`THIRD-PARTY-NOTICES.md`）待重生成，被 #5 阻塞                                         | 中     |

技术债 #1 的规避方式：**不要对 `packages/desktop` 使用 `tsc -b`**，改用 `tsc -p <cfg> --noEmit` 或 `scripts/desktop-typecheck-baseline.sh`。
