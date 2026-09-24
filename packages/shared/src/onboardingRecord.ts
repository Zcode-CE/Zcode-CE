import { z } from "zod";

/**
 * Onboarding 完成记录（三步向导：职业 / 模式 / 偏好）。
 *
 * 设计约束：
 * - 独立本地 JSON（~/.zcode/v2/onboarding-record.json），不混入 AppSettings；
 * - 以 deviceMid 为设备锚点，entries 支持多个 userId（多人登录）与 null（apikey/未登录）；
 * - uploadState 预留后续上传服务器：pending → uploaded；
 * - 跳过是显式答案：某页被跳过时该字段记 null，与"明确选择了值"区分。
 */

/** occupation 用非空字符串而非枚举：职业列表会演进，旧记录不能因枚举收窄而校验失败。 */
export const onboardingOccupationSchema = z.string().min(1).nullable();

export const onboardingInterfaceModeSchema = z.enum(["coding", "office"]).nullable();

export const onboardingRecordEntrySchema = z.object({
  userId: z.string().min(1).nullable(),
  occupation: onboardingOccupationSchema,
  interfaceMode: onboardingInterfaceModeSchema,
  memoryEnabled: z.boolean().nullable(),
  proactiveSuggestionsEnabled: z.boolean().nullable(),
  completedAt: z.string().min(1),
  uploadState: z.literal("pending"),
});

/**
 * 未完成向导的显式决定（v2 新增）。
 *
 * entries 表达"答完了引导"，decisions 表达"没答但已经处理过了"。状态所有者是
 * `onboardingRecordService`（本文件只声明形状与判据，不做判定）；判定面是两者的并集，
 * 可执行判据为：该 userId 命中 entries 或 decisions 任意一条，即视为已处理过引导，
 * `shouldOnboard` 返回 false。判据不看 status —— 两个枚举值都算已处理：
 * - `dismissed` / `user_closed`：用户主动关闭引导（不保存任何偏好）；
 * - `existing_local_user` / `existing_local_task`：存量用户短路（本地已有任务，
 *   引导对其没有意义），由 `shouldOnboard` 自动补写，不需要用户操作。
 *
 * 边界（改判据前先看这几条）：
 * - 只认 decisions 里 dismissed 的那一半是错的：老用户短路写下的 existing_local_user
 *   决策会在本机任务被删空后失效，同一个人被再弹一次；
 * - 判据是并集而不是只看 decisions，所以答完向导（entries）的人不会被重弹；
 * - 只有文件不存在、或该 userId 两侧都没有记录时，才回到"需要引导"。
 *
 * 为什么这是收窄而不是放宽：并集只会让更多 userId 命中"已处理"，即少弹一次；
 * 不新增"本该弹却不弹"的情形 —— 全新用户（无文件、无任何记录）仍返回 true。
 *
 * 只有这两个枚举值是有意的：决定一旦记录就不再变化，不做"改主意"的语义。
 */
export const onboardingDecisionSchema = z.object({
  userId: z.string().min(1).nullable(),
  status: z.enum(["dismissed", "existing_local_user"]),
  reason: z.enum(["user_closed", "existing_local_task"]),
  decidedAt: z.string().min(1),
});

/**
 * v1：只有 entries。必须保留——升级到 v2 后老用户的文件仍是 v1，
 * 若 schema 直接收窄成 v2 literal，老文件会解析失败，readRecordFile 返回 null，
 * 结果是把老用户当成全新用户重新引导，与"不再对老用户弹出"的目标完全相反。
 */
export const onboardingRecordFileV1Schema = z.object({
  version: z.literal(1),
  deviceMid: z.string().min(1),
  entries: z.array(onboardingRecordEntrySchema),
});

/** v2：新增 decisions。 */
export const onboardingRecordFileV2Schema = z.object({
  version: z.literal(2),
  deviceMid: z.string().min(1),
  entries: z.array(onboardingRecordEntrySchema),
  decisions: z.array(onboardingDecisionSchema),
});

/**
 * 读取入口：v1 无损升到 v2（decisions 补空数组）。
 *
 * 迁移只在读取时发生，没有单独的迁移脚本——下次写入自然落 v2。
 * 注意这里不能写成 v2 literal：见 `onboardingRecordFileV1Schema` 的说明。
 */
export const onboardingRecordFileSchema = z
  .union([onboardingRecordFileV1Schema, onboardingRecordFileV2Schema])
  .transform(
    (file): z.output<typeof onboardingRecordFileV2Schema> =>
      file.version === 1 ? { ...file, version: 2, decisions: [] } : file,
  );

export type OnboardingRecordEntry = z.infer<typeof onboardingRecordEntrySchema>;

export type OnboardingDecision = z.infer<typeof onboardingDecisionSchema>;

export type OnboardingRecordFileV1 = z.infer<typeof onboardingRecordFileV1Schema>;

export type OnboardingRecordFileV2 = z.infer<typeof onboardingRecordFileV2Schema>;

/** appendRecord 的入参：userId 由服务端（host）补全，调用方不传。 */
export type OnboardingRecordEntryInput = Omit<OnboardingRecordEntry, "userId" | "uploadState">;

/** 解析后的形态恒为 v2（v1 已在 transform 里升级），调用方不需要分支处理版本。 */
export type OnboardingRecordFile = z.output<typeof onboardingRecordFileSchema>;
