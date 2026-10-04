# 无头服务器发行包（`zcode` · Web 面板）

> 面向**使用者与部署方**：把一个自包含的 `zcode` 包放到没有桌面环境的机器上，用浏览器（含手机）操作**这台机器上的工作台**。
> **它不接管桌面端**：不是接管桌面端正在开的会话，桌面端已连的远端 SSH / Docker 目标**不会**共享给浏览器
> （本仓库只有 `packages/web` ↔ `packages/server` 这一条自托管链路；桌面端的远程连接注册表是**窗口内**的）。
> 构造与运维细节见 [remote-assets-cdn.md](./remote-assets-cdn.md)（资产托管）与 [web-remote-control.md](../development/web-remote-control.md)（链路与安全全貌）。

---

## 1. 这是什么

一个**自包含发行包**：解包即得到

| 目录                                              | 内容                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `bin/zcode.mjs`                                   | 可执行入口（runner）：`zcode --web …` 起服务；也可直接跑 TUI                                                        |
| `server/`                                         | 服务端（HTTP + WebSocket + RPC + 静态资源托管）                                                                     |
| `agent/zcode.cjs`                                 | Agent 运行时（app-server bundle），**+ `agent/provider/` 内置 provider 配置 + 第三方声明**                          |
| `web/`                                            | Web 面板静态根（前端构建产物）                                                                                      |
| `install.sh` / `releases/*.tar.gz` + `sha256.txt` | 安装脚本与归档校验和（三者构成**发布站点根**，上传布局见 §8 与 [remote-assets-cdn.md §14](./remote-assets-cdn.md)） |

它**不是**桌面应用的替代品，也**不包含**桌面端的本地能力（Computer Use、内嵌浏览器等）。
它提供的是：**在服务器上跑 Agent，用浏览器当界面**。

---

## 2. 构建

```bash
pnpm build:zcode                       # 产出 dist/zcode/（含 releases/*.tar.gz 与 sha256.txt）
node scripts/build-zcode.mjs --skip-build          # 复用已有 web/server/agent 构建产物，只重新打包
node scripts/build-zcode.mjs --base-url https://…  # 指定 install.sh 的依赖下载基址（见下）
node scripts/build-zcode.mjs --out-dir dist/zcode --version 3.14.3-ce.3
```

**`--base-url`（`ZCODE_DIST_BASE_URL`）是必填项**：它写进 `install.sh`，决定安装时去哪里取依赖；
缺失时脚本会直接失败（`Configure ZCODE_DIST_BASE_URL in .env or pass --base-url`）。
**在哪托管这份依赖载荷属于部署决策**，本仓库不指定默认值。

**例外：npm 打包链路**。`--base-url` 在全仓**只有一个消费点** —— 写进发布站点根的
`install.sh` 与 `latest.json.baseUrl`（`scripts/build-zcode.mjs`）。包体（tarball 内的 `zcode/`）
与它无关，实测同一份构建产物换两个不同基址，解包后整棵目录树**逐字节相同**。
所以 npm 发布不需要真实托管地址：

```bash
node scripts/build-zcode.mjs --allow-placeholder-base-url   # 未配 ZCODE_DIST_BASE_URL 时用占位基址
```

占位基址是 `https://zcode-dist.invalid/zcode/`（`.invalid` 是 RFC 2606 保留、永不解析的顶级域），
**只影响 `install.sh` 与 `latest.json`，不进 npm 包**：包的 `files` 是
`["bin","server","agent","web","!**/*.map"]`，不含 `install.sh`。用占位基址时 `install.sh` 里会多出
一段 stderr 告警（提示设置 `ZCODE_DIST_BASE_URL`），且运行期仍可用该变量覆盖。
这条不变式由 `scripts/test/installScriptBaseUrl.test.mjs` 钉住。

**本项目的实际托管点（2026-09-25 决定）**：基址为 `https://cdn.eidolonmachine.xyz/zcode`（社区 CDN，Cloudflare R2）。
放在 `/zcode` 子路径而不是根，是为了与同域下**已有的远程工作区资产**（`/components/**`、`/<版本>/manifest-*.json`）隔离。
对应仓库变量 `ZCODE_DIST_BASE_URL` 与 `pnpm build:zcode` 的 `--base-url` 必须用同一个值。

⚠️ **这个域名一旦随 `install.sh` 分发出去就不可更换**（换域名 = 存量用户的 `install.sh` 全部失效）——
与 [远程资产 CDN](remote-assets-cdn.md) §10 的红线 1 同一条约束。改动前先确认愿意长期维护它。

**容量**（R2 免费额度实测口径：10 GB-month 存储、出流量免费）：远程资产 192.4 MB + 每个版本约 78 MB，
按此估算免费额度可容纳上百个版本；发布脚本只保留最近 10 个版本，占用不会随时间单调增长。

---

## 3. 运行

```bash
node bin/zcode.mjs --web [--host <host>] [--port <port>] [--workspace <path>] \
                    [--open|--no-open] [--token <token>|--no-token]
```

| 参数                   | 说明                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--web`                | 起 Web 面板（不进入 TUI）                                                                                                                                                  |
| `--host`               | 监听地址。**默认 `127.0.0.1`（仅本机）**；`0.0.0.0`/本机私网 IP 才会对局域网开放。为 `0.0.0.0`/`::` 时 runner 会**逐个打印网卡可达地址并带上令牌**，方便你复制到手机浏览器 |
| `--port`               | 端口。**默认 `3030`**；被占用时**自动回退到空闲端口**并在启动日志写明；启动日志**始终打印实际地址**                                                                        |
| `--workspace`          | 工作区根目录（Agent 的文件/命令作用域）                                                                                                                                    |
| `--open` / `--no-open` | 是否自动打开本机浏览器（无头环境用 `--no-open`）                                                                                                                           |
| `--token <token>`      | 访问令牌；**非回环监听必须提供**                                                                                                                                           |
| `--no-token`           | 关闭令牌。**只允许与回环 host 组合**（见 §4）                                                                                                                              |

浏览器打开：`http://<host>:<port>/?token=<令牌>`（服务端校验后种下 cookie，之后不必再带查询串）。

---

## 4. 安全边界（按危险品对待）

> **这条链路暴露的是 agent 级能力** —— 拿到连接就能在 `--workspace` 指向的目录里**执行命令、读写文件**。
> 把它当"一个网页"来暴露是本次最容易犯的错。

1. **默认只监听回环**：不传 `--host` 时绑定 `127.0.0.1`。
2. **非回环 + 无令牌 = 拒绝启动**：runner 在**参数解析阶段**就拒绝 `--no-token` 与非回环 host 的组合；
   服务端侧同样是 fail-closed 的硬检查（`packages/server/src/http.ts` 的监听前置检查）。**不要用"反正是内网"当理由关掉令牌。**
3. **回环 + "会被外部访问"的信号 + 无令牌 = 也拒绝启动**（本版加固）。
   **"回环 = 只有本机能到"这个前提在代理后面不成立**：把回环端口放到同机反代/隧道/容器端口映射之后时，
   请求的对端地址就是回环，于是令牌那道闸整条不生效 —— 而 Host 白名单挡不住它（自己写 `Host: 127.0.0.1` 就在白名单里）、
   来源校验对不带 `Origin` 的客户端放行（那是为 CLI/桌面客户端留的取舍）。
   因此只要配置里出现信号（`ZCODE_SERVER_TRUSTED_PROXIES` 或 `ZCODE_SERVER_TRUSTED_HOSTS` **解析后有生效项**），
   令牌就必须开着；只有 `ZCODE_SERVER_TRUSTED_ORIGINS` 一档走**告警**（有意不拒绝）。
   **残余缺口（有意保留）**：三类信号全无 + 代理把 `Host` 改写成上游地址时，回环无令牌仍可被完全控制。
   ⇒ **只要回环端口对外可达（哪怕只在局域网内），就配一个令牌。** 完整口径与实测见
   [反代部署 §3.4](headless-server-reverse-proxy.md)。
