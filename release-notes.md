<!-- 草稿：未发版，发版前删除本行 -->

> 本次更新按"你能感知到的变化"组织。

## 新增功能

- **无头服务器 + 浏览器界面**：自包含发行包（服务端入口 + Agent 运行时 + Web 静态资源 + 启动器）。
  在没有桌面环境的机器上跑 `zcode --web`，同一局域网内的手机或另一台电脑用浏览器即可操作该工作台（含手机窄屏适配）；解包后 `node bin/zcode.mjs --web` 直接起服务。
  常用参数写入 `~/.zcode/cli/server.json`（命令行 > 环境变量 > 配置文件 > 内置默认），`--web --help` 列出全部默认值与旋钮。
  默认只监听本机；**非回环地址必须带令牌，否则拒绝启动**。
- **桌面端的远程控制入口**：账号区新增入口，从这里**启动/停止一个供浏览器访问的服务**，并把地址、二维码与链接交给手机或另一台电脑；对方用浏览器即可操作**这台机器上的工作台**。
  它**不是**接管桌面端正在开的会话，桌面端已连的远端 SSH / Docker 目标也**不会**共享给浏览器。默认只监听本机，要开放到局域网需显式选择并带令牌；已有服务在跑时只接管显示、**不会重复启动**。
- **本地 Docker 资产**：新增 `Dockerfile` 与 `compose.yaml`（glibc 基础镜像、非 root 运行、卷持久化、健康检查），以及一份 Docker 专门文档（容器内路径、卷与备份、局域网访问、令牌与轮换、glibc-only 的原因、安全边界）。
  实测覆盖：容器内起服务、鉴权 401/200、`/ws` 拒绝、**容器内终端可用**、卷持久化、优雅停止。本版**不发布预构建镜像**，请自行 `docker build`。
- **浏览器会话的断线恢复与版本配套校验**：浏览器客户端连服务端进程这条链路补齐了**断线恢复**与**版本配套校验** —— 手机窄屏下不再"一连就断、断了只能重开"。
- **工作区列表不再由客户端设置决定**：可见工作区改由**服务端注册表**作为唯一真相源，客户端只做派生视图；未启动的工作区有**诚实的"未启动"状态**，不再假装已就绪。
- **PDF 制作能力**：随包 Node 载荷（PDFKit + FontKit，MIT），**零外部依赖**，可生成中文正文、表格与页码。
- **MCP 可以按单个工具启停**：不想让模型看到某个工具，就在 MCP 服务器配置里写 `disabledTools`（设置页也有对应表单）。
- **引导式授权**：命令块新增「发送到终端」——命令进入**你自己的终端**，**由你按回车**才执行，而不是替你在后台跑。
- **远程工作区资产自建**：SSH 远程工作区的运行时资产可本地装配并端到端校验；社区 CDN 接入发布链，并新增「自定义 CDN 托管地址」（含基址语义修正：自定义地址按**字面值**作为发布根）。

## 体验优化

- **手机窄屏**：修复主内容区被裁切、设置行错位、头部重叠、断线覆盖层挡住交互、键盘遮挡输入；扩大输入区与侧栏的可点区域；状态浮层不再压住正文；命令面板与触屏提示贴边；工具行展开在触屏上有可发现的入口且内容可读。
- **触屏可达性**：补齐原先只有 hover 才能触发的入口（"切换终端"移入 ⋯ 菜单、消息操作在触屏上常显、移动 Web 可用"复制全文"，并覆盖剪贴板回退路径与失败提示）。

## 问题修复

- **页面加载期崩溃**：打开界面时偶发白屏/渲染报错，已在客户端调用顺序上修掉。
- **授权后永久卡在"正在重连"**：服务重启窗口只探测一次，错过一次就永不重试。
- **未授权态不再伪装成"正在重连"**：401 与断线现在如实区分；`/api` 精确路径纳入鉴权面。
- **局域网内无凭证即可操作本机工作台**：本地 Web 服务此前默认不设防，同一局域网内的任何人都能拿到一个权限**高于**普通客户端的凭据。现在默认只监听本机；要对局域网开放必须显式指定地址并带令牌。
- **上传自检的假失败**：网络抖动误判为失败、以及把"对象确实不可取"当成同一件事；发布根配置写错时改为**上传前**给出可行动的报错。
- **发行包内的服务端打包缺陷**：解包后起服务会抛 `Dynamic require of "fs" is not supported`，已修。

