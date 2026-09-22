# 与官方发行版的差异

> 状态：已核实 · 对照版本 ZCode 3.14.1（官方）与 ZCode-CE 3.14.1-ce.1

本文逐条回答「开源版是不是缺了一大堆功能」这个问题。所有结论都给出**可复现的验证方法**，
读者可以自己查。文中区分三类事实：

| 分类           | 含义                                                       |
| -------------- | ---------------------------------------------------------- |
| **官方未开源** | 官方发行版包含，但源码或资源不随包分发，或授权不允许再分发 |
| **尚未实现**   | 上游开源代码里有声明，但实现是占位或缺失，我们也还没补     |
| **双方一致**   | 官方发行版有**完全相同**的限制，不是开源版特有的缺口       |

**最容易误判的是第三类。** 有多项看似「缺失」的能力其实官方发行版同样不支持——
把这类算成开源版的缺口会得出错误结论。

## 结论摘要

### 插件清单对照

官方发行版随包分发 14 个插件，本仓库分发 10 个（其中 5 个是从官方发行包搬运的 MIT 内容，
见下文「本项目已补齐的部分」；`computer-use` 有 3 个文件带本地修改，其余为逐字节原样）。

| 插件                      | 官方 | 本仓库 | 说明                                                                                         |
| ------------------------- | ---- | ------ | -------------------------------------------------------------------------------------------- |
| `browser-use`             | ✅   | ✅     | 上游开源，本仓库同步维护                                                                     |
| `node-repl-host`          | ✅   | ✅     | 上游开源，Browser Use 与 Computer Use 的宿主                                                 |
| `documents` (DOCX)        | ✅   | ✅     | 官方版授权受限，本仓库为独立 MIT 实现                                                        |
| `presentations`           | ✅   | ✅     | 同上                                                                                         |
| `spreadsheets`            | ✅   | ✅     | 同上                                                                                         |
| `pdf`                     | ✅   | ❌     | 官方授权仅限非商业使用                                                                       |
| `image-search`            | ✅   | ❌     | 依赖官方服务端与账号鉴权                                                                     |
| `android-emulator`        | ✅   | ❌     | 仅分发编译产物，无源码                                                                       |
| `ios-simulator`           | ✅   | ❌     | 仅分发编译产物，无源码                                                                       |
| `computer-use`            | ✅   | ✅     | 官方插件搬运（MIT），执行改用开源驱动；**本仓对其中 3 个文件有本地修改**（见下「本地修改」） |
| `plugin-creator`          | ✅   | ✅     | 官方插件原样搬运（MIT；工作流改编自 Codex）                                                  |
| `skill-creator`           | ✅   | ✅     | 官方插件原样搬运（MIT）                                                                      |
| `zcode-guide`             | ✅   | ✅     | 官方插件原样搬运（MIT）                                                                      |
| `restore-legacy-sessions` | ✅   | ✅     | 官方插件原样搬运（MIT）                                                                      |

> 另有一个**非插件**的内置技能包：`bundled-skills`（官方 3.14.3 新增）。它不是插件（无
> `.zcode-plugin/plugin.json`），由运行时按 `source:"bundled"` + `scope:"system"` 的 skill root 原地发现；
> `dynamic-workflows` 自 3.14.3 起住在这里，`/workflow` 同时变成内置命令。本仓库已照搬
> （`apps/zcode-cli/packages/bundled-skills`），详见 `docs/development/architecture.md` 与
> `.reverse/25-v3143/BUNDLED-SKILLS.md`。`zcode-guide` 因此同步到官方 0.3.0：只剩 6 份自诊断/配置正文。

### 能力对照

| 能力                | 官方                   | 本仓库                       | 说明                                        |
| ------------------- | ---------------------- | ---------------------------- | ------------------------------------------- |
| Computer Use 执行   | macOS / Windows Helper | macOS / Windows / Linux 驱动 | 本仓库改用 MIT 开源驱动                     |
| Office 文档能力     | ✅                     | ✅                           | 官方版授权受限，本仓库为 MIT 实现（较精简） |
| PDF 制作            | ✅                     | ❌                           | 见「可补齐性评估」                          |
| 图片搜索            | ✅                     | ❌                           | 见「可补齐性评估」                          |
| Android / iOS 开发  | ✅                     | ❌                           | 见「可补齐性评估」                          |
| 遥测与上报          | 有                     | 已移除                       | 本仓库的主动改动                            |
| 国内网络加速        | 无                     | 有                           | 本仓库的主动改动                            |
| GitHub Actions 构建 | 无                     | 有                           | 本仓库的主动改动                            |

## 常见「缺失」说法的逐条核实

以下 12 项是容易被认为「开源版缺失」的能力，逐条核实结果如下。**其中 3 项与官方发行版
行为完全相同**，另有 4 项需要修正。

