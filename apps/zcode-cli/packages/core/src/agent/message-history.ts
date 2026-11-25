// Modified by ZCode: 自上游 zai-org/ZCode v3.18.2 (fec97590, Apache-2.0) 并入本波数据完整性与
// 内容块顺序修复（会话行逐行降级 / blockIndex / 迁移 0023–0026 / schema_too_new 守卫）。
// ============================================================
// Message History - Maintains conversation context across turns
// ============================================================

import {
  type RuntimeInputPresentation,
  type ModelCallWrapper,
  isBlockIndex,
  modelMessageContentToText,
  type ModelCacheControl,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type Model,
  type ModelReasoningContentBlock,
  type ModelTextContentBlock,
  type ModelToolCall,
  type TokenUsageInfo,
} from "@zcode/contracts";
import { SYSTEM_REMINDER_SOURCES, type SystemReminderSource } from "../system-reminder/source.js";

// Tool call from model (simple type, no brand)
export interface ToolCallInput {
  /** 仅当这次调用由 DeferredToolCall 包装产生时存在；执行链按目标 name/input 判定。 */
  modelCallWrapper?: ModelCallWrapper;
  id: string;
  name: string;
  input: unknown;
  /** 本次响应内的块到达序号；旧数据可缺失，见上游 v3.18.2 docs/design/v2/model/assistant-block-order.md。 */
  blockIndex?: number;
}

// 仅模型协议出口和原始调用诊断使用；内部消费者始终读取目标 name/input。
export function toModelToolCall(call: ToolCallInput): ModelToolCall {
  if (!call.modelCallWrapper) return call;
  return {
    id: call.id,
    name: call.modelCallWrapper,
    input: { name: call.name, input: call.input },
    ...(call.blockIndex !== undefined ? { blockIndex: call.blockIndex } : {}),
  };
}

export type ReasoningContentInput = ModelReasoningContentBlock;

export interface ModelInputMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;
  cacheControl?: ModelCacheControl;
  toolCalls?: ToolCallInput[];
  toolCallId?: string;
  toolName?: string;
  /** 包装标记只为协议出口保存；内部历史用它还原外层 DeferredToolCall 调用。 */
  modelCallWrapper?: ModelCallWrapper;
  isError?: boolean;
  providerId?: Model["providerId"];
  modelId?: Model["modelId"];
}

export type RuntimeMessageSource =
  | SystemReminderSource
  | "shared_context"
  | "real_user"
  | "legacy_synthetic";

export interface RuntimeMessageMetadata {
  /** compact 保留的已发现工具名：丢了它会把交付过的 deferred 工具重新公告一遍。 */
  compactBoundary?: { boundaryId: string; preCompactDiscoveredTools?: readonly string[] };
  /** ToolSearch 公告增量（模型可见文案由它重建；readded ⊂ added）。 */
  toolSearchAnnouncement?: {
    addedNames: readonly string[];
    removedNames: readonly string[];
    readdedNames: readonly string[];
  };
  source: RuntimeMessageSource;
  inputPresentation?: RuntimeInputPresentation;
}

export interface RuntimeMessageMessageEntry {
  kind?: "message";
  message: ModelInputMessage;
  metadata?: RuntimeMessageMetadata;
  /** 已提交 assistant 自己的 provider tokens；不会发送到 provider。 */
  tokens?: TokenUsageInfo;
  /** 仅在当前 query 内生效；不得进入 canonical history 或 Session persistence。 */
  queryScope?: "output_token_continuation";
}

export interface RuntimeAttachmentEntry {
  kind: "attachment";
  content: string;
  cacheControl?: ModelCacheControl;
  metadata: RuntimeMessageMetadata;
}

export type RuntimeMessageEntry = RuntimeMessageMessageEntry | RuntimeAttachmentEntry;

export interface CacheStats {
  totalMessages: number;
  cachedMessages: number;
  lastCacheHit: boolean;
  cacheReadTokens?: number;
}

// ============================================================
// Message History Interface
// ============================================================

export interface MessageHistory {
  // Initialize with optional system prompt or context prefix messages
  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void;

  // Add user message
  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void;

  // Add structured internal context that provider projection renders at request time.
  addAttachment(source: SystemReminderSource, content: string): void;

  // Add already-built runtime entries while preserving their source metadata.
  addEntries(entries: readonly RuntimeMessageEntry[]): void;

  // Add assistant message (may include tool calls)
  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void;

