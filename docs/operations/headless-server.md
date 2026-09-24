# 无头服务器发行包（`zcode` · Web 面板）

> 面向**使用者与部署方**：把一个自包含的 `zcode` 包放到没有桌面环境的机器上，用浏览器（含手机）操作同一个工作台。
> 构造与运维细节见 [remote-assets-cdn.md](./remote-assets-cdn.md)（资产托管）与 [web-remote-control.md](../development/web-remote-control.md)（链路与安全全貌）。

---

## 1. 这是什么

一个**自包含发行包**：解包即得到

| 目录                                              | 内容                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `bin/zcode.mjs`                                   | 可执行入口（runner）：`zcode --web …` 起服务；也可直接跑 TUI                               |
| `server/`                                         | 服务端（HTTP + WebSocket + RPC + 静态资源托管）                                            |
| `agent/zcode.cjs`                                 | Agent 运行时（app-server bundle），**+ `agent/provider/` 内置 provider 配置 + 第三方声明** |
| `web/`                                            | Web 面板静态根（前端构建产物）                                                             |
| `install.sh` / `releases/*.tar.gz` + `sha256.txt` | 安装脚本与归档校验和                                                                       |

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

## 4. 安全边界（**按危险品对待**）

> **这条链路暴露的是 agent 级能力** —— 拿到连接就能在 `--workspace` 指向的目录里**执行命令、读写文件**。
> 把它当"一个网页"来暴露是本次最容易犯的错。

1. **默认只监听回环**：不传 `--host` 时绑定 `127.0.0.1`，只有本机能访问。
2. **非回环 + 无令牌 = 拒绝启动**：runner 在**参数解析阶段**就拒绝 `--no-token` 与非回环 host 的组合；
   服务端侧同样是 fail-closed 的硬检查（`packages/server/src/http.ts` 的监听前置检查）。**不要用"反正是内网"当理由关掉令牌。**
3. **启动期 + 运行期各有一次暴露面告警**（本版已落地，`packages/server/src/http.ts`）：
   绑定非回环时启动会打印可操作的告警；本会话**首次**收到非回环对端的**明文 http** 请求时会再提示一次。看到告警说明你正处在高风险配置上。
4. **明文 http 只限可信局域网**：令牌会出现在 URL 查询串（进浏览器历史）、cookie 默认**不带 `Secure`**；
   只有在 **https**（含反代带 `X-Forwarded-Proto: https`）时才追加 `Secure`。跨公网/不可信网络**必须**把
   **TLS 终结放在反向代理或隧道**上，服务本身仍只监听回环或私网。
5. **令牌是静态共享密钥**：无设备级吊销、无速率限制；泄露即等于交出 agent 级访问。轮换＝换 `--token` 重启。
6. **没有中继、没有云服务**：本仓库不托管配对服务器/二维码服务/官方 relay（全仓 0 命中）；可达性完全由你的
   局域网、SSH 隧道或反代提供。

**推荐的三条暴露方式（由安全到方便）**：

| 方式     | 命令/要点                                               | 适用               |
| -------- | ------------------------------------------------------- | ------------------ |
| 仅本机   | 默认即可（`127.0.0.1`）                                 | 单机调试           |
| SSH 隧道 | `ssh -N -L 3030:127.0.0.1:3030 <主机>` 后本地浏览器访问 | 跨机使用，无需证书 |
| TLS 反代 | Caddy/nginx 终结 TLS，只让反代对外                      | 手机/团队长期使用  |

> **放到反代 / TLS 之后的具体做法（Host 白名单现状、只支持挂域名根、可信代理与 `X-Forwarded-*` 的真实语义、Caddy/nginx 最小配置）见 [headless-server-reverse-proxy.md](./headless-server-reverse-proxy.md)。**

---

## 5. 凭据与数据目录

- **数据目录**：`~/.zcode/v2`（会话、任务索引、设置、设备身份）。headless 服务与桌面端**共用同一目录** ——
  同一台机器上同时跑两者时不要并发写同一工作区。
- **provider 凭据**：随包带 `agent/provider/zcode-builtin.json`（内置 provider/model 配置）；
  登录态（OAuth 令牌等）落在数据目录里，与桌面端一致。也可用环境变量覆盖端点
  （`ZCODE_BASE_URL`、`ZCODE_ENDPOINT_ORIGIN` 等，见仓库根 `.env.example`）。
- **不要**把 provider secret 写进命令行或镜像层；用环境变量或数据目录里的凭据。

### 5.1 服务端旋钮一览（环境变量）

