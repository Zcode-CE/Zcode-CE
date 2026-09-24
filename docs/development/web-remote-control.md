# 网页远控（M1）：局域网/私网的手机或另一台电脑操作同一个工作台

> 定位：**自托管**的网页远控 —— 用户在装有 ZCode 的机器上起一个服务，同一局域网/私网内的手机或另一台电脑用浏览器打开就能操作这个工作台。
> **不是**官方产品的「扫码 + 云 relay + 移动壳」那套（官方那套在开源前已被整块移除：本仓库 0 命中，云 relay 与官方托管的手机页面均不可复制，见 [.reverse/40-remote-control/REMOTE-CONTROL-REVIVAL.md](../../.reverse/40-remote-control/REMOTE-CONTROL-REVIVAL.md)）。
> 本仓库**不托管任何中继**：服务跑在你自己的机器上，网络可达性由你的局域网/私网/隧道负责。

---

## 1. 服务入口与资源分发

**入口就是分发包里那条 `zcode --web` 命令**（安装后即用，不需要 dev 工具链）：

- `scripts/zcode-distribution/runner.mjs` 解析参数（`:34-104`），启动 `<安装目录>/server/entry-http.js`，并把 `<安装目录>/web` 作为静态根传给它（`:12-14`、`:180-190`）。
- 静态资产来自一次构建的 stage：`scripts/build-zcode.mjs:158-181` 分别构建 `@zcode/server` 与 `@zcode/web`，然后把 `packages/web/dist` 复制到 `<包根>/web`、`packages/server/dist` 复制到 `<包根>/server`。**web 资产随包分发**是既有机制，不是本轮新增。
- 服务进程是 **`packages/server` 的 http 入口**（`packages/server/src/entry-http.ts` + `src/http.ts`）。**不是** `packages/zcode-server-cli`：后者是远端工作区运行时（server-core），它的源码里**没有任何静态托管能力**（`grep -rn 'staticRoot|webRoot|spaFallback' packages/zcode-server-cli/src` → 0 命中），且对非回环监听 fail-closed（`src/server-core/http.ts:136-142`）。
- **两者的安全默认值差异**：server-core 只允许回环；`packages/server` 在 3.14.3-ce.2 这轮之前是 fail-open（不设 host 绑所有网卡、无 token 全开放），现已修为**默认回环**、**非回环 + 无 token 拒绝启动**（`packages/server/src/http.ts` 的 `DEFAULT_HTTP_LISTEN_HOST`/`assertListenSecurity`；前后对照见 [SECURITY-SERVER-DEFAULTS.md](../../.reverse/40-remote-control/SECURITY-SERVER-DEFAULTS.md)）。**本能力的暴露方式必须建立在这条默认值之上，不得为了「好连」放松。**

**起服务（安装后）**：

```bash
zcode --web --host 0.0.0.0          # 监听本机所有网卡；非回环会自动生成令牌并打印 Network 地址
zcode --web --host <本机私网 IP>      # 只绑某个网卡
zcode --web                         # 只在 127.0.0.1（默认；不对外）
```

`--host` 为 `0.0.0.0`/`::` 时 runner 会逐个打印网卡可达地址，并带上令牌（`runner.mjs:213-217` 的 `networkUrls`）；`--no-token` 只允许与回环 host 组合（组合校验在 `runner.mjs` 的参数解析阶段，见 §3）。

**实测状态（本轮）**：源码态起 `packages/server/dist/entry-http.js` + `ZCODE_WEB_STATIC_ROOT=<仓库>/packages/web/dist` + 令牌，浏览器可打开并可用（§8 有命令与原始观测）；**完整安装包链路**（`scripts/build-zcode.mjs` → `zcode --web`）本轮未实跑（需要整包构建），其分解见 §9。

---

## 2. 状态所有者与事件顺序

**谁持有状态**：服务进程（`packages/server`）持有 workspace/session 事实；RPC 层**每个连接一份 attachment**，不复制业务状态：

