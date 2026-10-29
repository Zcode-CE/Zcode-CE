// ============================================================
// CreateWorkflow Tool Entry（入口与声明）
// ============================================================
// 静态分析 + 用户确认 + 后台启动 dynamic-workflow run 的工具入口。
//
// handler 执行体与私有助手在 create-workflow-handler.ts（拆分见该文件头；
// 单文件 ≤400 行约束）。本文件持有 schema 桥、确认窗、权限声明与结果格式化。
// NOTE 常量与两个导出工具函数由 handler 文件定义、此处重导出，
// amend-workflow 的既有导入路径不变。

import {
  CreateWorkflowInputJsonSchema,
  CreateWorkflowInputSchema,
  CreateWorkflowOutputJsonSchema,
  CreateWorkflowOutputSchema,
  type ModelMessageContent,
} from "@zcode/contracts";
import type { ToolApprovalGate, ToolEntry } from "../types.js";
// Modified by ZCode: 拆分后从 handler 文件导入执行体与共用工具（重导出见文件尾）。
import {
  createWorkflowHandler,
  describeWorkflowConcurrencyLimit,
  resolveTraceContext,
  DIAGNOSTICS_NOT_EXECUTED_NOTE,
  EXECUTION_UNAVAILABLE_NOTE,
} from "./create-workflow-handler.js";
import { CREATE_WORKFLOW_TOOL_DESCRIPTION } from "./create-workflow-description.js";
import { createWorkflowNeedsSkill, requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";
import {
  CREATE_WORKFLOW_FAILURE_CODE,
  resolveCreateWorkflowInput,
  validateCreateWorkflowSource,
} from "./create-workflow-source.js";
import { displayOfAnalysis } from "./workflow-analysis-display.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import {
  applyWorkflowSettingsAdjustments,
  withWorkflowAdjustableSettings,
} from "./workflow-settings-adjustment.js";

const CREATE_WORKFLOW_TOOL_NAME = "CreateWorkflow";
const CREATE_WORKFLOW_TIMEOUT_MS = 15_000;
const CREATE_WORKFLOW_MODEL_BYTES = 24_000;

/**
 * 判断"运行这段脚本"值不值得打断用户，并构造确认窗要渲染的预览。
 *
 * **对两条来源是同一段代码**：走到这里输入已被 `resolveInput` 归一化，`script` 一定在场，
 * 所以这里既不知道也不需要知道脚本是内联写的还是从磁盘读的。saved run 的确认窗因此与内联
 * 逐字节同形——这正是「同一段脚本经两条路径产出的 display 完全相同」那条测试钉住的东西。
 *
 * 两种失败形态直接放行给 handler 而不弹窗：输入不合 schema、编译不过。让用户去批准一段
 * 编不过的代码，只会用一个不产生任何效果的决策打断 agent 自己的改错重试回路。（解析失败
 * 更早就在 `resolveInput` 里收口了，根本到不了这里。）
 */
function prepareCreateWorkflowApproval(input: unknown): ToolApprovalGate {
  const parsed = CreateWorkflowInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.script === undefined) return { gate: "proceed" };

  const analysis = analyzeScript(parsed.data.script);
  if (!analysis.ok) return { gate: "proceed" };

  // 弹窗自带标题并以图为主体；display 与直接启动的启动轮元数据同一构造函数。
  const display = displayOfAnalysis(analysis);
  return { gate: "ask", ...(display ? { display } : {}) };
}

