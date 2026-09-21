# ZCode-CE v3.14.1-ce.1.fix.2

**中文** · [English](#english)

> 承接 `3.14.1-ce.1.fix.1` 的启动修复，本版处理三处用户反馈的问题。
> 若你仍在 `3.14.1-ce.1`（界面卡在 logo），请直接升级到本版。

## 本次修复

### 1. 模型拉取对话框：模型一多就选不了、也加不了

对话框容器是 grid，而内部按 flex 写的滚动区在 grid 里**不生效** ——
列表没有高度约束就撑破 `max-height`，被 `overflow: hidden` 裁掉，底部「添加」按钮也被顶出可视区。

- 改为 flex 列布局：固定头 / 固定搜索框 / 可滚动列表 / 固定底部按钮
- **顶部新增搜索框**，模型多时可直接筛选
- 搜索只影响「看得见什么」，不影响「选中了什么」：勾选跨筛选保留，可先筛一批勾一批再一次提交
- 「全选」只作用于当前筛选下可见的项，无筛选时与改前一致

### 2. 电脑控制在 Linux 上打不开

Linux 上只显示「当前环境暂不支持电脑控制」。排查后发现能力其实齐备，是**四道授权门控**全部只按 macOS/Windows 建模：

- 可用性判定把 Linux 判为不支持
- 设置分区只认 macOS/Windows 工作区
- 插件页在 Linux 显示「不可用」卡片
- **「电脑控制」整个设置分区被硬编码隐藏 —— 这一条在所有平台都生效，Windows 同样打不开**

四条已全部处理。Linux 现在可按「实验性支持」启用：

- 驱动（开源实现 trycua/cua）已随包发出，打包期有 `assertPackagedCuaDriver` 硬校验把关
- **但后端在 X11 / Wayland 下的覆盖度尚未全面验证**，鼠标键盘控制与截图可能不可用 ——
  这一点已在设置页里如实标注，而不是承诺可用

### 3. 「反馈与诊断」页重排

- 布局：诊断信息、反馈渠道、预填内容等原被挤在固定宽度的窄列里（预填预览每行十来个字就换行），现改为整行宽度
- 删掉三行纯说明文字（附件、作用范围、遥测状态）—— 它们不是设置项
- 「生成日志包」与「下载日志」实际是两条日志打包路径、用户分不出来，合并为一个「下载日志」，
  并保留原来那份有用的反馈（导出后显示产物路径 + 「在文件管理器中显示」）
- 「本构建不含任何后台上报通道」移到 **关于 ZCode** 对话框，作为一句事实陈述

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

> Follows the startup fix in `3.14.1-ce.1.fix.1`. This release addresses three reported issues.
> If you are still on `3.14.1-ce.1` (UI stuck on the logo), upgrade straight to this version.

## Fixes

### 1. Model fetch dialog: with many models you could neither select nor add

The dialog container is a grid, so the scrolling area written with flex semantics had no effect —
the list had no height constraint, overflowed `max-height`, was clipped by `overflow: hidden`,
and the Add button was pushed out of view.

- Now a flex column: fixed header / fixed search / scrollable list / pinned footer
- **New search box at the top** to filter models
- Search only changes what is _visible_, not what is _selected_ — selections survive filter changes
- Select all applies to the currently visible items only; without a filter it behaves as before

### 2. Computer Use could not be opened on Linux

Linux only showed Computer Use as unavailable. Four separate gates all assumed macOS/Windows only,
including one that **hid the entire Computer Use settings section on every platform — Windows included**.
All four are addressed. Linux can now be enabled as an **experimental** feature:

- The driver (open-source trycua/cua) ships with the app, guarded by a hard `assertPackagedCuaDriver` check at package time
- **Its X11 / Wayland coverage has not been fully verified**, so mouse/keyboard control and screenshots may not work.
  This is stated plainly in the settings UI rather than promised.

### 3. Feedback & Diagnostics page reworked

- Layout: rows were squeezed into a fixed narrow column; block content now spans the full width
- Three purely explanatory rows removed (attachments, scope, telemetry status) — they were not settings
- Build log zip and Download logs were two packaging paths users could not tell apart; merged into one
  **Download logs**, keeping the useful part (showing the output path + Show in folder)
- This build contains no background reporting channel — moved into the **About ZCode** dialog

## Platforms

| Platform    | Artifacts                     |
| ----------- | ----------------------------- |
| **Linux**   | AppImage / deb / rpm / pacman |
| **Windows** | NSIS (unsigned)               |

**Data directory**: shared with the official ZCode at `~/.zcode/v2`; side-by-side installs are fine,
running both simultaneously is not recommended.
