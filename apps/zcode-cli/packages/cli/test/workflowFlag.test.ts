import assert from "node:assert/strict";
import test from "node:test";
import { resolveZCodeBuiltinPromptCommand } from "../../bootstrap/src/builtin-prompt-command.js";
import { parseGlobalArgs } from "../src/arguments.js";
import {
  DISABLE_WORKFLOW_FLAG,
  ENABLE_WORKFLOW_FLAG,
  HEADLESS_WORKFLOW_DEFAULT_ENABLED,
  headlessWorkflowEnabled,
  headlessWorkflowRuntimeConfig,
  isHeadlessWorkflowFlagSupportedInvocation,
  resolveHeadlessWorkflowFlag,
} from "../src/workflow-flag.js";

/**
 * headless 动态工作流开关的取值与语义（上游 3.14.3 的 `--enable-workflow`）。
 *
 * 为什么这几条必须钉住：本仓库与官方的默认值相反（官方 `-p` 默认关，本仓库默认开）。
 * 一旦有人「照抄官方」把默认值改成关闭，headless 的 `/workflow` 与十个工作流工具会静默消失
 * —— 没有报错、没有日志，只是模型忽然不工作了。所以默认值本身也要有断言。
 *
 * 运行：cd apps/zcode-cli/packages/cli && node --import tsx --test test/workflowFlag.test.ts
 */

const flagOf = (argv: string[]) => resolveHeadlessWorkflowFlag(parseGlobalArgs(argv).values);

test("默认值：本仓库 headless 开启动态工作流（与官方相反）", () => {
  assert.equal(HEADLESS_WORKFLOW_DEFAULT_ENABLED, true);
  assert.equal(headlessWorkflowEnabled(undefined), true);
  // 默认态不落字段：core 与 create-app 的语义都是「缺席即开启」，写 true 只是把同一件事写两遍。
  assert.deepEqual(headlessWorkflowRuntimeConfig({}), {});
});

test("两个拼写都能被 parseArgs 接住（官方拼写不报未知参数）", () => {
  assert.equal(flagOf([ENABLE_WORKFLOW_FLAG, "-p", "x"]), true);
  assert.equal(flagOf([DISABLE_WORKFLOW_FLAG, "-p", "x"]), false);
  assert.equal(flagOf(["-p", "x"]), undefined);
});

test("显式关闭落成 dynamicWorkflowEnabled: false；显式开启仍是缺席", () => {
  assert.deepEqual(headlessWorkflowRuntimeConfig({ enableWorkflow: false }), {
    dynamicWorkflowEnabled: false,
  });
  assert.deepEqual(headlessWorkflowRuntimeConfig({ enableWorkflow: true }), {});
});

test("反向拼写优先：用户唯一能关上门的写法不被幂等拼写覆盖", () => {
  assert.equal(flagOf([ENABLE_WORKFLOW_FLAG, DISABLE_WORKFLOW_FLAG, "-p", "x"]), false);
  assert.equal(flagOf([DISABLE_WORKFLOW_FLAG, ENABLE_WORKFLOW_FLAG, "-p", "x"]), false);
});

test("打到最终消费点：关闭时 /workflow 不展开，默认时展开", () => {
  // 消费点取自 create-app 的真实调用：把 runtimeConfig.dynamicWorkflowEnabled 交给内置命令展开。
  const enabled = headlessWorkflowRuntimeConfig({ enableWorkflow: true });
  const disabled = headlessWorkflowRuntimeConfig({ enableWorkflow: false });
  assert.notEqual(
    resolveZCodeBuiltinPromptCommand("/workflow 扫一遍 i18n 键", enabled),
    undefined,
    "默认/开启态必须展开成提示词",
  );
  assert.equal(
    resolveZCodeBuiltinPromptCommand("/workflow 扫一遍 i18n 键", disabled),
    undefined,
    "关闭态必须不展开 —— 展开就等于十个工作流工具不在场时仍然指挥模型去写脚本",
  );
});

test("作用域判据只认 -p/--prompt 与 --target，且不接受位置参数", () => {
  assert.equal(isHeadlessWorkflowFlagSupportedInvocation({ positionals: [], prompt: "x" }), true);
  assert.equal(
    isHeadlessWorkflowFlagSupportedInvocation({ positionals: [], targetRequest: {} }),
    true,
  );
  // 裸 tui（无 -p/--target）⇒ 不支持：报错而不是静默忽略。
  assert.equal(isHeadlessWorkflowFlagSupportedInvocation({ positionals: [] }), false);
  assert.equal(
    isHeadlessWorkflowFlagSupportedInvocation({ positionals: ["doctor"], prompt: "x" }),
    false,
  );
});
