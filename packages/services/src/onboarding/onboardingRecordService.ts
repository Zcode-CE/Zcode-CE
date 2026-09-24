import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { onboardingRecordFileSchema, onboardingRecordFileV2Schema } from "@zcode/shared";
import { appSettingsOccupationEnum } from "@zcode/shared";
import type {
  OnboardingDecision,
  OnboardingRecordEntry,
  OnboardingRecordEntryInput,
  OnboardingRecordFile,
} from "@zcode/shared";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { ensureDeviceMid } from "../device/deviceMid.js";
import { getAppConfigDir } from "../paths.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  CreateOnboardingRecordServiceOptions,
  IOnboardingRecordService,
  OnboardingSettingsSyncPatch,
} from "./onboardingRecord.js";

const logger = createServiceLogger("onboardingRecordService");

function getRecordFile(): string {
  // 记录是设备级数据，必须跟随 dataBaseDir（用户自定义数据目录时落在其 .zcode/v2 下，
  // 与 telemetry-state.json 一致），不能学 setting.json 固定写 home——setting.json 留在 home
  // 只是启动引导需要固定位置读取 dataBaseDir，不代表其他设备数据的落点。
  return join(getAppConfigDir(), "onboarding-record.json");
}

/**
 * 读取记录文件；文件不存在返回 null，内容损坏（手改/写坏）时同样返回 null 并 warn——
 * 损坏文件等价于"从未记录"，重新触发引导后在下次 append 时重建。
 */
async function readRecordFile(filePath: string): Promise<OnboardingRecordFile | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    logger.warn(undefined, "read onboarding record failed:", err);
    return null;
  }
  try {
    return onboardingRecordFileSchema.parse(JSON.parse(raw));
  } catch (cause) {
    logger.warn(undefined, "invalid onboarding record json, treating as missing. error:", cause);
    return null;
  }
}

