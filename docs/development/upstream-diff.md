# 与上游的差异

## 上游

ZCode-CE 基于 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0，创建于 2026-09-20）。
本仓库是它的 fork，**保持 fork 关系**以保留溯源与同步能力。

> 逐条回答「开源版是不是缺功能」的对照说明见 [与官方发行版的差异](./official-diff.md)；
> 本文说明**改了什么、为什么改、如何同步**。

## 改动概览

相对上游基线 `872ad96`（`feat: open source`），本仓库已累积 194 个提交、826 个文件变更
（+99364 / −28229 行，2026-09-25 快照）。下面六类里的**提交哈希与文件清单是各自的落地时刻**，
行数分布表则是 2026-09-22 的旧快照，只用于看相对量级。改动按主题分为六类。

> 计数核对方式：`git rev-list --count 872ad96..HEAD` 与 `git diff --shortstat 872ad96 HEAD`。
> 这两个数字随每次提交增长，引用前请重新执行 —— 本节其余数字同理。

### 1. 移除遥测与监控（178 文件，+839 / −21505）

按「数据流向 + 触发方」判定，而非按模块名。五个提交自底向上推进：

| 提交      | 内容                                                           |
| --------- | -------------------------------------------------------------- |
| `f3592e6` | 删除实现本体（ARMS/RUM、OTLP、Host 资源上报、崩溃远端通道）    |
| `7896d3a` | 清理依赖与构建入口（`@arms/rum-electron`、`@opentelemetry/*`） |
| `9fc3946` | 清理 main 侧调用点，保留本地诊断能力                           |
| `93db609` | 清理 UI 与 shared 层残留                                       |
| `f01fb20` | 清理进程资源采样中与上报绑定的 13 个模块                       |

主要删除位置：

| 目录                                      | 内容                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `apps/zcode-cli/packages/telemetry/`      | OTLP 链路整包（`bootstrap`、`otlp-exporter` 等）  |
| `packages/desktop/src/main/`              | `appARMSBootstrap`、`desktopResourceTelemetry` 等 |
| `packages/desktop/src/host/`              | `hostNetworkTelemetry` 等 9 个上报模块            |
| `packages/services/src/telemetry/`        | `telemetryCore`                                   |
| `packages/ui/src/lib/`                    | `messageTelemetry`、`userActionTelemetry` 等埋点  |
| `packages/shared/src/`                    | `telemetry.ts`、`remoteUsageTelemetry.ts` 等      |
| `patches/@arms__rum-electron@0.0.3.patch` | 随依赖一并移除                                    |

验证方法与保留项边界见 [遥测与隐私](../development/telemetry.md)。

### 2. 补齐官方服务权益（13 文件，+2659）

保留官方服务权益（套餐额度、领取、额度重置），补齐「手动领取套餐」的前端链路：

| 层       | 文件                                                         |
| -------- | ------------------------------------------------------------ |
| shared   | `manual-claim-plan.ts`（协议与纯函数）                       |
| services | `manualClaimPlanClient.ts`、`manualClaimCaptcha.ts`          |
| ui       | `ManualClaimPlanCard.tsx`、`ManualClaimCaptchaDialog.tsx` 等 |

另有 `8225921` 补齐官方 3.14.1 的两项修复（onboarding 记录与 composer 适配），
同时完成遥测调用点清理。

### 3. 模型列表（18 文件，+1601 / −71）

- 允许隐藏内置模型：`hiddenModelIds` 存**个人层**而非内置层，过滤放在 `ProviderConfigResolver`，
  设置列表与模型选择器同时生效；提供恢复入口，避免不可逆
- 支持从任意兼容供应商拉取模型列表：端点推导与响应解析在 `packages/shared`（纯函数），
  发请求在 Host 侧（renderer 直连会被 CORS 拦截）
- 支持 `openai-chat-completions` / `anthropic-messages` / `openai-responses` 三种格式

### 4. 反馈与诊断（10 文件，+1889）

反馈不再固定走官方工单系统，改为可配置渠道（默认本项目 GitHub Issues）：

