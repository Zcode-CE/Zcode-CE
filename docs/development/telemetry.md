# 遥测与隐私

## 本版的立场

ZCode-CE 移除了官方发行版中的遥测与监控组件。判断方式不是「删哪些模块」，而是**按数据流向与触发方分类**：

| 分类                               | 处置                             |
| ---------------------------------- | -------------------------------- |
| 与官方服务相关 **且** 后台自动发生 | **删除**                         |
| 与官方服务相关 **但用户主动触发**  | **重构为可配置**，默认指向本项目 |
| 与官方服务无关                     | 不在改造范围                     |
| 既承担遥测、又有本地用途的耦合组件 | **重构剥离遥测，保留本地能力**   |

## 移除范围

移除工作分为五个提交，按依赖关系自底向上推进：

| 提交      | 内容                                                                    |
| --------- | ----------------------------------------------------------------------- |
| `f3592e6` | 删除实现本体：ARMS/RUM、OTLP 链路、Host 资源上报、崩溃远端通道          |
| `7896d3a` | 清理依赖与构建入口：`@arms/rum-electron`、`@opentelemetry/*`、tsup 入口 |
| `9fc3946` | 清理 main 侧调用点，保留本地诊断链路                                    |
| `93db609` | 清理 UI 与 shared 层残留：通道常量、埋点采集点、ARMS 环境映射           |
| `f01fb20` | 清理进程资源采样中与上报绑定的 13 个模块                                |

被删除的组件按类别：

| 类别         | 代表模块                                                                           |
| ------------ | ---------------------------------------------------------------------------------- |
| 前端监控 SDK | `appARMSBootstrap`、`armsEventRedaction`、`armsUserIdentity`、`@arms/rum-electron` |
| OTLP 链路    | `apps/zcode-cli/packages/telemetry/` 整包（含 `otlp-exporter`）                    |
| Host 资源    | `hostNetworkTelemetry`、`hostSelfResourceTelemetry` 等 9 个模块                    |
| main 资源    | `desktopResourceTelemetry`、`desktopStabilityTelemetry` 等                         |
| 业务埋点     | `messageTelemetry`、`sendFunnelArmsTelemetry`、`userActionTelemetry` 等 UI 侧模块  |
| 崩溃上报     | 远端通道删除；本地归档保留（见下）                                                 |

## 保留的能力（不是遥测）

以下能力看起来与遥测相关，但实际承担本地功能，**本版保留**：

| 项                                                | 原因                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `deviceMid`（`~/.zcode/v2/telemetry-state.json`） | 是 `X-Device-Mid` 计费头与流客户端标识的来源。**文件名沿用历史命名，但只承载设备身份** |
| 崩溃本地归档（`~/.zcode/v2/crash/archive`）       | 本地排障，`uploadToServer: false`                                                      |
| 内存诊断日志（`[memory]`）                        | 本地日志，不上报                                                                       |
| `envelope.ttft` 协议字段                          | 协议契约，删除会导致两端解析失败                                                       |
| `codingPlanFunnelTelemetry` 的购买归因 context    | 权益链路，非上报                                                                       |

`telemetry-state.json` 的**文件名必须保持**：CLI、Desktop、远端 server 三端共用同一路径与字段，
改名等于重置所有存量用户的设备身份，`X-Device-Mid` 随即丢失、权益领取失败。
文件内**只保留 `deviceMid`**；官方版曾写入的 `lastDailyActiveDate` 等日活上报字段已随
`telemetryCore.ts` 一并删除，本版不再读写。

## 验证

分四层，任一层命中都说明移除不完整。以下命令均从仓库根目录执行。

### 1. 源码层：符号与端点扫描

```bash
grep -rn 'ZCODE_TELEMETRY_ENABLED\|ZCODE_TELEMETRY_REPORT_ENDPOINT\|ZCODE_ARMS_RUM_ENDPOINT\|mapZCodeEnvToArmsRumEnv' \
  --include='*.ts' --include='*.tsx' packages/*/src apps/*/packages/*/src
```

**预期结果**：只在注释里命中 3 行，无任何可执行引用。

```
packages/desktop/src/main/index.ts:1983:  // 「ZCODE_TELEMETRY_ENABLED && ZCODE_ARMS_RUM_ENDPOINT」下的 stability / resource / network
packages/shared/src/env.ts:45:// 遥测已全部移除（P1）：ZCODE_TELEMETRY_ENABLED / ZCODE_TELEMETRY_REPORT_ENDPOINT /
packages/shared/src/env.ts:46:// ZCODE_ARMS_RUM_ENDPOINT / mapZCodeEnvToArmsRumEnv / ArmsRumEnv 均已删除。
```

这三个常量本身已不存在于 `packages/shared/src/env.ts`，该文件现在只导出产品身份与环境判定。

> **pathspec 陷阱**：不要用 `git grep -n 'x' -- 'packages/*/src'`。这种 pathspec 会静默漏掉文件
> （返回码 1，看起来像「没有命中」）。用 `-- packages apps` 这类目录前缀，或直接用上面的 `grep -rn`。

### 2. 依赖层：lockfile 与包清单