## 升级须知（行为变化）

- **新增三个服务端环境变量**（都可以不设，默认值在安全侧）：
  - `ZCODE_SERVER_TRUSTED_ORIGINS`：跨源白名单（逗号分隔）。**只**在前端与后端不同源时才需要，**同源判定恒优先于它**；不登记 ⇒ 跨源请求被拒；登记过宽（例如你不控制的域名）⇒ 等于给别的站点开一道门；空项/非法项会被丢弃并在启动日志说明。若要按域名访问（含反代），还要登记 `ZCODE_SERVER_TRUSTED_HOSTS` —— **两道防线，缺一不可**。
  - `ZCODE_SERVER_CSP`：缺省 = **report-only**（只上报、不拦截）；`off` = 完全不发；`enforce` = 真正拦截。**拼错的值不会静默升级成 enforce**，而是回落到 report-only 并在启动日志说明。
  - `ZCODE_SERVER_HSTS`：**只在 https 且显式开启**时才发；一旦下发**无法回撤**（浏览器从此只走 https），因此默认关闭。
- **跨站请求现在会被拒绝（403）**：带跨站 `Origin` 的请求（含跨站 WebSocket 升级）会被拒，并带 `X-ZCode-Cross-Site-Rejected: 1` 响应头。
- **反代后面必须登记你自己的域名**：新增 Host 白名单（默认只放行回环与本机网卡地址），否则 DNS 重绑定仍能绕过来源校验。用域名访问却在 `ZCODE_SERVER_TRUSTED_HOSTS` 里没登记，你自己也会收到 403 并带 `X-ZCode-Host-Rejected: 1` —— 这条容易在升级后第一次配反代时踩到，**请把域名登记进去**。
- **鉴权失败开始限流**：同一来源连续 10 次鉴权失败 ⇒ 封禁 15 分钟（返回 403，不是 429）。判断来源时只采信已登记可信代理送来的 `X-Forwarded-For`，未登记 `ZCODE_SERVER_TRUSTED_PROXIES` 时一律按连接来源地址计。
- **新增审计日志**：连接建立/断开、鉴权失败、Host 与来源拒绝、令牌重载、并发超限都会写一行结构化日志（`audit:` 前缀）。日志不写令牌、cookie、完整查询串与请求体。
- **并发连接有上限**：同时活跃的 WebSocket 连接最多 32 条，超限时**拒绝新连接**（已有连接不受影响）。
- **"缺 Origin 就放行"是有意的取舍**：非浏览器客户端（curl、脚本、CLI）不带 `Origin`，一律放行。因此来源校验**不覆盖非浏览器客户端**；DNS 重绑定由 Host 白名单单独挡（见上一条）。反过来，**用 HTTP/1.1 但完全不发 `Host` 的手工探针会被拒绝**（curl 默认会带，不受影响）。
- **远控面板不是官方那套 relay / Bot Channel**：本项目**不引入中继**，也不做 IM 机器人；面板只提供"扫码 / 在手机浏览器打开链接"这一条**自托管**路径。
- **手机窄屏上部分入口换了位置**（例如"切换终端"进入 ⋯ 菜单）——不是功能删除，是为触屏可达。

## 已知限制

- **平台支持（指无头服务器发行包：服务端 + 内置 Agent 运行时 + Web 静态资源）：正式支持 Linux-x64（glibc）**。
  该发行包的 macOS / Windows 构建未实测，且包内原生载荷只含 Linux ⇒ **不承诺可用**；**桌面客户端与浏览器界面不在这条平台口径内** —— 浏览器界面只需要浏览器，手机与其它系统的浏览器同样可用。
