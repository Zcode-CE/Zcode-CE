import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES, type ZCodeSlashCommand } from "@zcode/shared";
import { DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME } from "./app/dynamic-workflow-gate.js";

export const APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES = [
  "goal",
  "compact",
  "init",
] as const;

/** 仅供 App Composer 使用的命令，不扩展 CLI TUI/help surface。 */
export const APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS = [
  {
    description: "Switch to Plan mode and optionally send a task.",
    inputHint: "/plan [task]",
    name: "plan",
    source: "builtin",
  },
  {
    // 3.14.3：官方把 /workflow 从 zcode-guide 插件收成内置命令（其内置 help 表里的同名条目
    // summary 就是这句）。因为不在共享 help 表里，这里按 App-only 内置命令登记；
    // 展开实现见 bootstrap/src/builtin-prompt-command.ts，灰度剔除去见 zcode-protocol/slash-commands.ts。
    description: "Design and launch a dynamic workflow for a task.",
    inputHint: "/workflow [what the workflow should accomplish]",
    name: DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME,
    source: "builtin",
  },
] as const satisfies readonly ZCodeSlashCommand[];

const EXTRA_RESERVED_SLASH_COMMAND_NAMES = [
  "compress",
  "plan",
  // /workflow 已是内置命令：用户/插件自定义命令不得再占用该名字，否则目录里会出现两个同名条目，
  // 展开也会被内置实现抢先（官方同样把 workflow 当作 known 命令）。
  DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME,
] as const;

const RESERVED_SLASH_COMMAND_NAMES = new Set(
  BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.flatMap((entry) => [
    entry.name,
    ...(entry.aliases ?? []),
  ]).concat([...EXTRA_RESERVED_SLASH_COMMAND_NAMES]),
);

function normalizeZCodeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function isReservedZCodeSlashCommandName(name: string): boolean {
  return RESERVED_SLASH_COMMAND_NAMES.has(normalizeZCodeSlashCommandName(name));
}
