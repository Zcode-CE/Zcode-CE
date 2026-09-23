// MCP tool bridge - projects MCP descriptors into core tool entries

import {
  modelMessageContentToText,
  ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
  ZCODE_MCP_ERROR_PRESENTATION_META_KEY,
  type JsonSchema,
  type McpPort,
  type McpToolCallResult,
  type McpToolDescriptor,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type ModelToolSideEffectScope,
  type PermissionCapabilityGroup,
  type RiskLevel,
} from "@zcode/contracts";
import { ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME as ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME } from "@zcode/shared";
import { OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION } from "@zcode/zcode-cua/frame-contract";
import type { ToolRegistry } from "../tool/registry.js";
import type { ToolEntry } from "../tool/types.js";
import { createToolRuleNameSet } from "../tool/tool-visibility.js";
import {
  asDataUrl,
  base64PayloadFromMcpImageData,
  normalizeMcpToolResultForModel,
} from "./image-normalization.js";
import { toMcpToolName, toModelVisibleMcpNamePart } from "./name.js";
import { isMcpToolDisabled } from "./tool-disabled.js";

export { toMcpToolName } from "./name.js";

export {
  HOST_NODE_REPL_IMAGE_MAX_DIMENSION,
  MCP_IMAGE_INLINE_BASE64_BYTES,
  MCP_IMAGE_INLINE_RAW_BYTES,
} from "./image-normalization.js";

const MCP_TOOL_TIMEOUT_MS = 30_000;
const OFFICIAL_CUA_PERMISSION_CAPABILITY_GROUP = "official_cua" satisfies PermissionCapabilityGroup;
const CUA_USER_TITLE_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  description:
    "Required short user-facing title in the user's language that describes why the app interface is being read without implementation terms such as CUA, MCP, or get_app_state",
} satisfies JsonSchema;
const ZCODE_CUA_CANONICAL_MODEL_PREFIX = "mcp__computer-use__";
const ZCODE_CUA_PROVIDER_SPELLING_ALIAS_PREFIX = "mcp__computer_use__";

export interface RegisterMcpToolsOptions {
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  /**
   * 工具级启停：server 名 → 该 server 被关闭的原始工具名集合。
   *
   * 语义与 `allowedTools`/`disallowedTools` **不同**，不能混为一谈：
   * 那两个是「本轮/本会话发给模型的工具面收窄」，被挡下的工具**仍在注册表里**，
   * 模型直呼时照样执行（见 `core/src/runtime/methods/turn-loop.ts` 的每轮过滤）。
   * `disabledToolsByServer` 挡在**注册面**：命中的工具根本不进 `ToolRegistry`，
   * 于是既不在 provider 工具表里，直呼也只会拿到 `ToolNotFound`。
   */
  disabledToolsByServer?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * 由 runtime 使用不可伪造的 product authority 凭据验明的官方 CUA server。
   * 名称本身不构成信任；省略时 fail-closed，所有 MCP 都按普通工具处理，
   * 不投影官方 CUA 规范名，也不挂载 provider 拼写别名。
   */
  officialCuaServerNames?: ReadonlySet<string>;
}

export interface RegisterMcpToolsResult {
  /** 实际进入注册表的工具名。 */
  registered: string[];
  /** 被工具级启停挡下的**原始**工具名（未进注册表的那批），供调用方记录与展示。 */
  disabledToolNames: string[];
}

export function registerMcpTools(
  registry: ToolRegistry,
  mcpPort: McpPort,
  descriptors: readonly McpToolDescriptor[],
  options: RegisterMcpToolsOptions = {},
): RegisterMcpToolsResult {
  const allowed = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const disallowed = createToolRuleNameSet(options.disallowedTools);
  const disabledByServer = options.disabledToolsByServer;
  const registered: string[] = [];
  const disabled: string[] = [];

  for (const descriptor of descriptors) {
    // 工具级启停判定必须**先于** allow 判定：三者都是收窄，取并集才安全。
    // 若把 `allowed` 放前面，一个既在 session allowlist、又被用户工具级关闭的工具会被放进来 ——
    // 那正是「用户关了它却还能用」。`disabledTools` 是唯一持久化、面向资源所有者的开关，
    // 与 transient 的 session 名单冲突时以前者为准。
    if (isMcpToolDisabled(descriptor, disabledByServer)) {
      disabled.push(descriptor.toolName);
      continue;
    }
    const officialCuaAuthorityVerified =
      options.officialCuaServerNames?.has(descriptor.serverName) === true;
    const descriptorName = toMcpToolName(descriptor);
    const name = toRegisteredMcpToolName(descriptor, officialCuaAuthorityVerified);
    // 官方 CUA 投影模型主名后，如果只按新名检查规则，升级前保存的 namespaced
    // denylist 会静默失效并放行。新旧名称任一命中 deny 即拒绝，任一命中 allow 即接受。
    if (allowed && !allowed.has(name) && !allowed.has(descriptorName)) continue;
    if (disallowed?.has(name) || disallowed?.has(descriptorName)) continue;
    registry.register(createMcpToolEntry(name, descriptor, mcpPort, officialCuaAuthorityVerified));
    registered.push(name);
  }

  // 关闭是**用户可见的能力变化**，与「注册成功但静默少几个工具」必须区分开：不把明细回传，
  // 用户只能通过「模型说没这个工具」反推自己的配置有没有生效。
  // 这里不自己打日志——core 的日志出口是注入的 logger，由调用方（runtime）统一记录。
  return { registered, disabledToolNames: disabled };
}

