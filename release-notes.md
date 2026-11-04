# ZCode-CE 3.17.2-ce.1

## 与官方版本的关系

本版对齐官方开源 **3.17.2**（`a9fe401e`，2026-11-03 发布）。官方闭源 3.17.2 只做机制核对（签名器、验证码链、内置配置下发的形状），**没有引入任何不可分发的能力**。逐条同步状态见 `docs/development/upstream-sync.md` 的 v3.17.2 节。

## 新增功能

- **远程常驻会话**：远端主机装有无头服务器 `zcode-server` 时，远程工作区会优先走常驻 daemon —— 断网、关窗、断连都不会结束远端会话。重连后自动接回（host 换连接句柄 → 主进程重建通道 → 界面换代服务），失败时明确提示「需重新加载工作区」，不会假装已恢复。没装 `zcode-server` 的远端行为完全不变。
- **工作区管理**：设置 →「工作区」新增统一入口，可查看本机记住过的全部工作区、编辑显示名、按最近使用/名称/会话数排序；每行提供「从列表移除」（保留数据）与「删除并清理数据」（不可恢复，需输入名称确认，运行中的工作区会被拒绝）。
- **MCP 工作区信任**：项目里声明的 MCP 服务器默认**不再自动信任并连接**；未信任的服务器在设置页与工作区内提示条里显示，由你决定是否信任。未知、陈旧或损坏的信任记录一律按未信任处理。
- **图片预览标注**：预览图片时可标注（画笔、形状、文字等），标注结果可保存并作为附件发进对话。
- **未读任务筛选**：侧栏视图新增「按未读」，只列出有未读的任务；退出视图即回到原偏好。
- **打开方式**：文件卡片与预览面板的下拉菜单会列出系统关联应用（含默认应用标记），可直接用指定应用打开；平台不支持时整组不出现。
- **在文件管理器中定位**：文件树右键与预览面板新增「在文件管理器中打开」，会选中文件本身（macOS Finder / Windows 资源管理器 / WSL 走对应路径）。
- **预览卡片整卡点击**：点击卡片任意位置即可打开预览，右侧按钮仍保持独立。
- **帮助菜单复制设备号**：账号菜单可直接复制设备号，方便反馈问题。

## 安全

- **计划模式不再放行高风险操作**：此前「计划模式 + 自主模式」的组合下，命中危险命令规则的工具可能免确认执行；现在计划模式会补做单次确认，且非只读的 MCP 工具不再被直接放行。
- **自定义命令的脚本改为经权限确认**：命令里的 `!` shell 块不再在解析阶段直接执行，而是交给模型经 Bash 工具走审批。
- **子代理权限不宽于父会话**：计划模式下探索型子代理不再被提升为完全放行，恢复子会话也不再沿用落盘的旧模式。

## 问题修复

- **配置文件损坏不再被覆盖**：`config.json` 的多处写入方改为「严格读取 → 写前重读 → 原子替换」，损坏的文件会保留备份而不是被默认值整份覆盖；`setting.json` 校验失败同样改为隔离备份，不再静默重置全部偏好。
- **长对话流式回复卡顿**明显减少（渲染分区与历史段缓存）。
- **产物卡片偶尔不刷新**：对陈旧修订号会按最新状态重查。
- **远程订阅迟到不再打死 Host**：RPC 订阅失败改为回一帧错误而不是让进程退出。
- **内容安全拦截快速报错**：被安全策略拦截的空回复不再反复重试。
- **大于 15MB 的归档不再卡住渲染进程**（RPC 二进制载荷）。
- **Windows 窗口被其他程序遮挡后恢复正常显示**；**macOS 应用图标空白**修复；**macOS 安装包补回中英文语言资源**。
- **发布链两段化**：安装包在启动冒烟通过后才发布，冒烟失败不会再在 Release 上留下资产。

## 变更

- **远程资产 CDN 换到新域名**：`https://cdn.wsdaxl.tech`（与旧域名指向同一个存储桶，内容一致）。已安装的旧版本继续使用旧域名，无需任何操作。

## 本版尚未验证

- Windows / macOS 安装包的启动与界面交互没有在真机逐项执行；本版的平台相关修复（遮挡重绘、图标、语言包）只在 Linux 上做了类型与构建验证。
- 远程常驻会话的真机验证只覆盖 SSH（自建 sshd + 真 daemon：断连后 daemon 存活、重连回同一代）；**WSL / Docker 未验证**（会零变化回退到原链路）。
- 工作区删除的确认框、图片标注、未读视图、打开方式菜单未在真实桌面会话里逐项点检（web 端已目视核过工作区列表与删除确认框）。
- 真实 provider 网关的端到端行为（工具搜索的原生模式等）没有凭据验证。

---

# English

ZCode-CE 3.17.2-ce.1 aligns with the upstream open-source **3.17.2** (`a9fe401e`). Highlights:

- **Persistent remote sessions**: when the remote host has `zcode-server` installed, remote workspaces run against a resident daemon — disconnects no longer end the remote session, and reconnects re-attach automatically (falling back to an explicit "reload workspace" prompt when the daemon restarted). Remotes without `zcode-server` behave exactly as before.
- **Workspace management**: a unified settings page to rename, sort, remove from list (keeps data) or delete with data cleanup (irreversible, requires typing the name; running workspaces are refused).
- **MCP workspace trust**: MCP servers declared inside a project are no longer trusted and connected automatically; unknown/stale/corrupt trust records are treated as untrusted.
- **Image annotation**, **unread-only sidebar view**, **open with…**, **reveal in file manager**, **whole-card preview click**, **copy device id**.
- **Security**: plan mode no longer lets dangerous-command rules skip confirmation; custom-command shell blocks now go through Bash approval; subagent permissions can no longer exceed the parent session.
- **Fixes**: corrupted config files are no longer overwritten (quarantined instead), streaming jank in long conversations, stale preview cards, late RPC subscriptions no longer kill the host, content-filtered replies fail fast, >15MB archives no longer stall the renderer, Windows occlusion repaint, macOS icon/locale assets, two-phase release publishing.
- **Change**: remote asset CDN moved to `https://cdn.wsdaxl.tech` (same bucket as before; existing installs keep using the old domain and need no action).

Not verified in this release: Windows/macOS installer startup and UI interaction, WSL/Docker for the persistent-session path, and real provider gateway behavior.