```
浏览器 A（手机）  ──WS──┐
                        ├─► packages/server/http.ts  ──►  createZCodeAgentConnectionScope(agentService, {connectionId, clientMode, role})
浏览器 B（电脑）  ──WS──┘        （每个连接：独立连接作用域）           │
                                                                       └─►  同一个 agentService / 同一份 workspace 事实
                                                                              输入串行 admission 由 runtime 的 CommandInbox 负责
```

- 连接作用域：`packages/server/src/http.ts:91-101`（`connectionId: server-ws-<uuid>`、`clientMode`、`role`；web/浏览器一律 `web-remote-replayable` + `terminal-client`，只有 `desktop-continuous` 才是 `trusted-host-relay`）。
- 语义边界：`packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts:1-31`（每个 RPC attachment 独立持有订阅 ownership；base service 只转发 CLI 事实，不在 host/main/relay 复制业务状态）。
- 输入串行：已接受的 busy/running 输入由 CLI/runtime 的 `CommandInbox` 做串行 admission（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts`；约定见根 `AGENTS.md` 的「进程、协议与远程控制」）。
- 恢复语义：`web-remote-replayable` 走**可重放快照**（`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:3420` 的投递形态映射、`:2223-2290` 的 replayable 分支；客户端侧 `packages/ui/src/hooks/useZCodeTaskService.ts:238-260` 用 `getTaskSnapshotWithEtag` 做快照 + etag 恢复）。

**手机与桌面同时连会发生什么 —— 未测**（本轮只验证了「两个客户端都能建立连接」，见 §8）。能确定的是：两者各自拿到独立的连接作用域，订阅 ownership 互不共享；**业务层并发**（同一会话被两个客户端同时输入、owner/lease 如何裁决、是否出现双写）本轮**没有测**，不要在文档或产品文案里承诺行为。桌面端自己的 owner/lease 机制（`packages/desktop/src/host/...`）属于 desktop 内部拓扑，**不是**本条链路的状态所有者。

---

## 3. 配对与认证 UX

**M1 的配对 = 一条带令牌的链接**（已被实现并实测）：

1. 起服务时若非回环绑定，runner 自动生成令牌并打印链接（`runner.mjs:173-175,213-217`）；
2. 用户在手机浏览器打开 `http://<主机>:<端口>/?token=<令牌>`；
3. 服务端校验查询串里的令牌后种下 cookie：`zcode_lite_token=<令牌>; Path=/; HttpOnly; SameSite=Lax`（`packages/server/src/http.ts:222-254`），**https（含反代 `X-Forwarded-Proto: https`）时追加 `Secure`**；
4. 之后只访问根路径即可，令牌不再出现在地址栏；
5. 反代/隧道场景见 §7 与 `docs/development/local-setup.md` 的「Web 工作台的监听与对外访问」。

**要不要二维码？M1 不做。** 理由：当前可用形态是「一条链接」，二维码只是把这条链接换个载体；而产品内生成二维码需要引入新的图形依赖，涉及新依赖取舍（按根 `AGENTS.md` 的判据属「非核心便利件」，应单独决策）。用户可用任意二维码工具把打印出来的链接转成码。

**授权否决/撤销**：令牌是**单个静态共享密钥**（换令牌 = 所有已连设备失效）；没有按设备凭据、没有设备列表、没有逐设备撤销。要撤销就换 `ZCODE_SERVER_AUTH_TOKEN`/重启服务并重新分发链接。

**`--no-token` 的边界**：只允许与回环 host 组合（`scripts/zcode-distribution/runner.mjs` 参数解析阶段的组合校验，与 `packages/server` 的 fail-closed 判定同一条不变式）。对外必须带令牌 —— 这不是可选项。

---

## 4. 跨站请求防护与安全响应头（task-34）

