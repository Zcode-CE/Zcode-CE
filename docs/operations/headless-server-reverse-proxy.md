# 反代 / TLS 之后部署无头服务器（三件事）

> 面向**部署方**：把 `zcode --web` 放到反向代理或隧道之后、给局域网外的设备使用时，必须知道的三件事 ——
> **① Host 白名单（今天的缺口）**、**② 只支持挂域名根**、**③ 可信代理与 `X-Forwarded-*` 的真实语义**。
> 服务本身的安全边界见 [headless-server.md](./headless-server.md) §4；链路与威胁模型见 [web-remote-control.md](../development/web-remote-control.md)；
> 三条部署路线（本机 / 私网隧道 / TLS 反代）见 [local-setup.md](../development/local-setup.md) 的「Web 工作台的监听与对外访问」。

## 0. 三条先记住的结论

1. **只支持挂在域名根（`/`）**：SPA 静态、`/api`、`/ws` 必须在**同一 origin**（见 §2）。
2. **Host 白名单（G6）当前尚未实现**：服务用 `Host` 头只是为了推导"自我来源"做跨站判定，
   **没有**允许主机名白名单 ⇒ **Origin 校验挡不住 DNS rebinding**。核对方法与修法见 §1 与 §5。
3. **`X-Forwarded-For` 当前被无条件信任**（用作对端地址的日志/告警）：因此**不要**把它当成安全判据（§3）。
   在「可信代理 + XFF 收紧」落地之前，**不要把服务暴露到公网**。

---

## 1. Host 白名单（G6）：为什么需要、我们到哪一步了

### 1.1 为什么必须校验 Host

服务默认绑回环时，`http://127.0.0.1:3030` 常被当成"安全位置"。但攻击者页面可以：

1. 诱导用户访问 `http://attacker.example`；
2. 该域名 **DNS 重绑定**到 `127.0.0.1`；
3. 页面从**自己的 origin** 发请求到 `http://attacker.example:3030/api/...` —— 对浏览器而言这是**同源**，
   于是会带上我们种在回环上的 cookie；
4. 结果是：**同源策略与 Origin 校验同时失效**（攻击者的 `Origin` 与它自己伪造的 `Host` 一致）。

同类项目的对策就是**主机名白名单**：Grafana 的 `enforce_domain` 选项明写
"**Prevents DNS rebinding attacks**"（来源：Grafana 配置文档，属同类项目文档证据）。

### 1.2 我们今天的实现口径（**如实：缺口**）

