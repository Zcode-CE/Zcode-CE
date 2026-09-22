import { join } from "node:path";
import {
  DYNAMIC_WORKFLOW_SKILL_NAME,
  DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME,
} from "./app/dynamic-workflow-gate.js";

const BUILTIN_PROMPT_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

interface ResolveZCodeBuiltinPromptCommandOptions {
  workingDirectory?: string;
  /**
   * 动态工作流灰度门：**显式 false** 时 `/workflow` 不展开成提示词。
   * 与 `/` 目录侧的剔除同一判据；缺席（TUI、headless、workflow_child 等未参与灰度的调用方）
   * 不设门禁。
   */
  dynamicWorkflowEnabled?: boolean;
}

/**
 * 内置提示词命令（不经过自定义命令发现，直接由入口层展开）。
 *
 * `/init` 与 `/workflow` 都在这里：官方 3.14.3 把 `/workflow` 从 zcode-guide 插件
 * 收成内置命令，理由与把 dynamic-workflows 技能收进 bundled-skills 一样 ——
 * 它服务的工具面由 runtime 注册，入口就不能由插件启停决定。
 */
export function resolveZCodeBuiltinPromptCommand(
  input: string,
  options: ResolveZCodeBuiltinPromptCommandOptions = {},
): string | undefined {
  const invocation = parseBuiltinPromptCommandInvocation(input);
  if (!invocation) {
    return undefined;
  }

  if (invocation.name === DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME) {
    return options.dynamicWorkflowEnabled === false ? undefined : buildWorkflowPrompt(invocation.args);
  }

  if (invocation.name !== "init") {
    return undefined;
  }

  const workingDirectory = options.workingDirectory ?? process.cwd();
  return buildInitAgentsPrompt({
    args: invocation.args,
    targetPath: join(workingDirectory, "AGENTS.md"),
    workingDirectory,
  });
}

/**
 * `/workflow` 的提示词正文：逐字对齐官方 3.14.3 的内置命令模板
 * （官方 `expandBuiltinWorkflowCommandPrompt` 的 `HAn` 常量），只把 `$ARGUMENTS`
 * 换成用户实际输入。改词就等于改产品行为，务必与官方对齐后再动。
 */
function buildWorkflowPrompt(args: string): string {
  return [
    `Use the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill to design and launch a dynamic workflow for this request:`,
    "",
    args,
    "",
    "Decide the subagent topology before writing any code: how many subagents, which of them",
    "share a context, what result each one returns. Then write the script and call the",
    "`CreateWorkflow` tool. (`CreateWorkflow` is the dynamic-workflow tool. Do not use the",
    "legacy `Workflow` tool, and do not substitute the `Agent` tool.)",
    "",
  ].join("\n");
}

function parseBuiltinPromptCommandInvocation(input: string): { args: string; name: string } | null {
  const match = BUILTIN_PROMPT_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}

function buildInitAgentsPrompt(params: {
  args: string;
  targetPath: string;
  workingDirectory: string;
}): string {
  const additionalInstructions = params.args
    ? ["", "Additional user instructions supplied with /init:", "```text", params.args, "```"].join(
        "\n",
      )
    : "";

  return [
    "You are running ZCode's built-in /init command.",
    "",
    "Your task is to create or update a concise workspace instruction file for future ZCode agents.",
    "",
    "Target:",
    `- Workspace directory: ${params.workingDirectory}`,
    `- Instruction file: ${params.targetPath}`,
    `- Existing hidden instruction candidates: ${join(params.workingDirectory, ".zcode", "AGENTS.md")} and ${join(params.workingDirectory, ".agents", "AGENTS.md")}`,
    "- File name must be exactly AGENTS.md.",
    "- This command targets the current workspace only. Do not write ~/.zcode/AGENTS.md.",
    additionalInstructions,
    "",
    "Process:",
    "1. First check whether .zcode/AGENTS.md or .agents/AGENTS.md exists in the workspace. If either exists, tell the user they already have an instructions file, mention the path found, and stop without creating a new AGENTS.md.",
    "2. Inspect the repository before writing. Prefer Read, Glob, Grep, and safe Bash commands such as ls, find, git status, and package-manager script inspection.",
    "3. If AGENTS.md already exists, read it first and update it with Edit instead of replacing it wholesale.",
    "4. If AGENTS.md does not exist, create it at the workspace root.",
    "5. Keep the file practical and short enough for future agents to read quickly.",
    "6. Include only project-specific facts future ZCode agents would otherwise miss.",
    "7. Ask the user only if a repository-specific decision cannot be inferred and would materially change the file.",
    "",
    "Recommended AGENTS.md content:",
    "- Repository purpose and major directories.",
    "- Build, typecheck, lint, and focused test commands discovered from the repo.",
    "- Architecture boundaries and layer rules that matter for edits.",
    "- Coding conventions, import/path rules, logging rules, UI/design rules, and platform compatibility constraints if present.",
    "- Known gotchas for desktop app, web, remote, stdio, protocols, or agent runtime if this repo has them.",
    "- Any documentation files that agents should read before changing sensitive areas.",
    "",
    "After creating or editing AGENTS.md, summarize the main sections you wrote and mention the file path.",
  ].join("\n");
}