> 为什么必须有这一节：这条链路暴露的是 **agent 级 RPC**，而它的凭据是 cookie（浏览器会自动附带）。
> 在**没有任何来源校验**的情况下，攻击者只需要让已授权用户打开一个恶意页面，就能：
> ① 跨站 `fetch` 拿不到数据（浏览器同源策略挡着），但 **WebSocket 握手不受同源策略约束**；
> ② 跨站表单即可 `POST /api/rpc-host-capability`，拿到 trusted-host ticket 再走 `/ws/host`，
> 而那一路拿到的是 `desktop-continuous`（trusted-host-relay）角色 —— **比普通终端客户端权限更高**。
> 结论：**不做来源校验就不能谈公网暴露**（对照调研见 [.reverse/43-web-security/SURVEY.md](../../.reverse/43-web-security/SURVEY.md) 的 G1/G2/G5）。

### 4.1 同源判定口径（唯一实现：`packages/server/src/webExposureGuard.ts`）

1. **保护面**（`shouldGuardRequest`）：
   - `/ws`、`/ws/**` —— **恒在保护面内**（WebSocket 升级）；
   - 其余路径 —— 只在**写方法**（`POST`/`PUT`/`PATCH`/`DELETE`）时保护；
   - 读方法 `GET/HEAD`、静态资产与 SPA 壳**不在**保护面内：跨站读受浏览器同源策略约束，且本服务**不发 CORS 头**，没有可被跨站利用的读面。
2. **同源定义**：`Origin` 与请求的 `Host` 在**协议 + 主机 + 端口**三元组上一致（主机大小写不敏感）。
   - 默认端口等价：`https://a` ≡ `https://a:443`、`http://a` ≡ `http://a:80`（登记白名单时两种写法都能命中）。
   - **不把 IP 与主机名视为同一来源**：`http://localhost:3030` 与 `http://127.0.0.1:3030` 是**不同**来源。
     这是标准口径；代价是「用 localhost 打开页面、却连 127.0.0.1」这类混用会被拒 ——
     取舍是宁可让这种混用显式登记，也不放宽判定（放宽等于给 DNS rebinding 留门）。
   - **畸形 `Origin`（含路径、非 http(s) 协议、不可解析）一律拒绝**；字面量 `null`
     （sandbox iframe、`data:`、部分重定向）**一律拒绝**，它不是任何合法来源。
3. **缺 `Origin` 时放行 —— 这是有意的取舍，不是遗漏**：
   - 依据：RFC 6455 §4.1 指出 `Origin` 由**浏览器**发送、「非浏览器客户端可能不发」；§10.2 进一步说明
     专用客户端可以给出任意 origin 字符串，所以 origin 模型对它们**本就没有意义**（它们也可以随意伪造）。
   - 后果（写清）：放行意味着「一个不发 `Origin` 的非浏览器恶意客户端」不受本层约束 ——
     但它本来就不受浏览器规则约束，真正拦住它的是**令牌那一层**（它必须持有令牌）。
     而**浏览器**对任何跨站请求都会带 `Origin`，所以这条放行**不放宽**浏览器侧的跨站面。
   - 还有一条现实理由：既有的非浏览器链路（CLI、桌面、`ws` 库、鉴权覆盖测试）都不发该头，
     「缺 Origin 即拒绝」会直接打断它们 —— 那是**误伤**，不是加固。
4. **跨源合法部署**（反代把前端放在另一个域名/端口）：用**新增**的环境变量显式放行，不引入第二个机制：
   - `ZCODE_SERVER_TRUSTED_ORIGINS` —— 逗号分隔的来源列表（如 `https://panel.example,http://gw.internal:8443`）。
   - 解析口径：按 `new URL()` 解析、默认端口归一化、**空项与不可解析项被丢弃**（一个写错的域名
     不应该让服务起不来）；启动日志会打印 `cross-site allowlist: ...` 便于核对。
   - 优先级：**同源判定恒先于白名单**（同源永远放行；白名单只用于额外的跨源来源）。