4. **启动期 + 运行期各有一次暴露面告警**（本版已落地，`packages/server/src/http.ts`）：
   绑定非回环时启动会打印可操作的告警；本会话**首次**收到非回环对端的**明文 http** 请求时会再提示一次。看到告警说明你正处在高风险配置上。
5. **明文 http 只限可信局域网**：令牌会出现在 URL 查询串（进浏览器历史）、cookie 默认**不带 `Secure`**；
   只有在 **https**（含反代带 `X-Forwarded-Proto: https`）时才追加 `Secure`。跨公网/不可信网络**必须**把
   **TLS 终结放在反向代理或隧道**上，服务本身仍只监听回环或私网。
6. **令牌是静态共享密钥**：无设备级吊销；泄露即等于交出 agent 级访问。轮换＝换 `--token` 重启（或令牌文件 + `SIGHUP`）。鉴权失败限流已落地（默认 10 次/5 分钟 ⇒ 封 15 分钟）。
7. **封禁的作用范围是路径，不是整个服务**。IM 机器人入站回调走一条平行前缀 `/bot/**`（`packages/server/src/botIngress.ts`），
   它不经过令牌面，用的是逐 bot 的 `x-zcode-bot-secret` 与一个独立的计数桶。因此：
   - 令牌面的封禁**不会**连带封禁 `/bot/**`；被令牌面封了 15 分钟的地址仍可继续打这个前缀。
   - 同理，猜 bot secret 失败到阈值也不会封掉该地址的 `/api/**` 或面板。

   看到「某地址被 403 封禁」时**不要**推断它全站不可用 —— 事件复盘若按这个推断走，会得出
   「它已经被封了，所以不可能再去试探 bot secret」这种错误结论，而实际上它正在试探（只是换了路径）。
   完整口径见 [web-remote-control.md](../development/web-remote-control.md) §5.5 与 §12。

8. **bot 入站不构成令牌面的豁免路径，它反而要求令牌开着**：要让 IM 平台从公网打到本机，必须把回调域名
   登记进 `ZCODE_SERVER_TRUSTED_HOSTS`（否则 Host 白名单会 403）；而「登记了生效项」正是第 3 条的
   外部访问信号 —— **登记域名 + 无可用令牌 ⇒ 服务拒绝启动**。这是既有的 fail-closed 被触发，
   不是 bot 功能引入的新约束。
9. **没有中继、没有云服务**：本仓库不托管配对服务器/二维码服务/官方 relay（全仓 0 命中）；可达性完全由你的
   局域网、SSH 隧道或反代提供。

**推荐的三条暴露方式（由安全到方便）**：

| 方式     | 命令/要点                                               | 适用               |
| -------- | ------------------------------------------------------- | ------------------ |
| 仅本机   | 默认即可（`127.0.0.1`）                                 | 单机调试           |
| SSH 隧道 | `ssh -N -L 3030:127.0.0.1:3030 <主机>` 后本地浏览器访问 | 跨机使用，无需证书 |
| TLS 反代 | Caddy/nginx 终结 TLS，只让反代对外                      | 手机/团队长期使用  |

> **放到反代 / TLS 之后的具体做法（Host 白名单、只支持挂域名根、可信代理与 `X-Forwarded-*` 的真实语义、
> 回环端口放到代理后面的后果与令牌口径、Caddy/nginx 最小配置）见 [headless-server-reverse-proxy.md](./headless-server-reverse-proxy.md)。**

---

## 5. 凭据与数据目录

- **数据目录**：`~/.zcode/v2`（会话、任务索引、设置、设备身份）。headless 服务与桌面端**共用同一目录** ——
  同一台机器上同时跑两者时不要并发写同一工作区。完整布局、备份与恢复**以 [data-layout.md](./data-layout.md) 为准**。
- **provider 凭据**：随包带 `agent/provider/zcode-builtin.json`（内置 provider/model 配置）；
  登录态（OAuth 令牌等）落在数据目录里，与桌面端一致。也可用环境变量覆盖端点
  （`ZCODE_BASE_URL`、`ZCODE_ENDPOINT_ORIGIN` 等，见仓库根 `.env.example`）。
- **不要**把 provider secret 写进命令行或镜像层；用环境变量或数据目录里的凭据。

### 5.1 服务端旋钮一览（环境变量）