| #   | 常见说法                                     | 核实结论                                                        |
| --- | -------------------------------------------- | --------------------------------------------------------------- |
| 1   | Computer Use 全部执行能力                    | ✅ **真** —— 上游开源包是占位实现，本仓库已补                   |
| 2   | CUA Helper / PiP / 权限探测                  | ⚠️ **部分真** —— Helper 与 PiP 传输层是占位；权限面板保留       |
| 3   | CUA 官方插件资源                             | ✅ **真** —— 官方 `computer-use` 插件未随源码分发               |
| 4   | Documents / PDF / PPTX / XLSX / 图片搜索     | ⚠️ **部分真** —— 补齐 3 项，PDF 与图片搜索仍缺                  |
| 5   | Android / iOS 模拟器                         | ✅ **真**                                                       |
| 6   | Plugin Creator / Skill Creator / ZCode Guide | ✅ **真**                                                       |
| 7   | Superpowers 插件实现                         | ⚠️ **部分真** —— 上游无实现，但**官方也没随包分发**（见修正 1） |
| 8   | Swift bridge                                 | ⚠️ **部分真** —— 上游有目录但只是占位符（见修正 2）             |
| 9   | Custom Command 动态 Shell Expansion          | 🔁 **双方一致** —— 官方发行版同样不支持                         |
| 10  | OAuth 自动刷新                               | ❌ **错** —— 上游有完整实现，本仓库原样保留                     |
| 11  | Subagent Auto 权限模式                       | 🔁 **双方一致** —— 官方发行版同样未实现                         |
| 12  | Workflow Worktree 隔离                       | 🔁 **双方一致** —— 官方发行版同样抛出未实现                     |

### 修正 1：Superpowers 插件实现（第 7 项）

**上游开源代码里没有 Superpowers 插件实现。** `superpowers-plugin/` 目录下只有一个
`LICENSE` 文件（21 行 MIT 文本），没有 `plugin.json`、没有 `package.json`、没有任何技能。
上游自己的三方声明写明：

> Superpowers-derived skill descriptions and their translations only; … The former bundled
> plugin implementation has been removed; only its retained license remains.

仓库里真正保留的是**技能名称的中英文文案**（`packages/ui/src/lib/builtinSkillI18n.ts`），
那是界面翻译资源，不是插件实现。

**但要补一句关键事实：官方发行版的 14 个随包插件里同样没有 Superpowers。** 它不在官方
插件目录下，也不在随包市场清单里。所以「开源版缺 Superpowers」这个说法本身站不住——
**两边都没有随包分发**。

Superpowers 上游（`obra/superpowers`，MIT）是公开项目，官方客户端通过
`claude-plugins-official` 市场提供安装入口。**本仓库现已同样提供该市场**（见「其它差距」），
因此用户可以从市场自行安装，而不是依赖随包分发。

### 修正 2：Swift bridge（第 8 项）

上游开源代码里有一个 `swift-bridge/` 目录，含 3 个文件，但**它是占位符**：

- `package.json` 自述为 `"Swift interop layer (placeholder)"`
- `src/index.ts` 自述为 `"Swift bridge placeholder. To be implemented when Swift integration is needed."`
- `isSwiftAvailable()` 恒返回 `false`，`detectSwiftVersion()` 恒返回 `null`
- **没有任何模块引用它**（全仓库搜索只命中它自己的 `package.json` 与三方清单）

所以「有目录」不等于「有实现」。真正的 Swift 相关能力在官方的 `ios-simulator` 插件里
（含 `templates/swiftui-app`），那部分本仓库没有。

### 修正 3：第 9、11、12 项与官方行为完全相同

这三项常被当成「开源版缺功能」，实际**官方发行版有一模一样的限制**。核实方式是把官方
发行版打包后的 CLI 与本仓库构建产物做字符串比对：

| 项                             | 官方限制原文                                                  | 官方 | 本仓库 |
| ------------------------------ | ------------------------------------------------------------- | ---- | ------ |
| Custom Command 动态 Shell 展开 | `Dynamic expansion is not available yet.`                     | 2 处 | 2 处   |
| Subagent Auto 权限模式         | `Auto mode is reserved but not implemented yet`               | 2 处 | 2 处   |
| Workflow Worktree 隔离         | `workflow agent isolation 'worktree' is not implemented yet.` | 1 处 | 1 处   |

第 9 项的检测正则（内联 `!` 反引号 与围栏式代码块）在两边也完全一致。第 12 项的
schema（`z.enum(["worktree"])`）两边同样存在——**schema 接受该值、运行时显式拒绝**，
这是官方当前的设计状态，不是开源版删改的结果。

### 修正 4：第 2 项的 PiP 与权限面板

这一项内部需要拆开看，各子项状态不同：

