/**
 * CLI 登录的错误码契约：CLI/TUI 只读 `code` 与 `message`，不解析文案。
 *
 * 单独成模块，是因为登录（auth-login）与账号组自愈（auth-login-credentials）都要构造它，
 * 放在任一方都会形成循环依赖；对外仍从 auth-login.js 导出。
 */
export class ZCodeCliLoginError extends Error {
  readonly code:
    | "auth_failed"
    | "auth_timeout"
    | "config_update_failed"
    | "credential_conflict"
    | "credential_unreadable"
    | "credential_write_failed";

  constructor(
    code: ZCodeCliLoginError["code"],
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ZCodeCliLoginError";
    this.code = code;
  }
}