export const createWorkflowToolEntry: ToolEntry = {
  capability:
    "Typecheck a dynamic-workflow TypeScript script against the facade and, once confirmed, start the run in the background",
  metadata: {
    shouldDefer: true,
    name: CREATE_WORKFLOW_TOOL_NAME,
    description: CREATE_WORKFLOW_TOOL_DESCRIPTION,
    // 引擎接线后这个调用会启动一个执行子进程与多个 actor 会话；只读声明随执行语义翻面
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CREATE_WORKFLOW_TIMEOUT_MS,
    maxOutputBytes: CREATE_WORKFLOW_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: createWorkflowHandler,
  // 来源二选一只对模型入参成立（归一化后两者同时在场是合法执行态），所以它住在这里而
  // 不是 schema 上——见 CreateWorkflowInputSchema 的注释。
  validateInput: (input) => validateCreateWorkflowSource(input),
  // 全流程唯一一次读盘。此后 hook、权限规则、确认窗与 handler 看到的都是同一份字节。
  // 天花板同在这里读：钳制必须发生在确认窗之前，否则用户批准的是一个不会生效的数。
  // 模型目录同在这里读：`subagent_model` 必须在确认窗之前解析成规范形，否则用户批准的是一个
  // 还没被认出来的名字，而解不出来的调用会在批准之后才失败。
  resolveInput: (input, context) => {
    // 技能门先于一切解析：没读过 dynamic-workflows 就拒绝提交脚本（saved 来源例外，见 gate 模块）。
    // 门必须保持同步拒绝：executor 与现有测试都依赖「拒绝当场返回」而不是一个 Promise。
    if (createWorkflowNeedsSkill(input)) {
      const refused = requireDynamicWorkflowSkill(context, CREATE_WORKFLOW_TOOL_NAME);
      if (refused) return refused;
    }
    return resolveCreateWorkflowInput(
      input,
      context.workingDirectory ?? ".",
      context.dynamicWorkflowRunPort?.concurrencyCeiling?.(),
      context.modelCatalogPort,
    ).then((resolution) => withWorkflowAdjustableSettings(resolution, context));
  },
  // Modified by ZCode:F6：确认窗批准后的调整落进入参（失败则整次失败，不启动）。
  applyInputAdjustments: (input, adjustments, context) =>
    applyWorkflowSettingsAdjustments(input, adjustments, context, {
      errorCode: CREATE_WORKFLOW_FAILURE_CODE,
      schema: CreateWorkflowInputSchema,
    }),
  prepareApproval: prepareCreateWorkflowApproval,
  inputSchema: CreateWorkflowInputJsonSchema,
  outputSchema: CreateWorkflowOutputJsonSchema,
  runtimeInputSchema: CreateWorkflowInputSchema,
  runtimeOutputSchema: CreateWorkflowOutputSchema,
  formatModelContent: formatCreateWorkflowModelContent,
  permission: {
    permission: "createWorkflow",
    // 诊断用，不面向用户：确认窗自己渲染本地化标题，UI 也会过滤读起来像内部信息的 reason。
    reason: "createWorkflow.runConfirmation: user must confirm running the analyzed script",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // workflow 是一整块执行 + 模型调用，任何权限模式（含 yolo / plan）都要先问。
    alwaysAsk: true,
    // 「每次调用都是不同的脚本」对保存的 workflow 不再成立：按名字
    // 调用时，同一个名字每次都是"同一个"工作流。但「同一个」工作流也不足以支撑免确认——
    // 每次仍要确认，理由有两条更硬的：运行一次
    // 要花钱且有真实副作用；而保存的文件在批准之后随时可能被改动（手改、git pull、别人提交），
    // 所以"上次批准过这个名字"根本不能推出"这次要跑的还是那段代码"。**持久**确认永不减免。
    //
    // 放开的是**会话作用域**：用户看过并批准了本会话第一个脚本之后，
    // 可以选「Always allow in this session」让本会话后续的 CreateWorkflow 免确认。授权只活在
    // PermissionService 实例的内存里，重启 / 冷恢复 / `/new` 都从零开始。
    askOptions: { allowAlways: "session" },
  },
  resultBudget: {
    maxInlineBytes: CREATE_WORKFLOW_MODEL_BYTES,
    maxModelBytes: CREATE_WORKFLOW_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: CREATE_WORKFLOW_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: CREATE_WORKFLOW_TIMEOUT_MS,
    maxMs: CREATE_WORKFLOW_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "CreateWorkflow typechecks synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatCreateWorkflowModelContent(output: unknown): ModelMessageContent {
  const parsed = CreateWorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return "CreateWorkflow returned an invalid result.";
  return parsed.data.response;
}

// Modified by ZCode: 拆分重导出（amend-workflow 的既有导入路径不变）。
export {
  describeWorkflowConcurrencyLimit,
  resolveTraceContext,
  DIAGNOSTICS_NOT_EXECUTED_NOTE,
  EXECUTION_UNAVAILABLE_NOTE,
};