| 子项           | 状态                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| CUA Helper     | ❌ 缺失。本仓库 `createCuaHelperInstaller` 返回不可用，无安装/校验实现                                                    |
| 权限探测       | ✅ 保留。`cuaAccessibilitySettings.ts`（646 行）等与上游基线逐行一致，未被删改                                            |
| 权限面板       | ✅ 保留，但**并非逐字节相同**（见下）                                                                                     |
| PiP 会话编排层 | ✅ 保留。`cuaPipSessionService.ts`（285 行）与上游基线一致，含重放与跳过原因判定                                          |
| PiP 传输层     | ❌ 占位。本仓库 `createPipSessionClient` 恒 `enabled: false`、`send()` 恒返回 `{applied:false}`；官方是完整 socket 客户端 |

权限面板 HTML 与官方**功能等价但非逐字节相同**：本仓库版本少 2 行注释，且脚本引用指向
源码文件而非打包产物。把它描述成「逐字节相同」是不准确的。

PiP 传输层是本项里最容易被忽略的缺口——**编排层保留不代表能力可用**，没有可用传输通道时
会话事件无法送达。本仓库该层走 `transport-disabled` 分支静默降级，不会报错。

### 修正 5：第 10 项的引用路径

「OAuth 自动刷新缺失」的说法**不成立**：上游有完整实现（291 行），本仓库与上游基线
逐字节一致、未做任何改动。

需要更正的是引用路径：实现在 `apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts`，
**不是** `adapters/src/auth/oauth-refresh.ts`（该路径不存在）。这是 **MCP OAuth 令牌刷新**
（含 `withFileLock` 并发保护与 45 秒刷新锁预算），与账号登录 OAuth 是两条链路。

## 官方未开源的部分

以下能力在官方发行版中可用，但本仓库**无法**通过移植源码来提供。

### 授权不允许再分发

官方四个 Office 文档插件（`documents` / `pdf` / `presentations` / `spreadsheets`）的
插件清单标注为 `SEE LICENSE IN skills/*/LICENSE.txt`，该文件内容是：

> Permission is granted for personal, educational, and non-commercial use only.
> Commercial use is strictly prohibited without prior written permission from the author.

**商业使用被明确禁止**，因此这些资源不能被复制进以 Apache-2.0 分发的开源仓库。这是许可
限制，不是能力取舍。本仓库的 Office 能力来自另一个 MIT 许可的实现（见下文）。

### 仅分发编译产物，无源码

以下插件在官方发行版中只包含**打包后的 JavaScript 与类型声明**，没有 TypeScript 源码，
且上游没有公开对应的源码仓库：

| 插件               | 分发内容                                        |
| ------------------ | ----------------------------------------------- |
| `android-emulator` | `dist/` 编译产物 + 16 个 `.d.ts`，无 `.ts` 源码 |
| `ios-simulator`    | `dist/` 编译产物 + `.d.ts`，无 `.ts` 源码       |

重新实现需要从打包产物反向工程——对这类依赖完整工具链（Android SDK、Xcode、AVD、idb）的
能力，成本极高且难以保证行为一致。

**2026-09-22 修订**：这张表此前还列了 `computer-use`、`node-repl-host`、`plugin-creator`、
`skill-creator`、`zcode-guide`、`restore-legacy-sessions` 六项，那个分类是错的。它们的发行
内容本来就是**可再分发的 MIT 内容**（技能文档、脚本、命令、文档），不需要「移植源码」，
只要按许可原样搬运即可——本轮已按此处理，见下文「本项目已补齐的部分」。

### 依赖官方服务端

`image-search` 插件本身只有 4 个文件，其 `.mcp.json` 声明的是一个 **HTTP MCP 服务**：

- 端点：官方 `ZCODE_BASE_URL` 下的 `/api/v1/mcp/server/image_search`
- 鉴权：`"type": "zcode_official"`，`"provider": "jwt_token"`

能力全部在官方服务端，插件只是带官方 JWT 鉴权的客户端声明。本仓库即使复制这个声明也
无法工作——它需要能访问官方服务端且已登录的账号。这不是「补一个插件」能解决的问题。

## 本项目已补齐的部分

### Computer Use：改用 MIT 开源驱动

