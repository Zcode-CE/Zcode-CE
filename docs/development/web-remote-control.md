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
5. 反代/隧道场景见 §6 与 `docs/development/local-setup.md` 的「Web 工作台的监听与对外访问」。

**要不要二维码？M1 不做。** 理由：当前可用形态是「一条链接」，二维码只是把这条链接换个载体；而产品内生成二维码需要引入新的图形依赖，涉及新依赖取舍（按根 `AGENTS.md` 的判据属「非核心便利件」，应单独决策）。用户可用任意二维码工具把打印出来的链接转成码。

**授权否决/撤销**：令牌是**单个静态共享密钥**（换令牌 = 所有已连设备失效）；没有按设备凭据、没有设备列表、没有逐设备撤销。要撤销就换 `ZCODE_SERVER_AUTH_TOKEN`/重启服务并重新分发链接。

**`--no-token` 的边界**：只允许与回环 host 组合（`scripts/zcode-distribution/runner.mjs` 参数解析阶段的组合校验，与 `packages/server` 的 fail-closed 判定同一条不变式）。对外必须带令牌 —— 这不是可选项。

---

## 4. 断线恢复（本轮最高价值项）

**现状缺陷（已确认）**：

- 传输层不重连：`packages/client/src/websocket.ts:62-100` 只在连接建立前 reject、建立后触发 `onClose` 回调，没有任何重连与退避；
- Web 入口把断线回调**直接丢弃**：`packages/web/src/main.tsx` 的 `connectViaWebSocket(wsUrl, { onClose: () => {} })`；
- 结果：手机锁屏/切后台、Wi-Fi 切换、服务重启后，页面**保持看似正常但完全不动**（假死），只有手动刷新才能恢复；启动阶段的失败有错误屏（`WebBootstrapErrorScreen`），**运行期断线没有任何提示**。

**M1 目标行为**：

1. 连接断开 → 立刻显示「连接中断，正在重连」覆盖层（含第几次尝试），页面其余部分不假装可用；
2. 自动重连：指数退避 `0.5s → 1s → 2s → 4s → 8s → 上限 10s`，带抖动；
3. 重连成功 → 用新连接**重新挂载应用**（应用自身按 `web-remote-replayable` 语义重新拉快照），覆盖层消失；
4. 重试次数用尽 → 覆盖层切到「无法连接」并给**重试按钮**（用户可手动再试），不再无声等待。

**明确不承诺**：恢复到**断线前那个任务**。原因是应用的 store 由 `StoreProvider` 在每次挂载时创建（`packages/ui/src/store/StoreProvider.tsx:31-40` 用 `useRef` 持有实例、通过 Context 提供，**没有模块级单例**），重新挂载后无法从外部读回「当前任务」；实现它需要把 store 生命周期上提或把任务标识落到 URL/持久化，属后续项（§9）。M1 的恢复语义是**回到工作区（会话列表）并可继续操作**，两者差别必须在发布文案里说清。

**验收方式**（可复现）：起服务 → 浏览器打开 → 杀掉服务进程（模拟锁屏/断线）→ 页面出现重连覆盖层 → 重新起服务（同端口）→ 覆盖层消失、应用恢复可用。§8 给了命令与原始观测。

---

## 5. 版本配套（web 资产与运行时必须同版本）

- **分发是同一份构建**：`scripts/build-zcode.mjs:158-181` 在同一次 stage 里构建 `@zcode/web` 与 `@zcode/server`（以及 agent bundle），因此安装包内 web 资产与 server 天然同版本。
- **契约版本**：`/api/server-info` 返回 `protocolVersion = SERVER_REMOTE_PROTOCOL_VERSION`（`packages/shared/src/server-remote.ts:3` 当前为 `1`；`packages/server/src/http.ts:166-180`）。
- **不配套时的行为（明确、不静默降级）**：web 客户端在启动时比对「自身编译进来的契约版本」与 `/api/server-info.protocolVersion`；**不等即显示明确的错误屏**（说明资产与服务器版本不一致、请用同一版本重新部署/刷新），**不进入应用**。本轮实现这一点（§8 有断言）。
- **未测**：跨版本的 RPC/协议兼容性（例如服务端旧、web 新但契约版本恰好相同的情形）本轮**没有测**；RPC 层不做版本协商（`packages/rpc/src` 无 `protocolVersion` 校验，`grep` 0 命中），因此「同版本」是当前唯一被支持形态。

---

## 6. 威胁模型与内网穿透指引

**这条链路暴露的是 agent 级 RPC** —— 拿到连接就能在该主机的工作区里执行命令、读写文件。因此：

1. **非回环必须令牌**：服务端对「非回环 + 无 token」拒绝启动（`packages/server/src/http.ts` 的 `assertListenSecurity`）；分发 runner 在参数解析阶段就拒绝该组合。**不要**用「反正内网」当理由关掉令牌。
2. **不要在明文 http 上跨不可信网络暴露**：令牌走查询串（会进浏览器历史）、cookie 默认没有 `Secure`（除非是 https/反代）。跨公网必须 **TLS 终结在隧道或反代**（`X-Forwarded-Proto: https` 会让 cookie 带 `Secure`）。
3. **推荐的三条路**（与 `docs/development/local-setup.md` 同口径）：① 只在本机（127.0.0.1）；② 私网/SSH 隧道（`ssh -N -L 3030:127.0.0.1:3030 <主机>`）—— 无需证书；③ TLS 反代（Caddy 两行）后仅让反代监听对外。
4. **本仓库不托管任何中继/云服务**：没有配对服务器、没有二维码分发服务、没有官方 relay（0 命中）。网络可达性完全由用户自己的私网/隧道/反代提供。
5. **公网暴露风险自担**：令牌是静态共享密钥、无设备级吊销、无速率限制；暴露到公网等于把「执行命令的能力」挂在一个单密钥上。

---

## 7. 明确不提供什么（不要按官方远控预期使用）

| 不提供                                         | 说明                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| 移动壳（原生 App / 抽屉式窄屏外壳 / 主屏安装） | 本仓库 `drawer` 0 命中、无 PWA manifest；手机用的是同一套响应式网页    |
| 推送通知                                       | 无                                                                     |
| 云 relay / 扫码配对服务器                      | 无（官方那套依赖 relay 与官方托管的手机页面，本仓库 0 命中且不可复制） |
| 多客户端并发保证                               | **未测**（§2）：可以两个客户端都连上，但同一会话的并发输入行为没有验证 |
| 回到断线前的同一任务                           | M1 恢复语义是回到工作区（§4）                                          |
| 设备管理 / 逐设备撤销 / 会话列表审计           | 无；令牌是单一静态密钥                                                 |

---

## 8. 验收（可执行命令与期望）

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

## 9. 未定 / 后续

1. **完整安装包链路的端到端验证**（`scripts/build-zcode.mjs` → `zcode --web` → 手机）：本轮只验证了「源码构建的 web 资产 + packages/server 入口 + 令牌 + 局域网可达」这一条；整包构建（含运行时 node_modules 复制与 TUI 运行时 stage）未实跑，需要单独一轮。
2. **二维码 / 一键分享**：需评估新依赖（§3）。
3. **回到断线前的同一任务**：需要把 store 生命周期上提或把任务标识落到 URL/持久化（§4）。
4. **多客户端并发**：需要一次带真实会话的并发验证（读/写/lease）（§2）。
5. **PR #1 的三项触屏 UI 修复**（消息操作栏常显、web 侧栏切换、非安全上下文剪贴板回退）是本能力的 UI 前置，将作为本线的一部分收编（由 Lead 在 pr-triage 复审结论出来后安排）。