| 旋钮                            | 作用                                                                                                           | 默认                | 备注                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZCODE_SERVER_AUTH_TOKEN`       | 显式单令牌（等价于 `--token`）                                                                                 | 空                  | 与令牌文件**取并集**（不是覆盖）：它是"运维手上那把钥匙"                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ZCODE_SERVER_AUTH_TOKENS_FILE` | 令牌文件（每行一条，便于轮换/多设备）；`kill -HUP` 重载                                                        | 空                  | 重载**整体替换文件那一部分** ⇒ 删掉一行即刻失效；文件空/坏 ⇒ **拒绝启动**（不静默降级）                                                                                                                                                                                                                                                                                                                                                                              |
| `ZCODE_SERVER_TRUSTED_HOSTS`    | Host 白名单（**挡 DNS rebinding**）：`host` / `host:port` / `[IPv6]` / `[IPv6]:port`，**追加**在默认白名单之后 | 空 = 只用默认白名单 | 默认 = 回环 + 本机网卡 + 实际监听地址；**未配域名时不放行任意 Host**；**缺失/畸形 `Host` ⇒ 拒绝**（HTTP/1.1 不带 Host 由 Node 解析器先判 400）；登记项不写端口 = 该主机任意端口，写了则必须相等；拒绝时 403 + `X-ZCode-Host-Rejected: 1`。**反代域名必须登记**，否则你自己的域名也 403（有意行为）。**副作用：登记了生效项 = "会被外部访问"的信号 ⇒ 回环下也要求令牌**（见 §4 第 3 条）。完整口径见 [web-remote-control.md](../development/web-remote-control.md) §6 |
| `ZCODE_SERVER_TRUSTED_ORIGINS`  | 跨源白名单（**挡跨站请求**；前端与后端不同源时）                                                               | 空（= 只允许同源）  | 同源判定**恒优先**；空项/非法项被丢弃。**与上一条是两道不同防线，不要互相替代**。**回环 + 无令牌 + 只登记它 ⇒ 能启动但会打暴露面告警**（它**有意不参与**拒绝启动，理由见 §4 第 3 条）                                                                                                                                                                                                                                                                                |
| `ZCODE_SERVER_TRUSTED_PROXIES`  | 可信代理（IP/CIDR），只有它们给的 `X-Forwarded-For` 才被采信                                                   | 空 = **谁都不信**   | 反代不配它 ⇒ 所有客户端共用一个计数桶，一个人的连续失败会连带拒绝**所有人**（服务会告警）。**副作用：配了生效项 = "会被外部访问"的信号 ⇒ 回环下也要求令牌**（见 §4 第 3 条）                                                                                                                                                                                                                                                                                         |
| `ZCODE_SERVER_CSP`              | CSP 强度：`off` / `enforce`                                                                                    | report-only         | 拼错的值**回落 report-only** 并在启动日志说明                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ZCODE_SERVER_HSTS`             | 是否随 https 下发 HSTS                                                                                         | 关                  | 只在 **https 且显式开启** 时发；**一旦下发无法撤回**                                                                                                                                                                                                                                                                                                                                                                                                                 |

**这一版的边界（分四道闸，公网暴露前逐条自查）**：**非回环必须令牌（回环在有外部访问信号时也要求令牌）** ·
Host 白名单（挡 rebinding）· 来源校验（挡跨站）· 鉴权失败限流（挡暴力破解，默认 10 次/5 分钟 ⇒ 封 15 分钟）。
完整口径见 [web-remote-control.md](../development/web-remote-control.md) §4–§6 与
[反代部署](headless-server-reverse-proxy.md)。

**默认监听口径**：不传任何参数时 `--web` 绑定 **`127.0.0.1:3030`**（端口被占用则回退到空闲端口，日志会写明），且**回环默认不启用令牌**；
要对外（局域网/反代）必须显式 `--host`，此时**必须**带令牌（非回环 + 无令牌会**拒绝启动**）。
**回环也不是无条件放行**：一旦配了外部访问信号（见 §4 第 3 条），回环同样要求令牌。

---

## 6. 交付渠道取舍（本轮不发布任何 registry）

| 渠道                            | 用户门槛           | 维护成本                               | 命名风险                      | 外部副作用                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------ | -------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tarball 挂 Release / 自托管** | 低（下载解包）     | 低                                     | 无                            | 无                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Docker 镜像**                 | 中（要会 docker）  | 中（镜像体积、tag 策略、基础镜像更新） | 需要 image 名与 registry 归属 | 需要 registry 账号与权限                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **npm 包**                      | 最低（`npx` 即用） | 中（版本/更新通道、体积限制）          | **最高**（见下）              | 需要 npm 账号与 token。**发布内容 = 分发包根**（`pnpm build:zcode` 的 `dist/zcode/`，`bin` 映射 `bin/zcode.mjs`）；包名统一用 **`zcode-ce`**。**不要发布 `@zcode/server-cli`**：它 `private: true`、占用官方 scope，且其 `bin` 指向的 bundle 直接执行会抛 `Dynamic require of "fs" is not supported`（在本仓直接执行该 bundle 即可复现；`packages/zcode-server-cli` 的 `bin` 不要用于发布）。该缺陷的回归判据在 `packages/zcode-server-cli/test/`。 |

**命名硬约束（不得违反）**：

- `@zcode/*` 是**官方 scope**，社区版**不得占用**（也不得发布同名包冒充官方）。
- 仓库里的 `packages/zcode-server-cli` 是 `private: true`（本就不用于发布），**不要**把它改名/改私有性来"借"名字。
- 包名固定用 `zcode-ce`，与 §7.1 第 1 条同一口径。早先记过的两个候选写法 `@zcode-ce/server` 与
  `zcode-ce-server` 已作废，不要再按它们发布。包描述里注明"社区版，非官方发行版"；发布前至少确认：
  名称未被占用、`README` 里写明非官方。

**支持成本是真实成本**：一旦发布，用户会用**你无法控制的环境**提 issue（旧内核、无 systemd、只读 rootfs、
代理/证书……），而"版本通道"也要你维护。判断标准是"我们是否愿意长期接住这些 issue"，不是"打包有多容易"。

---

## 7. 「ce.3 发版时的发布清单」（已批准，本轮不执行）

> 前提：真正打 tag 发 release 时才做；**失败不得阻塞 tag 发版**（job 独立、仅 tag/dispatch 触发）。
> **将来真做时也不得用 `continue-on-error`** —— 理由与 §7.1 第 5 条相同：
> 交付终点（推 registry）失败被吞掉后，CI 全绿而产物根本不存在，**误报成功比误报失败更危险**。
> 下面每一步都写成照着做即可的动作。

### 7.1 npm

1. **包名固定用 `zcode-ce`**（**已于 2026-09-25T22:44:50Z 发布 `3.14.3-ce.3`**；只读核对：`npm view zcode-ce version` 现返回该版本号，`dist-tags` 的 `latest` 与 `next` 都指向它）。不得用 `@zcode/*`（官方 scope）。
2. **打包来源 = 发行包内的 `zcode/` 目录，不是 `dist/zcode/`**：`pnpm build:zcode` 产出的 `dist/zcode/` 是**发布站点根**（`install.sh` + `latest.json` + `releases/<版本>/*.tar.gz`），包根在 tarball 内的 `zcode/` 一层。
   构建脚本把包体 stage 到 `dist/zcode/.work/zcode`、打完 tar 后**删掉 `.work`**，所以 `dist/zcode/` 下**不存在可直接 publish 的目录** —— 必须先解包：`tar xzf dist/zcode/releases/<版本>/zcode-<版本>.tar.gz -C <staging>`，再对 `<staging>/zcode/` 生成 `package.json`。
   `bin` 必须映射到 `bin/zcode.mjs`（与 `install.sh` 用的同一个入口），不要指向任何 `packages/**/dist/*.js`。
   注意包内原生的 `package.json` 是 `{"name":"zcode-runtime","private":true,...}` —— **`private: true` 会让 `npm publish` 直接拒绝**，必须整个覆盖掉（不是合并）。
3. 准备包描述：覆盖 `<staging>/zcode/package.json`。**不能照抄下面这版的最小字段** —— 实测有两处会致命（详见本节末「实测结论」）：

   ```jsonc
   {
     "name": "zcode-ce",
     "version": "<与 tag 一致的版本>",
     "type": "module",
     "bin": { "zcode": "bin/zcode.mjs" },
     "files": ["bin", "server", "agent", "web", "!**/*.map"],
     "dependencies": {
       /* 46 个运行时依赖，版本从包内 node_modules/<name>/package.json 读 */
     },
     "bundleDependencies": [
       /* 与 dependencies 同名同序 */
     ],
     "engines": { "node": ">=24" },
     "license": "Apache-2.0",
     "repository": "Zcode-CE/Zcode-CE",
     "description": "社区版（非官方）无头服务器 + Web 面板",
   }
   ```

   - **`node_modules` 必须靠 `bundleDependencies` 进包**：npm **无条件排除**包根 `node_modules`，写进 `files` 或加 `.npmignore` 都无效（实测三种写法都进不去）。少了它，服务会**先打印启动横幅再崩** `ERR_MODULE_NOT_FOUND: Cannot find package 'yaml'` —— 只看横幅会误判成功。
   - **`.map` 用 `!**/_.map`排除**：2 279 个 sourcemap 全在`web/assets/`，实测占 tarball 16 MB（81.9 MB → 65.9 MB）。注意 `!\*\*/_.map`**不会**排除包内`node_modules` 里那 31 个小 map（1.4 MB，属上游发布物，留着无妨）。
   - **`type: "module"`**：不加仍能跑，但每次启动都报 `MODULE_TYPELESS_PACKAGE_JSON` 警告（`server/entry-http.js` 会被重解析）。
   - `bin/zcode.mjs` 首行要有 shebang（`#!/usr/bin/env node`）并保持可执行位；实测包内已是 `755`。

4. 凭据：在仓库 secrets 里加 `NPM_TOKEN`（npm Access Token，Automation 类型；权限只需 publish 该包）。
   **⚠️ 令牌本身不能是需要交互式双重验证的类型**：实测上传成"需要 2FA 的版本"时，CI 里 `npm publish` 会失败（无人可应答 OTP）。
   **⚠️ 必须给 `actions/setup-node` 配 `registry-url`**（实测踩过）：只有拿到它，setup-node 才会生成 `.npmrc`，
   而 `NODE_AUTH_TOKEN` 是**写进那个 `.npmrc`** 的。缺了它，`npm publish` 直接 `ENEEDAUTH`
   （包已打好、shasum 已算出，却在认证阶段退出 —— registry 上什么都没有）。
   本仓库还在 job 里加了 `Preflight npm auth` 前置检查（`npm whoami` 真打 registry），让"令牌不可用"在**构建之前**就暴露，
   而不是等到几百 MB 的包白打好之后。它的触发条件必须与发布路径一致（`startsWith(github.ref, 'refs/tags/')`），
   否则会出现"tag 推送 + 基址未配置 ⇒ 前置检查被跳过、而 stage/publish 仍执行"的错配。

   **发布后校验的时间预算**：`Verify npm package` 用 `npx -y zcode-ce@<版本>` 起服务并等 `200`。
   实测本包 **解包约 293 MB / 11864 个文件**，npx 要**先下载再解包**才轮到起服务 ——
   原先的 **60s 预算不够**（`v3.14.3-ce.3` 因此"包发出去了但校验红"）。现已放宽到 **300s**，
   并把"下载解包"与"起服务"**分开计时**（合并成一个预算会看不出卡在哪一段）。
   **这不是放宽标准**：失败判据（拿不到 `200` 就 `exit 1`）没变，只是不再用不够的时间去误判。

