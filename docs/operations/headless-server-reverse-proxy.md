# 反代 / TLS 之后部署无头服务器（四件事）

> 面向**部署方**：把 `zcode --web` 放到反向代理或隧道之后、给局域网外的设备使用时，必须知道的四件事 ——
> **① Host 白名单（必须登记你的域名，否则 403）**、**② 只支持挂域名根**、**③ 可信代理与 `X-Forwarded-*` 的真实语义**、
> **④ 回环端口放到反代后面会发生什么（令牌那道闸为何默认不生效，以及本版怎么拦）**。
> **如果你只想看一条**：§3.4 是本文最该读的一节 —— 它讲的是"代理把外部流量带进了一个只监听回环的服务"，
> 而这类部署的错误配置会让**一个不带 `Origin` 的客户端拿到无需令牌的完全控制权**。
> 服务本身的安全边界见 [headless-server.md](./headless-server.md) §4；链路与威胁模型见 [web-remote-control.md](../development/web-remote-control.md)；
> 三条部署路线（本机 / 私网隧道 / TLS 反代）见 [local-setup.md](../development/local-setup.md) 的「Web 工作台的监听与对外访问」。

## 0. 四条先记住的结论

1. **只支持挂在域名根（`/`）**：SPA 静态、`/api`、`/ws` 必须在**同一 origin**（见 §2）。
2. **Host 白名单已实现**：`Host` 必须落在白名单里，否则 403。
   默认白名单 = 回环各形态 + 本机网卡地址 + 实际监听地址；**反代域名必须显式登记**
   `ZCODE_SERVER_TRUSTED_HOSTS`，否则你的域名会被 403。核对方法见 §1 与 §5.1。
3. **`X-Forwarded-For` 默认不被采信**：只有在 socket 对端落在
   `ZCODE_SERVER_TRUSTED_PROXIES` 内时才采信它，且从右往左取第一个不可信地址。
   **反代部署要配这个变量** —— 否则所有客户端都表现为回环地址，鉴权失败限流会共用一个计数桶，
   一个人的连续失败会让所有人在封禁期内被拒。详见 §3.3。
4. **回环端口放到代理后面时，令牌那道闸默认是不生效的**（"回环 ⇒ 只有本机能到"这个前提在代理后面不成立）。
   本版的对策是：**一旦配置里出现"这东西会被本机之外访问"的信号（登记域名 / 声明可信代理），回环也要求令牌，
   否则拒绝启动**；只有 `TRUSTED_ORIGINS` 这一档走告警。**但存在一个有意保留的残余缺口**（代理把 `Host` 改写成
   上游地址 ⇒ 三类信号全无）。⇒ **只要回环端口对外可达，就配一个令牌**。详见 §3.4。

---

## 1. Host 白名单：为什么需要、当前到哪一步

### 1.1 为什么必须校验 Host

服务默认绑回环时，`http://127.0.0.1:3030` 常被当成"安全位置"。但攻击者页面可以：

1. 诱导用户访问 `http://attacker.example`；
2. 该域名 **DNS 重绑定**到 `127.0.0.1`；
3. 页面从**自己的 origin** 发请求到 `http://attacker.example:3030/api/...` —— 对浏览器而言这是**同源**，
   于是会带上我们种在回环上的 cookie；
4. 结果是：**同源策略与 Origin 校验同时失效**（攻击者的 `Origin` 与它自己伪造的 `Host` 一致）。

同类项目的对策就是**主机名白名单**：Grafana 的 `enforce_domain` 选项明写
"**Prevents DNS rebinding attacks**"（来源：Grafana 配置文档，属同类项目文档证据）。

### 1.2 我们今天的实现口径（**已实现**）