- **Alpine / musl 不在支持范围**；实测行为是：服务与面板**可以运行**（npm 形态，需自带 **Node ≥24** 的 musl 构建；Alpine 3.24 的 `apk add nodejs` 实测 24.18.1 即满足），**终端功能不可用** —— 会在创建终端时给出明确提示，而不是崩溃。
- **第三方许可材料：随包通知里仍有部分组件的出版方材料不全** —— 我们按「**发布者声明 + 标准条款 + 已记录的出处**」逐条登记，未闭环的条目在随包的 `THIRD-PARTY-NOTICES.md` 与 `third-party/README.md` 里如实列出（**登记了不等于材料齐全**）。
  顺带修正一处署名：`brotli` 内嵌的 `google/brotli` 解码器是 **Apache-2.0**，此前被我们记为 MIT；本版已补上其版权与许可声明。
- **远程控制（桌面端）本次只到「开服务 + 连接信息」**：已连设备列表与逐设备断开、端口与监听范围选择、令牌轮换入口**尚未提供**（排后续批次）。
- **桌面端安装包因此增大约 66 MB**（服务端入口 7.2 MB + Web 界面资源 59 MB，已排除 source map）—— 手机扫码打开的就是这份 Web 界面，必须随包。
- **容器形态只能管理挂载进去的目录**（这是容器边界本身，不是缺陷）：需要主机全盘访问时，用 npm 形态直接在主机上运行。
- 与上一版相同（Windows 构建未签名、Windows / macOS 未在真机做完整功能回归、Linux 桌面自动化为实验性等），本批**未新增**其他长期限制。

## 本版尚未验证

- **真机软键盘（IME）未验证**：窄屏键盘避让只在受控环境下核对，未在真机 IME 上验证。
- **手机 + 桌面同时连同一会话的并发语义未测**：两端能各自连接，但同一会话被两端同时操作的行为**没有测**，不要依赖。
- **浏览器级"跨源页面 + 跨源 fetch"未做**：WS 侧已有等价覆盖与测试，但"跨源网页用 fetch 打服务"这条路径未实测。
- **没有沙箱**：令牌泄露（或加固被绕过）意味着在宿主上以服务进程权限执行命令、读写工作区外文件（含 `~/.zcode/v2` 里的 provider 凭据）；工作区之外没有第二道边界。
- **无令牌吊销**：令牌是静态共享密钥、没有设备维度；轮换令牌会让**所有**已连设备重连（设备级撤销属后续批次）。
- **反代配置未实测**：文档里的 Caddy / nginx 最小配置需要在你自己有证书的环境里自测。
- **"先被扫描、再被封"的过程未复现**：限流在受控条件下验证过，但没有在真实公网扫描下跑过。
- **CI 新增的两个 job 未在真实 runner 上跑过**：无头服务器发行包的构建/挂载 job、远程资产上传 job 都只在本地核对（release 流水线**其余** job 长期在真实 runner 上运行，不受这条影响）。
- **WSL 作为远程工作区承载未实测**：需要 Windows 客户端或 `windows-latest` CI，且需启用 WSL2；**Docker 承载已实测通过**（真实 Docker 29.8.0、rootless、cgroup v2，容器用默认参数，含在容器内启动服务并完成握手）。
- **musl 主机（如 Alpine）上的本机运行：终端不可用，服务与面板可用（实测）**：
  起服务、连面板、`/api/server-info` 鉴权、`/ws` 无令牌拒绝都已实测通过；**创建终端会被拦断并给出可操作提示**。
  拦断取代了此前的**进程级崩溃**：在 musl 上原生 `fork()` 会 **Segmentation fault（exit 139）并杀掉整个进程**，该崩溃不可捕获 —— 这也是为什么拦断发生在**装载原生模块之前**，而不是"装不上再说"。
- **远程工作区在 musl 远端上不可用（实测）**：载荷是 glibc 构建（`node` 报 `cannot execute: required file not found`，缺 `/lib64/ld-linux-x86-64.so.2`），
  因此连接时会**在部署资产之前拦断**并给可操作原因；改用 glibc 发行版的远端镜像即可。
