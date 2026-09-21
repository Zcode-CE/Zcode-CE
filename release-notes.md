# ZCode-CE v3.14.1-ce.1.fix.3

**中文** · [English](#english)

> 承接 `3.14.1-ce.1.fix.2`。本版把「本应可用、却在开源版里被摘掉或卡住的能力」补回来。
> 若你仍在 `3.14.1-ce.1`（界面卡在 logo），请直接升级到本版。

## 本次修复

### 1. 五个内置插件从未随包发出

官方发行包有 **14** 个内置插件，本仓库只发出 **5** 个。其余插件在源码里**声明都在**，包里没有实体 ——
运行时会遍历候选路径全部落空后**静默跳过**，不报错、不警告。本版补入 5 个，现在共 **10** 个：

- **`computer-use`** —— 见下节
- **`zcode-guide`** —— 恢复 `/workflow` 命令与 `dynamic-workflows` 技能，见下节
- **`skill-creator`** —— 让智能体帮你写技能
- **`plugin-creator`** —— 让智能体帮你写插件（工作流改编自 OpenAI Codex，Apache-2.0，已登记归属）
- **`restore-legacy-sessions`** —— 恢复旧版本会话。**默认关闭**，且它会写会话数据库
  （`~/.zcode/v2/tasks-index.sqlite`、`~/.zcode/cli/db/db.sqlite`），只在显式启用并调用时运行

全部按官方发行包逐字节原样搬运（MIT / Apache-2.0），未带官方 `node_modules`。

同时修了一处护栏缺失：`skill-creator` 与 `restore-legacy-sessions` 此前**完全没有声明必需资产**，
少一个文件只会静默降级 —— 现已逐项钉住。

### 2. `/workflow` 命令在本构建里此前从未存在

本仓库为它建好了全套装配 —— 命令面板里专门把它排在 `goal` 之后、灰度开关、运行时包、界面文案 ——
**但内容提供方 `zcode-guide` 插件从未随包发出**。结果是这个命令在我们的构建里从来没有出现过。
本版补入该插件，`/workflow` 与 `dynamic-workflows` 技能恢复。

### 3. 电脑控制：解开 Helper 门控

本构建的三个平台都**没有官方 Helper 实体**（打包配置里没有它，生成它的脚本也不在本仓库）。
而官方原先只在存在私有 Helper 时才向智能体注入 broker 凭据 —— 于是这条能力在本仓库里恒不可用。

本版让开源驱动（`@trycua/cua-driver`，MIT）不再依赖 Helper：无 Helper 实体时直接生成
socket 与 pluginAuthority 凭据，与官方为 macOS 写的懒启动契约同源。

**如实标注的限制**：

- **Windows 未在真机上实测** —— 只做了 CI 打包。驱动的 Windows 预编译产物能否在本机加载未经验证
- **Linux 的 X11 / Wayland 覆盖度仍未验证** —— 鼠标键盘控制与截图可能不可用，设置页按「实验性」标注
- **远端工作区（SSH / WSL / 容器）与 Web 不承载电脑控制** —— 本轮有意不碰

### 4. 文档与许可

- 修正 `NOTICE.md` 中「电脑控制不可用」等已过期陈述，以及 `official-diff.md` 里一处自相矛盾
  （把纯 Markdown 的插件错写成「仅分发编译产物，无源码」）
- 5 个插件的许可与第三方归属登记完成，`licenses:check` 通过

### 5. 仍未补齐的能力（有意不做，不是遗漏）

- `pdf` —— 官方版授权**仅限非商业使用**，不能进入本仓库；需基于开源排版链重新实现，已列入后续路线
- `image-search` —— 能力在官方服务端，需要官方账号鉴权，本地实现无意义
- `android-emulator` / `ios-simulator` —— 官方只分发编译产物，无源码
- 官方 Office 四件套原版 —— 同为「禁止商用」许可；本仓库使用独立 MIT 实现提供同等能力

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

> Follows `3.14.1-ce.1.fix.2`. This release restores capabilities that should have been available
> but were stripped from, or blocked in, the open-source build.
> If you are still on `3.14.1-ce.1` (UI stuck on the logo), upgrade straight to this version.

## Fixes

### 1. Five built-in plugins were never shipped

The official distribution ships **14** built-in plugins; this repository shipped **5**. The rest were
still declared in source but had no package on disk — resolution silently skips them with no error and
no warning. Five are added here, bringing the total to **10**:

- **`computer-use`** — see below
- **`zcode-guide`** — restores the `/workflow` command and the `dynamic-workflows` skill, see below
- **`skill-creator`** — let the agent write skills for you
- **`plugin-creator`** — let the agent write plugins for you (workflow adapted from OpenAI Codex,
  Apache-2.0; attribution registered)
- **`restore-legacy-sessions`** — restore sessions from older versions. **Off by default**, and it
  writes to the session database (`~/.zcode/v2/tasks-index.sqlite`, `~/.zcode/cli/db/db.sqlite`);
  it only runs when explicitly enabled and invoked

All copied byte-for-byte from the official distribution (MIT / Apache-2.0), without the official
`node_modules`.

A missing guardrail was fixed too: `skill-creator` and `restore-legacy-sessions` previously declared
**no required assets at all**, so a missing file degraded silently — each is now pinned.

### 2. The `/workflow` command never existed in this build

This repository has the entire wiring for it — the command palette even pins it right after `goal`,
plus the feature gate, runtime packages and UI copy — **but its content provider, the `zcode-guide`
plugin, was never shipped.** The command had therefore never appeared in our builds. It ships now,
restoring `/workflow` and the `dynamic-workflows` skill.

### 3. Computer Use: the Helper gate is opened

None of the three platforms in this build has an official Helper binary (it is absent from the
packaging config and the script that would produce it is not in this repository). The official code
only injects broker credentials into the agent when a private Helper exists — so this capability was
permanently unavailable here.

This release decouples the open-source driver (`@trycua/cua-driver`, MIT) from the Helper: without a
Helper it mints the socket and pluginAuthority credentials directly, the same lazy-start contract the
official code already uses for macOS.

**Stated plainly:**

- **Windows has not been tested on real hardware** — CI packaging only. Whether the driver's
  prebuilt Windows binary loads on a real machine is unverified
- **Linux X11 / Wayland coverage is still unverified** — mouse/keyboard control and screenshots may
  not work; the settings page labels it experimental
- **Remote workspaces (SSH / WSL / containers) and Web do not carry Computer Use** — deliberately out
  of scope this round

### 4. Docs and licensing

- Corrected stale claims in `NOTICE.md` ("Computer Use is unavailable") and one self-contradiction in
  `official-diff.md` (plugins that are plain Markdown were mis-described as "compiled artifacts only,
  no source")
- License and third-party attribution registered for all five plugins; `licenses:check` passes

### 5. Still missing on purpose (not oversights)

- `pdf` — the official plugin is licensed for **non-commercial use only** and cannot be included here;
  it needs a rewrite on an open-source layout toolchain, now on the roadmap
- `image-search` — the capability lives on official servers and requires official account auth
- `android-emulator` / `ios-simulator` — the official builds ship compiled artifacts without source
- The official Office plugins — also "no commercial use"; equivalent capability is provided by
  independent MIT implementations

## Platforms

| Platform    | Artifacts                     |
| ----------- | ----------------------------- |
| **Linux**   | AppImage / deb / rpm / pacman |
| **Windows** | NSIS (unsigned)               |

**Data directory**: shared with the official ZCode at `~/.zcode/v2`; side-by-side installs are fine,
running both simultaneously is not recommended.
