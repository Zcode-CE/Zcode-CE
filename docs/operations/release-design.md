# 发布设计：包名、构建产物与更新渠道

> 状态：**已实施**（2026-09-21 设计，当日落地）· 平台范围 **Linux + Windows**（macOS 暂不发，无签名证书）
>
> 决策依据：「包名改 ZCode-CE 作区别，构建安装包发布到 release，更新渠道从官方接到我们的仓库」。
>
> 本文保留**设计期视角**：第一、二节的「现状 / 要改成」对照记录当时的决策过程，
> 其中「要改成」「方案选择」描述的是已落地的目标形态。落地后的运维说明见
> [发布流程](./release.md) 与 [持续集成](./ci.md)。

## 一、产品身份

### 1.1 现状

`packages/desktop/scripts/desktop-product-identity.mjs` 定义了两套身份：

| flavor       | appId                   | productName     | linuxExecutableName | linuxPackageName |
| ------------ | ----------------------- | --------------- | ------------------- | ---------------- |
| `production` | `dev.zcode.app`         | `ZCode`         | `zcode`             | `zcode`          |
| `preview`    | `dev.zcode.app.preview` | `ZCode Preview` | `zcode-preview`     | `zcode-preview`  |

### 1.2 要改成

| flavor             | appId                      | productName        | linuxExecutableName | linuxPackageName   |
| ------------------ | -------------------------- | ------------------ | ------------------- | ------------------ |
| `production`（CE） | `dev.zcode.app.ce`         | **`ZCode-CE`**     | `zcode-ce`          | `zcode-ce`         |
| `preview`          | `dev.zcode.app.ce.preview` | `ZCode-CE Preview` | `zcode-ce-preview`  | `zcode-ce-preview` |

### 1.3 ⚠️ 数据影响（已实测，结论：**业务数据不受影响**）

数据目录由 `packages/services/src/paths.ts` 的 `getAppConfigDir()` 决定：

```
getAppConfigDir() = {homedir}/.zcode/v2     ← 硬编码 ".zcode"，与 appId/productName 无关
```

| 路径                        | 内容                                                          | 大小（实测） | 改包名后                      |
| --------------------------- | ------------------------------------------------------------- | ------------ | ----------------------------- |
| `~/.zcode/v2/`              | **全部业务数据**：会话、凭据、任务索引、deviceMid、设置       | **140M**     | ✅ **不受影响**               |
| `~/.config/ZCode/`（Linux） | Electron 运行时：`session/`、`rum-electron-store/`、`sentry/` | 129M         | ⚠️ 变为 `~/.config/ZCode-CE/` |

**关键**：`~/.config/ZCode/` 里主要是**已移除的遥测残留**（`rum-electron-store` / `sentry` / `zcode-data-size-telemetry.json`），唯一有意义的是 `session/`（Electron 窗口状态）。

→ **结论：无需数据迁移**。业务数据路径不变；Electron 窗口状态可丢弃（用户重开窗口的代价）。

### 1.4 与官方版共存

改 `appId` 后，ZCode-CE 与官方 ZCode 是**两个独立应用**，可并存安装、互不干扰。

**但两者共享 `~/.zcode/v2/`** —— 这是设计选择（便于切换），也意味着**不要同时运行两个版本写同一工作区**。需在文档中说明。

## 二、更新渠道

### 2.1 现状（CE 用官方 manifest）

`packages/desktop/src/main/manifestUpdateProvider.ts` 实现了自定义 provider：

| 项   | 值                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| 端点 | `/api/v1/releases/electron/manifest`                                                                       |
| 参数 | `platform` / `arch` / `channel`（`1`=stable，`3`=preview）/ `device_mid`                                   |
| 头   | `Accept: application/x-yaml` + `X-Device-Mid`                                                              |
| 解析 | `parseYaml` → electron-updater 标准 `UpdateInfo`（`files[]` 带 `url`/`sha512`，或 legacy `path`/`sha512`） |

**且打包态忽略 `ZCODE_UPDATE_FEED_URL` 覆盖**（`autoUpdater.ts:703-714`）。

### 2.2 方案选择

| 方案                       | 说明                                                                                                | 评价                        |
| -------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------- |
| **A. GitHub provider**     | electron-builder 原生支持 `publish: { provider: "github", owner, repo }`，产物直接发 GitHub Release | ✅ **推荐**：零额外基础设施 |
| B. generic + 自建 manifest | 自己生成 YAML manifest 放静态托管                                                                   | 需要额外维护                |
| C. 继续用官方 manifest     | 不改                                                                                                | ❌ 与「脱离官方渠道」矛盾   |

