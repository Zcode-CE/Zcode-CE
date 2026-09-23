# 持续集成与发布构建

本仓库用 GitHub Actions 承担两件事：日常校验（`ci.yml`）与发布打包（`release.yml`）。
两者都在 `.github/workflows/` 下，无需自建 runner。

## 为什么发布必须走 CI

**Windows 安装包（nsis）无法在 Linux 上交叉打包。** 桌面端的原生依赖（`node-pty` 预编译产物、
`bundled-tools` 里的 ripgrep 等）按目标平台分目录准备，Linux 机器上拿不到 Windows 的原生产物。
因此 Windows 包只能由 `windows-latest` runner 产出，不能靠本地打完再传。

## `ci.yml` — 日常校验

在 `main` 的 push 与所有 pull request 上运行，串行执行：

| 步骤     | 命令                                       |
| -------- | ------------------------------------------ |
| 类型检查 | `pnpm typecheck`                           |
| Lint     | `pnpm lint`                                |
| 格式检查 | `pnpm fmt:check`                           |
| 测试     | `pnpm test`                                |
| 架构检查 | `pnpm run architecture:check -- --changed` |
| 构建检查 | 见下方「构建检查」                         |

用 `fetch-depth: 0` 做完整克隆，因为 `architecture:check --changed` 需要与基线比较变更集，
浅克隆会让它算错改动范围。

**刻意不跑 `pnpm licenses:check`**：它比对的平台包集合与 runner 平台相关，
在 CI 环境会因平台差异产生与改动无关的失败。

### 构建检查（Build check (agent bundle)）

```bash
shopt -s nullglob
rm -rf apps/zcode-cli/packages/*/dist packages/desktop/bundled-agents
node scripts/build-desktop-agent-cli.mjs
test -s apps/zcode-cli/packages/cli/dist/zcode.cjs
```

**为什么存在**：上面五步**都不解析打包器的模块解析**。`pnpm typecheck`（tsc/NodeNext）与
`pnpm test`（`tsx --test`）按各包 `package.json` 的 `exports` 解析模块，而 agent bundle 走的是
**手写白名单 + 前缀改写**的 esbuild 别名表（`apps/zcode-cli/packages/cli/scripts/build.mjs`
的 `resolveBuildAliases`）。两条链路互不相干，于是「源码级全绿、构建级红」可以一路漂到打包才暴露。

**实测过一次完整漂移**：新增 shared 子路径 `@zcode/shared/mcpDisabledTools` 时漏登记别名，
上面五步全部通过，而 `prepare:remote-assets`、桌面 agent 打包、SEA 打包**三条链同时断**，
报错是 esbuild 把子路径拼到总入口后面：

```
✘ [ERROR] Cannot read directory ".../packages/shared/src/index.ts": not a directory
✘ [ERROR] Could not resolve ".../packages/shared/src/index.ts/mcpDisabledTools"
```

**能抓住哪类失败**：

| 类别                  | 例子                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 打包期模块解析        | 新增/改名的 `@zcode/shared/<subpath>`、`@zcode/*` 子路径或 workspace 包入口漏登记 esbuild 别名                                                                                                                  |
| 打包产物生成          | 入口图里出现打包器解不开的东西。**真实候选**：`@zcode/node-repl-host` 的 `exports` 各条都没有 `import` 条件、直接指向 `./src/*.ts`（实测命令见下），一旦有打包入口图把它当普通依赖解析就会挂，而 `tsc` 完全正常 |
| 独立 runtime 产物校验 | `node-repl-host/dist/mcp/server.js`、`browser-use-plugin/scripts/browser-client.mjs` 缺失时报错                                                                                                                 |
| 构建期断言            | 构建脚本内部对 workspace 包产物/清单的校验（例如 shared 必须钉一个精确的 zod v4 版本）                                                                                                                          |

**先删 dist 是刻意的**：不删 `dist` 时构建可能直接打到上一次留下的产物，别名错误因此**看不见**（实测过这种假通过）。

上面那条 `node-repl-host` 的候选可以用一段只读脚本复核（它只解析 `package.json` 的 `exports` 形状）：

```bash
node -e "for (const p of ['node-repl-host','core','adapters']) {
  const e = require('./apps/zcode-cli/packages/'+p+'/package.json').exports ?? {};
  for (const [k, v] of Object.entries(e))
    if (typeof v === 'object' && v && !('import' in v)) console.log(p + k + ' -> ' + JSON.stringify(v));
}"
```

**实测代价**（本仓库 Linux 开发机、Node 24；CI 为 ubuntu-latest，量级相同）：

| 项目                         | 实测                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| 这步新增的墙钟时间           | **约 32–35s**（`pnpm typecheck` 之后、干净 dist 上跑：32s / 31s / 35s 三次） |
| 其中 library 的 tsc          | 约 27s（7 个 workspace 包全量重编译，它是 bundle 的前置条件，删不掉）        |
| 其中两个独立 runtime 构建    | 约 4s                                                                        |
| 其中 esbuild 打 agent bundle | < 1s                                                                         |
| 联网/大资产                  | **无**（全部来自 workspace 与 `node_modules`；不下载 Node 运行时）           |

