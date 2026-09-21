# 发布流程

> 状态：草稿 · 待补充实际发布步骤

## 平台支持

**Linux 与 Windows**。macOS 暂不发布（无代码签名证书，未签名包的用户体验代价过高）。

## 版本号

当前版本：**`3.14.1-ce.1`**，写在根 `package.json` 的 `version` 字段。

采用「**上游版本 + CE 后缀**」的形态：`3.14.1` 表明基于官方 ZCode 3.14.1，`-ce.1` 是本社区版自己的递增序号。这样既便于说明与上游的对应关系，又不会与官方版本号混淆。

### 版本号的来源与传播

版本号只有一个权威来源 —— 根 `package.json` 的 `version`。各构建入口在构建期读取它并注入：

| 构建入口                                             | 注入方式                                                |
| ---------------------------------------------------- | ------------------------------------------------------- |
| `packages/desktop/scripts/build-metadata.mjs`        | 读根 `package.json` → 写 `out/metadata/build-meta.json` |
| `packages/desktop/tsup.config.ts` / `vite.config.ts` | `__ZCODE_VERSION__` ← `buildMetadata.appVersion`        |
| `packages/server/tsup.config.ts` / `build-remote.ts` | `__ZCODE_VERSION__` ← 根 `package.json` 的 `version`    |
| `packages/web/vite.config.ts`                        | `__ZCODE_VERSION__` ← 根 `package.json` 的 `version`    |
| `packages/desktop/electron-builder.config.js`        | `extraMetadata.version` ← `buildMetadata.appVersion`    |

`packages/shared/src/version.ts` 消费这个编译期常量，导出运行时可用的 `ZCODE_VERSION`；未被任何 bundler 注入时（如直接跑测试）回退为 `"0.0.0-dev"`。

`ZCODE_VERSION` 会被用于多处对服务端的标识，例如 `app_version` 请求参数（领取、计费、强更检查等）、诊断与反馈信息。**因此改版本号只需改根 `package.json` 一处**，其余位置会在构建期自动同步。

`apps/zcode-cli/package.json` 使用**独立的版本序列**（`0.16.9`），与产品版本号无关，不要一起改。

### 预发布标识的影响

`3.14.1-ce.1` 是合法的 semver，且带预发布标识（`ce`）。这会带来两处需要留意的行为：

- **更新检查**：`electron-updater` 依据当前版本是否含预发布标识来决定是否允许预发布更新（`AppUpdater` 构造时按 `currentVersion` 计算）。含预发布标识时，更新渠道名取自该标识，`latest.yml` 的读取路径会随之变化。发布产物与更新清单需与此保持一致。
- **强制更新比对**：`packages/shared/src/forceUpdate.ts` 的 `compareSemverVersions` 按 semver 规则比较，**预发布版本低于同号正式版本**（`3.14.1-ce.1 < 3.14.1`）。若远端下发的最低可用版本为正式号，社区版会被判定为需要升级。

## 构建

（待补充：`pnpm build:zcode` / `bundle:desktop` 的实际流程与产物路径）

## 更新渠道

自动更新走 **electron-updater 的原生 GitHub provider**，更新源是本项目自己的 GitHub Release
（`Zcode-CE/Zcode-CE`），不依赖官方更新服务，也不需要自建 manifest 服务。

### 配置在哪

`packages/desktop/electron-builder.config.js` 的 `publish` 段落：

```js
publish: { provider: "github", owner: "zcode-ce", repo: "zcode-ce", releaseType: "release" }
```

打包时 electron-builder 会把这份配置写进安装包的 `app-update.yml`，运行时 electron-updater
直接读它构造 `GitHubProvider`。客户端代码只在需要时覆盖更新源（见下），默认不介入。

### 发布一个版本需要哪些产物

electron-builder 会为每个平台生成更新清单与差分块，**必须一并上传到同一个 Release**：

| 平台    | 更新清单           | 安装包                                |
| ------- | ------------------ | ------------------------------------- |
| Linux   | `latest-linux.yml` | `AppImage` / `deb` / `rpm` / `pacman` |
| Windows | `latest.yml`       | `nsis`                                |

同时要上传对应的 `.blockmap`，否则差分下载退化为全量包。Tag 采用 `v` 前缀（如
`v3.14.1-ce.1`），与 electron-builder 的默认 `vPrefixedTagName` 一致。

**Release 必须是已发布状态，不能是 draft。** draft 对更新检查完全不可见
（`releases.atom` 与 `/releases/latest` 都不返回），会让更新链路静默失效，因此
`releaseType` 显式设为 `release`。需要临时改成 draft 或预发布时用 `EP_DRAFT` /
`EP_PRE_RELEASE` 环境变量覆盖。

### 更新源覆盖（镜像 / 自建 feed）

打包态可以通过 `ZCODE_UPDATE_FEED_URL` 环境变量或 `--zcode-update-feed-url` 启动参数把
更新源指向镜像站或自建 feed，**只接受 `https`**（更新产物会被下载并执行，明文链路可被
中间人替换），非 https 取值会被忽略并记一条 `warn` 日志。

走覆盖时会切换回官方 manifest 协议的 provider。原因是 GitHub provider 只接受
`{ owner, repo, host }`，会丢弃 URL 的路径部分，无法表达镜像前缀或自建地址。

> 国内网络下的 GitHub 加速方案见 [github-mirror.md](./github-mirror.md)。

### 发布通道

上游有 `stable` / `preview` 两条发布流，本项目只维护**一条**：GitHub Release 本身就是
唯一的发布流，因此原生 provider 下更新通道固定为 `stable`。设置里的「接受预览版更新」
开关只在走更新源覆盖（manifest 协议）时才有意义。

## 签名

| 平台    | 状态                                                      |
| ------- | --------------------------------------------------------- |
| Linux   | 不需要签名                                                |
| Windows | **无证书**，安装时会触发 SmartScreen 警告，需在文档中说明 |
| macOS   | 不发布                                                    |
