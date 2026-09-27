import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFLOW_RUNS_LIMITS,
  WORKFLOW_RUNS_LEGACY_LIMITS,
  applyWorkflowRunRemoved,
  applyWorkflowRunUpdated,
  canonicalWorkflowRun,
  clampWorkflowRunsForLegacy,
  diffWorkflowRunsState,
  reduceWorkflowRunsState,
  workflowRunSchema,
  workflowRunStepCounts,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunsState,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 协议 v4 workflowRuns 键级增量的黄金测试。
 *
 * 为什么必须自补：上游 `workflow-runs-delta.ts` 把契约写在文件头 ——
 *
 *   `JSON.stringify(applyAll(带 prior 的快照, diff(prior, next)).workflowRuns) === JSON.stringify(next)`
 *
 * ——逐字节，不只是深相等（键序因此是一等公民）。但上游没有带任何 protocol-v4 测试
 * （穷尽核实：`git ls-tree -r upstream/main -- packages/shared/test` 里 v4/protocol 命中 0）。
 * 这条契约一旦被违反，表现是「消费侧状态与生产侧静默分叉」——面板显示旧值、增量对不上，
 * 而两边都不报错。所以这里用真实 reducer 产出的状态转移来钉住它。
 *
 * 三条断言面（对应上游文件头的三条结构性事实）：
 *   A. 逐字节往返：reducer 产出的任意 (prior, next) 对，diff→apply 必须回到 next 的字节。
 *   B. 键序规范：run 对象的键序必须等于 `workflowRunSchema` 的声明序（唯一不靠值相等保证的一环）。
 *   C. 旧消费者裁剪：超界的 run 必须先过 `clampWorkflowRunsForLegacy`，否则老对端整帧丢。
 *
 * 运行：cd packages/shared && node --import tsx --test test/protocolV4WorkflowRunsGolden.test.ts
 */

/** 一段确定的事件脚本：同一份输入永远产出同一串状态（黄金向量可复现）。 */
const EVENT_SCRIPT: WorkflowRunProgressEnvelope[] = [
  { runId: "run-a", eventType: "run-started", sequence: 1, payload: { scriptName: "golden" } },
  {
    runId: "run-a",
    eventType: "node-queued",
    sequence: 2,
    payload: { siteId: "s1", ordinal: 0, phaseName: "collect" },
  },
  {
    runId: "run-a",
    eventType: "node-queued",
    sequence: 3,
    payload: { siteId: "s1", ordinal: 1, phaseName: "collect" },
  },
  {
    runId: "run-a",
    eventType: "node-settled",
    sequence: 4,
    payload: { siteId: "s1", ordinal: 0, phaseName: "collect" },
  },
  {
    runId: "run-a",
    eventType: "actor-started",
    sequence: 5,
    payload: { siteId: "s2", ordinal: 0, actorSessionId: "actor-1" },
  },
  {
    runId: "run-a",
    eventType: "node-queued",
    sequence: 6,
    payload: { siteId: "s2", ordinal: 0, actorSessionId: "actor-1", phaseName: "write" },
  },
  // 第二条 run：验证多 run 同时驻留时 diff 不会串键
  { runId: "run-b", eventType: "run-started", sequence: 1, payload: { scriptName: "golden-b" } },
  {
    runId: "run-b",
    eventType: "node-queued",
    sequence: 2,
    payload: { siteId: "s1", ordinal: 0, phaseName: "collect" },
  },
  {
    runId: "run-b",
    eventType: "node-settled",
    sequence: 3,
    payload: { siteId: "s1", ordinal: 0, phaseName: "collect" },
  },
  // 回到 run-a 改一个已有条目：验证「只改一条 run、其余保持引用」的快路径
  {
    runId: "run-a",
    eventType: "node-settled",
    sequence: 7,
    payload: { siteId: "s1", ordinal: 1, phaseName: "collect" },
  },
  { runId: "run-a", eventType: "run-settled", sequence: 8, payload: {} },
];

/** 跑事件脚本，逐事件返回状态序列（含起点空态）。 */
function replay(script: WorkflowRunProgressEnvelope[]): WorkflowRunsState[] {
  const states: WorkflowRunsState[] = [{ revision: 0, runs: [] }];
  let current = states[0]!;
  for (const envelope of script) {
    const next = reduceWorkflowRunsState(current, envelope);
    if (next) {
      states.push(next);
      current = next;
    }
  }
  return states;
}

/**
 * 按 delta 契约施加一次 diff 到 prior 上（apply 侧的生产语义）。
 *
 * 两个易错点（都是实测踩出来的，写在这里免得下一个人重踩）：
 *   · `diffWorkflowRunsState` 返回的是delta 事件数组（`WorkflowRunDelta[]`），
 *     不是 `{updated, removed}` 对象；
 *   · `applyWorkflowRunUpdated` / `applyWorkflowRunRemoved` 接收并返回**整个
 *     `WorkflowRunsState`**（它们自己管 revision 与 runs），不是 runs 数组。
 */
function applyDiff(prior: WorkflowRunsState, next: WorkflowRunsState): WorkflowRunsState {
  let state: WorkflowRunsState = prior;
  for (const delta of diffWorkflowRunsState(prior, next)) {
    state =
      delta.op === "workflowRun.removed"
        ? applyWorkflowRunRemoved(state, delta)
        : applyWorkflowRunUpdated(state, delta);
  }
  return state;
}