5. CI job 形态（**已落地**，在 `release.yml` 的 `headless-server-package` job 内）：checkout → pnpm install →
   `build-zcode` → smoke → 挂 Release / 上传 artifact → stage npm 包 → `npm publish` → 发布后验证。
   **`continue-on-error` 已全部移除**：job 级与 `Publish to npm` / `Verify npm package` / `Attach package to release` 四处原先都设有它，
   后果是 **npm 发布实际失败（`ENEEDAUTH`）而 CI 显示全绿、registry 上根本没有这个包**。
   交付终点失败必须让流水线变红 —— 唯一保留的软降级是「基址未配置就跳过构建」这种显式选择（会打印 `::warning::`）。
   **npm 三步不依赖 `ZCODE_DIST_BASE_URL`**：该 job 的构建步骤在变量未配置时会 `exit 0` 跳过，
   而 npm 发布不需要那个变量（见 §2 的例外），所以它的触发条件是 `startsWith(github.ref, 'refs/tags/')`
   —— **不含** `packaged == 'true'`。缺分发包时它自己用 `--allow-placeholder-base-url` 构建一份并补跑 smoke。
   早先的写法把 npm 步骤挂在这个 job 的 `packaged` 输出上，结果是「变量没配 ⇒ npm 也不发」。
   **`--tag` 是必需的**：版本号是预发布（`3.14.3-ce.3`），不带 `--tag` 时 npm 直接报
   `You must specify a tag using --tag when publishing a prerelease version`（实测，退出码非 0）。
6. 发布后验证：`npm view <名字>@<版本> dist.shasum` 有值；另起干净容器 `npx -y <名字>@<版本> --web --no-open --port 3030` 后 `curl -sI localhost:3030/` 应为 200。
   **判据要打到进程存活，不能只看横幅**：缺依赖时服务会先打印 `ZCode Web is running` 再崩，因此必须同时确认进程仍在 + `curl` 真的拿到 200（本页 §7.1 末的实测就是这么做的）。
7. 回滚：72 小时内可 `npm unpublish <名字>@<版本>`；之后只能 `npm deprecate <名字>@<版本> "原因"` 并发布修复版本。

**实测结论（3.14.3-ce.3，Linux x64，Node v24.21.0，npm 12.0.2 —— 发布预演，未真发）**：
按上面第 2、3 条生成的包，`npm pack` 实测 **65.9 MB / 11 822 文件**（解包 293 MB），随后**真装真跑**通过：

| 检查项                               | 实测结果                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `npm pack`                           | 65.9 MB，11 822 文件（含 `bundleDependencies` 44 个）                                    |
| 含 `.map`？                          | 仅 `node_modules` 内 31 个 / 1.4 MB；`web/assets/` 的 2 279 个已被 `!**/*.map` 排除      |
| `npm i -g`（隔离 prefix）            | 通过，`node_modules` 完整保留，`bin/zcode` 软链正确                                      |
| **离线安装** `npm i -g --offline`    | 通过 ⇒ 打包的依赖自足，装时不联网                                                        |
| `bin/zcode.mjs`                      | 首行 `#!/usr/bin/env node`，权限 **755**（安装后仍 755）                                 |
| `zcode --web --no-open --port 39218` | `curl -sI localhost:39218/` → **200**；进程存活；`SIGTERM` 干净退出                      |
| `node-pty` 原生载荷                  | 从**装好的包**里 `pty.spawn` 成功（`exitCode=0`），`prebuilds/linux-x64/pty.node` 在包内 |
| `npm publish --dry-run --tag next`   | 通过（`+ zcode-ce@3.14.3-ce.3`）；**不带 `--tag` 会失败**                                |

**体积上限余量**：npm 单包 tarball 上限约 100 MB，本包 65.9 MB ⇒ 余量约 34 MB。

**未验证项**：① 包名 `zcode-ce` 的真实注册（E404 只说明当前未被占用，首次 publish 才算数）；② 从 registry 安装（`npx zcode-ce@<版本>`）—— 预演只验了本地 tarball；③ macOS / Windows / musl 上装这个 npm 包（包内 `node-pty` 预编译含 darwin/win32，但本机只实测了 linux-x64）；④ `engines: ">=24"` 在 Node 22 上的实际表现（本机只有 Node 24，未构造低版本环境）。

**「base-url 不影响 npm 包」的实测证据（2026-09-25，本机 Linux x64）**：
用两个不同基址各构建一份（`https://cdn-a.invalid/zcode/` 与 `https://cdn-b.invalid/other/`），
两份的 `install.sh` 与 `latest.json` 确实不同，但解包后的包树 `diff -r` **无差异**；
再各自 `stage-npm-package` 后 `diff -r` 两份 staging 目录，同样**无差异**。
另用 `--allow-placeholder-base-url`（不配 `ZCODE_DIST_BASE_URL`）走完整条 CI 步骤：
占位域名只出现在 `dist/zcode/install.sh` 里，`grep -rI zcode-dist.invalid dist/npm-stage` **0 命中**，
staging 根下也不存在 `install.sh` / `latest.json`；
装到隔离 prefix 后 `zcode --web --no-open` 起服务并 `curl -sI` 拿到 **200**。

### 7.2 Docker

本版状态（ce.3）：仓库根已提供本地 Docker 资产 —— `Dockerfile` + `compose.yaml`（不推任何 registry，由用户本地 `docker build`）。
用法、卷/令牌/局域网访问/安全边界与九条实测证据见 [headless-server-docker.md](./headless-server-docker.md)；
下面第 1、3~7 条是**将来真要发布镜像时**的清单（今天未执行）。

1. 确定镜像名：建议 `ghcr.io/<你的 org>/zcode-ce-server`（走 GitHub Container Registry 可复用 `GITHUB_TOKEN`，无需额外账号）。
2. 镜像构建（已落地为仓库根的 `Dockerfile`）：以 `dist/zcode/` 为上下文、单阶段、基础镜像 `node:24-slim`（Debian/glibc）——
   产物已是自包含分发包，因此**不需要**多阶段构建。`ADD releases/<版本>/zcode-<版本>.tar.gz /opt/`（ADD 自动解包），
   `ENV ZCODE_DATA_BASE_DIR=/data`、`VOLUME /data`、`EXPOSE 3030`、`ENTRYPOINT ["node","/opt/zcode/bin/zcode.mjs"]`、
   默认 `CMD ["--web","--host","0.0.0.0","--no-open","--workspace","/workspace"]`，非 root（uid 10001）运行并带 `HEALTHCHECK`。
   **令牌必须由运行方注入**（`--token=<值>` 或令牌文件 `ZCODE_SERVER_AUTH_TOKENS_FILE`），**不要**打进镜像；
   用 `alpine` 基础镜像必须先自装 musl 版 **Node ≥24**，且**终端功能不可用**（见 §10 的 `Alpine / musl` 一行）。
3. 凭据：ghcr 用内置 `GITHUB_TOKEN`（需 `packages: write` 权限）；若推别的 registry，加 `REGISTRY_USERNAME`/`REGISTRY_TOKEN` secrets。
4. CI job 形态：job `publish-docker-headless`，条件同 npm；步骤：build → `docker tag` → `docker push` 两个 tag（`:<版本>` 与 `:latest`）。
   **不设 `continue-on-error`**：镜像推不上去就是交付终点失败，必须让流水线变红（与 §7.1 第 5 条同一纪律）。
