import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  liveParticipantView,
  withImplicitPhase,
} from "@/components/workflow-graph/participant-model.js";
import { aggregateRunStatuses, statusOfRunNode } from "@/components/workflow-graph/run-status.js";
import type {
  StepRunStatus,
  WorkflowCausalityGraphData,
} from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";

/**
 * UI 建模性能三件套的接线回归（task-91，官方 v3.14.3 吸收）。
 *
 * ## 为什么需要这些断言
 * 上游 v3.14.3 把「每张实例卡重扫一遍 run.nodes」改成一次建索引（participant-model.ts 的
 * runIndex，上游注释原文：「表界是 1024 个实例 × 1024 个节点，也就是每帧一百万次比较」），并把
 * timeline-model 的结果按 (graph, run) 的**对象身份**记忆（timeline-cache.ts：卡与详情页在同一
 * 帧里画同一条 run，各自的 useMemo 会各建一遍）。
 *
 * 这两处都是**纯性能改造**：输出必须逐字段不变，否则是行为回归而不是优化。断言分三类：
 *   A. 等价性 —— 新旧建模对同一输入给出同一份**状态**（不只键集合；含 world-read 与无戳旧载荷）；
 *   B. 缓存语义 —— 同一对象只建一次；换了对象必须重建（不能喂出过期模型）；
 *   C. 扫描次数 —— 用可数的迭代器**确定性地**量节点扫描次数，而不是量墙钟（见下）。
 *
 * ## 为什么 C 用计数而不是计时
 * 初版这里量的是墙钟，结果**反向验证没通过**：把 runIndex 改坏（桶恒空）后断言照样全绿——
 * 因为墙钟在这个规模上有几十倍余量，且坏法仍能靠 `!seen && binder.has(actor.phaseName)` 这条
 * 兜底路径认领同一批卡。改成数 run.nodes 的迭代次数后，判据与「每卡重扫」这个事实直接对应。
 *
 * 运行：cd packages/ui && node --import tsx --test test/workflowTimelineModel.test.ts
 */

/** 一张 many 卡的图：每张卡一条车道、一个站点。 */
function buildGraph(cardCount: number, phaseCount: number): WorkflowCausalityGraphData {
  const phases = Array.from({ length: phaseCount }, (_, i) => ({
    id: "ph" + i,
    name: "phase" + i,
  }));
  const steps: WorkflowCausalityGraphData["steps"] = [];
  const lanes: WorkflowCausalityGraphData["lanes"] = [];
  const participants: WorkflowCausalityGraphData["participants"] = [];
  for (let c = 0; c < cardCount; c += 1) {
    const lane = "lane" + c;
    const siteId = "site" + c;
    lanes.push({ id: lane });
    steps.push({
      id: siteId,
      kind: "ask",
      label: "ask" + c,
      lane,
      phase: "ph" + (c % phaseCount),
    });
    participants.push({
      id: "card" + c,
      phase: "ph" + (c % phaseCount),
      lane,
      steps: [siteId],
      many: true,
    });
  }
  return { handoffs: [], lanes, participants, phaseEdges: [], phases, sink: [], steps };
}

/** 每张卡 perCard 个实例，每个实例一个已结算节点。 */
function buildRun(input: {
  cardCount: number;
  perCard: number;
  phaseNames: readonly string[];
}): WorkflowRunState {
  const { cardCount, perCard, phaseNames } = input;
  const actors: WorkflowRunState["actors"] = [];
  const nodes: WorkflowRunState["nodes"] = [];
  for (let c = 0; c < cardCount; c += 1) {
    const lane = "lane" + c;
    const siteId = "site" + c;
    const phaseName = phaseNames[c % phaseNames.length]!;
    for (let a = 0; a < perCard; a += 1) {
      actors.push({ ordinal: a, phaseName, siteId: lane, status: "completed" });
      nodes.push({
        actorOrdinal: a,
        actorSiteId: lane,
        kind: "ask",
        ordinal: a,
        outcome: "ok",
        phase: "settled",
        phaseName,
        siteId,
      });
    }
  }
  return {
    actors,
    nodes,
    runId: "run-1",
    status: "running",
    usage: { nodesUsed: nodes.length, spentTokens: 0 },
  };
}

