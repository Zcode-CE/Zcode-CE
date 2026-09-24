# ZCode-CE v3.14.3-ce.3

> 草稿（**未发版**）：本批次内容按"用户能感知的变化"组织；发版前请与提交核对。

## 新增功能

- **无头服务器 + 浏览器面板可以交付了**：新增「无头服务器发行包」——一个自包含的 `zcode` 包（服务端入口 + Agent 运行时 + Web 静态资源 + 启动器）。
  在**没有桌面环境**的机器上跑 `zcode --web`，同一局域网内的手机或另一台电脑用浏览器就能操作这个工作台（含手机窄屏适配）。
  配套给出部署/决策文档与安全文档，并把三条安全不变式**固化进冒烟测试**：`/api/server-info` 无令牌 401 / 带令牌 200、`/ws` 无令牌升级被拒、**非回环 + 无令牌拒绝启动**。
  > 本节指的是"服务 + 浏览器界面"这条路径；**面板的图形界面（桌面入口与面板本身）尚未实现**（进行中）。
- **网页里直接操作工作台（自托管）**：浏览器客户端连服务端进程这条链路补齐了**断线恢复**与**版本配套校验**——手机窄屏下不再"一连就断、断了只能重开"。
- **工作区列表不再由客户端设置决定**：可见工作区改由**服务端注册表**作为唯一真相源，客户端只做派生视图；未启动的工作区有**诚实的"未启动"状态**，不再假装已就绪。
- **PDF 制作能力**：随包 Node 载荷（PDFKit + FontKit，MIT），**零外部依赖**，可生成中文正文、表格与页码。
- **MCP 可以按单个工具启停**：不想让模型看到某个工具，就在 MCP 服务器配置里写 `disabledTools`（设置页也有对应表单）。
- **引导式授权**：命令块新增「发送到终端」——命令进入**你自己的终端**，**由你按回车**才执行，而不是替你在后台跑。
- **远程工作区资产自建**：SSH 远程工作区的运行时资产可本地装配并端到端校验；社区 CDN 接入发布链，并新增「自定义 CDN 托管地址」（含基址语义修正：自定义地址按**字面值**作为发布根）。

## 体验优化

- **手机窄屏（P0 + P1）**：修复主内容区裁切、设置行错位、头部重叠、断线覆盖层挡住交互、键盘避让；扩大输入区与侧栏命中区；状态浮层不再压住正文；命令面板贴边与触屏提示；工具行展开在触屏上有可发现的入口且内容可读。
- **触屏可达性**：补齐原先只有 hover 才能触发的入口（"切换终端"移入 ⋯ 菜单、消息操作在触屏上常显、移动 Web 可用"复制全文"，并覆盖剪贴板回退路径与失败提示）。

## 问题修复

- **加载期渲染崩溃**：三个服务 hook 被无条件调用导致 hook 顺序错位。
- **授权后永久卡在"正在重连"**：服务重启窗口只探测一次，错过一次就永不重试。
- **未授权态不再伪装成"正在重连"**：401 与断线现在如实区分；`/api` 精确路径纳入鉴权面。
- **本地 Web 工作台默认 fail-open**：局域网内可无凭证领到 trusted-host ticket（权限**高于**普通客户端）——已修。
- **上传自检的假失败**：网络抖动误判为失败、以及把"对象确实不可取"当成同一件事；发布根配置写错时改为**上传前**给出可行动的报错。

## 升级须知（行为变化）

- **新增三个服务端环境变量**（都可以不设，默认值在安全侧）：
  - `ZCODE_SERVER_TRUSTED_ORIGINS`：跨源白名单（逗号分隔）。**只**在前端与后端不同源时才需要，**同源判定恒优先于它**；不登记 ⇒ 跨源请求被拒；登记过宽（例如你不控制的域名）⇒ 等于给别的站点开一道门；空项/非法项会被丢弃并在启动日志说明。
  - `ZCODE_SERVER_CSP`：缺省 = **report-only**（只上报、不拦截）；`off` = 完全不发；`enforce` = 真正拦截。**拼错的值不会静默升级成 enforce**，而是回落到 report-only 并在启动日志说明。
  - `ZCODE_SERVER_HSTS`：**只在 https 且显式开启**时才发；一旦下发**无法回撤**（浏览器从此只走 https），因此默认关闭。
