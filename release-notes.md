# ZCode-CE 3.16.3-ce.1

## 与官方版本的关系

本版版本号对齐官方闭源 **3.16.3**（3.16.3 未开源）；代码以开源 **3.16.2**（`3c5b2276`）为基线逐特性移植（未搬项见台账）。闭源 3.16.3 的签名器与验证码机制只做核对，未引入不可分发的能力。逐条同步状态见仓库的 `docs/development/upstream-sync.md`。

## 新增功能

- **工具搜索（按需加载工具定义）**：设置 →「工具与权限」新增「工具搜索」，可选自动 / 原生 / 本地 / 关闭四种模式（默认关闭，保持旧行为）。开启后模型只先看到工具名，需要时再加载完整定义，减少长会话的上下文占用；关闭时与之前完全一致。
- **工作区附加目录**：设置 →「工作区附加目录」可为当前项目添加多个额外文件夹（支持一次多选、批量添加）。新建会话时这些目录会一起进入模型的可见范围与技能/命令发现；由调度、机器人或闲时任务创建的会话也会带上。改动只对之后新建的会话生效，已运行的会话不受影响。
- **工作区显示名称与主根**：设置里可以给项目起一个本机显示名称，侧栏、文件树、归档列表与命令中心都会使用它；同时只读展示「主根（执行根）」，明确会话、命令与 Git 从哪里执行。显示名只影响本机展示，不改变路径或身份。
- **图片预览操作**：右侧预览的图片现在支持「添加到聊天」「下载图片」「复制图片」。添加到聊天只把文件引用加入当前输入框，不自动发送；下载保存原始字节（SVG 仍是 SVG，不会变成截图）；复制把图片以 PNG 写入系统剪贴板。桌面可用右键菜单，窄屏使用「图片操作」菜单。
- **归档列表按项目分组**：归档任务按工作区分组展示，组头显示条数与折叠开关；折叠状态会在本机记住。只有一个工作区时保持原来的平铺形态。
- **侧边面板全视图**：面板右上角新增「全视图」按钮，也可按 `Ctrl+Shift+F`（macOS `⌘⇧F`）把右侧面板铺满内容区；再次触发、关闭面板或切换任务都会退出并恢复原布局。本版的全视图**不包含浮动输入窗**。
- **Windows 任务栏未读角标**：Windows 上任务栏图标会显示未读红点，未读数通过辅助技术可读的描述提供；macOS / Linux 继续使用系统角标计数。
- **安全验证（3007）可重试**：遇到「需要完成安全验证」的失败时，界面会给出明确的「重试验证」入口，不再只显示一条无法继续的错误。

## 体验优化

- 设置页的附加目录支持一次选择多个文件夹，不再需要重复点「添加」。
- 命令中心的工作区结果使用你设置的显示名称，和侧栏、文件树保持一致。
- 归档分组折叠后，重连或重新打开侧栏仍保持折叠。
- 对话框标题、错误页、入门页与价格卡等界面文字统一到设计系统的字号刻度，视觉层级更一致。
- 模型不可用时，发送会在输入被接收之前给出明确失败，不再出现「点了发送但没有任何反应」。

## 问题修复

- **长会话压缩后仍可能无响应**：上下文压缩判断哪些旧工具结果可以清理时，现在会读取工具结果的权威名称；投影后只剩调用 ID 的结果也能被正确识别与清理。
- **模型不可用时的输入丢失**：模型选择在服务端目录中不存在时，会在确认接收输入之前拒绝，并提示具体缺失的 provider/model，而不是先接收再在后台失败。
- **插件设置里的英文界面显示中文**：插件管理产生的「请先打开一个工作区」等提示改走本地化文案，中英文界面一致。
- **大量界面文字直接显示键名**：补齐了组件在用但字典缺失的 90 个文案键，并加了全仓字面量键护栏，避免再次出现界面上显示 `bots.xxx` 这类键名。
- **术语不统一**：面向用户的实体统一称为「项目」，「工作区」只保留在文件系统、目录、路径与远程工作区等技术语境。

## 本版尚未验证