| 事实                                                                                                                             | 证据                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Host` **现在是被校验的**：必须落在白名单里，否则 403（+ `X-ZCode-Host-Rejected: 1` + 可操作原因）                               | `packages/server/src/hostAllowlist.ts`（`evaluateHost`）；`http.ts` 的 Host 中间件与 upgrade gate |
| 默认白名单 = 回环各形态（含 `127/8`、`::1`、`localhost`、大小写与尾随点）+ **本机网卡地址** + 实际监听地址；**不含任何外部域名** | `hostAllowlist.ts` 的 `buildTrustedHostEntries`；启动日志逐类打印生效项                           |
| 反代域名必须显式登记 `ZCODE_SERVER_TRUSTED_HOSTS`（支持 `host`/`host:port`/`[IPv6]:port`）                                       | `entry-http.ts` 读环境变量；`http.ts` 追加进白名单                                                |
| **WebSocket 升级同样校验**（`/ws` 绕过中间件链的响应通道）                                                                       | `http.ts` 的 `server.on("upgrade")` 里 Host 分支先于来源判定                                      |
| 跨源部署另有 `ZCODE_SERVER_TRUSTED_ORIGINS`（**不同防线**：Origin 挡跨站、Host 挡 rebinding）                                    | `webExposureGuard.ts`；两者分工见 `docs/development/web-remote-control.md` §6.2                   |

**结论**：§1.1 那条攻击链**已关闭** —— 攻击者的请求 `Host: evil.com` 不在白名单里 ⇒ 403，
浏览器读不到任何响应（而 `Origin` 校验单独是挡不住它的：那时 `Origin` 与 `Host` 自洽）。

**反代部署的唯一注意点**：登记你的域名，否则**你自己的域名也会 403**（这是有意行为，不是 bug）。
核对命令见 §5.1；设计与取舍（端口语义、缺失 Host 的处理、与 `TRUSTED_ORIGINS` 的分工）见
[docs/development/web-remote-control.md](../../docs/development/web-remote-control.md) §6。

---

## 2. 只支持挂在域名根（`/`）

**当前不支持子路径部署**（例如 `https://example.com/zcode/`）。原因：面板的 SPA 静态资源、`/api/*` 与 `/ws*`
必须**同一 origin**（cookie 是 `Path=/`、`SameSite=Lax`；WebSocket 与 API 都按根路径注册）；
把服务挂到子路径需要"base path 改造"（前端 router base、静态资源前缀、API/WS 前缀全部改造），**本版没有做**。

### 2.1 反代必须满足的三条

1. **同一 origin 同时服务 SPA 与 `/api`、`/ws*`**（不要在反代上把 API 拆到另一个域名/端口）。
2. **转发 WebSocket 升级**：`/ws`、`/ws/host`、`/ws/remote/*`（漏了会表现为"面板能开、一连就断"）。
3. **透传 `X-Forwarded-Proto: https`**：服务据此给令牌 cookie 追加 `Secure`
   （`packages/server/src/http.ts:297-306`；不传也不报错，只是 cookie 少了 `Secure`）。

### 2.2 Caddy（最小可用，与 [local-setup.md](../development/local-setup.md) 同口径）

```
zcode.example.com {
  reverse_proxy 127.0.0.1:3030
}
```

Caddy 自动签发证书、自动转发 WebSocket 升级、自动设置 `X-Forwarded-Proto`。

### 2.3 nginx（最小可用）

```nginx
server {
  listen 443 ssl;
  server_name zcode.example.com;

  # 证书略（certbot 等）
  location / {
    proxy_pass http://127.0.0.1:3030;
    proxy_http_version 1.1;

    # ① WebSocket 升级转发（/ws、/ws/host、/ws/remote/*）
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # ② 让服务知道对外是 https（cookie 才会带 Secure）
    proxy_set_header X-Forwarded-Proto https;

    # ③ 覆写而不是追加 XFF（见 §3；反代自己提供对端地址）
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Host $host;
  }
}
```

**注意**：`proxy_set_header X-Forwarded-For $remote_addr` 是**覆写**，不是 `$proxy_add_x_forwarded_for`（追加）。
用追加形式时，客户端自带的伪 `XFF` 会留在列表里；服务**从右往左取第一个不可信地址**（见 §3.1），
伪造值留在左侧不影响判定 —— 但覆写仍是更干净的做法（少一层可被误读的输入）。

---

## 3. 可信代理与 `X-Forwarded-*`：现在的真实语义

