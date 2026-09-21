export interface DefaultPluginMarketplace {
  id: string;
  source: string;
  name: string;
  description: string;
  pluginCount: number;
  lastUpdated?: string;
}

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "zcode-plugins-official";

/**
 * Anthropic 维护的 Claude Code 插件目录。
 *
 * 来源：`anthropics/claude-plugins-official`（Apache-2.0）。它**不是本项目维护的市场**，
 * 收录的是第三方插件；加它只为让用户能安装社区插件（Superpowers、context7 等），
 * 不代表本项目对其内容做任何背书。
 */
export const CLAUDE_PLUGINS_OFFICIAL_MARKETPLACE_ID = "claude-plugins-official";

/**
 * 官方插件在「用户未显式配置」时的默认启用集合。
 *
 * Settings 三类资源发现共用；集合内容与官方发行版**完全一致**（10 项）。
 *
 * ⚠️ 其中 2 项在本仓库没有实体，因此当前是**无效条目**：`image-search`、`pdf`。
 *
 * （fix.3 前这里是 5 项 —— `skill-creator`、`plugin-creator`、`zcode-guide` 曾同样无实体，
 * 本轮已按上游 MIT 原样搬入，见 docs/development/official-diff.md。）
 *
 * 这不是本仓库删除了声明，而是这两项的**实体不适于随本仓库分发**：`pdf` 官方授权仅限
 * 非商业使用；`image-search` 的能力在官方服务端且需官方账号鉴权，本地实现无意义。
 * 注意这两项都**不是**「仅分发编译产物」—— 真正只发编译产物的是 `android-emulator` 与
 * `ios-simulator`，而它们本就不在本名单内。判定链是
 * `candidate.defaultEnabled || DEFAULT_ENABLED.has(pluginId)` —— 没有 candidate
 * 时这段逻辑不会执行，所以无效条目**不产生运行时错误**，只是不生效。
 *
 * 保留它们而不是删除，是为了与上游保持一致：这些能力将来可能补齐
 * （PDF 与会话迁移已在 README 的后续计划里），删除声明会让后续同步上游时产生冲突。
 */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@zcode-plugins-official",
  // 名单里仍有 2 项本仓库无实体（image-search、pdf），保留是为与上游保持一致；
  // 判定链见上方 doc comment —— 无 candidate 时不执行，不产生运行时错误。
  "image-search@zcode-plugins-official",
  "documents@zcode-plugins-official",
  "pdf@zcode-plugins-official",
  "presentations@zcode-plugins-official",
  "spreadsheets@zcode-plugins-official",
  // node_repl 宿主：不进市场、不对用户露出，也不贡献任何 skill/command/subagent，但必须
  // 始终可用 —— node_repl 的注册门禁是「Browser Use 或 Computer Use 任一启用」，宿主自己
  // 不参与那个判断。Browser Use 默认开着，宿主若默认关就等于它上来就没有宿主。
  "node-repl-host@zcode-plugins-official",
  "skill-creator@zcode-plugins-official",
  "plugin-creator@zcode-plugins-official",
  "zcode-guide@zcode-plugins-official",
  // 电脑控制回退为默认关闭，故 computer-use 不在此名单内。
]);

export const DEFAULT_PLUGIN_MARKETPLACES: DefaultPluginMarketplace[] = [
  {
    // ZCode 官方市场：本地 seed 分片与 CDN 分片在 Agent storage 内合并。
    // CDN manifest 的 name 必须与该 canonical id 一致。
    id: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    source: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
    name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description: "Official ZCode plugins marketplace: built-in and community plugins for ZCode.",
    pluginCount: 0,
  },
  {
    // 社区插件入口。上游开源代码里只保留了第一个市场，导致 Superpowers、context7 等
    // 社区插件没有安装入口 —— 这里补上，字段与官方发行版一致。
    //
    // 注意：该市场由 Anthropic 维护、收录第三方插件；本项目不背书其内容，
    // 也不对其插件质量或许可负责，用户安装前应自行确认。
    id: CLAUDE_PLUGINS_OFFICIAL_MARKETPLACE_ID,
    source: "anthropics/claude-plugins-official",
    name: CLAUDE_PLUGINS_OFFICIAL_MARKETPLACE_ID,
    description:
      "Directory of popular Claude Code extensions including development tools, productivity plugins, and MCP integrations",
    pluginCount: 0,
  },
];

// 商店「公开」分段只有一个 ZCode 官方市场 id，内置与 CDN 不再拆分身份。
export const PUBLIC_STORE_MARKETPLACE_IDS = [ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID] as const;

export function isPublicStoreMarketplaceId(id: string): boolean {
  return (PUBLIC_STORE_MARKETPLACE_IDS as readonly string[]).includes(id);
}
