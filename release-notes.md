# ZCode-CE v3.14.3-ce.4

## 新增功能

- **远程控制面板可以看到「谁连着」并逐台断开**：面板现在列出已连接的设备（地址、客户端、连接时间、角色），可以断开单台或全部断开。此前只能看到访问地址与二维码，没有任何办法知道有谁连进来、也没法单独踢掉某一台。
- **面板内可以轮换访问令牌**：此前令牌只能通过改启动参数或删令牌文件再发信号来更换。现在桌面端面板里可以直接轮换，轮换后旧令牌立即失效。**已连接的设备不会因此断开**，需要的话请配合「全部断开」使用。
- **监听范围与端口可在面板内选择**：可以选择「仅本机」或「本机所在的局域网」，端口可自动选空闲端口或指定。对局域网开放前会先确认一次，并可一键切回「仅本机」。
- **入口会显示「等待连接」**：远程控制入口现在有三种状态 —— 未开启、等待连接（服务已启动但还没有设备连上）、运行中。此前只有两种。
- **Office 文档可以自动做视觉检查了**：docx / pptx / xlsx 交付前可以渲染成页图并检查版面（断行、裁切、表格宽度、图表标签等）。此前技能里写的是「本版本没有渲染工具」，直接把转出的 PDF 交给用户自己看。渲染需要系统已安装 LibreOffice，缺失时会如实说明未做该项检查。
- **CI 增加 macOS 与 Windows 的构建与启动检查**：这两个平台的「能构建 / 能启动 / 能连面板」此前只有推断，现在由流水线实测（每日与手动触发）。**首次实测结果：macOS 通过；Windows 在构建步骤失败（已修，见「问题修复」），修复后尚未重跑。**

## 体验优化

- **工作流大量子代理时不再丢实例**：单条工作流可容纳的子代理与节点上限从 256 提升到 1024，并且超出上限的实例现在会被计数并在界面上如实显示，而不是静默消失。此前一个 3000 路并发的运行在界面上会显示成「1024 步」，是一句假话。
- **工作流状态推送的流量与改动量成正比**：此前每有一条引擎事件就要把整张状态表重发一遍，一条长运行的开销随规模平方增长。现在只发送变化的部分。
- **Office 数据类任务不再多一句无用提示**：xlsx 的数据与公式任务此前会无条件附带一句「未做视觉检查」，现在这类任务不再提示；只有排版类任务才做视觉检查。

## 问题修复

- **修复子会话的上下文顺序颠倒**：当目标会话已有自己的历史消息时，被复制的转录内容会被追加到这些历史之后，导致模型看到的上下文前后颠倒，而且没有任何报错或日志。现在这种情况会跳过复制而不是写坏顺序。
- **修复跨站防护误伤普通读取请求**：此前来自其他站点的普通 GET 请求会被拒绝（403），而设计上读请求不在防护范围内。这是过严而非过松，没有安全影响，但会让跨源部署的读接口不可用。
- **修复 Office 视觉评审无法调用**：技能里让模型调用的评审代理名缺少插件前缀，在默认安装下会因重名而调用失败。四个办公插件现在都使用带前缀的名称。
- **修复 PDF 插件的同一处评审调用**：同上。
- **许可材料登记与实际不符**：图形驱动包实际声明的是「MIT 与 MPL-2.0 双许可」，登记表此前只记了 MIT，把 MPL 的义务漏掉了。现已按实际声明登记，并随包分发 MPL-2.0 全文。

## 升级须知（行为变化）

- **工作流实例上限提升会改变对旧客户端的推送**：上限提升后，超过旧上限（256）的状态在推送给**旧版本客户端**时会先被裁剪到旧上限。因此用旧版本客户端连接新版本主机时，界面上看到的工作流条目可能少于主机实际持有的。升级客户端即可看到完整内容。
- **Office 视觉检查现在可能主动调用外部渲染器**：仅在用户要求视觉检查、且系统已安装 LibreOffice 时才会执行。没有安装时行为与之前一致（如实说明未做）。

## 已知限制

- **令牌轮换不会断开已连接的设备**：轮换只让旧令牌失效，已经建立的连接会继续工作。要立即断开需要另外执行「全部断开」。
- **Windows 的构建检查修复后尚未重跑**：首次实测暴露的 `spawnSync pnpm ENOENT` 已修，但「修完是否真的转绿」要等下一次实测，本版未观测到。macOS 已实测通过。

## 本版尚未验证

