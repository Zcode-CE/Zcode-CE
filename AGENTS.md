## 核心原则

- 新增或修改行为前，先更新对应 spec；目录不存在时按需创建。先明确产品规则、状态所有者、接口和验收场景，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 文档与知识库

- **开工前先读文档**：接到任务先读与该任务相关的既有文档，不要从零推导。至少覆盖：根 `AGENTS.md`、目标包的 `AGENTS.md`、`.reverse/` 下同主题的分析结论、`docs/development/` 下对应能力的文档，以及各节列出的领域文档（如 `CONTEXT.md`、`DESIGN.md`）。
- **交付时声明读过什么**：报告或答复的开头写明读了哪几份、你的结论与它们是**一致还是不一致**。不一致时给出证据 —— 指出既有文档有错，比默默绕过它有价值。
- **文档有错就地修正**：发现文档与当前源码或实测不符，**按实际情况改掉它**并说明依据。先区分两类：**事实错误**（例如「某插件无源码」而实测是纯 Markdown）直接改；**判断分歧**（要不要做、值不值得做）先与人对齐再改。
- **文档是知识库，不是一次性产物**：任何改变行为、接口或能力范围的改动，都要同步更新受影响的文档 —— `docs/`、`.reverse/` 的结论段、以及源码里的说明性注释。改完之后文档应当仍然可信。
- **改动能力范围后主动回扫文档**：改变能力范围或分发内容后，grep 一遍 `docs/`、`README*.md`、`.reverse/*/ROADMAP.md` 以及本节上面的仓库结构清单 —— 没有这一环，被列举、被计数的值会静默漂移。（fix.3 新增 5 个插件后，`architecture.md`、README「后续计划」、基线事实文档都曾滞后。）
- **改目录结构后回扫所有相对路径**：搬运或重命名目录时，**所有以该目录为基准的相对路径都会静默失效** —— 它们不会报错，只会在运行时「文件不存在」。本项目实例：office 技能从上游的 `assets/office-docx/` + `assets/scripts/`（平级）改名成 `skills/docx/` + `scripts/`（多一层），技能正文的 `../scripts/` 少了一级，**从搬运那天起模型调用校验器就必然失败**，直到有人在真实运行目录上核对才暴露。改目录后 grep 一遍引用该目录的 `../`、`./` 路径，并在**真实运行时的目录布局**上验证，而不是源码树。
- **会漂移的值要么运行时取值、要么标快照时刻**：版本号、插件数、提交哈希、文件计数这类复制来的值，优先改成运行时读取（例如版本号用 `node -p "require('./package.json').version"` 而不是写死），否则在旁边注明它是哪个时刻的快照。
- **否定式断言必须穷尽验证**：「全仓仅一处」「没有任何地方引用」「只支持 X」这类断言比肯定式更容易错，因为它要求穷尽。写进文档前自己跑一遍；引用他人给的这类断言前同样要复核。
- **验证必须打到最终消费点**：交付物经过多个处理阶段时（如 stage → seed → 打包 → 运行时，或 构建 → 安装 → 执行），**不能停在中间产物**。中间阶段全绿而最终消费点失败是常态而非例外 —— 本项目两次踩过：① 裁剪闭包静态可达 ≠ 运行时 `require` 可解析（多版本嵌套、动态 require）；② stage 出的文件在磁盘上 ≠ 运行时 seed 后还在（顶层白名单会静默裁掉）。写验证时先问「**谁最终读它、从哪个路径读**」，再从那个点验证。
- **判据**：如果一份文档能让读者做出错误决定，那它就是缺陷，与代码 bug 同级，必须修。

## 能力来源与取舍

从外部引入能力时，按来源分三类处理：

| 来源                        | 拿什么                           | 边界                                                                                                                               |
| --------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **官方 ZCode 发行包**       | **能力对齐与行为参考**           | 许可受限（Office 插件禁止商用、模拟器仅发编译产物、CUA Helper 为私有二进制），多数**不能搬**；可参考其能力清单、接口形状与交互设计 |
| **DSH（deepseek-harness）** | **载荷与工程实现**               | MIT，可搬；本项目已在复用其平台能力（如 agent team）。搬载荷时连许可一起登记                                                       |
| **本项目自研**              | **技能文本、产品决策、许可合规** | 这是差异化所在：技能正文、产品取舍、第三方登记都由本项目承担                                                                       |

判据：

- **技能与载荷是配套的，不能拆开搬**。先有载荷、再改技能；反过来会让技能指挥模型做它做不到的事。
- **核心依赖必须自带载荷；可选增强可以依赖外部工具。**
  官方把 `docx`、Python 这类**核心依赖**也推给用户安装（`setup.sh`）**不可采纳** —— 本项目核心能力（文档生成、结构校验）零外部依赖，随包发 Node 载荷。
  但**非核心的可选增强**（如渲染 / 转 PDF 需要 LibreOffice）可以依赖外部工具，须三条同时成立：
  ① **没有它核心能力仍完整**；
  ② **必须如实声明**未做该检查 —— **静默降级是唯一不被允许的**（官方 `setup.sh` 的 FORBIDDEN 清单同样禁止 silently degrading，这一点我们与它一致，差别在别处）；
  ③ **只在用户明确要求时引导安装，且保留用户拒绝的权利** —— 官方恰恰剥夺了这一权利（它禁止问「要不要用 Word 代替」，把违规伪装成提问的禁令正说明它把「装」当成不可协商项）。
  **不得禁止用户用已有软件（Word / WPS / Pages）完成同类任务** —— 本项目没有强制的视觉验证流水线，引擎选择权属于用户。
  **环境限制**：Linux 下 agent 通常**无法代装**（shell 无 TTY、`sudo` 需要密码 ⇒ 包管理器无法非交互运行），只能给出命令让用户自己执行。macOS / Windows 可能经包管理器可行，但同样需用户同意。
