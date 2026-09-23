/**
 * MCP 工具级启停（`disabledTools`）的**唯一**归一化实现与上限常量。
 *
 * 为什么这些定义必须住在 `@zcode/shared` 的**叶子模块**里（本文件不 import 任何本仓模块）：
 * 它有三个层级的消费者 ——
 *   ① wire schema（`@zcode/shared/zcode-protocol`）
 *   ② Agent DTO 投影（`@zcode/shared/mcp`）
 *   ③ CLI 侧配置 schema / 插件 MCP 归一化 / 协议还原（`@zcode/contracts` → `@zcode/adapters`、`@zcode/bootstrap`、`@zcode/core`）
 * 而依赖方向是单向的「contracts → shared」，所以常量与函数只能住在 shared 侧、由 contracts 重新导出。
 *
 * 为什么单独一个文件而不是塞进 `zcode-protocol/index.ts`：
 * - `shared/mcp.ts` **已经依赖** `zcode-protocol/index`，把定义放那里会让「协议文件 → mcp.ts」的方向也参与进来，
 *   而这层语义与协议（zod schema）无关；
 * - 本文件**不依赖 zod**，因此绕开了既有的「contracts 的 zod v3 / shared 的 zod v4 跨包耦合」约束
 *   （同类约束见 `contracts/src/interfaces/browser-control.port.ts` 的说明）—— 纯 TS 常量与纯函数没有版本问题。
 *
 * 产品规则见 `docs/development/tool-policy.md`。
 */

/**
 * 单个 MCP server 最多可关闭的工具数。
 *
 * 它是**配置校验上限**，不是产品能力上限：存在的目的是让手写/粘贴的畸形配置有一个明确的
 * 拒绝点，而不是被无界数组拖垮校验。200 已远大于任何真实 server 的工具数。
 *
 * **本文件是它的唯一所有者**；wire schema、DTO 投影、CLI 配置 schema 都从这里取（或重新导出）。
 */
export const MCP_SERVER_MAX_DISABLED_TOOLS = 200;

/** 归一化后的 `disabledTools`：已 trim、去空、去重、截断到上限。 */
export interface NormalizedMcpDisabledTools {
  /** 生效的工具名；未配置时为空数组。 */
  disabledTools: string[];
  /** 被丢弃的非字符串项数量（空串单列，见 `blankCount`）。 */
  droppedEntryCount: number;
  /** 被丢弃的空串项数量。 */
  blankCount: number;
  /** 输入不是数组 ⇒ 视为未设置。 */
  invalidShape: boolean;
  /** 去重后仍超过上限而被截断的条目数。 */
  truncatedCount: number;
}

/**
 * `disabledTools` 的**唯一**归一化函数：**所有**读该键的入口都必须调它
 * （wire schema 取上限、UI DTO 投影、CLI 配置 schema、插件 MCP 归一化、协议 DTO → runtime）。
 * 任何一处另写一份都会漂移成「同一份配置在不同入口行为不同」。
 *
 * 非法输入**不抛错**：调用方按 `invalidShape`/`dropped*`/`truncatedCount` 决定怎么告警。
 * 之所以不抛错，是因为「一个字段写错就整条 server 被丢弃」会让用户的 MCP 直接不可用 ——
 * 代价远大于收益；这里宁可「该字段不生效 + 告警」。
 */
export function normalizeMcpDisabledTools(value: unknown): NormalizedMcpDisabledTools {
  if (value === undefined || value === null) {
    return {
      disabledTools: [],
      droppedEntryCount: 0,
      blankCount: 0,
      invalidShape: false,
      truncatedCount: 0,
    };
  }
  if (!Array.isArray(value)) {
    return {
      disabledTools: [],
      droppedEntryCount: 0,
      blankCount: 0,
      invalidShape: true,
      truncatedCount: 0,
    };
  }

  const disabledTools: string[] = [];
  let droppedEntryCount = 0;
  let blankCount = 0;
  for (const entry of value) {
    if (typeof entry !== "string") {
      droppedEntryCount += 1;
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      blankCount += 1;
      continue;
    }
    if (!disabledTools.includes(trimmed)) disabledTools.push(trimmed);
  }

  const truncatedCount = Math.max(0, disabledTools.length - MCP_SERVER_MAX_DISABLED_TOOLS);
  if (truncatedCount > 0) disabledTools.length = MCP_SERVER_MAX_DISABLED_TOOLS;

  return { disabledTools, droppedEntryCount, blankCount, invalidShape: false, truncatedCount };
}