### 3.1 现状（源码口径）

| 头                  | 服务怎么用                                                                                                           | 证据                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `X-Forwarded-Proto` | 只决定令牌 cookie 是否加 `Secure`（`https` 或该头为 `https`）                                                        | `http.ts:297-306`（注释明写"该头可被伪造，但伪造只会让 cookie 多一个 Secure"，无害）                                 |
| `X-Forwarded-For`   | **只在声明了可信代理后**才采信，且**从右往左取第一个不可信地址**；它是鉴权限流的**计数键**，也是审计日志里的对端地址 | `authThrottle.ts` 的 `resolveClientAddress`（模块注释写了"为什么必须与限流同批"）；`http.ts` 的 `resolvePeerAddress` |

**要点**：`XFF` **默认不被采信**（`ZCODE_SERVER_TRUSTED_PROXIES` 为空 = 谁都不信），因此伪造它换不来新的限流额度；
反过来，**采信它却不声明可信代理**是此前的真实缺陷 —— 那会让攻击者每请求换一个假 IP、限流形同不存在。
这条已经修掉：**限流与 XFF 采信是同一个改动的两半**（见 §3.2）。

### 3.2 部署方该怎么配（三条原则）

- **只在自己控制的反代/隧道后面暴露服务**，并让反代**覆写** `XFF`。
- **不要**把 `XFF` 当作准入判据（不要在反代规则里写"XFF 属于内网就放行"）；它只用于限流计数与审计日志的对端地址，且仅在 `ZCODE_SERVER_TRUSTED_PROXIES` 覆盖到你的反代时才被采信。
- **不要**在没有可信代理的情况下把服务直接暴露到公网。
- 反代与服务的监听地址在同一台机器时，服务侧仍应只监听 **`127.0.0.1`**（反代负责对外）。

### 3.3 两步配置：反代交出客户端地址 + 服务侧登记可信代理

反代与服务的监听地址在同一台机器时（本文 §2.2/§2.3 的两种配置都是这样），**socket 对端就是回环**。
若不在服务侧登记 `ZCODE_SERVER_TRUSTED_PROXIES`，后果有两个，且第二个更严重：

1. 限流按**反代地址**计数 ⇒ 所有客户端共用一个计数桶，任何一个人的连续失败会让**所有人**在封禁期内被拒
   （服务检测到这个组合时会额外告警并给出修法）；
2. 审计日志与告警里的"对端地址"全是反代地址 ⇒ 出事时无法回答"是谁在连"。

修法两步，缺一不可：

```bash
# ① 反代侧：把客户端地址交给服务（nginx 覆写；Caddy 默认就会设置 X-Forwarded-For）
proxy_set_header X-Forwarded-For $remote_addr;   # 覆写，不是 $proxy_add_x_forwarded_for 追加

# ② 服务侧：登记反代地址（IP 或 CIDR），否则上面那个头**不会被采信**
ZCODE_SERVER_TRUSTED_PROXIES=127.0.0.1
```

启动日志会明确写出当前口径，排障时先看这两行：

```text
trusted proxies: 1 条（采信 X-Forwarded-For）
trusted proxies: 未配置 ⇒ 不采信 X-Forwarded-For，对端地址一律取 socket
```

> **注意（与令牌的联动）**：登记 `ZCODE_SERVER_TRUSTED_PROXIES` 本身就是一个"这东西会被本机之外访问"的
> 信号 ⇒ 从本版起，**回环绑定 + 无令牌 + 配了它**会**拒绝启动**。见 §3.4。

---

## 3.4 把回环端口放到反代/隧道后面会发生什么（**必读**）

> 这一节回答的是**部署形态本身**带来的问题，不是某条配置写错了。

### 3.4.1 基础事实：回环绑定时令牌默认是关的

回环绑定下"只有本机能访问"成立，因此令牌默认关闭，启动日志会写明：

```text
bind=127.0.0.1 scope=loopback-only token-auth=disabled
```

