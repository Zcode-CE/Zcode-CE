import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile } from "../node/privateFilePersistence.js";
import { createCredentialStoreChangedError } from "./credentialFailure.js";

/**
 * 凭据存储代次（恢复/重置代数）。
 *
 * 为什么需要它：加密发生在凭据文件锁之外（可能经桥在别的进程完成），从加密到写盘之间
 * 可能发生过损坏恢复，把整库清空并换了密钥。若此时仍按旧结果写回，会出现「新密文 + 旧
 * 快照」的半份状态。P1 只有闸门，推进代次的是 P2 的恢复流程；闸门放在 P1 是因为它是
 * 正确性要求：一旦 P2 才引入代次文件，P1 期间已经可能发生的在途写就会漏掉。
 *
 * 代次落盘在凭据文件旁的 `<credentials.json>.recovery-generation`，内容是十进制整数。
 * 缺失或内容非法都按 0 处理：凭据文件本身损坏有既有的备份+拒绝覆盖流程，代次文件损坏
 * 不应额外阻断读取。
 */
const GENERATION_SUFFIX = ".recovery-generation";

export function credentialGenerationPath(filePath: string): string {
  return `${filePath}${GENERATION_SUFFIX}`;
}

export async function captureCredentialGeneration(filePath: string): Promise<number> {
  const raw = await readFile(credentialGenerationPath(filePath), "utf8").catch((error) => {
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** 锁内复核：代次变化说明本次加密结果可能基于已被替换的存储，必须拒绝写盘。 */
export async function assertCredentialGeneration(
  filePath: string,
  expected: number,
): Promise<void> {
  if ((await captureCredentialGeneration(filePath)) !== expected) {
    throw createCredentialStoreChangedError();
  }
}

/** 推进代次（P2 的恢复流程与测试使用）；调用方应已持有凭据文件锁。 */
export async function advanceCredentialGeneration(filePath: string): Promise<number> {
  const next = (await captureCredentialGeneration(filePath)) + 1;
  await atomicWritePrivateTextFile(credentialGenerationPath(filePath), `${next}\n`);
  return next;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