- **上游同样不支持 musl**（不是本版独有的取舍）：上游 `node-pty` 没有 musl 预编译，官方发行版的资产集也只有 `platformArch` 维度、没有 `-musl` 平台类。
- **npm 形态的 Node 下限是 `>=24`**：低于下限时可能在打印启动横幅后才失败（实测 Node 20 在导入期即失败），请先用 `node --version` 确认。
- **⚠️ Windows 上不要用 kill -HUP**：令牌轮换依赖 SIGHUP，而 Windows 没有这个信号、**对进程发 SIGHUP 会终止进程** ⇒ 那不是重载令牌，是**把服务杀掉**。Windows 下改完令牌文件请**重启服务**。
- **手机 + 桌面同时操作同一会话的并发写语义没有任何实测**：CommandInbox 的串行 admission 是**设计约定**，不是并发写的验收结论；连接数上限（默认 32）只防资源耗尽，**不要读作「并发写已被保护」**。

---

# English

<!-- Draft: not released — delete this line before tagging. -->

> This release is organised by the changes you can perceive.

## New features

- **Headless server + browser UI**: a self-contained distribution (server entry + Agent runtime + Web static assets + launcher).
  Run `zcode --web` on a machine **without a desktop environment** and a phone or another computer on the same LAN can drive that workbench in a browser (narrow-screen phones included); after unpacking, `node bin/zcode.mjs --web` starts the service directly.
  Frequently used options can be written to the config file `~/.zcode/cli/server.json` (command line > environment variables > config file > built-in defaults), and `--web --help` now lists every default and knob.
  It listens on loopback by default; a **non-loopback bind without a token refuses to start**.
- **Remote control entry point on the desktop**: a new entry in the account area starts/stops a **service that browsers can reach**, and hands out the address, QR code and link to a phone or another computer — which then drives **the workbench on that machine** in a browser.
  It does **not** take over sessions that are already open on the desktop, and remote SSH / Docker targets connected from the desktop are **not** shared with the browser. It listens on loopback by default; opening it to the LAN requires an explicit choice and a token. If a service is already running, the panel adopts it for display and does **not** start a second one.
- **Local Docker assets**: a `Dockerfile` and `compose.yaml` (glibc base image, non-root, volume persistence, health check) plus a dedicated Docker document (paths inside the container, volumes and backup, LAN access, tokens and rotation, why glibc-only, security boundary).
  Measured: service inside the container, auth 401/200, `/ws` rejection, **terminal usable inside the container**, volume persistence, graceful stop. This release **does not publish a prebuilt image** — build it yourself with `docker build`.
- **Disconnect recovery and version compatibility checks for browser sessions**: the browser-client → server path gained **disconnect recovery** and **version compatibility checks** — on narrow screens it no longer "connects once, then dies and has to be reopened".
- **The workspace list no longer depends on client settings**: visible workspaces now come from a **server-side registry** as the single source of truth, with the client as a derived view; a workspace that is not running shows an honest **"not started"** state instead of pretending to be ready.
- **PDF generation**: bundled Node payload (PDFKit + FontKit, MIT), **zero external dependencies** — CJK body text, tables, page numbers.
- **Per-tool MCP toggles**: hide a single tool from the model via `disabledTools` in the MCP server config (the settings page has a form for it too).
- **Guided authorization**: a new "send to terminal" action on command blocks — the command lands in **your** terminal and only runs when **you** press Enter.
- **Self-hosted remote-workspace assets**: SSH remote-workspace runtime assets can be assembled locally and verified end to end; the community CDN is wired into the release pipeline, and a **custom CDN hosting address** setting was added (including a base-URL semantics fix: a custom address is used **literally** as the publish root).

## Improvements

- **Narrow-screen phones**: fixed main-content clipping, settings-row misalignment, header overlap, a disconnect overlay that blocked interaction, and the keyboard covering the input; enlarged the composer and sidebar tap areas; status overlays no longer cover the body text; command palette and touch hints are now flush; tool-row expansion is discoverable and readable on touch.
- **Touch reachability**: entries that used to require hover are now reachable on phones ("switch terminal" moved into the ⋯ menu, message actions stay visible on touch, "copy full response" works on mobile web, including the clipboard fallback and a failure message).