**问题在于：请求经同机代理到达时，对端地址就是回环。** 服务看到的对端是 `127.0.0.1`，
于是"回环 ⇒ 只有本机能到"这个前提**在代理后面不成立** —— 代理把外部流量带进来了。

此时另外两道闸也拦不住一个**不带 `Origin`** 的客户端：

- **Host 白名单**挡不住：攻击者（或任何非浏览器客户端）自己写 `Host: 127.0.0.1` 就在白名单里；
- **来源校验**挡不住：它对不带 `Origin` 的客户端**有意放行**（那是为 CLI / 桌面客户端留的取舍），
  而 `curl` 恰好不带 `Origin`。

⇒ 净结果：**一个不带 `Origin` 的客户端 = 无需令牌的完全控制权**（执行命令、读写工作区）。

### 3.4.2 本版怎么拦：有"外部访问信号"时回环也要求令牌

从本版起，**回环绑定不再无条件放行**：只要配置里给出了"这东西会被本机之外访问"的信号，
就按"对外"对待，**令牌必须开着**（fail-closed，拒绝启动）。

| 信号                       | 触发条件                                          | 处置                           |
| -------------------------- | ------------------------------------------------- | ------------------------------ |
| 声明自己在反代/隧道之后    | `ZCODE_SERVER_TRUSTED_PROXIES` **解析后有生效项** | **拒绝启动**（无可用令牌时）   |
| 登记了默认集合之外的主机名 | `ZCODE_SERVER_TRUSTED_HOSTS` **解析后有生效项**   | **拒绝启动**（无可用令牌时）   |
| 登记了跨源来源             | `ZCODE_SERVER_TRUSTED_ORIGINS` **解析后有生效项** | **只告警，不拒绝启动**（见下） |

四点必须说清：

1. **判据读的是"解析后的生效项"，不是"环境变量有没有被设置"**。一个写错的值（`host:abc`、`not-an-ip`）
   会被静默丢弃 ⇒ **不算信号、不拒绝启动**（与既有"非法项丢弃"的取舍一致 —— 打错字不该变成服务起不来）。
2. **`TRUSTED_ORIGINS` 被刻意排除在拒绝之外，这是有意的，不是漏了**。它同样说明"前面有代理"，
   但**只登记它**是此前能起来的一种部署形态（前端在另一个来源），把配错直接升级成"起不来"会打死合法路径。
   因此这一档走**启动告警**：服务能起来，但日志会明确写出"当前没有任何可用的令牌 + 后果"。
   **这也是唯一可达的告警形态** —— 另外两类信号（或非回环）已经在更早的分支里被拒绝启动，跑不到告警。
3. **拒绝发生在任何子系统被拉起之前**（provider runtime、CUA 等都不会先初始化），
   进程以非 0 码退出，用户看到的就是拒绝原因本身，而不是一堆日志之后的二段错误。
4. **分发入口（`zcode --web`）还会更早拦一次**：runner 在**参数解析阶段**就检查同一组信号，
   命中时直接拒绝，**不会先打印 "ZCode Web is running" 横幅再报错**（避免"看起来起来了、其实是二段错误"）。
   它的判据与服务端**同一口径**（同样读解析后的生效项）。注意：runner 侧是**镜像实现**
   （分发包里的 `bin/zcode.mjs` 是逐字节拷贝的纯 ESM，不能 import 服务端的 TS 模块），因此存在
   "两边解析口径漂移"的风险 —— 这一点由源码注释如实说明，本文不宣称已有测试钉住它。

拒绝文案（照实测引用，不写"应该会拦"）：

