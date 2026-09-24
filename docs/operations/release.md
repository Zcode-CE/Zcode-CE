# 发布流程

> 面向发布维护者。构建产物与 CI 细节见 [持续集成与发布构建](./ci.md)。

## 平台支持

**Linux 与 Windows**。macOS 暂不发布（无代码签名证书，未签名包的用户体验代价过高）。

## 版本号

当前版本写在根 `package.json` 的 `version` 字段。**本文不复制具体版本号** —— 它每次发布都变，
硬编码在这里必然过期。查当前值：

```bash
node -p "require('./package.json').version"
git tag --sort=-v:refname | head -1
```

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

### 远程运行时资产（先发资产，再发版）

远程工作区（SSH / WSL / Docker）的运行时资产**不随安装包分发**，需要在发版前先发布到托管点。
完整流程与验收命令见 [remote-workspace.md](../development/remote-workspace.md)，这里只定顺序与边界：

1. **顺序**：`pnpm prepare:remote-assets` → `node scripts/assemble-remote-assets.mjs --out <本地发布根>` →
   上传到托管点 → 验收（4 个平台的 `manifest-*.json` 与 `components/**` 都能取到）→ **再打 tag 发版**。
   反过来的后果：用户装上安装包后第一次连远程工作区会因为取不到资源清单而失败（表现为"连接失败"）。
2. **上传失败不阻塞发版**：资产上传是**独立步骤，不是发布门禁**。资产可以事后补传（客户端每次连接都会重新取清单），
   而卡住发版会让已经准备好的安装包白等一轮。判据是"安装包本身能不能用"，不是"托管点此刻是否最新"。
3. 教程位置：运维手册见 [remote-assets-cdn.md](./remote-assets-cdn.md)；构建期/运行期两个基址旋钮的语义差异
   （构建期旋钮会追加 `/zcode/electron/releases/<版本>`，运行期旋钮按字面值使用）见
   [remote-workspace.md §5.3](../development/remote-workspace.md)。

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

## 发布一个版本

### 1. 确认版本号

版本号只有一个权威来源 —— 根 `package.json` 的 `version`。改这一处即可，
其余位置在构建期自动同步（见上文「版本号的来源与传播」）。

```bash
node -e "console.log(require('./package.json').version)"
```

### 2. 本地预检

发布前至少确认这几项通过（CI 也会跑，本地先跑能省一轮往返）：

```bash
pnpm fmt:check
pnpm lint
pnpm typecheck
pnpm test
```

> `pnpm licenses:check` 的 `--strict` 模式**当前不通过**（30 项材料待补齐），
> 基础检查通过不代表合规完成。发布前需确认这是已知状态，详见
> [与上游的差异](../development/upstream-diff.md) 的技术债 #5。

### 3. 打 tag 并推送

CI 的 `release.yml` 由 **push `v*` tag** 触发。tag 采用 `v` 前缀，与 electron-builder
默认的 `vPrefixedTagName` 一致：

```bash
git tag -a v3.14.1-ce.1 -m "ZCode-CE v3.14.1-ce.1"
git push origin v3.14.1-ce.1
```

推送后 GitHub Actions 会构建 Linux x64 与 Windows x64 两个平台，并把安装包与更新清单
发布到同一个 Release。**矩阵是串行执行的**（原因见 [持续集成](./ci.md)），
总时长约为两平台之和（约 40 分钟）。

### 4. 演练（不发布）

不想真正建 Release 时，用 `workflow_dispatch` 手动触发：它只构建并上传 artifact，
不新建 Release。适合验证工作流本身或产出包供人工验收。

### 5. 核对 Release 内容

Release 必须包含**安装包 + 更新清单 + 差分块**，三者缺一会让更新链路降级或失效：

| 平台    | 更新清单           | 安装包                                | 差分块      |
| ------- | ------------------ | ------------------------------------- | ----------- |
| Linux   | `latest-linux.yml` | `AppImage` / `deb` / `rpm` / `pacman` | `.blockmap` |
| Windows | `latest.yml`       | `nsis`（`.exe`）                      | `.blockmap` |

**Release 必须是已发布状态，不能是 draft。** draft 对 `electron-updater` 完全不可见
（`releases.atom` 与 `/releases/latest` 都不返回），会让更新链路**静默失效**。
`electron-builder.config.js` 已显式设 `releaseType: "release"`。

### 6. 验证更新链路

发布后用一个旧版本安装包实测升级：应能检测到新版本、下载差分块并完成安装。
这一步不能省 —— 更新配置的错误（provider、清单缺失、draft 状态）在构建阶段都不会报错。

> **CI 尚未在真实 runner 上验证过**。`.github/workflows/` 只能在 GitHub 的 runner 上执行，
> 本地无法运行，因此工作流本身只做过 YAML 语法与命令级核对。首次打 tag 时需确认实际结果。

