import { z } from "zod";

export const SERVER_CLI_PROTOCOL_VERSION = 1;
export const SERVER_RUNTIME_NODE_VERSION = "22.16.0";
export const CRASH_WINDOW_MS = 5 * 60_000;
export const CRASH_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;

export const lifecycleStateSchema = z.enum([
  "starting",
  "ready",
  "stopping",
  "stop-failed",
  "stopped",
  "crashed",
  "crash-loop-stopped",
  "updating",
  "uninstalling",
  "uninstalled",
]);

export const crashBudgetSchema = z.object({
  windowStartedAt: z.number().int().nonnegative().optional(),
  crashCount: z.number().int().nonnegative(),
  nextRestartDelayMs: z.number().int().nonnegative(),
  exhausted: z.boolean(),
});

export const serverStatusSchema = z
  .object({
    protocolVersion: z.literal(SERVER_CLI_PROTOCOL_VERSION).default(SERVER_CLI_PROTOCOL_VERSION),
    state: lifecycleStateSchema,
    pid: z.number().int().positive().nullable(),
    port: z.number().int().nonnegative().nullable(),
    host: z.string().min(1).nullable(),
    version: z.string().min(1),
    generation: z.number().int().nonnegative(),
    /**
     * 是否已安装发布包（`install.json` 在场）。桌面用它把「未安装 / 已安装未运行 / 运行中」
     * 三态分开；旧快照没有该字段时按 false 解析，CLI 输出前会用文件系统事实覆盖它。
     */
    installed: z.boolean().default(false),
    startedAt: z.number().int().nonnegative().nullable().default(null),
    lastExitReason: z.string().max(500).nullable().default(null),
    serviceRegistered: z.boolean(),
    runningTaskCount: z.number().int().nonnegative(),
    crashBudget: crashBudgetSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type CrashBudgetSnapshot = z.infer<typeof crashBudgetSchema>;
export type ServerStatus = z.infer<typeof serverStatusSchema>;

export const updatePreparationResultSchema = z
  .object({
    status: z.enum(["ready", "blocked"]),
    runningTaskCount: z.number().int().nonnegative(),
  })
  .strict();
export type UpdatePreparationResult = z.infer<typeof updatePreparationResultSchema>;

export function createStoppedServerStatus(
  version: string,
  options: { serviceRegistered?: boolean; installed?: boolean; now?: number } = {},
): ServerStatus {
  return serverStatusSchema.parse({
    protocolVersion: SERVER_CLI_PROTOCOL_VERSION,
    state: "stopped",
    pid: null,
    port: null,
    host: null,
    version,
    generation: 0,
    installed: options.installed ?? false,
    startedAt: null,
    lastExitReason: null,
    serviceRegistered: options.serviceRegistered ?? false,
    runningTaskCount: 0,
    crashBudget: {
      crashCount: 0,
      nextRestartDelayMs: CRASH_BACKOFF_MS[0],
      exhausted: false,
    },
    updatedAt: options.now ?? Date.now(),
  });
}

const requestBase = z.object({ id: z.string().trim().min(1).max(128) });
export const controlRequestSchema = z.discriminatedUnion("command", [
  requestBase.extend({ command: z.literal("ping") }),
  requestBase.extend({ command: z.literal("status") }),
  requestBase.extend({ command: z.literal("stop") }),
  requestBase.extend({ command: z.literal("restart") }),
  requestBase.extend({ command: z.literal("prepare-update") }),
  requestBase.extend({ command: z.literal("apply-update"), force: z.boolean().optional() }),
  requestBase.extend({ command: z.literal("prepare-uninstall") }),
  requestBase.extend({ command: z.literal("confirm-uninstall"), confirmation: z.string() }),
]);
export type ControlRequest = z.infer<typeof controlRequestSchema>;

export const controlResponseSchema = z
  .object({
    id: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ControlResponse = z.infer<typeof controlResponseSchema>;

export const coreMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    host: z.string().min(1),
    port: z.number().int().positive(),
    version: z.string().min(1),
    generation: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("heartbeat"),
    at: z.number().int().nonnegative(),
    runningTaskCount: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("task-activity"),
    runningTaskCount: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("shutdown-ack") }),
  z.object({ type: z.literal("fatal"), message: z.string().max(500) }),
  z.object({ type: z.literal("exit"), reason: z.string().max(500) }),
]);
export type CoreMessage = z.infer<typeof coreMessageSchema>;

export const coreCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("shutdown") }),
]);
export type CoreCommand = z.infer<typeof coreCommandSchema>;

export const releaseManifestSchema = z
  .object({
    // version 会参与 releases/<version>-<target>-<sha> 路径拼接，不能允许 `/`、`\` 或 `..` 穿越 data root。
    version: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
    releaseDir: z.string().trim().min(1),
    nodeVersion: z.string().trim().min(1).optional(),
    releaseId: z.string().trim().min(1).optional(),
    appVersion: z.string().trim().min(1).optional(),
    target: z.string().trim().min(1).optional(),
    archiveSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    archiveSizeBytes: z.number().int().nonnegative().optional(),
    components: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            paths: z.array(z.string().trim().min(1)).min(1),
            sizeBytes: z.number().int().nonnegative(),
            archivePath: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export const releaseCatalogEntrySchema = z
  .object({
    version: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
    appVersion: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u)
      .optional(),
    target: z.string().trim().min(1),
    archiveUrl: z.string().url(),
    manifestUrl: z.string().url().optional(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    archiveSizeBytes: z.number().int().nonnegative().optional(),
    components: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            sizeBytes: z.number().int().nonnegative(),
            archiveUrl: z.string().url().optional(),
            archiveSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/i)
              .optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const releaseCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    releases: z.array(releaseCatalogEntrySchema),
  })
  .strict();
export type ReleaseCatalogEntry = z.infer<typeof releaseCatalogEntrySchema>;
export type ReleaseCatalog = z.infer<typeof releaseCatalogSchema>;