## Fixes

- **Crash while a page was loading**: the interface occasionally showed a blank screen or a render error; fixed at the client call-order level.
- **Stuck "reconnecting" after authorization**: the server-restart window was probed only once — one miss meant never retrying.
- **Unauthorized state no longer masquerades as "reconnecting"**: 401 and a dropped connection are now distinguished; the exact `/api` path is inside the auth surface.
- **Any device on the LAN could drive the local workbench without credentials**: the local Web service used to be open by default, so anyone on the same LAN could obtain a credential with **higher** privilege than a normal client. It now listens on loopback only; exposing it to the LAN requires an explicit bind address and a token.
- **False failures in upload self-checks**: network flakiness was reported as a failure, and "object really is not retrievable" was conflated with it; a misconfigured publish root now fails **before** uploading with an actionable error.
- **A packaging defect in the bundled server**: starting the service from an unpacked distribution used to fail with `Dynamic require of "fs" is not supported`; fixed.

## Upgrade notes (behaviour changes)

- **Three new server environment variables** (all optional; defaults sit on the safe side):
  - `ZCODE_SERVER_TRUSTED_ORIGINS`: cross-origin allowlist (comma-separated). Needed **only** when the frontend and backend are not same-origin; **the same-origin check always wins**; leaving it unset rejects cross-origin requests, and registering too much (e.g. a domain you do not control) opens a door for that site; empty/invalid entries are dropped and reported in the startup log. If you access the panel by domain (including behind a proxy), also register `ZCODE_SERVER_TRUSTED_HOSTS` — **two separate defences, both required**.
  - `ZCODE_SERVER_CSP`: default = **report-only** (reports, does not block); `off` = send nothing; `enforce` = actually block. A **misspelled value does not silently become enforce** — it falls back to report-only and says so in the startup log.
  - `ZCODE_SERVER_HSTS`: sent **only over https and only when explicitly enabled**; once sent it **cannot be taken back** (browsers will only use https), which is why it is off by default.
- **Cross-site requests are now rejected (403)**: requests carrying a cross-site `Origin` (including cross-site WebSocket upgrades) are rejected with an `X-ZCode-Cross-Site-Rejected: 1` response header.
- **Behind a reverse proxy you must register your own domain**: a new Host allowlist (by default only loopback and local interface addresses are allowed) closes the DNS-rebinding path. Accessing the panel by a domain that is not listed in `ZCODE_SERVER_TRUSTED_HOSTS` gets **your own domain rejected with 403** and an `X-ZCode-Host-Rejected: 1` header — an easy trap the first time you put a proxy in front of the service. **Register the domain.**
- **Failed authentication is now rate limited**: 10 failed attempts in a row from one source ⇒ a 15-minute ban (returns 403, not 429). The client address is taken from `X-Forwarded-For` only when the request comes from a declared trusted proxy (`ZCODE_SERVER_TRUSTED_PROXIES`); otherwise the connection's own address is used.
- **New audit log**: connection open/close, failed authentication, Host and origin rejections, token reloads, and connection-limit rejections each write one structured line (prefix `audit:`). Tokens, cookies, full query strings, and request bodies are never written.
- **Concurrent connections are capped**: at most 32 WebSocket connections can be active at once; beyond that **new connections are rejected** (existing ones are unaffected).
- **"No Origin ⇒ allow" is a deliberate trade-off**: non-browser clients (curl, scripts, CLI) send no `Origin` and are always allowed. The origin check therefore **does not cover non-browser clients**; DNS rebinding is blocked separately by the Host allowlist (previous item). Conversely, **a manual probe that uses HTTP/1.1 but sends no `Host` at all is rejected** (curl sends one by default, so it is unaffected).
- **The remote-control panel is not the official relay / Bot Channel**: this project ships **no relay** and **no IM bots**; the panel offers only the **self-hosted** "scan the code / open the link on your phone" path.
- **Some entries moved on narrow screens** (e.g. "switch terminal" into the ⋯ menu) — not a removal, but touch reachability.