```bash
grep -c '@arms/' pnpm-lock.yaml          # 预期 0
grep -c 'otlp' pnpm-lock.yaml            # 预期 0
grep -rn '@arms\|@opentelemetry' package.json packages/*/package.json   # 预期无输出
```

**预期结果**：ARMS 与 OTLP 均为 0。

```bash
grep -c '@opentelemetry/' pnpm-lock.yaml # 预期 4
```

**这一条非 0 是正常的**：残留的 `@opentelemetry/api@1.9.0` 是 Vercel AI SDK（`ai` 包）的生产依赖，
不是本项目的上报通道。移除它会让 `ai` 解析失败。判定标准是「谁引入它」，不是「包名里有没有 opentelemetry」：

```bash
pnpm why @opentelemetry/api   # 预期只列出 ai@*
pnpm why @arms/rum-electron   # 预期空输出
```

### 3. 产物层：安装包扫描

打包后扫描 `app.asar` 的文件清单，确认上报 SDK 未随包分发：

```bash
npx --no-install @electron/asar list packages/desktop/dist/linux-unpacked/resources/app.asar > /tmp/asar-list.txt
wc -l < /tmp/asar-list.txt          # 本机实测 27869
grep -ci arms /tmp/asar-list.txt    # 预期 0
grep -ci otlp /tmp/asar-list.txt    # 预期 0
```

**预期结果**：`arms` 与 `otlp` 均为 0。`@opentelemetry/api` 会作为 `ai` 的传递依赖出现，
属上一条同一原因，不是上报通道。

也可直接扫描 agent 运行时 bundle（`apps/zcode-cli/packages/cli/dist/zcode.cjs`）：

```bash
grep -c 'ARMS_RUM' apps/zcode-cli/packages/cli/dist/zcode.cjs   # 预期 0
```

### 4. 运行期：产物内容与出网端点

解包 `app.asar` 后**按内容**扫描，而不只是看文件清单。这一步能抓到「文件名不含 arms，
但代码里仍保留上报逻辑」的情况：

```bash
rm -rf /tmp/asarx && npx --no-install @electron/asar extract \
  packages/desktop/dist/linux-unpacked/resources/app.asar /tmp/asarx
grep -rl 'electron initialized' /tmp/asarx/ | wc -l   # 预期 0
grep -rl 'ARMS_RUM\|rum-electron' /tmp/asarx/ | wc -l  # 预期 0
grep -rl 'otlp-exporter' /tmp/asarx/ | wc -l           # 预期 0
```

**预期结果**：三项均为 0。本机实测即 0。

官方版启动时会打一行 ARMS 初始化日志，本版**没有任何代码能打出这一行**：

```bash
grep -rn 'electron initialized' packages/*/src apps/*/packages/*/src   # 预期 0 命中
```

**对照实验**（同一台机器、同一 `~/.zcode/v2/logs/` 目录）。日志里确实存在 ARMS 初始化记录，
但它们全部来自**官方版的安装路径**，不是本版构建：

```bash
grep -rh '\[arms\]' ~/.zcode/v2/logs/*.log | grep -o 'version=[0-9a-z.-]*' | sort | uniq -c
```

```
      1 version=3.12.3
     18 version=3.14.0
```

只出现官方版本号 `3.12.3` / `3.14.0`，**没有任何一行来自 `3.14.1-ce.1`**。逐进程核对可确认
这些行由官方安装目录写出：

```bash
grep -rh 'deep-link.*entry' ~/.zcode/v2/logs/*.log | grep -o '"entry":"[^"]*"' | sort | uniq -c
```

```
     13 "entry":"/usr/lib/zcode/app.asar"
```

`/usr/lib/zcode/app.asar` 是官方版安装位置；本版的 `app.asar` 位于解包目录
`packages/desktop/dist/linux-unpacked/resources/`。同一份日志里 `3.14.1-ce` 出现 0 次。

出网端点侧，业务请求只应命中 ZCode 服务本体：

```bash
grep -oh '"url":"https\?://[^"]*"' ~/.zcode/v2/logs/2026-09-2*.log \
  | sed 's/.*"url":"//; s/"$//' | sed -E 's|https?://([^/]*).*|\1|' | sort -u
```

```
zcode.z.ai
```

**预期结果**：只有 `zcode.z.ai`（计费与套餐额度查询，用户主动触发的权益链路），
没有 ARMS/RUM 或 OTLP 收集端。

### 已知残留

以下标识符保留了历史命名或定义，但**不构成上报路径**。扫描时命中它们属预期：

| 位置                                                                  | 说明                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/processResourceTelemetry.ts`                     | 仍导出事件名与属性键表。其中 `PROCESS_RESOURCE_CLI_LANES` 被 `validation.ts` 消费，其余常量仅模块内自用 |
| `packages/shared/src/validation.ts` 的 `armsCustomEventPayloadSchema` | 定义仍在，但未从 `index.ts` 再导出，也无消费方                                                          |
| 多处源码注释                                                          | 形如「遥测移除（P1）：…」，记录删除原因与保留理由，是刻意的                                             |

## 反馈渠道

用户主动提交反馈时，默认生成 **GitHub Issues 预填链接**，可在设置页「反馈与诊断」中改为自定义地址或关闭。预填内容**不含** deviceMid、账号标识、凭据与完整日志。详见 [反馈与诊断](../community/feedback.md)。