- 任何搬运都走既有流程：逐字节搬运 → 许可登记（`copied-components.json`）→ 差异文档（`official-diff.md`）→ **本地修改必须如实登记**（MIT 用 `locallyModifiedFiles`；Apache-2.0 路径用 `modifiedFiles` 并在文件内加 `Modified by ZCode:` 标记）。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。

以下命令从仓库根目录执行：

| 用途             | 命令                                      |
| ---------------- | ----------------------------------------- |
| 类型检查         | `pnpm typecheck`                          |
| Lint             | `pnpm lint` / `pnpm lint:fix`             |
| 格式检查         | `pnpm fmt:check`                          |
| 桌面开发         | `pnpm dev:desktop`                        |
| Web 开发         | `pnpm dev:web`                            |
| 提交前检查       | `pnpm verify:pre-push`（Lint 与架构检查） |
| 架构检查         | `pnpm architecture:check --changed`       |
| 模块阅读包       | `pnpm architecture:context <module-id>`   |
| 未使用依赖与导出 | `pnpm knip`                               |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`     |

测试入口以目标包当前的 `package.json` 和实际测试文件为准，不假定存在统一的单测或 E2E 命令。

- `packages/desktop`：Electron main、host、renderer。
- `packages/web`、`packages/server`：Web 客户端与服务端。
- `packages/ui`：共享 React 组件、hooks 与 Zustand store。
- `packages/services`：业务服务；`packages/rpc`：RPC 框架。
- `packages/shared`：共享协议与类型；`packages/client`：Agent 客户端 SDK。
- `apps/zcode-cli`：Agent CLI 与运行时。
- `CONTEXT.md`：插件商店领域词汇；修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范；修改 UI 前阅读。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 有行为改动时先补充对应测试；交互改动需要 E2E 场景。检查测试与实现是否一致，并实际执行可用的验证。未执行或环境受限时如实说明。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。

## 提交与推送

- 按「一个完整的改动单元」提交，不要为每处小修各提一次。同一件事的拆分、补漏、格式化、修订说明都合并进同一个提交。
- 不要每有提交就推送。在本地累积若干提交、或一件事整体收尾后，再一次性 push。
- 紧迫的热修不必等凑批，但仍要把同一件事合并成一个提交，不要拆散。
- 推送前在本地跑完 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、`pnpm test`，不要把 CI 当成第一道检查。
  （只跑前三项会漏掉只能被测试抓到的行为回归 —— 例如断言某入口「应保持隐藏」这类护栏。）
- 原因：每次 push 都会触发 CI。细碎提交叠加频繁推送会让流水线反复空跑，也会稀释真正失败信号的可见度。

## 版本号

- 版本号按**改动意图**定，不按改动量定。`3.14.1-ce.N.fix.M` 的意图是「修补既有版本的缺陷、让本应可用的能力恢复可用」—— 即使涉及多个插件、跨模块或大量文件，只要意图是修补，就仍是 `fix.M`；语义新增才升 `ce.N`。
- 预览版用 `-alpha.ce.N`（`alpha` 必须带前缀），热修用点分隔的 `.fix.M` —— 符合 semver 预发布排序规则。
- 打 tag 前必须确认 CI 已绿：先 push 代码、等 CI 通过、再单独打 tag。**tag 必须指向 CI 通过的那个提交**，不要与代码同时推。
- 发布后同步四处：`package.json` 版本、AUR `PKGBUILD` 的 `pkgver` 与 `_upstream_tag`、`release-notes.md`、以及随包 `THIRD-PARTY-NOTICES.md` 的再生成。

## UI 与平台边界

- 遵守 `DESIGN.md`，复用已有组件，兼顾桌面与手机 Web 的布局、交互、主题和国际化。
- 组件通过 `packages/ui/src/hooks/` 访问服务；平台操作通过 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调用 `window.zcode`。
- 通过依赖注入处理 Desktop、Web、本地和远程环境的差异，并兼顾 Windows、macOS 和 Linux。
- Zustand 状态位于 `packages/ui/src/store/`。广播同步的主题、语言等字段需要防止回环；UI 局部状态不应被误当作服务端事实。
- hooks 中含 JSX 的文件使用 `.tsx`。

## 进程、协议与远程控制

- Desktop app 通过 stdio 与 Agent 通信。协议改动同步更新 `packages/shared/src/zcode-protocol/index.ts`，提供严格类型与运行时校验。
- Main 负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态。
- 每个窗口使用一个 window-scoped Local Host；本地 workspace 共享该 Host。远程 workspace 由窗口内的连接注册表管理，不另建 Desktop Remote Host。
- 手机远控连接桌面已有 Host attachment，复用会话运行时；不为手机另起 Agent、Local Host 或远程会话。
- Desktop 的 `desktop-continuous` 实时链路与手机的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，不保存任务队列、快照等业务状态。
- 已接受的 busy/running 输入由 CLI/runtime `CommandInbox` 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
- 保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

- UI 使用 `packages/ui/src/logger.ts`，不直接使用 `console.log` 或 `window.zcode?.log`。
- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`（`packages/services/src/logger/serviceLogger.ts`）。
- `debug` 用于协议原始数据、流式 chunk 和逐条工具更新等高频诊断，生产环境不落盘。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。
