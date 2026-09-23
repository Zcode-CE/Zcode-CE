// MCP Port - Model Context Protocol adapter boundary

import type { JsonSchema } from "../model/index.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { McpServerFailureKind, OfficialMcpAuthPortFailureReason } from "@zcode/shared";

export type McpServerTransportType = "stdio" | "http" | "sse";
export type McpProtocolVersion = "legacy" | "auto" | "2026-07-28";
export type McpServerIsolation = "session" | "workspace";

/** 公共 MCP 配置校验完成后由宿主附加的运行时来源。 */
export interface McpServerRuntimeSource {
  kind: "builtin" | "plugin";
}

/**
 * 单个 MCP server 最多可关闭的工具数 —— **从唯一所有者重新导出**。
 *
 * 定义住在 `@zcode/shared/mcpDisabledTools`（叶子模块，不依赖任何本仓模块）：wire schema、
 * Agent DTO 投影与这里的 CLI 配置 schema 必须共用同一个上限与同一份归一化实现，
 * 各写一份同值常量只会各自漂移。依赖方向是单向的 `contracts → shared`，所以由本文件重新导出。
 *
 * 保留本模块原有的导出名（`MCP_SERVER_MAX_DISABLED_TOOLS` / `NormalizedMcpDisabledTools`），
 * 避免既有调用点（adapters / bootstrap / core）改 import 路径。
 */
export {
  normalizeMcpDisabledTools,
  MCP_SERVER_MAX_DISABLED_TOOLS,
} from "@zcode/shared/mcpDisabledTools";
export type { NormalizedMcpDisabledTools } from "@zcode/shared/mcpDisabledTools";

/**
 * server 配置对象内按工具名关闭该 server 的部分工具（工具精细化管理）。
 *
 * 语义与 `enabled` 正交且更细：`enabled: false` 关整包，`disabledTools` 关其中几个工具。
 * 与 `enabled` **同对象、同文件、同写入者**（`~/.zcode/cli/config.json` 的 `mcp.servers`），
 * 不另设全局工具 deny 清单——两处可写会让「UI 显示的状态」与「真正生效的状态」漂移。
 *
 * 条目是 **server 自己 `tools/list` 返回的原始工具名**（`McpToolDescriptor.toolName`），
 * 不是模型可见名（`mcp__<server>__<tool>`）：原始名在 server 内唯一，模型可见名会随 server 名变化。
 * 作用域是**单个 server**，不同 server 的同名工具互不影响。
 */
export interface McpServerConfigBase {
  enabled?: boolean;
  disabledTools?: string[];
  isolation?: McpServerIsolation;
  protocolVersion?: McpProtocolVersion;
  /** 仅限宿主生成，公共配置 schema 会拒绝该字段。 */
  source?: McpServerRuntimeSource;
  timeoutMs?: number;
}

export interface McpClientCredentialsOAuthConfig {
  type: "client_credentials";
  clientId: string;
  clientSecret: string;
  clientName?: string;
  scope?: string;
}

export interface McpAuthorizationCodeOAuthConfig {
  type: "authorization_code";
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPath?: string;
  scope?: string;
}

export type McpOAuthConfig = McpAuthorizationCodeOAuthConfig | McpClientCredentialsOAuthConfig;

/**
 * ZCode 官方 Server MCP 的鉴权声明。
 * 允许出现在 `type: "http"` 与 `type: "stdio"`；`sse` 仍拒。
 * `type`/`provider` 均为精确值，不接受别名或大小写变体。
 *
 * 注意：该字段本身**不构成**官方身份证明。官方身份由运行时解析的 ZCode API origin 判定
 * （host 侧还会二次校验）；第三方 Plugin 复制该字段只能让凭证流向真实 ZCode 后端。
 *
 * 两种形态的凭证投递通道不同：
 * - http：宿主在 fetch wrapper 里逐请求注入身份头，凭证从不进入插件进程；
 * - stdio：请求由插件进程自己发出，身份头随每条出站协议消息的 `_meta` 下发。
 */
export interface ZCodeOfficialMcpAuthConfig {
  type: "zcode_official";
  provider: "jwt_token";
}

