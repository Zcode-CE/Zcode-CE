# 远程工作区（SSH / Docker / WSL）

远程工作区让 Agent 跑在**你自己的远端主机**上：本机只做客户端，远端跑 `zcode-server` 与 agent，
文件操作、命令执行、Git 都在远端进行。本文是**使用与自部署指南**——从"默认能不能用"到"怎么改成自己的发布点"。

> 维护者/运维视角（桶、缓存策略、上传脚本、CI 自动发布）见 [remote-assets-cdn.md](../operations/remote-assets-cdn.md)。

---

## 1. 这个能力是什么、什么时候需要它

- **不需要它**：只在本机开发就用本地工作区，什么都不用配。
- **需要它**：代码/依赖/构建都在另一台机器（开发机、跳板机后的内网机器、云主机、容器）上，
  你希望 Agent 的工具调用（读写文件、跑命令、Git）发生在那里，而界面留在本机。
- **支持三种目标**：SSH、WSL、Docker。本地必须有 SSH 客户端能力（SSH 目标）或对应的 `wsl`/`docker` 命令。
- **远端要求**：必须是 **POSIX shell** 环境；Windows 作为远端主机**不支持**（会被明确拒绝）。

远程工作区需要在远端放一份"运行时资产"（Node 运行时 + `zcode-server` + agent bundle + 搜素工具，
共 4 个平台各一份）。这份资产**不随安装包分发**，所以要么用我们托管的社区 CDN，要么你自己托管一份。

---

## 2. 默认行为

| 场景                                      | 默认指向                                      | 结果                                                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **本项目发布的安装包**（GitHub Releases） | **社区 CDN** `https://cdn.eidolonmachine.xyz` | ✅ **开箱可用**（前提：该版本已发布到该 CDN；该默认值由发布流水线的仓库变量 `ZCODE_CDN_BASE_URL` 提供，且流水线**要求**它已配置，否则发布 job 直接失败 —— 见 `.github/workflows/release.yml`） |
| 你从源码自己构建、且没设任何旋钮          | 官方 CDN（`https://cdn-zcode.z.ai`）          | ❌ 官方 CDN 只有官方版本号，CE 版本取不到 ⇒ 连接失败（需按 §3 指向自己的发布点）                                                                                                               |

社区 CDN 是本项目自建的对象存储 + 自定义域名：**不中继请求**（客户端直连该域名，我们不转发你的流量），
**不采集遥测**；资产请求只带 HTTP 客户端默认头，不带设备标识、账号或 Cookie。

---

## 3. 把客户端指向你的发布点

三种方式，**优先级从高到低**：

| 方式                                             | 生效范围           | 用法                                                                                       |
| ------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------ |
| **环境变量 `ZCODE_REMOTE_ASSET_CDN_BASE_URL`**   | 本次启动（最高）   | `ZCODE_REMOTE_ASSET_CDN_BASE_URL=https://your-host/assets pnpm dev:desktop`                |
| **设置页「远程资产 → 自定义远程资产 CDN 地址」** | 当前安装           | 图形界面填写**发布根**；适合不想动环境变量的用户。**只在桌面端生效**（见下）               |
| **构建期 `ZCODE_CDN_BASE_URL`**                  | 你构建出来的安装包 | `ZCODE_CDN_BASE_URL=https://your-host/assets pnpm dev:desktop`；打包发行版时设它作为默认值 |

> 补充（文档此前没写全，不是行为变化）：`ZCODE_CDN_BASE_URL` **也能作为运行期环境变量**使用，
> 只是它的优先级在 `ZCODE_REMOTE_ASSET_CDN_BASE_URL` **之下**、在内置默认值**之上**
> （`packages/desktop/src/main/remoteCdn.ts:47` 读 `process.env.ZCODE_CDN_BASE_URL`，随后才回落到内置官方默认）。
> 若只想临时覆盖，用第一行的 `ZCODE_REMOTE_ASSET_CDN_BASE_URL`，别用这个。

> 顺序是**实现级事实**，不要凭直觉换：`desktopRuntimeEnv.ts` 把环境变量的值放进
> `remoteCdn.ts` 的 `override` 槽位，而那是**最先**判定的分支 ⇒ 环境变量永远压过设置页。
> 「运维/调试时能临时覆盖用户设置」正是这条顺序要保证的契约。

