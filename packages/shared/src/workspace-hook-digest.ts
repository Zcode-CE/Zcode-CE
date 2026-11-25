// Modified by ZCode: 自上游 zai-org/ZCode v4.0.0 (a4b44451, Apache-2.0) 并入本波安全/稳定性修复（详见 docs/development/upstream-sync.md）。
import { createHash } from "node:crypto";
import { basename, relative, resolve } from "node:path";
import {
  WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
  WORKSPACE_HOOK_EVENT_NAMES,
  resolveWorkspaceHookConfiguredGates,
  resolveWorkspaceHookTimeoutMs,
  type WorkspaceHookConfigFileKind,
  type WorkspaceHookDefinition,
  type WorkspaceHookEventName,
  type WorkspaceHookRuntimeRoot,
  type WorkspaceHookSourceInput,
} from "./workspace-hook-config.js";
import {
  identifyWorkspaceHookScriptPath,
  workspaceHookReviewItemId,
  type WorkspaceHookScriptEntry,
  type WorkspaceHookScriptState,
} from "./workspace-hook-script.js";

export interface CanonicalWorkspaceHookEntryData {
  reviewItemId: string;
  event: WorkspaceHookEventName;
  matcherIndex: number;
  hookIndex: number;
  sourceFileIndex: number;
  sourceRelativePath: string;
  matcher: string | null;
  type: "command" | "process";
  command: string;
  args?: string[];
  async?: boolean;
  shell?: true | string;
  resolvedTimeoutMs: number;
  resolvedMaxOutputBytes: number;
  statusMessage?: string;
  /** 能识别的直接入口脚本；同步路径拿不到脚本状态或识别不到入口时缺省。 */
  scriptEntry?: WorkspaceHookScriptEntry;
  sourceRootEnabled: boolean;
  declarationEnabled: boolean;
  runtimeHooksEnabled: boolean;
  configuredEnabled: boolean;
  editable: boolean;
  declarationDigestAlgorithm: "sha256";
  hookDeclarationDigest: string;
}

export interface WorkspaceHookBundleSnapshotData {
  schemaVersion: typeof WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION;
  workspaceIdentity: string;
  discoveredAt: string;
  sourceFiles: Array<{
    canonicalPath: string;
    baseDir: string;
    discoveryOrder: number;
    configFileKind: WorkspaceHookConfigFileKind;
    explicitProjectConfig: boolean;
    editable: boolean;
    hooksRoot: {
      enabled?: boolean;
      timeoutMs?: number;
      maxOutputBytes?: number;
    };
  }>;
  hooks: CanonicalWorkspaceHookEntryData[];
  digestAlgorithm: "sha256";
  bundleDigest: string;
}