  // Add tool result
  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError?: boolean,
    modelCallWrapper?: ModelCallWrapper,
  ): void;

  // 借用当前权威 entries，只允许同步只读；跨异步边界时由调用方做数组浅快照。
  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[];

  // 创建可写的防御性副本；Runtime 内部普通只读点应使用 borrowReadOnlyRuntimeEntries。
  toRuntimeEntries(): RuntimeMessageEntry[];

  // Replace the active provider-visible history after compact/rewind.
  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void;

  // Get current message count
  getMessageCount(): number;

  // Cache management
  getCacheStats(): CacheStats;
  setCacheHit(tokens?: number): void;
  setCacheMiss(): void;

  // Reset for new turn
  reset(): void;
}

// ============================================================
// Message History Implementation
// ============================================================

export class MessageHistoryImpl implements MessageHistory {
  private entries: RuntimeMessageEntry[] = [];
  private cacheStats: CacheStats = {
    totalMessages: 0,
    cachedMessages: 0,
    lastCacheHit: false,
  };

  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void {
    this.entries = [];

    if (typeof systemPromptOrMessages === "string" && systemPromptOrMessages.length > 0) {
      this.entries.push({
        message: {
          role: "system",
          content: systemPromptOrMessages,
        },
      });
    } else if (Array.isArray(systemPromptOrMessages)) {
      this.entries.push(...systemPromptOrMessages.map(cloneEntryInput));
    }

    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void {
    this.entries.push(createRuntimeUserEntry(content, metadata));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAttachment(source: SystemReminderSource, content: string): void {
    this.entries.push(systemReminderAttachmentEntry(source, content));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addEntries(entries: readonly RuntimeMessageEntry[]): void {
    this.entries.push(...entries.map(cloneRuntimeMessageEntry));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void {
    const reasoningBlocks = reasoning?.map((block) => cloneReasoningBlock(block)) ?? [];
    this.entries.push({
      message: {
        role: "assistant",
        content:
          reasoningBlocks.length > 0
            ? [
                ...reasoningBlocks,
                ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
              ]
            : content,
        toolCalls: toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
          ...(tc.modelCallWrapper ? { modelCallWrapper: tc.modelCallWrapper } : {}),
        })),
        ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
      },
      ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
    });
    this.cacheStats.totalMessages = this.entries.length;
  }

  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError = !success,
    modelCallWrapper?: ModelCallWrapper,
  ): void {
    this.entries.push(
      createRuntimeToolResultEntry(toolCallId, toolName, content, isError, modelCallWrapper),
    );
    this.cacheStats.totalMessages = this.entries.length;
  }

  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[] {
    return this.entries;
  }

  toRuntimeEntries(): RuntimeMessageEntry[] {
    return this.entries.map(cloneRuntimeMessageEntry);
  }

  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void {
    this.entries = messages.map(cloneEntryInput);
    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  getMessageCount(): number {
    return this.entries.length;
  }

  getCacheStats(): CacheStats {
    return { ...this.cacheStats };
  }

  setCacheHit(tokens?: number): void {
    this.cacheStats.lastCacheHit = true;
    this.cacheStats.cacheReadTokens = tokens;
    // Mark all messages as potentially cached
    this.cacheStats.cachedMessages = this.entries.length;
  }

  setCacheMiss(): void {
    this.cacheStats.lastCacheHit = false;
    this.cacheStats.cacheReadTokens = undefined;
    this.cacheStats.cachedMessages = countContextPrefixMessages(this.entries);
  }

  reset(): void {
    const contextPrefixMessages = this.entries.slice(0, countContextPrefixMessages(this.entries));
    this.entries = contextPrefixMessages.map(cloneRuntimeMessageEntry);
    this.cacheStats = {
      totalMessages: contextPrefixMessages.length,
      cachedMessages: contextPrefixMessages.length,
      lastCacheHit: false,
    };
  }
}

export function countContextPrefixMessages(
  messagesOrEntries: readonly (ModelInputMessage | RuntimeMessageEntry)[],
): number {
  let count = 0;
  for (const item of messagesOrEntries) {
    if (isRuntimeAttachmentEntry(item)) {
      if (item.metadata.source === "context_prefix" || item.metadata.source === "skills_listing") {
        count++;
        continue;
      }
      break;
    }
    const message = messageFromEntryInput(item);
    const metadata = metadataFromEntryInput(item);
    if (message.role === "system") {
      count++;
      continue;
    }
    if (message.role !== "user") break;
    if (metadata) {
      if (metadata.source === "context_prefix" || metadata.source === "skills_listing") {
        count++;
        continue;
      }
      break;
    }
    if (isMetaUserContext(message.content)) {
      count++;
      continue;
    }
    break;
  }
  return count;
}

function isMetaUserContext(content: ModelMessageContent): boolean {
  return modelMessageContentToText(content).trimStart().startsWith("<system-reminder>");
}

export function systemReminderRuntimeMetadata(
  source: SystemReminderSource,
): RuntimeMessageMetadata {
  return { source };
}

export function realUserRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "real_user" };
}

