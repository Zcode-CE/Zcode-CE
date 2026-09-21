# 发布流程

> 状态：草稿 · 待补充实际发布步骤

## 平台支持

**Linux 与 Windows**。macOS 暂不发布（无代码签名证书，未签名包的用户体验代价过高）。

## 版本号

当前版本：**`3.14.1-ce.1`**，写在根 `package.json` 的 `version` 字段。

### 命名结构

```
3.14.1        -ce.1          .fix.1
└─ 上游版本    └─ 社区版序号   └─ 可选：热修复
   （官方 ZCode）  （本项目的第 N 次发布）

3.14.1 -alpha.ce.1
└─ 上游  └─ 可选：预览版（alpha 前置）
```

| 形态       | 示例                         | 用途             |
| ---------- | ---------------------------- | ---------------- |
| **稳定**   | `3.14.1-ce.1`、`3.14.1-ce.2` | 正式发布         |
| **预览**   | `3.14.1-alpha.ce.1`          | 稳定版之前的预览 |
| **热修复** | `3.14.1-ce.1.fix.1`          | 不改功能的小修复 |

### ⚠️ 为什么 alpha 前置、fix 用点号

这两处不是风格选择，而是 **semver 排序的硬约束**。反例（实测）：

| 写法                  | 实际排序               | 后果                                    |
| --------------------- | ---------------------- | --------------------------------------- |
| `3.14.1-ce.1-alpha.1` | **大于** `3.14.1-ce.1` | 预览版被当成升级推给稳定版用户          |
| `3.14.1-ce.1-fix.1`   | **大于** `3.14.1-ce.2` | 发布 ce.2 后，ce.1-fix.1 用户收不到更新 |

**根因**：semver 逐段比较预发布标识，**数字段小于字符串段**。

```
3.14.1-ce.1         → prerelease = ["ce", 1]          ← 第二段是数字
3.14.1-ce.1-alpha.1 → prerelease = ["ce", "1-alpha", 1] ← 第二段是字符串 → 更大
3.14.1-ce.1-fix.1   → prerelease = ["ce", "1-fix", 1]   ← 同上
```

**正确写法**（实测通过）：

```
3.14.1-alpha.ce.1   → prerelease = ["alpha", "ce", 1]   ← 首段 alpha < ce → 小于稳定版 ✅
3.14.1-ce.1.fix.1   → prerelease = ["ce", 1, "fix", 1]  ← 第三段才出现 fix → 小于 ce.2 ✅
```

### 演进序列（升序）

```
3.14.1-alpha.ce.1    预览
3.14.1-alpha.ce.2    预览
3.14.1-ce.1          稳定首发
3.14.1-ce.1.fix.1    热修复
3.14.1-ce.2          稳定第 2 版
3.14.1-ce.2.fix.1    热修复
```

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

稳定版 `3.14.1-ce.1` 在 semver 里**也是预发布版本**（含 `ce` 标识）。两处行为需要留意：

- **更新检查**：`electron-updater` 按当前版本是否含预发布标识计算 `allowPrerelease`。含标识时更新渠道名取自该标识，会先找 `ce-linux.yml`。本项目的处理见 [持续集成与发布构建](./ci.md)。
- **强制更新比对**：`packages/shared/src/forceUpdate.ts` 的 `compareSemverVersions` 按 semver 规则比较，**预发布版本低于同号正式版本**（`3.14.1-ce.1 < 3.14.1`）。社区版**不执行远端强制升级检查**，因此不受此影响；该函数仍用于其它需要版本序的场景。

构建在 CI 上完成，流程、矩阵与踩坑点见 [持续集成与发布构建](./ci.md)。本地打包的入口是：

```bash
pnpm bundle:desktop --os <linux|win> --arch x64
```

该命令内部已依次执行运行时资产准备、构建、electron-builder 打包、产物校验与体积审计，
不要在其前后重复跑 `prepare:runtime-assets` / `build`。

**Windows 包无法在 Linux 上交叉打包**（原生依赖按平台分目录准备），必须由 Windows runner 产出。

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
