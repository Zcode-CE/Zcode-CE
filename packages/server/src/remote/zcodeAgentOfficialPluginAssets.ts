import { posix } from "node:path";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME = "packages";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES = ["browser-use-plugin"] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS = [
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // 开发态远程插件复制使用独立白名单，遗漏 agents 会只在远端丢失子代理。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // Browser bootstrap 会从插件根目录动态导入 scripts/browser-client.mjs。
  // 开发态 SSH 部署若漏掉 scripts，会出现 MCP server 已启动但浏览器绑定无法初始化的半成品状态。
  "scripts",
  "skills",
  "templates",
] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS = [
  ...REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES.map(
    (packageName) => `${packageName}/.zcode-plugin/plugin.json`,
  ),
  // 只校验 Browser Use manifest 会把“有插件壳”的残缺目录
  // 误判为可复用。生产 remote、开发态 remote 与 release source 校验共用这份必需资产合同。
  //
  // 这里只能列 browser-use **自己产出**的资产。node_repl 宿主抽成 @zcode/node-repl-host 后
  // browser-use 不再产出 dist/mcp/server.js；
  // 本清单里指向不存在的文件，会让远端资产校验对着幽灵路径报缺失。
  //
  // 远端口径（2026-10-04 校准，C34）：
  // - 远端 glm 组件随包带 browser-use 插件正文与 node_repl 宿主（prepare-prebuilds.mjs
  //   每次必 stage，宿主的 dist/mcp/server.js 由 staging 侧的可复用完整性清单兜底）；
  // - 不承载 bua/cua 的能力：浏览器操作依赖桌面宿主注入的 browserControlPort（远端
  //   SSH/Docker 链路不提供），电脑控制还需要 CUA Helper / 原生驱动与 zcode-cua-plugin
  //   资产（全部不进远端）；
  // - 这份合同是下限（minimum）：只钉必须即刻满足的 browser-use 内容；宿主与其余
  //   内容插件（office / pdf / 纯内容插件 / bundled-skills）staging 侧已 stage，
  //   由 remoteOfficialPluginRequiredPaths 的完整性判据兜底，不在此重复要求。
  //
  // PACKAGE_NAMES 同时是开发态远端 staging 的驱动（zcodeAgentDevDeploy 逐名拷贝插件
  // 源码并按本清单断言资产）：把 node-repl-host 加进来会让 dev 部署要求本地先构建宿主
  // dist，属口径变更——等“远端承载 bua/cua”的产品口径变化时再动（F3-1 §9.2 第 2 条），
  // 而不是把宿主产物挂回 browser-use 名下。
  "browser-use-plugin/docs/api.json",
  "browser-use-plugin/docs/documents.json",
  "browser-use-plugin/docs/overview.md",
  // 远端缓存若缺少 recording 正文，documents.json 仍会错误宣告该 lookup 可用。
  "browser-use-plugin/docs/recording.md",
  "browser-use-plugin/docs/workflow.md",
  "browser-use-plugin/scripts/browser-client.mjs",
  "browser-use-plugin/skills/control-browser/SKILL.md",
  "browser-use-plugin/skills/web-gui-tester/SKILL.md",
  // 仅校验 manifest 无法发现文档插件缺少技能正文或视觉评审 Agent。
] as const;

export function buildRemoteAgentOfficialPluginDir(remoteProviderDir: string): string {
  return posix.join(remoteProviderDir, REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME);
}

export function buildRemoteAgentOfficialPluginSourceRelativePath(params: {
  runtimeResourceDir: string;
  platformArch: string;
}): string {
  return posix.join(
    params.runtimeResourceDir,
    params.platformArch,
    REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME,
  );
}

export function buildRemoteAgentOfficialPluginRequiredPaths(remoteProviderDir: string): string[] {
  const remoteOfficialPluginDir = buildRemoteAgentOfficialPluginDir(remoteProviderDir);
  return REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS.map((relativePath) =>
    posix.join(remoteOfficialPluginDir, relativePath),
  );
}