| 旋钮                            | 作用                                                                                                           | 默认                | 备注                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZCODE_SERVER_AUTH_TOKEN`       | 显式单令牌（等价于 `--token`）                                                                                 | 空                  | 与令牌文件**取并集**（不是覆盖）：它是"运维手上那把钥匙"                                                                                                                                                                                                                                                                                                                        |
| `ZCODE_SERVER_AUTH_TOKENS_FILE` | 令牌文件（每行一条，便于轮换/多设备）；`kill -HUP` 重载                                                        | 空                  | 重载**整体替换文件那一部分** ⇒ 删掉一行即刻失效；文件空/坏 ⇒ **拒绝启动**（不静默降级）                                                                                                                                                                                                                                                                                         |
| `ZCODE_SERVER_TRUSTED_HOSTS`    | Host 白名单（**挡 DNS rebinding**）：`host` / `host:port` / `[IPv6]` / `[IPv6]:port`，**追加**在默认白名单之后 | 空 = 只用默认白名单 | 默认 = 回环 + 本机网卡 + 实际监听地址；**未配域名时不放行任意 Host**；**缺失/畸形 `Host` ⇒ 拒绝**（HTTP/1.1 不带 Host 由 Node 解析器先判 400）；登记项不写端口 = 该主机任意端口，写了则必须相等；拒绝时 403 + `X-ZCode-Host-Rejected: 1`。**反代域名必须登记**，否则你自己的域名也 403（有意行为）。完整口径见 [web-remote-control.md](../development/web-remote-control.md) §6 |
| `ZCODE_SERVER_TRUSTED_ORIGINS`  | 跨源白名单（**挡跨站请求**；前端与后端不同源时）                                                               | 空（= 只允许同源）  | 同源判定**恒优先**；空项/非法项被丢弃。**与上一条是两道不同防线，不要互相替代**                                                                                                                                                                                                                                                                                                 |
| `ZCODE_SERVER_TRUSTED_PROXIES`  | 可信代理（IP/CIDR），只有它们给的 `X-Forwarded-For` 才被采信                                                   | 空 = **谁都不信**   | 反代不配它 ⇒ 所有客户端共用一个计数桶，一个人的连续失败会连带拒绝**所有人**（服务会告警）                                                                                                                                                                                                                                                                                       |
| `ZCODE_SERVER_CSP`              | CSP 强度：`off` / `enforce`                                                                                    | report-only         | 拼错的值**回落 report-only** 并在启动日志说明                                                                                                                                                                                                                                                                                                                                   |
| `ZCODE_SERVER_HSTS`             | 是否随 https 下发 HSTS                                                                                         | 关                  | 只在 **https 且显式开启** 时发；**一旦下发无法撤回**                                                                                                                                                                                                                                                                                                                            |

**这一版的边界（分四道闸，公网暴露前逐条自查）**：非回环必须令牌 · Host 白名单（挡 rebinding）·
来源校验（挡跨站）· 鉴权失败限流（挡暴力破解，默认 10 次/5 分钟 ⇒ 封 15 分钟）。
完整口径见 [web-remote-control.md](../development/web-remote-control.md) §4–§6 与
[反代部署](headless-server-reverse-proxy.md)。

**默认监听口径**：不传任何参数时 `--web` 绑定 **`127.0.0.1:3030`**（端口被占用则回退到空闲端口，日志会写明），且**回环默认不启用令牌**；
要对外（局域网/反代）必须显式 `--host`，此时**必须**带令牌（非回环 + 无令牌会**拒绝启动**）。

---

## 6. 交付渠道取舍（**本轮不发布任何 registry**）

| 渠道                            | 用户门槛           | 维护成本                               | 命名风险                      | 外部副作用                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------ | -------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tarball 挂 Release / 自托管** | 低（下载解包）     | 低                                     | 无                            | 无                                                                                                                                                                                                                                                                                                                                                                   |
| **Docker 镜像**                 | 中（要会 docker）  | 中（镜像体积、tag 策略、基础镜像更新） | 需要 image 名与 registry 归属 | 需要 registry 账号与权限                                                                                                                                                                                                                                                                                                                                             |
| **npm 包**                      | 最低（`npx` 即用） | 中（版本/更新通道、体积限制）          | **最高**（见下）              | 需要 npm 账号与 token。**发布内容 = 分发包根**（`pnpm build:zcode` 的 `dist/zcode/`，`bin` 映射 `bin/zcode.mjs`）；包名统一用 **`zcode-ce`**。**不要发布 `@zcode/server-cli`**：它 `private: true`、占用官方 scope，且其 `bin` 指向的 bundle 直接执行会抛 `Dynamic require of "fs" is not supported`（复现见 `.reverse/36-ssh/HEADLESS-CLI-PACKAGE-RUNNABILITY.md`） |

**命名硬约束（不得违反）**：

- `@zcode/*` 是**官方 scope**，社区版**不得占用**（也不得发布同名包冒充官方）。
- 仓库里的 `packages/zcode-server-cli` 是 `private: true`（本就不用于发布），**不要**把它改名/改私有性来"借"名字。
- 建议形态（**可用性未验证，发布前必须自行确认**）：带 scope 的 `@zcode-ce/server`，或不带 scope 的
  `zcode-ce-server`；包描述里注明"社区版，非官方发行版"。发布前至少确认：名称未被占用、scope 归属你所有、
  `README` 里写明非官方。

**支持成本是真实成本**：一旦发布，用户会用**你无法控制的环境**提 issue（旧内核、无 systemd、只读 rootfs、
代理/证书……），而"版本通道"也要你维护。判断标准是"我们是否愿意长期接住这些 issue"，不是"打包有多容易"。

---

## 7. 「ce.3 发版时的发布清单」（已批准，**本轮不执行**）

> 前提：真正打 tag 发 release 时才做；**失败不得阻塞 tag 发版**（job 独立、`continue-on-error` 或仅 tag/dispatch 触发）。
> 下面每一步都写成照着做即可的动作。

### 7.1 npm

1. **包名固定用 `zcode-ce`**（只读核对：`npm view zcode-ce version` 目前返回 E404 = 尚无同名已发布包；**E404 不等于保证能注册**，最终以首次 publish 结果为准）。**不得用 `@zcode/*`**（官方 scope）。
2. **打包来源 = 分发包根**：先 `pnpm build:zcode`，再对 `dist/zcode/` 生成 `package.json`；`bin` 必须映射到 **`bin/zcode.mjs`**（与 `install.sh` 用的同一个入口），不要指向任何 `packages/**/dist/*.js`。
3. **准备包描述**：在 staging 目录（`dist/zcode/`）生成 `package.json`：
   `{ "name": "zcode-ce", "version": "<与 tag 一致的版本>", "bin": { "zcode": "bin/zcode.mjs" }, "files": ["bin", "server", "agent", "web"], "engines": { "node": ">=22" }, "license": "Apache-2.0", "repository": "Zcode-CE/Zcode-CE", "description": "社区版（非官方）无头服务器 + Web 面板" }`。
   注意：`bin/zcode.mjs` 首行要有 shebang（`#!/usr/bin/env node`）并保持可执行位。
4. **凭据**：在仓库 secrets 里加 `NPM_TOKEN`（npm Access Token，**Automation** 类型；权限只需 publish 该包）。
5. **CI job 形态**：新 job `publish-npm-headless`，`if: startsWith(github.ref, 'refs/tags/') && inputs.publish_registry == true`（或独立的 `workflow_dispatch`）；
   步骤：checkout → pnpm install → `pnpm build:zcode --base-url <依赖托管基址>` → 生成 `package.json` → `npm publish --access public`。**`continue-on-error: true`**。
6. **发布后验证**：`npm view <名字>@<版本> dist.shasum` 有值；另起干净容器 `npx -y <名字>@<版本> --web --no-open --port 3030` 后 `curl -sI localhost:3030/` 应为 200。
7. **回滚**：72 小时内可 `npm unpublish <名字>@<版本>`；之后只能 `npm deprecate <名字>@<版本> "原因"` 并发布修复版本。

### 7.2 Docker

1. **确定镜像名**：建议 `ghcr.io/<你的 org>/zcode-ce-server`（走 GitHub Container Registry 可复用 `GITHUB_TOKEN`，无需额外账号）。
2. **镜像构建**：以 `dist/zcode/` 为上下文的多阶段 Dockerfile：基础镜像 `node:24-slim`（或 `node:22-slim`），
   `COPY . /opt/zcode`，`ENV ZCODE_DATA_BASE_DIR=/data`，`VOLUME /data`，`EXPOSE 3030`，
   `ENTRYPOINT ["node","/opt/zcode/bin/zcode.mjs"]`，默认 `CMD ["--web","--host","0.0.0.0","--no-open","--token",""]`（令牌必须由运行方通过 env/参数注入，**不要**打进镜像）。
3. **凭据**：ghcr 用内置 `GITHUB_TOKEN`（需 `packages: write` 权限）；若推别的 registry，加 `REGISTRY_USERNAME`/`REGISTRY_TOKEN` secrets。
4. **CI job 形态**：job `publish-docker-headless`，条件同 npm；步骤：build → `docker tag` → `docker push` 两个 tag（`:<版本>` 与 `:latest`）。`continue-on-error: true`。
5. **发布后验证**：`docker run --rm <镜像>:<版本> --help` 退出码 0；再 `docker run --rm -p 3030:3030 <镜像>:<版本> --web --host 0.0.0.0 --token <临时>` 后 `curl -sI localhost:3030/` → 200、`curl -sI localhost:3030/api/server-info` 无 token → 401。
6. **回滚**：删除该 tag（ghcr 网页或 `gh api -X DELETE`）；`:latest` 指回上一个版本。

### 7.3 两者共同的注意事项

- **不要**把凭据写进镜像层、命令行参数（会进进程列表/镜像历史）或日志。
- 发布 job **必须**与 tag 发版解耦或 `continue-on-error`：registry 故障不该让"安装包已经好了"的发版失败。
- 发布前先跑既有 smoke（见 §8）；发布后在**干净环境**复核 §7.1/§7.2 的验证命令。

---

## 8. 验证方式（仓库内可复现）

```bash
pnpm build:zcode --base-url <依赖托管基址>            # 1) 构建
node scripts/zcode-distribution-smoke.mjs dist/zcode/releases/*.tar.gz
```

**发布前最低判据**：`node bin/zcode.mjs --help` 与 `node bin/zcode.mjs --version` 都必须**退出码 0**（用户形态的第一步；比 smoke 更快）。

smoke 在**隔离目录**里解包并驱动这个包：TUI 导入、`--web` 起服务、`/` 壳、`/api/server-info`、
WebSocket、优雅退出；失败即非零退出。本版实测（3.14.3-ce.2，Linux x64）：

```text
{"version":"3.14.3-ce.2","platform":"linux","arch":"x64",
 "tui":"native import, initialized render, keyboard exit passed",
 "web":"HTML, server-info, workspace, WebSocket, shutdown passed","isolated":true}
smoke-exit=0
```

**这几条安全不变式现在由 smoke 常驻守着**（`scripts/zcode-distribution-smoke.mjs`，在**解包产物**上验；
两条新断言都做过反向验证：把它们改放松，smoke 立即变红）：

| 不变式                                                                                                                 | 状态                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/api/server-info` 无令牌 **401** / 带 `?token=` **200**                                                               | ✅ smoke 覆盖（摘要里的 `security` 字段）                                             |
| `/ws` 无令牌升级被拒（**401**）                                                                                        | ✅ smoke 覆盖（加固时才发现：此前那次无令牌直连其实是"恰好被允许"）                   |
| 非回环 + `--no-token` **拒绝启动**，且退出码必须是**非 0 的数字**、日志含 `Refusing to start/拒绝启动` 与 `token/令牌` | ✅ smoke 覆盖（服务若真起来会被超时杀掉、`code` 为 `null`，断言据此判红，不会假通过） |
| `--token=` 空值路径                                                                                                    | ⚠️ **未覆盖**（一次性脚本验过 `exit 1`，与 `--no-token` 同判定）                      |
| 令牌 cookie 的 `HttpOnly` / `SameSite` / `Secure` 属性                                                                 | ⚠️ **未覆盖**                                                                         |
| 多客户端（手机 + 桌面同时连）并发语义                                                                                  | ⚠️ **未覆盖**（见 [web-remote-control.md](../development/web-remote-control.md) §8）  |

手工复核（不属于 smoke）：

| 检查                                                          | 实测结果                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| `/` 与静态资源                                                | `/` → **200**；壳里引用的 `/assets/index-*.js` → **200** |
| 带 `Cookie: zcode_lite_token=<token>` 访问 `/api/server-info` | **200**                                                  |
| 回环 + `--no-token`                                           | 允许启动并访问（本地开发路径）                           |

## 9. 已知限制与未验证项

- **未对外发布**：本仓库的发布流水线目前只**构建 + 冒烟 + 挂 workflow artifact**，不发布到 npm/Docker（§7 是已批准但未执行的清单）。
- **依赖载荷托管位置未定**：`--base-url` 指向的依赖由部署方决定；本仓库不提供默认值。
- **Docker / WSL 作为承载环境未实测**；只在 Linux 上验证。
- **令牌无吊销/无速率限制**：公网暴露风险自担（§4）。
- **手机 + 桌面同时连同一会话的并发语义未测**（见 [web-remote-control.md](../development/web-remote-control.md) §8）。