## Known limitations

- **Platform support (for the headless server distribution: server + bundled Agent runtime + Web static assets): Linux-x64 (glibc) is the supported one.**
  macOS / Windows builds of that distribution are untested and its native payloads are Linux-only, so they are **not promised to work**. The **desktop client and the browser UI are not covered by this platform statement** — the browser UI only needs a browser, so phones and browsers on other systems work too.
- **Alpine / musl is outside the supported set.** Measured behaviour: the service and the panel do run (npm form, with a musl build of **Node >= 24** — on Alpine 3.24 `apk add nodejs` yields 24.18.1, which satisfies it), while the **terminal is unavailable** and is refused with an actionable message instead of crashing.
- **Third-party licence material: some bundled components still lack publisher material** — every such entry is recorded against "**publisher declaration + standard terms + recorded provenance**", and the ones that are not closed are listed honestly in the shipped `THIRD-PARTY-NOTICES.md` and `third-party/README.md` (**being recorded is not a claim that the material is complete**).
  One attribution fix in the same pass: the `google/brotli` decoder vendored inside `brotli` is **Apache-2.0** and had been recorded as MIT; its copyright and licence notice are now included.
- **Remote control (desktop) stops at "start the service + connection info" in this release**: the connected-device list with per-device disconnect, port/listen-scope selection and a token-rotation entry point are **not provided yet** (later batches).
- **The desktop installer therefore grows by about 66 MB** (7.2 MB server entry + 59 MB web UI assets, source maps excluded) — the web UI is what a phone opens after scanning, so it has to ship inside the app.
- **In container form only mounted directories can be managed** (that is the container boundary itself, not a defect): for full host-disk access, run the npm form directly on the host.
- Unchanged from the previous version (unsigned Windows build, no full on-device regression on Windows/macOS, experimental Linux desktop automation, …); this batch adds **no** other long-term limitations.

## Not verified in this release

- **Real-device soft keyboard (IME) not verified**: keyboard-avoidance changes were checked in a controlled environment only.
- **Phone + desktop on the same session at the same time is untested**: both can connect, but concurrent driving of one session is **not tested** — do not rely on it.
- **Browser-level "cross-origin page + cross-origin fetch" not done**: the WS side is covered equivalently (with tests), but a cross-origin page fetching our endpoints has not been measured.
- **No sandbox**: a leaked token (or a bypass of this hardening) means command execution and file access outside the workspace with the service process's privileges (including provider credentials under `~/.zcode/v2`); there is no second boundary beyond the workspace.
- **No token revocation**: the token is a static shared secret with no per-device dimension; rotating it reconnects **every** client (per-device revocation is a later batch).
- **Reverse-proxy configuration not measured**: test the Caddy / nginx snippets in your own certificate environment.
- **"Scanned first, then banned" was not reproduced**: the rate limit was verified under controlled conditions, not against a real internet scan.
- **The two new CI jobs have not run on a real runner**: the headless-server package build/attach job and the remote-asset upload job were verified locally only (the **rest** of the release workflow runs on real runners and is unaffected).
- **WSL as a remote-workspace host is untested**: it needs a Windows client or a `windows-latest` CI runner with WSL2 enabled. **Docker as a host was measured working** (real Docker 29.8.0, rootless, cgroup v2, default container flags, including starting the server inside the container and completing the handshake).
- **On a musl host (e.g. Alpine) the local service works but the terminal does not (measured)**: starting the service, connecting the panel, `/api/server-info` auth and the unauthenticated `/ws` refusal were all measured working; **creating a terminal is refused with an actionable message**.
  That refusal replaces a **process-killing crash**: on musl the native `fork()` segfaults (**exit 139**) and takes the whole process down, and the crash is not catchable — which is why the check runs **before the native module is loaded**, not after the failure.