/**
 * 数 run.nodes 被迭代了几「趟」。数组字面量做不到，所以换一个只实现迭代协议的替身——
 * 生产代码只做 `for (const node of run.nodes)`，所以这是忠实的替身，不是桩。
 */
function countingNodes(nodes: WorkflowRunState["nodes"]): {
  value: WorkflowRunState["nodes"];
  passes: () => number;
} {
  let passes = 0;
  const value = {
    length: nodes.length,
    [Symbol.iterator](): IterableIterator<WorkflowRunState["nodes"][number]> {
      passes += 1;
      return nodes[Symbol.iterator]();
    },
  } as unknown as WorkflowRunState["nodes"];
  return { passes: () => passes, value };
}

/**
 * 旧参考：逐字取自 fork 点 872ad96:participant-model.ts 的 instancesOfCard / statusFor，
 * 状态折叠复用生产的 statusOfRunNode / aggregateRunStatuses（旧代码用的就是这两个）。
 */
function legacyView(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState,
): Record<string, StepRunStatus> {
  const siteOf = new Map(graph.steps.map((step) => [step.id, step.source ?? step.id]));
  const phases = graph.phases ?? [];
  const byName = new Map(phases.map((phase) => [phase.name, phase.id]));
  const binderHas = (phaseId: string, phaseName: string | undefined): boolean => {
    if (phaseName === undefined) return phases.some((phase) => phase.id === phaseId);
    const at = byName.get(phaseName);
    return at === undefined ? true : at === phaseId;
  };
  const statuses: Record<string, StepRunStatus> = {};
  for (const participant of graph.participants) {
    const sites = new Set(participant.steps.map((id) => siteOf.get(id) ?? id));
    const seen = new Set<number>();
    const here = new Set<number>();
    for (const node of run.nodes) {
      if (node.actorSiteId !== participant.lane || !sites.has(node.siteId)) continue;
      if (node.actorOrdinal === undefined) continue;
      seen.add(node.actorOrdinal);
      if (binderHas(participant.phase, node.phaseName)) here.add(node.actorOrdinal);
    }
    const claimed = run.actors
      .filter(
        (actor) =>
          actor.siteId === participant.lane &&
          (here.has(actor.ordinal) ||
            (!seen.has(actor.ordinal) && binderHas(participant.phase, actor.phaseName))),
      )
      .sort((a, b) => a.ordinal - b.ordinal);
    const statusFor = (ordinal: number): StepRunStatus => {
      const values: StepRunStatus[] = [];
      for (const node of run.nodes) {
        if (!sites.has(node.siteId)) continue;
        if (node.actorSiteId !== participant.lane) continue;
        if (node.actorOrdinal !== ordinal) continue;
        if (!binderHas(participant.phase, node.phaseName)) continue;
        values.push(statusOfRunNode(node));
      }
      return aggregateRunStatuses(values) ?? "pending";
    };
    // 成员卡（字面量基数展开）：第 i 个成员绑车道上第 i 个实例，**键仍是原卡 id**——
    // 逐字取自 872ad96 的 \`participant.member !== undefined\` 分支。
    if (participant.member !== undefined) {
      const actor = claimed[participant.member.index];
      statuses[participant.id] = actor === undefined ? "pending" : statusFor(actor.ordinal);
      continue;
    }
    // 单卡恰一个实例：原卡绑定（id 不变），状态仍由 step 折叠 ⇒ 旧实现不写 participantStatuses。
    if (participant.many !== true && claimed.length === 1) continue;
    if (participant.many !== true && claimed.length === 0) continue;
    for (const actor of claimed) {
      statuses[participant.id + "@" + actor.ordinal] = statusFor(actor.ordinal);
    }
  }
  return statuses;
}