```text
拒绝启动：绑定回环地址 "127.0.0.1"，但配置里给出了"这东西会被本机之外访问"的信号，且没有可用的令牌。

触发的信号：
  · 在 ZCODE_SERVER_TRUSTED_HOSTS 里登记了默认集合之外的主机名（生效项：panel.example.com）

原因：回环绑定本身只说明「监听在哪」，不说明「谁能到达」。
  把回环端口放到同机反向代理、隧道或容器端口映射之后时，请求的对端地址就是回环，
  于是「回环不要求令牌」这条判断会让鉴权关卡整条不生效：
  - Host 白名单挡不住它（攻击者自己写 Host: 127.0.0.1 就在白名单里）；
  - 来源校验对不带 Origin 的客户端放行（那是为 CLI/桌面客户端留的取舍），而 curl 恰好不带 Origin。
  ⇒ 结果是一个 curl 就等于无需令牌的完全控制权（执行命令、读写工作区）。

两种做法：
  1. 配一个令牌（推荐）：ZCODE_SERVER_AUTH_TOKEN=$(openssl rand -hex 32)，
     或把每行一条令牌的文件路径写进 ZCODE_SERVER_AUTH_TOKENS_FILE；
  2. 或去掉上面那些登记项：如果你确实只在本机用（不经反代/隧道），
     就不要配 ZCODE_SERVER_TRUSTED_PROXIES，也不要在 ZCODE_SERVER_TRUSTED_HOSTS 里登记域名。
```

### 3.4.3 仍然成立的残余缺口（**有意的边界**）

以下形态**不会**触发上面任何信号，因此**仍然是无令牌的**：

> `bind 127.0.0.1` + **无令牌** + **三类信号全无** + 同机反代/隧道**把 `Host` 改写成上游地址**
> （即不透传原 `Host`）⇒ 运维自己的域名能用，也就**没有理由**去登记 `TRUSTED_HOSTS`。

判据只能读"运维**显式给出**的信号"，做不到"猜出你前面有代理" —— 这是**有意保留的边界**，
不是遗漏。要真正关掉它，必须让"回环 = 可信"这个默认前提失效，而那会打断"本机开箱即用"这条合法路径。

**所以：只要你的回环端口对外可达（哪怕只在局域网内），就配一个令牌。** 这是唯一不依赖判据的修法。

### 3.4.4 仍然建议：在代理层再加一层认证

服务自己的令牌是**静态共享密钥**（无设备级吊销、无过期）。反代/隧道场景下建议**再加一层**：

| 方式                                                     | 适用           | 要点                                                                                     |
| -------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| **Basic auth**（Caddy `basicauth` / nginx `auth_basic`） | 个人/小团队    | 最快落地；凭据由代理校验，服务侧完全不知道                                               |
| **mTLS**                                                 | 设备可控的场景 | 客户端证书即设备身份，天然可按设备吊销（补上服务侧没有的能力）                           |
| **VPN / 私网**（Tailscale、WireGuard）                   | 跨机使用       | 网络层准入，不需要证书；见 [local-setup.md](../development/local-setup.md) 的第 2 条路线 |

### 3.4.5 令牌在 URL 里 ⇒ 会进代理访问日志

首次访问的形态是 `https://<你的域名>/?token=<令牌>`（服务端校验后种下 cookie，之后不必再带查询串）。
**这一次请求会以完整查询串的形式落进反代的访问日志**，也进浏览器历史。

建议二选一（或都做）：

- **在代理层脱敏**：nginx 用 `map` + 自定义 `log_format` 把 `token` 参数替换掉；Caddy 用 `log` 的
  `format` 或直接对根路径关掉 query 记录；
- **只记路径、不记查询串**：对 `/` 这条路径关闭 query 日志。

> 服务侧的审计日志**已经**遵守这条纪律：它**只写 `pathname`、不写 `search`**，
> 并有测试用真实令牌字符串反向搜索整份审计文本、必须搜不到。反代是这条链上**唯一**还会记下明文令牌的地方。

---

## 4. 与既有文档的关系

| 文档                                                                             | 关系                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [headless-server.md](./headless-server.md) §4                                    | 服务自身的安全边界（默认回环、非回环必令牌、暴露告警、令牌 = agent 级访问）。**反代相关细节一律看本文**，那边只留一句链接 |
| [local-setup.md](../development/local-setup.md) 的「Web 工作台的监听与对外访问」 | 三条部署路线的入口（本机 / 私网隧道 / TLS 反代）。本文把第 3 条展开成可照做的配置                                         |
| [web-remote-control.md](../development/web-remote-control.md) §7                 | 威胁模型与内网穿透指引；跨源合法部署用 `ZCODE_SERVER_TRUSTED_ORIGINS`                                                     |

