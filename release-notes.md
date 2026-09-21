# ZCode-CE v3.14.1-ce.1.fix.1

**中文** · [English](#english)

> **热修复版本。** 修复 v3.14.1-ce.1 中导致界面完全无法显示的启动缺陷。
> 该版本全部产物在任意平台、任意数据目录下都会卡在启动 logo 画面。
> **所有 v3.14.1-ce.1 用户请升级到本版本。**

## 修复内容

### 1. 启动卡死的两个独立缺陷

两个缺陷各自都足以让界面无法渲染，共同表现是永远停在启动 logo：

| # | 位置 | 问题 |
| - | ---- | ---- |
| 1 | `packages/desktop/src/preload/index.ts` | 残留一处对已被删除的 `scheduleArmsEventBridgePatch()` 的调用，preload 抛 `ReferenceError`，导致 preload 脚本加载失败、IPC 桥残缺 |
| 2 | `packages/services/src/logger/serviceLogger.ts` | `process.pid` 在浏览器环境不存在；该模块被打进渲染包后抛 `ReferenceError: process is not defined`，React 无法挂载 |

两个缺陷的成因不同但后果相同，因此只修其中一个仍会是坏版本。

### 2. 为什么此前没有被发现

根 `typecheck` 脚本只覆盖 `packages/desktop/tsconfig.host.json`，**`tsconfig.preload.json` 不在类型检查范围内**，
因此缺陷 1 的 `TS2304` 从未被 CI 捕获。本版已把 preload 工程纳入 `typecheck`。

### 3. 顺带修复的上游缺陷

官方发行版自身存在一处不对称缺陷：`packages/desktop/src/main/logger.ts` 为主进程装了 EPIPE 护栏
（注释原文「不能让日志输出反过来杀掉主进程」），但 **host 进程侧没有装**。
host 是 utilityProcess，未捕获异常会走 `process.exit(1)`；当继承来的 stdout/stderr 管道断开时，
host 会猝死且 main 不重建，渲染进程永远等不到 host。本版把同一规则补到了 host 侧。

## 验证

- `pnpm typecheck` 通过（0 错误）；`pnpm lint` 通过（0 错误）
- 打包产物内 `app.asar` 复核：preload 中残留符号 0 次；host 中 EPIPE 护栏各 1 次
- 实机运行 + CDP 取证：`rootChildCount=1`、正文正常渲染、控制台零异常
  （修复前为 `rootChildCount=0`、`bodyTextLen=0` 并伴随两条 `ReferenceError`）

## 平台

| 平台        | 产物                          |
| ----------- | ----------------------------- |
| **Linux**   | AppImage / deb / rpm / pacman |
| **Windows** | NSIS（当前未签名）            |

**数据目录**：与官方 ZCode 共享 `~/.zcode/v2`，可并存安装但不建议同时运行。

## 文档

- [与官方发行版的差异](https://github.com/Zcode-CE/Zcode-CE/blob/main/docs/development/official-diff.md)
- [安装说明](https://github.com/Zcode-CE/Zcode-CE#安装)
- [发布与版本号规则](https://github.com/Zcode-CE/Zcode-CE/blob/main/docs/operations/release.md)

---

# English

> **Hotfix release.** Fixes a startup defect in v3.14.1-ce.1 that made the interface
> completely unusable — every artifact of that release stays stuck on the splash logo
> on any platform with any data directory.
> **All v3.14.1-ce.1 users should upgrade.**

## Fixes

### 1. Two independent defects causing the startup hang

Either one alone is enough to prevent the interface from rendering:

| # | Location | Problem |
| - | -------- | ------- |
| 1 | `packages/desktop/src/preload/index.ts` | A leftover call to the removed `scheduleArmsEventBridgePatch()` made the preload script throw `ReferenceError`, so it failed to load and the IPC bridge was left incomplete |
| 2 | `packages/services/src/logger/serviceLogger.ts` | `process.pid` does not exist in a browser context; the module is bundled into the renderer and threw `ReferenceError: process is not defined`, so React never mounted |

### 2. Why it was not caught earlier

The root `typecheck` script only covered `packages/desktop/tsconfig.host.json`;
**`tsconfig.preload.json` was outside type checking**, so the `TS2304` from defect 1
never reached CI. This release adds the preload project to `typecheck`.

### 3. Upstream defect fixed along the way

The official distribution has an asymmetric flaw: `packages/desktop/src/main/logger.ts`
installs an EPIPE guard for the main process (its comment reads "log output must not kill
the main process"), but **the host process has no such guard**. The host is a utilityProcess,
and an uncaught exception there calls `process.exit(1)`; if the inherited stdout/stderr pipe
breaks, the host dies, main does not rebuild it, and the renderer waits forever.
This release ports the same guard to the host side.

## Verification

- `pnpm typecheck` passes (0 errors); `pnpm lint` passes (0 errors)
- Inspected `app.asar` inside the packaged artifacts: 0 occurrences of the leftover symbol
  in preload; EPIPE guard present in host
- Ran the packaged build and verified via CDP: `rootChildCount=1`, content rendered,
  zero console exceptions (previously `rootChildCount=0`, `bodyTextLen=0`, two `ReferenceError`s)

## Platforms

| Platform    | Artifacts                     |
| ----------- | ----------------------------- |
| **Linux**   | AppImage / deb / rpm / pacman |
| **Windows** | NSIS (unsigned)               |

**Data directory**: shared with the official ZCode at `~/.zcode/v2`; both can be installed
side by side, but running them simultaneously is not recommended.
