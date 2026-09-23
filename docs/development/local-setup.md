# 本地开发

## 环境

版本以 [mise.toml](../../mise.toml) 为准：Node.js **24.14.0**、pnpm **10.33.2**。

## 初始化

```bash
pnpm install
```

> `pnpm bootstrap` 会额外准备桌面运行资源与远程资源（需要网络下载 Electron / Node 运行时）。仅做源码开发时，`pnpm install` 即可。

## 常用命令

| 用途             | 命令                                    |
| ---------------- | --------------------------------------- |
| 类型检查         | `pnpm typecheck`                        |
| Lint             | `pnpm lint` / `pnpm lint:fix`           |
| 格式检查         | `pnpm fmt:check`                        |
| 测试             | `pnpm test`                             |
| 桌面开发         | `pnpm dev:desktop`                      |
| Web 开发         | `pnpm dev:web`                          |
| 架构检查         | `pnpm architecture:check --changed`     |
| 模块阅读包       | `pnpm architecture:context <module-id>` |
| 未使用依赖与导出 | `pnpm knip`                             |

## 测试

测试运行器是 Node 内置的 `node:test`，配 `tsx` 解析 TypeScript：

```bash
pnpm test                          # 全部
cd packages/ui && node --import tsx --test test/*.test.ts   # 单包
```

**注意**：`packages/ui` 使用 tsconfig paths 的 `@/*` 别名，**必须从包目录内执行**，从仓库根跑会 `ERR_MODULE_NOT_FOUND`。`scripts/run-tests.mjs` 已处理这个差异。

## 类型检查的覆盖范围

`pnpm typecheck` 的工程列表**不含** `packages/desktop/tsconfig.main.json` 与 `tsconfig.renderer.json`。改动 desktop main/renderer 时需额外跑：

```bash
bash scripts/desktop-typecheck-baseline.sh diff
```

它用 `git worktree` 取真实 HEAD 做对比，只报**净增**的错误。

## Web 工作台的监听与对外访问

**默认只绑回环**：`pnpm dev:web`（以及 `pnpm dev:server`）在未设置 `HOST` / `ZCODE_SERVER_HOST` 时监听 `127.0.0.1`，且不启用令牌鉴权 —— 这类「无鉴权的对外监听」被明确禁止：服务端的 `/api/*`、`/ws`、`/ws/host` 在该配置下等同于把 Agent 级 RPC 与 trusted-host 凭据发放接口交给整个网段（`POST /api/rpc-host-capability` 会签发 30 秒有效的一次性 ticket，`/ws/host` 凭该 ticket 即得 trusted host 角色）。因此：

- **显式绑定非回环地址 + 未设置 `ZCODE_SERVER_AUTH_TOKEN` ⇒ 服务端拒绝启动**（fail-closed，与 `zcode-server-cli` 的 server-core 立场一致），报错会给出令牌生成方式与下面三条路线。
- 启动日志会打印**真实监听地址与安全前提**，例如 `bind=127.0.0.1 scope=loopback-only token-auth=disabled`；非回环且带令牌时打印 `scope=non-loopback token-auth=enabled`。

### 三条路线

1. **只在本机用**（默认）：不设任何变量，浏览器访问 `http://127.0.0.1:<PORT>`。
2. **手机/另一台机器访问，但不暴露到公网**：保持回环监听，靠私有网络或隧道打通，**不需要证书**：
   - 私网：Tailscale / WireGuard 之类把你的设备放进同一私有网络，然后指向该私网地址；
   - SSH 隧道：`ssh -N -L 3030:127.0.0.1:3030 <主机>`，本机浏览器访问 `http://127.0.0.1:3030`。
3. **对外提供，用 TLS 反代终止 TLS**：反代必须 ① 同一 origin 同时服务 SPA 静态与 `/api`、`/ws`；② 转发 WebSocket 升级（`/ws`、`/ws/host`、`/ws/remote/*`）；③ 带上 `X-Forwarded-Proto: https`（令牌 cookie 据此决定是否加 `Secure`）。Caddy 示例：

   ```
   zcode.example.com {
     reverse_proxy 127.0.0.1:3030
   }
   ```

   Caddy 会自动签发证书并转发 WebSocket 升级；nginx 需要显式写 `proxy_set_header Upgrade` / `Connection "upgrade"` 与 `proxy_set_header X-Forwarded-Proto https`。

