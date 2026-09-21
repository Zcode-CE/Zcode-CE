import { ZCODE_GITHUB_MIRROR_ENV_KEY, normalizeGithubMirrorPrefix } from "@zcode/shared";

/**
 * 从进程环境读取 GitHub 加速前缀。
 *
 * 为什么走环境变量而不是直接读 AppSettings：插件安装在 agent 子进程内执行
 * （desktop → zcodeAgentService → bootstrap/zcode-protocol/plugins.ts），子进程里没有设置服务。
 * 这与 HTTP 代理、自定义 CA 完全同构 —— 宿主在 spawn agent 时把设置翻译成环境变量注入
 * （ZCODE_HTTP_PROXY 同理），子进程只消费最终值，不再复制一份设置读取与默认值逻辑。
 *
 * 非法值在这里退化为「未配置」：配置写错只应让请求回落到直连，
 * 不能因为一个前缀把插件安装整条链路打断（保存期已拒绝非法值，见 shared/githubMirror.ts）。
 */
export function resolveGithubMirrorPrefixFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return normalizeGithubMirrorPrefix(env[ZCODE_GITHUB_MIRROR_ENV_KEY]);
}