5. **拒绝语义**：
   - HTTP 写方法：`403` + `{"error":"<可操作原因>"}`（含「请把前端来源登记进 `ZCODE_SERVER_TRUSTED_ORIGINS`」的指引），
     并带 `X-ZCode-Cross-Site-Rejected: 1`；每个「路径 + 方法」只告警一次（可观测但不被探测打爆日志）。
   - **WebSocket 升级：必须在 HTTP 层拒绝**（`packages/server/src/http.ts` 的 `server.on("upgrade")` gate）。
     原因（**实测，非推测**）：`@hono/node-ws` 的升级适配器只取响应状态码，自己拼一条
     `Connection: close` / `Content-Length: 0` 的响应 —— 在 Hono 中间件里返回的 403 会把
     **响应体与安全响应头一起丢掉**。被拒时本 gate 直接写 socket，客户端因此能拿到原因与安全头；
     放行时**不处理**（不消费 socket），交给随后注册的 node-ws 监听器正常升级。
6. **顺序**：安全响应头中间件在最外层 → 来源校验中间件 → 令牌中间件。
   因此「未授权 + 跨站」的请求得到 **403（跨站）** 而不是 401 —— 这两件事必须能区分：
   401 = 没带凭据；403 = 带了凭据但被跨站利用。

### 4.2 安全响应头

| 头                                    | 值                                         | 理由                                                                                                                  |
| ------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `X-Content-Type-Options`              | `nosniff`                                  | 同源内容嗅探会让工作区产出的文件有机会被当作脚本执行，而同源脚本能直接发起带 cookie 的请求（HttpOnly 拦不住同源脚本） |
| `X-Frame-Options`                     | `DENY`                                     | 面板能执行命令，**不能被任意站点 iframe 嵌入**做点击劫持                                                              |
| `Content-Security-Policy-Report-Only` | `frame-ancestors 'none'`                   | 现代浏览器的同一条约束；**默认只 report-only**，因为我们尚未盘点构建产物里的内联脚本                                  |
| `Referrer-Policy`                     | `no-referrer`                              | 首次落地页 URL 可能带 `?token=`，不应经 Referer 泄给第三方                                                            |
| `Permissions-Policy`                  | `camera=(), microphone=(), geolocation=()` | 面板不需要这些能力                                                                                                    |
| `Strict-Transport-Security`           | `max-age=31536000; includeSubDomains`      | **只在 https 请求且显式开启时下发**（`ZCODE_SERVER_HSTS=1`）；默认关，因为 HSTS 一旦下发就无法回退                    |

- `ZCODE_SERVER_CSP`：`report-only`（默认）/ `enforce` / `off`。**未知值不静默升级**为 enforce：
  记一条启动告警后回落到默认的 report-only。**`off` 只关 CSP**；点击劫持防护由
  `X-Frame-Options: DENY` 继续承担（无条件下发，与 CSP 模式无关）。

### 4.3 验收（可执行）

```bash
# 五档 × 逐端点矩阵 + 真实服务端集成（含「HTTP 层 WS 拒绝」的响应体与响应头断言）
cd packages/server && node --import tsx --test test/webOriginGuard.test.ts

# 反向验证（证明测试有牙齿）：临时做两处改动后，3 条集成用例必须变红
#   ① 删掉 app.use("*", createCrossSiteGuard(...))
#   ② 让 server.on("upgrade") 的来源 gate 直接 return
```

**反向验证实测（本轮）**：按上述两处临时改动后，8 条里 **5 pass / 3 fail**（正是三条集成用例）；
恢复后 8/8 绿，且恢复前后 `sha256sum` 与改动前副本**逐字节一致**。

---

## 5. 断线恢复（本轮最高价值项）

**现状缺陷（已确认）**：

- 传输层不重连：`packages/client/src/websocket.ts:62-100` 只在连接建立前 reject、建立后触发 `onClose` 回调，没有任何重连与退避；
- Web 入口把断线回调**直接丢弃**：`packages/web/src/main.tsx` 的 `connectViaWebSocket(wsUrl, { onClose: () => {} })`；
- 结果：手机锁屏/切后台、Wi-Fi 切换、服务重启后，页面**保持看似正常但完全不动**（假死），只有手动刷新才能恢复；启动阶段的失败有错误屏（`WebBootstrapErrorScreen`），**运行期断线没有任何提示**。