| 文件                             | 作用                                     |
| -------------------------------- | ---------------------------------------- |
| `feedbackEntryPlan.ts`           | 纯函数编排层，入口与设置页共用同一条路径 |
| `useFeedbackEntryAction.ts`      | 入口点击的唯一动作实现                   |
| `FeedbackDiagnosticsSection.tsx` | 独立的「反馈与诊断」设置分区             |

安全边界 fail-closed：仅允许 `http/https`，`javascript:` / `data:` / `file:` 一律拒绝；
入口现场文本统一过 `redactFeedbackText`，避免凭据进入对外可见的 URL。
详见 [反馈与诊断](../community/feedback.md)。

### 5. 能力替换：Office 与 Computer Use

**Office（22 文件，+2025）**：官方 Office 插件许可为「非商业，禁止商用」，不能随本仓库分发，
改用 MIT 许可的 DeepSeek Harness skill-office 实现。三个插件
（`documents-plugin` / `presentations-plugin` / `spreadsheets-plugin`）各含
`skills/`、`scripts/check_office.py`、`agents/visual-judge.md` 与 `LICENSE.dsh`。

**Computer Use（21 文件）**：官方 helper 二进制完全无许可标注，且不支持 Linux
（`resolveCuaHelperInstallPlan` 与 `resolveWindowsCuaRuntime` 都按平台硬抛），
改用 MIT 许可的 `@trycua/cua-driver`。这是一层**协议翻译**而非转发：ZCode 的模型可见面是
14 个 capability method，驱动暴露 59 个 MCP 风格工具。详见
[Computer Use](../development/computer-use.md)。

### 6. 发布准备与 CI（12 文件）

- **产品身份**：`appId`/`productName` 改为 `dev.zcode.app.ce` / `ZCode-CE`，与官方版并存安装
- **更新渠道**：`electron-builder` 的 `publish` 改为 GitHub provider（本项目 Release），
  不再依赖官方 manifest 服务
- **国内加速**：新增 `AppSettings.githubMirrorPrefix`（默认空 = 关闭）
- **强更门**：社区版不执行远端强制升级检查
- **CI**：`.github/workflows/ci.yml`（日常校验 **+ 一步最小构建**：`node scripts/build-desktop-agent-cli.mjs`，用于抓构建期模块解析/打包产物生成失败 —— 这类问题在 typecheck/test 里完全不可见）与 `release.yml`（发布打包，另含 tag-only 的 `remote-assets` job）

详见 [发布流程](../operations/release.md) 与 [持续集成](../operations/ci.md)。

### 改动分布（2026-09-25 快照）

| 目录                      | 文件数 |
| ------------------------- | ------ |
| `apps/zcode-cli/packages` | 220    |
| `packages/ui`             | 176    |
| `packages/desktop`        | 148    |
| `packages/services`       | 87     |
| `packages/shared`         | 38     |
| `docs`                    | 30     |
| `packages/server`         | 29     |
| `third-party`             | 22     |
| `packages/zcode-cua`      | 11     |

> 只列前九项，复算方式：`git diff --numstat 872ad96 HEAD | awk '{print $3}'` 后按目录前缀归并。
> 这张表随每次提交增长，引用前请重新执行。

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

| #   | 项                                                                          | 严重度 | 状态                                                            |
| --- | --------------------------------------------------------------------------- | ------ | --------------------------------------------------------------- |
| 1   | `tsconfig.main.json` 的 `rootDir` 越界（`tsc -b` 会把编译产物写进 `src/`）  | 高     | ✅ 已修（`18948a9` 补 `noEmit`）                                |
| 2   | `pnpm typecheck` 的工程列表不含 desktop main/renderer                       | 中     | ✅ 已修（`8549509` 纳入 main/renderer/scheduler）               |
| 3   | desktop main/renderer 存在既有类型错误                                      | 中     | ✅ 已修（`ce03e36` main 77→0、`5cbe4cd` renderer/scheduler）    |
| 4   | `packages/ui` 的 `@/*` 别名导致测试必须从包目录内执行                       | 低     | ⬜ 仍存在                                                       |
| 5   | `THIRD-PARTY-NOTICES.md` 仍有材料待补齐（`licenses:check --strict` 不通过） | 中     | ⬜ 仍存在（**条数以 `third-party/inventory.json` 为准**，见下） |