- **跨站请求现在会被拒绝（403）**：带跨站 `Origin` 的请求（含跨站 WebSocket 升级）会被拒，并带 `X-ZCode-Cross-Site-Rejected: 1` 响应头。
- **"缺 Origin 就放行"是有意的取舍**：非浏览器客户端（curl、脚本、CLI）不带 `Origin`，一律放行。因此这次加固**不覆盖非浏览器客户端**，也**不覆盖 DNS 重绑定**（**Host 白名单尚未实现**，见反代部署文档）。
- **远控面板不是官方那套 relay / Bot Channel**：本项目**不引入中继**，也不做 IM 机器人；面板只提供"扫码 / 在手机浏览器打开链接"这一条**自托管**路径。
- **手机窄屏上部分入口换了位置**（例如"切换终端"进入 ⋯ 菜单）——不是功能删除，是为触屏可达。

## 未验证项（如实声明）

> 这一节存在的意义：**不让"没验证"被读成"已验证"**。

- **真机软键盘（IME）未验证**：窄屏键盘避让只在受控环境下核对，未在真机 IME 上验证。
- **手机 + 桌面同时连同一会话的并发语义未测**：两端能各自连接，但同一会话被两端同时操作的行为**没有测**，不要依赖。
- **浏览器级"跨源页面 + 跨源 fetch"未做**：WS 侧已有等价覆盖与测试，但"跨源网页用 fetch 打服务"这条路径未实测。
- **没有沙箱**：令牌泄露（或加固被绕过）意味着在宿主上以服务进程权限执行命令、读写工作区外文件（含 `~/.zcode/v2` 里的 provider 凭据）；工作区之外没有第二道边界。
- **Host 白名单尚未实现**：DNS 重绑定仍然可行（Origin 校验挡不住"Origin 与 Host 自洽"的请求）。
- **无令牌吊销**：令牌是静态共享密钥、没有设备维度；轮换令牌会让**所有**已连设备重连（设备级撤销属后续批次）。
- **无速率限制**：本批没有按地址的鉴权失败限流；在加上它之前，面向不可信网络的暴露只能靠令牌长度与网络边界。（限流与"只在可信代理之后才采信 `X-Forwarded-For`"是同一批在途工作，**尚未进入本批**。）
- **反代配置未实测**：文档里的 Caddy / nginx 最小配置需要在你自己有证书的环境里自测。
- **CI 新增的两个 job 未在真实 runner 上跑过**：无头服务器发行包的构建/挂载 job、远程资产上传 job 都只在本地核对（release 流水线**其余** job 长期在真实 runner 上运行，不受这条影响）。
- **Docker / WSL 作为远程工作区承载未实测**（本批只在 Linux 上验证）。
- **本说明不含任何性能数字**：没有实测的性能结论一律不写。
- **平台：正式支持 Linux-x64**。macOS / Windows **未实测**，且当前包内的原生载荷**只含 Linux**（node-pty 等）⇒ **不承诺可用**；终端功能需要对应平台的原生载荷。
- **⚠️ Windows 上不要用 kill -HUP**：令牌轮换依赖 SIGHUP，而 Windows 没有这个信号、**对进程发 SIGHUP 会终止进程** ⇒ 那不是重载令牌，是**把服务杀掉**。Windows 下改完令牌文件请**重启服务**。
- **手机 + 桌面同时操作同一会话的并发写语义没有任何实测**：CommandInbox 的串行 admission 是**设计约定**，不是并发写的验收结论；连接数上限（默认 32）只防资源耗尽，**不要读作「并发写已被保护」**。