**为什么不用 `pnpm prepare:remote-assets`**：它会下载 Node 运行时并写约 500MB 的 `mock-cdn`，
还要为每个平台产一份 seed，不适合每次 PR。这里选的是它的**前段**（同一份
`scripts/build-desktop-agent-cli.mjs`），只覆盖当前平台的 agent bundle。

**与 `release.yml` 的关系（重要）**：这步**不是**发布构建，也不是它的替代。
它只证明「模块能被正确解析并打出 agent bundle」；发布构建还会做平台化 seed、远程资产装配、
安装包生成与产物审计（见下一节）。**CI 绿不等于可以发版**。

**本地无法完整验证的部分**：GitHub Actions 只能在 GitHub runner 上执行，本地无法运行工作流本身；
这步的命令级行为已在本地按原样跑过（含负对照，见下），但 job 整体仍需在真实 PR 上确认一次。

## `release.yml` — 发布打包

### 触发

| 触发方式            | 行为                                              |
| ------------------- | ------------------------------------------------- |
| push tag `v*`       | 构建两个平台并发布到 GitHub Release               |
| `workflow_dispatch` | 只构建并上传 artifact，不新建 Release（用于演练） |

Tag 采用 `v` 前缀（如 `v3.14.1-ce.1`），与 electron-builder 默认的 `vPrefixedTagName` 一致。

### 矩阵

| runner           | 目标                    | 产物                                           |
| ---------------- | ----------------------- | ---------------------------------------------- |
| `ubuntu-latest`  | `--os linux --arch x64` | `.AppImage` / `.deb` / `.rpm` / `.pkg.tar.zst` |
| `windows-latest` | `--os win --arch x64`   | `.exe`（nsis）                                 |

矩阵**串行执行**（`max-parallel: 1`）。原因是两个平台都会调用 electron-builder 的 GitHub
publisher，而它「先列 Release 再创建」，创建失败没有重试；并行时两边可能同时创建同一个 tag 的
Release，后者以 422 失败并中断构建。代价是总时长约为两平台之和。

### Linux 额外依赖

```bash
sudo apt-get install -y rpm libarchive-tools
```

- `rpm`：提供 `rpmbuild`。缺失时 electron-builder 在 rpm 阶段报
  `Need executable 'rpmbuild' to convert dir to rpm`。
- `libarchive-tools`：提供 `bsdtar`。pacman 目标（`.pkg.tar.zst`）由 fpm 调用
  `bsdtar` 生成，CI 镜像不保证预装。

Windows runner 无额外系统依赖。

### 构建命令

```bash
pnpm install --frozen-lockfile
pnpm bundle:desktop --os <linux|win> --arch x64
```

两点容易踩：

1. **不要再补 `--`**。`bundle:desktop` 的定义是
   `pnpm --filter @zcode/desktop run bundle --`，末尾已有 `--`。再加一个会让参数变成位置参数，
   `bundle.mjs` 回退到默认目标 `mac/arm64` 并**静默失败**。
2. **`--os` 必须显式传**。`scripts/bundle.mjs` 的 `DEFAULT_TARGET_OS` 是 `"mac"`。

同理，不要把 electron-builder 的 `--publish`、`--config` 等参数透传给 `bundle:desktop`：
`bundle.mjs` 的 `parseArgs` 会把无法识别的参数收进位置参数，进而当作 `--os` 取值并抛错。

`bundle.mjs` 内部已依次执行 `prepare:runtime-assets` → `build` → electron-builder →
产物校验 → 体积审计，**不要在它之前重复跑一遍 prepare/build**（资产准备约 10 分钟）。

### 产物与更新清单

electron-builder 为每个平台生成更新清单，必须与安装包上传到**同一个** Release：

| 平台    | 更新清单           | 安装包                                |
| ------- | ------------------ | ------------------------------------- |
| Linux   | `latest-linux.yml` | `AppImage` / `deb` / `rpm` / `pacman` |
| Windows | `latest.yml`       | `nsis`                                |

差分块 `.blockmap` 必须一并上传，否则 electron-updater 的差分下载退化为全量包。
工作流把安装包与清单同时上传为 artifact，便于 Release 需要人工补发时取用。

### 发布状态

`electron-builder.config.js` 里 `releaseType: "release"`，产物直接进正式 Release。
**不能改成 draft**：draft 对 electron-updater 完全不可见（`releases.atom` 与
`/releases/latest` 都不返回），会让更新链路静默失效。

需要临时改成 draft 或预发布时用 `EP_DRAFT` / `EP_PRE_RELEASE` 环境变量覆盖。

### 重跑已发布超过 2 小时的 tag

electron-publish 对已存在的 Release 有一条时间保护：发布时间超过 2 小时就**只打 warn 并跳过上传**，
构建仍然显示成功。工作流设置了 `EP_GH_IGNORE_TIME: "true"` 让重跑真正覆盖上传。

### 权限

```yaml
permissions:
  contents: write
```

使用 Actions 自带的 `secrets.GITHUB_TOKEN`，不需要额外 PAT。构建步骤显式注入
`GH_TOKEN`，因为 electron-builder 的 GitHub publisher 读的是这个变量名。

## 本地无法验证的部分

GitHub Actions 只能在 GitHub 的 runner 上执行，**本地无法运行**。因此工作流文件的改动
只能做 YAML 语法校验与命令级核对，真实运行结果需要在第一次打 tag 时确认。