### 7. 同步到 AUR

**⚠️ 改本仓库的 `aur/` 目录不等于发布。** AUR 的包有**两个独立位置**：

| 位置                                           | 作用                                                    |
| ---------------------------------------------- | ------------------------------------------------------- |
| 本仓库的 `aur/`                                | **存档副本**（它的 remote 是本项目的 GitHub，不是 AUR） |
| `ssh://aur@aur.archlinux.org/zcode-ce-bin.git` | **AUR 上的正式包** —— 只有 push 到这里才算发布          |

**只改 `aur/` 并提交本仓库，AUR 上的版本不会变。**（`release.md` 此前没有这一步，导致 3.14.3-ce.2 首次发布时漏推。）

**顺序**（sha256 只能在产物出来后算，所以必然排在 tag 构建之后）：

1. **算 sha256**：从 Release 下载 `*-linux-x64.pkg.tar.zst`，`sha256sum` 取哈希；
2. **改 `aur/PKGBUILD`**：`pkgver`（点号形式，pacman 不允许连字符）、`_upstream_ver`、`_upstream_tag`、`sha256sums`；
3. **重新生成 `.SRCINFO`**：`cd aur && makepkg --printsrcinfo > .SRCINFO`（**必须与 PKGBUILD 同步**，AUR 用它建索引）；
4. **提交本仓库**的 `aur/`（这是存档，与第 5 步是两件事）；
5. **推送到 AUR**：

   ```bash
   cd /tmp && rm -rf aur-pub && mkdir aur-pub && cd aur-pub
   git clone ssh://aur@aur.archlinux.org/zcode-ce-bin.git .
   cp <repo>/aur/PKGBUILD <repo>/aur/.SRCINFO .
   git add PKGBUILD .SRCINFO
   git commit -m "fix: 更新到 <version>"
   git push origin master
   ```

6. **验证**（**注意 AUR 的 RPC 索引有 1~2 分钟延迟**，推送后立刻查会看到旧版本）：

   ```bash
   curl -sS 'https://aur.archlinux.org/rpc/v5/info?arg[]=zcode-ce-bin' | \
     python3 -c "import json,sys; print(json.load(sys.stdin)['results'][0]['Version'])"
   ```

   应以 `<pkgver>-1` 的形式返回新版本。git 仓库（`git log origin/master`）是**权威**，
   RPC 只是索引，两者短暂不一致属正常。

**前置**：需要 `aur@aur.archlinux.org` 的 SSH 公钥已登记（`ssh -T aur@aur.archlinux.org`
应返回 `Welcome to AUR, <user>!`）。

### 重跑已发布超过 2 小时的 tag

`electron-publish` 对已存在的 Release 有一条时间保护：发布时间超过 2 小时就**只打 warn 并跳过上传**，
构建仍然显示成功（是个静默失效点）。`release.yml` 已设 `EP_GH_IGNORE_TIME: "true"` 让重跑真正覆盖上传。

## 发版说明（release-notes.md）

`release-notes.md` 的正文**就是 GitHub Release 的正文**（`.github/workflows/release.yml` 用
`gh release edit --notes-file release-notes.md` 写入），所以它只该回答一个问题：
**这次更新改了什么、对用户有什么影响。**

### 写作口径（硬约束）

发版说明的读者是**用户**，不是项目成员。下面每一条都在评审时逐条对照；违反即打回，不作个案讨论。

| #   | 要求             | 具体做法                                                                                                                                                                    |
| --- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **面向用户**     | 只陈述「你能看到什么、能做什么、需要注意什么」。**禁止内部语汇**：埋点、门禁、单元（测试）、提交、hook、bundle、spec、回归、验收矩阵、反向验证、Lead 复核、报告编号、任务号 |
| 2   | **口吻**         | 简洁陈述句。**不写主观评价**（很扎实、非常棒、优雅、彻底、完美）；**不用口语**（顺手、搞定、踩坑、其实、翻车）；不写「我们觉得 / 我们认为」这类第一人称口语；**不用感叹号** |
| 3   | **不写实现细节** | 不出现 `file:line`、内部函数名与文件名、内部代号、提交哈希。写「做了什么、对你意味着什么」，不写它在代码里怎么实现                                                          |
| 4   | **不重复版本号** | 标题与正文都不写 `ZCode-CE vX.Y.Z-ce.N` —— 发布页上方已经显示 tag 与标题，重复一遍只是噪音（安装包文件名、环境变量等**必要位置照写**）                                      |
| 5   | **每条可验证**   | 优先写成「你怎么确认它生效」（例如「`--web --help` 现在列出默认值与全部旋钮」），而不是「已修复」这类断言。无可验证落点的条目，先问：用户凭什么相信它                       |
| 6   | **诚实边界**     | 未验证、未支持、不承诺的必须写；**不得**把「未验证」写成「已验证」，也**不得**写「与官方对等」这类无法支撑的说法。宁可让用户预期低一点                                      |