**与既有说法的关系**：早期 `local-setup.md` 只写了"伪造 `X-Forwarded-Proto` 无害"（正确），但没说明 `X-Forwarded-For` 的采信口径；现在两处口径已一致 —— **XFF 只在声明了可信代理后才被采信**，未配置时以连接来源地址为准，且始终不作为准入判据。

---

## 5. 核对方法（可执行）

### 5.1 Host 白名单是否生效（**实现后**：核心线索是"伪 Host 一律 403"）

```bash
# ① 伪 Host ⇒ 403（且响应体给出去哪里登记域名）；这条**不受令牌状态影响**
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: attacker.example' http://127.0.0.1:3030/api/server-info
# 期望 403（不是 401：401 说明 Host 根本没被校验）

# ② 看拒绝原因是否可操作（应提到 ZCODE_SERVER_TRUSTED_HOSTS）
curl -sS -H 'Host: attacker.example' http://127.0.0.1:3030/api/server-info

# ③ 合法 Host（回环 + 真实端口）仍应照常：401/200 取决于是否带令牌
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3030/api/server-info      # 401（缺令牌）

# ④ 启动日志里逐类打印生效白名单（排障第一站）
#    trusted hosts: loopback=[127.0.0.1,::1,localhost] interface=[...] configured=[...]

# ⑤ 反代域名必须登记，否则你自己的域名也会被 403：
#    ZCODE_SERVER_TRUSTED_HOSTS=zcode.example.com
```

### 5.2 实现位置（核对该实现是否存在）

```bash
grep -rnE 'evaluateHost|buildTrustedHostEntries|ZCODE_SERVER_TRUSTED_HOSTS' packages/server/src | head
# 期望：hostAllowlist.ts（判定）+ http.ts（中间件与 upgrade gate）+ entry-http.ts（读环境变量）

# §3.4 的"回环 + 外部访问信号 ⇒ 拒绝启动"在哪：
grep -rnE 'collectExposureSignals|refusalSignals|buildLoopbackExposureRefusal' packages/server/src | head
# 期望：exposureGate.ts（判据与文案的唯一所有者）+ http.ts（接进 assertListenSecurity）
# 直接看行为（回环 + 登记域名 + 无令牌 ⇒ 非 0 退出，且拒绝发生在子系统之前）：
ZCODE_SERVER_TRUSTED_HOSTS=panel.example.com ZCODE_SERVER_HOST=127.0.0.1 PORT=3030 \
  node packages/server/dist/entry-http.js    # 期望：拒绝启动，退出码 1
```

### 5.3 反代三条要求是否满足

```bash
curl -sSI https://zcode.example.com/ | head -1                      # SPA 壳 200
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Origin: https://zcode.example.com' \
  https://zcode.example.com/api/server-info                          # 401（无令牌）——说明 API 在同一 origin 上
# WebSocket：浏览器打开面板能保持连接（漏转发升级会表现为立刻断开）
```

---

## 6. 未验证 / 限制

- **Host 白名单已实现**（§1.2）：默认白名单不含任何外部域名 ⇒ **反代域名必须显式登记**，
  否则会 403（这是有意行为，不是 bug）。
- **`XFF` 收紧已实现**（§3）：反代部署请配 `ZCODE_SERVER_TRUSTED_PROXIES`，否则限流按反代地址计数。
- **回环 + 外部访问信号 + 无令牌 ⇒ 拒绝启动已实现**（§3.4.2）。其中 `TRUSTED_ORIGINS` 一档**有意只告警**
  （不拒绝），理由见 §3.4.2 第 2 点。
- **残余缺口（有意保留）**：三类信号全无 + 代理改写 `Host` 时，回环无令牌仍可被完全控制（§3.4.3）。
  判据只能读"运维显式给出的信号"，不猜拓扑。
