export declare const NODE_REPL_DEFAULT_TIMEOUT_MS = 60000;
export declare const NODE_REPL_SERVER_VERSION = "0.6.0";
export declare const NODE_REPL_SERVER_INSTRUCTIONS: string;
/**
 * CUA 未启用时，给 node_repl 的 server instructions 追加一句「本会话没有 CUA」的说明。
 *
 * 为什么需要：注册条件只看「browser-use 或 cua 任一启用」，所以 CUA 关闭时模型照样拿得到
 * `mcp__node_repl__js`；它一旦尝试 Computer Use 只会撞上「桥不存在」，实测会转去自行安装驱动
 * 并猜错包名。在会话开始就把「没有 CUA、也没有任何东西需要安装」讲清楚，比等它撞错再解释更早。
 *
 * 只追加说明，不改注册逻辑（是否注册 node_repl 仍由 bootstrap 决定，见 built-in-node-repl.ts）。
 */
/**
 * CUA 未启用时追加到 `js` 工具描述末尾的一句。
 *
 * 为什么必须挂在**工具描述**上：本仓库的 MCP 集成只消费 tools/list，不消费 server 的
 * initialize `instructions`（全 CLI src 无读取点），所以 server instructions 里的说明模型看不到；
 * 工具描述是模型每次选工具时都会读到的那一份文案。
 */
export declare const JS_TOOL_DESCRIPTION_COMPUTER_USE_DISABLED_SUFFIX: string;
/** 按本会话是否启用了 CUA 解析 `js` 工具描述。 */
export declare function resolveJsToolDescription(input: {
    computerUseEnabled: boolean;
}): string;
export declare function withComputerUseAvailabilityNote(instructions: string, input: {
    computerUseEnabled: boolean;
}): string;
export declare const JS_TOOL_DESCRIPTION: string;
//# sourceMappingURL=tool-contract.d.ts.map