**设置页这一项只在桌面端出现**：消费链是 desktop main
（`desktopRuntimeEnv.ts` → `remoteCdn.ts` 的 `overrideBaseUrl` 槽位）。Web 端的设置页**不显示**它
（`createSettingsPageConfig` 按 `isDesktop` 过滤），因为 Web / CLI 侧的资产解析走另一条链、
不读 AppSettings —— 显示一个点了没用的开关就是 UI 说谎。
**Web / CLI 用户请用运行期环境变量**（本表第一行）。

**生效时机**：改设置后**新建**的远程连接用新基址，已建立的会话沿用旧基址。

**语义（重要）**：三个方式的值都是**发布根**——即包含 `<版本>/` 与 `components/` 的那一层，
**按字面值使用**，不要带版本号。唯一的例外是**内置的官方默认值**，它自带
`/zcode/electron/releases/<版本>` 前缀（官方 CDN 的资源确实挂在那个前缀下）。

> 2026-09-23 修正：此前构建期旋钮会把值当**父目录**并追加 `/zcode/electron/releases/<版本>`，
> 与本文档"值就是发布根"的契约矛盾（自建发布点会 404）。代码已按本文档修正，并有契约测试钉住
> （`packages/desktop/test/remoteCdnBaseUrl.test.ts`，把实现改回旧行为会红）。

---

## 4. 自建发布点：最小步骤

需要一处能提供**静态文件**的托管点（对象存储 + 自定义域名、内网 nginx、任意静态服务器均可）。
命令都在仓库根目录执行。

```bash
# 1) 生成（只有 Node 运行时需要一次外网；其余都本地构建或随仓库分发）
pnpm prepare:remote-assets

# 2) 装配成客户端真正会请求的布局（含自检：appVersion / artifactPath / sha256）
node scripts/assemble-remote-assets.mjs --out ./publish-root

# 3) 托管：把 ./publish-root 原样发布（保留目录层级）

# 4) 指向它（三选一：环境变量 / 设置页 / 构建期，优先级见 §3）
ZCODE_REMOTE_ASSET_CDN_BASE_URL=https://your-host/assets pnpm dev:desktop

# 5) 验收
pnpm exec tsx scripts/verify-remote-assets.mjs --root ./publish-root   # 期望 RESULT: PASS
```

发布根必须长这样（`<平台架构>` ∈ `linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64`）：

```
publish-root/
  <版本>/manifest-<平台架构>.json      # 4 个平台各一份
  <版本>/publish.json                  # 发布记录（客户端不读，排障用）
  components/<平台架构>/<组件>/<组件版本>.tar.gz
```

两个必须记住的点：

1. **`components/` 要在发布根，不能塞进版本目录** —— 客户端按「发布根 → 版本化路径」的顺序探测，
   放错位置会让每次连接先白打一轮 404（实测）。
2. **清单里的 `appVersion` 必须等于客户端版本**（`3.14.3-ce.2` 这种）。每发一个 CE 版本就要生成并托管
   对应版本的一份资产；跨版本复用清单会被客户端直接拒绝。

### 升级/换版本

资产是**按版本**托管的，多个版本可以并存（`components/` 共用，组件名内含内容寻址 sha，不会冲突）。
升级客户端后，先确认新版本的资产已发布，再连。

---

## 5. 验收与排障

### 5.1 不上真实远端也能验（推荐先做这一步）

```bash
pnpm exec tsx scripts/verify-remote-assets.mjs --root ./publish-root
```

它会起本地静态服务当"资产 CDN"，用**真实** `connectRemote` 与同机 POSIX 假后端走完
「拉清单 → 下载组件 + sha256 → 上传"远端" → 起 `zcode-server` → 握手」，成功打印 `RESULT: PASS`。
"远端"的 `$HOME` 被重定向到临时目录，不会碰你真实的 `~/.zcode`。

### 5.2 真实远端

1. 启动桌面端并带上 §3 的方式之一（或先在设置页填自定义 CDN 地址）。
2. 新建任务 → 远程连接对话框 → 选 SSH → 填主机/端口/用户名 → 选认证方式（密码或私钥；
   私钥可从 `~/.ssh/config` 别名自动带出）→ 选「资源下载方式」。
3. 连接日志期望看到：`deploy complete` → `handshake done, server version: …`。
4. 远端 `~/.zcode/server/` 下会出现 `node`、`zcode-server.cjs`、`agents/`、`tools/`（还有 `build/`）。
   体积随版本/平台变化：**2026-09-24 在 linux-x64 上实测** `~/.zcode/server/` ≈ **158.0 MB**、含 `~/.zcode/v2/` 共 ≈ **158.5 MB**
   （本行是快照值，不是承诺值；换版本或换平台请以实际为准）。

