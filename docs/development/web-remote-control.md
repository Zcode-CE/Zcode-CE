# 网页远控（M1）：局域网/私网的手机或另一台电脑操作这台机器上的工作台

> 定位：**自托管**的网页远控 —— 用户在装有 ZCode 的机器上起一个服务，同一局域网/私网内的手机或另一台电脑用浏览器打开就能操作**这台机器上的工作台**。
> **边界（先读这条，避免按官方远控的预期使用）**：它**不是**接管桌面端 ——
> ① **不接管桌面端正在开的会话**；② 桌面端已连的**远端 SSH / Docker 目标不会共享给浏览器**
> （那是桌面端**窗口内**的连接注册表，`packages/desktop/src/host/windowRemoteConnectionRegistry.ts`，
> 与本文这条链路没有关系）。本仓库只有 `packages/web` ↔ `packages/server` 这一条自托管链路，
> 见根 `AGENTS.md` 的「上游形态提示（本仓库未实现）」。
> **不是**官方产品的「扫码 + 云 relay + 移动壳」那套：上游开源版移除的是**产品面**（云 relay 服务、
> 配对/扫码服务器、移动壳），协议与传输层接缝（`relay_owner`/`relay_bridge` 枚举、`web-remote-replayable`）
> 从开源基线起就存在 —— 准确口径见根 `AGENTS.md` 的「上游形态提示」与 [上游同步台账](upstream-sync.md) 的「已修正的既有结论」。
> 本仓库这两样都**没有引入**（全仓检索云 relay / 移动壳相关常量 0 命中）。
> 本仓库**不托管任何中继**：服务跑在你自己的机器上，网络可达性由你的局域网/私网/隧道负责。
> **本文是这条链路的权威说明**（状态所有者、四道闸的判定口径、`/bot/**` 入站面）；
> 部署与参数清单见 [无头服务器发行包](../operations/headless-server.md)，反代场景见
> [反代部署](../operations/headless-server-reverse-proxy.md) —— 三处冲突时以本文的安全口径为准。

---

## 1. 服务入口与资源分发

**入口就是分发包里那条 `zcode --web` 命令**（安装后即用，不需要 dev 工具链）：

- `scripts/zcode-distribution/runner.mjs` 解析参数（`:34-104`），启动 `<安装目录>/server/entry-http.js`，并把 `<安装目录>/web` 作为静态根传给它（`:12-14`、`:180-190`）。
- 静态资产来自一次构建的 stage：`scripts/build-zcode.mjs:158-181` 分别构建 `@zcode/server` 与 `@zcode/web`，然后把 `packages/web/dist` 复制到 `<包根>/web`、`packages/server/dist` 复制到 `<包根>/server`。**web 资产随包分发**是既有机制，不是本轮新增。
- 服务进程是 **`packages/server` 的 http 入口**（`packages/server/src/entry-http.ts` + `src/http.ts`）。**不是** `packages/zcode-server-cli`：后者是远端工作区运行时（server-core），它的源码里**没有任何静态托管能力**（`grep -rn 'staticRoot|webRoot|spaFallback' packages/zcode-server-cli/src` → 0 命中），且对非回环监听 fail-closed（`src/server-core/http.ts:136-142`）。
- **两者的安全默认值差异**：server-core 只允许回环；`packages/server` 在 3.14.3-ce.2 这轮之前是 fail-open（不设 host 绑所有网卡、无 token 全开放），现已修为**默认回环**、**非回环 + 无 token 拒绝启动**（`packages/server/src/http.ts` 的 `DEFAULT_HTTP_LISTEN_HOST`/`assertListenSecurity`；回归用例见 `packages/server/test/` 下的监听与鉴权用例）。**本能力的暴露方式必须建立在这条默认值之上，不得为了「好连」放松。**

**起服务（安装后）**：

```bash
zcode --web --host 0.0.0.0          # 监听本机所有网卡；非回环会自动生成令牌并打印 Network 地址
zcode --web --host <本机私网 IP>      # 只绑某个网卡
zcode --web                         # 只在 127.0.0.1（默认；不对外）
```

`--host` 为 `0.0.0.0`/`::` 时 runner 会逐个打印网卡可达地址，并带上令牌（`runner.mjs:213-217` 的 `networkUrls`）；`--no-token` 只允许与回环 host 组合（组合校验在 `runner.mjs` 的参数解析阶段，见 §3）。

**实测状态（本轮）**：源码态起 `packages/server/dist/entry-http.js` + `ZCODE_WEB_STATIC_ROOT=<仓库>/packages/web/dist` + 令牌，浏览器可打开并可用（§13 有命令与原始观测）；**完整安装包链路**（`scripts/build-zcode.mjs` → `zcode --web`）本轮未实跑（需要整包构建），其分解见 §9。

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

**手机与桌面同时连会发生什么 —— 未测**（本轮只验证了「两个客户端都能建立连接」，见 §13；
这一限制现在有一处**集中的、如实写明的**声明，见 **§9.4**）。能确定的是：两者各自拿到独立的连接作用域，订阅 ownership 互不共享；**业务层并发**（同一会话被两个客户端同时输入、owner/lease 如何裁决、是否出现双写）本轮**没有测**，不要在文档或产品文案里承诺行为。桌面端自己的 owner/lease 机制（`packages/desktop/src/host/...`）属于 desktop 内部拓扑，**不是**本条链路的状态所有者。

---

## 3. 配对与认证 UX

**M1 的配对 = 一条带令牌的链接**（已被实现并实测）：

1. 起服务时若非回环绑定，runner 自动生成令牌并打印链接（`runner.mjs:173-175,213-217`）；
2. 用户在手机浏览器打开 `http://<主机>:<端口>/?token=<令牌>`；
3. 服务端校验查询串里的令牌后种下 cookie：`zcode_lite_token=<令牌>; Path=/; HttpOnly; SameSite=Lax`（`packages/server/src/http.ts:222-254`），**https（含反代 `X-Forwarded-Proto: https`）时追加 `Secure`**；
4. 之后只访问根路径即可，令牌不再出现在地址栏；
5. 反代/隧道场景见 §10 与 `docs/development/local-setup.md` 的「Web 工作台的监听与对外访问」。