export function legacySyntheticRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "legacy_synthetic" };
}

export function todoReminderRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "todo_reminder" };
}

export function systemReminderAttachmentEntry(
  source: SystemReminderSource,
  content: string,
): RuntimeAttachmentEntry {
  return {
    kind: "attachment",
    content,
    metadata: systemReminderRuntimeMetadata(source),
  };
}

export function createRuntimeUserEntry(
  content: ModelMessageContent,
  metadata?: RuntimeMessageMetadata,
): RuntimeMessageMessageEntry {
  return {
    message: {
      role: "user",
      content,
    },
    metadata: cloneRuntimeMessageMetadata(metadata),
  };
}

export function createRuntimeAssistantEntry(
  content: string,
  toolCalls?: readonly ToolCallInput[],
  reasoning?: readonly ReasoningContentInput[],
  model?: Pick<Model, "providerId" | "modelId">,
  tokens?: TokenUsageInfo,
): RuntimeMessageMessageEntry {
  // 旧条目不带 blockIndex。修复原因：非流式结果会在原对象上给 reasoning 编号，原样复制会让旧条目
  // 部分带序号，只有思考块时还会被请求投影当成有序条目（上游 v3.18.2 assistant-block-order.md）。
  const reasoningBlocks =
    reasoning?.map(({ blockIndex: _blockIndex, ...block }) => cloneReasoningBlock(block)) ?? [];
  return {
    message: {
      role: "assistant",
      content:
        reasoningBlocks.length > 0
          ? [
              ...reasoningBlocks,
              ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
            ]
          : content,
      toolCalls: toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        ...(toolCall.modelCallWrapper ? { modelCallWrapper: toolCall.modelCallWrapper } : {}),
      })),
      ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
    },
    ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
  };
}

// ============================================================
// assistant 内容块顺序（blockIndex）
// ============================================================
// 设计依据：上游 zai-org/ZCode v3.18.2 的 apps/zcode-cli/docs/design/v2/model/assistant-block-order.md。
// CE 没有服务端内置工具轮次：一条持久化 assistant 消息始终产出一条 assistant entry，
// 所以这里只有 content 与 tool 两种块，也没有 compact 分组键。

/**
 * 有序 assistant 的一个块。所有块都带 blockIndex；旧数据（缺序号）走 createRuntimeAssistantEntry。
 */
export type AssistantHistoryBlock =
  | { kind: "content"; block: ModelReasoningContentBlock | ModelTextContentBlock }
  | { kind: "tool"; call: ToolCallInput };

function assistantHistoryBlockIndex(block: AssistantHistoryBlock): number | undefined {
  return block.kind === "content" ? block.block.blockIndex : block.call.blockIndex;
}

export function hasOrderedAssistantHistoryBlocks(
  blocks: readonly AssistantHistoryBlock[],
): boolean {
  return blocks.every((block) => isBlockIndex(assistantHistoryBlockIndex(block)));
}

/**
 * live 与冷恢复构造有序 assistant 条目的唯一入口，两条路径因此产出相同条目。
 * - 按 blockIndex 稳定排序；去掉没有内容的 reasoning 和空字符串文字；文字块不合并。
 * - 本地工具都放进同一个条目；usage 照旧附加。
 * 维护约束：新增写入点时每次写入都要带 blockIndex，漏写一次这条消息就静默按旧数据排序。
 */