test("A. runIndex：新旧建模给出逐实例相同的状态（穷举形状）", () => {
  const phaseNames = ["phase0", "phase1", "phase2", "phase3"];
  for (const cardCount of [1, 2, 5, 8]) {
    for (const perCard of [1, 2, 3, 4]) {
      const graph = buildGraph(cardCount, 4);
      const run = buildRun({ cardCount, perCard, phaseNames });
      const label = cardCount + "卡×" + perCard + "节点";
      assert.deepEqual(
        liveParticipantView(graph, run).participantStatuses,
        legacyView(graph, run),
        label + "：状态表必须与旧实现逐键相同",
      );
    }
  }
});

/**
 * world-read 节点（无 actorSiteId / actorOrdinal）与无戳旧载荷。
 *
 * ⚠ 反向验证的实测边界（如实记录，不粉饰）：把 runIndex 的
 * \`if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;\`
 * 降成只判 actorOrdinal，**没有任何断言变红**。原因是这个守卫在本实现里是**冗余**的：
 * 桶键用 \`\0\` 连接（见 actorKey 的注释），world-read 会落进 "undefined\0undefined"，
 * 而认领端查的是 \`actorKey(participant.lane, actor.ordinal)\`——lane 是图里的真实车道 id，
 * 不可能等于字符串 "undefined"，所以永远取不到那个桶（实测：车道名取 "undefined" 时仍然一致）。
 * 因此这一条**不构成**「守卫有牙齿」的证据，只证明行为等价；守卫保留是照搬上游、且是防御性的。
 */
test("A. runIndex：world-read（无 actor 的节点）与无戳旧载荷不改变结论", () => {
  const graph = buildGraph(3, 2);
  const base = buildRun({ cardCount: 3, perCard: 2, phaseNames: ["phase0", "phase1"] });
  // world-read：无 actorSiteId / actorOrdinal —— 旧实现的筛选对它恒假，索引丢掉它必须等价。
  const withWorldRead: WorkflowRunState = {
    ...base,
    nodes: [
      ...base.nodes,
      { kind: "world-read", ordinal: 9, outcome: "ok", phase: "settled", siteId: "site0" },
    ],
  };
  assert.deepEqual(
    liveParticipantView(graph, withWorldRead).participantStatuses,
    legacyView(graph, withWorldRead),
    "world-read 节点不进索引，但结论必须与旧实现一致",
  );
  // 无戳的旧载荷：actor 与 node 都不带 phaseName。
  const legacyRun: WorkflowRunState = {
    ...base,
    actors: base.actors.map(({ phaseName: _p, ...rest }) => rest),
    nodes: base.nodes.map(({ phaseName: _p, ...rest }) => rest),
  };
  assert.deepEqual(
    liveParticipantView(graph, legacyRun).participantStatuses,
    legacyView(graph, legacyRun),
    "无戳旧载荷必须与旧实现一致（旧 run 逐字节不变）",
  );
});

test("A. runIndex：同站点被 k 个阶段再入时不广播（每张卡只认自己的实例）", () => {
  // 同一个站点出现在两个阶段里 ⇒ 两张卡共享车道；实例必须按出生戳归位，而不是两张卡都认领。
  const graph: WorkflowCausalityGraphData = {
    handoffs: [],
    lanes: [{ id: "lane0" }],
    participants: [
      { id: "a", lane: "lane0", phase: "ph0", steps: ["site0"], many: true },
      { id: "b", lane: "lane0", phase: "ph1", steps: ["site0"], many: true },
    ],
    phaseEdges: [],
    phases: [
      { id: "ph0", name: "phase0" },
      { id: "ph1", name: "phase1" },
    ],
    sink: [],
    steps: [{ id: "site0", kind: "ask", label: "ask", lane: "lane0", phase: "ph0" }],
  };
  // 两个实例的**出生戳不同**：ordinal 0 生在 phase0，ordinal 1 生在 phase1。
  // （不能用 buildRun 的按卡取戳版本——它给一张卡上的所有实例同一个戳，测不出再入。）
  const run: WorkflowRunState = {
    actors: [
      { ordinal: 0, phaseName: "phase0", siteId: "lane0", status: "completed" },
      { ordinal: 1, phaseName: "phase1", siteId: "lane0", status: "completed" },
    ],
    nodes: [
      {
        actorOrdinal: 0,
        actorSiteId: "lane0",
        kind: "ask",
        ordinal: 0,
        outcome: "ok",
        phase: "settled",
        phaseName: "phase0",
        siteId: "site0",
      },
      {
        actorOrdinal: 1,
        actorSiteId: "lane0",
        kind: "ask",
        ordinal: 1,
        outcome: "ok",
        phase: "settled",
        phaseName: "phase1",
        siteId: "site0",
      },
    ],
    runId: "run-reentry",
    status: "running",
    usage: { nodesUsed: 2, spentTokens: 0 },
  };
  const next = liveParticipantView(graph, run);
  assert.deepEqual(next.participantStatuses, legacyView(graph, run), "再入场景必须与旧实现一致");
  // 阶段 0 的实例（ordinal 0）只该出现在 a 上，阶段 1 的（ordinal 1）只该出现在 b 上。
  assert.deepEqual(
    Object.keys(next.participantStatuses).sort(),
    ["a@0", "b@1"],
    "同站点被两个阶段再入时，两张卡各认自己阶段出生的实例（不是一次广播）",
  );
});

