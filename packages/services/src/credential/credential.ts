import type { CredentialFileGuard } from "@zcode/shared/credential-security";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 凭据管理服务
 *
 * 提供 key-value 形式的凭据读写。
 * 实现端（host process）负责加密存储细节，
 * 消费端（renderer）只通过 RPC 调用，不感知存储位置。
 */
export interface ICredentialService {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const ICredentialService = createServiceDescriptor<ICredentialService>(
  ServiceChannels.Credential,
);

/** OAuth 会话版本键：任何 OAuth 变更都在同一批次里轮换它（SPEC §7.3）。 */
export const OAUTH_SESSION_REVISION_KEY = "oauth:session_revision" as const;

/**
 * 凭据变更操作：batch = 一次提交影响多个键，recover = 恢复流程（keys 可能为空，表示整库）。
 * 与上游 4.0.0 的同名载荷一致，消费点据 keys 判定要失效哪些派生状态。
 */
export type CredentialMutationOperation = "save" | "delete" | "batch" | "recover";

/** Host 私有的变更通知载荷；不进 Renderer、不进 RPC。 */
export interface CredentialMutationEvent {
  operation: CredentialMutationOperation;
  /** 本次提交实际受影响的键（批量提交一次一个事件，键已去重）。 */
  keys: readonly string[];
}

export interface UpdateManyOptions {
  /** 整组 CAS 期望值（明文；null = 必须不存在）。 */
  expected?: Readonly<Record<string, string | null>>;
  /** 锁内复核调用方前提（如 session revision 未变）；抛错即放弃提交且不写盘。 */
  assertCurrent?: () => void;
}

export interface DeleteUnreadableOptions {
  expected?: Readonly<Record<string, string | null>>;
  /** 成功提交时一并删除的键，默认就是 keys。 */
  removeKeys?: readonly string[];
  /** 成功提交时写入的明文替换值（如重新下发的 JWT）。 */
  replacements?: Readonly<Record<string, string>>;
}

/**
 * Host 私有的批量凭据契约（SPEC §7.1）。
 *
 * 不进 ICredentialService、不暴露给 Renderer/RPC：批量 CAS 属于主机侧事务语义，
 * 渲染进程只需要 load/save/delete。实现见 credentialService.ts。
 */
export interface LocalCredentialService extends ICredentialService {
  /** 一次读多键（普通读取不取写锁，由读取前后代次校验拒绝旧结果）；null 只表示键不存在。 */
  loadMany(keys: readonly string[]): Promise<Record<string, string | null>>;
  /**
   * 整组条件写：expected 全部相等才应用 changes（null = 删除）。
   * 返回 false = CAS 失败且未写盘（正常竞态，不抛错）；true = 已提交。
   */
  updateMany(
    changes: Readonly<Record<string, string | null>>,
    options?: UpdateManyOptions,
  ): Promise<boolean>;
  /** 只清理锁内仍解不开的键；返回 true = 本次提交了删除或替换。 */
  deleteUnreadable(keys: readonly string[], options?: DeleteUnreadableOptions): Promise<boolean>;
  /** 锁内「没有才写」，返回最终值；多 Host 并发时收敛到先写入者。 */
  saveIfAbsent(key: string, value: string): Promise<string>;
  /** 锁内比较后删除，只删仍等于 expected 的值。 */
  deleteIfEquals(key: string, expected: string): Promise<void>;
  /** 读取并修复单个不可读键；assertCurrent 在锁内复核调用方前提。 */
  recoverUnreadable(key: string, assertCurrent: () => void): Promise<string | null>;
  /** 把「读-改-写」包成一个代次作用域，供登录等长事务使用。 */
  captureRecoveryGuard(): Promise<CredentialFileGuard>;
}

/**
 * OAuth 会话写入口的最小凭据契约：批量读 + 整组 CAS 写（SPEC §7.5 第 3 步）。
 *
 * 为什么不是完整的 LocalCredentialService：OAuth 只需这三种语义，测试替身也只需实现它们。
 * 单键 save/delete 继续留给插件、bot、MCP 等非会话键，OAuth 侧一律走整组提交 —— 逐键写入
 * 会让另一个进程的登录插进两次写之间，落盘出「A 的 token + B 的 profile」。
 */
export type OAuthSessionCredentialService = Pick<
  LocalCredentialService,
  "load" | "loadMany" | "updateMany"
>;