export function buildAssistantEntries(input: {
  blocks: readonly AssistantHistoryBlock[];
  model?: Pick<Model, "providerId" | "modelId">;
  tokens?: TokenUsageInfo;
  /** 冷恢复保留带 usage 的空 assistant 作为上下文估算锚点。 */
  keepEmptyFinal?: boolean;
}): RuntimeMessageMessageEntry[] {
  const sorted = [...input.blocks].sort(
    (left, right) => assistantHistoryBlockIndex(left)! - assistantHistoryBlockIndex(right)!,
  );
  const content: Array<ModelReasoningContentBlock | ModelTextContentBlock> = [];
  const toolCalls: ToolCallInput[] = [];
  for (const block of sorted) {
    if (block.kind === "tool") {
      toolCalls.push(cloneOrderedToolCall(block.call));
      continue;
    }
    const keep =
      block.block.type === "reasoning"
        ? hasAssistantReasoningContent(block.block)
        : block.block.text.length > 0;
    if (keep) content.push(cloneOrderedContentBlock(block.block));
  }
  if (content.length === 0 && toolCalls.length === 0 && !input.keepEmptyFinal) return [];
  return [
    createOrderedAssistantEntry(
      content,
      toolCalls.length > 0 ? toolCalls : undefined,
      input.model,
      input.tokens,
    ),
  ];
}

// 旧条目与有序条目共用的条目外壳，两条路径的 message 字段因此一致。
function assistantEntry(
  content: ModelMessageContent,
  toolCalls: ToolCallInput[] | undefined,
  model: Pick<Model, "providerId" | "modelId"> | undefined,
  tokens: TokenUsageInfo | undefined,
): RuntimeMessageMessageEntry {
  return {
    message: {
      role: "assistant",
      content,
      ...(toolCalls ? { toolCalls } : {}),
      ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
    },
    ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
  };
}

function createOrderedAssistantEntry(
  content: Array<ModelReasoningContentBlock | ModelTextContentBlock>,
  toolCalls: ToolCallInput[] | undefined,
  model: Pick<Model, "providerId" | "modelId"> | undefined,
  tokens?: TokenUsageInfo,
): RuntimeMessageMessageEntry {
  // 没有内容块时与旧条目一样用空字符串，避免空数组走不同的 provider 序列化。
  return assistantEntry(content.length > 0 ? content : "", toolCalls, model, tokens);
}

// 只复制模型历史需要的字段；providerExecuted 等运行时标记不进入历史，live 与冷恢复构造的结果一致。
function cloneHistoryToolCall(call: ToolCallInput): ToolCallInput {
  return {
    id: call.id,
    name: call.name,
    input: call.input,
    ...(call.modelCallWrapper ? { modelCallWrapper: call.modelCallWrapper } : {}),
  };
}

function cloneOrderedContentBlock(
  block: ModelReasoningContentBlock | ModelTextContentBlock,
): ModelReasoningContentBlock | ModelTextContentBlock {
  return block.type === "reasoning"
    ? cloneReasoningBlock(block)
    : { type: "text", text: block.text, blockIndex: block.blockIndex };
}

function cloneOrderedToolCall(call: ToolCallInput): ToolCallInput {
  return { ...cloneHistoryToolCall(call), blockIndex: call.blockIndex };
}

export function hasAssistantReasoningContent(reasoning: ModelReasoningContentBlock): boolean {
  return reasoning.text.length > 0 || Object.keys(reasoning.providerOptions ?? {}).length > 0;
}

export function createRuntimeToolResultEntry(
  toolCallId: string,
  toolName: string,
  content: ModelMessageContent,
  isError: boolean,
  modelCallWrapper?: ModelCallWrapper,
): RuntimeMessageMessageEntry {
  return {
    message: {
      role: "tool",
      content,
      toolCallId,
      toolName,
      ...(modelCallWrapper ? { modelCallWrapper } : {}),
      isError,
    },
  };
}

export function isKnownSystemReminderSource(value: unknown): value is SystemReminderSource {
  return (
    typeof value === "string" && SYSTEM_REMINDER_SOURCES.includes(value as SystemReminderSource)
  );
}

function cloneEntryInput(input: ModelInputMessage | RuntimeMessageEntry): RuntimeMessageEntry {
  if (isRuntimeMessageEntry(input)) {
    return cloneRuntimeMessageEntry(input);
  }
  return { message: cloneModelInputMessage(input) };
}

export function cloneRuntimeMessageEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  if (entry.kind === "attachment") {
    return {
      kind: "attachment",
      content: entry.content,
      cacheControl: entry.cacheControl ? { ...entry.cacheControl } : undefined,
      metadata: cloneRuntimeMessageMetadata(entry.metadata)!,
    };
  }
  return {
    message: cloneModelInputMessage(entry.message),
    metadata: cloneRuntimeMessageMetadata(entry.metadata),
    ...(entry.tokens ? { tokens: cloneTokenUsageInfo(entry.tokens) } : {}),
    ...(entry.queryScope ? { queryScope: entry.queryScope } : {}),
  };
}