test("A. runIndex：建了还没被 ask 的实例（零节点）按自己的出生戳归位", () => {
  // 这条覆盖 instancesOfCard 的第二条分支：车道上在场、但这张卡的站点上一个节点都没有的 actor。
  // 没有它，「丢掉出生戳兜底」这类改动不会被任何断言抓住（反向验证实测：M2 曾经全绿）。
  const graph = buildGraph(2, 2);
  const base = buildRun({ cardCount: 2, perCard: 1, phaseNames: ["phase0", "phase1"] });
  const pending: WorkflowRunState = {
    ...base,
    // 车道 lane0 上多一个 ordinal 7 的实例：它一个节点都还没有（刚铸造、还没派 ask）。
    actors: [
      ...base.actors,
      { ordinal: 7, phaseName: "phase0", siteId: "lane0", status: "waiting" },
    ],
  };
  const next = liveParticipantView(graph, pending);
  assert.deepEqual(
    next.participantStatuses,
    legacyView(graph, pending),
    "零节点实例必须与旧实现一致（按出生戳归位，状态 pending）",
  );
  assert.equal(next.participantStatuses["card0@7"], "pending", "零节点实例的卡状态是 pending");
  assert.deepEqual(
    Object.keys(next.participantStatuses).sort(),
    ["card0@0", "card0@7", "card1@0"],
    "零节点实例必须出卡，不能因为「没节点」被丢掉",
  );
});

test("A. runIndex：statusFor 按出生戳收窄（同站点跨阶段的节点不混进本卡状态）", () => {
  // 反向验证实测：把 statusFor 里的 \`binder.has(participant.phase, node.phaseName)\` 去掉后
  // 这条断言必须变红——否则「阶段收窄」这个语义就没有任何断言保护。
  const graph: WorkflowCausalityGraphData = {
    handoffs: [],
    lanes: [{ id: "lane0" }],
    participants: [
      { id: "a", lane: "lane0", phase: "ph0", steps: ["site0"], many: true },
      { id: "b", lane: "lane0", phase: "ph1", steps: ["site0"], many: true },
    ],
    phaseEdges: [],
    phases: [
      { id: "ph0", name: "phase0" },
      { id: "ph1", name: "phase1" },
    ],
    sink: [],
    steps: [{ id: "site0", kind: "ask", label: "ask", lane: "lane0", phase: "ph0" }],
  };
  const run: WorkflowRunState = {
    actors: [{ ordinal: 0, phaseName: "phase0", siteId: "lane0", status: "running" }],
    // 同一个实例（lane0/ordinal0）在两个阶段各有一个节点：phase0 已结算、phase1 正在跑。
    nodes: [
      {
        actorOrdinal: 0,
        actorSiteId: "lane0",
        kind: "ask",
        ordinal: 0,
        outcome: "ok",
        phase: "settled",
        phaseName: "phase0",
        siteId: "site0",
      },
      {
        actorOrdinal: 0,
        actorSiteId: "lane0",
        kind: "ask",
        ordinal: 0,
        phase: "executing",
        phaseName: "phase1",
        siteId: "site0",
      },
    ],
    runId: "run-narrow",
    status: "running",
    usage: { nodesUsed: 2, spentTokens: 0 },
  };
  const next = liveParticipantView(graph, run);
  assert.deepEqual(next.participantStatuses, legacyView(graph, run), "阶段收窄必须与旧实现一致");
  // 卡 a 只看出生在 phase0 的那个节点 ⇒ done；若丢掉收窄，两个节点一起折 ⇒ running。
  assert.equal(next.participantStatuses["a@0"], "done", "卡 a 只认出生在 phase0 的节点");
});

