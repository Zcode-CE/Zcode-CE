export interface ComputerUseRuntimeContext {
  sessionId: string;
  runtimeScope: "main" | "subagent";
  workspaceKey: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  turnId?: string;
  clientMode?: "web-remote-replayable" | "desktop-continuous";
  deliveryKind?: "web-remote-replayable" | "desktop-continuous";
  trace?: Record<string, unknown>;
}

export interface ComputerUseRuntimeExecuteInput {
  toolName: string;
  arguments?: unknown;
  context: ComputerUseRuntimeContext;
  signal?: AbortSignal;
}

export interface ComputerUseRuntime {
  execute(input: ComputerUseRuntimeExecuteInput): Promise<unknown>;
  closeSession(context: ComputerUseRuntimeContext): Promise<void>;
  dispose(): Promise<void>;
}

export interface ComputerUseRuntimeOptions {
  /**
   * 运行时实现选择。
   * - `open-source`（默认）：MIT 许可的 @trycua/cua-driver。
   * - `disabled`：维持 placeholder 语义，所有面 fail closed。
   */
  driver?: "open-source" | "disabled";
  /** 官方 Helper 的 broker socket。本包不再消费，仅保留以兼容既有装配点。 */
  brokerSocketPath?: string;
  refreshMarkerPath?: string;
  ensureBrokerAvailable?: () => Promise<void>;
  env?: Record<string, string | undefined>;
  /**
   * 测试注入点：替换真实驱动加载。仅回归测试使用，生产装配点不传。
   * 传入的实例需实现 `callTool(name, argumentsJson, { signal })` 与
   * `shutdown()` / `uniffiDestroy()`。
   */
  loadDriver?: () => Promise<unknown>;
}

export declare function createComputerUseRuntime(
  options?: ComputerUseRuntimeOptions,
): ComputerUseRuntime;

/** 具备 cua-driver 预编译二进制的平台三元组。 */
export declare const CUA_DRIVER_SUPPORTED_PLATFORMS: readonly string[];