**要不要二维码？—— 已实现（2026-09-24 订正）。** 原表述是「M1 不做，理由是需引入新的图形依赖」，**与事实不符**：`qrcode@^1.5.4` 是**从上游开源基线 `872ad96` 继承的既有依赖**（`packages/ui/package.json:66`，与上游逐行相同），并非新依赖；且面板已实现二维码渲染（`packages/ui/src/RemoteControlPanel.tsx` 渲染 SVG，真浏览器断言含「从 SVG 相对路径还原矩阵再与 `qrcode` 编码器逐格比对链接」）。桌面端面板的「连接信息」给出地址、链接与二维码。

**授权否决/撤销**：令牌是**单个静态共享密钥**（换令牌 = 所有已连设备失效）；没有按设备凭据、没有设备列表、没有逐设备撤销。要撤销就换 `ZCODE_SERVER_AUTH_TOKEN`/重启服务并重新分发链接。

**`--no-token` 的边界**：只允许与回环 host 组合（`scripts/zcode-distribution/runner.mjs` 参数解析阶段的组合校验，与 `packages/server` 的 fail-closed 判定同一条不变式）。对外必须带令牌 —— 这不是可选项。

---

## 4. 跨站请求防护与安全响应头

> 为什么必须有这一节：这条链路暴露的是 **agent 级 RPC**，而它的凭据是 cookie（浏览器会自动附带）。
> 在**没有任何来源校验**的情况下，攻击者只需要让已授权用户打开一个恶意页面，就能：
> ① 跨站 `fetch` 拿不到数据（浏览器同源策略挡着），但 **WebSocket 握手不受同源策略约束**；
> ② 跨站表单即可 `POST /api/rpc-host-capability`，拿到 trusted-host ticket 再走 `/ws/host`，
> 而那一路拿到的是 `desktop-continuous`（trusted-host-relay）角色 —— **比普通终端客户端权限更高**。
> 结论：**不做来源校验就不能谈公网暴露**（跨站与 rebinding 两条链的防护见本页 §4–§6）。

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