两种「资源下载方式」（**当前只有 SSH 目标能选**：Docker / WSL 恒用默认的「本地下载后上传」）：

| 模式                   | 谁去下载资产                                | 前置条件                                                                                                                 |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 本地下载后上传（默认） | 你的电脑下载，再通过 SSH 上传到远端         | 无（远端只要能跑 POSIX shell）                                                                                           |
| 远端服务器下载         | 远端自己用 `curl`/`wget` 下载（省上传时间） | 远端必须能访问发布根，且有 `curl` 或 `wget` + `tar` + `sha256sum`/`shasum`/`openssl`；缺失时会明确报错并提示切回默认模式 |

> 「资源下载方式」由桌面端按目标类型提供：`packages/desktop/src/host/index.ts` 只在 `target.kind === "ssh"` 时传入
> `assetInstallMode`，所以 **Docker / WSL 一律走默认的本地下载后上传**（对它们的远端不要求能访问发布根）。

### 5.3 常见报错对照

| 现象                                            | 原因                                                                                                                                                                                                                                                           | 处理                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[remote-assets] manifest not found for <平台>` | **两种原因**：(a) 发布根里没有该版本的 `manifest-<平台>.json`（路径不对、版本没发布、或基址带了多余层级）；(b) **该平台不在发布范围内**（当前只发布 darwin 与 linux 上的 x64/arm64；`linux-armv7l`、`linux-ppc64le`、`linux-s390x`、`freebsd-*` 等都没有资产） | 先在**远端**跑 `uname -s -m`：若结果落在 Linux 或 Darwin、且是 x86_64/aarch64 ⇒ 是 (a)，用 `curl -I <发布根>/<版本>/manifest-<平台>.json` 验证、基址要指向**发布根**；若不在这几类里 ⇒ 是 (b)，换一台 x64/arm64 的 Linux/macOS 远端，或自行按该平台构建资产（本项目不发布该类） |
| `manifest appVersion mismatch …`                | 清单的 `appVersion` 与客户端版本不一致（常见于托管的资产是旧版本）                                                                                                                                                                                             | 为当前客户端版本生成并发布资产                                                                                                                                                                                                                                                  |
| 组件 404（下载中途失败）                        | `components/` 不在发布根下（被塞进版本目录），或上传时漏了 `components/**`                                                                                                                                                                                     | 按 §4 的布局重新托管                                                                                                                                                                                                                                                            |
| 每次连接先出现一批 404 再成功                   | 布局只满足"版本化路径"那条候选                                                                                                                                                                                                                                 | 把 `components/` 移到发布根                                                                                                                                                                                                                                                     |
| 失败但日志像网络问题                            | 打不开发布根（DNS/证书/防火墙）                                                                                                                                                                                                                                | 先在本机 `curl` 发布根确认可达                                                                                                                                                                                                                                                  |

---

## 6. 安全与隐私

- **不中继**：客户端直连你配置的发布根；本项目没有中间服务器转发你的连接或数据。
- **不带标识**：资产请求只有 HTTP 客户端默认头（`host / connection / accept / accept-language / sec-fetch-mode / user-agent / accept-encoding`），
  不含 `X-Device-Mid`、Cookie、Authorization（**2026-09-24 实测**：一次完整连接共 8 个请求、头名称恰好上述 7 个）。
- **版本号可见**：请求路径含版本号，托管方理论上能从访问日志看出"某 IP 在用哪个 CE 版本"；自托管时这一暴露由你掌握。
- **SSH 主机密钥未校验**：当前实现不读 `known_hosts`、不校验主机指纹。**连接前请自行确认目标主机身份**
  （例如先在终端用 `ssh` 连一次并核对指纹，或用固定 IP / 内网可信链路）。
- **凭据**：密码/私钥口令只存在于连接过程与内存态，不写入日志明文。
- **隧道场景要 TLS**：如果你用隧道/自建服务承载资产，请使用 `https`；明文链路可被替换（客户端只接受 http/https，
  但 https 才能防中间人）。
- **`~/.ssh/config`** 只以 `ssh -G`（只解析、不建连）读取别名，用于回填主机/端口/用户名/私钥路径；
  **不解析 `ProxyJump`、`IdentityAgent`**。

---

## 7. 已知限制

1. 远端必须是 POSIX shell 环境（Windows 远端明确拒绝）。
2. 资产必须按客户端版本生成；清单 `appVersion` 与客户端版本不等会被拒绝。
3. `prepare:remote-assets` 的输出目录固定在 `packages/desktop/mock-cdn`（不可重定向）；装配脚本可用 `--out` 指定输出。
4. 生成过程没有事务性：中途失败会留下"半个 release 目录"，重跑会复用已存在文件；怀疑产物陈旧时删掉
   `packages/desktop/mock-cdn/releases/<版本>` 重跑。
5. 远程工作区当前**不承载** Browser Use / Computer Use（远端插件合同只声明 browser-use 所需资产）。
6. **Docker：已实测通过**（2026-09-24）。三者共用同一套部署与资源代码（`connectRemote` →
   `deployServer(backend, {platform, arch})`，资产层无 provider 分支），这次的实测把 Docker 从"理论上同样受益"变成"真的走通"：
   `detect() = {platform: linux, arch: x64}` → 自托管发布根 **8 个请求全部 200、零 404**（manifest + node-runtime /
   server-bundle / node-pty / glm / bfs / ripgrep / ugrep）→ 资产上传进容器（在容器内取到
   `/root/.zcode/server/{zcode-server.cjs, agents/glm/…, tools/…}`）→ **容器内起 server 并握手成功**
   （`handshake done, server version: 3.14.3-ce.2`）→ 干净退出。
   **运行时与版本（写清是为了让你能判断结论适用面）**：**真实 Docker 守护进程 29.8.0**、rootless、cgroup v2、
   overlayfs、容器**默认参数**（未加任何额外 flag）。同样的链路此前也在 podman 的 docker 兼容套接字上跑通过一轮
   （并因此被记为「不能表述为『在 Docker 上实测』」）；现在两者都有证据，真 Docker 是主线。
   容器内实测取到的落点：`/root/.zcode/server/{node, zcode-server.cjs, agents/, tools/{bfs,ripgrep,ugrep}, build/}` 与 `/root/.zcode/v2/`；
   远端安装体积实测 `~/.zcode = 158.5 MB`（`server/ = 158.0 MB`）。
   **一条环境附注（只在 podman 下适用，与产品无关）**：用 **podman 的 docker 兼容套接字**跑时，容器在**默认参数**下
   容器内无法 fork（`sh: 4: Cannot fork`，会直接卡在 `detect()`），需要 `--pids-limit -1`；
   真 Docker 默认参数下实测**不需要**该 flag（容器内 `pids.max` = 37829，正常 fork）。
   也就是说：`--pids-limit` 是**podman 环境特有的坑**（该机 rootless podman 且 `/etc/subuid` 缺少映射），不是 Docker 的要求。
7. **WSL：未实测**。`packages/server/src/remote/wsl-backend.ts:504` 与 `wsl-detect.ts:148/166` 硬性要求
   `process.platform === "win32"`（要调 `wsl.exe`）⇒ 只能在 **Windows 客户端**上验证，Linux/macOS 主机无法实测。
   验证条件：一台 Windows 客户端，或 CI 的 `windows-latest` runner 并且已启用 WSL2 且有发行版。
   静态核查结论（供参考，不等于验证）：WSL 的 Windows 专属假设（`wsl.exe` 调用、UTF-16LE 输出解码、
   `wsl.exe -- bash -lc` 的参数重组）**全部落在 WSL 后端内部**，不扩散到资产层；WSL 内的远端是 Linux，
   需要的是已发布的 `linux-x64/arm64`，因此**缺少 win32 平台类不影响 WSL 远端**。
8. **Alpine(musl)：实测不可用**（2026-09-24 实测，不再是预期）。自托管资产里的
   `components/linux-x64/node-runtime` 解出的 `node` 是 **glibc 动态链接**（`ldd` 依赖 `libdl.so.2` /
   `libstdc++.so.6` / `libm.so.6`，解释器 `/lib64/ld-linux-x86-64.so.2`），而 Alpine 用 musl、没有该解释器。
   实测对照（同一份载荷、同一台机器）：**Debian 系容器**（`kalilinux/kali-rolling`）里
   `/root/.zcode/server/node --version` ⇒ `v22.16.0`；**Alpine 容器**（`postgres:16-alpine`）里执行同一文件 ⇒
   `/payload/node: cannot execute: required file not found`，**退出码 127**。
   ⇒ 结论：**Alpine 系远端当前不可用**；远端请用 glibc 发行版（Debian / Ubuntu / RHEL 系等）。
9. 桌面端以外的客户端（Web）**没有**远程工作区入口。
