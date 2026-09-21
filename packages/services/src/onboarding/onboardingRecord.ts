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
   * 1. 当前用户已有 `dismissed` 决策 → false（用户关闭过，重启不再弹）
   * 2. 本机已有任务（`hasExistingLocalTask`）→ 落一条 `existing_local_user` 决策后返回 false
   *    （老用户不该被当成新用户引导）
   * 3. 当前用户没有对应条目或文件不存在 → true
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
}

export type OnboardingRecordServiceFactory = (
  options: CreateOnboardingRecordServiceOptions,
) => IOnboardingRecordService;

export const IOnboardingRecordService = createServiceDescriptor<IOnboardingRecordService>(
  ServiceChannels.OnboardingRecord,
);

export type { OnboardingRecordEntry, OnboardingRecordEntryInput, OnboardingRecordFile };
