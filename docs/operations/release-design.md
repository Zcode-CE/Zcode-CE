# 发布设计：包名、构建产物与更新渠道

> 状态：**设计稿**（未实施）· 2026-09-21
> 决策依据：用户确认「包名改 ZCode-CE 作区别，构建安装包发布到 release，更新渠道从官方接到我们的仓库」
> 平台范围：**Linux + Windows**（macOS 暂不发，无签名证书）

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

### 2.4 待确认

- 打包态忽略 `ZCODE_UPDATE_FEED_URL` 的行为（`autoUpdater.ts:703-714`）是否要保留？
  - 保留：与官方一致，避免更新源被环境变量改道
  - 放开：便于自建镜像与企业内网部署
  - **建议保留**（安全默认），但在文档中说明可通过构建期配置改更新源

## 三、构建与产物

### 3.1 待补充

- `pnpm build:zcode` / `bundle:desktop` 的实际流程
- Linux 产物：`AppImage` / `deb` / `rpm` / `pacman`（`manifestUpdateProvider.ts` 里已 import 这 4 种 updater）
- Windows 产物：`nsis` / `portable`

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