**推荐 A**，理由：electron-updater 的 `GitHubProvider` 直接读 Release 的 `latest.yml`（electron-builder 会自动生成），**不需要自建 manifest 服务**。

### 2.3 实施要点（方案 A）—— 已定位到精确改造点

**关键事实**：`applyManifestUpdateProvider` 是**无条件调用**的（`autoUpdater.ts:1507`），**所以改用 GitHub provider 必须改代码，不是只改配置**。

| #   | 位置                                                  | 动作                                                                                                                             |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/desktop/electron-builder.config.js:747-756` | `publish` 由 `{ provider: "generic", url: "http://localhost:8081" }` 改为 `{ provider: "github", owner, repo }`                  |
| 2   | `packages/desktop/src/main/autoUpdater.ts:754-769`    | `applyManifestUpdateProvider` 按构建目标分支：社区版走 electron-updater 原生 `GitHubProvider`，不再注入 `ManifestUpdateProvider` |
| 3   | `packages/desktop/src/main/autoUpdater.ts:1507`       | 调用点保持，但函数内部按分支决定是否 `setFeedURL`                                                                                |
| 4   | 验证                                                  | `electron-builder` 生成的 `latest.yml` 与 `GitHubProvider` 的读取路径一致；实际发布一个版本验证升级链路                          |

**保留 `ManifestUpdateProvider` 文件本身**（不删）—— 它是官方 manifest 协议的实现，未来若要支持自建更新服务可复用。

### 2.4 更新源覆盖（已定）

打包态忽略 `ZCODE_UPDATE_FEED_URL` 的行为**已放开**，改为「仅忽略非 https」：
打包态接受 https 覆盖，非 https 取值被忽略并记一条 `warn`。理由与安全约束见第五节第 1 条。

## 三、构建与产物

### 3.1 构建流程与产物（已实施）

#### 两条构建入口，用途不同

| 命令                  | 产物                         | 用途                                    |
| --------------------- | ---------------------------- | --------------------------------------- |
| `pnpm bundle:desktop` | 桌面安装包（AppImage/deb/…） | **发布用**，见 [发布流程](./release.md) |
| `pnpm build:zcode`    | `dist/zcode/` 服务端 tar 包  | 服务端分发，与桌面安装包无关            |

两者互不依赖。桌面发布只需 `bundle:desktop`。

#### `bundle:desktop` 内部流程

```bash
pnpm bundle:desktop --os <mac|win|linux> --arch <x64|arm64>
```

该脚本（`packages/desktop/scripts/bundle.mjs`）**依次**执行五步，不要在其前后重复跑 prepare/build：

| #   | 阶段                          | 说明                                 |
| --- | ----------------------------- | ------------------------------------ |
| 1   | `prepare:runtime-assets`      | 准备运行时资产（约 10 分钟，最耗时） |
| 2   | `build`                       | 构建各包                             |
| 3   | `electron-builder`            | 打包，带 3 次重试与心跳日志          |
| 4   | `verify-runtime-dependencies` | 机械校验必需运行时模块已进包         |
| 5   | `audit-bundle-size`           | 体积审计，超限则**构建失败**         |

两个易踩点：

1. **`--os` 必须显式传**。`DEFAULT_TARGET_OS` 是 `"mac"`、`DEFAULT_TARGET_ARCH` 是 `"arm64"`；
   不传会静默产出 macOS 包。也可用 `ZCODE_TARGET_OS` / `ZCODE_TARGET_ARCH` 环境变量。
2. **不要再补 `--`**。`bundle:desktop` 的定义末尾已有 `--`，再加一个会让参数变成位置参数被丢掉。

体积审计的上限（`scripts/audit-bundle-size.mjs`）：`AppImage`/`deb`/`dmg`/`zip`/`exe` 均为
**500 MiB**，其它扩展名走 `default` 同样是 500 MiB。超限即退出码 1。

#### Linux 产物：4 种格式

`electron-builder.config.js` 的 `linux.target` 为 `["AppImage", "deb", "rpm", "pacman"]`。
本机实测 `pnpm bundle:desktop --os linux --arch x64` 产出：

| 格式     | 文件                                         | 体积      |
| -------- | -------------------------------------------- | --------- |
| AppImage | `ZCode-CE-3.14.1-ce.1-linux-x86_64.AppImage` | 176.5 MiB |
| deb      | `ZCode-CE-3.14.1-ce.1-linux-amd64.deb`       | 133.4 MiB |
| rpm      | `ZCode-CE-3.14.1-ce.1-linux-x86_64.rpm`      | 110.1 MiB |
| pacman   | `ZCode-CE-3.14.1-ce.1-linux-x64.pkg.tar.zst` | 117.4 MiB |