- 本版的界面目视与点击交互没有在真实桌面会话中逐项执行；发布前建议在一台有显示环境的机器上过一遍新增入口。
- Windows / macOS 安装包由 CI 产出，本轮没有在对应平台做启动冒烟。
- 工具搜索的「原生」模式依赖真实 provider 网关行为，本轮没有凭据做端到端验证。
- 图片复制/下载的系统剪贴板、原生另存为与手机触屏菜单未在真实平台执行。
- Windows 任务栏未读角标未在 Windows 真机验证。
- 加速卡（Highspeed）的抽卡与到期退回不在本版范围：本仓库只有相关契约与视觉件，没有抽卡服务与运行时。

---

# English

## Relationship to the official release

This release uses the version number of official closed-source **3.16.3** (3.16.3 is not open-source). The code is a per-feature port on top of open-source **3.16.2** (`3c5b2276`); unported items are tracked in the ledger. The closed-source 3.16.3 signer and captcha mechanisms were reviewed but no non-distributable capability was added. Per-item status is in `docs/development/upstream-sync.md`.

## New features

- **Tool search (load tool definitions on demand)**: Settings → Tool policy now offers a Tool search mode — auto / native / local / off (off by default, preserving the previous behavior). When enabled, the model initially sees tool names only and loads full definitions when needed, reducing context usage in long sessions; off is byte-for-byte the old behavior.
- **Additional workspace directories**: Settings → Workspace additional directories lets you add extra folders to the current project (multi-select and batch add are supported). New sessions include them in the model's visible scope and in skill/command discovery; sessions created by schedules, bots, or off-peak tasks also carry them. Changes apply to sessions created afterwards.
- **Workspace display name and primary root**: you can give a project a local display name; the sidebar, file tree, archive list and command center use it. A read-only "Primary root" row shows where sessions, commands and Git run. The display name is presentation-only and does not change paths or identity.
- **Image preview actions**: images in the right-hand preview now support "Add to chat", "Download image" and "Copy image". Add to chat only inserts a file reference into the current composer (it does not send); download saves the original bytes (SVG stays SVG, not a screenshot); copy writes the image as PNG to the system clipboard. Right-click works on desktop, and narrow screens get an "Image actions" menu.
- **Archived tasks grouped by project**: archived tasks are grouped by workspace, with per-group counts and a collapse toggle; the collapsed state is remembered locally. With a single workspace the original flat list is kept.
- **Side pane full view**: a "Full view" button in the side pane header (also `Ctrl+Shift+F`, macOS `⌘⇧F`) expands the pane over the content area; triggering it again, closing the pane or switching tasks exits and restores the previous layout. This version's full view **does not include the floating composer**.
- **Windows taskbar unread badge**: on Windows the taskbar icon shows an unread dot, with the count exposed to assistive technologies; macOS / Linux keep using the system badge count.
- **Security verification (3007) can be retried**: when a turn fails because a security verification is required, the UI now offers an explicit retry entry instead of a dead-end error.

## UX improvements

- Additional directories support selecting several folders at once.
- The command center uses your workspace display name, matching the sidebar and file tree.
- Archive group collapse state survives reconnects and reopening the sidebar.
- Dialog titles, error pages, onboarding and price cards now use the design system's type scale consistently.
- When the selected model is unavailable, sending fails clearly before the input is accepted instead of appearing to do nothing.

## Fixes

- **Long sessions could still hang after compaction**: deciding which old tool results can be cleared now reads the authoritative tool name, so results whose projection only kept the call ID are recognized and cleared.
- **Input loss when a model is unavailable**: a model missing from the provider catalog is rejected before the input is accepted, with the missing provider/model named, instead of failing silently in the background.
- **Chinese copy in the English plugin settings**: plugin-management errors such as "open a workspace first" now go through localization.
- **Raw message keys shown in the UI**: 90 keys used by components but missing from the dictionaries were added, with a repository-wide guard against literal keys.
- **Inconsistent terminology**: the user-facing entity is now consistently called a "project"; "workspace" is kept only for filesystem, directory, path and remote-workspace contexts.

## Not verified in this release

- Visual and click-through checks were not performed in a real desktop session; review the new entries on a machine with a display before publishing.
- Windows / macOS installers are produced by CI and were not smoke-tested on those platforms this round.
- Tool search's "native" mode depends on real provider gateway behavior and was not end-to-end tested (no credentials).
- System clipboard, native save dialogs and the mobile touch menu were not exercised on real platforms.
- The Windows taskbar unread badge was not checked on real Windows.
- Highspeed card draw and expiry fallback are out of scope: this repository has the contract and visual pieces only, not the draw service or runtime.
