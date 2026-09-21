# ZCode-CE

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode-CE" width="128" height="128" />
</div>
<p align="center">
  <a href="https://github.com/Zcode-CE/Zcode-CE/issues">问题反馈</a> ·
  <a href="https://github.com/Zcode-CE/Zcode-CE/discussions">讨论区</a> ·
  <a href="https://github.com/zai-org/ZCode">上游项目</a>
</p>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

ZCode-CE 是 AI 编程工作台 **ZCode 的开源社区版**，提供桌面应用、浏览器界面和终端 Agent。本仓库包含客户端、后端服务、共享 UI，以及 Agent CLI 与运行时源码。

## 关于本项目

ZCode-CE 基于 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）构建，面向希望**完全掌控自己开发环境**的用户。**欢迎社区成员参与建设** —— 无论是功能开发、问题反馈还是文档改进。

我们与官方发行版的差异目前集中在五个方面：

| 方面             | 说明                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **无遥测**       | 移除官方发行版中的遥测与监控组件。仅使用自带 API 时，不产生任何与官方服务相关的后台上报                                                                                  |
| **保留权益**     | 官方服务权益（套餐额度、限时赠送额度）完整保留。客户端已具备领取与计费所需的全部能力                                                                                     |
| **社区反馈**     | 反馈默认走本项目的 GitHub Issues，不经过官方工单系统。渠道可在设置中修改或关闭                                                                                           |
| **开源文档能力** | Office 文档能力（Word / PowerPoint / Excel）由 MIT 许可的开源实现提供，不依赖官方闭源插件                                                                                |
| **桌面自动化**   | Computer Use 由 MIT 许可的开源实现（[trycua/cua](https://github.com/trycua/cua)）提供，不依赖官方未标注许可的闭源 helper。**Windows 正式支持；Linux 实验性**（默认关闭） |

### 我们不是什么

- **不是官方发行版**。ZCode-CE 由社区维护，不代表 Z.ai 或智谱的官方立场。
- **不提供账号服务**。模型访问、套餐与计费仍由官方服务提供，本项目不代理、不转售。
- **Computer Use 的平台支持有差异**。Windows 为正式支持；**Linux 为实验性**（默认关闭，需在设置中开启）。官方发行版不支持 Linux 桌面自动化，本版通过开源实现提供，但受上游验证范围限制：已在 X11 / Sway / KDE Wayland 验证，**Wayland 下截图不可用**（元素操作不受影响），GNOME 未完整验证。详见[桌面自动化文档](docs/development/computer-use.md)。

## 安装

从 [Releases](https://github.com/Zcode-CE/Zcode-CE/releases) 下载对应平台的安装包。

| 平台        | 格式                                           | 说明                                                                          |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| **Windows** | `.exe`（NSIS）                                 | 直接运行安装。当前**未签名**，首次运行需在 SmartScreen 提示中选择「仍要运行」 |
| **Linux**   | `.AppImage` / `.deb` / `.rpm` / `.pkg.tar.zst` | AppImage 需先 `chmod +x` 再运行                                               |

**数据目录**：与官方 ZCode 共享 `~/.zcode/v2`，两者**可并存安装**（安装身份独立），但**不建议同时运行**。

> **关于 Windows 签名**：官方发行版使用 DigiCert 签发的组织验证（OV）证书签名。本项目作为社区项目无法申请同类证书，正在申请 [SignPath Foundation](https://signpath.org/) 的免费开源代码签名（证书签发给 SignPath Foundation，非本项目），通过后将消除 SmartScreen 提示。

想从源码构建或参与开发？见下方[初始化](#初始化)与[开发与运行](#开发与运行)。

## 入口

| 入口                 | 用途                                                           | 开发命令                       |
| -------------------- | -------------------------------------------------------------- | ------------------------------ |
| Desktop              | Electron 桌面应用                                              | `pnpm dev:desktop`             |
| Web / ZCode 命令行版 | 终端与浏览器工作台；将 TUI、Web、后端和 Agent 组装为独立运行包 | `pnpm dev:web`                 |
| Agent CLI            | 在终端中使用 `zcode`，也为 Desktop 和 Web 提供 Agent 运行时    | `pnpm --filter @zcode/cli dev` |

## 初始化

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下开发和打包命令均在仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备桌面本地运行资源，再执行 `build:bootstrap`。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，作为普通目录随本仓库一起克隆，无需单独拉取或初始化 Git submodule。

根据需要选择其他初始化或构建入口：

| 命令                           | 用途                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `pnpm install`                 | 安装依赖                                                          |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源，默认包含远程资源准备                            |
| `pnpm prepare:remote-assets`   | 单独准备远程运行资源                                              |
| `pnpm bootstrap:with-remote`   | 初始化依赖、本地与远程资源，并串行构建相关包；跳过桌面应用 bundle |
| `pnpm build`                   | 递归执行各 workspace 包的构建脚本，包括包内的资源准备步骤         |

默认 `bootstrap` 跳过远程资源准备，适合本地桌面开发。使用远程工作区或验证远程发行资源时，再运行对应准备命令。

## 开发与运行

### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test
```

`pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`，使用生产服务配置。启动脚本会准备本地运行资源、构建桌面 Agent，再启动 Electron 和源码监听。

需要独立开发数据目录时，可设置 `ZCODE_DATA_BASE_DIR`。例如在 macOS / Linux 中：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test
```

### Web 开发

```bash
pnpm dev:web
```

该命令同时启动 Web 开发服务器和后端；浏览器访问前者。

## 验证

| 用途       | 命令                                |
| ---------- | ----------------------------------- |
| 类型检查   | `pnpm typecheck`                    |
| Lint       | `pnpm lint`                         |
| 测试       | `pnpm test`                         |
| 架构检查   | `pnpm architecture:check --changed` |
| 提交前检查 | `pnpm verify:pre-push`              |

改动桌面端 main/renderer 时，额外运行 `bash scripts/desktop-typecheck-baseline.sh diff` —— `pnpm typecheck` 的工程列表不覆盖这两个子工程。

## 数据与配置

| 路径                           | 内容                       |
| ------------------------------ | -------------------------- |
| `~/.zcode/v2/`                 | 会话、凭据、任务索引、设置 |
| `~/.config/ZCode-CE/`（Linux） | Electron 运行时状态        |

ZCode-CE 与官方 ZCode 使用**独立的安装身份**，可以并存。两者共享 `~/.zcode/v2/` 数据目录，因此不建议同时运行并写入同一工作区。

## 文档

开发者文档见 [docs/](docs/)：

- [架构与模块边界](docs/development/architecture.md)
- [与上游的差异](docs/development/upstream-diff.md)
- [本地开发](docs/development/local-setup.md)
- [遥测与隐私](docs/development/telemetry.md)
- [贡献指南](docs/community/contributing.md)
- [发布流程](docs/operations/release.md)

## 开源参考与致谢

ZCode-CE 站在许多开源项目的肩膀上。以下按用途分类列出我们复用或参考的项目。

### 复用的代码组件

这些项目的代码被直接引入本仓库，完整清单与许可快照见 [third-party/copied-components.json](third-party/copied-components.json)。

| 项目                                                                                                                | 许可       | 用途                                                       |
| ------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------- |
| [zai-org/ZCode](https://github.com/zai-org/ZCode)                                                                   | Apache-2.0 | 本仓库的上游                                               |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)                                     | MIT        | Office 文档能力（`skill-office`）；Computer Use 的架构参考 |
| [vercel/ai-elements](https://github.com/vercel/ai-elements)                                                         | Apache-2.0 | AI 对话界面组件                                            |
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui)                                                                     | MIT        | UI 基础组件                                                |
| [microsoft/vscode](https://github.com/microsoft/vscode)                                                             | MIT        | 编辑器相关实现                                             |
| [withfig/autocomplete](https://github.com/withfig/autocomplete)                                                     | MIT        | 命令补全数据                                               |
| [material-extensions/vscode-material-icon-theme](https://github.com/material-extensions/vscode-material-icon-theme) | MIT        | 文件图标主题                                               |
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)                                           | Apache-2.0 | 浏览器自动化                                               |
| [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills)                                             | MIT        | Agent 技能定义                                             |
| [obra/superpowers](https://github.com/obra/superpowers)                                                             | MIT        | Agent 技能实现                                             |

### 运行时依赖

| 项目                                        | 许可          | 用途                                            |
| ------------------------------------------- | ------------- | ----------------------------------------------- |
| [trycua/cua](https://github.com/trycua/cua) | MIT / MPL-2.0 | Computer Use 的桌面驱动（`@trycua/cua-driver`） |

完整的 npm 依赖许可清单见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

### 设计参考

以下项目未复用代码，但其设计与接口约定对本项目的实现有重要参考价值。

| 项目                                                 | 参考内容                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| [zcode-api](https://github.com/LX2000WASD/zcode-api) | 官方服务接口的协议还原，用于权益能力（套餐额度、领取、计费）的实现                |
| [openai/codex](https://github.com/openai/codex)      | Computer Use 的应用级访问控制设计                                                 |
| [trycua/cua](https://github.com/trycua/cua)          | 平台行为台账与安全语义（`possibly_sent` 防重放、`controller lease`、kill switch） |

### 第三方服务

模型访问、套餐与计费由 [Z.ai / 智谱](https://z.ai/) 提供，本项目不代理、不转售。

---

感谢上述项目的作者与维护者。如果你的项目出现在这里但归属或表述有误，欢迎提 issue 指正。

## 许可

本项目基于 [zai-org/ZCode](https://github.com/zai-org/ZCode) 构建，遵循 [Apache-2.0](LICENSE)。

第三方组件声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，功能说明与风险提示见 [NOTICE.md](NOTICE.md)。
