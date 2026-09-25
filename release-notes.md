> 本次更新按"你能感知到的变化"组织。

## 同步上游

**本版同步的上游版本**：`v3.14.3`（来源：**开源仓库**；依据：**源码比对**）。

| 条目                                                    | 同步情况                                               |
| ------------------------------------------------------- | ------------------------------------------------------ |
| 工作流引擎：续跑确定性修复（重放次序）                  | **已跟进**                                             |
| 工作流卡片：性能与稳定性建模                            | **已跟进**                                             |
| 工作流失败语义：内容拒收可诊断                          | **已跟进**                                             |
| 协议 v4：workflowRuns 扩张（op 5→7、实例上限 256→1024） | **计划下版跟进**（需整体搬运，含配套 golden 测试）     |
| IM 机器人（上游称 Bot Channel）                         | **部分跟进** —— 入站面已实现；桌面端 UI 接线未完成     |
| 云端 relay / 配对服务器 / 移动壳                        | **不适用** —— 上游开源版同样不提供，本项目也不引入中继 |

**一处与上游不同的选择（有意偏离）**：飞书 SDK 钉 `1.74.0`（上游为 `1.64.0`）—— 1.64.0 的两个缺陷正好落在飞书唯一使用的那条长连接路径上（一个会杀掉宿主进程，一个会静默丢事件），两者在 1.74.0 均已修复。

## 新增功能

- **无头服务器 + 浏览器界面**：自包含发行包，在没有桌面环境的机器上跑 `zcode --web`，同一局域网内的手机或另一台电脑用浏览器即可操作该工作台；解包后 `node bin/zcode.mjs --web` 直接起服务。常用参数写入 `~/.zcode/cli/server.json`，`--web --help` 列出全部默认值与旋钮。默认只监听本机；**非回环地址必须带令牌，否则拒绝启动**。
- **桌面端的远程控制入口**：账号区新增入口，从这里启动/停止一个供浏览器访问的服务，并把地址、二维码与链接交给手机或另一台电脑。它**不是**接管桌面端正在开的会话，桌面端已连的远端 SSH / Docker 目标也**不会**共享给浏览器。
- **本地 Docker 资产**：新增 `Dockerfile` 与 `compose.yaml`（glibc 基础镜像、非 root 运行、卷持久化、健康检查），以及一份 Docker 专门文档。本版**不发布预构建镜像**，请自行 `docker build`。
- **npm 包**：本版起发布 `zcode-ce`，`npx zcode-ce --web` 可直接起无头服务。
- **浏览器会话的断线恢复与版本配套校验**：手机窄屏下不再"一连就断、断了只能重开"。
- **工作区列表不再由客户端设置决定**：可见工作区改由**服务端注册表**作为唯一真相源；未启动的工作区有诚实的"未启动"状态，不再假装已就绪。
- **PDF 制作能力**：随包 Node 载荷（PDFKit + FontKit，MIT），**零外部依赖**，可生成中文正文、表格与页码。
- **MCP 可以按单个工具启停**：不想让模型看到某个工具，就在 MCP 服务器配置里写 `disabledTools`（设置页也有对应表单）。
- **引导式授权**：命令块新增「发送到终端」——命令进入**你自己的终端**，**由你按回车**才执行。需要**管理员权限**的命令（装系统依赖、改系统配置、绑特权端口等）会**额外标注**；提权与回车确认都在你的终端里完成，**Agent 拿不到管理员权限，也不会替你输入密码**。
- **远程工作区资产自建**：SSH 远程工作区的运行时资产可本地装配并端到端校验；新增「自定义 CDN 托管地址」。

## 体验优化

- **手机窄屏**：修复主内容区被裁切、设置行错位、头部重叠、断线覆盖层挡住交互、键盘遮挡输入；扩大输入区与侧栏的可点区域。
- **触屏可达性**：补齐原先只有 hover 才能触发的入口（"切换终端"移入 ⋯ 菜单、消息操作在触屏上常显、移动 Web 可用"复制全文"）。

## 问题修复

- **页面加载期崩溃**：打开界面时偶发白屏/渲染报错，已修。
- **授权后永久卡在"正在重连"**：服务重启窗口只探测一次，错过一次就永不重试。
- **未授权态不再伪装成"正在重连"**：401 与断线现在如实区分；`/api` 精确路径纳入鉴权面。
- **局域网内无凭证即可操作本机工作台**：本地 Web 服务此前默认不设防。现在默认只监听本机；要对局域网开放必须显式指定地址并带令牌。
- **上传自检的假失败**：网络抖动误判为失败；发布根配置写错时改为**上传前**给出可行动的报错。
- **发行包内的服务端打包缺陷**：解包后起服务会抛 `Dynamic require of "fs" is not supported`，已修。