test("A. 逐字节往返：每一对相邻状态都满足 apply(prior, diff(prior,next)) === next", () => {
  const states = replay(EVENT_SCRIPT);
  assert.ok(states.length >= 10, `事件脚本应产出至少 10 个状态，实际 ${states.length}`);

  let transitions = 0;
  for (let i = 1; i < states.length; i += 1) {
    const prior = states[i - 1]!;
    const next = states[i]!;
    const applied = applyDiff(prior, next);
    assert.equal(
      JSON.stringify(applied.runs),
      JSON.stringify(next.runs),
      `第 ${i} 次转移后 workflowRuns 的字节不一致（键序或内容分叉）`,
    );
    transitions += 1;
  }
  assert.equal(transitions, states.length - 1);
});

test("A2. 逐字节往返：任意**非相邻**状态对（跨多步）同样成立", () => {
  // 增量是按「上一步」算的，但消费侧可能落后多步（丢帧后补快照）。跨步对照能抓住
  // 「只在相邻对成立、跨步就分叉」这类隐蔽错误。
  const states = replay(EVENT_SCRIPT);
  let pairs = 0;
  for (let i = 0; i < states.length; i += 1) {
    for (let j = i + 1; j < states.length; j += 1) {
      const applied = applyDiff(states[i]!, states[j]!);
      assert.equal(
        JSON.stringify(applied.runs),
        JSON.stringify(states[j]!.runs),
        `跨步对 (${i},${j}) 的字节不一致`,
      );
      pairs += 1;
    }
  }
  assert.ok(pairs > 40, `应覆盖 40 对以上，实际 ${pairs}`);
});

test("B. 键序规范：reducer 产出的每个 run 的键序等于 schema 声明序", () => {
  const declared = Object.keys(workflowRunSchema.shape);
  for (const state of replay(EVENT_SCRIPT)) {
    for (const run of state.runs) {
      assert.deepEqual(
        Object.keys(run),
        declared.filter((key) => key in run),
        `run ${run.runId} 的键序与 schema 声明序不符`,
      );
      // canonicalWorkflowRun 必须幂等：已经是规范序时不得改动字节
      assert.equal(
        JSON.stringify(canonicalWorkflowRun(run)),
        JSON.stringify(run),
        `run ${run.runId} 经 canonicalWorkflowRun 后字节改变 ⇒ 不幂等`,
      );
    }
  }
});

test("C. 旧消费者裁剪：超界 run 被裁到 legacy 界，且不触碰界内 run", () => {
  // 造一个超过 legacy 界（256）的 run：用 limits 抬界后灌满节点。
  const wide = { ...WORKFLOW_RUNS_LIMITS, maxNodes: 400, maxActors: 400, maxTotalEntries: 10_000 };
  let state: WorkflowRunsState | undefined;
  state =
    reduceWorkflowRunsState(
      undefined,
      { runId: "wide", eventType: "run-started", sequence: 1, payload: {} },
      wide,
    ) ?? undefined;
  for (let i = 0; i < 300; i += 1) {
    state =
      reduceWorkflowRunsState(
        state,
        {
          runId: "wide",
          eventType: "node-queued",
          sequence: i + 2,
          // 节点标识在 payload.instance 里（嵌套），不是平铺的 siteId/ordinal ——
          // 形状取自 reducer 的 workflowInstanceRef(payload.instance)。
          payload: { instance: { siteId: "s", ordinal: i } },
        },
        wide,
      ) ?? state;
  }
  assert.ok(state, "宽 run 应已建立");
  const built = state!;
  assert.equal(built.runs[0]!.nodes.length, 300, "抬界后应装得下 300 个节点");

  const clamped = clampWorkflowRunsForLegacy(built);
  const nodes = clamped.runs[0]!.nodes.length;
  assert.ok(
    nodes <= WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes,
    `裁剪后节点数 ${nodes} 应 ≤ legacy 界 ${WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes}`,
  );
  // 「前 256 条」不是随手取的：旧归约触界时是拒新，它产出的恰好是最早的那 256 条。
  assert.equal(nodes, WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes);
  assert.deepEqual(
    clamped.runs[0]!.nodes.map((n) => n.ordinal),
    Array.from({ length: WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes }, (_, i) => i),
    "裁剪必须保留**最早**的条目（与旧归约的拒新语义一致）",
  );

  // 界内的 run 一个字节都不该动
  const small = replay(EVENT_SCRIPT).at(-1)!;
  const smallClamped = clampWorkflowRunsForLegacy(small);
  assert.equal(
    JSON.stringify(smallClamped.runs),
    JSON.stringify(small.runs),
    "未超界的 run 经裁剪后必须逐字节不变",
  );
});

test("D. 被拒实例计数：表外实例被计入 workflowRunStepCounts（步数不再少报）", () => {
  // 用一个小界逼出「被拒」路径，验证计数器把表外条目加回总数 —— 这正是
  // 「一个 3000 路 fan-out 在读面上显示成 1024 步」那句假话的修复面。
  const tight = { ...WORKFLOW_RUNS_LIMITS, maxNodes: 3, maxActors: 3, maxTotalEntries: 3 };
  let state: WorkflowRunsState | undefined =
    reduceWorkflowRunsState(
      undefined,
      { runId: "r", eventType: "run-started", sequence: 1, payload: {} },
      tight,
    ) ?? undefined;
  for (let i = 0; i < 6; i += 1) {
    state =
      reduceWorkflowRunsState(
        state,
        {
          runId: "r",
          eventType: "node-queued",
          sequence: i + 2,
          payload: { instance: { siteId: "s", ordinal: i } },
        },
        tight,
      ) ?? state;
  }
  const run = state!.runs[0]!;
  assert.equal(run.nodes.length, 3, "表内应被界夹在 3");
  const unlisted = run.usage.nodesUnlisted ?? 0;
  assert.equal(unlisted, 3, "被拒的 3 个实例必须被计数（而不是无声消失）");
  const counts = workflowRunStepCounts(run);
  assert.equal(counts.total, 6, "步数读法必须把表外条目加回来（3 表内 + 3 表外）");
});