技术债 #1 的历史规避方式（**已由 `noEmit` 修掉**，保留作为背景）：不要对
`packages/desktop` 使用 `tsc -b`，改用 `tsc -p <cfg> --noEmit` 或
`scripts/desktop-typecheck-baseline.sh`。

技术债 #3 已修完，**这里不抄数字**（同 #5 的理由：写死必然过期）。取当前值：

```bash
bash scripts/desktop-typecheck-baseline.sh current   # 结果写在 .reverse/16-typecheck-baseline/current.*.txt
bash scripts/desktop-typecheck-baseline.sh diff      # 只报相对 HEAD 的新增（改动 desktop 后跑这条）
```

**2026-09-27 复核**：`tsc -p packages/desktop/tsconfig.main.json --noEmit` 与
`tsc -p packages/desktop/tsconfig.renderer.json --noEmit` **均 exit 0、0 个 error TS**。
（复核方式：先确认 tsc 真的在检查这些文件 —— 往 `src/main/` 与 `src/renderer/src/` 各放一个
故意的类型错误，两边都如期报 `TS2322`，再删掉。）
⚠️ **本段此前写的「main 1 项、renderer 90 项」是 2026-09-22 的旧快照**；
`ce03e36`（main 77→0）与 `5cbe4cd`（renderer 114→0）在**同一天稍晚**就把它们清干净了，
这里没跟着改。另注意旧快照 `.reverse/16-typecheck-baseline/current.*.counts`（mtime 09-22 00:24，
早于 `5cbe4cd` 03:29 / `ce03e36` 03:35，**修之前**的值）已于 2026-10-03 随该目录归档到
`.reverse/archive/16-typecheck-baseline/`——**别拿它当当前值**；脚本下次运行会在
`.reverse/16-typecheck-baseline/` 重新生成。

技术债 #5 的两级判定：

```bash
node scripts/licenses.mjs check           # 基础检查（新鲜度 + 材料档位）
node scripts/licenses.mjs check --strict  # 发布前必须通过
```

⚠️ **基础检查今天就是红的**（2026-09-27 实测，exit 1）：

```text
Error: Third-party input changed: package.json. Run node scripts/licenses.mjs notices
```

根因是 `8b3e459`（fix.1）与 `6d754dc`（fix.2）两次只改 `package.json` 的 `version` 一行，
而没有同批重生成 notices（`third-party/inventory.json` 最后一次重生成是 `fa7c2a6`）。
**本段此前写「基础检查，当前通过」** —— 那是 ce.3 tag 时刻的状态，两次 bump 之后就失效了。
⇒ 别把「基础检查通过」当默认前提，先跑一遍；重生成见 `docs/operations/release.md` §「发布一个版本」第 1 步。

**这个门禁没有 CI 兜底**（`licenses:check` 不在 `ci.yml`、也不在 `release.yml`，理由见 `docs/operations/release.md` 的本地预检一节）——
它红了不会有流水线报出来，只有人手动跑才会发现。

基础检查通过**不等于**合规完成 —— `--strict` 还会列出待补齐材料
（如 `@trycua/cua-driver-*`、`@ubjs/*` 的版本级许可材料，以及 Skia / QuickJS-NG
等原生组件的构建来源）。

**条数不写在这里**（它会随依赖变化而漂移，写死必然过期）。取当前值：

```bash
# 阻断项条数（"待补齐材料"就是这一项）
node -p "require('./third-party/inventory.json').reviewRequired.length"

# 已按两档口径书面声明、不再阻断的条数
node -p "require('./third-party/inventory.json').documentedLimitations.length"
```

字段含义与判定档位见 `third-party/README.md`（它同样规定"确切数字以 `inventory.json` 为准，不要在本文件里抄写数字"）。