test("A. runIndex：成员卡按 ordinal 升序取第 i 个实例（actorsBySite 的排序有语义）", () => {
  // 反向验证实测：把 \`actorsBySite\` 的 sort 换成 reverse 后这条断言必须变红。
  // 成员卡 \`member.index\` 是「车道上第 i 个实例」，排序丢了就会绑到另一个实例上。
  const graph: WorkflowCausalityGraphData = {
    handoffs: [],
    lanes: [{ id: "lane0" }],
    participants: [
      { id: "m0", lane: "lane0", phase: "ph0", steps: ["site0"], member: { index: 0, of: 3 } },
      { id: "m1", lane: "lane0", phase: "ph0", steps: ["site0"], member: { index: 1, of: 3 } },
      { id: "m2", lane: "lane0", phase: "ph0", steps: ["site0"], member: { index: 2, of: 3 } },
    ],
    phaseEdges: [],
    phases: [{ id: "ph0", name: "phase0" }],
    sink: [],
    steps: [{ id: "site0", kind: "ask", label: "ask", lane: "lane0", phase: "ph0" }],
  };
  // ⚠ 必须**三个**实例且输入序不是「逆序」：两个元素的 reverse() 恰好等于 sort()，
  // 反向验证实测——用两元素夹具时「排序被换成 reverse」逃过了全部断言。三个元素才会暴露。
  const run: WorkflowRunState = {
    actors: [
      { ordinal: 1, name: "n1", phaseName: "phase0", siteId: "lane0", status: "completed" },
      { ordinal: 0, name: "n0", phaseName: "phase0", siteId: "lane0", status: "completed" },
      { ordinal: 2, name: "n2", phaseName: "phase0", siteId: "lane0", status: "completed" },
    ],
    nodes: [0, 1, 2].map((ordinal) => ({
      actorOrdinal: ordinal,
      actorSiteId: "lane0",
      kind: "ask" as const,
      ordinal,
      outcome: "ok" as const,
      phase: "settled" as const,
      phaseName: "phase0",
      siteId: "site0",
    })),
    runId: "run-member",
    status: "running",
    usage: { nodesUsed: 3, spentTokens: 0 },
  };
  const next = liveParticipantView(graph, run);
  assert.deepEqual(next.participantStatuses, legacyView(graph, run), "成员卡绑定必须与旧实现一致");
  // 成员卡第 i 个绑车道上第 i 个实例（按 ordinal 升序），与 actors 的输入顺序无关。
  assert.equal(next.instances["m0"]?.ordinal, 0, "m0 绑 ordinal 0");
  assert.equal(next.instances["m1"]?.ordinal, 1, "m1 绑 ordinal 1");
  assert.equal(next.instances["m2"]?.ordinal, 2, "m2 绑 ordinal 2");
  assert.equal(next.instances["m0"]?.name, "n0", "m0 的名字来自 ordinal 0 的实例");
});

