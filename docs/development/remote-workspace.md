# 远程工作区（SSH / Docker / WSL）

远程工作区把 ZCode Agent 跑在**你自己的远端主机**上：本机只做客户端，远端跑 `zcode-server` 与 agent，
文件操作、命令执行、Git 都在远端进行。本文说明**当前版本的真实可用状态**、以及自己把远程运行时资产
准备好并托管起来的完整步骤。

> 结论先行：**连接、鉴权、部署、握手、远端会话这些代码都在**；缺的只有一样东西 —— **远程运行时资产的供给点**。
> 默认配置下这个供给点指向官方 CDN，而官方只发布官方版本号，本仓库版本（`3.14.x-ce.N`）在那里必然 404。
> 因此**打包版开箱时远程工作区不可用**；本文的「三步走」就是把它变成可用。

---

## 1. 现状（先说清楚你拿到的是什么）

| 项                   | 状态                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| 客户端连接与部署逻辑 | ✅ 完整（SSH / WSL / Docker 三种目标）                                                                       |
| 远端运行时资产       | ⚠️ **不随安装包分发**（安装包里没有任何远程运行时；`electron-builder` 的 `extraResources` 不含它们）         |
| 默认资产来源         | 官方 CDN（`https://cdn-zcode.z.ai`），**只有官方版本号**                                                     |
| 打包版默认结果       | ❌ 连接会在「取资源清单」这一步失败，报 `[remote-assets] manifest not found for <平台>`                      |
| 自建发布点           | ✅ 已提供脚本：生成 → 装配 → 验收（本文 §3）                                                                 |
| Windows 作为远端主机 | ❌ 明确不支持（`packages/server/src/remote/remotePlatformSupport.ts` 直接拒绝，remote 后端依赖 POSIX shell） |

**为什么默认不指向某个"我们的"CDN**：本项目不自建云服务。默认值指向一个不存在于公网的地址会让
错误更难理解；因此默认保持现状（官方 CDN）+ 报错如实指向"资源清单取不到"，并在此文档给出自托管路线。

---

## 2. 客户端版本号与资产版本的硬约束

- 客户端请求的清单路径是 **`<资产基址>/<appVersion>/manifest-<平台架构>.json`**，
  其中 `appVersion` 就是构建时的 `package.json` 版本（`3.14.3-ce.2` 这种）。
- 清单里的 `appVersion` 字段必须与客户端版本**完全相等**，否则客户端直接判为无效
  （`packages/server/src/remote/remoteAssetCache.ts` 的 appVersion 校验）。
- 这正是「直接用官方 CDN」走不通的原因：官方清单写 `3.14.3`，CE 客户端是 `3.14.3-ce.2`。

**实践含义**：每发一个 CE 版本，就要为那个版本生成并托管一份资产（不能跨 app 版本复用清单）。

---

## 3. 自托管三步走

前提：Node 版本以 `mise.toml` 为准；命令都在**仓库根目录**执行；需要一个能提供静态文件的托管点
（对象存储 + CDN、内网 nginx、GitHub Pages、任意静态文件服务都行）。

### 第 1 步：生成

```bash
pnpm prepare:remote-assets
```

- 产出落在 `packages/desktop/mock-cdn/`（gitignored）：`releases/<版本>/…` 与 `components/…`。
- 需要外网**一次**：4 个平台的 Node 运行时二进制（默认源 `https://cdn.npmmirror.com/binaries/node`，
  可用 `ZCODE_NODE_DIST_MIRROR` 换成别的镜像/官方源）。其余（server bundle、agent bundle、node-pty、
  搜索工具）都是本地构建或随仓库分发，不需要外网。
- 同机重复执行会复用已有产物（`[skip] already exists`），不会重复下载。

### 第 2 步：装配成"客户端真正会请求"的布局

```bash
node scripts/assemble-remote-assets.mjs --out /srv/zcode-remote-assets
```

产出（这才是要托管的目录）：

```
/srv/zcode-remote-assets/
  <appVersion>/manifest-linux-x64.json     # 以及 darwin-arm64 / darwin-x64 / linux-arm64
  <appVersion>/publish.json                # 发布记录：版本、时间、每个制品的 sha256 与大小
  components/<平台架构>/<组件>/<组件版本>.tar.gz
```

装配脚本会**自检并在失败时以非零码退出**：

1. 每个平台清单存在，且 `manifest.appVersion` 等于当前 `package.json` 版本；
2. 清单里每个 `artifactPath` 都能在发布根下取到；
3. 每个制品的 sha256 与清单声明一致。

> 注意：`components/` 必须位于**发布根**，不能塞进版本目录 —— 客户端按
> 「父级 root → 版本化路径」的顺序探测（`remoteAssetCdn.ts`），放错位置会让每次连接先白打一轮 404。
> 装配脚本已经按正确布局产出。

### 第 3 步：托管并让客户端指向它

把第 2 步的目录原样发布到静态托管点（保留目录层级），然后二选一：

```bash
# 方式 A：运行期覆盖（最常用；自托管用户、排障都适用）
ZCODE_REMOTE_ASSET_CDN_BASE_URL=https://your-host/zcode-remote-assets pnpm dev:desktop

# 方式 B：构建期默认值（自己打包发行版时用）
ZCODE_CDN_BASE_URL=https://your-host/zcode-remote-assets pnpm dev:desktop
```