export function resolveWorkspaceHookEntries(input: {
  workspacePath: string;
  sources: readonly WorkspaceHookSourceInput[];
  runtimeRoot: WorkspaceHookRuntimeRoot;
  /**
   * readWorkspaceHookScriptStates 的结果。
   *
   * 缺省表示调用方拿不到脚本内容（同步构建，如 createConfig）：此时不附加 scriptEntry，
   * declaration digest 与引入内容绑定之前逐字节相同，既有 Trust 不会一次性失效。
   * 传入后每个可识别入口都进条目；映射里查不到该 reviewItemId 时记 unverifiable（fail closed）。
   */
  scriptStates?: ReadonlyMap<string, WorkspaceHookScriptState>;
}): CanonicalWorkspaceHookEntryData[] {
  const entries: CanonicalWorkspaceHookEntryData[] = [];

  for (const [sourceFileIndex, source] of input.sources.entries()) {
    const sourceRelativePath = normalizeRelativeSourcePath(
      input.workspacePath,
      source.canonicalPath,
    );
    for (const event of WORKSPACE_HOOK_EVENT_NAMES) {
      for (const [matcherIndex, matcher] of (source.hooks.events?.[event] ?? []).entries()) {
        for (const [hookIndex, hook] of matcher.hooks.entries()) {
          const gates = resolveWorkspaceHookConfiguredGates({
            sourceEnabled: source.hooks.enabled,
            declarationEnabled: hook.enabled,
            runtimeHooksEnabled: input.runtimeRoot.enabled,
          });
          const resolvedTimeoutMs = resolveWorkspaceHookTimeoutMs(
            hook,
            input.runtimeRoot.timeoutMs,
          );
          const reviewItemId = workspaceHookReviewItemId(
            sourceFileIndex,
            event,
            matcherIndex,
            hookIndex,
          );
          // 只有在调用方拿到脚本状态（异步入口）时才识别入口：同步路径下 scriptEntry 缺席，
          // 声明摘要保持与引入内容绑定之前逐字节相同，升级本身不会让既有 Trust 失效。
          const scriptPath =
            input.scriptStates === undefined ? undefined : identifyWorkspaceHookScriptPath(hook);
          const scriptEntry =
            scriptPath === undefined
              ? undefined
              : {
                  path: scriptPath,
                  // 已经声明要绑定内容却查不到该条目，按 unverifiable 处理：不退回声明级摘要。
                  state: input.scriptStates?.get(reviewItemId) ?? { kind: "unverifiable" as const },
                };
          const common = {
            reviewItemId,
            event,
            matcherIndex,
            hookIndex,
            sourceFileIndex,
            sourceRelativePath,
            matcher: matcher.matcher ?? null,
            command: hook.command,
            resolvedTimeoutMs,
            resolvedMaxOutputBytes: input.runtimeRoot.maxOutputBytes,
            ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
            ...(scriptEntry ? { scriptEntry } : {}),
            ...gates,
            editable: source.editable,
            declarationDigestAlgorithm: "sha256" as const,
            hookDeclarationDigest: createWorkspaceHookDeclarationDigest({
              sourceRelativePath,
              sourceDiscoveryOrder: source.discoveryOrder,
              event,
              matcher: matcher.matcher ?? null,
              matcherIndex,
              hookIndex,
              hook,
              defaultTimeoutMs: input.runtimeRoot.timeoutMs,
              resolvedMaxOutputBytes: input.runtimeRoot.maxOutputBytes,
              ...(scriptEntry ? { scriptEntry } : {}),
            }),
          };

          entries.push(
            hook.type === "process"
              ? {
                  ...common,
                  type: "process",
                  ...(hook.args && hook.args.length > 0 ? { args: [...hook.args] } : {}),
                }
              : {
                  ...common,
                  type: "command",
                  ...(hook.async === true ? { async: true } : {}),
                  ...(hook.shell !== undefined ? { shell: hook.shell } : {}),
                },
          );
        }
      }
    }
  }
  return entries;
}

export function buildWorkspaceHookBundleSnapshot(input: {
  workspaceIdentity: string;
  workspacePath: string;
  sources: readonly WorkspaceHookSourceInput[];
  runtimeRoot: WorkspaceHookRuntimeRoot;
  /** 语义同 resolveWorkspaceHookEntries 的 scriptStates：缺省时摘要不绑定脚本内容。 */
  scriptStates?: ReadonlyMap<string, WorkspaceHookScriptState>;
  discoveredAt?: string;
}): WorkspaceHookBundleSnapshotData | undefined {
  const hooks = resolveWorkspaceHookEntries(input);
  if (hooks.length === 0) return undefined;

  const sourceFiles = input.sources.map((source) => ({
    canonicalPath: source.canonicalPath,
    baseDir: source.baseDir,
    discoveryOrder: source.discoveryOrder,
    configFileKind: source.configFileKind,
    explicitProjectConfig: source.explicitProjectConfig,
    editable: source.editable,
    hooksRoot: {
      ...(source.hooks.enabled !== undefined ? { enabled: source.hooks.enabled } : {}),
      ...(source.hooks.timeoutMs !== undefined ? { timeoutMs: source.hooks.timeoutMs } : {}),
      ...(source.hooks.maxOutputBytes !== undefined
        ? { maxOutputBytes: source.hooks.maxOutputBytes }
        : {}),
    },
  }));
  const bundlePayload = [
    "workspace-hook-bundle",
    WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
    input.sources.map((source) => [
      normalizeRelativeSourcePath(input.workspacePath, source.canonicalPath),
      source.discoveryOrder,
      source.configFileKind,
      source.explicitProjectConfig,
      canonicalOptional(source.hooks.enabled),
      canonicalOptional(source.hooks.timeoutMs),
      canonicalOptional(source.hooks.maxOutputBytes),
    ]),
    hooks.map((hook) => [
      hook.hookDeclarationDigest,
      hook.sourceRootEnabled,
      hook.declarationEnabled,
      hook.runtimeHooksEnabled,
      hook.configuredEnabled,
    ]),
  ];

  return deepFreeze({
    schemaVersion: WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
    workspaceIdentity: input.workspaceIdentity,
    discoveredAt: input.discoveredAt ?? new Date().toISOString(),
    sourceFiles,
    hooks,
    digestAlgorithm: "sha256",
    bundleDigest: sha256(bundlePayload),
  });
}

