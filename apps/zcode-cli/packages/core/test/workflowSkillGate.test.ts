import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowToolEntry } from "../src/tool/handlers/create-workflow.js";
import { amendWorkflowToolEntry } from "../src/tool/handlers/amend-workflow.js";
import { saveWorkflowToolEntry } from "../src/tool/handlers/save-workflow.js";
import { evalWorkflowSnippetToolEntry } from "../src/tool/handlers/eval-workflow-snippet.js";
import {
  WORKFLOW_SKILL_NOT_LOADED_CODE,
  amendWorkflowNeedsSkill,
  createWorkflowNeedsSkill,
  requireDynamicWorkflowSkill,
} from "../src/tool/handlers/workflow-skill-gate.js";
import { sessionHasLoadedSkill } from "../src/agent/loaded-skills.js";
import type { ToolInputResolutionContext } from "../src/tool/types.js";

/**
 * 技能门（task-98）。
 *
 * 断言打在最终消费点：不是「gate 函数返回了 failure」，而是四个工具的 resolveInput
 * （executor 在 hook、权限与确认窗之前唯一会调的那个钩子）真的拒绝。
 * 依据：上游 v3.14.3 的 workflow-skill-gate.ts，与我方逐字节相同的技能正文
 * （bundled-skills/skills/dynamic-workflows/SKILL.md §16：「each of them refuses to run until
 * this skill has been loaded in the session」）。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/workflowSkillGate.test.ts
 */

const NOT_LOADED: ToolInputResolutionContext = { hasLoadedSkill: () => false };
const LOADED: ToolInputResolutionContext = { hasLoadedSkill: () => true };
/** 探针缺席：没有 skillPort 的会话（子代理、headless 精简装配）——门不得生效。 */
const NO_PROBE: ToolInputResolutionContext = {};

function refuse(
  entry: { resolveInput?: (input: unknown, context: ToolInputResolutionContext) => unknown },
  input: unknown,
  context: ToolInputResolutionContext,
): { errorCode?: number; message?: string } | undefined {
  const out = entry.resolveInput?.(input, context) as
    | { result: true; input: unknown }
    | { result: false; errorCode: number; message: string }
    | undefined;
  if (out !== undefined && out.result === false) return out;
  return undefined;
}

test("CreateWorkflow：未加载技能时 resolveInput 拒绝，且拒绝文案点名技能与工具", () => {
  const out = refuse(createWorkflowToolEntry, { script: "return 1;", name: "x" }, NOT_LOADED);
  assert.ok(out, "未加载技能时必须拒绝");
  assert.equal(out.errorCode, WORKFLOW_SKILL_NOT_LOADED_CODE);
  assert.match(out.message ?? "", /dynamic-workflows/);
  assert.match(out.message ?? "", /CreateWorkflow/);
  assert.match(out.message ?? "", /Skill tool/);
  assert.match(out.message ?? "", /Nothing was started/);
});

test("CreateWorkflow：加载技能后放行到归一化（不再返回技能门失败）", () => {
  const out = refuse(createWorkflowToolEntry, { script: "return 1;", name: "x" }, LOADED);
  // 归一化本身需要 workingDirectory；这里只断言「不再是技能门那条拒绝」。
  if (out) assert.notEqual(out.errorCode, WORKFLOW_SKILL_NOT_LOADED_CODE);
});

test("CreateWorkflow：按名字跑保存的工作流不需要技能（上游的例外）", () => {
  // 例外也打在最终消费点：saved-only 的调用穿过 resolveInput 时不得拿到技能门那条 428。
  // （没有 run 端口时归一化会以「找不到这个保存的工作流」失败，那是另一条路径，不是技能门。）
  const savedOnly = refuse(createWorkflowToolEntry, { saved: { name: "pr-review" } }, NOT_LOADED);
  if (savedOnly) assert.notEqual(savedOnly.errorCode, WORKFLOW_SKILL_NOT_LOADED_CODE);
  assert.equal(createWorkflowNeedsSkill({ saved: { name: "pr-review" } }), false);
  assert.equal(createWorkflowNeedsSkill({ saved: { name: "pr-review" }, script: "x" }), true);
  assert.equal(createWorkflowNeedsSkill({ path: "a.ts" }), true);
  assert.equal(createWorkflowNeedsSkill({ script: "return 1;" }), true);
  assert.equal(createWorkflowNeedsSkill(undefined), true);
  assert.equal(createWorkflowNeedsSkill([]), true);
});

