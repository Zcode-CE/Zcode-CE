/**
 * 凭据密钥失败的受控分类（凭据 v2 P1）。
 *
 * 三个错误码必须互相区分，否则上层会把「存储不可用」当成「登录失效」并触发
 * 既有 OAuth 恢复逻辑删除登录态（SPEC 不变式 I3）：
 * - `CREDENTIAL_SECURE_STORAGE_UNAVAILABLE`：密钥来源不可用/配置错（可重试，不是坏密文）
 * - `ZCODE_CREDENTIAL_DECRYPT_FAILED`：密文本身解不开（既有 OAuth 恢复的判据，见 ../oauth.ts）
 * - `ZCODE_CREDENTIAL_STORE_CHANGED`：加密后、写盘前存储代次变化（调用方重试一次）
 *
 * P1 只产出 stage 子集：config / source / managed / load / read / create / verify / missing /
 * invalid / fallback。类型里保留 P2 的诊断全集，避免二次改名破坏已发布面。
 */
export type CredentialKeyFailureStage =
  | "config"
  | "source"
  | "file"
  | "managed"
  | "load"
  | "read"
  | "create"
  | "verify"
  | "missing"
  | "invalid"
  | "pin"
  | "fallback"
  | "lock";

/** 受控诊断：只含阶段与固定格式的错误码，不含密钥、凭据值、路径或原生错误正文。 */
export interface CredentialKeyFailureDiagnostic {
  stage: CredentialKeyFailureStage;
  /** Node.js 错误码，如 `ENOENT`、`EPERM`、`ZCODE_FILE_LOCK_TIMEOUT`。 */
  errorCode?: string;
  /** 系统错误号，如 Windows `8` = `ERROR_NOT_ENOUGH_MEMORY`。 */
  osCode?: number;
}

export const CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE =
  "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" as const;
export const CREDENTIAL_STORE_CHANGED_CODE = "ZCODE_CREDENTIAL_STORE_CHANGED" as const;

/** 带受控诊断的存储不可用错误；`diagnostic` 可用于日志分类，不含任何机密。 */
export interface CredentialStorageUnavailableError extends Error {
  readonly code: typeof CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE;
  readonly diagnostic: CredentialKeyFailureDiagnostic;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getNumericCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  for (const key of ["osCode", "errno"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function toCredentialKeyFailureDiagnostic(
  stage: CredentialKeyFailureStage,
  cause?: unknown,
): CredentialKeyFailureDiagnostic {
  const diagnostic: CredentialKeyFailureDiagnostic = { stage };
  const errorCode = getErrorCode(cause);
  const osCode = getNumericCode(cause);
  if (errorCode !== undefined) diagnostic.errorCode = errorCode;
  if (osCode !== undefined) diagnostic.osCode = osCode;
  return diagnostic;
}

/**
 * 构造「密钥存储不可用」。消息只描述用户可以采取的动作，不带密钥、不重复原生错误正文
 * ——原生错误正文在多平台可能包含条目名或路径。
 */
export function createCredentialStorageUnavailableError(
  stage: CredentialKeyFailureStage,
  cause?: unknown,
): CredentialStorageUnavailableError {
  const error = new Error(
    "System credential storage is unavailable. Unlock the OS credential store and restart to retry. " +
      "Headless deployments must provide ZCODE_CREDENTIAL_SECRET, a readable " +
      "ZCODE_CREDENTIAL_SECRET_FILE, or an existing private 32–4096 byte credential-secret file " +
      "in the credentials directory. Do not configure both managed secret sources.",
  ) as CredentialStorageUnavailableError;
  Object.defineProperty(error, "code", { value: CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE });
  Object.defineProperty(error, "diagnostic", {
    value: toCredentialKeyFailureDiagnostic(stage, cause),
  });
  error.name = "CredentialStorageUnavailableError";
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function isCredentialStorageUnavailableError(
  error: unknown,
): error is CredentialStorageUnavailableError {
  return getErrorCode(error) === CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE;
}

/** 读取任意错误上的受控诊断；不是本模块的存储错误时返回 null。 */
export function credentialKeyFailureOf(error: unknown): CredentialKeyFailureDiagnostic | null {
  if (typeof error !== "object" || error === null) return null;
  const diagnostic = (error as { diagnostic?: unknown }).diagnostic;
  if (typeof diagnostic !== "object" || diagnostic === null) return null;
  const stage = (diagnostic as { stage?: unknown }).stage;
  return typeof stage === "string" ? (diagnostic as CredentialKeyFailureDiagnostic) : null;
}

/** 加密后、写盘前存储代次变化：调用方按当前存储重试一次，不得写入旧结果。 */
export function createCredentialStoreChangedError(): Error {
  return Object.assign(
    new Error(
      "Credential store changed while this value was being encrypted; retry against the current store.",
    ),
    { code: CREDENTIAL_STORE_CHANGED_CODE },
  );
}
