import { join } from "node:path";
import type { SkillRoot } from "@zcode/contracts";

/**
 * 动态工作流灰度门在 App 装配层的两处减法。
 * 工具面的减法在 core 的 registerBuiltInTools，`/` 目录的减法在 zcode-protocol/slash-commands.ts；
 * 这里只放「命令展开」和「技能发现」这两项需要 bootstrap 侧常量/路径推导的。
 */

/**
 * `/workflow` 的命令名。官方 3.14.3 起它是**内置命令**（此前由 zcode-guide 插件以自定义命令
 * 形式提供）：展开点在 builtin-prompt-command.ts，目录暴露点在 slash-command-surface.ts，
 * 灰度裁剪点在本模块。三处必须用同一个名字，所以常量放这里。
 */
export const DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME = "workflow";

/** 内置技能名/目录名：bundled-skills 包内 `skills/dynamic-workflows`。 */
export const DYNAMIC_WORKFLOW_SKILL_NAME = "dynamic-workflows";

/** 灰度关闭时不允许展开的命令名（内置展开与自定义命令共用一份判据）。 */
export const DYNAMIC_WORKFLOW_GATED_COMMAND_NAMES: readonly string[] = [
  DYNAMIC_WORKFLOW_SLASH_COMMAND_NAME,
];

/** 内置技能包里工作流编写指南技能的目录名（skills/<dir>/SKILL.md）。 */
const DYNAMIC_WORKFLOW_SKILL_DIRECTORY_NAME = DYNAMIC_WORKFLOW_SKILL_NAME;

const SKILL_MANIFEST_FILE_NAME = "SKILL.md";

/**
 * 灰度关闭时要从技能发现中剔除的 SKILL.md 绝对路径。
 *
 * 为什么按路径而不是按 root 过滤：NodeSkillAdapter 只提供 `disabledPaths` 这一个剔除机制
 * （config.json 的 `skill.<path>.enable=false` 走的也是它），而 zcode-guide 的其余技能
 * （配置指南、各种自诊断）与灰度无关，必须继续可见——整根 root 拿掉会连坐它们。
 *
 * 为什么不按 pluginId 精确匹配 zcode-guide：插件 id 形如 `<name>@<marketplace>`，随安装
 * 来源变化；而这里推导出的路径不存在时只是一个永不命中的 Set 成员，没有副作用。
 */
export function collectDynamicWorkflowDisabledSkillPaths(
  pluginSkillRoots: readonly SkillRoot[],
): string[] {
  return pluginSkillRoots.map((root) =>
    join(root.path, DYNAMIC_WORKFLOW_SKILL_DIRECTORY_NAME, SKILL_MANIFEST_FILE_NAME),
  );
}