- **Remote workspaces on a musl target are not usable (measured)**: the payload is a glibc build (`node` fails with `cannot execute: required file not found`, missing `/lib64/ld-linux-x86-64.so.2`), so a connection is **refused before assets are deployed**, with an actionable reason; use a glibc-based image as the remote host.
- **Upstream does not support musl either** (so this is not a choice unique to this build): upstream `node-pty` ships no musl prebuilds, and the official distribution asset set has only a `platformArch` dimension with no `-musl` platform class.
- **The npm form requires Node >= 24**: below that, startup can fail _after_ the banner is printed (Node 20 was measured failing at import time) — check `node --version` first.
- **On Windows, do not use kill -HUP**: token rotation relies on SIGHUP, which Windows does not have — and sending SIGHUP **terminates the process**, so it is not a reload, it is killing your server. On Windows, restart the service after editing the token file.
- **Concurrent writes to one session from a phone and a desktop at the same time have no measurements at all**: the CommandInbox serial admission is a **design convention**, not a verification result for concurrent writes; the connection cap (default 32) only prevents resource exhaustion and must **not** be read as "concurrent writes are protected".

---

<!-- 历史版本（发版时请删除本段及其以下内容） -->

# ZCode-CE v3.14.3-ce.2

## 新增功能

- **Office 文档能力不再依赖系统 Python**。文档生成与结构校验改为随包 Node 载荷，开箱即用；
  此前需要自行安装 Python 3 与相关库，未安装时技能完全不可用。
- **新增「工具与权限」设置页**。可以查看危险命令清单、把某条命令加严为「每次都要确认」，
  或放宽某条命令；也可以关闭「危险命令进入持久授权」，让它们每次都重新确认。

## 体验优化

- **授权弹窗现在显示真实范围**。此前它只显示「前缀」类规则，把「该工具的任意命令」这类规则
  静默省略 —— 你无法从界面上看出自己到底授予了多大范围。现在三种范围都会列出（任意 / 前缀 / 精确）。
  终端界面（TUI）有同一处问题，也已修。
- **Office 技能明确了能力边界**：docx / pptx 为纯生成器，不支持重度编辑既有文档；
  xlsx 可读写，但重写既有工作簿会丢弃图表部件（合并单元格与公式保留）。交付前会如实告知。
- **渲染（转 PDF / 视觉检查）明确为可选增强**。需要 LibreOffice，缺失时会说明「未做视觉检查」
  而不是静默跳过；你仍可用已有的 Word / WPS / Pages 完成同类任务。

## 问题修复

- **修复电脑控制在正式包中完全不可用**。此前驱动载荷在打包时被静默丢弃，首次调用会报
  `Cannot find package '@trycua/cua-driver'`；该文案会误导模型安装不存在的包。
- **修复开发模式下 office 载荷与电脑控制驱动缺失**（`pnpm dev:desktop`）。
- **修复危险命令被记成「整类命令」**。批准一次 `sudo apt install foo` 此前会记住
  「`sudo apt install` 任意包」；现在只记住这一条确切命令。同类问题（`doas`、`pkexec`）一并修复。
- **修复校验器可被小文件耗尽内存**。40 KB 的构造文档可让它占用 4.2 GB 并崩溃、且不输出结果；
  修复后同一文件占用 77 MB。
- **修复空命令导致的权限放大**。`Bash` 收到空命令时，「始终允许本项目」会退化成
  「本项目内任意 Bash 永久免问」，且界面上没有提示。
- **修复校验器误判自己生成的 Word 文档**。用 docx 库产出的 `.docx` 会被校验器判为失败（而 Python 版判通过），原因是它按属性书写顺序解析命名空间，而规范里声明对该元素的所有属性生效、与顺序无关。现已修复，并补齐了同一路径掩盖的两类非法输入检查。
- **修复校验器的 `--out` 参数可覆盖输入文档**（当它指向输入文档的符号链接时）。
- **修复 Excel 流式读取不可用**。读取大型工作簿的流式接口恢复可用。

## 其他变更