**M1 目标行为**：

1. 连接断开 → 立刻显示「连接中断，正在重连」覆盖层（含第几次尝试），页面其余部分不假装可用；
2. 自动重连：指数退避 `0.5s → 1s → 2s → 4s → 8s → 上限 10s`，带抖动；
3. 重连成功 → 用新连接**重新挂载应用**（应用自身按 `web-remote-replayable` 语义重新拉快照），覆盖层消失；
4. 重试次数用尽 → 覆盖层切到「无法连接」并给**重试按钮**（用户可手动再试），不再无声等待。

**明确不承诺**：恢复到**断线前那个任务**。原因是应用的 store 由 `StoreProvider` 在每次挂载时创建（`packages/ui/src/store/StoreProvider.tsx:31-40` 用 `useRef` 持有实例、通过 Context 提供，**没有模块级单例**），重新挂载后无法从外部读回「当前任务」；实现它需要把 store 生命周期上提或把任务标识落到 URL/持久化，属后续项（§10）。M1 的恢复语义是**回到工作区（会话列表）并可继续操作**，两者差别必须在发布文案里说清。

**验收方式**（可复现）：起服务 → 浏览器打开 → 杀掉服务进程（模拟锁屏/断线）→ 页面出现重连覆盖层 → 重新起服务（同端口）→ 覆盖层消失、应用恢复可用。§9 给了命令与原始观测。

---

## 6. 版本配套（web 资产与运行时必须同版本）

- **分发是同一份构建**：`scripts/build-zcode.mjs:158-181` 在同一次 stage 里构建 `@zcode/web` 与 `@zcode/server`（以及 agent bundle），因此安装包内 web 资产与 server 天然同版本。
- **契约版本**：`/api/server-info` 返回 `protocolVersion = SERVER_REMOTE_PROTOCOL_VERSION`（`packages/shared/src/server-remote.ts:3` 当前为 `1`；`packages/server/src/http.ts:166-180`）。
- **不配套时的行为（明确、不静默降级）**：web 客户端在启动时比对「自身编译进来的契约版本」与 `/api/server-info.protocolVersion`；**不等即显示明确的错误屏**（说明资产与服务器版本不一致、请用同一版本重新部署/刷新），**不进入应用**。本轮实现这一点（§9 有断言）。
- **未测**：跨版本的 RPC/协议兼容性（例如服务端旧、web 新但契约版本恰好相同的情形）本轮**没有测**；RPC 层不做版本协商（`packages/rpc/src` 无 `protocolVersion` 校验，`grep` 0 命中），因此「同版本」是当前唯一被支持形态。

---

## 7. 威胁模型与内网穿透指引

**这条链路暴露的是 agent 级 RPC** —— 拿到连接就能在该主机的工作区里执行命令、读写文件。因此：

1. **非回环必须令牌**：服务端对「非回环 + 无 token」拒绝启动（`packages/server/src/http.ts` 的 `assertListenSecurity`）；分发 runner 在参数解析阶段就拒绝该组合。**不要**用「反正内网」当理由关掉令牌。
2. **不要在明文 http 上跨不可信网络暴露**：令牌走查询串（会进浏览器历史）、cookie 默认没有 `Secure`（除非是 https/反代）。跨公网必须 **TLS 终结在隧道或反代**（`X-Forwarded-Proto: https` 会让 cookie 带 `Secure`）。
3. **推荐的三条路**（与 `docs/development/local-setup.md` 同口径）：① 只在本机（127.0.0.1）；② 私网/SSH 隧道（`ssh -N -L 3030:127.0.0.1:3030 <主机>`）—— 无需证书；③ TLS 反代（Caddy 两行）后仅让反代监听对外。
4. **反代部署细节**（Host 白名单现状与缺口、只支持挂在域名根、WebSocket 升级转发、`X-Forwarded-Proto`/`X-Forwarded-For` 的真实语义、Caddy/nginx 最小配置）见 [headless-server-reverse-proxy.md](../../docs/operations/headless-server-reverse-proxy.md)。
5. **本仓库不托管任何中继/云服务**：没有配对服务器、没有二维码分发服务、没有官方 relay（0 命中）。网络可达性完全由用户自己的私网/隧道/反代提供。
6. **跨站面已加固**：来源校验与安全响应头见 §4 —— 它不是可选项。公网暴露时**必须**同时满足
   「非回环 + 令牌」（第 1 条）与「来源校验未被绕过」（§4；反代放在另一个域名时用
   `ZCODE_SERVER_TRUSTED_ORIGINS` 显式登记），两者是并列的两道闸。