| 事实                                                                                                                     | 证据                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Host` 头只被用来**推导自我来源**（`resolveSelfOrigin(hostHeader, protocol, requestUrl)`），用于跨站请求的 `Origin` 判定 | `packages/server/src/webExposureGuard.ts:112-133`（"Host 头是唯一第一手信息"）；`http.ts:730`、`webExposureGuard.ts:301` 传 `host` 进来 |
| **不存在**允许主机名白名单（`allowedHost`/`expectedHost`/`ALLOWED_HOST`/`enforceDomain` 之类）                           | 全仓检索这些标识：**0 命中**（命令见 §5.2）                                                                                             |
| 跨源部署可用 `ZCODE_SERVER_TRUSTED_ORIGINS` 显式放行（批次 A 的机制）                                                    | `packages/server/src/entry-http.ts:47`、`http.ts:157-159,529,682-683`                                                                   |

**结论**：**§1.1 那条攻击链今天仍然成立**。Origin 校验解决的是"别的网站冒充浏览器发起请求"，
不解决"攻击者用自己的域名重绑定到本机"（那时它的 `Origin` 与 `Host` 是自洽的）。

**修法（已登记，未实现）**：见 [.reverse/43-web-security/B2-REVERSE-PROXY-GAPS.md](../../.reverse/43-web-security/B2-REVERSE-PROXY-GAPS.md)（G6 待办：允许主机名白名单 + 拒绝不匹配的 `Host`）。

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
用追加形式时，客户端自带的伪 `XFF` 会留在列表里；服务取首跳（见 §3.1）就会拿到伪造值。

---

## 3. 可信代理与 `X-Forwarded-*`：现在的真实语义

### 3.1 现状（源码口径）

| 头                  | 服务怎么用                                                    | 证据                                                                                 |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `X-Forwarded-Proto` | 只决定令牌 cookie 是否加 `Secure`（`https` 或该头为 `https`） | `http.ts:297-306`（注释明写"该头可被伪造，但伪造只会让 cookie 多一个 Secure"，无害） |
| `X-Forwarded-For`   | **取首跳**作为"对端地址"，用于启动/运行期**告警文案与日志**   | `http.ts:374-376`（注释：可伪造，但伪造只会多打一次告警）、`webExposureGuard.ts:329` |

**要点**：今天**没有任何按 IP 的限流或封禁**依赖这个值，所以伪造 `XFF` 不会立刻变成绕过；
但一旦将来加"按 IP 限流/审计"，**首跳 XFF 是攻击者可控的**（同类风险见安全调研 G3/G10②）。

### 3.2 部署方该怎么配

- **只在自己控制的反代/隧道后面暴露服务**，并让反代**覆写** `XFF`（nginx 用 `$remote_addr`，Caddy 默认行为即可）。
- **不要**把 `XFF` 当作准入判据（不要在反代规则里写"XFF 属于内网就放行"）。
- **不要**在没有可信代理的情况下把服务直接暴露到公网。
- 反代与服务的监听地址在同一台机器时，服务侧仍应只监听 **`127.0.0.1`**（反代负责对外），
  这样"非回环 + 无令牌拒绝启动"这条不变量的保护面不会被绕过。

### 3.3 我们会怎么改（同批，未落地）

"**只信任来自可信代理的 `XFF`**"（例如配置可信代理地址/网段，非可信来源忽略该头）与批次 A-2 的 A3 是同一批工作；
落地前请按 §0 第 3 条处理（**不要暴露到公网**）。

---

## 4. 与既有文档的关系

| 文档                                                                             | 关系                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [headless-server.md](./headless-server.md) §4                                    | 服务自身的安全边界（默认回环、非回环必令牌、暴露告警、令牌 = agent 级访问）。**反代相关细节一律看本文**，那边只留一句链接 |
| [local-setup.md](../development/local-setup.md) 的「Web 工作台的监听与对外访问」 | 三条部署路线的入口（本机 / 私网隧道 / TLS 反代）。本文把第 3 条展开成可照做的配置                                         |
| [web-remote-control.md](../development/web-remote-control.md) §7                 | 威胁模型与内网穿透指引；跨源合法部署用 `ZCODE_SERVER_TRUSTED_ORIGINS`                                                     |

**本文修正的既有说法**：`local-setup.md` 此前只写了"伪造 `X-Forwarded-Proto` 无害"（正确），
但**没有提到 `X-Forwarded-For` 也被无条件信任**；本文 §3 补上这条，并明确"不要用 XFF 做安全判据"。

---

## 5. 核对方法（可执行）

### 5.1 Host 白名单是否已落地

```bash
# 带一个不属于本服务的 Host 访问：若实现白名单，应被拒绝（403/400）而不是正常返回
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: attacker.example' http://127.0.0.1:3030/api/server-info
# 今天（无白名单）预期：401（缺令牌）——**这不能证明安全**，它只说明令牌仍在拦；
# 用一个有效令牌再试：若能返回 200，说明 Host 未被校验
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: attacker.example' \
  -H 'Cookie: zcode_lite_token=<令牌>' http://127.0.0.1:3030/api/server-info
```

### 5.2 是否真的没有主机名白名单

```bash
grep -rnE 'allowedHost|expectedHost|ALLOWED_HOST|enforceDomain' packages/server/src packages/server/test scripts | wc -l   # 今天 → 0
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

- **Host 白名单尚未实现**（§1.2）：这是本文最重要的**缺口**声明，不是"待确认"。
- **`XFF` 收紧尚未实现**（§3.3）：落地前不要暴露到公网。
- 本文的 Caddy/nginx 配置在**本机未实测**（没有可用的对外域名与证书环境）；请按 §5.3 在自己的环境核对。
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