- 移除依赖链中**无许可依据**的 `buffers@0.1.1`（npm 无许可声明、包内无 LICENSE、上游仓库已不可访问）。
- 补登三个此前缺失上游许可文本的第三方包。
- **危险命令的持久授权默认关闭**。这是行为变更：此前能被「记住」的危险命令（如 `rm -rf ./build`）
  现在每次都要重新确认。可在「工具与权限」页一键放宽。

## 已知限制

- **电脑控制本次只验证到「枚举应用」（`list_apps`）**，动作类调用（点击、输入）未验证。
- **Office 载荷的验证止于打包链**，未在「安装后的完整包」中做端到端验证。

---

<!-- 以上为 ce.2 发布正文的英文版（发版时随上文一并删除） -->

# 历史版本（ce.2）

## New features

- **Office document capabilities no longer need a system Python.** Document creation and structural
  checks ship a self-contained Node payload and work out of the box. A system Python 3 install used
  to be required, and the skills were unusable without it.
- **New "Tools & permissions" settings page.** Review the dangerous-command list, tighten a command
  to "always ask", relax one, or turn off persistent grants for dangerous commands entirely so they
  are confirmed every time.

## Improvements

- **The approval dialog now shows the real scope.** It used to list only "prefix" rules and silently
  omit rules like "any command of this tool" — you could not tell how far a grant reached. All three
  kinds are now listed (any / prefix / exact). The terminal UI (TUI) had the same problem and is fixed too.
- **Office skills now state their capability boundaries**: docx / pptx are pure generators and do not
  support heavy edits to existing documents; xlsx can read and write, but rewriting an existing
  workbook drops chart parts (merges and formulas are preserved). This is disclosed before delivery.
- **Rendering (PDF / visual checks) is explicitly an optional enhancement.** It needs LibreOffice;
  when absent, the build says visual layout was not inspected rather than silently skipping it.
  You can still use software you already have (Word, WPS, Pages) for the same task.

## Fixes

- **Fixed Computer Use being entirely unavailable in packaged builds.** The driver payload was
  silently dropped during packaging, so the first call failed with
  `Cannot find package '@trycua/cua-driver'` — wording that led the model to install a package that
  does not exist.
- **Fixed missing office payload and Computer Use driver in development mode** (`pnpm dev:desktop`).
- **Fixed dangerous commands being remembered as a whole family.** Approving `sudo apt install foo`
  used to remember "any `sudo apt install`"; it now remembers that exact command only. The same
  problem with `doas` and `pkexec` is fixed as well.
- **Fixed a validator memory exhaustion from small files.** A crafted 40 KB document could make the
  validator consume 4.2 GB and crash without producing output; the same file now uses 77 MB.
- **Fixed a permission escalation via empty commands.** With an empty `Bash` command, "Always allow
  in this project" degraded into "any Bash command in this project, permanently, without asking",
  with no hint in the UI.
- **Fixed the validator rejecting Word documents it produced itself.** A `.docx` written by the docx library was judged as failing (while the Python implementation passed): it parsed namespaces in attribute order, whereas the spec makes a declaration apply to every attribute of that element regardless of order. Fixed, along with two illegal-input checks that the same code path had been masking.
- **Fixed the validator's `--out` overwriting the input document** when it pointed at a symlink to it.
- **Fixed Excel streaming reads being unavailable.** The streaming API for large workbooks works again.

## Other changes

- Removed **`buffers@0.1.1`** from the dependency chain: no license declaration on npm, no LICENSE
  file in the package, and its upstream repository is no longer reachable.
- Added upstream license texts for three third-party packages that were missing them.
- **Persistent grants for dangerous commands are off by default.** This is a behavior change:
  dangerous commands that used to be remembered (such as `rm -rf ./build`) are now confirmed every
  time. It can be relaxed with one click on the "Tools & permissions" page.

## Known limitations

- **Computer Use was verified only up to listing applications (`list_apps`)**; action calls
  (clicks, typing) were not verified.
- **Office payload verification stops at the packaging chain** — no end-to-end check inside a fully
  installed build.