## 升级须知（行为变化）

- **新增三个服务端环境变量**（都可选，默认值在安全侧）：
  - `ZCODE_SERVER_TRUSTED_ORIGINS`：跨源白名单（逗号分隔）。**只**在前端与后端不同源时才需要，**同源判定恒优先于它**；不登记 ⇒ 跨源请求被拒。按域名访问（含反代）还需登记 `ZCODE_SERVER_TRUSTED_HOSTS` —— **两道防线，缺一不可**。
  - `ZCODE_SERVER_CSP`：缺省 = **report-only**（只上报、不拦截）；`off` = 完全不发；`enforce` = 真正拦截。拼错的值不会静默升级成 enforce，而是回落到 report-only 并在启动日志说明。
  - `ZCODE_SERVER_HSTS`：**只在 https 且显式开启**时才发；一旦下发**无法回撤**，因此默认关闭。
- **跨站请求现在会被拒绝（403）**：带跨站 `Origin` 的请求（含跨站 WebSocket 升级）会被拒，并带 `X-ZCode-Cross-Site-Rejected: 1` 响应头。
- **反代后面必须登记你自己的域名**：新增 Host 白名单（默认只放行回环与本机网卡地址）。用域名访问却未登记会收到 403 并带 `X-ZCode-Host-Rejected: 1` —— 升级后第一次配反代时容易踩到。
- **鉴权失败开始限流**：同一来源连续 10 次鉴权失败 ⇒ 封禁 15 分钟（返回 403，不是 429）。
- **新增审计日志**：连接建立/断开、鉴权失败、Host 与来源拒绝、令牌重载、并发超限都会写一行结构化日志（`audit:` 前缀）。日志不写令牌、cookie、完整查询串与请求体。
- **并发连接有上限**：同时活跃的 WebSocket 连接最多 32 条，超限时拒绝新连接。
- **回环绑定不再等于可以关令牌**：只要给出"会被外部访问"的信号 —— 登记了可信代理 `ZCODE_SERVER_TRUSTED_PROXIES`，或登记了默认集合之外的主机名 `ZCODE_SERVER_TRUSTED_HOSTS` —— **回环绑定下未配令牌也会拒绝启动**。只登记跨源来源 `ZCODE_SERVER_TRUSTED_ORIGINS` 时只告警、不拒绝启动。
- **分发入口的同一组合在起进程之前就被拒绝**：不会再出现"先看到 running、再被二段错误打断"。
- **"缺 Origin 就放行"是有意的取舍**：非浏览器客户端（curl、脚本、CLI）不带 `Origin`，一律放行。因此来源校验**不覆盖非浏览器客户端**；DNS 重绑定由 Host 白名单单独挡。
- **「Web 控制」与「IM 机器人」是两条不同的路径，不要混为一谈**：「**Web 控制**」用浏览器完整操作这台机器上的工作台，**不经过任何第三方**，默认开启；「**IM 机器人**」需要你自己的外部账号（微信 / 飞书 / Telegram 等）、**数据会经过第三方平台**，因此**默认关闭**。本项目**不引入中继**。
- **手机窄屏上部分入口换了位置**（例如"切换终端"进入 ⋯ 菜单）——不是功能删除，是为触屏可达。

## 已知限制

- **CLI 独立发行包平台支持：正式支持 Linux-x64（glibc）**。该发行包的 macOS / Windows 构建未实测，且包内原生载荷只含 Linux ⇒ **不承诺可用**。
- **Alpine / musl 不在支持范围**：服务与面板**可以运行**（npm 形态，需自带 **Node ≥24** 的 musl 构建），**终端功能不可用** —— 会在创建终端时给出明确提示，而不是崩溃。
- **第三方许可材料：随包通知里仍有部分组件的出版方材料不全** —— 未闭环的条目在随包的 `THIRD-PARTY-NOTICES.md` 与 `third-party/README.md` 里如实列出（**登记了不等于材料齐全**）。
- **远程控制（桌面端）本次只到「开服务 + 连接信息」**：已连设备列表与逐设备断开、端口与监听范围选择、令牌轮换入口**尚未提供**（排后续批次）。
- **桌面端安装包因此增大约 66 MB**。
- **IM 机器人默认关闭，且桌面端 UI 接线本版未完成**：入站面（`/bot/**`）已实现并带独立凭据、独立限流与 fail-closed。启用后消息会经**你选择的那家平台**的服务器，**不经过智谱服务器**。
- **协议 v4 的 workflowRuns 扩张尚未跟进（计划下版）**：跨版本互连时可能表现为「内容被拒收」而非静默错乱。
- **容器形态只能管理挂载进去的目录**（这是容器边界本身）：需要主机全盘访问时，用 npm 形态直接在主机上运行。
- **Docker 镜像约 801 MB**。
- 与上一版相同（Windows 构建未签名、Windows / macOS 未在真机做完整功能回归、Linux 桌面自动化为实验性等），本批**未新增**其他长期限制。