5. 发布后验证：`docker run --rm <镜像>:<版本> --help` 退出码 0；再 `docker run --rm -p 3030:3030 <镜像>:<版本> --web --host 0.0.0.0 --token <临时>` 后 `curl -sI localhost:3030/` → 200、`curl -sI localhost:3030/api/server-info` 无 token → 401。
6. 回滚：删除该 tag（ghcr 网页或 `gh api -X DELETE`）；`:latest` 指回上一个版本。

### 7.3 两者共同的注意事项

- **不要**把凭据写进镜像层、命令行参数（会进进程列表/镜像历史）或日志。
- 发布 job 必须与 tag 发版**解耦**：registry 故障不该让"安装包已经好了"的发版失败。
  **但解耦不等于吞失败** —— 不得用 `continue-on-error`（或任何等价物）：它会把"镜像/npm 包根本没发出去"伪装成成功，
  而**误报成功比误报失败更危险**（实测先例见 §7.1 第 5 条：`ENEEDAUTH` 导致 npm 发布失败而 CI 全绿、registry 上根本没有这个包）。
- 发布前先跑既有 smoke（见 §8）；发布后在干净环境复核 §7.1/§7.2 的验证命令。

---

## 8. 验证方式（仓库内可复现）

```bash
pnpm build:zcode --base-url <依赖托管基址>            # 1) 构建
# 2) smoke：路径必须含 <版本>/ 这一层。`releases/*.tar.gz` 少一层 ⇒ 匹配不到（shell 把字面量
#    原样传给 tar ⇒ status 2）；`releases/*/*.tar.gz` 会连历史版本一起匹配 ⇒ smoke 只读 argv[2]，
#    且 glob 按字典序 ⇒ 可能"测旧版、发新版"。CI 里由 build 步骤输出精确路径，这里手工跑同理。
VERSION="$(node -p "require('./package.json').version")"
node scripts/zcode-distribution-smoke.mjs "dist/zcode/releases/$VERSION/zcode-$VERSION.tar.gz"
```

发布到 CDN（让 `install.sh` 的布局成立；机制与缓存头口径见
[remote-assets-cdn.md §14](./remote-assets-cdn.md)）：

```bash
# 2) 先看要传什么、要删什么（不写桶；--dry-run 下 --public-base-url 可省）
node scripts/upload-headless-release-r2.mjs --dist dist/zcode \
  --bucket <bucket> --public-base-url https://<域名> --keep-versions 10 --dry-run

# 3) 真上传（上传后逐个自检 sha256 / latest.json 内容；清理需 --yes）
node scripts/upload-headless-release-r2.mjs --dist dist/zcode \
  --bucket <bucket> --public-base-url https://<域名> --keep-versions 10 --yes
```

顺序仍是「**先发载荷、再发版**」：`install.sh` 从 `<BASE>/latest.json` 取版本，
载荷没传完就发版会让用户装到一半失败。

**发布前最低判据**：`node bin/zcode.mjs --help` 与 `node bin/zcode.mjs --version` 都必须**退出码 0**（用户形态的第一步；比 smoke 更快）。

smoke 在**隔离目录**里解包并驱动这个包：TUI 导入、`--web` 起服务、`/` 壳、`/api/server-info`、
WebSocket、优雅退出；失败即非零退出。本版实测（3.14.3-ce.2，Linux x64，**glibc 发行版**）：

```text
{"version":"3.14.3-ce.2","platform":"linux","arch":"x64",
 "tui":"native import, initialized render, keyboard exit passed",
 "web":"HTML, server-info, workspace, WebSocket, shutdown passed","isolated":true}
smoke-exit=0
```

**这几条安全不变式现在由 smoke 常驻守着**（`scripts/zcode-distribution-smoke.mjs`，在**解包产物**上验；
两条新断言都确认过有效：把它们改放松，smoke 会立即变红）：

