# 140 — MCP Apps / mcp-ui 契约移植（F5 上半）

## 目的

把上游 zai-org/ZCode v3.15.1（aac47556，Apache-2.0）的「UI 插件（MCP App）」**契约层**搬到 CE，为桌面 host sandbox（desktop-host-port）与 UI（ui-features-port）提供共享类型与协议 schema。本仓库不实现插件沙箱与渲染，只协定三端共用的契约。

## 范围（本任务 = 契约侧）

| 层             | 文件                                                                                                                                       | 说明                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| shared schema  | packages/shared/src/mcp-apps/（15 文件，含 CONTRACT.md）                                                                                   | MCP App 实例、app-provided 工具、sampling、资源 MIME 白名单等运行时校验 schema                                                               |
| shared schema  | packages/shared/src/zcode-protocol/trace.ts                                                                                                | 协议 trace 摘要 schema（channel 回复 host 请求与采样共用）                                                                                   |
| shared 导出    | packages/shared/src/zcode-protocol/index.ts 增量                                                                                           | zcodeMcpUi*（open/close instance、callTool/cancel、readResource、list/subscribe、sampling、app tools 注册/接纳/结算）、zcodePluginUiSurface* |
| bootstrap 契约 | apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/（19 文件）                                                                    | agent 侧处理器契约与实现：instances 凭证 owner、callRaces、samplingCalls 账本、notifications 路由、sessionAccess 收窄视图                    |
| bootstrap 契约 | zcode-protocol/plugin-ui-surfaces.ts、topic-resource-port.ts、fork-model-selection.ts、saved-workflows-run.ts、workflow-settings-answer.ts | mcp-ui 依赖的相邻端口契约                                                                                                                    |
| 宿主类型       | packages/client/src/globals.d.ts 增量                                                                                                      | 插件页面 window 侧类型声明                                                                                                                   |

## 不在本任务（消费侧，cli-runtime-port 负责）

@zcode/contracts 的 mcp.port.ts 增量、@zcode/core 的 mcp/app-tools.ts、bootstrap/src/app 的 ZCodeApp 方法、bootstrap/src/zcode-protocol-v4 与 tui 的接线。契约侧自绿（packages/shared typecheck 通过）即解锁 wave 2；bootstrap 包的整体 typecheck 在消费侧落地前允许带 mcp-ui 相关缺失，须如实报告。

## 状态所有者与关键不变量（搬 CONTRACT.md 的约定）

- McpUiInstances 是运行凭证唯一 owner：runtimeId、单调 generation、不可猜 token、稳定 appIdentity；同逻辑页面同连接的并发 open 幂等；close 先撤凭证再 abort。
- 页面只能选工具名与参数，不能选连接/会话/实例；callTool 检查 app visibility；原始 MCP 结果直接返回，不产生对话或 transcript row。
- 采样账本：每实例/任务/Agent 并发上限 1/4/8，60 秒绝对期限，单实例账本 ≤4096 项；先 pin 后执行，同代 operationId 不重放。
- resources/read 面向 UI 的结果去 \_meta；总大小 8 MiB、MIME 白名单、blob MIME 必填，违例返回 -32001 明确错误而非截断。
- 页面生命周期不新增 SQLite 表、不持久化 widgetState、不改 CommandInbox / Host owner/lease / continuous / replayable。

## 验收

- packages/shared typecheck 通过；mcp-ui 契约文件逐字节等于上游（除本仓注释去 markdown 强调）。
- 报告中列出搬运清单（文件 + 上游路径 aac47556:<path>）交 release-integrator 登记。
- 上游 schema 与三端类型的同构性由上游 contract.test 断言；CE 不跑 vitest，以 shared 自测（mcp-apps schema 单测，node:test）覆盖关键形状。