/**
 * Compact 之后 preserved assistant 的 provider usage 仍属于被替换的旧前缀。
 * 只对 projection 副本清零，不能改写 SessionStore 中的原始 tokens。
 */
export function invalidateRuntimeTokenUsage(tokens: TokenUsageInfo): TokenUsageInfo {
  return {
    ...tokens,
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  };
}

function cloneTokenUsageInfo(tokens: TokenUsageInfo): TokenUsageInfo {
  return {
    ...tokens,
    cache: { ...tokens.cache },
  };
}

function cloneRuntimeMessageMetadata(
  metadata: RuntimeMessageMetadata | undefined,
): RuntimeMessageMetadata | undefined {
  if (!metadata) return undefined;
  // 这两份是可变的名称集合：请求投影会拿它做增删公告与 compact 提升，
  // 深拷贝保证 projection 的改动不会写回 canonical 历史。
  return {
    ...metadata,
    ...(metadata.compactBoundary
      ? {
          compactBoundary: {
            ...metadata.compactBoundary,
            preCompactDiscoveredTools: metadata.compactBoundary.preCompactDiscoveredTools
              ? [...metadata.compactBoundary.preCompactDiscoveredTools]
              : undefined,
          },
        }
      : {}),
    ...(metadata.toolSearchAnnouncement
      ? {
          toolSearchAnnouncement: {
            addedNames: [...metadata.toolSearchAnnouncement.addedNames],
            removedNames: [...metadata.toolSearchAnnouncement.removedNames],
            readdedNames: [...metadata.toolSearchAnnouncement.readdedNames],
          },
        }
      : {}),
  };
}

function messageFromEntryInput(input: ModelInputMessage | RuntimeMessageEntry): ModelInputMessage {
  if (isRuntimeAttachmentEntry(input)) {
    throw new Error("Runtime attachment entries do not have a direct model message representation");
  }
  return isRuntimeMessageEntry(input) ? input.message : input;
}

function metadataFromEntryInput(
  input: ModelInputMessage | RuntimeMessageEntry,
): RuntimeMessageMetadata | undefined {
  return isRuntimeMessageEntry(input) ? input.metadata : undefined;
}

function isRuntimeMessageEntry(
  input: ModelInputMessage | RuntimeMessageEntry,
): input is RuntimeMessageEntry {
  return "message" in input || ("kind" in input && input.kind === "attachment");
}

export function isRuntimeAttachmentEntry(
  input: ModelInputMessage | RuntimeMessageEntry,
): input is RuntimeAttachmentEntry {
  return isRuntimeMessageEntry(input) && "kind" in input && input.kind === "attachment";
}

export function cloneModelInputMessage(message: ModelInputMessage): ModelInputMessage {
  const next: ModelInputMessage = {
    role: message.role,
    content: cloneModelMessageContent(message.content),
  };
  if (message.cacheControl) next.cacheControl = { ...message.cacheControl };
  if (message.toolCalls) next.toolCalls = message.toolCalls.map((toolCall) => ({ ...toolCall }));
  if (message.toolCallId) next.toolCallId = message.toolCallId;
  // 空字符串是可恢复调用的 provider 原始名称，不能在 request-local clone 时按 falsy 丢失。
  if (message.toolName !== undefined) next.toolName = message.toolName;
  if (message.modelCallWrapper) next.modelCallWrapper = message.modelCallWrapper;
  if (message.isError !== undefined) next.isError = message.isError;
  if (message.providerId) next.providerId = message.providerId;
  if (message.modelId) next.modelId = message.modelId;
  return next;
}

function cloneReasoningBlock(block: ReasoningContentInput): ReasoningContentInput {
  return {
    ...block,
    providerOptions: block.providerOptions ? { ...block.providerOptions } : undefined,
  };
}

export function cloneModelMessageContent(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return content;
  return content.map(cloneModelMessageContentBlock);
}

function cloneModelMessageContentBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  if (block.type === "reasoning") {
    return cloneReasoningBlock(block);
  }
  if ("source" in block && block.source) {
    return { ...block, source: { ...block.source } };
  }
  return { ...block };
}

// ============================================================
// Factory
// ============================================================

export function createMessageHistory(): MessageHistory {
  return new MessageHistoryImpl();
}