export function createOnboardingRecordService(
  options: CreateOnboardingRecordServiceOptions,
): IOnboardingRecordService {
  // 串行化写：引导保存与并发触发判定同时发生时不丢条目。
  let writeQueue: Promise<unknown> = Promise.resolve();
  const enqueueWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = writeQueue.then(task, task) as Promise<T>;
    writeQueue = queued.catch(() => {});
    return queued;
  };

  /**
   * 解析新建记录文件要固化的 deviceMid；拿不到非空值时返回 null。
   *
   * 这里不允许兜底造值：schema 要求 deviceMid min(1)，写空串会让整份文件下次读取
   * 解析失败（readRecordFile 返回 null），刚落的决策与 entries 一并被当成"从未记录"，
   * 用户的关闭动作静默丢失。宁可本次不写并 warn，也不写出必然读不回来的文件。
   */
  const resolveNewFileDeviceMid = async (): Promise<string | null> => {
    try {
      const raw = options.resolveDeviceMid
        ? await options.resolveDeviceMid()
        : await ensureDeviceMid();
      const deviceMid = typeof raw === "string" ? raw.trim() : "";
      if (!deviceMid) {
        logger.warn(
          undefined,
          "onboarding record deviceMid resolved empty, skip write (schema requires min(1))",
        );
        return null;
      }
      return deviceMid;
    } catch (error) {
      logger.warn(undefined, "resolve deviceMid for onboarding record failed:", error);
      return null;
    }
  };

  /**
   * 落一条决策并保证幂等：同一 (userId, status) 已存在时不重复追加。
   *
   * 失败只 warn 不抛：决策是"下次别再弹"的优化，写盘失败不应阻断引导判定本身
   * （本机确实已有任务/用户确实关闭过，下次启动会重试落盘）。
   */
  const recordDecisionSafely = async (
    existingFile: OnboardingRecordFile | null,
    userId: string | null,
    status: OnboardingDecision["status"],
    reason: OnboardingDecision["reason"],
  ): Promise<void> => {
    try {
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        let file = existingFile ?? (await readRecordFile(filePath));
        if (!file) {
          // 新建文件必须固化一个非空 deviceMid（见 resolveNewFileDeviceMid）：
          // 解析不到就放弃本次写入，而不是写一份下次读不回来的文件。
          const deviceMid = await resolveNewFileDeviceMid();
          if (!deviceMid) return;
          file = { version: 2, deviceMid, entries: [], decisions: [] };
        }
        if (file.decisions.some((d) => d.userId === userId && d.status === status)) return;
        file.decisions.push({
          userId,
          status,
          reason,
          decidedAt: new Date().toISOString(),
        });
        await mkdir(join(filePath, ".."), { recursive: true });
        await atomicWriteText(filePath, JSON.stringify(file, null, 2));
      });
    } catch (error) {
      logger.warn(undefined, "record onboarding decision failed:", error);
    }
  };

  return {
    async appendRecord(deviceMid: string, entry: OnboardingRecordEntryInput): Promise<void> {
      const userId = await options.loadUserId();
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const existing = await readRecordFile(filePath);
        // deviceMid 以文件内已有值为权威：本地文件不变是设备关联的前提，
        // 调用方传入不同值只说明异常（如 getDeviceId 行为变化），记录并沿用旧值。
        let file: OnboardingRecordFile;
        if (existing) {
          if (existing.deviceMid !== deviceMid) {
            logger.warn(
              undefined,
              "deviceMid mismatch, keep existing:",
              existing.deviceMid,
              "incoming:",
              deviceMid,
            );
          }
          file = existing;
        } else {
          // 新文件直接落 v2：v1 只在读取旧文件时出现，由 onboardingRecordFileSchema 无损升级。
          file = { version: 2, deviceMid, entries: [], decisions: [] };
        }
        const record: OnboardingRecordEntry = {
          userId,
          ...entry,
          uploadState: "pending",
        };
        // 每 userId（含 null）至多一条：同一用户重复完成引导（debug 重置后再答等）覆盖旧条目，
        // 而不是追加——覆盖后的新答案重新置 pending，等待上传。
        const previousIndex = file.entries.findIndex((item) => item.userId === userId);
        const validated = onboardingRecordFileV2Schema.shape.entries.element.parse(record);
        if (previousIndex >= 0) file.entries[previousIndex] = validated;
        else file.entries.push(validated);
        await mkdir(join(filePath, ".."), { recursive: true });
        await atomicWriteText(filePath, JSON.stringify(file, null, 2));
      });
    },

    async claimAnonymousRecord(): Promise<void> {
      const userId = await options.loadUserId();
      if (!userId) return;
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const file = await readRecordFile(filePath);
        if (!file) return;
        if (file.entries.some((entry) => entry.userId === userId)) return;
        // 兼容旧版重复文件取最后一条 null；移交是改写，不保留匿名副本。
        for (let i = file.entries.length - 1; i >= 0; i -= 1) {
          if (file.entries[i]!.userId === null) {
            file.entries[i] = onboardingRecordFileV2Schema.shape.entries.element.parse({
              ...file.entries[i]!,
              userId,
            });
            break;
          }
        }
        await atomicWriteText(filePath, JSON.stringify(file, null, 2));
      });
    },

    async shouldOnboard(): Promise<boolean> {
      const userId = await options.loadUserId();
      const file = await readRecordFile(getRecordFile());

      // 判定顺序与官方 3.14.1 一致，不可调换：
      // 1) 该 userId 在 entries 或 decisions 里已有任意一条记录 → 不再引导。
      // 2) 本机已有任务 → 视为老用户，落一条 existing_local_user 决策后不引导。
      //    没有这一步，升级到本版的老用户会被当成新用户弹一次引导。
      //
      // 第 1 步的判定面是 entries ∪ decisions 的并集（判据见 @zcode/shared 的
      // onboardingDecisionSchema 注释），不按 status 过滤：只认 dismissed 时，第 2 步
      // 自己写下的 existing_local_user 决策会在本机任务被删空后失效，同一个人被再弹一次。
      // 这是收窄引导触发面（少弹一次），不会让本该引导的人不引导。
      const hasIdentityRecord =
        file?.entries.some((entry) => entry.userId === userId) === true ||
        file?.decisions.some((decision) => decision.userId === userId) === true;
      if (hasIdentityRecord) {
        return false;
      }

      const hasExistingLocalTask = options.hasExistingLocalTask;
      if (hasExistingLocalTask && (await hasExistingLocalTask())) {
        // 决策落盘失败不能阻断判定：下次启动会重试，且本机确实已有任务。
        await recordDecisionSafely(file, userId, "existing_local_user", "existing_local_task");
        return false;
      }

      return true;
    },

    async dismissOnboarding(): Promise<void> {
      const userId = await options.loadUserId();
      const file = await readRecordFile(getRecordFile());
      await recordDecisionSafely(file, userId, "dismissed", "user_closed");
    },

    async getLatestEntry(): Promise<OnboardingRecordEntry | null> {
      const userId = await options.loadUserId();
      const file = await readRecordFile(getRecordFile());
      if (!file) return null;
      let latest: OnboardingRecordEntry | undefined;
      for (const entry of file.entries) {
        if (entry.userId === userId) latest = entry;
      }
      return latest ?? null;
    },

    async syncSettingsFromRecord(): Promise<OnboardingSettingsSyncPatch | null> {
      const userId = await options.loadUserId();
      const file = await readRecordFile(getRecordFile());
      if (!file) return null;
      // append 是覆盖语义，正常每 userId 至多一条；兼容旧版本的重复追加文件时取最后一条。
      let latest: OnboardingRecordEntry | undefined;
      for (const entry of file.entries) {
        if (entry.userId === userId) latest = entry;
      }
      if (!latest) return null;
      // 跳过页记 null：回填保守默认，与引导跳过写 settings 的行为一致（职业 other、偏好关）。
      // record 的 occupation 是非枚举字符串（职业列表会演进），窄化到 settings 的枚举；
      // 旧版本可能落过已收窄/未知的职业值，未知值回填 other，与推荐池的兜底一致。
      const occupation = appSettingsOccupationEnum.safeParse(latest.occupation);
      return {
        onboardingOccupation: (occupation.success ? occupation.data : null) ?? "other",
        proactiveSuggestionsEnabled: latest.proactiveSuggestionsEnabled ?? false,
        memoryEnabled: latest.memoryEnabled ?? false,
      };
    },

    async updateRecordPreferences(
      patch: Partial<
        Pick<OnboardingRecordEntryInput, "memoryEnabled" | "proactiveSuggestionsEnabled">
      >,
    ): Promise<void> {
      const userId = await options.loadUserId();
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const file = await readRecordFile(filePath);
        if (!file) return;
        const index = file.entries.findLastIndex((entry) => entry.userId === userId);
        if (index < 0) return;
        file.entries[index] = onboardingRecordFileV2Schema.shape.entries.element.parse({
          ...file.entries[index],
          ...patch,
        });
        await atomicWriteText(filePath, JSON.stringify(file, null, 2));
      });
    },

    async getRecords(): Promise<OnboardingRecordFile | null> {
      return readRecordFile(getRecordFile());
    },

    async clearRecords(): Promise<void> {
      await enqueueWrite(async () => {
        await rm(getRecordFile(), { force: true });
      });
    },
  };
}