- **远程控制面板的界面未经真实 Electron 窗口查看**：相关逻辑有测试覆盖（含跨端真实服务端联调与反向验证），但未在真实桌面窗口里完整走一遍。
- **触屏下的入口显示未在真机验证**：只有源码级与 DOM 级断言。
- **Office 视觉检查的端到端未由真实模型执行**：技能文本与渲染链路均已实测，但「模型按技能指示去调用」这一步没有真实会话验证。
- **Windows 在 CI 上尚未跑通**：首次实测（Linux ✅ / macOS ✅ / Windows ❌）已定位到构建脚本在 Windows 上找不到包管理器并修复，但修复后的重跑尚未进行 —— 因此「Windows 能构建、能启动、能连面板」三列仍不能读作已通过。

# English

## New features

- **The remote control panel now shows who is connected, and can disconnect them**: the panel lists connected devices (address, client, connect time, role) and can disconnect one or all of them. Previously it showed only the access address and a QR code, with no way to tell who was connected or to drop a single device.
- **The access token can be rotated from the panel**: previously this required changing launch parameters, or editing the token file and signalling the process. The desktop panel can now rotate it directly, and the old token stops working immediately. **Already-connected devices are not disconnected by a rotation** - pair it with "disconnect all" if that is what you want.
- **Listen scope and port are selectable in the panel**: choose "this machine only" or "the local network", with an automatic free port or a specific one. Opening to the local network asks for confirmation first, and one click returns to "this machine only".
- **The entry point shows a "waiting for connection" state**: the remote control entry now has three states - off, waiting for a connection (service running, no device connected yet), and running. Previously there were two.
- **Office documents can be visually checked automatically**: docx / pptx / xlsx can be rendered to page images and inspected for layout (line breaks, clipping, table widths, chart labels) before delivery. The skills previously said "this build has no rendering tool" and handed the converted PDF to the user. Rendering needs LibreOffice installed; when it is missing the check is reported as not performed.
- **CI now builds and starts on macOS and Windows**: those two platforms' "builds / starts / can reach the panel" were previously inferred; a pipeline now measures them (daily and on demand). **It had not run on real runners at release time** - see "Not verified in this release".

## Improvements

- **Large workflows no longer silently drop instances**: the per-run ceiling for subagents and nodes rose from 256 to 1024, and instances beyond the ceiling are now counted and shown honestly instead of disappearing. A 3000-way run used to display as "1024 steps", which was untrue.
- **Workflow state updates now scale with the change, not the state**: previously every engine event resent the whole state table, making a long run quadratic. Only the changed part is sent now.
- **Office data tasks no longer carry a useless caveat**: xlsx data and formula tasks used to state "visual layout was not inspected" unconditionally; they no longer do. Only layout tasks get a visual check.

## Fixes

- **Fixed reversed context order in sub-sessions**: when the target session already had its own history, copied transcript content was appended after it, so the model saw the context in the wrong order - with no error and no log. That case now skips the copy instead of writing a bad order.
- **Fixed cross-site protection rejecting ordinary reads**: ordinary GET requests from another site were rejected (403), while reads are outside the protected surface by design. This was over-strict rather than permissive, with no security impact, but it made cross-origin read endpoints unusable.
- **Fixed the Office visual reviewer being uncallable**: the agent name used in the skills lacked its plugin prefix, so it failed on a default install because the name was ambiguous. All four Office plugins now use the prefixed name.
- **Fixed the same reviewer call in the PDF plugin.**
- **Licence material registration did not match the artifact**: the graphics driver packages actually declare "MIT and MPL-2.0", while the registry recorded only MIT, hiding the MPL obligation. It now matches the actual declaration, and the MPL-2.0 text ships with the notices.

## Upgrade notes (behaviour changes)

- **The raised workflow ceiling changes what old clients receive**: state beyond the old ceiling (256) is trimmed before being sent to **older clients**. A newer host with an older client may therefore show fewer workflow entries than the host holds. Upgrading the client shows the full content.
- **Office visual checks may now invoke an external renderer**: only when the user asks for a visual check and LibreOffice is installed. Without it, behaviour is unchanged (the check is reported as not performed).

## Known limitations

- **Rotating the token does not disconnect connected devices**: rotation only invalidates the old token; established connections keep working. Use "disconnect all" to drop them immediately.
- **The macOS and Windows build checks have not run on real runners yet**: the pipelines are new in this release but had not been executed at release time, so measured results for those platforms are still pending.

## Not verified in this release

- **The remote control panel has not been viewed in a real Electron window**: the logic is covered by tests (including cross-end integration against a real server, with negative verification), but a full walkthrough in a real desktop window was not performed.
- **The entry point on touch devices was not verified on a real device**: only source-level and DOM-level assertions.
- **The Office visual check was not executed end to end by a real model**: the skill text and the rendering chain are both measured, but "the model follows the skill and calls it" was not verified in a real session.
- **The three-platform CI workflow has not run on real runners**: Windows is expected to fail (the build script invokes the package manager in a way that does not work on Windows), and the real result had not been observed at release time.