function toRegisteredMcpToolName(
  descriptor: McpToolDescriptor,
  officialCuaAuthorityVerified: boolean,
): string {
  if (
    officialCuaAuthorityVerified &&
    descriptor.serverName === ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME
  ) {
    // adapter 会把官方插件 serverName 命名空间化，descriptor.name 因而是
    // mcp__plugin_zcode-cua_computer-use__*；直接沿用它会让 provider 约定的 computer-use
    // 工具永远不存在。可信门成立后仅投影模型可见名称，handler 仍用 descriptor 的原路由。
    return `${ZCODE_CUA_CANONICAL_MODEL_PREFIX}${toModelVisibleMcpNamePart(descriptor.toolName)}`;
  }
  return toMcpToolName(descriptor);
}

function createMcpToolEntry(
  name: string,
  descriptor: McpToolDescriptor,
  mcpPort: McpPort,
  officialCuaAuthorityVerified: boolean,
): ToolEntry {
  const readOnly = descriptor.annotations?.readOnlyHint === true;
  const destructive = descriptor.annotations?.destructiveHint === true;
  const isHostNodeReplExecution =
    descriptor.serverName === "node_repl" && descriptor.toolName === "js";
  const isCuaAppObservation = isZCodeCuaGetAppState(descriptor);
  // 宿主 node_repl 的 js 能执行本机 Node 代码，不能沿用普通未知 MCP 的 medium/network
  // 默认值；否则权限 UI 会把文件/进程级能力错误描述成普通网络调用。
  const sideEffectScope: ModelToolSideEffectScope = isHostNodeReplExecution ? "system" : "network";
  const riskLevel: RiskLevel = isHostNodeReplExecution
    ? "high"
    : destructive
      ? "high"
      : readOnly
        ? "low"
        : "medium";
  const needsApproval = true;
  const timeoutMs = descriptor.timeoutMs ?? MCP_TOOL_TIMEOUT_MS;
  const resultBudget = officialCuaAuthorityVerified
    ? {
        // 图片 block 的 base64 不计入模型文本预算，但树文本仍可能超过普通 MCP 的
        // 50 KiB。这里给官方 CUA 足够的有界文本空间，避免通用截断把结构化
        // image/image_ref 退化成纯字符串或改变相邻顺序。
        maxInlineBytes: 256 * 1024,
        maxModelBytes: 256 * 1024,
        strategy: "truncate" as const,
        preview: { direction: "head" as const },
      }
    : isHostNodeReplExecution
      ? {
          maxInlineBytes: 1_000_000,
          maxModelBytes: 64 * 1024,
          strategy: "artifact" as const,
          preview: { direction: "tail" as const, maxBytes: 64 * 1024 },
          artifact: { enabled: true, retention: "session" as const },
        }
      : {
          maxInlineBytes: 100_000,
          maxModelBytes: 50_000,
          strategy: "truncate" as const,
          preview: { direction: "head" as const },
        };

  return {
    // 因精确查找直接返回 Tool not found。只在不可伪造的官方 authority 门成立且内部
    // serverName 仍是官方 namespaced 名时挂单向别名；provider 继续只看规范名称。
    aliases: officialCuaProviderSpellingAliases(name, descriptor, officialCuaAuthorityVerified),
    capability: `MCP tool exposed by ${descriptor.serverName}: ${descriptor.toolName}`,
    // 项目级 CUA 授权只能复用不可伪造的 official authority gate。
    // server/tool 名可以被第三方仿冒，因此绝不能用名称 wildcard 表达这一权限。
    ...(officialCuaAuthorityVerified
      ? {
          permissionCapabilityGroup: OFFICIAL_CUA_PERMISSION_CAPABILITY_GROUP,
          // 最终栅格和紧随其后的 image_ref 共同定义模型唯一可用的像素坐标系。
          // modelContentProtection 是唯一 Host authority；通用 resultBudget / hook
          // 投影据此不能截断、丢弃或重排这组块，避免并行 boolean 漂移。
          modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
        }
      : {}),
    inputSchema: createModelFacingMcpInputSchema(descriptor, isCuaAppObservation),
    outputSchema: McpToolOutputJsonSchema,
    metadata: {
      concurrentSafe: readOnly || descriptor.annotations?.idempotentHint === true,
      destructive,
      // 必须把 MCP tool 的 description 透传到 metadata，让 registry 把它带进模型输入，
      // 否则模型侧只看到 name + inputSchema，调用 MCP 工具时缺乏判断依据。
      description: descriptor.description,
      name,
      mcpPresentation: {
        serverName: descriptor.serverName,
        toolName: descriptor.toolName,
        ...(descriptor.description ? { description: descriptor.description } : {}),
        // 只有官方 MCP 的结果才允许携带被客户端信任的结构化标识（额度耗尽 / 无套餐）。
        ...(descriptor.official ? { official: true } : {}),
      },
      needsApproval,
      readOnly,
      riskLevel,
      sideEffectScope,
      timeoutMs,
    },
    permission: {
      permission: "mcp",
      reason: `MCP tool ${descriptor.serverName}/${descriptor.toolName} executes through an external server`,
      riskLevel,
      sideEffectScope,
      needsApproval,
      patternSources: ["toolName", "input", "network"],
      denyPriority: "beforeAsk",
    },
    resultBudget,
    timeout: {
      defaultMs: timeoutMs,
      allowCallOverride: false,
    },
    cancellation: {
      supported: true,
      cleanup: "bestEffort",
      userVisibleMessage: `MCP tool ${name} was cancelled`,
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
    handler: async (input, context) => {
      const result = await mcpPort.callTool(
        {
          serverName: descriptor.serverName,
          toolName: descriptor.toolName,
          arguments: toMcpRuntimeArguments(input, isCuaAppObservation),
          trace: {
            traceId: context.traceId,
            spanId: context.spanId,
            parentSpanId: context.parentSpanId,
            sessionId: context.sessionId,
            turnId: context.turnId,
          },
          runtimeScope: context.runtimeScope ?? "main",
          workspacePath: context.workingDirectory,
          ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
          ...(context.workspaceIdentity?.trim()
            ? {
                workspaceIdentity: context.workspaceIdentity.trim(),
                workspaceKey: context.workspaceIdentity.trim(),
              }
            : { workspaceKey: context.workingDirectory }),
          ...(context.turnId ? { turnId: context.turnId } : {}),
          clientMode: context.clientMode ?? "desktop-continuous",
          deliveryKind: context.deliveryKind ?? "desktop-continuous",
        },
        {
          signal: context.abortSignal,
          timeoutMs,
        },
      );
      // MCP server 会返回大 base64 图片；resultBudget 只看到图片占位文本，
      // 必须在 handler 阶段保存副本并替换模型可见内容，避免 provider 请求体被打爆。
      return normalizeMcpToolResultForModel({
        compressOversizedImages: isHostNodeReplExecution,
        context,
        descriptor,
        preserveOfficialCuaFrames: officialCuaAuthorityVerified,
        result,
        toolName: name,
      });
    },
    formatModelContent: (output) => formatMcpToolResult(output),
  };
}

function officialCuaProviderSpellingAliases(
  name: string,
  descriptor: McpToolDescriptor,
  officialCuaAuthorityVerified: boolean,
): readonly string[] | undefined {
  if (
    !officialCuaAuthorityVerified ||
    descriptor.serverName !== ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME ||
    !name.startsWith(ZCODE_CUA_CANONICAL_MODEL_PREFIX)
  ) {
    return undefined;
  }
  const toolName = name.slice(ZCODE_CUA_CANONICAL_MODEL_PREFIX.length);
  return toolName.length > 0
    ? [`${ZCODE_CUA_PROVIDER_SPELLING_ALIAS_PREFIX}${toolName}`]
    : undefined;
}

export const McpToolOutputJsonSchema = {
  type: "object",
  required: ["content"],
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
      },
    },
    structuredContent: {},
    isError: {
      type: "boolean",
    },
    _meta: {
      type: "object",
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} satisfies JsonSchema;