export function createWorkspaceHookDeclarationDigest(input: {
  sourceRelativePath: string;
  sourceDiscoveryOrder: number;
  event: WorkspaceHookEventName;
  matcher: string | null;
  matcherIndex: number;
  hookIndex: number;
  hook: WorkspaceHookDefinition;
  defaultTimeoutMs: number;
  resolvedMaxOutputBytes: number;
  scriptEntry?: WorkspaceHookScriptEntry;
}): string {
  return sha256(
    canonicalDeclarationPayload({
      ...input,
      resolvedTimeoutMs: resolveWorkspaceHookTimeoutMs(input.hook, input.defaultTimeoutMs),
    }),
  );
}

function canonicalDeclarationPayload(input: {
  sourceRelativePath: string;
  sourceDiscoveryOrder: number;
  event: WorkspaceHookEventName;
  matcher: string | null;
  matcherIndex: number;
  hookIndex: number;
  hook: WorkspaceHookDefinition;
  resolvedTimeoutMs: number;
  resolvedMaxOutputBytes: number;
  scriptEntry?: WorkspaceHookScriptEntry;
}): unknown[] {
  const execution =
    input.hook.type === "process"
      ? ["process", input.hook.command, [...(input.hook.args ?? [])]]
      : [
          "command",
          input.hook.command,
          input.hook.async === true,
          input.hook.shell === undefined
            ? ["unset"]
            : input.hook.shell === true
              ? ["true"]
              : ["string", input.hook.shell],
        ];
  return [
    "workspace-hook-declaration",
    WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
    input.sourceRelativePath,
    input.sourceDiscoveryOrder,
    input.event,
    input.matcher,
    input.matcherIndex,
    input.hookIndex,
    execution,
    input.resolvedTimeoutMs,
    input.resolvedMaxOutputBytes,
    // 直接入口脚本内容进摘要（D24）：脚本变化即要求重新信任。未提供 scriptStates（同步路径）
    // 或识别不到入口时不追加，摘要与引入内容绑定之前逐字节相同；missing / unverifiable 也进
    // 摘要，保证它们不会与任何可授权的 file 状态得到同一个 digest。
    ...(input.scriptEntry
      ? [["scriptEntry", input.scriptEntry.path, canonicalScriptState(input.scriptEntry.state)]]
      : []),
  ];
}

function canonicalScriptState(state: WorkspaceHookScriptState): unknown[] {
  return state.kind === "file" ? ["file", state.sha256] : [state.kind];
}

function normalizeRelativeSourcePath(workspacePath: string, sourcePath: string): string {
  const value = relative(resolve(workspacePath), resolve(sourcePath)).replaceAll("\\", "/");
  return value || basename(sourcePath);
}

function canonicalOptional(value: boolean | number | undefined): unknown[] {
  return value === undefined ? ["unset"] : ["set", value];
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
