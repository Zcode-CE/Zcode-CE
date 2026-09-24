import type {
  OnboardingRecordEntry,
  OnboardingRecordEntryInput,
  OnboardingRecordFile,
} from "@zcode/shared";
import { ServiceChannels, type AppSettings } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 登录态变化时按 record 回填 settings 的字段范围（settings 仍是运行时唯一事实源）。 */
export interface OnboardingSettingsSyncPatch {
  onboardingOccupation?: AppSettingsPatchOccupation;
  proactiveSuggestionsEnabled?: boolean;
  memoryEnabled?: boolean;
}

type AppSettingsPatchOccupation = NonNullable<AppSettings["onboardingOccupation"]>;

/**
 * deviceMid 的状态所有者与接口契约（记录文件是设备级数据，新文件必须固化一个非空 deviceMid）：
 *
 * - 形状要求：schema 要求 min(1)（@zcode/shared 的 onboardingRecordFileV1Schema / V2Schema）。
 *   写进空串不是"少一个字段"，而是整份文件下次读取必然解析失败 ⇒ readRecordFile 返回 null
 *   ⇒ 整份记录（含刚落的决策）被当成"从未记录"，用户的关闭动作静默丢失。
 * - 已有文件：以文件内 deviceMid 为权威，调用方传入不同值只 warn 并沿用旧值（设备关联的前提）。
 * - 文件不存在：由服务侧解析，默认走设备身份唯一入口 ensureDeviceMid（telemetry-state.json，
 *   与 X-Device-Mid / 反馈 / claim 同一个字段），装配可用 resolveDeviceMid 覆盖。
 *   解析不到非空值时跳过本次写入并明确告警，绝不写出必然读不回来的文件。
 * - 并发：同一进程内写操作走同一条串行队列（enqueueWrite），不会交错出半截文件。
 */
export interface IOnboardingRecordService {
  /**
   * 追加一条引导完成记录。文件不存在时创建并固化 deviceMid（之后以文件内值为权威）；
   * userId 由服务内部按当前登录态补全，调用方不传。
   */
  appendRecord(deviceMid: string, entry: OnboardingRecordEntryInput): Promise<void>;
  /**
   * 触发判定。返回 true 表示应当弹出引导。
   *
   * 判定顺序（与官方 3.14.1 一致，不可调换）：
   * 1. 当前用户在 entries 或 decisions 里已有任意一条记录 → false。
   *    判定面是两者的并集（判据见 `@zcode/shared` 的 `onboardingDecisionSchema` 注释），
   *    不按 status 过滤：`dismissed`（用户关闭过）与 `existing_local_user`（老用户短路）
   *    都表示"已经处理过了"，重启后都不该再弹。
   * 2. 本机已有任务（`hasExistingLocalTask`）→ 落一条 `existing_local_user` 决策后返回 false
   *    （老用户不该被当成新用户引导）
   * 3. 文件不存在，或当前用户两侧都没有记录 → true
   *
   * 为什么第 1 步必须认整个 decisions 集合：只认 `dismissed` 时，老用户短路写下的
   * `existing_local_user` 决策会在本机任务被删空后失效，同一个人被再弹一次。
   */
  shouldOnboard(): Promise<boolean>;
  /**
   * 记录「用户主动关闭了引导」。
   *
   * 与 `appendRecord` 的区别：appendRecord 是"完成/跳过引导"的作答记录，本方法只记录
   * 关闭动作本身。没有它，关闭只存在于组件 state 里，重启后引导会再次弹出。
   */
  dismissOnboarding(): Promise<void>;
  /**
   * 登录认领：当前 userId 没有条目而存在匿名（null）条目时，把 null 条目移交给该 userId
   * （改写而非复制，避免同一引导行为产生双条目污染上传统计）。同一人"未登录答一次→登录"
   * 不再被当成新用户重复引导；匿名态失去记录后再次触发引导属预期。
   * 未登录（userId=null）或已有条目时为幂等空操作。
   */
  claimAnonymousRecord(): Promise<void>;
  /** 当前用户最近一条作答（引导再次打开时预填用）；无记录返回 null。 */
  getLatestEntry(): Promise<OnboardingRecordEntry | null>;
  /**
   * 把当前用户在 record 里最近一条作答同步回 settings（换账号恢复该用户的职业/偏好，
   * 推荐区内容随之切换）。跳过页记 null 的字段按保守默认回填（职业 other、偏好关），
   * 与引导跳过行为一致；用户没有记录时不改 settings。
   */
  syncSettingsFromRecord(): Promise<OnboardingSettingsSyncPatch | null>;
  /**
   * 用户手动修改偏好后反向回写 record（record 保持"该用户最新偏好"，
   * 与 settings 手动入口一致，换号同步不会复活已关闭的开关）。当前用户无条目时忽略。
   */
  updateRecordPreferences(
    patch: Partial<
      Pick<OnboardingRecordEntryInput, "memoryEnabled" | "proactiveSuggestionsEnabled">
    >,
  ): Promise<void>;
  /** 读取整份记录文件（后续上传服务器使用）；文件不存在返回 null。 */
  getRecords(): Promise<OnboardingRecordFile | null>;
  /** 删除记录文件（调试用）。 */
  clearRecords(): Promise<void>;
}

/** 工厂入参：userId 解析注入（正式装配用 oauthCredentialRepo，测试用桩）。 */
export interface CreateOnboardingRecordServiceOptions {
  loadUserId: () => Promise<string | null>;
  /**
   * 本机是否已有任务。用于判定"老用户"——老用户升级到本版后不应被当成新用户引导。
   *
   * 不传时跳过该分支（等价于"没有本地任务"）。生产装配必须传：
   * `node.ts` 用 `taskIndexRepo.listTaskMetas({})` 非空实现，与官方 `hasExistingLocalTask` 同义。
   */
  hasExistingLocalTask?: () => Promise<boolean>;
  /**
   * 记录文件不存在时，新建文件要固化的 deviceMid 从哪里来。
   *
   * 不传时走设备身份唯一入口 ensureDeviceMid（telemetry-state.json，与 X-Device-Mid /
   * 反馈 / claim 同一个字段与锁），生产装配无需显式传。测试注入桩以避免读写真实设备文件，
   * 与 bigmodelCodingPlanSubscriptionProvider 的 resolveDeviceMid 同一套路。
   *
   * 返回值必须是 trim 后非空的字符串；空值会被当作解析失败（跳过写入并 warn），
   * 不允许写进记录文件——schema 的 min(1) 会让那份文件下次读取整份失效。
   */
  resolveDeviceMid?: () => Promise<string>;
}

export type OnboardingRecordServiceFactory = (
  options: CreateOnboardingRecordServiceOptions,
) => IOnboardingRecordService;

export const IOnboardingRecordService = createServiceDescriptor<IOnboardingRecordService>(
  ServiceChannels.OnboardingRecord,
);

export type { OnboardingRecordEntry, OnboardingRecordEntryInput, OnboardingRecordFile };