test("B. timeline-cache：同一对 (graph, run) 只建一次；换了 run 对象必须重建", () => {
  const graph = buildGraph(4, 2);
  const run = buildRun({ cardCount: 4, perCard: 2, phaseNames: ["phase0", "phase1"] });
  const first = buildWorkflowTimeline(graph, run);
  const second = buildWorkflowTimeline(graph, run);
  assert.equal(
    first,
    second,
    "同一对 (graph, run) 必须拿到同一个模型对象（卡与详情页同帧只建一次）",
  );
  // 投影是浅重建：内容一变必换新对象 ⇒ 新对象必须绕过缓存重建。
  const third = buildWorkflowTimeline(graph, { ...run, status: "completed" });
  assert.notEqual(third, first, "run 换了对象就必须重建（缓存不能喂出过期的模型）");
  assert.equal(third.live, true);
  // 无 run 的静态图（确认窗、编译反馈卡）走同一张表，用哨兵占住 run 那一级。
  const staticA = buildWorkflowTimeline(graph, undefined);
  const staticB = buildWorkflowTimeline(graph, undefined);
  assert.equal(staticA, staticB, "无 run 的静态图同样按对象身份记忆");
  assert.equal(staticA.live, false);
});

test("B. timeline-cache：换了 graph 对象也必须重建", () => {
  const graph = buildGraph(4, 2);
  const run = buildRun({ cardCount: 4, perCard: 2, phaseNames: ["phase0", "phase1"] });
  const first = buildWorkflowTimeline(graph, run);
  const otherGraph = buildGraph(5, 2);
  assert.notEqual(buildWorkflowTimeline(otherGraph, run), first, "graph 换了对象必须重建");
  assert.equal(buildWorkflowTimeline(otherGraph, run).stations.length, 2);
});

test("B. 等价性：换新对象重建出的模型与命中缓存逐字段相同", () => {
  const graph = buildGraph(6, 3);
  const run = buildRun({ cardCount: 6, perCard: 3, phaseNames: ["phase0", "phase1", "phase2"] });
  const cached = buildWorkflowTimeline(graph, run);
  const rebuilt = buildWorkflowTimeline(graph, { ...run });
  assert.deepEqual(
    JSON.parse(JSON.stringify(rebuilt)),
    JSON.parse(JSON.stringify(cached)),
    "重建与命中缓存必须给出同一份模型",
  );
  // 无标记脚本走隐式阶段合成：两条入口都要覆盖。
  const implicit = buildWorkflowTimeline(
    withImplicitPhase({
      handoffs: [],
      lanes: [{ id: "workspace" }],
      participants: [],
      sink: [],
      steps: [],
    }),
    undefined,
  );
  assert.equal(implicit.live, false);
});

test("C. runIndex：节点扫描次数与卡数无关（确定性判据）", () => {
  // 判据直接对应「每卡重扫 run.nodes」这个事实：旧实现是 O(卡数 × 节点数) 趟，
  // 新实现建索引一趟 + 按 actor 取桶（桶里没有节点时连一趟都不发生）。
  const measure = (cardCount: number, perCard: number): number => {
    const graph = buildGraph(cardCount, 4);
    const run = buildRun({
      cardCount,
      perCard,
      phaseNames: ["phase0", "phase1", "phase2", "phase3"],
    });
    const counter = countingNodes(run.nodes);
    liveParticipantView(graph, { ...run, nodes: counter.value });
    return counter.passes();
  };
  const few = measure(4, 2);
  const many = measure(32, 2);
  assert.ok(
    many <= few + 4,
    "卡数从 4 涨到 32，节点扫描趟数却从 " + few + " 涨到 " + many + "：疑似退回「每卡重扫」",
  );
  // 且总量必须有界：一趟建索引，之后按 actor 取桶。
  assert.ok(many <= 64, "扫描趟数应远小于卡数×节点数，实测 " + many);
});

test("C. 反向：旧实现的扫描趟数确实随卡数放大（证明上一条的判据有牙齿）", () => {
  // 用与上面同一个替身量**旧算法**：它必须随卡数放大，否则上一条断言量错了对象。
  const measure = (cardCount: number, perCard: number): number => {
    const graph = buildGraph(cardCount, 4);
    const run = buildRun({
      cardCount,
      perCard,
      phaseNames: ["phase0", "phase1", "phase2", "phase3"],
    });
    const counter = countingNodes(run.nodes);
    legacyView(graph, { ...run, nodes: counter.value });
    return counter.passes();
  };
  const few = measure(4, 2);
  const many = measure(32, 2);
  assert.ok(many > few * 4, "旧实现的扫描趟数本应随卡数放大（4卡=" + few + "，32卡=" + many + "）");
});