7. **公网暴露风险自担**：令牌截至目前仍是静态共享密钥、无设备级吊销、**无速率限制**
   （限流与令牌轮换是下一批 A-2 的任务，尚未落地）；暴露到公网等于把「执行命令的能力」挂在一个单密钥上。

---

## 8. 明确不提供什么（不要按官方远控预期使用）

| 不提供                                         | 说明                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| 移动壳（原生 App / 抽屉式窄屏外壳 / 主屏安装） | 本仓库 `drawer` 0 命中、无 PWA manifest；手机用的是同一套响应式网页    |
| 推送通知                                       | 无                                                                     |
| 云 relay / 扫码配对服务器                      | 无（官方那套依赖 relay 与官方托管的手机页面，本仓库 0 命中且不可复制） |
| 多客户端并发保证                               | **未测**（§2）：可以两个客户端都连上，但同一会话的并发输入行为没有验证 |
| 回到断线前的同一任务                           | M1 恢复语义是回到工作区（§5）                                          |
| 设备管理 / 逐设备撤销 / 会话列表审计           | 无；令牌是单一静态密钥                                                 |

---

## 9. 验收（可执行命令与期望）

```bash
# 1) 构建 web 资产（开发/源码态）
pnpm --filter @zcode/web build

# 2) 起服务：只绑回环 + 令牌 + 静态根（对局域网暴露时把 HOST 换成 0.0.0.0 或本机私网 IP）
HOST=127.0.0.1 PORT=3030 ZCODE_SERVER_AUTH_TOKEN=<令牌> ZCODE_WEB_STATIC_ROOT=<仓库>/packages/web/dist \
  node packages/server/dist/entry-http.js

# 3) 未授权必须 401、带令牌必须 200（手机首次打开用带令牌的链接）
curl -s -o /dev/null -w 'no-token %{http_code}\n'   http://<主机>:3030/api/server-info
curl -s -o /dev/null -w 'with-token %{http_code}\n' "http://<主机>:3030/api/server-info?token=<令牌>"

# 4) 打开 http://<主机>:3030/?token=<令牌> —— 应看到工作区与会话列表
# 5) 断线恢复：杀掉进程后页面应出现「连接中断/正在重连」，重启同端口服务后覆盖层消失、应用恢复可用
```

**原始观测（本轮实跑）**：见 [.reverse/40-remote-control/WEB-REMOTE-CONTROL-M1.md](../../.reverse/40-remote-control/WEB-REMOTE-CONTROL-M1.md)（含断线前后页面状态、重连次数与时间戳）。

---

## 10. 未定 / 后续

1. **完整安装包链路的端到端验证**（`scripts/build-zcode.mjs` → `zcode --web` → 手机）：本轮只验证了「源码构建的 web 资产 + packages/server 入口 + 令牌 + 局域网可达」这一条；整包构建（含运行时 node_modules 复制与 TUI 运行时 stage）未实跑，需要单独一轮。
2. **二维码 / 一键分享**：需评估新依赖（§3）。
3. **回到断线前的同一任务**：需要把 store 生命周期上提或把任务标识落到 URL/持久化（§5）。
4. **多客户端并发**：需要一次带真实会话的并发验证（读/写/lease）（§2）。
5. **PR #1 的三项触屏 UI 修复**（消息操作栏常显、web 侧栏切换、非安全上下文剪贴板回退）是本能力的 UI 前置，将作为本线的一部分收编（由 Lead 在 pr-triage 复审结论出来后安排）。