上游开源包 `packages/zcode-cua` 原本是**占位实现**，`createComputerUseRuntime()` 恒返回
「Computer Use is not available in this build.」。本仓库改为适配 MIT 许可的
[`@trycua/cua-driver`](https://www.npmjs.com/package/@trycua/cua-driver)（`0.28.2`），
以预编译二进制分发六个平台目标：

| 平台    | 目标三元组                           |
| ------- | ------------------------------------ |
| macOS   | `darwin-x64`、`darwin-arm64`         |
| Linux   | `linux-x64-gnu`、`linux-arm64-gnu`   |
| Windows | `win32-x64-msvc`、`win32-arm64-msvc` |

**关于 Linux：官方发行版没有可用的 Linux 执行后端，本仓库通过开源驱动提供（实验性）。**
证据有两条，都可自行复核：

1. 官方 Helper 自动安装器对非 macOS 平台**直接抛错**：
   `ZCode Computer Use auto-install is only supported on macOS, got <platform>`
2. 官方 Helper 工厂只有 `darwin` 与 `windows` 两个分支，没有 Linux 分支；
   官方 Linux 构建产物里也没有任何 `cua-helper` 文件

需要说明的是，官方 CUA 插件的**类型声明**里确实写了 `target: "mac" | "windows" | "linux"`，
客户端也把非 darwin/win32 平台映射为 `"linux"`——但这描述的是 API 形状，**实际执行依赖
Helper 后端**，而官方没有提供 Linux 后端。这个区别容易被误读，故在此点明。

保留的失败关闭语义：`driver: "disabled"` 模式维持原占位行为，所有面不可用。原生 Helper、
PiP 传输层、broker RPC 仍是占位——**这三块没有被开源驱动替代**，因为它们的职责是官方私有
二进制之间的通道，不是驱动能力本身。

### 四个内容插件：官方发行包原样搬运

`zcode-guide`、`skill-creator`、`plugin-creator`、`restore-legacy-sessions` 四个插件没有
MCP server、没有 hooks、没有编译产物，全部是技能文档（Markdown）与 `.mjs` 脚本，清单声明
`license: MIT` / `author: Z.ai`。它们**不需要重新实现**：直接从官方发行包逐字节搬运到
`apps/zcode-cli/packages/<name>-plugin/`（共 25 个文件，逐文件 sha256 与官方包相同），
许可归属登记在 `third-party/copied-components.json`，许可全文随 `THIRD-PARTY-NOTICES.md` 分发。

| 插件                      | 版本  | 搬运文件数 | 许可         | 备注                   |
| ------------------------- | ----- | ---------- | ------------ | ---------------------- |
| `zcode-guide`             | 0.3.0 | 8          | MIT (© Z.ai) | 6 个技能文档 + 说明    |
| `skill-creator`           | 0.1.0 | 2          | MIT (© Z.ai) | 1 个技能文档           |
| `plugin-creator`          | 0.1.1 | 9          | MIT (© Z.ai) | 含 Codex 血缘，见下    |
| `restore-legacy-sessions` | 0.1.0 | 6          | MIT (© Z.ai) | 技能 + 命令 + 2 个脚本 |

> `zcode-guide` 由 0.2.0 升到 **0.3.0**：官方 3.14.3 把 `commands/workflow.md` 与
> `skills/dynamic-workflows/` 三份正文迁出，改由内置技能包 `bundled-skills` 承担（见下文）。
> 因此它的 `plugin.json` 也去掉了 `commands` 字段。

两点如实说明：

- **官方 `package.json` 有意不搬**（官方 9/3/10/7 个文件 → 本仓库 8/2/9/6）。原因：
  `apps/zcode-cli/packages/*` 是 pnpm workspace 的通配目录，放进去会让这 4 个目录变成
  workspace importer，CI 第一站 `pnpm install --frozen-lockfile` 直接失败；而插件加载只认
  `.zcode-plugin/plugin.json`，MIT 声明就在那份文件里，许可信息不因此缺失。
- **`plugin-creator` 带 Codex 血缘**：`skills/plugin-creator/SKILL.md:8` 自述
  「the authoring workflow is adapted from Codex's plugin-creator」，上游是 Apache-2.0 的
  [openai/codex](https://github.com/openai/codex)。逐文件比对显示 Z.ai 做的是**改写**而不是复制
  （上游 SKILL.md 249 行 vs 本包 58 行；上游 5 个 Python 脚本 vs 本包 5 个独立的 Node 脚本），
  但仍按上游自述**如实登记**了一条独立的 Apache-2.0 归属条目——许可副本由
  `THIRD-PARTY-NOTICES.md` 承担，变更声明即 SKILL.md 里那句自述。

### 内置技能包 `bundled-skills`（不是插件）

官方 3.14.3 新增 `glm/packages/bundled-skills/`，本仓库已同步为
`apps/zcode-cli/packages/bundled-skills/`（4 文件，逐字节）。

它**不是插件**——没有 `.zcode-plugin/plugin.json`、没有 `package.json`，因此上文「官方
随包分发 14 个插件」的计数**不受影响**（官方 `glm/packages/` 下有 15 个目录，其中 14 个是
插件）。它走另一套发现机制：运行时把它的 `skills/` 原地识别为一个
`source: "bundled"`、`scope: "system"` 的技能根。

| 项         | 说明                                                                                |
| ---------- | ----------------------------------------------------------------------------------- |
| 内容       | `skills/dynamic-workflows/` 三份正文（`SKILL.md` / `patterns.md` / `examples.md`）  |
| 定位       | 不进插件商店、**无开关、不可卸载**、不出现在设置技能列表与 `$` 选择器               |
| 为什么内置 | 官方 README 自述：该特性的工具面由 runtime 注册，教模型用工具的正文必须同样不可移除 |
| 关联变化   | `/workflow` 从「插件自定义命令」升格为 **CLI 内置命令**，不再依赖插件存在           |

> 与官方的一处**已知差异**：官方另有 SEA 发行态的资产内嵌（`sea-bundled-skill-assets.mjs`
>
> - `~/.zcode/cli/bundled-skills/<hash>/` 物化）。本仓库的发布形态是 Electron 桌面 + AUR，
>   不走 SEA，故未实现该分支。详见 `.reverse/25-v3143/V3143-CLOSEOUT.md`。

### Office 三件套：MIT 独立实现

本仓库新增三个插件，源码来自 MIT 许可的
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)
（`packages/skill/skill-office`），并做了本地适配：

| 插件            | 技能   | 官方对应        | 本仓库         | 官方            |
| --------------- | ------ | --------------- | -------------- | --------------- |
| `documents`     | `docx` | `documents`     | 65 行 SKILL.md | 315 行 SKILL.md |
| `presentations` | `pptx` | `presentations` | 89 行 SKILL.md | 783 行 SKILL.md |
| `spreadsheets`  | `xlsx` | `spreadsheets`  | 75 行 SKILL.md | 349 行 SKILL.md |

**必须诚实说明：这是精简实现，不是官方实现的移植。** 官方版每个技能附带 `references/`、
`scenes/`、`routes/`、`env_setup/` 等数十个文档与脚本，本仓库版本没有这些内容。差异体现
在场景覆盖深度——官方 docx 有学术、合同、文案、试卷、公文、报告、简历 7 个场景文件，
本仓库没有对应的场景拆分。

本仓库版本的适配点：

- 上游引用的 `load_workspace_dependencies` / `render_document` / `present` 工具，替换为
  系统 `python3` 与文件路径等价物
- 技能目录从 `assets/` 改名为 `skills/`，匹配本仓库插件布局
- 附带独立的 OOXML 结构检查脚本 `scripts/check_office.py`
- `agents/visual-judge.md` 是本仓库独立实现，不是从上游复制

### 移除遥测、国内加速、CI 构建

这三项是本仓库的主动改动，与「补齐官方能力」无关，详见
[遥测与隐私](telemetry.md) 与 [与上游的差异](upstream-diff.md)。

## 澄清：开源版本就具备的能力

以下能力常被误认为「开源版删掉了」，实际**上游开源代码里完整保留**，本仓库未做删改。

| 能力                      | 位置                                                                  | 状态                     |
| ------------------------- | --------------------------------------------------------------------- | ------------------------ |
| OAuth 令牌自动刷新        | `apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts`           | 291 行，与基线逐字节一致 |
| CUA 权限面板（HTML/渲染） | `packages/desktop/src/renderer/cua-permission-panel.html`             | 保留，功能等价           |
| CUA 权限探测与设置项      | `packages/desktop/src/main/cuaAccessibilitySettings.ts`               | 646 行，未改动           |
| CUA 权限拖拽面板          | `packages/desktop/src/main/cuaPermissionDragPanel.ts`                 | 265 行，未改动           |
| PiP 会话编排层            | `packages/services/src/cua-permission-broker/cuaPipSessionService.ts` | 285 行，未改动           |
| Workflow worktree schema  | `apps/zcode-cli/packages/contracts/src/workflow/script.ts`            | 保留（运行时拒绝）       |
| Subagent 权限模式框架     | `apps/zcode-cli/packages/core/src/permission/service.ts`              | 保留（auto 模式拒绝）    |
| 插件市场框架              | `packages/shared/src/plugin-marketplaces.ts`                          | 保留                     |

判断方法：**「有目录」不等于「有实现」，也不等于「没有」**。本仓库对上游的改动绝大部分是
删除遥测相关代码与新增独立目录，对上述文件没有做功能删减。

## 其它差距

除了上述 12 项，系统对比后还发现以下差距。

### 默认个人插件市场（已补齐）

官方构建产物里出现 `claude-plugins-official`，其中一处的注释明确写着它是
**默认个人市场 id**：

> 默认个人市场 id（客户端精选推荐区已下线，pluginNames 策展名单随之下线）。

这个市场是 **Superpowers、context7 等社区插件**的分发入口。上游开源快照只保留了
`zcode-plugins-official` 一个市场，本仓库一度同样如此——直接后果是官方用户能从市场装上
Superpowers，本仓库用户没有这个入口。

**现状：本仓库已补上该市场**（`packages/shared/src/plugin-marketplaces.ts` 的
`DEFAULT_PLUGIN_MARKETPLACES`，id 为 `CLAUDE_PLUGINS_OFFICIAL_MARKETPLACE_ID`）。

需要说明的是：

- 该市场由 **Anthropic 维护**（`anthropics/claude-plugins-official`），收录的是第三方插件；
  本项目不背书其内容，用户安装前应自行确认许可与质量
- 该市场在官方客户端是否**首启自动注册**，本文未验证，已列入「待验证项」

### 插件声明与实际分发不一致

本仓库的官方插件声明文件
（`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`）
声明了 **14 个**插件，本仓库仍不分发其中的 `android-emulator`、`ios-simulator`、`pdf`、
`image-search` 四个。该文件在 fix.3 之前与上游基线逐字节一致，fix.3 起为其中几个内容型插件
补了 `requiredSeedPaths`（见该文件内注释），因此**现在已与基线不同**。

这些声明在运行时找不到对应目录，会被静默跳过（`resolveFilesystemPluginRoot` 遍历
`rootCandidates` 全部落空后返回 `undefined`）。

默认启用名单（`packages/shared/src/plugin-marketplaces.ts` 的
`DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`）里同样保留了没有实体的条目（`pdf` 与
`image-search`）。但**这些条目只参与「已发现的插件是否默认启用」这一个判断**，集合的每一处
消费点都作用在**已发现、已加载或已落盘缓存**的候选之上：

| 消费点                              | 求值对象                             |
| ----------------------------------- | ------------------------------------ |
| `commandsService.ts:394`            | 遍历已发现的 command candidate       |
| `skillsService.ts:820`              | 遍历已发现的 skill candidate         |
| `subagentsService.ts:437`           | 遍历官方插件缓存根（磁盘上已存在的） |
| `adapters/src/plugins/index.ts:179` | 已成功加载的插件（`loaded.id`）      |

没有候选时那段逻辑根本不执行，因此无效条目**不产生运行时错误，只是不生效** —— 用户不会
因为这条名单看到失败提示。

要区分的是另一条链路：**插件被列进市场清单、却没有可加载的目录**时，用户在该条目上点「启用」
会拿到 `Plugin not found: <name>@<marketplace>`（`adapters/src/plugins/marketplace.ts:703`
的校验）。那条报错的判据是市场清单，不是这张默认启用名单，两者不能混为一谈。

这是本仓库需要修正的一致性问题（声明与实际分发不一致），不是官方的问题。

### 插件资源规模差异

即使是双方都有的插件，资源规模也有差距：

| 插件             | 官方                                               | 本仓库                                                                                           |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `node-repl-host` | `dist/mcp/server.js` 约 5.1 MB                     | 约 2.0 MB                                                                                        |
| `browser-use`    | `scripts/browser-client.mjs` 79,261 字节           | 78,937 字节                                                                                      |
| `computer-use`   | 技能 306 行 + 文档 450 行 + 客户端脚本 58,928 字节 | 技能 332 行 + 文档 467 行 + 客户端脚本 59,140 字节（**有本地修改**，按 2026-09-23 修改后的快照） |

`browser-use` 的差异来自上游持续更新，属于正常同步节奏。`computer-use` 的差异是结构性的：
官方插件把技能、文档、客户端脚本打包在一起，本仓库只有自己的实现文档。

### 本地修改（computer-use 插件壳，2026-09-23 · task 3143-3）

本仓库对官方 `zcode-cua-plugin` 的**三个文件**做了有意修改，其余文件仍逐字节相同：

| 文件                              | 修改内容                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skills/computer-use/SKILL.md`    | 顶部硬约束：驱动由宿主提供，**严禁** `npm install`/`pnpm add`/猜包名/换驱动/改插件让驱动"出现"；新增「When Computer Use is unavailable」小节：遇到 bridge 错误立即停止、如实告知用户「Computer Use 未启用，可在 设置 → 电脑控制 开启」、不得自愈 |
| `docs/computer-use.md`            | 「Bootstrap every call」一节后补同样约束与三步处置（先停止 / 告知用户在设置中开启 / 征得同意再换方案）                                                                                                                                           |
| `scripts/computer-use-client.mjs` | bridge 缺失时的报错改为可操作版本：明确「不是缺依赖、不要安装任何驱动」，并指引用户去设置里开启                                                                                                                                                  |

**动因**：`computer-use` 插件默认关闭，而 `node_repl` 只要 browser-use **或** cua 任一启用就注册，
于是模型看得到 `mcp__node_repl__js`、尝试 CUA 时却撞上「bridge 不可用」；原报错只陈述不可用，
实测模型会据此自行 `npm install` 并**猜错包名**（`@trycua/Cua.Driver` 与 `cua_drivers` 在 npm registry 上
都不存在，正确包名只有 `@trycua/cua-driver`）。用户已定方案：bridge 不可用即报错停下、严禁自愈式安装。
登记见 `third-party/copied-components.json` 的 `ZCode computer-use plugin shell (Z.ai)` 条目（字段名 `locallyModifiedFiles`）。
**为什么不是 `modifiedFiles`**：声明解析器要求 `modifiedFiles` 里的每个文件**正文内**含字面量 `Modified by ZCode:`（`scripts/generate-third-party-notices.mjs:78-84`），而这 3 个文件是 MIT 材料、没有也不应加这种标记；改用自定义字段 `locallyModifiedFiles` 既保留机器可读的改动清单（进 `third-party/inventory.json`），又不动文件正文。MIT 本身不要求文件内变更声明，改动的书面说明就在本节的表格里。

## 可补齐性评估

按「可行性 × 价值」排序。

### 可做，价值高

| 项                 | 做法                                                           | 障碍                   |
| ------------------ | -------------------------------------------------------------- | ---------------------- |
| 修正插件声明一致性 | 从 `official-plugin-definitions.ts` 移除未分发插件，或补齐分发 | 无，纯本地改动         |
| Superpowers 插件   | 上游 `obra/superpowers` 为 MIT，可自行打包为 ZCode 插件        | 无许可障碍，需实现适配 |
| 默认个人市场       | 恢复 `claude-plugins-official` 引用，给社区插件一个安装入口    | 需确认该市场内容的许可 |
| 加深 Office 三件套 | 补充场景文档、参考手册、环境检查脚本                           | 工作量大，需逐项实现   |

### 可做，价值中等

| 项                        | 做法                                                 | 障碍                                               |
| ------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| PDF 制作                  | 基于开源排版工具链重新实现                           | 官方版有 43 个文件，含 LaTeX/HTML 双链路，工作量大 |
| `restore-legacy-sessions` | 迁移逻辑本身不复杂（7 个文件，含 2 个扫描/恢复脚本） | 需要旧版会话格式样本                               |

### 做不了，或成本极高

| 项                   | 原因                                                      |
| -------------------- | --------------------------------------------------------- |
| 官方 Office 插件移植 | 授权明确禁止商业使用，不能进入 Apache-2.0 仓库            |
| 图片搜索             | 能力在官方服务端，需要官方账号鉴权，本地实现无意义        |
| Android 模拟器       | 无源码，需从打包产物反向工程；依赖完整 Android SDK 工具链 |
| iOS 模拟器           | 无源码，需从打包产物反向工程；依赖 macOS 与 Xcode         |
| CUA 原生 Helper      | 官方私有二进制，未标注许可；本仓库已用开源驱动替代其能力  |
| PiP 传输层           | 需要与官方 Helper 的 socket 协议对接，Helper 本身不可得   |
| 动态 Shell 展开      | **官方发行版同样不支持**，非本仓库缺口                    |
| Subagent Auto 权限   | **官方发行版同样不支持**，非本仓库缺口                    |
| Worktree 隔离        | **官方发行版同样不支持**，非本仓库缺口                    |

## 验证方法

以下命令读者可以自行执行。官方侧路径以本机安装的官方 ZCode 3.14.1 为例，**前提是你已经
安装了官方发行版**；未安装时这些命令会失败，属正常现象。本仓库侧命令在仓库根目录执行。

### 通用前提

```bash
# 官方插件目录（按本机实际安装路径调整）
OFFICIAL=/usr/lib/zcode/glm/packages

# 官方打包后的 CLI
OFFICIAL_CLI=/usr/lib/zcode/glm/zcode.cjs

# 本仓库基线提交（开源时的初始状态）
BASE=872ad96
```

### 核实插件清单差异

```bash
# 官方插件清单（应为 14 项）
ls "$OFFICIAL"

# 本仓库插件清单（应为 10 项：按真实 plugin.json 清单计）
find apps/zcode-cli/packages -name plugin.json -path '*.zcode-plugin*' \
  | sed 's|/.zcode-plugin/plugin.json||' | sort
```

注意 `apps/zcode-cli/packages/` 下还有一个 `superpowers-plugin/` 目录，但它只有一个
`LICENSE`、没有 `plugin.json`，不构成插件——这类「有目录但内容少」的情况容易误判，
下文单独说明。

### 核实 Computer Use 占位实现

```bash
# 基线：占位实现，恒返回不可用
git show "$BASE":packages/zcode-cua/index.js

# 当前：适配开源驱动
cat packages/zcode-cua/index.js

# 支持的平台清单
grep -A8 'CUA_DRIVER_SUPPORTED_PLATFORMS' packages/zcode-cua/cua-driver-runtime.js
```

### 核实官方 CUA 没有 Linux 后端

```bash
# 官方 Helper 安装器的平台断言（应命中 darwin-only 报错文案）
grep -a -o 'auto-install is only supported on macOS' /usr/lib/zcode/app.asar | head -1

# 官方 Linux 构建产物里没有 Helper
find /path/to/official-linux-install -iname '*cua-helper*'
```

### 核实 Superpowers 只有 LICENSE

```bash
# 目录内容（应只有 LICENSE 一个文件）
git ls-tree -r --name-only "$BASE" | grep superpowers

# 上游自述：实现已被移除，只保留许可
grep -A3 '"id": "Superpowers skill description adaptations"' third-party/copied-components.json

# 官方随包插件里也没有 Superpowers（应无输出）
ls "$OFFICIAL" | grep -i superpower
```

### 核实 Swift bridge 是占位符

```bash
# 源码自述为 placeholder，两个导出函数恒返回空值
git show "$BASE":apps/zcode-cli/packages/swift-bridge/src/index.ts

# 确认没有任何模块引用它
grep -rn 'swift-bridge' --include='*.ts' --include='*.json' . 2>/dev/null | grep -v node_modules
```

### 核实第 9、11、12 项与官方一致

把官方打包产物与本仓库构建产物做字符串比对：

```bash
OUR_CLI=apps/zcode-cli/packages/cli/dist/zcode.cjs

for m in "Dynamic expansion is not available yet." \
         "Auto mode is reserved but not implemented yet" \
         "workflow agent isolation 'worktree' is not implemented yet." ; do
  printf 'official=%s ours=%s  %s\n' \
    "$(grep -o -F "$m" "$OFFICIAL_CLI" | wc -l)" \
    "$(grep -o -F "$m" "$OUR_CLI" | wc -l)" "$m"
done
```

预期结果：三项的两边计数完全相同。

### 核实 PiP 传输层是占位

```bash
# 本仓库：恒 enabled: false
cat packages/zcode-cua/pip-session-node.js

# 官方：完整的 socket 客户端（含握手、重连、版本校验）
grep -a -o '.\{200\}createPipSessionClient.\{200\}' /usr/lib/zcode/app.asar | head -1
```

### 核实权限面板不是逐字节相同

```bash
# 对比官方渲染进程 HTML 与本仓库源码版本
diff /path/to/official/out/renderer/cua-permission-panel.html \
     packages/desktop/src/renderer/cua-permission-panel.html
```

预期结果：有差异（注释与脚本引用方式不同），但功能结构一致。

### 核实 OAuth 刷新存在且未改动

```bash
# 与基线逐字节比对（应无输出）
git show "$BASE":apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts \
  | diff - apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts
```

### 核实官方 Office 插件的许可限制

```bash
head -5 "$OFFICIAL/presentations-plugin/skills/pptx/LICENSE.txt"
```

预期结果：明确写有 `non-commercial use only` 与 `Commercial use is strictly prohibited`。

### 核实默认个人市场缺失

```bash
# 官方构建产物（应有命中）
grep -a -c 'claude-plugins-official' /usr/lib/zcode/app.asar

# 本仓库源码（应无命中）
grep -rn 'claude-plugins-official' --include='*.ts' apps/ packages/ | grep -v node_modules
```

### 核实插件声明与实际分发不一致

声明文件里的插件名有两种写法（字面量、`OFFICIAL_*_PLUGIN_NAME` 常量、以及一个展开的
数组），所以不能只 grep `name:`：

```bash
# 声明的插件数（应为 14）
node -e '
const fs = require("fs");
const src = fs.readFileSync(
  "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts", "utf8");
const consts = {};
for (const m of src.matchAll(/const (OFFICIAL_[A-Z_]+_PLUGIN_NAME)\s*=\s*"([^"]+)"/g))
  consts[m[1]] = m[2];
const names = [];
for (const m of src.matchAll(/^\s+name:\s*(?:"([^"]+)"|([A-Z_]+)),/gm))
  names.push(m[1] ?? consts[m[2]] ?? m[2]);
for (const m of src.matchAll(/\["([a-z]+)",\s*"[a-z]+",\s*"[A-Za-z]+"/g)) names.push(m[1]);
console.log([...new Set(names)].length);
'

# 实际分发的插件数（应为 10）
find apps/zcode-cli/packages -name plugin.json -path '*.zcode-plugin*' | wc -l
```

预期结果：14 项声明、10 个实际分发的插件——声明里有 4 个插件在仓库中不存在
（`android-emulator`、`ios-simulator`、`pdf`、`image-search`）。

## 待验证项

以下结论尚未取得充分证据，读者不应直接采信：

| 项                                         | 状态                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `claude-plugins-official` 是否首启自动注册 | 该市场已在本仓库声明（见「其它差距」）；但官方/本仓库是否在**首启**自动注册未验证 |
| 官方 Windows CUA 是否已面向所有用户发布    | 官方存在 `WindowsCuaHelperHost` 与 `ZCODE_CUA_DEV_MODE` 开关；发布范围未验证      |
| 官方 macOS Helper 的完整能力边界           | 仅确认安装器为 darwin-only；其能力清单未与本仓库逐项比对                          |

## 相关文档

- [Computer Use（开源实现）](computer-use.md)
- [与上游的差异](upstream-diff.md)
- [遥测与隐私](telemetry.md)
- [架构与模块边界](architecture.md)