## 本版尚未验证

- **真机软键盘（IME）未验证**：窄屏键盘避让只在受控环境下核对。
- **手机 + 桌面同时连同一会话的并发语义未测**：两端能各自连接，但同一会话被两端同时操作的行为**没有测**，不要依赖。
- **浏览器级"跨源页面 + 跨源 fetch"未做**：WS 侧已有等价覆盖与测试，但"跨源网页用 fetch 打服务"这条路径未实测。
- **没有沙箱**：令牌泄露意味着在宿主上以服务进程权限执行命令、读写工作区外文件（含 `~/.zcode/v2` 里的 provider 凭据）。
- **无令牌吊销**：令牌是静态共享密钥、没有设备维度；轮换令牌会让**所有**已连设备重连。
- **反代配置未实测**：文档里的 Caddy / nginx 最小配置需要在你自己有证书的环境里自测。
- **"先被扫描、再被封"的过程未复现**：限流在受控条件下验证过，但没有在真实公网扫描下跑过。
- **WSL 作为远程工作区承载未实测**：需要 Windows 客户端或 `windows-latest` CI；**Docker 承载已实测通过**。
- **远程工作区在 musl 远端上不可用（实测）**：载荷是 glibc 构建，连接时会**在部署资产之前拦断**并给可操作原因。
- **上游同样不支持 musl**（不是本版独有的取舍）。
- **npm 形态的 Node 下限是 `>=24`**：低于下限时可能在打印启动横幅后才失败，请先用 `node --version` 确认。
- **Windows 上不要用 kill -HUP**：令牌轮换依赖 SIGHUP，而 Windows 没有这个信号、**对进程发 SIGHUP 会终止进程**。Windows 下改完令牌文件请**重启服务**。

---

# English

> This release is organised by the changes you can perceive.

## Upstream sync

**Upstream version synced in this release**: `v3.14.3` (source: **open-source repo**; basis: **source comparison**).

| Item                                                                 | Status                                                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Workflow engine: resume determinism fix (replay order)               | **Synced**                                                                                                     |
| Workflow cards: performance/stability modelling                      | **Synced**                                                                                                     |
| Workflow failure semantics: diagnosable content rejection            | **Synced**                                                                                                     |
| Protocol v4: workflowRuns expansion (5→7 ops, instance cap 256→1024) | **Planned for the next release** (must move as a whole, with matching golden tests)                            |
| IM bots (upstream calls it Bot Channel)                              | **Partially synced** — inbound side implemented; desktop UI wiring not finished                                |
| Cloud relay / pairing server / mobile shell                          | **Not applicable** — the upstream open-source repo does not provide it either, and this project ships no relay |

**One deliberate divergence from upstream**: we pin the Feishu SDK at `1.74.0` (upstream pins `1.64.0`) — two defects in 1.64.0 sit exactly on the only long-connection path Feishu uses (one kills the host process, one silently drops events); both are fixed in 1.74.0.

## New features