产物命名规则为 `${productName}-${version}-linux-${arch}.<ext>`。解包目录
（`linux-unpacked/`）另有约 612 MiB，属中间产物。

两个格式特例：

- **pacman 的扩展名是 `.pkg.tar.zst`**，不是 electron-builder 默认的 `.pacman`；由 fpm 调用
  `bsdtar` 生成，构建机需有 `libarchive-tools`。
- **rpm 需要 `rpmbuild`**（`rpm` 包），且额外 `-d mesa-libgbm -d alsa-lib` —— electron-builder 的
  rpm 默认 `Requires` 不含 Electron ELF 实际依赖的这两个库，最小化容器装完会启动失败。

#### Windows 产物：只有 nsis

`win.target` 为 `["nsis"]`，产出单个 `.exe` 安装包。

> **修正**：早先设计中列的 `portable` **没有配置**，`target` 里只有 `nsis`。若将来要加，
> 需同时考虑 `portable` 不写注册表、不走安装器，更新链路需另行验证。

**Windows 包无法在 Linux 上交叉打包**：原生依赖（`node-pty` 预编译产物、`bundled-tools` 里的
ripgrep 等）按平台分目录准备，Linux 机器上拿不到 Windows 的原生产物，必须由 `windows-latest` 产出。

#### 产物名后缀与身份

产物名只标记**后端环境**：测试后端加 `_TEST`，生产后端无后缀。身份（正式 / Preview）靠
`productName` 区分，不体现在后缀里：

| 场景                | 产物名示例                                                |
| ------------------- | --------------------------------------------------------- |
| 生产后端 + 正式身份 | `ZCode-CE-3.14.1-ce.1-linux-x86_64.AppImage`              |
| 测试后端 + Preview  | `ZCode-CE Preview-3.14.1-ce.1-linux-x86_64_TEST.AppImage` |

#### CI 上的构建

发布构建由 GitHub Actions 承担（Linux x64 + Windows x64 矩阵），流程、额外系统依赖与踩坑点
见 [持续集成](./ci.md)。

### 3.2 签名

| 平台    | 状态                                                                       |
| ------- | -------------------------------------------------------------------------- |
| Linux   | 不需要                                                                     |
| Windows | **无证书** → 触发 SmartScreen 警告。**需在文档中说明**，用户点「仍要运行」 |
| macOS   | 不发布                                                                     |

## 四、已定事项

1. **版本号策略**：`3.14.1-ce.1` —— 保留上游版本号 + CE 后缀，表明"基于上游 3.14.1 的第 1 次社区发布"。
   - 实现位置：根 `package.json` 的 `version`（唯一权威来源，传播到 `build-meta.json` → `__ZCODE_VERSION__`）
   - ⚠️ **发布纪律**：版本号后缀必须保持一致。`3.14.1-ce.1` 含预发布标识会让 electron-updater 的 `allowPrerelease=true`，
     先去取 `ce-linux.yml`（404 后回退 `latest-linux.yml`，功能正常但多一次请求）。实测若同时存在 `v3.15.0`
     与 `v3.14.2-ce.1`，会选中后者（**channel 匹配优先于版本高低**）。
2. **发布仓库**：`Zcode-CE/Zcode-CE`（组织仓库）。
3. **CI**：GitHub Actions 自动构建（Linux x64 + Windows x64）。
4. **数据目录**：与官方版共存可行，但**不建议同时运行**（两者共享 `~/.zcode/v2` 业务数据）。
5. **强更门**：**社区版禁用**远端强制升级检查（见 `packages/desktop/src/main/index.ts` 的说明）——
   官方下发的 `minimalVersion` 面向官方发行版，命中后会阻止创建主窗口，失败模式是"应用完全打不开"。

## 五、待确认

1. 打包态忽略 `ZCODE_UPDATE_FEED_URL` 的行为是否保留？
   - **已定**：改为"仅忽略非 https"，即打包态**接受 https 覆盖**。原因：GitHub provider 只接受
     `{owner, repo, host}` 三元组、会丢弃 URL 的路径部分，因此路径前缀镜像（`ghfast.top` 这类）
     **无法**作用于更新链路；用户与企业内网需要靠 feed URL 覆盖指向镜像或自建源。
     安全约束由"只接受 https"承担（更新产物要下载并执行，允许 http 等于让链路可被中间人替换）。