# 怎样才能相信这些断言：临时做两处改动后，3 条集成用例必须变红
#   ① 删掉 app.use("*", createCrossSiteGuard(...))
#   ② 让 server.on("upgrade") 的来源 gate 直接 return
```

**实测结果**：按上述两处临时改动后，8 条里 **5 pass / 3 fail**（正是三条集成用例）；
恢复后 8/8 绿，且恢复前后 `sha256sum` 与改动前副本**逐字节一致**。

---

## 5. 鉴权失败限流、可信代理与令牌轮换

> 这一节把三条规则从代码注释搬进 spec（注释仍然保留，但规则必须以文档为准）：
> 限流阈值与封禁的作用范围、`X-Forwarded-For` 的信任口径、令牌文件的格式与热重载语义、
> 以及三个新旋钮的用途/优先级/错误行为/测试覆盖。

### 5.1 鉴权失败限流（A3）

| 项         | 值 / 语义                                                                                                                                                                   | 证据                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 计数键     | **解析后的客户端地址**（不是 XFF 原文，也不是原始 socket）                                                                                                                  | `packages/server/src/http.ts` 令牌中间件；`authThrottle.ts`  |
| 默认阈值   | **10 次失败 / 5 分钟窗口** ⇒ 封禁 **15 分钟**                                                                                                                               | `authThrottle.ts` 的 `DEFAULT_MAX_FAILURES/WINDOW_MS/BAN_MS` |
| 阈值依据   | 本服务的正确凭据是一条 192 bit 令牌或它的 cookie，**正常使用不可能连续失败 10 次**；而暴力破解在 10 次内绝无机会                                                            | —                                                            |
| 响应语义   | 封禁期内 **403**（+ 可区分原因 `Too many failed authentication attempts...`），**不是 401** —— 这是「拒绝服务、不要自动重试」的语义，也便于运维区分「凭据不对」与「被限流」 | `http.ts` 限流闸门                                           |
| 成功即清零 | 一次正确令牌会清掉该地址的计数 ⇒ 正常用户偶发输错**不会累积**到阈值                                                                                                         | `throttle.recordSuccess`                                     |
| 窗口过期   | 计数按窗口重置（不会因「很久以前失败过几次」而在某天突然被封）                                                                                                              | `authThrottle.test.ts`                                       |
| 覆盖面     | **WebSocket 升级请求同样受限**：`/ws` 是主要攻击面，只在 HTTP 上拦等于留后门                                                                                                | `authThrottleHttp.test.ts`                                   |
| 票据失败   | `/ws/host` 的 ticket 校验失败也计数（有效令牌 + 反复猜票据同样是暴力破解）；同一请求只计一次                                                                                | `http.ts` 的 `/ws/host` 中间件                               |
| 可观测     | 每次失败打一条 `warn`（含方法、路径、对端地址与累计次数）；触发封禁时另打一条                                                                                               | `http.ts`                                                    |
| 内存上界   | 同时跟踪的地址有上限（默认 4096），超出时回收过期项、必要时驱逐最早一条 ⇒ 伪造地址不能把内存撑爆                                                                            | `authThrottle.ts`                                            |

### 5.2 `X-Forwarded-For` 的信任口径（与限流**同批**）

**规则**：**默认不采信 `X-Forwarded-For`，对端地址一律取 socket 地址**；只有当 socket 对端落在
`ZCODE_SERVER_TRUSTED_PROXIES`（IP 或 CIDR 列表）内时才采信，且**从右往左取第一个不可信地址**。

- **为什么必须与限流同批**：按地址限流却仍无条件采信 XFF ⇒ 攻击者每次请求换一个假 IP，
  限流形同不存在。改动前 `resolvePeerAddress` 的注释写着「伪造只会多打一次告警」—— 那条理由
  在只有告警时成立，**引入限流后不再成立**。
- **方向性选择**：这里默认**收紧**（谁都不信），与 Open WebUI 的 `FORWARDED_ALLOW_IPS`（默认 `*`）
  相反。理由：「默认信任转发头」的失败模式（限流可绕过 + 审计日志被伪造）比「反代后限流粒度偏粗」更贵。
- **从右往左**：多跳 XFF 里左侧可被客户端自行添加，只有「第一个不可信地址」是可信客户端地址
  （与 Portainer 的 `libhttp.ClientIP(r, trustedProxies)` 同思路）。
- **畸形跳**（带端口、域名、垃圾）：**不采信，退回 socket** —— 宁可粒度粗，也不给伪造留缝。
- **反代未配 `TRUSTED_PROXIES` 时的真实后果（已实测并在日志里说明）**：所有客户端都表现为回环地址
  ⇒ 所有客户端**共用同一个计数桶**，任何一个人的连续失败会让**所有人**在封禁期内被拒绝。
  服务在「封禁回环 + 未配可信代理」时会额外告警并给出修法（登记反代地址）。
  测试专门钉住了这一后果（`authThrottleHttp.test.ts` 的「反代误伤」用例）。

### 5.3 令牌轮换与撤销（A4，最小方案）

**形态**：`ZCODE_SERVER_AUTH_TOKENS_FILE` 指向一个文本文件，每行一条令牌：

```text
# 注释与空行忽略（\r\n 也接受）
<token>                 # 只有令牌
<token> 手机              # 令牌 + 标签（标签进日志，绝不打印令牌本身）
```

| 项                      | 规则                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 优先级                  | `ZCODE_SERVER_AUTH_TOKEN`（显式单令牌）与令牌文件**并存、取并集**：显式令牌是「运维手上那把钥匙」，文件是「可批量撤销的设备钥匙」。两者都为空 ⇒ 不启用鉴权（回环下的合法形态）。                       |
| 重载                    | **SIGHUP ⇒ 重读文件并整体替换「文件那一部分」**（`kill -HUP <pid>`）。本入口此前没有 SIGHUP 处理器（那套在 `entry-stdio.ts` 的桌面 stdio 链路里，互不影响）。                                          |
| 重载后语义              | **旧令牌立即失效**（校验永远读当前集合，不缓存旧副本）；未被删掉的令牌与环境变量令牌**不受影响**。                                                                                                     |
| 重载失败                | **保持上一份可用集合**并打印告警（一次手滑清空文件不该让所有人掉线），不静默。                                                                                                                         |
| 错误行为（fail-closed） | 文件不存在 / 空文件 / 只有注释 / 行格式非法 ⇒ **拒绝启动**（非回环时给出可操作原因）。理由：一个被配成空集合的令牌源会让服务「要么完全不可用、要么看起来没启用鉴权」，两种都不能静默发生。             |
| 比较方式                | **sha256 摘要 + 常量时间比较**（消除超长令牌的字面比较时序侧信道）。                                                                                                                                   |
| 不提供                  | 设备表、逐设备「已登录」视图、OIDC —— 都属需要状态所有者设计的另一议题；本方案的目标是把「撤销一台设备」变成一次 `kill -HUP`。（注：「配对二维码」已由桌面端远程控制面板提供，见 §3；2026-09-24 订正） |
| 未做（可选增强）        | 令牌过期时间（`expires=<ISO>`）。按设备撤销这一主诉求已由文件方案覆盖。                                                                                                                                |

### 5.4 新增旋钮一览（用途 / 默认 / 配错的后果）

| 变量                            | 用途                                                                        | 默认                                     | 配错/缺失的后果                                                                |
| ------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| `ZCODE_SERVER_TRUSTED_PROXIES`  | 声明哪些地址是可信反代（IP 或 CIDR）⇒ 只有它们给的 `X-Forwarded-For` 被采信 | **空（谁都不信）**                       | 反代后所有客户端共用一个计数桶（见 §5.2），且日志/审计里的对端地址都是反代地址 |
| `ZCODE_SERVER_AUTH_TOKENS_FILE` | 多条令牌 + SIGHUP 热重载                                                    | 未设置（只用 `ZCODE_SERVER_AUTH_TOKEN`） | 文件为空/损坏 ⇒ **拒绝启动**（不静默降级）                                     |
| `ZCODE_SERVER_TRUSTED_ORIGINS`  | 跨源合法部署的**来源**白名单（见 §4.1）                                     | 空（只接受同源）                         | 反代换域名后写请求被 403（提示就该配这个）                                     |

### 5.5 封禁的作用范围：按路径，不是全站

令牌面的闸门在 `http.ts:1024-1039`，bot 面的闸门在 `botIngress.ts:283-298`。

- 令牌面的封禁不会连带封禁 bot 入站面（`/bot/**`）。被令牌面封了 15 分钟的地址，
  仍然可以继续打 `/bot/**`（受 bot 面自己的计数桶约束）。
- 同理，bot 面的限流不会封禁令牌面：猜 bot secret 失败到阈值，不会让这个地址的
  `/api/**` 或面板打不开。
- 两个桶的阈值与窗口相同（10 次 / 5 分钟 ⇒ 封 15 分钟），但各自计数、互不影响。

**不写这条会导致什么错误结论**：运维看到「某地址被 403 封禁」时的自然推断是「它全站不可用了」。
在上面这条链路的形态下，这个推断是错的 —— 事件复盘时会得出「它已经被封了，所以它不可能
再去试探 bot secret」这样的结论，而实际上它正在试探（只是换了路径）。
反过来也一样：只封了 bot 面的地址，仍然可以正常使用令牌面。

> 这条与「按路径生效」是同一件事的两面：鉴权是白名单语义（§9.3），限流闸门挂在鉴权链上，
> 因此封禁的作用域跟着路径面走，不跟着地址走。

### 5.6 验收（可执行）

```bash
cd packages/server
node --import tsx --test test/authToken.test.ts          # 令牌文件解析 / 热重载两条不变式
node --import tsx --test test/authThrottle.test.ts       # 可信代理解析 + 限流状态机
node --import tsx --test test/authThrottleHttp.test.ts   # 真实服务端：伪造 XFF 攻击 / 反代误伤 / 多令牌
```

**实测结果**：把 `resolveClientAddress` 改回「无条件取 XFF 首跳」**且**去掉限流闸门后，
16 条里 **9 pass / 7 fail**（含「对端地址默认不采信 XFF」「伪造 XFF 不能绕过」「封禁也覆盖 WS 升级」）；
恢复后 16/16 绿，且 `sha256sum` 与改动前副本逐字节一致。

**真实链路实测（独立进程 + 自建端口）**：伪造 XFF 换头攻击 `401×10 → 403×3`（额度不能靠换头重置）；
封禁期内正确令牌也 403；日志出现「鉴权失败次数达到阈值（10/10），已封禁该客户端 900 秒」；
SIGHUP 轮换后旧令牌立即 401、未撤销令牌与 env 令牌仍 200；文件写坏后重载保持上一份集合并留告警；
非回环 + 空令牌文件 ⇒ 拒绝启动。

## 6. Host 白名单——关掉 DNS rebinding 那条链

> **为什么 §4 的来源校验挡不住它**（必须先理解这一点，否则会以为"已经防住了"）：
> DNS rebinding 攻击里，攻击者页面 `http://evil.com` 解析到受害者的 LAN 地址，浏览器发出的请求
> `Origin: http://evil.com` 与 `Host: evil.com` **彼此一致** ⇒ §4.1 的同源判定**放行**，
> 而浏览器又认为这是自己的同源、**能直接读响应**。⇒ 只有 Host 白名单能关掉这条链。

### 6.1 判定口径（唯一实现：`packages/server/src/hostAllowlist.ts`）

1. **规则**：`Host`（含端口归一）必须落在白名单里，否则 **403** + 可操作原因 + 拒绝标记头
   `X-ZCode-Host-Rejected: 1`（与 §4 的语义一致），并带全部安全响应头。
2. **回环访问同样校验** —— 没有例外。默认部署就是「绑回环 + 浏览器在本机打开」，那正是这条链的目标场景。
3. **默认白名单 = 三者取并集**（**未配置域名时不得放行任意 Host**）：
   - 回环：`127.0.0.0/8` 任意形式（`127.1.2.3` 也指向本机）、`::1`、`localhost`（含大小写与尾随点）；
   - **本机各网卡地址**（`os.networkInterfaces()` 的非内部地址）⇒「绑局域网 IP 然后用该 IP 访问」照旧可用；
   - 服务**实际监听的地址**（绑哪张网卡就一定能用该地址访问，避免"加固把合法路径打死"）；
   - 运维显式登记的域名：`ZCODE_SERVER_TRUSTED_HOSTS`。
4. **端口语义**：登记项**不写端口 ⇒ 该主机任意端口都接受**；写了端口 ⇒ 必须相等。
   这条必须写清，否则"配了域名却被端口卡住"会很难排查。
5. **缺失/畸形 Host ⇒ 拒绝**（fail-closed）：HTTP/1.1 不带 `Host`（实测 Node 的 HTTP 解析器先返回
   **400 Bad Request**，我们的中间件根本不会被调用）、空值、含路径/空白/非法字符、端口非数字。
   **已知代价（有意取舍）**：用 HTTP/1.1 且不发 `Host` 的手工探针会被拒 —— 那种请求同样不带
   `Origin`，本来被当作"非浏览器客户端"放行过；如果这里也放行，rebinding 链上"浏览器不带 Host"
   这一格就永远敞着。诊断工具请带上 `Host`（curl 默认就带）。
6. **无歧义形态**：不带方括号的 IPv6 带端口（`::1:3030`）**整体是合法 IPv6 字面量**
   （RFC 7230 要求 IPv6 带端口时必须加方括号，所以这个形态只能这样解释）⇒ 当作纯 IPv6 主机名处理，
   于是它匹配不上任何白名单条目（fail-closed）。

### 6.2 与 `ZCODE_SERVER_TRUSTED_ORIGINS` 的关系（**两道不同防线，不要互相替代**）

| 防线                           | 校验对象 | 挡什么                                                                  | 机制                        |
| ------------------------------ | -------- | ----------------------------------------------------------------------- | --------------------------- |
| `ZCODE_SERVER_TRUSTED_HOSTS`   | `Host`   | **DNS rebinding**（"浏览器以为在跟 evil.com 说话，实际连的是本机服务"） | `hostAllowlist.ts`          |
| `ZCODE_SERVER_TRUSTED_ORIGINS` | `Origin` | **跨站请求**（"别的网站代浏览器发请求"）                                | `webExposureGuard.ts`（§4） |

两者都必要且都不充分：**只配 ORIGINS 挡不住 rebinding**（Origin 与 Host 自洽）；
**只配 HOSTS 挡不住跨站**（攻击者不需要伪造 Host 就能让受害者浏览器替他发请求）。
**反代换域名时通常两个都要配。**

### 6.3 升级请求同样校验

`/ws` 的升级请求**绕过 Hono 中间件链的响应通道**（`@hono/node-ws` 的适配器只取状态码，
见 §4.1 第 5 条）⇒ Host 校验与来源校验一样必须挂在 `server.on("upgrade")` 那条链上：
拒绝时直接写 socket（客户端因此能拿到原因与安全头），并复用「已拒绝就跳过」的 WeakSet 护栏。
**顺序是先 Host、后来源**：Host 是请求的基本属性，连"这是发给谁的请求"都没确认之前不该继续判定。

### 6.4 配置面

- `ZCODE_SERVER_TRUSTED_HOSTS`：逗号分隔。支持 `host` / `host:port` / `[IPv6]` / `[IPv6]:port`。
  **追加**在默认白名单之后（不替换默认值）。非法项丢弃（一个写错的域名不该让服务起不来）。
- **生效项在启动日志里逐类打印**（`trusted hosts: loopback=[...] interface=[...] configured=[...]`）——
  这是排障的关键：用户看到 403 却不知道该写哪个变量时，先看这行。

### 6.5 验收（可执行）

```bash
cd packages/server
node --import tsx --test test/hostAllowlist.test.ts   # 解析/判定矩阵 + 真实服务端（含伪 Host 与 WS 升级）
```

**实测结果**：把中间件的 Host 校验与 upgrade gate 的 Host 分支都关掉后，12 条里
**9 pass / 3 fail**（「伪 Host 必须 403」「WS 升级的 Host 也必须校验」「登记域名后必须放行」）；
恢复后 12/12 绿，且 `sha256sum` 与改动前副本逐字节一致。

**真实链路实测**：用裸 `http` 请求（fetch 不允许覆盖 `Host`）发 `Host: evil.com` ⇒ 403；
WebSocket 用真实 socket 发 `Host: evil.com` ⇒ **HTTP 403**（不是握手后再断）；
合法 `Host: 127.0.0.1:<port>` 与登记后的域名 ⇒ 照旧 200 / OPEN；
绑本机非回环网卡后用该网卡 IP 访问 ⇒ 200；真浏览器 E2E（`ZCODE_WEB_E2E_FORCE=1`）仍绿。

---

## 7. 断线恢复（本轮最高价值项）

**现状缺陷（已确认）**：

- 传输层不重连：`packages/client/src/websocket.ts:62-100` 只在连接建立前 reject、建立后触发 `onClose` 回调，没有任何重连与退避；
- Web 入口把断线回调**直接丢弃**：`packages/web/src/main.tsx` 的 `connectViaWebSocket(wsUrl, { onClose: () => {} })`；
- 结果：手机锁屏/切后台、Wi-Fi 切换、服务重启后，页面**保持看似正常但完全不动**（假死），只有手动刷新才能恢复；启动阶段的失败有错误屏（`WebBootstrapErrorScreen`），**运行期断线没有任何提示**。

**M1 目标行为**：

1. 连接断开 → 立刻显示「连接中断，正在重连」覆盖层（含第几次尝试），页面其余部分不假装可用；
2. 自动重连：指数退避 `0.5s → 1s → 2s → 4s → 8s → 上限 10s`，带抖动；
3. 重连成功 → 用新连接**重新挂载应用**（应用自身按 `web-remote-replayable` 语义重新拉快照），覆盖层消失；
4. 重试次数用尽 → 覆盖层切到「无法连接」并给**重试按钮**（用户可手动再试），不再无声等待。

**明确不承诺**：恢复到**断线前那个任务**。原因是应用的 store 由 `StoreProvider` 在每次挂载时创建（`packages/ui/src/store/StoreProvider.tsx:31-40` 用 `useRef` 持有实例、通过 Context 提供，**没有模块级单例**），重新挂载后无法从外部读回「当前任务」；实现它需要把 store 生命周期上提或把任务标识落到 URL/持久化，属后续项（§11）。M1 的恢复语义是**回到工作区（会话列表）并可继续操作**，两者差别必须在发布文案里说清。

**验收方式**（可复现）：起服务 → 浏览器打开 → 杀掉服务进程（模拟锁屏/断线）→ 页面出现重连覆盖层 → 重新起服务（同端口）→ 覆盖层消失、应用恢复可用。§13 给了命令与原始观测。

---

## 8. 版本配套（web 资产与运行时必须同版本）

- **分发是同一份构建**：`scripts/build-zcode.mjs:158-181` 在同一次 stage 里构建 `@zcode/web` 与 `@zcode/server`（以及 agent bundle），因此安装包内 web 资产与 server 天然同版本。
- **契约版本**：`/api/server-info` 返回 `protocolVersion = SERVER_REMOTE_PROTOCOL_VERSION`（`packages/shared/src/server-remote.ts:3` 当前为 `1`；`packages/server/src/http.ts:166-180`）。
- **不配套时的行为（明确、不静默降级）**：web 客户端在启动时比对「自身编译进来的契约版本」与 `/api/server-info.protocolVersion`；**不等即显示明确的错误屏**（说明资产与服务器版本不一致、请用同一版本重新部署/刷新），**不进入应用**。本轮实现这一点（§10 有断言）。
- **未测**：跨版本的 RPC/协议兼容性（例如服务端旧、web 新但契约版本恰好相同的情形）本轮**没有测**；RPC 层不做版本协商（`packages/rpc/src` 无 `protocolVersion` 校验，`grep` 0 命中），因此「同版本」是当前唯一被支持形态。

---

## 9. 审计日志与并发上限

> 批次 A 让「被拒」**看得见**（401/403 + 告警），但**没有账本**：出事后无法回答「谁在何时连过、
> 谁被拒了几次、谁被撤销、令牌什么时候重载过」，于是处置只剩「全量轮换 + 重启」这一档。
> 这一节补上账本（B1）与资源边界（B3）。

### 9.1 审计日志（B1）

**形态**：一行一条结构化 JSON，前缀沿用仓库 `formatLogPrefix`，source 为 `zcode-server:audit`，
事件名带 `audit:` 前缀（`grep 'audit:'` 即可单独取出）。等级：生命周期与重载 = `info`；
安全拒绝 = `warn`（仓库约定「不可恢复错误用 error」，审计本身不制造 error）。

| 事件                                               | 触发点                                                     | 关键字段                                                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `audit:ws-open` / `audit:ws-close`                 | WebSocket 连接建立/断开（三条 `/ws*` 路由）                | `connectionId`（把 open/close 配对）、`role`、`authenticated`、`peer`、`path`、`durationMs`（仅 close）、`tokenLabel` |
| `audit:auth-failure`                               | 令牌无效/缺失（`/api*`、`/ws*`）                           | `peer`、`method`、`path`、`reason`                                                                                    |
| `audit:auth-ban`                                   | 失败次数达到阈值触发封禁（与失败**分开记**，便于只看封禁） | `peer`、`path`、`reason`                                                                                              |
| `audit:host-rejected`                              | Host 不在白名单（中间件与 WS 升级两条路径）                | `peer`、`path`、`reason`                                                                                              |
| `audit:origin-rejected`                            | Origin 与 Host 不同源（中间件与 WS 升级两条路径）          | `peer`、`method`、`path`、`reason`                                                                                    |
| `audit:connection-limit-rejected`                  | 并发连接数达到上限                                         | `peer`、`path`、`connections`、`maxConnections`                                                                       |
| `audit:token-reload` / `audit:token-reload-failed` | SIGHUP 重载成功/失败                                       | `tokenCount`、`tokenLabels`（**只有标签**）、`reason`                                                                 |

**写入纪律（硬约束）**：**绝不写入**凭据、令牌（明文或前缀）、cookie、**完整查询串**
（`?token=...` 会进浏览器历史与代理日志，写进审计等于再多一处落盘）、请求体、工作区文件内容、
原始 `X-Forwarded-For`。只写**解析后的对端地址**（与限流同一口径，可信代理规则）与**令牌标签**。
只写 `pathname`，不写 `search`。**测试含否定式断言**：用真实令牌字符串反向搜索整份审计文本，必须搜不到。

**高频事件的代价与取舍（不静默丢弃）**：被扫描时失败事件是突发的（单个扫描器可打出每秒几十条）。
三条路里我们**不选**「不限速」（日志被打爆，真事件被淹）、**也不选**「丢重复」（静默丢事件正是审计最不该有的行为），
而是**合并 + 计数**：同键（`事件 + 对端 + 原因 + 路径 + 角色`）在窗口内写第一条、窗口末写一条**汇总**
（带 `coalesced.count / windowMs / firstAt / lastAt`）。**没有任何事件丢失**，只是从「逐条明细」降级为
「明细 + 计数」。阈值依据：窗口 60s、窗口内逐条上限 200 条 —— 稳态最多约 1 条/秒 + 1 条汇总/分钟/键，
正常使用远达不到；200 条足够保留一次真实攻击的完整明细。**不同对端不合并**（否则会掩盖"多源扫描"）。
进程收到 `SIGTERM`/`SIGINT` 时 `flush()`，避免最后 <60s 的计数随进程消失。
若审计写入本身失败：**不影响请求处理**，但会打一条 `error`（fail-loud，不 fail-silent）。

### 9.2 并发上限（B3）

| 项           | 语义                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上界         | 并发 WebSocket 连接数，默认 **32**（`DEFAULT_MAX_CONCURRENT_CONNECTIONS`，可配 `maxConcurrentConnections`）                                                |
| 与限流的区别 | **限流（§5.1）防凭据爆破**（按地址计数、时间窗封禁）；**并发上限防资源耗尽**（一次得手的凭据或本机其它进程开几千条连接把服务拖垮）。两者职责不同、互不替代 |
| 超限语义     | **拒绝新连接**：HTTP **403** + 明确原因 + `X-ZCode-Connection-Limit: 1`；**已建立的连接不受影响**；**不排队**（排队等于让攻击者用队首阻塞合法用户）        |
| 检查位置     | 在 WS 升级 gate 里，**先于来源判定**（连接洪水的第一诉求是立刻止血）                                                                                       |
| 可观测       | 拒绝写入审计；同时打一条 `warn`（只打一次，避免刷屏）                                                                                                      |
| 依据         | 单机自托管是「本人几台设备 + 几个浏览器标签」，正常远低于 32；32 足以拦住连接洪水                                                                          |

### 9.3 路由公开/受保护标注（G11）

鉴权是**白名单**语义（不在 `isTokenProtectedPath` 里的路径一律公开），因此「新增路由忘了归入
`/api` 或 `/ws` 前缀」会让鉴权**静默缺席**（而 SPA fallback 还会给该路径返回 200 的壳，看不出异常）。
对策：`http.ts` 里的 **`ROUTE_POLICY`** 表把每条已知路由的公开/受保护写成显式契约（公开路由必须写明理由），
并由 **`assertRoutePolicyEnforced()` 在启动时逐条断言**「标为受保护的路由确实被鉴权覆盖」——
不满足就**拒绝启动**（fail-closed）。测试逐条对照该表与实现，防未来漂移。

表里新增了一条公开条目 `/bot/**`（§12 的 IM 机器人入站回调），它**不授予任何访问权**：
`ROUTE_POLICY` 不驱动运行期路由（`matchesRoutePolicy` 无调用点），访问权在 `botIngress.ts`
的闸门内 —— 未启用任何渠道时这条路径与「不存在」逐字节相同（404）。

### 9.4 限制（**如实声明，不要读成"已经验证"**）

- **多客户端并发写语义未经测试**：手机上打开面板、桌面上同时操作**同一个会话**时会发生什么
  （谁赢、是否出现重复提交、owner/lease 如何裁决）**没有任何实测**。
  既有边界是：已接受的 busy/running 输入由 CLI/runtime 的 `CommandInbox` 做**串行 admission**
  （见根 `AGENTS.md`「进程、协议与远程控制」），每个 RPC attachment 各自持有独立的连接作用域与订阅 ownership
  （`packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts`）——**但这是设计约定，不是并发写的验收结论**。
  在测出来之前：**不要**把它当"两端会互相看到对方的修改"，也**不要**把 §9.2 的连接数上限读成"并发写已被保护"
  （前者限的是**连接数**，后者管的是**写入语义**，两件事）。
- 审计日志**不落盘轮转**：只走 stdout/采集器（journald 等），本服务不管轮转；需要留存请自行配置采集与轮转。

### 9.5 验收（可执行）

```bash
cd packages/server
node --import tsx --test test/auditLog.test.ts    # 结构/等级/合并计数/否定式/flush/fail-loud
node --import tsx --test test/auditHttp.test.ts   # 真实链路：连接/失败/封禁/两类拒绝/上限 + 路由标注
```

**实测结果**：去掉 `http.ts` 里任一 `audit.record` 调用 ⇒ 对应事件断言变红；
把合并策略改成"超限即丢" ⇒ 「事件计数不丢」变红；把 `ROUTE_POLICY` 的一条受保护路由改成不被
`isTokenProtectedPath` 覆盖 ⇒ `assertRoutePolicyEnforced` 抛错（该用例已单独钉住）。

---

## 10. 威胁模型与内网穿透指引

**这条链路暴露的是 agent 级 RPC** —— 拿到连接就能在该主机的工作区里执行命令、读写文件。因此：

1. **非回环必须令牌**：服务端对「非回环 + 无 token」拒绝启动（`packages/server/src/http.ts` 的 `assertListenSecurity`）；分发 runner 在参数解析阶段就拒绝该组合。**不要**用「反正内网」当理由关掉令牌。**回环也不是无条件放行** —— 配了外部访问信号（可信代理 / 登记域名）时同样要求令牌，见第 6 条的第 4.5 道闸。
2. **不要在明文 http 上跨不可信网络暴露**：令牌走查询串（会进浏览器历史）、cookie 默认没有 `Secure`（除非是 https/反代）。跨公网必须 **TLS 终结在隧道或反代**（`X-Forwarded-Proto: https` 会让 cookie 带 `Secure`）。
3. **推荐的三条路**（与 `docs/development/local-setup.md` 同口径）：① 只在本机（127.0.0.1）；② 私网/SSH 隧道（`ssh -N -L 3030:127.0.0.1:3030 <主机>`）—— 无需证书；③ TLS 反代（Caddy 两行）后仅让反代监听对外。
4. **反代部署细节**（Host 白名单现状与缺口、只支持挂在域名根、WebSocket 升级转发、`X-Forwarded-Proto`/`X-Forwarded-For` 的真实语义、Caddy/nginx 最小配置）见 [headless-server-reverse-proxy.md](../../docs/operations/headless-server-reverse-proxy.md)。
5. **本仓库不托管任何中继/云服务**：没有配对服务器、没有二维码分发服务、没有官方 relay（0 命中）。网络可达性完全由用户自己的私网/隧道/反代提供。
6. **四道闸 + 第 4.5 道，缺一不可**（公网暴露前逐条自查）：
   | 闸 | 位置 | 反代部署时要配什么 |
   | --- | --- | --- |
   | 非回环必须令牌 | `assertListenSecurity`（第 1 条） | `ZCODE_SERVER_AUTH_TOKEN` 或令牌文件 |
   | **Host 白名单**（挡 DNS rebinding） | §6 | 反代域名登记进 `ZCODE_SERVER_TRUSTED_HOSTS` |
   | **来源校验**（挡跨站） | §4 | 前端来源登记进 `ZCODE_SERVER_TRUSTED_ORIGINS` |
   | **鉴权失败限流**（挡暴力破解） | §5.1 | 反代后须配 `ZCODE_SERVER_TRUSTED_PROXIES`，否则所有客户端共用一个计数桶（§5.2） |
   | **第 4.5 道：回环 + 外部访问信号 ⇒ 也要求令牌** | `exposureGate.ts` + `assertListenSecurity` | 配了 `TRUSTED_PROXIES` 或 `TRUSTED_HOSTS`（**解析后有生效项**）就必须同时给令牌，否则**拒绝启动** |

   **第 4.5 道不改前四道的语义**，只补上"回环"这一格：前三道闸都建立在「回环 = 只有本机能到」这个前提上，
   而把回环端口放到同机代理/隧道后面时该前提**不成立**（对端地址就是回环 ⇒ 令牌那道闸整条不生效）。
   判据只读**运维显式给出的信号**，不猜拓扑；`TRUSTED_ORIGINS` 一档**有意只告警不拒绝**（避免打死既有合法部署）。
   仍有一个**有意保留的残余缺口**：三类信号全无 + 代理把 `Host` 改写成上游地址时，回环无令牌仍可被完全控制。
   完整口径与实测见 [反代部署 §3.4](../../docs/operations/headless-server-reverse-proxy.md)。

7. **公网暴露风险自担**：令牌默认是静态共享密钥；要按设备撤销请用令牌文件 + SIGHUP（§5.3）。
   限流已落地（§5.1），但**限流是按地址计数的粗粒度防线**，不替代令牌强度。

---

## 11. 明确不提供什么（不要按官方远控预期使用）

| 不提供                                         | 说明                                                                                                                                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 移动壳（原生 App / 抽屉式窄屏外壳 / 主屏安装） | 本仓库 `drawer` 0 命中、无 PWA manifest；手机用的是同一套响应式网页                                                                                                                                                                |
| 推送通知                                       | 无                                                                                                                                                                                                                                 |
| 云 relay / 扫码配对服务器                      | 无（官方那套依赖 relay 与官方托管的手机页面，本仓库 0 命中且不可复制）                                                                                                                                                             |
| **接管桌面端**（其已开会话、其已连的远端目标） | 无。这是**两条不同的链路**：浏览器连的是 `packages/server` 这个自托管服务；桌面端的远程连接注册表是**窗口内**的（`windowRemoteConnectionRegistry.ts`）。浏览器**看不到、也接管不了**桌面端正在开的会话与它已连的 SSH / Docker 目标 |
| 多客户端并发保证                               | **未测**（§2）：可以两个客户端都连上，但同一会话的并发输入行为没有验证                                                                                                                                                             |
| 回到断线前的同一任务                           | M1 恢复语义是回到工作区（§7）                                                                                                                                                                                                      |
| 设备管理 UI / 会话列表审计                     | 无 UI；**逐设备撤销**可用令牌文件 + SIGHUP 做到（§5.3），但没有界面与管理列表                                                                                                                                                      |

---

## 12. IM 机器人入站回调（`/bot/**`）

> 这是与「Web 控制」并列的另一条入站路径，但它不是浏览器链路：**第三方 IM 平台**按你登记的
> 回调 URL 把消息 POST 进来。它与前面几节共用同一台服务、同一份配置，但不共用令牌面。

**为什么另开一个前缀，而不是挂在 `/api` 下**：给 `/api` 开一条豁免（让不带令牌的回调通过）
等于在令牌面上打洞 —— 那是本页投入防护最多的一层，任何豁免都要重新论证其余各闸是否仍然闭合。
改成平行前缀 `/bot/**` 之后，`isTokenProtectedPath` 对它恒为 `false`
（`http.ts:598-605` 只认 `/api` 与 `/ws` 两个前缀），既有令牌中间件一行未改，
隔离是结构性的而不是靠一条判断。

### 12.1 形状与默认状态

| 项                   | 值 / 语义                                                                                                                         | 证据                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 路径                 | `POST /bot/:provider/:botId`（推荐）；`POST /bot/:provider` 也注册，但无 `botId` 时**显式 400**（不做「用配置里唯一的 bot」兜底） | `botIngress.ts:223-236`        |
| 凭据                 | 请求头 `x-zcode-bot-secret`，逐 bot 存储；头名固定不可配                                                                          | `botIngress.ts:67`、`:302-310` |
| 默认状态             | 未启用任何 webhook 渠道时该路径不存在：闸门在第一个判断就返回 404，不读配置、不读凭据、不读请求体                                 | `botIngress.ts:190-194`        |
| 未配 / 读不到 secret | **一律 401**（fail-closed，没有「跳过校验」这条路径）                                                                             | `botIngress.ts:303-311`        |
| 请求体上限           | 32 MiB，流式计数、不依赖 `Content-Length`（chunked 同样受限），超限 413                                                           | `botIngress.ts:61`、`:91-126`  |
| 封禁响应             | **403**（与令牌面同一状态码与响应体，不引入 429、不加 `Retry-After`）                                                             | `botIngress.ts:283-298`        |

### 12.2 状态码

| 场景                              | 状态码                                |
| --------------------------------- | ------------------------------------- |
| provider 不受支持 / 非 webhook    | 400                                   |
| 缺 `botId`（裸形状）              | 400                                   |
| secret 缺失、错误、未配置或读不到 | 401                                   |
| 渠道未启用 / bot 不存在           | 404（与「路由未注册」逐字节相同）     |
| 同一地址连续失败达到阈值          | 403                                   |
| 请求体超过上限                    | 413                                   |
| 业务处理失败                      | 503（透传，让平台稍后重试，不是 200） |
| 成功                              | 200                                   |

### 12.3 限流

阈值与窗口复用令牌面的默认值（10 次失败 / 5 分钟 ⇒ 封 15 分钟），计数键也是解析后的
客户端地址（同一套可信代理口径），但用的是独立的计数桶（`http.ts:876-880` 的
`botIngressThrottle`）。为什么必须独立：共享会让「有人暴力猜 bot secret」连带把该地址的
`/api/**` 与面板一起封掉，反过来「别人扫我」也会让我的机器人掉线 15 分钟。

**封禁是按路径生效的，不是全站封禁**：令牌面的封禁不会连带封禁 bot 入站面，bot 面的限流
也不会封禁令牌面（完整口径与「不写会导致什么错误结论」见 §5.5）。

### 12.4 配置改完要重启才生效（新增方向）

入站路由只在服务启动时挂载（`entry-http.ts:25-41` 的启动期快照），运行期不增删路由；
而每个请求都会重新读一次配置（`botIngress.ts:252-276`）。因此：

- 新增或启用一个渠道后，要重启服务才会开始接收回调；
- 删除或停用一个渠道立即生效（下一次回调就是 404）。

这个不对称是有意的：删除方向立即收紧（fail-closed），新增方向要一个显式动作才放大面
（fail-safe）。代价是「配了却不生效」会被误判成 bug，因此桌面端远程控制面板的「IM 机器人」
标签页把这句话常显在提醒块里（`packages/ui/src/RemoteControlImBotTab.tsx`）。

### 12.5 与其它几道闸的关系

| 闸                     | 对 `/bot/**` 是否生效 | 说明                                                                                                      |
| ---------------------- | --------------------- | --------------------------------------------------------------------------------------------------------- |
| Host 白名单（§6）      | 生效                  | 公网回调域名**必须**登记进 `ZCODE_SERVER_TRUSTED_HOSTS`，否则 IM 平台的请求会被 403                       |
| 来源校验（§4）         | 生效                  | IM 平台不是浏览器、不发 `Origin` ⇒ 放行（`webExposureGuard.ts` 的有意取舍）；浏览器发的跨站 POST 仍被 403 |
| 令牌（§3）             | **不经过**            | `/bot/**` 不在 `isTokenProtectedPath` 内                                                                  |
| 限流（§5.1）           | 生效，但独立桶        | 见 §12.3                                                                                                  |
| 安全响应头、暴露面告警 | 生效                  | 都挂在 `app.use("*")` 上，对 `/bot/**` 同样下发                                                           |

**`/bot/**`不构成令牌面的豁免路径，它反而要求令牌开着**：要让 IM 平台从公网打到本机，
就必须把回调域名登记进`ZCODE_SERVER_TRUSTED_HOSTS`（否则 Host 白名单会 403）；
而「登记域名」正是 §10 第 6 条里第 4.5 道闸的外部访问信号 —— **登记域名 + 无可用令牌 ⇒ 服务拒绝启动**
（`exposureGate.ts`，实测见 `packages/server/test/exposureGateHttp.test.ts:59-89`）。
这是既有的 fail-closed 被触发，不是 bot 功能引入的新约束。

---

## 13. 验收（可执行命令与期望）

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

**原始观测（本轮实跑）**：断线重连前后的页面状态、重连次数与时间戳记录在本页 §8 的验收证据里；自动化覆盖见 `packages/web/test/` 与 `packages/ui/test/` 的重连用例。

**bot 入站面（§12）的验收**（与上面这条链路同一台服务）：

```bash
cd packages/server
node --import tsx --test test/botIngress.test.ts        # 22 条：默认 404 / fail-closed / 独立限流桶 / bodyLimit / 审计否定式
node --import tsx --test test/exposureGateHttp.test.ts  # 登记域名 + 无令牌 ⇒ 拒绝启动（§12.5 的因果链）
```

桌面端远程控制面板的「IM 机器人」标签页里那句话（§12.4），真浏览器断言见
`.reverse/93-bot-ingress/harness/probe-im-bot.mjs`：它渲染产品组件本身并读 `innerText`，
判据是「这句话在屏幕上且落在常显的提醒块内」。把渲染点摘掉后探针必须变红（已验证）。

---

## 14. 未定 / 后续

1. **完整安装包链路的端到端验证**（`scripts/build-zcode.mjs` → `zcode --web` → 手机）：本轮只验证了「源码构建的 web 资产 + packages/server 入口 + 令牌 + 局域网可达」这一条；整包构建（含运行时 node_modules 复制与 TUI 运行时 stage）未实跑，需要单独一轮。
2. **二维码 / 一键分享**：**已完成**（桌面端面板的连接信息含二维码与复制链接，复用既有 `qrcode` 依赖；见 §3 订正）。剩余的是 Web 客户端侧是否也给出口 —— 按产品决定，Web 端**不需要**面板（用户已明确），故暂不做。
3. **回到断线前的同一任务**：需要把 store 生命周期上提或把任务标识落到 URL/持久化（§7）。
4. **多客户端并发**：需要一次带真实会话的并发验证（读/写/lease）（§2）。
5. **PR #1 的三项触屏 UI 修复**（消息操作栏常显、web 侧栏切换、非安全上下文剪贴板回退）是本能力的 UI 前置，将作为本线的一部分收编（由 Lead 在 pr-triage 复审结论出来后安排）。