- **Headless server + browser UI**: a self-contained distribution; run `zcode --web` on a machine without a desktop environment and a phone or another computer on the same LAN can drive that workbench in a browser. After unpacking, `node bin/zcode.mjs --web` starts the service directly. Frequently used options can be written to `~/.zcode/cli/server.json`, and `--web --help` lists every default and knob. It listens on loopback by default; a **non-loopback bind without a token refuses to start**.
- **Remote control entry point on the desktop**: a new entry in the account area starts/stops a **service that browsers can reach**, and hands out the address, QR code and link to a phone or another computer. It does **not** take over sessions already open on the desktop, and remote SSH / Docker targets connected from the desktop are **not** shared with the browser.
- **Local Docker assets**: a `Dockerfile` and `compose.yaml` (glibc base image, non-root, volume persistence, health check) plus a dedicated Docker document. This release **does not publish a prebuilt image** — build it yourself with `docker build`.
- **npm package**: starting with this release we publish `zcode-ce`; `npx zcode-ce --web` starts the headless service directly.
- **Disconnect recovery and version compatibility checks for browser sessions**: on narrow screens it no longer "connects once, then dies and has to be reopened".
- **The workspace list no longer depends on client settings**: visible workspaces now come from a **server-side registry** as the single source of truth; a workspace that is not running shows an honest **"not started"** state instead of pretending to be ready.
- **PDF generation**: bundled Node payload (PDFKit + FontKit, MIT), **zero external dependencies** — CJK body text, tables, page numbers.
- **Per-tool MCP toggles**: hide a single tool from the model via `disabledTools` in the MCP server config (the settings page has a form for it too).
- **Guided authorization**: a new "send to terminal" action on command blocks — the command lands in **your own** terminal and only runs when **you** press Enter. Commands that need **administrator rights** (installing system dependencies, changing system configuration, binding privileged ports) are **additionally labelled**; the elevation and the Enter press both happen in your terminal, so the **agent never gains administrator rights and never types your password**.
- **Self-hosted remote-workspace assets**: SSH remote-workspace runtime assets can be assembled locally and verified end to end; a **custom CDN hosting address** setting was added.

## Improvements

- **Narrow-screen phones**: fixed main-content clipping, settings-row misalignment, header overlap, a disconnect overlay that blocked interaction, and the keyboard covering the input; enlarged the composer and sidebar tap areas.
- **Touch reachability**: entries that used to require hover are now reachable on phones ("switch terminal" moved into the ⋯ menu, message actions stay visible on touch, "copy full response" works on mobile web).

## Fixes

- **Crash while a page was loading**: the interface occasionally showed a blank screen or a render error; fixed.
- **Stuck "reconnecting" after authorization**: the server-restart window was probed only once — one miss meant never retrying.
- **Unauthorized state no longer masquerades as "reconnecting"**: 401 and a dropped connection are now distinguished; the exact `/api` path is inside the auth surface.
- **Any device on the LAN could drive the local workbench without credentials**: the local Web service used to be open by default. It now listens on loopback only; exposing it to the LAN requires an explicit bind address and a token.
- **False failures in upload self-checks**: network flakiness was reported as a failure; a misconfigured publish root now fails **before** uploading with an actionable error.
- **A packaging defect in the bundled server**: starting the service from an unpacked distribution used to fail with `Dynamic require of "fs" is not supported`; fixed.

## Upgrade notes (behaviour changes)

- **Three new server environment variables** (all optional; defaults sit on the safe side):
  - `ZCODE_SERVER_TRUSTED_ORIGINS`: cross-origin allowlist (comma-separated). Needed **only** when the frontend and backend are not same-origin; **the same-origin check always wins**; leaving it unset rejects cross-origin requests. If you access the panel by domain (including behind a proxy), also register `ZCODE_SERVER_TRUSTED_HOSTS` — **two separate defences, both required**.
  - `ZCODE_SERVER_CSP`: default = **report-only** (reports, does not block); `off` = send nothing; `enforce` = actually block. A misspelled value does not silently become enforce — it falls back to report-only and says so in the startup log.
  - `ZCODE_SERVER_HSTS`: sent **only over https and only when explicitly enabled**; once sent it **cannot be taken back**, which is why it is off by default.
