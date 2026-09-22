import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES, type ZCodeSlashCommand } from "@zcode/shared";
import {
  listZCodeCustomCommands,
  type ListZCodeCustomCommandsOptions,
} from "../custom-commands.js";
import {
  APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS,
  APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES,
  isReservedZCodeSlashCommandName,
} from "../slash-command-surface.js";
import { DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME } from "../app/dynamic-workflow-gate.js";

// /workflow 的名字由 dynamic-workflow-gate.ts 统一持有（展开点、目录点、灰度裁剪点三处共用）。

export interface ListProtocolSlashCommandsOptions extends ListZCodeCustomCommandsOptions {
  /**
   * 动态工作流灰度门。**只有显式 false
   * 才剔除** `workflow`：CLI 自身的目录装配（TUI / 未参与灰度的调用方）缺席该字段，
   * 必须保持原样。协议服务端一律从 appRuntimePreferences 传入显式布尔。
   */
  dynamicWorkflowEnabled?: boolean;
}

export async function listProtocolSlashCommands(
  options: ListProtocolSlashCommandsOptions = {},
): Promise<ZCodeSlashCommand[]> {
  const builtins = listAppProtocolBuiltinSlashCommands();
  let customCommands: Awaited<ReturnType<typeof listZCodeCustomCommands>>["commands"] = [];
  try {
    const outcome = await listZCodeCustomCommands(options);
    customCommands = outcome.commands;
  } catch {
    // 自定义命令发现失败不应阻断 session snapshot；保留可执行的内置协议命令。
    customCommands = [];
  }

  const catalog: ZCodeSlashCommand[] = [
    ...builtins,
    ...customCommands
      .filter((command) => !command.disableNonInteractive)
      .filter((command) => !isReservedZCodeSlashCommandName(command.name))
      .map((command) => ({
        description: command.description,
        inputHint: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
        name: command.name,
        source: "custom" as const,
      })),
  ];
  // 灰度关闭：/workflow 整体消失（内置条目与任何残留的自定义命令一起剔除）——
  // composer 的加号菜单与 `/` 面板都只读这份目录，剔除即两个入口一起消失；
  // 手打命令名的展开侧另有同一判据（builtin-prompt-command.ts）。
  const gated =
    options.dynamicWorkflowEnabled === false
      ? catalog.filter((command) => command.name !== DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME)
      : catalog;
  return pinWorkflowAfterGoal(gated);
}

/**
 * App `/` 面板按本目录顺序展示，本函数是唯一的排序点（UI 不维护排序白名单）。
 * `workflow` 现在是内置命令（3.14.3 起，此前由 zcode-guide 插件提供）；
 * 产品要求它与 `goal` 一样作为「开启一段工作」的入口，紧随 goal 之后。
 * 只调顺序：来源、去重与 reserved 规则不变；任一方缺席时保持原序。
 */
function pinWorkflowAfterGoal(commands: ZCodeSlashCommand[]): ZCodeSlashCommand[] {
  const workflowIndex = commands.findIndex(
    (command) => command.name === DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME,
  );
  if (workflowIndex < 0 || !commands.some((command) => command.name === "goal")) return commands;
  const [workflow] = commands.splice(workflowIndex, 1);
  const goalIndex = commands.findIndex((command) => command.name === "goal");
  commands.splice(goalIndex + 1, 0, workflow!);
  return commands;
}

function listAppProtocolBuiltinSlashCommands(): ZCodeSlashCommand[] {
  const sharedBuiltins = APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES.flatMap((name) => {
    const command = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find((entry) => entry.name === name);
    if (!command) return [];
    return [
      {
        description: command.summary,
        inputHint: command.usage,
        name: command.name,
        source: "builtin" as const,
      },
    ];
  });
  return [...sharedBuiltins, ...APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS];
}
