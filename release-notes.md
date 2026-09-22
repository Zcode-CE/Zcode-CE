# ZCode-CE v3.14.3-ce.1

**中文** · [English](#english)

> 本版跟进官方 v3.14.3，并把 `/workflow` 从插件形态升格为内置能力（与官方同构）。
> 承接 `3.14.1-ce.1.fix.3` 的插件恢复与电脑控制修复。
> 若你仍在 `3.14.1-ce.1`（界面卡在 logo），请直接升级到本版。

## 本次变更

### 1. `/workflow` 升格为内置能力（跟进官方架构）

官方在 v3.14.3 做了一次架构调整：把 `dynamic-workflows` 技能从 `zcode-guide` 插件里迁出，成为**内置技能包（bundled skills）** —— 不进插件商店、不可卸载、无开关、不出现在设置与 `$` 选择器中。

理由是产品性的：动态工作流的工具由运行时注册，教模型怎么用它的技能就必须同样不可移除。

本版照此重构：

- 新增 `bundled-skills` 包，由运行时在每次启动时按 `source: "bundled"` / `scope: "system"` 发现
- `zcode-guide` 对齐官方 **0.3.0**（移除 `commands/workflow.md` 与 `skills/dynamic-workflows/`）
- `/workflow` 改为 CLI 内置命令，**不再依赖任何插件是否存在**

这对你意味着：**上一版里 `/workflow` 依赖 zcode-guide 插件，本版它始终可用。**

### 2. 电脑控制：bridge 不可用时的指引（修复模型自行装错包）

有用户反馈模型调用电脑控制时报「找不到驱动包」。排查后确认**不是构建缺陷** —— 而是：

- 电脑控制**默认关闭**，此时运行时不注册 CUA bridge；
- 但 `node_repl` 工具因浏览器能力仍可用，模型于是**自行猜测驱动包名并尝试安装**，连猜两次都不存在。

本版在四个层面加了指引（模型必经路径）：

- **工具描述按会话解析**：未启用时直接写明「本会话没有电脑控制、没有东西需要安装、不要装或猜驱动包」（MCP 集成只消费 `tools/list`，不读 server instructions，所以必须挂在这里）
- 技能正文与文档补「禁止自行安装/猜测驱动」的硬约束与三步处置
- bridge 缺失的报错改成可操作文案：告知用户在 **设置 → 电脑控制** 开启，然后停止

这是**软约束**（靠文案劝阻）。模型仍具备执行安装命令的能力，若后续仍出现问题，我们会考虑在权限层加一次确认。

### 3. 内置技能包与插件资产的许可登记

- `bundled-skills`、`zcode-guide` 0.3.0 均已登记（MIT / © Z.ai）
- 电脑控制的插件资产**有本地修改**（就是上面第 2 点的指引），已如实登记为 `locallyModifiedFiles`，差异文档同步说明
- `licenses:check` 通过

### 4. 文档

修正多处随版本演进而过期的陈述，包括「与上游基线逐字节一致」（本版起已不成立）、插件文件计数、`/workflow` 的来源说明等。

## 与官方 v3.14.3 的关系

**本版对齐官方的架构与版本号，但能力实现不同。** 主要差异：

- **电脑控制**：官方使用私有 Helper 二进制；本版使用 MIT 许可的开源驱动（trycua/cua）
- **Office 三件套**：官方版授权禁止商业使用；本版为独立 MIT 实现
- **未提供**：PDF（官方版禁商用，计划复用开源方案）、图片搜索（需官方账号鉴权）、Android/iOS 模拟器（官方仅发编译产物）

完整清单见[与官方发行版的差异](https://github.com/Zcode-CE/Zcode-CE/blob/main/docs/development/official-diff.md)。

## 如实标注的未验证范围

- **Windows 未在真机实测** —— 仅经 CI 打包。驱动的 Windows 预编译产物能否加载未经验证
- **Linux 的 X11 / Wayland 覆盖度未验证** —— 鼠标键盘与截图可能不可用，设置页标为实验性
- **远端工作区（SSH / WSL / 容器）与 Web 不承载电脑控制**

## 平台

| 平台        | 产物                          |
| ----------- | ----------------------------- |
| **Linux**   | AppImage / deb / rpm / pacman |
| **Windows** | NSIS（当前未签名）            |

**数据目录**：与官方 ZCode 共享 `~/.zcode/v2`，可并存安装但不建议同时运行。

## 文档

- [与官方发行版的差异](https://github.com/Zcode-CE/Zcode-CE/blob/main/docs/development/official-diff.md)
- [发布与版本号规则](https://github.com/Zcode-CE/Zcode-CE/blob/main/docs/operations/release.md)

---

# English

> This release follows official v3.14.3 and promotes `/workflow` from a plugin to a built-in capability,
> matching the official architecture. It continues the plugin restoration and Computer Use fix from
> `3.14.1-ce.1.fix.3`.
> If you are still on `3.14.1-ce.1` (UI stuck on the logo), upgrade straight to this version.

## Changes

### 1. `/workflow` becomes a built-in capability (following the official architecture)

In v3.14.3 the official build moved the `dynamic-workflows` skill out of the `zcode-guide` plugin and made
it a **bundled skill** — not in the plugin store, not uninstallable, no toggle, invisible in Settings and
the `$` skill picker. The reasoning is product-level: the dynamic-workflow tools are registered by the
runtime, so the skill that teaches the model to use them must be equally unremovable.

This release mirrors that:

- New `bundled-skills` pack, discovered at startup as `source: "bundled"` / `scope: "system"`
- `zcode-guide` aligned to official **0.3.0** (drops `commands/workflow.md` and `skills/dynamic-workflows/`)
- `/workflow` is now a CLI built-in command, **no longer depending on any plugin**

For you this means: in the previous release `/workflow` required the zcode-guide plugin; now it is always
available.

### 2. Computer Use: guidance when the bridge is unavailable (fixes the model installing the wrong package)

A user reported that the model tried to load a driver package that could not be found. Investigation showed
**this was not a packaging defect**:

- Computer Use is **off by default**, so the runtime does not register the CUA bridge;
- but `node_repl` remains available because of the browser capability, so the model **guessed a driver
  package name and tried to install it** — twice, neither existing.

This release adds guidance on four layers, all on paths the model must traverse:

- **Tool description resolved per session**: when disabled it states plainly that this session has no
  Computer Use, that there is nothing to install, and not to install or guess a driver package (the MCP
  integration only consumes `tools/list` and does not read server instructions, so this is where it has
  to live)
- Skill body and docs gain a hard constraint against self-installing or guessing drivers, plus a
  three-step disposition
- The bridge-missing error now tells the user to enable it in **Settings → Computer Use**, then stops

This is a **soft constraint** (persuasion via copy). The model can still run install commands; if the
problem recurs we will consider a confirmation at the permission layer.

### 3. Licensing for the bundled skill pack and plugin assets

- `bundled-skills` and `zcode-guide` 0.3.0 are registered (MIT / © Z.ai)
- The Computer Use plugin assets now carry **local modifications** (the guidance above), truthfully
  registered as `locallyModifiedFiles`, with the diff documented
- `licenses:check` passes

### 4. Documentation

Corrected several statements that had gone stale as versions advanced, including "byte-identical to the
upstream baseline" (no longer true as of this release), plugin file counts, and the origin of `/workflow`.

## Relationship to official v3.14.3

**This release follows the official architecture and version number, but not its capability
implementations:**

- **Computer Use**: the official build uses a private Helper binary; this build uses the MIT-licensed
  open-source driver (trycua/cua)
- **Office trio**: the official plugins are licensed for non-commercial use only; these are independent
  MIT implementations
- **Not provided**: PDF (official is non-commercial; an open-source route is planned), image search
  (requires official account auth), Android/iOS emulators (official ships compiled artifacts only)

See the full [diff against the official distribution](https://github.com/Zcode-CE/Zcode-CE/blob/main/docs/development/official-diff.md).

## Stated plainly: what is not verified

- **Windows has not been tested on real hardware** — CI packaging only. Whether the driver's prebuilt
  Windows binary loads on a real machine is unverified
- **Linux X11 / Wayland coverage is unverified** — mouse/keyboard control and screenshots may not work;
  the settings page labels it experimental
- **Remote workspaces (SSH / WSL / containers) and Web do not carry Computer Use**

## Platforms

| Platform    | Artifacts                     |
| ----------- | ----------------------------- |
| **Linux**   | AppImage / deb / rpm / pacman |
| **Windows** | NSIS (unsigned)               |

**Data directory**: shared with the official ZCode at `~/.zcode/v2`; side-by-side installs are fine,
running both simultaneously is not recommended.