- **Cross-site requests are now rejected (403)**: requests carrying a cross-site `Origin` (including cross-site WebSocket upgrades) are rejected with an `X-ZCode-Cross-Site-Rejected: 1` response header.
- **Behind a reverse proxy you must register your own domain**: a new Host allowlist (by default only loopback and local interface addresses are allowed). Accessing the panel by a domain that is not listed gets **your own domain rejected with 403** and an `X-ZCode-Host-Rejected: 1` header — an easy trap the first time you put a proxy in front of the service.
- **Failed authentication is now rate limited**: 10 failed attempts in a row from one source ⇒ a 15-minute ban (returns 403, not 429).
- **New audit log**: connection open/close, failed authentication, Host and origin rejections, token reloads, and connection-limit rejections each write one structured line (prefix `audit:`). Tokens, cookies, full query strings, and request bodies are never written.
- **Concurrent connections are capped**: at most 32 WebSocket connections can be active at once; beyond that new connections are rejected.
- **A loopback bind no longer means you can turn the token off**: as soon as you give a "this will be reachable from outside" signal — a registered trusted proxy (`ZCODE_SERVER_TRUSTED_PROXIES`) or a registered hostname outside the default set (`ZCODE_SERVER_TRUSTED_HOSTS`) — a **loopback bind without a token also refuses to start**. Registering only cross-origin sources (`ZCODE_SERVER_TRUSTED_ORIGINS`) warns but does not refuse to start.
- **The distribution entry point refuses the same combinations before starting the process**: you no longer see "running" followed by a second-stage failure.
- **"No Origin ⇒ allow" is a deliberate trade-off**: non-browser clients (curl, scripts, CLI) send no `Origin` and are always allowed. The origin check therefore **does not cover non-browser clients**; DNS rebinding is blocked separately by the Host allowlist.
- **"Web control" and "IM bot" are two different paths — do not conflate them**: **Web control** drives the workbench in full from a browser, goes through **no third party**, and is on by default. An **IM bot** needs your own external account (WeChat / Feishu / Telegram, …) and **your data passes through a third-party platform**, so it is **off by default**. This project ships **no relay**.
- **Some entries moved on narrow screens** (e.g. "switch terminal" into the ⋯ menu) — not a removal, but touch reachability.

## Known limitations

- **Platform support for the standalone CLI distribution: Linux-x64 (glibc).** macOS / Windows builds of that distribution are untested and its native payloads are Linux-only, so they are **not promised to work**.
- **Alpine / musl is outside the supported set**: the service and the panel do run (npm form, with a musl build of **Node >= 24**), while the **terminal is unavailable** and is refused with an actionable message instead of crashing.
- **Third-party licence material: some bundled components still lack publisher material** — the ones that are not closed are listed honestly in the shipped `THIRD-PARTY-NOTICES.md` and `third-party/README.md` (**being recorded is not a claim that the material is complete**).
- **Remote control (desktop) stops at "start the service + connection info" in this release**: the connected-device list with per-device disconnect, port/listen-scope selection and a token-rotation entry point are **not provided yet** (later batches).
- **The desktop installer therefore grows by about 66 MB**.
- **IM bots are off by default and the desktop UI wiring is not finished in this release**: the inbound side (`/bot/**`) is implemented with its own credential, its own throttle and fail-closed behaviour. Once enabled, messages pass through **the platform you chose**, **not through Zhipu's servers**.
- **Protocol v4 workflowRuns expansion is not synced yet (planned for the next release)**: cross-version interop may surface as "content rejected" rather than silent corruption.
- **In container form only mounted directories can be managed** (that is the container boundary itself): for full host-disk access, run the npm form directly on the host.
- **The Docker image is about 801 MB**.
- Unchanged from the previous version (unsigned Windows build, no full on-device regression on Windows/macOS, experimental Linux desktop automation, …); this batch adds **no** other long-term limitations.

## Not verified in this release

- **Real-device soft keyboard (IME) not verified**: keyboard-avoidance changes were checked in a controlled environment only.
- **Phone + desktop on the same session at the same time is untested**: both can connect, but concurrent driving of one session is **not tested** — do not rely on it.
- **Browser-level "cross-origin page + cross-origin fetch" not done**: the WS side is covered equivalently (with tests), but a cross-origin page fetching our endpoints has not been measured.
- **No sandbox**: a leaked token means command execution and file access outside the workspace with the service process's privileges (including provider credentials under `~/.zcode/v2`).
- **No token revocation**: the token is a static shared secret with no per-device dimension; rotating it reconnects **every** client.
- **Reverse-proxy configuration not measured**: test the Caddy / nginx snippets in your own certificate environment.
- **"Scanned first, then banned" was not reproduced**: the rate limit was verified under controlled conditions, not against a real internet scan.
- **WSL as a remote-workspace host is untested**: it needs a Windows client or a `windows-latest` CI runner with WSL2 enabled. **Docker as a host was measured working**.
- **Remote workspaces on a musl target are not usable (measured)**: the payload is a glibc build, so a connection is **refused before assets are deployed**, with an actionable reason.
- **Upstream does not support musl either** (so this is not a choice unique to this build).
- **The npm form requires Node >= 24**: below that, startup can fail _after_ the banner is printed — check `node --version` first.
- **On Windows, do not use kill -HUP**: token rotation relies on SIGHUP, which Windows does not have — and sending SIGHUP **terminates the process**. On Windows, restart the service after editing the token file.

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