### 固定骨架

中英各一份，**逐节对应**（缺一节就在两份里都缺）。中文在前、英文在后，中间用 `---` 分隔。

```markdown
## 新增功能

## 体验优化

## 问题修复

## 升级须知（行为变化）

## 已知限制

## 本版尚未验证
```

**没有相关内容的板块直接不写** —— 空标题是噪音。固定骨架让每一版结构一致，
用户扫一眼就知道这次动了哪几类东西。

「升级须知」与「已知限制」「本版尚未验证」三节的分工：**行为变化与要用户做的动作**进「升级须知」；
**本版新增的长期限制**进「已知限制」；**没测过、没覆盖、没支持的**进「本版尚未验证」。

### 只写「改了什么 + 影响」，不写「为什么」

「为什么这么改」属于**开发日志**（`.reverse/` 下的分析报告、commit message），不属于发版说明，
**也不要在正文里链接它们** —— 那个目录本地忽略、不入库，对读者是死链。
发版说明里出现大段背景与推理，会把用户真正要看的「改动与影响」淹掉。

### 「已知限制」只写本版新增的

限制分两类，**只有 B 类进发版说明**：

| 类型                                     | 例子                                               | 放哪                           |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------ |
| **A. 长期限制**（与版本无关）            | Windows 未真机回归、Wayland 截图不可用、构建未签名 | **README 的「已知限制」章节**  |
| **B. 本版新出现 / 因本版变更而变得重要** | 「某新功能只验证到枚举、动作类未验证」             | **发版说明的「已知限制」板块** |

**判据**：一条限制进发版说明，当且仅当它**因本次变更而新出现，或本次变更让它变得重要**。
否则归 README。这样避免「每版都重复同一句 Windows 未实测」，让真正的信号不被淹没。

### 「本版尚未验证」—— 单独一节，不允许省略

这一节的意义是**不让「没验证」被读成「已验证」**。有未验证项就必须写，且要写到用户能据此
做出正确决定（例如「不要依赖跨设备同时操作同一会话」）。

**若本版确实有需要用户知情的验证边界，如实写** —— 宁可让用户预期低一点，也不要让声明超过证据。

### 发布前对照的硬检查

1. **口吻**：全文搜一遍主观评价词与口语词（很、非常、优雅、彻底、顺手、搞定、踩坑、其实、！）；
2. **内部语汇**：全文搜一遍上表第 1 行的禁用词；
3. **版本号**：标题与正文不出现 `ZCode-CE v`；
4. **可验证**：逐条问「用户怎么确认它生效」，答不上来的条目退回重写或删除；
5. **新旧一致性**：**上一版正文说过的话，本版不再成立的要改掉** —— 典型的失效点是「尚未实现 / 无某功能」
   这类否定式断言：功能落地后那句话会反过来误导用户（本项目的 ce.3 草稿就出现过这种滞后）；
6. **中英一致**：逐节核对，不能只改一份；
7. **散文式说辞**：不写「某功能已由测试充分验证」这类无法被用户验证的总结句。

### 草稿与历史段落

- **顶部草稿标记**：起草到发版之间的正文加一行 HTML 注释（`<!-- 草稿：未发版，发版前删除本行 -->`），
  它在 GitHub 上不渲染，读者看不到草稿身份；发版前必须删掉。
- **历史版本**：上一版正文如需留在文件里备查，放在文件**末尾**并用 HTML 注释隔开
  （`<!-- 历史版本（发版时删除本段及其以下内容） -->`）。**已发布 Release 的正文改动是对外写操作**，
  需要用户确认，不能顺手回改。
- **段落级版本身份**：确实需要给某段标注它属于哪一版时，用 `<span id="..."></span>` 之类
  不渲染的锚点，或者在文件内以小标题分隔（如 `# 历史版本（ce.2）`）；**不要**在读者可见的正文里重复版本号。

### 不写什么

以下内容**曾经出现在发版说明里，现已移除**，因为它们不属于「本次更新」：

| 移除的内容                     | 现在在哪                                                          |
| ------------------------------ | ----------------------------------------------------------------- |
| 平台支持矩阵                   | `README.md` 的「安装」一节                                        |
| 与官方发行版的关系             | `README.md` 的「关于本项目」+ `docs/development/official-diff.md` |
| 文档索引                       | `README.md` 的「文档」一节                                        |
| 顶部的「中文 · English」锚点行 | 直接删 —— 正文本身双语，往下滚就是英文，锚点没有实际作用          |

## 签名

| 平台    | 状态                                                      |
| ------- | --------------------------------------------------------- |
| Linux   | 不需要签名                                                |
| Windows | **无证书**，安装时会触发 SmartScreen 警告，需在文档中说明 |
| macOS   | 不发布                                                    |
