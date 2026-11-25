import { AsyncLocalStorage } from "node:async_hooks";
import { assertCredentialGeneration, captureCredentialGeneration } from "./credentialGeneration.js";

/**
 * 凭据代次作用域（SPEC §7 批量契约的底座）。
 *
 * 为什么需要作用域，而不是每次现读代次：登录这类长事务跨越「读快照 → 系统交互 → 整组写」，
 * 中途可能发生损坏恢复并换了密钥。若写盘时只比较写前一刻的代次，恢复之前开始、恢复之后提交的
 * 旧事务仍可能把旧结果盖上；作用域把事务起始代次固定下来，写入口在锁内复核的就是这个起始值
 * （SPEC §7.2.4「代次作用域覆盖加密与锁内写盘」）。
 *
 * 用 AsyncLocalStorage 而不是模块级变量：同一进程里 Host 与内嵌 CLI 可能并发处理两个账号切换，
 * 用模块级代次会让互相无关的事务串行化并互相误杀。
 */
export type CredentialFileGuard = <T>(operation: () => Promise<T>) => Promise<T>;

const generationScopes = new AsyncLocalStorage<Map<string, number>>();

/** 作用域内取事务起始代次；无作用域时读磁盘当前代次。写入口用它领取 expectedGeneration。 */
export async function currentCredentialGeneration(filePath: string): Promise<number> {
  const scoped = generationScopes.getStore()?.get(filePath);
  return scoped ?? (await captureCredentialGeneration(filePath));
}

/** 已处于作用域时复用其代次（不重新采样），否则本次采样并建立作用域。 */
export async function withCredentialGenerationScope<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (generationScopes.getStore()?.has(filePath) === true) return await operation();
  const scopes = new Map(generationScopes.getStore() ?? []);
  scopes.set(filePath, await captureCredentialGeneration(filePath));
  return await generationScopes.run(scopes, operation);
}

/**
 * 把「读-改-写」包成一个代次作用域（SPEC §7.1 的 captureRecoveryGuard）。
 *
 * 与 withCredentialGenerationScope 的区别：守卫在操作前后都复核同一代次，因此事务期间发生
 * 恢复/重置时，即使写入口本身已经在锁内复核过，也会在守卫出口再报一次
 * ZCODE_CREDENTIAL_STORE_CHANGED，调用方按当前存储重试一次即可。
 * 已在作用域内调用时复用外层代次：嵌套守卫必须指回同一个事务起点，不能各自采样。
 */
export async function captureCredentialRecoveryGuard(
  filePath: string,
): Promise<CredentialFileGuard> {
  const generation = await currentCredentialGeneration(filePath);
  const scopes = new Map(generationScopes.getStore() ?? []);
  scopes.set(filePath, generation);
  return async <T>(operation: () => Promise<T>): Promise<T> =>
    await generationScopes.run(scopes, async () => {
      await assertCredentialGeneration(filePath, generation);
      const result = await operation();
      await assertCredentialGeneration(filePath, generation);
      return result;
    });
}