test("AmendWorkflow：只改设定的调用放行，带 path 或 script 的拒绝", () => {
  assert.equal(amendWorkflowNeedsSkill({ run_id: "r", max_concurrency: 2 }), false);
  assert.equal(amendWorkflowNeedsSkill({ run_id: "r", script: "return 1;" }), true);
  assert.equal(amendWorkflowNeedsSkill({ run_id: "r", path: "a.ts" }), true);
  assert.equal(amendWorkflowNeedsSkill(undefined), true);

  const settingsOnly = refuse(amendWorkflowToolEntry, { run_id: "r", max_concurrency: 2 }, NOT_LOADED);
  assert.equal(settingsOnly, undefined, "只改设定的调用不得被技能门拒绝");
  const withScript = refuse(amendWorkflowToolEntry, { run_id: "r", script: "return 1;" }, NOT_LOADED);
  assert.ok(withScript);
  assert.equal(withScript.errorCode, WORKFLOW_SKILL_NOT_LOADED_CODE);
  assert.match(withScript.message ?? "", /AmendWorkflow/);
});

test("SaveWorkflow 与 EvalWorkflowSnippet：未加载技能时同样拒绝", () => {
  for (const [entry, toolName] of [
    [saveWorkflowToolEntry, "SaveWorkflow"],
    [evalWorkflowSnippetToolEntry, "EvalWorkflowSnippet"],
  ] as const) {
    const out = refuse(entry, { script: "return 1;", name: "x", scope: "project" }, NOT_LOADED);
    assert.ok(out, `${toolName} 未加载技能时必须拒绝`);
    assert.equal(out.errorCode, WORKFLOW_SKILL_NOT_LOADED_CODE);
    assert.match(out.message ?? "", new RegExp(toolName));
  }
});

test("探针缺席时不设门：没有 Skill 工具的会话仍可提交脚本", () => {
  assert.equal(requireDynamicWorkflowSkill(NO_PROBE, "CreateWorkflow"), undefined);
  const out = refuse(createWorkflowToolEntry, { script: "return 1;", name: "x" }, NO_PROBE);
  if (out) assert.notEqual(out.errorCode, WORKFLOW_SKILL_NOT_LOADED_CODE);
});

test("sessionHasLoadedSkill：判据取自历史，只有成功闭合的 Skill 调用才算", () => {
  const entries = [
    {
      message: {
        role: "assistant" as const,
        content: "",
        toolCalls: [{ id: "c1", name: "Skill", input: { skill: "dynamic-workflows" } }],
      },
    },
  ];
  assert.equal(sessionHasLoadedSkill(entries, "dynamic-workflows"), false, "只有调用、没有结果不算");
  assert.equal(
    sessionHasLoadedSkill(
      [...entries, { message: { role: "tool" as const, content: "ok", toolCallId: "c1" } }],
      "dynamic-workflows",
    ),
    true,
  );
  assert.equal(
    sessionHasLoadedSkill(
      [...entries, { message: { role: "tool" as const, content: "no", toolCallId: "c1", isError: true } }],
      "dynamic-workflows",
    ),
    false,
    "结果 isError 不算成功加载",
  );
  assert.equal(
    sessionHasLoadedSkill(
      [...entries, { message: { role: "tool" as const, content: "ok", toolCallId: "other" } }],
      "dynamic-workflows",
    ),
    false,
    "toolCallId 对不上不算",
  );
  assert.equal(sessionHasLoadedSkill(entries, "docx"), false, "别的技能不算");
  assert.equal(
    sessionHasLoadedSkill(
      [
        {
          message: {
            role: "assistant" as const,
            content: "",
            toolCalls: [{ id: "c2", name: "Skill", input: { name: "dynamic-workflows" } }],
          },
        },
        { message: { role: "tool" as const, content: "ok", toolCallId: "c2" } },
      ],
      "dynamic-workflows",
    ),
    true,
    "旧形 { name } 也要认（contracts 的 SkillInputSchema 两种都收）",
  );
  assert.equal(
    sessionHasLoadedSkill(
      [
        { kind: "attachment" as const, content: "x", metadata: { source: "real_user" as const } },
        {
          message: {
            role: "assistant" as const,
            content: "",
            toolCalls: [{ id: "c3", name: "Skill", input: { skill: "dynamic-workflows" } }],
          },
        },
        { message: { role: "tool" as const, content: "ok", toolCallId: "c3" } },
      ],
      "dynamic-workflows",
    ),
    true,
    "attachment 条目不得打断判据",
  );
});