## 已知限制

- 与上一版相同（Windows 构建未签名、Windows / macOS 未在真机做完整功能回归、Linux 桌面自动化为实验性等），本批**未新增**长期限制；本批涉及的短期未验证项见上一节的"未验证项"。

# English

# ZCode-CE v3.14.3-ce.3

> Draft (**not released**): organised by changes users can perceive; cross-check with the commit set before tagging.

## New features

- **The headless server + browser panel is now deliverable**: a new "headless server package" — a self-contained `zcode` bundle (server entry + Agent runtime + Web static assets + launcher). Run `zcode --web` on a machine **without a desktop environment**, and a phone or another computer on the same LAN can drive that workbench in a browser (narrow-screen phones included). Deployment/decision docs and a security doc ship with it, and three security invariants are now pinned in the smoke test: `/api/server-info` 401 without a token / 200 with one, unauthenticated `/ws` upgrades rejected, and **non-loopback without a token refuses to start**.
  > This paragraph is about the "service + browser UI" path; the **panel's graphical UI (desktop entry point and the panel itself) is not implemented yet** (in progress).
- **Operate the workbench from a browser (self-hosted)**: the browser-client → server path gained **disconnect recovery** and **version compatibility checks** — on narrow screens it no longer "connects once, then dies and has to be reopened".
- **The workspace list no longer depends on client settings**: visible workspaces now come from a **server-side registry** as the single source of truth, with the client as a derived view; a workspace that is not running shows an honest **"not started"** state instead of pretending to be ready.
- **PDF generation**: bundled Node payload (PDFKit + FontKit, MIT), **zero external dependencies** — CJK body text, tables, page numbers.
- **Per-tool MCP toggles**: hide a single tool from the model via `disabledTools` in the MCP server config (the settings page has a form for it too).
- **Guided authorization**: a new "send to terminal" action on command blocks — the command lands in **your** terminal and only runs when **you** press Enter.
- **Self-hosted remote-workspace assets**: SSH remote-workspace runtime assets can be assembled locally and verified end to end; the community CDN is wired into the release pipeline, and a **custom CDN hosting address** setting was added (including a base-URL semantics fix: a custom address is used **literally** as the publish root).

## Improvements

- **Narrow-screen phones (P0 + P1)**: fixed main-content clipping, settings-row misalignment, header overlap, a disconnect overlay that blocked interaction, and keyboard avoidance; enlarged composer/sidebar hit areas; status overlays no longer cover the body text; command palette edge placement and touch hints; tool-row expansion is now discoverable and readable on touch.
- **Touch reachability**: entries that used to require hover are now reachable on phones ("switch terminal" moved into the ⋯ menu, message actions stay visible on touch, "copy full response" works on mobile web, including the clipboard fallback and a failure message).

## Fixes

- **Render crash during load**: three service hooks were called unconditionally, scrambling hook order.
- **Stuck "reconnecting" after authorization**: the server-restart window was probed only once — one miss meant never retrying.
- **Unauthorized state no longer masquerades as "reconnecting"**: 401 and a dropped connection are now distinguished; the exact `/api` path is inside the auth surface.
- **Local Web workbench defaulted to fail-open**: anyone on the LAN could obtain a trusted-host ticket without credentials (higher privilege than a normal client).
- **False failures in upload self-checks**: network flakiness was reported as a failure, and "object really is not retrievable" was conflated with it; a misconfigured publish root now fails **before** uploading with an actionable error.

## Upgrade notes (behaviour changes)

