# ZCode-CE v3.14.3-ce.3.fix.2

## 问题修复

- **会话列表与工作区统一由服务端管理**：侧栏现在列出服务端记录的全部工作区（三端一致），而不是各设备自己的记录。此前换一台设备或换一个浏览器打开，看到的可能是另一份列表。
- **每个工作区可以直接看到会话**：此前新列出的工作区只显示目录路径、展开后是空的；现在展开即可看到该工作区的会话标题。
- **点击工作区不再「消失」**：此前点开一个只显示路径的工作区，它会从列表里消失（被并入了本机记录）。现在点击只切换视图，列表内容不变。
- **会话数不再虚报**：此前有 24 个工作区显示「已有 N 个会话」但点开是空的（那些会话已归档）。现在显示的数字与展开后能看到的条数一致。
- **去掉行上的「未启动」标记**：此前几乎所有工作区都带这个标记，而它并不携带信息 —— 绝大多数工作区本来就没在运行。现在只有真正在运行的工作区显示运行标识（圆圈），需要启动时展开行内仍有「打开并启动」。
- **Start Plan 渠道的验证链路恢复可用**：上一版补齐了该链路，但一个跨进程调用的错误导致界面报「这块界面出了点问题」，使修复实际未生效。现已修正。
- **IM 机器人的失败提示可操作**：该渠道需要人工完成安全校验，机器人无法完成；此前会把机器码直接丢给用户，现在给出明确指引。
- **IM 机器人页签不再显示无效按钮**：此前该页签的「启用」按钮点了没有反应（功能尚未接入宿主）。现在不具备条件时不显示该页签，而不是给一个无响应的按钮。

## 本版尚未验证

- **浏览器界面的求解流程与分页观感未做真机验证**：相关逻辑有测试覆盖（含反向验证），但未在真实浏览器里完整走通。

# English

## Fixes

- **Sessions and workspaces are now managed server-side**: the sidebar lists every workspace the server knows about, consistently across clients. Previously a different device or browser could show a different list.
- **Each workspace now shows its sessions directly**: newly listed workspaces used to show only a directory path and expand to nothing; expanding now reveals that workspace's session titles.
- **Clicking a workspace no longer makes it disappear**: opening a path-only workspace used to remove it from the list (it got merged into local records). Clicking now only switches the view.
- **Session counts are no longer inflated**: 24 workspaces used to claim "N sessions" while expanding showed nothing (those sessions were archived). The number now matches what you can actually see.
- **Removed the per-row "not started" badge**: almost every workspace carried it while conveying nothing - most workspaces simply are not running. Only genuinely running workspaces now show the running indicator (a dot), and the in-row "open and start" action remains available when you need it.
- **The Start Plan verification chain actually works now**: the previous release added the chain, but a cross-process call error surfaced as "something went wrong in this area", so the fix never took effect. That is corrected.
- **Actionable failure messages for IM bots**: this channel requires a human to complete a security check that a bot cannot; the raw machine code used to be shown to users, and a clear instruction is given instead.
- **The IM bot tab no longer shows a dead button**: its "enable" button did nothing because the feature was never wired to a host. The tab is now hidden when unavailable rather than offering an unresponsive button.

## Not verified in this release

- **The browser-side solving flow and pagination appearance have not been verified on a real browser**: the logic is covered by tests (including negative verification), but a full walkthrough in a real browser was not performed.
