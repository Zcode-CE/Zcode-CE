/**
 * 「服务端到底是不回话，还是在拒绝我」—— 把这两种情况分开。
 *
 * 背景（task-21 实测）：静态壳不鉴权是刻意设计，所以没有凭据也能打开页面；
 * 而未授权时服务端的 /api/* 与 /ws 全部 401。修复前 web 入口把这个 401 当成"连不上"，
 * 于是界面上显示「连接已中断，正在重连（第 N 次）」并无限重试 —— 明明服务在运行、只是没授权，
 * 既误导用户（以为是网络问题），又永远等不到结果。这里给出可测的判定与可直接照做的文案。
 */

export type AuthProbeOutcome = "authorized" | "unauthorized" | "unreachable";

export interface ServerInfoProbeResult {
  /** HTTP 状态码；网络层失败时用 networkError 表示（没有状态码）。 */
  status?: number;
  networkError?: boolean;
}

export function classifyServerInfoProbe(result: ServerInfoProbeResult): AuthProbeOutcome {
  if (result.networkError === true || typeof result.status !== "number") {
    return "unreachable";
  }
  if (result.status === 401 || result.status === 403) {
    return "unauthorized";
  }
  return result.status >= 200 && result.status < 300 ? "authorized" : "unreachable";
}

/** 未授权时给用户看的文案：必须能直接照做（怎么拿到带 token 的链接），且不再提"重连"。 */
export function buildUnauthorizedMessage(isChinese: boolean, origin: string): string {
  if (isChinese) {
    return (
      "未授权：这台服务器需要访问令牌。" +
      "请在运行服务的那台机器上，用启动时打印的带令牌链接打开一次（形如 " +
      origin +
      "/?token=<令牌>），本次访问会种下登录 cookie，之后即可直接访问本页。" +
      "若你手上没有链接：用 zcode --web --host <地址> 重新起服务会把链接打印出来；" +
      "服务端设置 ZCODE_SERVER_AUTH_TOKEN 也等于要求令牌。"
    );
  }
  return (
    "Unauthorized: this server requires an access token. " +
    "On the machine running the server, open the tokenized link printed at startup once (like " +
    origin +
    "/?token=<token>); that visit stores the login cookie and this page works afterwards. " +
    "Without a link: restart with zcode --web --host <address> to print one, or check ZCODE_SERVER_AUTH_TOKEN."
  );
}