- **Three new server environment variables** (all optional; defaults sit on the safe side):
  - `ZCODE_SERVER_TRUSTED_ORIGINS`: cross-origin allowlist (comma-separated). Needed **only** when the frontend and backend are not same-origin; **the same-origin check always wins**; leaving it unset rejects cross-origin requests, and registering too much (e.g. a domain you do not control) opens a door for that site; empty/invalid entries are dropped and reported in the startup log.
  - `ZCODE_SERVER_CSP`: default = **report-only** (reports, does not block); `off` = send nothing; `enforce` = actually block. A **misspelled value does not silently become enforce** — it falls back to report-only and says so in the startup log.
  - `ZCODE_SERVER_HSTS`: sent **only over https and only when explicitly enabled**; once sent it **cannot be taken back** (browsers will only use https), which is why it is off by default.
- **Cross-site requests are now rejected (403)**: requests carrying a cross-site `Origin` (including cross-site WebSocket upgrades) are rejected with an `X-ZCode-Cross-Site-Rejected: 1` response header.
- **"No Origin ⇒ allow" is a deliberate trade-off**: non-browser clients (curl, scripts, CLI) send no `Origin` and are always allowed. This hardening therefore **does not cover non-browser clients**, and does **not** cover DNS rebinding (**no Host allowlist yet** — see the reverse-proxy deployment doc).
- **The remote-control panel is not the official relay / Bot Channel**: this project ships **no relay** and **no IM bots**; the panel offers only the **self-hosted** "scan the code / open the link on your phone" path.
- **Some entries moved on narrow screens** (e.g. "switch terminal" into the ⋯ menu) — not a removal, but touch reachability.

## Unverified items (declared as such)

> The point of this section is to **keep "not verified" from being read as "verified"**.

- **Real-device soft keyboard (IME) not verified**: keyboard-avoidance changes were checked in a controlled environment only.
- **Phone + desktop on the same session at the same time is untested**: both can connect, but concurrent driving of one session is **not tested** — do not rely on it.
- **Browser-level "cross-origin page + cross-origin fetch" not done**: the WS side is covered equivalently (with tests), but a cross-origin page fetching our endpoints has not been measured.
- **No sandbox**: a leaked token (or a bypass of this hardening) means command execution and file access outside the workspace with the service process's privileges (including provider credentials under `~/.zcode/v2`); there is no second boundary beyond the workspace.
- **No Host allowlist yet**: DNS rebinding remains possible (the Origin check cannot stop a request whose Origin and Host agree).
- **No token revocation**: the token is a static shared secret with no per-device dimension; rotating it reconnects **every** client (per-device revocation is a later batch).
- **No rate limiting**: this batch ships no per-address throttling for failed authentication; until it lands, exposure to untrusted networks relies on token entropy and the network boundary alone. (Throttling and "trust `X-Forwarded-For` only behind declared proxies" are the same in-flight batch — **not included here**.)
- **Reverse-proxy configuration not measured**: test the Caddy / nginx snippets in your own certificate environment.
- **The two new CI jobs have not run on a real runner**: the headless-server package build/attach job and the remote-asset upload job were verified locally only (the **rest** of the release workflow runs on real runners and is unaffected).
- **Docker / WSL as remote-workspace hosts untested** (this batch was verified on Linux only).
- **No performance numbers are quoted**: nothing without a measurement is written here.
- **Platform: Linux-x64 is the supported one.** macOS / Windows are **not tested**, and the native payloads inside the bundle are **Linux-only** (node-pty and friends), so **do not expect them to work**; the terminal feature needs that platform's native payload.
- **On Windows, do not use kill -HUP**: token rotation relies on SIGHUP, which Windows does not have — and sending SIGHUP **terminates the process**, so it is not a reload, it is killing your server. On Windows, restart the service after editing the token file.
- **Concurrent writes to one session from a phone and a desktop at the same time have no measurements at all**: the CommandInbox serial admission is a **design convention**, not a verification result for concurrent writes; the connection cap (default 32) only prevents resource exhaustion and must **not** be read as "concurrent writes are protected".

## Known limitations

- Unchanged from the previous version (unsigned Windows build, no full on-device regression on Windows/macOS, experimental Linux desktop automation, …); this batch adds **no** new long-term limitations — see "Unverified items" above for this batch's short-term gaps.

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

# English

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