> 本仓库自有源码里**没有 TLS 服务端**（`node:https` 只作为客户端出现在反馈上报与 CLI 网络适配器里），TLS 一律由隧道或反代提供。

### 对外必须带令牌

```bash
export ZCODE_SERVER_AUTH_TOKEN=$(openssl rand -hex 32)
HOST=0.0.0.0 PORT=3030 ZCODE_SERVER_AUTH_TOKEN=$ZCODE_SERVER_AUTH_TOKEN \
  ZCODE_WEB_STATIC_ROOT=<仓库>/packages/web/dist node packages/server/dist/entry-http.js
# 手机/另一台机器首次访问 http://<host>:3030/?token=$ZCODE_SERVER_AUTH_TOKEN
# 该次请求会种下 HttpOnly cookie（Path=/; SameSite=Lax；https 时再加 Secure），之后可只访问根路径
```

自检（把 `<HOST>` 换成对外主机名）：

```bash
curl -s -o /dev/null -w 'static %{http_code}\n'      http://<HOST>:3030/                          # 200（静态壳不鉴权）
curl -s -o /dev/null -w 'api-no-token %{http_code}\n' http://<HOST>:3030/api/server-info           # 401
curl -s -o /dev/null -w 'api-token %{http_code}\n'    "http://<HOST>:3030/api/server-info?token=$ZCODE_SERVER_AUTH_TOKEN"  # 200
```

### 分发入口（`zcode --web`）的对应关系

独立运行包里的 `zcode --web` 自己有一套更严格的默认值：`--host` 默认 `127.0.0.1`；非回环时自动生成并注入令牌（`--token` 可指定）。**`--no-token` 与 `--host` 指定非回环地址的组合**在服务端 fail-closed 之后会被拒绝启动（服务端会打印拒绝原因并退出）；需要对外时请给出 `--token`，或改为「回环 + 隧道/反代」。

### 现状边界（如实说明）

- 令牌是**静态共享密钥**：更换令牌会让所有已配对设备失效，且当前没有按设备吊销、没有配对二维码、没有会话列表。需要的场景请参考 `.reverse/40-remote-control/SECURITY-SERVER-DEFAULTS.md` 与 `REMOTE-CONTROL-REVIVAL.md` 里的分档方案。
- 静态资源不受令牌保护（浏览器要先拿到 SPA 才能进入鉴权流程）；未授权者能读到前端代码与版本信息，但读不到会话数据（会话数据全部经 `/api` 与 `/ws`）。
- 反代场景依赖 `X-Forwarded-Proto`：该头可被伪造，但伪造只会让 cookie 多一个 `Secure`（明文 http 下不会被回发），不会造成提权。

### 暴露面告警（非回环监听 / 明文 http）

服务端在两种情况下会打印**告警**（只告警，**不拒绝**请求 —— 只是为了「不许静默」）：

1. **启动期**：绑定地址不是回环（例如 `ZCODE_SERVER_HOST=0.0.0.0` 或某个私网 IP）时，启动日志会打印一段可操作的提醒：这是 agent 级服务（可执行命令、读写工作区）、**token 是唯一屏障**、明文 http 下 token cookie **不带 `Secure`**（同网段可嗅探）、建议放到 **TLS 终结的反向代理或隧道**之后并透传 `X-Forwarded-Proto: https`、能只绑私网网卡就别绑 `0.0.0.0`。
2. **运行期一次**：同一服务实例**首次**收到来自**非回环对端**且**非 TLS**（无 https、也没有 `X-Forwarded-Proto: https`）的请求时，打印同口径提醒，写明「本次会话下发的 token cookie 将不带 `Secure`」。同一实例只提示一次。

**明文 http 的合法用法限于可信局域网**：手机在自家局域网里用 `http://<私网IP>:<端口>/?token=...` 访问是本项目支持的用法，服务端不会因此拒绝请求；但不要把该端口暴露到公网 —— 需要跨网络访问时，请走 TLS 终结的反向代理或隧道（此时请求带 `X-Forwarded-Proto: https`，cookie 才会带 `Secure`，运行期告警也不再出现）。

护栏与反向验证见 `packages/server/test/httpExposureWarning.test.ts`（非回环无 token 仍拒绝启动；非回环 + token 启动且出现含关键指引的告警；回环 127.x / ::1 / [::1] / localhost / ::ffff:127.x **不得**出现告警；运行期告警只出现一次；声明 https 时不告警）。
