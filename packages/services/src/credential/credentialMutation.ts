import type { CredentialMutationEvent } from "./credential.js";

/**
 * 凭据变更事件的消费判定。
 *
 * 为什么单独成文件：判定必须能脱离 Host 装配过程被穷举验证。漏掉一个敏感键的后果是
 * 「账号已经切换、旧账号的 plugin-ui 实例仍存活」——没有报错，只能靠断言钉住。
 */
const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const ACCOUNT_USER_INFO_KEY_PATTERN = /^oauth:[^:]+:user_info$/;

/** 账号面键：切换或清理账号时必然变化，派生状态（plugin-ui 实例、账号缓存）必须失效。 */
export function isAccountSurfaceCredentialKey(key: string): boolean {
  return key === ACTIVE_PROVIDER_KEY || ACCOUNT_USER_INFO_KEY_PATTERN.test(key);
}

/** 变更事件里任一键命中账号面即为命中；批量提交不得因集合化而漏判。 */
export function credentialMutationTouchesAccountSurface(event: CredentialMutationEvent): boolean {
  return event.keys.some(isAccountSurfaceCredentialKey);
}
