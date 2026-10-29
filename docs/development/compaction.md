# 上下文压缩：microcompact 的工具名解析

## 1. 背景

microcompact 会把较旧的工具结果替换成占位文本。判断「哪些工具结果可清」时，原实现只看
provider 投影后的消息自身的 `toolName`。投影/合并后部分 tool result 只剩 `toolCallId`，
`toolName` 为空 ⇒ 这些结果不会被识别为候选，压缩省不出 token，长会话在上下文上限附近表现为
「压缩后仍然无响应」。

上游 3.16.2 的 X3 修复：让候选分类读取**权威目标身份**（原始 runtime entry 的 `toolName`），
token 估算仍旧使用真实 provider 包装。

## 2. 规则

- `maybeLocalMicrocompactMessages` 新增可选 `resolveToolResultName(message, index)`；
  未提供时行为与之前逐字节一致（只看 `message.toolName`）。
- `maybeLocalMicrocompactRuntimeEntries` 传入解析器：优先取 `buildProviderRequestMessages`
  的 `sourceEntries[index]`（非 attachment 时用其 `toolName`），否则回落投影消息自身。
- 解析结果仍必须通过 `compactableToolNames` 白名单；解析不出名字的结果保持原样。
- 不改变 token 估算、保留条数、错误结果/媒体结果的既有边界。

## 3. 验收

- 同一批 tool result 在 `toolName` 为空、解析器能给出白名单名字时，成为候选并被清理；
- 不提供解析器时仍是 `no_candidates`（等价既有行为）；
- 解析器给出非白名单名字时不清；
- 根 `typecheck`、`typecheck:cli`、`lint`、受影响的 core 测试通过。

## 4. 未验证

真实长会话在模型上下文上限附近的行为需要实机 provider 复现；本仓库用单元测试钉住分类规则。