- 本文的 Caddy/nginx 配置在**本机未实测**（没有可用的对外域名与证书环境）；请按 §5.3 在自己的环境核对。
- §3.4 的实测是在**本机同机 TCP 代理**上做的（真实服务进程 + 真实代理转发，见该节的命令形态），
  **未在真实 Caddy/nginx + 公网域名下复测**。
- 子路径部署**不支持**（§2），且不是"配置一下就好"——需要 base path 改造，属未排期工作。

---

## 7. 三个安全旋钮（怎么配 / 配错的后果 / 怎么验证）

> 三个都是**服务端进程的环境变量**（批次 A-1 新增，实现见 `packages/server/src/entry-http.ts` 与 `webExposureGuard.ts`）。
> 机制与语义的**规格**在 [web-remote-control.md](../development/web-remote-control.md) §4，这里只给"部署方怎么用"。

| 变量                           | 什么时候配                                                                                                                                               | 配错的后果                                                                                                                                                                                                                                                          | 怎么验证生效                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ZCODE_SERVER_TRUSTED_ORIGINS` | **只有**当面板的前端与后端**不在同一 origin**（例如前端 `https://ui.example.com`、后端 `https://api.example.com`）时，把**前端的来源**登记进来；逗号分隔 | ① 不登记 ⇒ 跨源请求被拒（面板报"来源不被允许"，并提示你登记白名单）；② 登记成**无关或过宽**的来源 ⇒ 等于给别的站点开了一道门（**别登记 `*`，别登记你不控制的域名**）；③ 同一 origin 部署却登记它 ⇒ 多余（**同源判定恒优先于白名单**），且增加误配面                 | 启动日志会打印生效的白名单（`cross-site allowlist: …`）；功能上：面板跨源访问能正常返回 `/api/server-info`（200），未登记来源被拒（403） |
| `ZCODE_SERVER_CSP`             | 想调 CSP 强度时。缺省（不设）= **report-only**（只上报、不拦截，给观察期）；`off` = 完全不发；`enforce` = 真正拦截                                       | ① 直接上 `enforce` 而站点里仍有内联脚本 ⇒ 面板可能白屏（**先在 report-only 下观察**）；② 拼错值（例如 `true`）**不会**静默变成 enforce —— 会回落 report-only 并在启动日志说明；③ `off` 会丢掉一层纵深防御（`frame-ancestors`/`X-Frame-Options` 仍无条件下发，见下） | `curl -sSI https://<你的域名>/                                                                                                           | grep -i content-security-policy`：`Content-Security-Policy-Report-Only` = 观察期，`Content-Security-Policy` = enforce，无该头 = off |
| `ZCODE_SERVER_HSTS`            | **只在**你确定整站长期走 https、且所有子域都已 https 时才开（例如 `1`/`true`）                                                                           | ① 在还没准备好的域名上开启 ⇒ 浏览器从此只走 https，回退困难（**HSTS 一旦下发无法撤回**，这是它默认关闭的原因）；② 明文 http 下**不会**下发，所以"开了没生效"通常是没走 https                                                                                        | `curl -sSI https://<你的域名>/                                                                                                           | grep -i strict-transport-security`：有该头 = 生效；http 下不应出现                                                                  |

**两个与部署相关的要点**：

1. **`ZCODE_SERVER_TRUSTED_ORIGINS` 不能替代「同一 origin」**：反代的最佳做法仍然是**同一 origin 同时服务 SPA 与 `/api`/`/ws`**（§2.1）——那样根本不需要白名单；白名单只服务"前端/后端域名不同"的既有部署。
2. **无条件下发的响应头**（与上面三个旋钮无关）：`X-Content-Type-Options: nosniff` 与 `X-Frame-Options: DENY`（及 CSP 里的 `frame-ancestors 'none'`）始终下发 —— 点击劫持防线不依赖配置。

**验证用的最小命令集**：

```bash
B=https://<你的域名>
curl -sSI "$B/" | grep -iE 'content-security-policy|strict-transport-security|x-frame-options|x-content-type-options'
# 跨源白名单：未登记来源应被拒（403），登记后应通过（配合有效令牌观测 401/200 的差别）
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' "$B/api/server-info"
```