/**
 * Plugin loader 生成的运行时归属信息，`.mcp.json` 不能覆盖。
 * 用于凭据解析和日志关联，不参与信任判定。
 * 目标 origin 必须通过 `isOfficialMcpOriginTrusted` 的校验；插件身份本身不构成
 * 授权过滤条件。目的地校验与服务端接口权限、套餐、配额校验分别承担不同边界。
 */
export interface McpOfficialProvenance {
  pluginId: string;
  /** Plugin 内的原始 MCP key（未加 `plugin:<name>:` 命名空间前缀）。 */
  mcpKey: string;
  source: "plugin";
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  auth?: ZCodeOfficialMcpAuthConfig;
  /** 宿主生成，禁止来自文件配置。 */
  official?: McpOfficialProvenance;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  auth?: ZCodeOfficialMcpAuthConfig;
  /** 宿主生成，禁止来自文件配置。 */
  official?: McpOfficialProvenance;
}

export interface McpSseServerConfig extends McpServerConfigBase {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export type McpServerStatusKind =
  | "connecting"
  | "connected"
  | "disabled"
  | "disconnected"
  | "failed"
  | "untrusted";

export interface McpServerStatus {
  status: McpServerStatusKind;
  transport: McpServerTransportType;
  toolCount: number;
  updatedAt: string;
  error?: string;
  failureKind?: McpServerFailureKind;
  serverRequestId?: string;
  protocolEra?: "legacy" | "modern";
  authorization?: {
    type: "oauth_authorization_code";
    authorizationUrl: string;
    startedAt: string;
  };
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export const ZCODE_MCP_ERROR_PRESENTATION_META_KEY = "zcode/errorPresentation";
export const ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY = "message-only";
/** MCP content 中来自模型显式 tab.screenshot() 的 image block 索引。 */
export const ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY =
  "zcode/browserScreenshotContentIndices";
/**
 * 本次 node_repl cell 操作的目标应用身份，供工具卡显示 App 图标。
 *
 * **只能由 node-repl-host 写入**：宿主的 CUA bridge 从 broker 响应里读 producer 的
 * `zcode.cua/app-associations-v1`，投影成这里的最小形态。producer 那个键本身经
 * `nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult` 也能到达 `_meta`，而这两个
 * API 挂在模型可见的 sandbox globals 上，因此不可信、必须在宿主侧丢弃（同
 * `ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY` 的处置）。
 */
export const ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY = "zcode/nodeReplCuaApp";
/**
 * 官方 Server MCP 响应头里的 `x-request-id`，附在失败的 tool result 上（值为 string）。
 *
 * 用短前缀 `zcode/` 而不是 `com.zcode/`：这不是跨语言协议——服务端在 header 里给，客户端
 * 读到后自己搬进 `_meta`，产出与消费都在客户端（`com.zcode/` 留给 Go 侧直接产出的键，
 * 如 `com.zcode/mcp-unavailable`）。
 *
 * 只在 `isError` 时附加：这是给人看的排障线索（拿它去查服务端日志），成功路径上是纯噪声。
 */
export const ZCODE_MCP_SERVER_REQUEST_ID_META_KEY = "zcode/officialMcpServerRequestId";

export interface McpToolDescriptor {
  serverName: string;
  toolName: string;
  name?: string;
  description?: string;
  timeoutMs?: number;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
  /**
   * 该 tool 的结果**可信到足以据此改变界面**：来自 `type: "http"` 且声明
   * `auth.type = zcode_official` 的 MCP server。
   *
   * 唯一用途是信任结果里的结构化标识（额度耗尽 / 无套餐的 `error_code`）。判据是"结果由谁产出"
   * 而不是"插件是谁"：
   * - http：响应来自 ZCode 后端。连接存活即意味着每个请求都过了 origin 校验且 fail closed，
   *   第三方插件即使声明官方鉴权，也只能把请求打到真实 ZCode，响应体不由它写；
   * - stdio：结果由插件进程自己产出、可任意伪造，因此**不置位**。
   *
   * 刻意**不**按"插件是否来自官方 marketplace"判定：那会让非官方安装源（含本地自测与
   * zcode-plugins-test）的官方插件失效，而它也不是真实屏障——详见 `@zcode/shared` 的
   * `isOfficialMcpOriginTrusted`。
   */
  official?: boolean;
}

export type McpContentBlock = Record<string, unknown>;

export interface McpToolCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpConnectionSnapshot {
  statuses: Record<string, McpServerStatus>;
  tools: McpToolDescriptor[];
}

export interface McpConnectOptions {
  /**
   * authorization_code OAuth callback 的等待上限。
   * 普通 MCP timeoutMs 只约束协议请求，session 启动需要单独限制 OAuth 授权等待。
   */
  oauthAuthorizationTimeoutMs?: number;
  /**
   * 复用既有连接前先校验其存活性（见 McpPort.pingServer），已死则重连。
   * 设置页刷新这类"用户明确要求重新探测"的调用必须置位；session 启动不需要，
   * 复用池中刚建立的连接即可。
   */
  revalidate?: boolean;
  signal?: AbortSignal;
  trace?: TraceContext;
  workingDirectory?: string;
  /** 身份隔离使用 workspaceIdentity；本地缺省时才 fallback 到 workingDirectory。 */
  workspaceIdentity?: string;
}

export interface McpCallToolRequest {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  trace?: TraceContext;
  /** 调用来源；宿主 MCP 可据此限制不能安全继承到 subagent 的能力。 */
  runtimeScope?: "main" | "subagent";
  /** 请求上下文仅用于 shared-host 隔离，不改变 MCP tool 参数。 */
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: string;
  deliveryKind?: string;
  turnId?: string;
}

export interface McpCallToolOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * 端口层失败分类（"不发任何请求"的几类）。
 * `official_mcp_origin_untrusted` 可能来自 adapter 本地校验，也可能来自 host 侧二次校验。
 */
export type OfficialMcpAuthFailureReason = OfficialMcpAuthPortFailureReason;

export type OfficialMcpAuthHeadersResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * MCP adapter 消费身份头的依赖注入端口。
 * adapter 不直接依赖 `packages/services`；Agent 进程经该端口向 host 索取本次请求的身份头。
 *
 * 失败必须走返回值而非抛异常，调用方禁止从错误文本解析原因。
 * `workspaceIdentity` / `workspacePath` / `pluginId` / `mcpKey` / `targetOrigin`
 * 仅用于路由、二次校验与审计，**不参与凭证选择**——凭证是 host 全局状态。
 */
export interface OfficialMcpAuthHeadersPort {
  resolveHeaders(input: {
    pluginId: string;
    mcpKey: string;
    targetOrigin: string;
    workspaceIdentity?: string;
    workspacePath?: string;
    signal?: AbortSignal;
  }): Promise<OfficialMcpAuthHeadersResult>;
}

/**
 * 官方 MCP 信任判定。
 *
 * 规则只有一条：**目标 origin 逐字符等于当前 ZCode API origin（https、无 username/password）**，
 * 另有仅放开 http loopback 的本地自测开关。`pluginId` / `mcpKey` 传进来只用于日志与凭证解析
 * 归属，**不影响判定结果**——曾经的"必须是官方 marketplace 插件"那道检查已于 2026-08 移除
 * （它让官方插件在发布前无法对真实端点自测，而第三方插件本可用 hook 读到同一份凭证，
 * 并非真实屏障）。
 *
 * 实现在 `@zcode/shared`：host 与 adapter 共用同一份，避免一侧放行一侧拒绝。
 * 异步是为了让 host 侧能按 settings 覆盖解析 origin。
 */
export interface OfficialMcpTrustedOriginRegistry {
  isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
    detail?: string;
    trusted: boolean;
  }>;
}

export interface McpPort {
  connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options?: McpConnectOptions,
  ): Promise<McpConnectionSnapshot>;
  connectServer(
    name: string,
    config: McpServerConfig,
    options?: McpConnectOptions,
  ): Promise<McpServerStatus>;
  disconnectServer(name: string): Promise<McpServerStatus | undefined>;
  /**
   * 主动探测连接是否仍然存活，返回 false 表示 transport 已断。
   * HTTP/SSE MCP 被停掉时不会派发 onclose，status() 会长期停在 connected；
   * 只有显式 ping 才能把这种"无声死亡"暴露出来。实现可选：未实现时调用方按存活处理。
   */
  pingServer?(name: string, options?: { timeoutMs?: number }): Promise<boolean>;
  status(): Promise<Record<string, McpServerStatus>>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(request: McpCallToolRequest, options?: McpCallToolOptions): Promise<McpToolCallResult>;
  close(): Promise<void>;
}