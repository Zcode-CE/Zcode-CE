# 工具搜索（F14 / `toolSearchMode`）

模型可见工具面的按需交付：常驻工具照旧进请求，其余工具只公告名字，模型用 `ToolSearch`
取定义、用 `DeferredToolCall` 调用。上游 3.16.2 的同名能力，分三轮落地：wave1 契约与纯模块
（task-56）、wave2 运行时接线（task-14）、wave3 协议与设置面（task-58）。

## 模式与解析

用户可请求四态（`ToolSearchMode`）：`off` / `auto` / `native` / `local`；解析后的
`ResolvedToolSearchMode` 不含 `auto`。

- `off`（缺省）：完整工具目录，两个控制入口不进请求，行为与没有本功能一致。
- `native`：provider 侧延迟加载，只有声明 `requestCapabilities.toolSearch.protocolSupported`
  的 provider 可用；请求带 `toolSearchEnabled`，adapter 注入 `advanced-tool-use-2025-11-20` beta
  头并编码 `tool_reference` / `defer_loading`。未声明时发送前显式报错，不静默降级。
- `local`：客户端目录搜索 + `DeferredToolCall` 包装执行。请求永不设 `toolSearchEnabled`
  （不发 beta、不带 `defer_loading`），定义在真实 tool result 位置展开成 `<functions>` 文本。
- `auto`：provider 声明 `defaultEnabled` 走 native，否则按工具调用能力退回 local/off。

入口两处、优先级不同：

1. 设置页「工具与权限 → 工具搜索」（`AppSettings.toolSearchMode`）——桌面/远控的常规入口。
   Host 在会话创建/恢复时经 runtime preferences 下发（`toolSearchMode`），CLI 写进
   `runtimeConfig.toolSearch.mode`；已运行会话不重读，改动只对新建会话生效。
2. CLI `--toolsearch-mode`（`apps/zcode-cli/packages/cli/src/tool-search-flag.ts`）—— 直连 CLI
   时显式指定；它不经过协议装配，因此不受设置页影响。

两处最终都写入 `runtimeConfig.toolSearch.mode`，子 Agent 继承，不写 session。

## 状态所有者

| 事实                  | 所有者                                                                                         | 说明                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 完整工具目录 + 元数据 | 工具注册表（`ToolMetadata.shouldDefer/alwaysLoad/searchHint`）                                 | 注册表只提供候选，不裁剪、不授权                                |
| 本次请求的曝光决策    | `prepareRuntimeProviderRequest`（`core/runtime/helpers/runtime-provider-request-messages.ts`） | 每次请求只做一次 `buildToolExposure`，同时产出 tools 与消息投影 |
| 已发现集合            | 历史里的 `tool_reference` 块 + compact 检查点                                                  | 无额外缓存；结果未提交/被取消不算发现                           |
| 包装身份              | `ToolCall.modelCallWrapper` + tool part metadata `modelCallWrapper`                            | 内部历史只存目标 name/input，包装标记只用于协议出口还原         |

## 曝光规则（`core/tool/search/exposure.ts`）

- 常驻：`alwaysLoad` 或未声明 `shouldDefer` 的工具；内置常驻含 Read/Write/Edit/Bash/Glob/Grep/
  Skill/Agent/AskUserQuestion/ToolSearch。其余内置工具（cron、todo、workflow、off-peak、js、
  Task 别名、send-message 等）声明 `shouldDefer: true`，部分带 `searchHint`。
- `native`：发送常驻 + 已发现 deferred 的完整 schema（后者带 `deferLoading`），其余只公告名字。
- `local`：发送常驻 + `ToolSearch` + `DeferredToolCall`；搜索命中的定义在结果位置展开。
- 无 deferred 工具或缺控制入口时整链关闭并记录 reason（`no_deferred_tools` /
  `provider_disabled` / `tool_unavailable`）；`config.getTools` 在解析为 off 时不暴露两个控制入口。

## 执行准入

`core/tool/deferred-call.ts` 的 `resolveDeferredToolCall` 是唯一解析边界，被三处共用：
turn-model-step（进入 assistant 历史之前）、turn-tools（part/事件/调度之前）、executor
`call-runner`（生命周期之前）。规则：

- 只接受 `local` 模式下、本次请求目录里含 `DeferredToolCall` 且目标为 client-executed
  deferred 工具的调用；常驻工具、provider 原生工具、控制入口自身、未注册目标一律拒绝。
- 拒绝保持包装身份，由 executor 产出配对的失败结果（`emitToolCallError`），不执行目标。
- 未搜索不是执行禁令：目录允许即可解包，缺 schema 的后果由目标工具参数校验承担，并在失败
  文本里提示先 `select:` 加载。
- 解包后复用普通调用的调度、校验、权限、Hook、超时、取消与结果格式，不递归第二套 executor。

## 持久化与冷恢复

- 工具结果的 `modelContent` 可为文本或 `tool_reference` 数组（`tool-result-metadata.ts` 的
  union）；`completedToolPartMetadata` 把引用块原样写入 part metadata。
- 冷恢复：`agent/tool-search-hydration.ts` 校验后还原引用块；`session-history-hydrator` 按
  part metadata 的 `modelCallWrapper` 恢复包装标记，按 `runtimeMessage` 恢复公告增量。
- 辅助请求：memory / goal verifier / compact summary 也走同一曝光决策（memory 摘掉 ToolSearch
  并恒为 off，verifier 无工具，compact 只保留 Read + 控制入口 + MCP 候选）。
- compact：`preCompactDiscoveredTools` 进 compact 检查点（`compact/manual.ts` 写、
  `compact-active` 产出），请求投影据此把 compact 前的发现继续算作已发现；压缩后按保留历史
  重建名称公告。
- 公告（`ToolSearchAnnouncementSchema` 的 added/removed/readded）以 system reminder
  （source `tool_search_announcement`）落盘，模型可见、UI/transcript 隐藏。请求投影在成功
  搜索的 tool result 之后追加一句 `Tool loaded.`，只进投影不写历史。

## 权限

`ToolSearch` 声明 `tool.search`（只读、无审批），`DeferredToolCall` 声明
`tool.deferred_call`（high 风险、需审批）；包装调用解包后按**目标工具**的权限与 Hook 判定。

## 不变量与验证

- `off` 与接入前逐字节一致：tools 列表、messages、tool part metadata 三处都有断言
  （`core/test/toolSearchWiring.test.ts`）。
- `native` 未声明能力时发送前失败；`local` 不发送 `toolSearchEnabled`。
- 设置面：`AppSettings.toolSearchMode` 四态经 runtime preferences 下发；老配置缺字段 = off，
  与接入前行为一致（`packages/shared/test/toolSearchMode.test.ts`）。
- 辅助请求与主请求共用同一曝光决策：memory（摘掉 ToolSearch、恒为 off）、goal verifier
  （`tools: []`）与 compact summary 都走 `prepareRuntimeProviderRequest`；off 下三者与改动前
  逐字节一致（`core/test/toolSearchWiring.test.ts` 的 deepEqual 断言）。
- CLI help（zh/en）包含 `--toolsearch-mode` 四态。
- Executor 级准入：`core/test/toolSearchExecutorAdmission.test.ts` 直接驱动 `executeToolCall`，
  断言 off 与「目录里没有目标」两条拒绝分支都不执行目标 handler、且发出配对失败事件。
- 仍缺：真实 provider E2E（native 的 beta 头与 `tool_reference` 网关行为）；TUI/桌面是否需要
  专门的 ToolSearch 卡片待评估（通用工具渲染未见异常）。
