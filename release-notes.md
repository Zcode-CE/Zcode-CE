# ZCode-CE

> **热修复版本。** 修复 `3.16.3-ce.1` 安装包启动后窗口空白的问题：Windows 上显示为纯黑窗口，Linux 与 macOS 上显示为空白窗口。
> **正在使用 `3.16.3-ce.1` 的用户请升级到本版本。**

## 问题修复

- **安装包启动后界面空白 / 黑屏**：`3.16.3-ce.1` 的 Windows、Linux、macOS 安装包都会在启动后停在空白窗口，进不到界面。原因是打包时界面初始化脚本需要的运行时依赖没有随安装包一起打入，脚本加载失败后界面没有挂载。本版把这部分依赖重新打进安装包，窗口可以正常打开。`3.15.1-ce.1` 及更早版本没有这个问题。

## 升级须知（行为变化）

- **`3.16.3-ce.1` 的三个平台安装包都受影响**：Linux、Windows、macOS 请升级到本版本；更早的版本不受此问题影响，不必为此升级。
- **窗口空白时应用内更新用不了**：界面打不开，「检查更新」也无法操作。请从本页下载对应平台的安装包，覆盖安装即可。
- **数据不会丢**：覆盖安装保留数据目录（`~/.zcode/v2`）中的会话与设置。
- **功能与 `3.16.3-ce.1` 相同**：本版只改启动链路，没有新增或改变任何功能。
- **发布前会先启动一次安装包**：从本版起，Linux 安装包在发布前会先启动并确认界面已加载，坏包不会进入发布；Windows 与 macOS 的安装包仍没有启动检查（见下节）。

## 本版尚未验证

- **Windows / macOS 安装包的启动没有实测**：发布前的自动启动检查只覆盖 Linux 安装包。修复改的是三个平台共用的同一份打包内容，但这两个平台的安装包仍需要在真机上确认。若升级后仍是空白窗口，请在 issue 中反馈并附上系统版本与截图。
- **界面没有逐项点检**：本版没有在真实桌面会话里逐项操作界面入口。本版不带新功能，受影响的界面范围与 `3.16.3-ce.1` 相同。

---

# English

> **Hotfix release.** Fixes a startup defect in the `3.16.3-ce.1` installers where the window stays blank: a solid black window on Windows, an empty window on Linux and macOS.
> **If you are on `3.16.3-ce.1`, upgrade to this release.**

## Fixes

- **Blank or black window after launch**: the Windows, Linux and macOS installers of `3.16.3-ce.1` all stopped at a blank window, so the interface could not be reached. A runtime dependency used by the window bootstrap script was not packaged with the installers, the script failed to load and the interface was never mounted. This release packages that dependency again and the window opens normally. Versions up to `3.15.1-ce.1` do not have this problem.

## Upgrade notes (behavior changes)

- **All three platform installers of `3.16.3-ce.1` are affected**: upgrade on Linux, Windows and macOS. Earlier versions are not affected and do not need an upgrade for this reason.
- **In-app updates are unusable while the window is blank**: with no interface you cannot reach "Check for updates". Download the installer for your platform from this page and install it over the existing one.
- **Your data is kept**: reinstalling keeps the sessions and settings in the data directory (`~/.zcode/v2`).
- **Same features as `3.16.3-ce.1`**: this release changes the startup path only; no feature is added or changed.
- **The installer is launched once before release**: starting with this release, the Linux installer is launched and checked for a mounted interface before publishing, so a broken package cannot be released. The Windows and macOS installers still have no startup check (see below).

## Not verified in this release

- **Startup of the Windows and macOS installers was not tested**: the automatic startup check only covers the Linux installer. The fix changes the same packaged contents for all three platforms, but these two installers still need a real-machine check. If you still get a blank window after upgrading, please report it in an issue with your OS version and a screenshot.
- **The interface was not checked item by item**: no real desktop session was used to click through the interface for this release. This release adds no features, so the affected surface is the same as `3.16.3-ce.1`.