| 不变式                                                                                                                 | 状态                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/api/server-info` 无令牌 **401** / 带 `?token=` **200**                                                               | ✅ smoke 覆盖（摘要里的 `security` 字段）                                             |
| `/ws` 无令牌升级被拒（**401**）                                                                                        | ✅ smoke 覆盖（加固时才发现：此前的无令牌直连只是"恰好被放行"，并不是断言守住的）     |
| 非回环 + `--no-token` **拒绝启动**，且退出码必须是**非 0 的数字**、日志含 `Refusing to start/拒绝启动` 与 `token/令牌` | ✅ smoke 覆盖（服务若真起来会被超时杀掉、`code` 为 `null`，断言据此判红，不会假通过） |
| `--token=` 空值路径                                                                                                    | ⚠️ **未覆盖**（一次性脚本验过 `exit 1`，与 `--no-token` 同判定）                      |
| 令牌 cookie 的 `HttpOnly` / `SameSite` / `Secure` 属性                                                                 | ⚠️ **未覆盖**                                                                         |
| 多客户端（手机 + 桌面同时连）并发语义                                                                                  | ⚠️ **未覆盖**（见 [web-remote-control.md](../development/web-remote-control.md) §8）  |

手工复核（不属于 smoke）：

| 检查                                                          | 实测结果                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `/` 与静态资源                                                | `/` → **200**；壳里引用的 `/assets/index-*.js` → **200**          |
| 带 `Cookie: zcode_lite_token=<token>` 访问 `/api/server-info` | **200**                                                           |
| 回环 + `--no-token`（**未配任何外部访问信号**）               | 允许启动并访问（本地开发路径）；配了信号则拒绝启动，见 §4 第 3 条 |

## 9. 已知限制与未验证项

- **npm 已发布，Docker 镜像未发布**（两个渠道状态不同，不要合并读）：
  - **npm**：`zcode-ce@3.14.3-ce.3` **已于 2026-09-25T22:44:50Z 真发**（核对：`npm view zcode-ce version` ⇒ `3.14.3-ce.3`），
    发布流水线 `release.yml` 的 `headless-server-package` job 内含 `Stage npm package` / `Publish to npm` / `Verify npm package` 三步，
    tag 推送即执行（**不再有 `continue-on-error`**，见 §7.1 第 5 条）。包描述、体积与全部实测数据见 §7.1 末「实测结论」——
    注意那张表的标题写的是「发布预演」，那是**真发之前**那次本地预演的记录，标题保留原样作为历史。
  - **Docker 镜像**：**不发布**。`release.yml` 里**没有**任何 docker job（`grep -n docker .github/workflows/release.yml` 0 命中），
    §7.2 的 registry 发布步骤仍未执行。**本地 Docker 资产已提供**（仓库根 `Dockerfile` + `compose.yaml`，
    由用户自行 `docker build`，见 [headless-server-docker.md](./headless-server-docker.md)），Docker 侧只到「本地 `docker build`」。
- **依赖载荷托管位置**：本仓库发布时托管在社区 CDN（`ZCODE_CDN_BASE_URL`，见
  [remote-assets-cdn.md](./remote-assets-cdn.md)）；`--base-url` 指向的依赖由部署方决定，
  自建者不配就仍是占位/官方默认。**npm 形态不需要它**（见 §2 的例外）。
- **本机与远端都有 libc 拦断，且都在失败之前**：**正式支持**的是 **glibc 发行版**（见 §10 的 `Linux-x64（glibc）` 一行）。远端工作区在**连接时**先判 libc 再部署资产；**本机**（CLI / 无头 server）在**创建终端之前**判定，命中 musl 时给出可操作错误并正常退出 —— 不再出现原生 fork 的段错误（实测对照见 §10）。
- **musl 上的能力边界（实测）**：Alpine 系**可以运行服务与面板**（需满足 `engines` 的 Node 版本，见 §10），**终端功能不可用**并会明确提示；本版**不承诺** musl 上的完整能力。
- **Docker 作为承载环境已实测**（Linux x64，`node:24-slim` 本地构建）：`GET /` 200、`/api/server-info` 无令牌 401 / 带令牌 200、`/ws` 401、**容器内 pty 可开**（uid 10001 下 `terminal-exit=0`）、卷持久化、`SIGTERM` 优雅退出（exit 0，约 1 s）、HUP 令牌重载（送给 `entry-http.js` 子进程时生效）、`compose config/build/up/down` 全通 —— 逐条命令与输出见 [headless-server-docker.md](./headless-server-docker.md) §10。**WSL 作为承载环境仍未实测**；只在 Linux 上验证。
- **令牌无设备级吊销**：只能整体轮换（换 `--token` 重启，或令牌文件 + `SIGHUP` 删行）。**鉴权失败限流已落地**（默认 10 次/5 分钟 ⇒ 封 15 分钟，见 §5.1），但它是按地址计数的粗粒度防线，不替代令牌强度。公网暴露风险自担（§4）。
- **手机 + 桌面同时连同一会话的并发语义未测**（见 [web-remote-control.md](../development/web-remote-control.md) §8）。

---

## 10. 平台支持矩阵（未实测的不要当已验证）

**本表的「未实测」现在有了一条可执行的路径**：`.github/workflows/cross-platform.yml` 在
`ubuntu-latest` / `macos-latest` / `windows-latest` 上各跑一次
`node scripts/build-zcode.mjs --allow-placeholder-base-url` + 既有 smoke
（构建 → 解包 → 真跑 TUI 与 `--web` 面板）。它**不进每个 PR**（`workflow_dispatch` + 每日 `schedule`），
理由见 [ci.md](./ci.md) 的「跨平台实测」。**它不设 `continue-on-error`**：某个 OS 跑不通就让它红，
那是本工作流要产出的信息本身。

⚠️ **该工作流在真实 runner 上的首次结果尚未观测**（Actions 只能在 GitHub runner 上执行，本地无法跑工作流）。
因此下表的 macOS / Windows 两行**在拿到那次的运行结论之前，仍必须读作「未实测」**——
工作流存在只说明「可测」，不等于「测过了」。

| 平台                                          | 能构建                                                                                   | 能启动 `--web`            | 能连面板  | 终端功能                                                              | 令牌轮换（`SIGHUP`）                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------- | --------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Linux-x64（glibc）**                        | ✅ 已实测                                                                                | ✅ 已实测                 | ✅ 已实测 | ✅ 已实测                                                             | ✅ 已实测                                                                   |
| **Alpine / musl**                             | ❌ 本版不发布 musl 平台类                                                                | ✅ **已实测**（Node ≥24） | ✅ 已实测 | ❌ **不可用**（拦断 + 可操作错误，实测无段错误）                      | ✅ 已实测                                                                   |
| **Docker（`node:24-slim` 内，本版本地构建）** | ✅ 已实测（`docker build -f Dockerfile dist/zcode`）                                     | ✅ 已实测                 | ✅ 已实测 | ✅ 已实测（容器内 pty 可开）                                          | ✅ 已实测（送给 server 进程；`docker kill -s HUP` 到不了，见 docker 页 §6） |
| Linux-arm64                                   | 推断                                                                                     | 推断                      | 推断      | 推断                                                                  | 推断                                                                        |
| macOS-x64 / arm64                             | **未知**（未在 mac 上构建过；跨平台工作流已可测，结果未观测）                            | 推断（`node-pty` 懒加载） | 推断      | 推断（**darwin 原生载荷在包内**，见下）                               | 推断可用（mac 有 SIGHUP）                                                   |
| **Windows-x64 / arm64**                       | **未知**（`install.sh` 是 POSIX 脚本 ⇒ 只能走 npm 形态；跨平台工作流已可测，结果未观测） | 推断                      | 推断      | 推断（**win32 原生载荷在包内**，但服务端终端与信号另有 Windows 分支） | ❌ **不成立**（见 §10.3）                                                   |

**⚠️ 原生载荷以包内实测为准（2026-09-27 解包产物）**：实测 `dist/zcode/releases/3.14.3-ce.3/zcode-3.14.3-ce.3.tar.gz`（`tar -tzf` 列目录），**6 个平台的载荷全在**：

| 载荷                        | 包内实际存在的平台目录                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `node-pty/prebuilds/`       | `darwin-arm64` `darwin-x64` `linux-arm64` `linux-x64` `win32-arm64` `win32-x64`（6 个全在） |
| `@mbears/opentui-core-`     | 同上 6 个平台目录全在（`opentui.dll` / `koffi.node` 等）                                    |
| `koffi/build/koffi/`        | `darwin_arm64` `darwin_x64` `linux_arm64` `linux_x64` `win32_arm64` `win32_x64`             |
| `unsafe-pointer/prebuilds/` | 同上 6 个平台目录全在                                                                       |

原因不在「按当前平台裁剪」，而在 **`pnpm-workspace.yaml` 的 `supportedArchitectures`**
（`os: [current, darwin, linux, win32]` / `cpu: [current, x64, arm64]`）—— `pnpm install` 会把
**全部 6 个平台**的原生包都装进 `node_modules`，打包脚本再整份拷走。
`scripts/zcode-distribution/assets.mjs` 里对 `supportedTargets` 的循环（`stageTuiRuntime`）
同样会为 6 个 target 各 stage 一份。
⇒ **「原生载荷缺失」不再是 macOS / Windows 的第一障碍**；真正的未知项是构建链与 smoke 里的
POSIX 假设（见 §10.1），那些必须由 `.github/workflows/cross-platform.yml` 实测才能定论。

**⚠️ 未覆盖：包内同时带着一份「本机编出来的」`build/Release/pty.node`（见 §10.2）。**

远程工作区组件清单只有 `linux-x64/arm64` + `darwin-x64/arm64` —— 那属于**远程工作区运行时**，
与本机 CLI 的原生依赖是两件事（`win32` 远程组件仍缺，见 `.reverse/36-ssh/ROADMAP.md` 阶梯 ⑤）。

**musl 上的边界（为什么服务能跑、终端不行）**：上游 `node-pty` 的预编译**没有 musl 变体**，所以终端这一项在本版不可用；服务与面板不依赖它，因此可用。**这不是我们的取舍**，三条上游事实：① 上游 `node-pty` 的预编译**没有 musl 变体**（只有 glibc 的 `linux-x64`/`linux-arm64` 等）；② 官方发行版的资产集同样只有 `platformArch` 维度、**没有 `-musl` 平台类**，其 Linux 侧原生载荷是单份 glibc 二进制；③ 官方对「没有该平台预编译」的处置只是终端不可用，用户看不到 libc 层面的说明。⇒ 因此本版把 `Alpine / musl` 明确列为**不成立**，而不是「未实测」。

**实测结果（Alpine 3.24.2 + musl 版 Node，npm 形态跑本仓 JS）**：**服务与面板可用** —— `GET /` 返回 200（15 519 B 面板外壳）、`/api/server-info` 无令牌 401 / 带令牌 200、`/ws` 无令牌 401、agent 0.16.9、进程存活；**终端不可用** —— 走守卫时输出 `BLOCKED` 与可操作提示并**正常退出**，而**去掉守卫**直接原生 fork 会 `exit=139`（这正是本版加守卫要消灭的现象）。

**Node 版本下限（实测 + 与仓库一致）**：需 **Node ≥24**。下限不足时可能在**打印启动横幅之后**才失败，例如 Node 20.19.5 在导入期硬失败（`SyntaxError: … fs/promises does not provide an export named glob`；agent 另报 `No such built-in module: node:sqlite`），Node 22.16.0 服务端可全通但不满足本版声明。musl 上的获取方式（实测）：Alpine 3.24 `apk add nodejs` → **v24.18.1**（已满足）；其它镜像可用 unofficial-builds 的 `linux-x64-musl` 24.x（24.0.0 / 24.9.0 / 24.14.0 / 24.18.1 实测均 HTTP 200）。

**历史对照：没有守卫时的现象**（这三种失效形态正是本版加守卫要消灭的对象，**不是本版现状**）：直接执行 glibc 的 `node` 载荷 → `sh: …: not found`（缺 `/lib64/ld-linux-x86-64.so.2`）；装 `gcompat`+`libstdc++` 后 → `Error relocating … fcntl64: symbol not found`，退出码 **127**；改用 musl 的 node 启动，`pty.node` 能被加载，但**建终端时段错误**（**139**）并带走整个进程。有守卫之后走的是上面那条「输出 `BLOCKED` + 可操作提示 + 正常退出」的路。

**本机路径也有运行时守卫**（2026-09-24 `b77fe21` 落地）：`packages/services/src/terminal/localLibcSupport.ts` 的
`assertLocalTerminalNativeSupported()`，由 `terminalService.ts` 在**第一次原生 `dlopen` / `spawn` 之前**调用 ——
命中 musl 时给出可操作错误并正常退出，而不是让原生 fork 段错误带走整个进程。判据（为什么必须前置而不是
「打日志后继续」）写在 `terminalService.ts` 的调用点注释里：musl 能成功装载 glibc 的 `pty.node`，
所以 `import("node-pty")` 的 `.catch` 不会触发，失败发生在更晚的 spawn。**为什么非要前置**：段错误不可捕获、
是进程级死亡 —— 用户看到的是「服务莫名其妙没了」，而不是一条错误信息。

**远端工作区另有一套守卫**：远端必须是 glibc，连接时在部署资产之前就拦断 —— 口径见
[remote-workspace.md §7](../development/remote-workspace.md) 第 8 条。

**核实本机守卫的方式**：读 `terminalService.ts` 的调用点（`assertLocalTerminalNativeSupported` 的前置位置与理由）
与 `packages/services/test/terminalMuslGuard.test.ts`（含 musl/glibc 两种快照的断言），
以及构建期裁剪原生载荷的脚本 `packages/desktop/scripts/node-pty-package-assets.mjs`（它按当前平台拷贝预编译产物），
以及本页 §10 的支持矩阵。

### 10.1 三 OS 实测能测到什么、测不到什么（`.github/workflows/cross-platform.yml`）

| 事项                  | 该工作流覆盖                                                                     | **不**覆盖                                                                         |
| --------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 构建                  | `node scripts/build-zcode.mjs --allow-placeholder-base-url` 在三个 OS 上真跑一遍 | 发布构建（平台化 seed、远程资产装配、安装包生成）—— 那是 `release.yml`             |
| 启动 `--web` / 连面板 | 既有 smoke：解包后起服务、`/` 壳、`/api/server-info`、WebSocket、优雅退出        | 真实终端交互（conpty / spawn-helper）、浏览器端到端、反代与 TLS                    |
| 平台                  | `ubuntu-latest` / `macos-latest` / `windows-latest`（CI runner 镜像）            | **用户机器**（旧内核、不同 shell、企业代理、只读 rootfs）                          |
| 终端功能              | 只在 Linux 上被 smoke 覆盖                                                       | macOS / Windows 的终端能力**仍需真机验证**（`.reverse/36-ssh/ROADMAP.md` §3 末条） |

**当前实测结果（2026-09-27，run `36337338853`）—— 三 OS 全绿**：

| OS               | 结果           | 耗时  |
| ---------------- | -------------- | ----- |
| `ubuntu-latest`  | ✅ **success** | 2m14s |
| `macos-latest`   | ✅ **success** | 5m18s |
| `windows-latest` | ✅ **success** | 5m10s |

⇒ **「能构建 / 能启动 / 能连面板」三列在三个平台上全部从「推断」变成「实测通过」。**
macOS 此前整列是「未实测」；Windows 经五轮修复后转绿（见下表）。

**Windows 的五轮修复轨迹**（每一轮都由**真实 runner 的结果**定位，不是推测）：

| 轮  | Windows 的表现                                      | 修复                                                                    |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `Build`：`spawnSync pnpm ENOENT`                    | `199ac9b` 复用 `resolveSpawnRuntimeOptions`（cmd shim）                 |
| 2   | `Smoke`：`tar: gzip: stdin: unexpected end of file` | `9378191` 用 Node 原生解包替代外部 `tar`（GNU tar 把 `D:\` 当远程归档） |
| 3   | `Smoke`：权限位 `666 ≠ 755`                         | `05748b7` 三处 POSIX 专属断言按平台分叉                                 |
| 4   | `Smoke`：清理 `EPERM unlink conpty.node`            | `d0891f9` 清理失败不判红（Windows 文件锁）                              |
| 5   | **断言全过但 job 挂住 36 分钟**                     | `8651cfa` 断言跑完后显式退出（残留句柄）                                |

**注意第 3 轮的红正是下面 (B) 组预测过的**（连 `0o666` 都预测对了），
第 4、5 轮则是**预测之外的新发现**（Windows 文件锁与句柄回收语义）。
⇒ 这份「已知会红的点」清单**方向正确但不完整** —— 实跑才能补全。

**下面两组「已知会红的点」保留为历史记录**：(A) 已修，(B) 已按平台分叉。
它们记录了**为什么**这三处判据在 Windows 上不成立 —— 改动这段代码前先读它。

**已知会红的点**。按执行顺序有两组 —— **(A) 已由 `199ac9b` 修复并首次实测确认，
(B) 仍待 Windows 跑到那一步才能观测**：

**(A) 构建步骤本身（在 smoke 之前）** —— `scripts/build-zcode.mjs` 用裸 `spawnSync("pnpm", …)`
（`build-zcode.mjs:126` 的 `run()`，无 `shell: true`）调 `pnpm` 四次（`:171` `pnpm --filter @zcode/cli... build`、
`:180` `pnpm exec tsc -b`、`:186` `pnpm --filter @zcode/server build`、`:187` `pnpm --filter @zcode/web build`）。

- 机理：Windows 上 libuv 的 `path_search_walk_ext` 对**不带扩展名**的命令名**只试 `.com` 与 `.exe`**
  （[libuv `src/win/process.c`](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c) 原文注释
  _"Try .com extension" / "Try .exe extension"_），而 `pnpm` 在 Windows 上由 npm 以 `pnpm.cmd` 形式提供。
- **本仓已经知道这件事**：`scripts/spawn-command.mjs:6-21` 的 `resolveSpawnRuntimeOptions()` 注释写着
  「Windows runner 上 bare `pnpm` / `npm` 实际也是通过 cmd shim 提供」并因此返回 `{ shell: true }`。
  它被 `packages/desktop/scripts/bundle.mjs`、`scripts/third-party-npm.mjs`、
  `apps/zcode-cli/packages/cli/scripts/build-sea.mjs` 复用 —— **但 `scripts/build-zcode.mjs` 没有复用**。
- **诚实标注**：这条**未在 Windows 上实测**（本地只有 Linux），属**高置信度推断**；但 `pnpm install` 那一步
  不受影响 —— 它是 workflow 的 `run:` 步骤，由 pwsh 解析，pwsh 会走 `PATHEXT`。差异只出在 Node 的 `spawnSync`。
- 修法（**不属本单元**）：让 `build-zcode.mjs` 的 `run()` 复用 `resolveSpawnRuntimeOptions`。
  另外 `build-zcode.mjs:281` 的 `tar` 在 Windows 上把 `D:\…` 当**远程归档**（GNU tar 报
  `Cannot connect to D:`；bsdtar 不支持远程归档、按字面量处理）—— 是否出问题取决于 runner 上哪个 `tar` 先命中 PATH，**未验证**。

**(B) smoke 步骤** —— 两处**只在 POSIX 成立**的断言，Windows 上必然失败，失败在**第一处**
（`scripts/zcode-distribution-smoke.mjs:40`）：

1. **解包后的执行位**：`assertMode(bin/zcode.mjs, 0o755)` 与旁路模块 `0o644`。Windows 文件系统没有
   执行位概念，Node 的 `stat().mode` 对普通文件恒为 `0o666`（只读为 `0o444`）⇒ `0o755` 永不成立。
   **改判据也修不好**：Windows 上「可执行」不由位表达。
2. **`SIGTERM` ⇒ 退出码 143**（`smoke:168,178`）：`143 = 128 + SIGTERM(15)` 是 POSIX 语义。
   Windows 上 `process.kill(pid, "SIGTERM")` 落到 `TerminateProcess`，`node-pty` 的 Windows 终端
   报的是退出码而非信号 ⇒ 拿不到 143。同一原因也会让 `web.kill("SIGTERM")` 后的
   `assert.deepEqual([0, null])`（`smoke:248-249`）失败。

⇒ 本工作流在 Windows 上**预期红**。**不要用 `continue-on-error` 把它变绿**：那会把
「Windows 上这套 smoke 还没打通」伪装成「Windows 可用」。要让它绿，得先让 smoke 的判据按平台分叉
（属 `.reverse/36-ssh/ROADMAP.md` 阶梯 ② 之后的工作），而不是放宽断言。

### 10.2 ⚠️ 包内同时带着一份「本机编出来的」`node-pty/build/Release/pty.node`

**实测（`dist/zcode/releases/3.14.3-ce.3/zcode-3.14.3-ce.3.tar.gz`，解 node-pty 子树后用仓库自带的
fail-closed 护栏判）**：包内 `node_modules/node-pty/` 下同时存在两份来源不同的 `pty.node`：

| 路径                           | 大小     | sha256（前 12 位） | 来源                                             |
| ------------------------------ | -------- | ------------------ | ------------------------------------------------ |
| `build/Release/pty.node`       | 75 888 B | `7be4058f232b`     | **本机构建时 `node-gyp` 编出来的**（ELF x86-64） |
| `prebuilds/linux-x64/pty.node` | 75 976 B | `ce00b69d6524`     | `@lydell/node-pty-linux-x64` 的预编译产物        |

**为什么这是缺陷**：`node-pty` 的原生模块加载顺序是
`["build/Release", "build/Debug", "prebuilds/<platform>-<arch>"]`（`node_modules/node-pty/lib/utils.js:19`）
—— **`build/Release` 优先于 `prebuilds/`**。于是运行时会静默加载那份**我们没验证过**的本地编译产物。

**这条护栏仓库里已经有，但没接到无头链上**：`packages/desktop/scripts/node-pty-package-assets.mjs`
的 `assertPackagedNodePtyPayloadVerified()` 正是为这件事写的（fail-closed：产物里出现
`build/Release/pty.node` 就抛错），它被**桌面端**（`electron-builder.config.js`）与
**`packages/zcode-server-cli` 的 stage** 调用，而 `scripts/build-zcode.mjs` 的
`scripts/zcode-distribution/assets.mjs` **没有引用它**。

**实测复核命令**（只解 node-pty 子树，约 2 MB，不解整包）。**前提是先按 §8 构建出当前版本的产物**：
`VERSION` 取的是 `package.json` 的版本，没有对应 tarball 时 `tar` 会以 status 2 失败，不会静默通过：

```bash
# 版本目录这一层不能省（同 §8 的说明：releases/*.tar.gz 少一层会匹配不到）。
VERSION="$(node -p "require('./package.json').version")"
WORK=$(mktemp -d)
tar -xzf "dist/zcode/releases/$VERSION/zcode-$VERSION.tar.gz" -C "$WORK" zcode/node_modules/node-pty
node -e "import('./packages/desktop/scripts/node-pty-package-assets.mjs').then(({assertPackagedNodePtyPayloadVerified:a})=>{
  a({ nodePtyPackageRoot: process.argv[1] + '/zcode/node_modules/node-pty', platformKey: 'linux-x64' });
})" "$WORK"
rm -rf "$WORK"
```

实测输出（2026-09-27，本机 Linux x64）：

```text
分发产物内不得包含 node-pty 的 build/Release/pty.node：…/zcode/node_modules/node-pty/build/Release/pty.node
原因：node-pty 的加载顺序是 [build/Release, build/Debug, prebuilds/<platform>-<arch>]
（node-pty/lib/utils.js:19），build/Release 优先于 prebuilds ⇒ 运行时会静默加载这份
未经我们验证的原生模块（与打包恢复进来的那一份版本/校验和都不同）。
```

**现状与影响边界（如实声明，不要夸大）**：两份都是 **linux-x64** 的 ELF，因此**今天 Linux 上跑得动**
（smoke 常绿），失败只在「换了内核 / 不同 glibc / 特定交互」时才可能显形 —— 属最难排查的一类静默失效。
**本版未修**（不属本单元范围）；修法是让 `scripts/zcode-distribution/assets.mjs` 复用
`assertPackagedNodePtyPayloadVerified`，并剔除 `build/`。
⚠️ 这也说明：`build/Release/pty.node` 的存在**不影响** macOS / Windows 那两格 —— 在那些平台上
`build/Release/` 里没有对应文件（它是为宿主平台编的），加载顺序会落到 `prebuilds/<platform>-<arch>`。

### 10.3 ⚠️ Windows 上没有 SIGHUP（照抄 `kill -HUP` 会打死服务）

令牌文件的轮换靠 `SIGHUP`（`packages/server/src/entry-http.ts`）。Windows **没有这个信号**，而且**对进程发 SIGHUP 的语义是终止进程** ⇒ 在 Windows 上执行 `kill -HUP <pid>` 不是"重载令牌"，而是**把服务杀掉**。

Windows 下的替代做法（**当前版本未提供自动重载**）：改完令牌文件后**重启服务**。自动重载（文件监听或受保护的本地控制面）属后续版本。

## 11. 配置文件（把 `--web` 参数持久化）

不想每次敲一长串参数时，把常用值写进一个 JSON 文件（**不引入新依赖**，只在启动服务时读一次）。

| 项       | 值                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路径     | `~/.zcode/cli/server.json`（可用 `ZCODE_CLI_CONFIG` 指定别的路径）                                                                                                                            |
| 格式     | JSON（顶层必须是对象）                                                                                                                                                                        |
| 读取时机 | **只在真正启动服务时**读一次；`--help` / `--version` 不读（配置文件坏了也能拿到帮助）                                                                                                         |
| 优先级   | **命令行 flag > 环境变量 > 配置文件 > 内置默认**                                                                                                                                              |
| 键       | `host` `port` `workspace` `token` `noToken` `open` `authTokensFile` `trustedHosts` `trustedOrigins` `trustedProxies` `csp` `hsts`（与 §5.1 的旋钮表同口径；列表类键可用数组或逗号分隔字符串） |

**错误行为（fail-closed）**：文件不存在 ⇒ 用默认（不是错误）；`ZCODE_CLI_CONFIG` 指定的路径读不到 ⇒ **拒绝启动**；JSON 非法 / 键类型错 / 取值非法（如端口越界、`csp` 枚举错）⇒ **拒绝启动并指出哪个键、期望什么**；**未知键 ⇒ 告警但不拒绝启动**（取舍：配置文件跨版本共享，多一个键就拒绝启动会逼用户改文件才能升级；未知键只被忽略，不参与任何映射）。

```jsonc
{
  "host": "127.0.0.1",
  "port": 3030,
  "workspace": "/srv/work",
  "trustedHosts": ["panel.example.com", "10.0.0.5:8443"],
  "csp": "report-only",
}
```

**排障**：启动日志里的端口与预期不符 ⇒ 先看是不是被 flag/env 覆盖（优先级链），再确认配置文件路径（`ZCODE_CLI_CONFIG`）就是你编辑的那个。
