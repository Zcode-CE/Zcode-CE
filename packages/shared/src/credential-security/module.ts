/**
 * 凭据 v2 的公开面（P1）。
 *
 * 只有后端（Desktop Host、桌面内置 agent、独立 CLI、独立 Server）可以 import 这里：
 * 系统密钥绝不进入 Renderer、通用 RPC 或日志。后续阶段只追加导出，不改已发布名。
 */
export type {
  CredentialCipher,
  CredentialKeyStore,
  CredentialRecord,
  SystemCredentialCipher,
  SystemCredentialCipherOptions,
} from "./contract.js";
export {
  CREDENTIAL_SECURE_STORAGE_UNAVAILABLE_CODE,
  CREDENTIAL_STORE_CHANGED_CODE,
  createCredentialStorageUnavailableError,
  credentialKeyFailureOf,
  isCredentialStorageUnavailableError,
  type CredentialKeyFailureDiagnostic,
  type CredentialKeyFailureStage,
} from "./credentialFailure.js";
export {
  CREDENTIAL_SOURCE_FILE,
  ENV_CIPHERTEXT_PREFIX,
  LEGACY_PREFIX,
  OS_CIPHERTEXT_PREFIX,
  OS_SOURCE_MARKER,
  PRIVATE_SECRET_FILE_NAME,
  SYSTEM_PREFIX,
  credentialSourcePath,
  isKnownCredentialCiphertext,
  isOsSourcePinned,
  needsCredentialMigration,
  privateSecretPath,
  readCredentialSource,
  readOptionalBytes,
  recordValues,
  resolveCredentialsFilePath,
  resolveCredentialsFilePathIn,
  writeCredentialRecordLocked,
  type CredentialRecordWriteOptions,
  type CredentialSourceState,
} from "./credentialFileState.js";
export {
  advanceCredentialGeneration,
  assertCredentialGeneration,
  captureCredentialGeneration,
  credentialGenerationPath,
} from "./credentialGeneration.js";
export {
  migrateCredentialRecord,
  mutateCredentialRecordLocked,
  readCredentialRecordWithMigration,
  type CredentialRecordTarget,
  type MutateCredentialRecordOptions,
} from "./credentialRecordStore.js";
export {
  createCredentialCipherByPath,
  createServerCredentialCipher,
  type CredentialCipherByPathOptions,
} from "./serverCredentialCipher.js";
export {
  createLegacyCredentialCipher,
  createSystemCredentialCipher,
} from "./systemCredentialCipher.js";