function normalizeInputSchema(schema: JsonSchema | undefined): JsonSchema {
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }

  return {
    ...schema,
    type: "object",
    properties:
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? schema.properties
        : {},
  };
}

function createModelFacingMcpInputSchema(
  descriptor: McpToolDescriptor,
  isCuaAppObservation: boolean,
): JsonSchema {
  const schema = normalizeInputSchema(descriptor.inputSchema);
  if (!isCuaAppObservation) return schema;

  const properties = schema.properties as Record<string, unknown>;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];

  // 原因：title 是 ZCode 给用户看的意图摘要，不属于上游 zcode-cua 参数。只在模型 contract
  // 叠加必填字段，runtime dispatch 再剥离，既让模型稳定生成可读标题，也保持上游严格 schema 兼容。
  return {
    ...schema,
    properties: {
      ...properties,
      title: CUA_USER_TITLE_SCHEMA,
    },
    required: [...new Set([...required, "title"])],
  };
}

function isZCodeCuaGetAppState(
  descriptor: Pick<McpToolDescriptor, "serverName" | "toolName">,
): boolean {
  if (descriptor.toolName.trim().toLowerCase().replace(/-/g, "_") !== "get_app_state") {
    return false;
  }

  const serverName = descriptor.serverName.trim().toLowerCase().replace(/_/g, "-");
  return (
    descriptor.serverName === ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME ||
    serverName === "zcode-cua" ||
    serverName === "computer-use" ||
    (serverName.includes("zcode-cua") && serverName.includes("computer-use"))
  );
}

function hasInformativeStructuredContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function formatMcpToolResult(output: unknown): ModelMessageContent {
  if (!isMcpToolCallResult(output)) {
    return stringify(output);
  }

  const blocks = output.content.flatMap(formatContentBlock);
  // 生产 adapter 会保留 structuredContent 的空键；undefined、null、空对象和
  // 空数组都没有模型信息，不能追加伪造的 "Structured content" 块。有内容的错误详情
  // 仍需保留，权限引导依赖这条结构化通道。
  if (hasInformativeStructuredContent(output.structuredContent)) {
    blocks.push({
      type: "text",
      text: `Structured content:\n${stringify(output.structuredContent)}`,
    });
  }

  const content = blocks.length > 0 ? collapseModelBlocks(blocks) : stringify(output);
  if (!output.isError) return content;
  // 展示策略由 MCP result 显式声明；通用 bridge 不应识别具体 server，
  // 也不应通过解析错误字符串来猜测哪些内容属于堆栈。
  const errorPresentation = output._meta?.[ZCODE_MCP_ERROR_PRESENTATION_META_KEY];
  return typeof errorPresentation === "string" &&
    errorPresentation === ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY
    ? content
    : `MCP tool returned an error:\n${modelMessageContentToText(content)}`;
}

function formatContentBlock(block: Record<string, unknown>): ModelMessageContentBlock[] {
  if (block.type === "text" && typeof block.text === "string") {
    return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];
  }
  if (block.type === "image") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
    if (typeof block.data === "string" && typeof block.mimeType === "string") {
      return [
        {
          type: "image",
          mediaType: block.mimeType,
          dataUrl: asDataUrl(block.data, block.mimeType),
          source: {
            id: "mcp-image",
            kind: "inline",
            mimeType: block.mimeType,
            placeholder: "MCP image",
            sizeBytes: estimateBase64Bytes(block.data),
          },
        },
      ];
    }
    return [{ type: "text", text: `[MCP image content omitted: ${mimeType}]` }];
  }
  if (block.type === "audio") {
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
    return [{ type: "text", text: `[MCP audio content omitted: ${mimeType}]` }];
  }
  if (block.type === "resource") {
    return [{ type: "text", text: `MCP resource content:\n${stringify(block.resource ?? block)}` }];
  }
  return [{ type: "text", text: stringify(block) }];
}

function collapseModelBlocks(blocks: ModelMessageContentBlock[]): ModelMessageContent {
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n\n");
  }
  return blocks;
}

function estimateBase64Bytes(value: string): number | undefined {
  const data = base64PayloadFromMcpImageData(value);
  if (data.length === 0) return undefined;
  return Math.floor((data.replace(/=+$/, "").length * 3) / 4);
}

function isMcpToolCallResult(value: unknown): value is McpToolCallResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as McpToolCallResult).content)
  );
}

function toRecordInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function toMcpRuntimeArguments(
  input: unknown,
  stripCuaUserTitle: boolean,
): Record<string, unknown> {
  const argumentsRecord = toRecordInput(input);
  if (!stripCuaUserTitle || !("title" in argumentsRecord)) return argumentsRecord;

  const runtimeArguments = { ...argumentsRecord };
  delete runtimeArguments.title;
  return runtimeArguments;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