- `ZCODE_REMOTE_ASSET_CDN_BASE_URL` 优先级最高，运行时读取；桌面端也会把它透传给窗口 Host。
- `ZCODE_CDN_BASE_URL` 在构建时被编译进产物，作为**默认基址**；两者都不设时才回落到官方 CDN。
- **基址要指向发布根**（即包含 `<版本>/` 与 `components/` 的那一层），不要带版本号。

---

## 4. 验收

### 4.1 端到端自检（不需要 SSH、不需要远端）

```bash
node scripts/assemble-remote-assets.mjs            # 若还没装配
pnpm exec tsx scripts/verify-remote-assets.mjs     # 期望输出 RESULT: PASS，退出码 0
```

它会：起一个本地静态服务充当"资产 CDN" → 用**真实** `connectRemote` 与一个同机的 POSIX 假后端，
完整走一遍「拉清单 → 按组件下载 + sha256 校验 → 上传"远端" → 起 `zcode-server` → 握手」。
"远端"的 `$HOME` 被重定向到临时目录，**不会碰你真实的 `~/.zcode`**。
成功后打印 `manifest 请求: 1`、`组件下载(GET): 7`（Linux 平台的组件数）。

### 4.2 真实远端

1. 启动桌面端（带上 §3 的基址环境变量）。
2. 新建任务 → 打开远程连接对话框 → 选择 **SSH** → 填主机 / 端口 / 用户名 → 选认证方式（密码或私钥；
   私钥可从 `~/.ssh/config` 的别名里自动带出）→ 选择「资源下载方式」。
3. 连接日志里应依次出现：`deploy complete` → `handshake done, server version: …`。
4. 远端 `~/.zcode/server/` 下会出现 `node`、`zcode-server.cjs`、`agents/`、`tools/`（约 155 MB）。

两种「资源下载方式」的差别：

| 模式                   | 谁去下载资产                                | 前置条件                                                                                                                 |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 本地下载后上传（默认） | 你的电脑下载，再通过 SSH 上传到远端         | 无（远端只需要能跑 POSIX shell）                                                                                         |
| 远端服务器下载         | 远端自己用 `curl`/`wget` 下载（省上传时间） | 远端必须能访问资产基址，且有 `curl` 或 `wget` + `tar` + `sha256sum`/`shasum`/`openssl`；缺了会明确报错并提示切回默认模式 |

---

## 5. 怎么"发布"这份资产（三种路径的代价）

| 路径                                                       | 可用性          | 代价 / 注意                                                                                                                                            |
| ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **自托管静态目录**（对象存储 / nginx / 内网）              | ✅ 推荐         | 需要一处托管与每版一次上传；可完全离线（内网）                                                                                                         |
| **workflow artifact**（CI 产出，人工下载后传自己的托管点） | ✅ 兜底         | 仓库发布流水线里已有 `remote-assets` job：tag 发版时自动「生成 → 装配 → 端到端自检 → 上传 artifact」，但**不向任何外部主机发布**，仍需人工搬运到托管点 |
| **GitHub Release 资产**                                    | ❌ 不适用       | Release 资产是**扁平** URL（`/releases/download/<tag>/<file>`），无法表达 `<版本>/manifest-*.json` + `components/<平台>/…` 的目录层级，客户端取不到    |
| **GitHub Pages / 静态分支**                                | ⚠️ 可行但不推荐 | 目录层级可以满足，但每个版本约 190 MB 二进制进 git 历史，仓库会迅速膨胀                                                                                |

CI 里那条 job 的名字是 `remote-assets`（`.github/workflows/release.yml`），只在 tag 发布或手动触发时运行，
不参与 PR。

---

## 6. 安全与隐私

- 资产请求**只带 HTTP 客户端默认头**（`host / connection / accept / accept-language / sec-fetch-mode / user-agent / accept-encoding`），
  **不带** `X-Device-Mid`、Cookie、Authorization 或任何账号/设备标识（实测：一次完整连接共 8 个请求）。
- 请求 URL 的路径里含**版本号**，托管方理论上可从访问日志看出"某 IP 在用哪个 CE 版本"；自托管时这一暴露由你自己掌握。
- SSH 连接目前**不做主机密钥校验**（未设置 `hostVerifier`/`hostHash`，也不读 `known_hosts`）。连接前请自行确认目标主机身份。
- 凭据（密码 / 私钥口令）只存在于连接过程与内存态，日志里不会出现明文（相关脱敏见连接日志实现）。
- `~/.ssh/config` 只会以 `ssh -G`（只解析、不建立连接）读取别名，用于回填主机/端口/用户名/私钥路径；
  **不解析 `ProxyJump`、`IdentityAgent`**，需要跳板机请自行在网络上打通。

---

## 7. 已知限制

1. 远端必须是 **POSIX shell** 环境（Windows 远端直接拒绝）。
2. 资产必须**按 app 版本**生成；清单里的 `appVersion` 与客户端版本不等会被直接拒绝（§2）。
3. `prepare:remote-assets` 的**输出目录不可重定向**（固定在 `packages/desktop/mock-cdn`）；
   装配脚本的输出目录可以用 `--out` 指定。
4. 生成过程**没有事务性**：中途失败会留下"半个 release 目录"，重跑会复用已存在的文件；
   怀疑产物陈旧时删掉 `packages/desktop/mock-cdn/releases/<版本>` 重跑。
5. 远程工作区当前**不承载** Browser Use / Computer Use（远端插件合同只声明 browser-use 所需资产）。
