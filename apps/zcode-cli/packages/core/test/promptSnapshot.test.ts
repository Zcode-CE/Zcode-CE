/**
 * 主会话 prompt 快照：system 字节在冷恢复和升级后保持不变。
 *
 * 为什么必须钉住（移植上游 v4.0.0 的 prompt-snapshot 语义）：
 * - 首次请求的 system 落库后，冷恢复/升级后请求仍发送记录的字节；升级改了 system 文案时也一样，
 *   否则 provider 前缀缓存失效（Anthropic 侧前缀变化还会直接 400）。
 * - compaction 成功后快照清成 null，下一次请求按当前代码重建再重新记录；不能复用压缩前的 system。
 * - 旧会话没有这一行时按没有快照处理，请求字节与旧路径逐字节一致（不做迁移）。
 * - 工具调用与工具定义不记录：MCP 工具在会话中途会变，只有 system 需要稳定。
 *
 * 运行：cd apps/zcode-cli/packages/core && node --import tsx --test test/promptSnapshot.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_PROMPT_SNAPSHOT,
  createRootTraceContext,
  createSessionId,
  type ModelToolCall,
  type SessionEntryInfo,
} from "@zcode/contracts";
import { createMessageHistory, type RuntimeMessageEntry } from "../src/agent/message-history.js";
import type { ContextBuildResult, Model } from "../src/runtime/deps.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { rebuildContextPrefix } from "../src/runtime/methods/context-refresh.js";
import {
  buildForkedPromptSnapshotEntry,
  clearPromptSnapshot,
  copyPromptSnapshotToFork,
  loadPromptSnapshot,
  promptSnapshotFor,
  recordPromptSnapshot,
  type PromptSnapshot,
} from "../src/runtime/helpers/prompt-snapshot.js";

const SESSION_ID = createSessionId();
const MODEL_A = { providerId: "test", modelId: "model-a" };

interface TestStore {
  entries: Map<string, SessionEntryInfo>;
  saveSessionEntry(entry: SessionEntryInfo): Promise<void>;
  sessionEntries(input: { sessionID: string; type?: string }): Promise<SessionEntryInfo[]>;
}

function createStore(initial: readonly SessionEntryInfo[] = []): TestStore {
  const entries = new Map<string, SessionEntryInfo>();
  for (const entry of initial) entries.set(entry.id, structuredClone(entry));
  return {
    entries,
    async saveSessionEntry(entry) {
      entries.set(entry.id, structuredClone(entry));
    },
    async sessionEntries(input) {
      return [...entries.values()].filter(
        (entry) =>
          entry.sessionID === input.sessionID && (!input.type || entry.type === input.type),
      );
    },
  };
}

interface RuntimeOptions {
  store?: TestStore;
  taskType?: "interactive" | "subagent_child";
  sessionModel?: () => { providerId: string; modelId: string } | undefined;
  currentSystem?: () => string;
  warnings?: string[];
}

/** 只搭 rebuildContextPrefix 与快照读写需要的面；context 内容由 currentSystem 模拟当前代码。 */
function createRuntime(options: RuntimeOptions = {}): AgentRuntimeInternal {
  const currentSystem = options.currentSystem ?? (() => "Rules v1");
  const history = createMessageHistory();
  history.init([
    { message: { role: "system", content: currentSystem() } },
    { message: { role: "user", content: "first" } },
  ]);
  const contextResult = (): ContextBuildResult => ({
    sections: [],
    totalChars: 0,
    totalTokens: 0,
    systemMessages: [{ role: "system", content: currentSystem() }],
    metaUserAttachments: [],
  });
  const snapshot = {
    workingDirectory: "/tmp/zcode-prompt-snapshot-test",
    envInfo: {
      cwd: "/tmp/zcode-prompt-snapshot-test",
      platform: "linux",
      shell: "bash",
      osVersion: "test",
      nodeVersion: "24.14.0",
    },
    currentDate: "2026-11-25",
    diagnostics: [],
  };
  const builder = { build: () => contextResult() };
  const runtime = {
    sessionId: SESSION_ID,
    rootTraceContext: createRootTraceContext({ sessionId: SESSION_ID }),
    config: { taskType: options.taskType ?? "interactive" },
    sessionStore: options.store ?? createStore(),
    logger: {
      warn: (message: string) => {
        options.warnings?.push(message);
      },
    },
    getSessionModelSelection: options.sessionModel ?? (() => MODEL_A),
    messageHistory: history,
    contextBuilder: builder,
    contextInitialized: true,
    contextSourceSnapshot: snapshot,
    latestContextBuildResult: undefined,
    createConfigOnlyContextSnapshot: () => snapshot,
    createContextBuilderFromSnapshot: () => builder,
    memoryRoot: undefined,
    memoryIndexContent: undefined,
    workingDirectory: snapshot.workingDirectory,
  };
  return runtime as unknown as AgentRuntimeInternal;
}

function model(providerId: string, modelId: string): Model {
  return { providerId, modelId } as unknown as Model;
}

function traceFor() {
  return createRootTraceContext({ sessionId: SESSION_ID });
}

function systemEntry(content: string): RuntimeMessageEntry {
  return { message: { role: "system", content } };
}

function userEntry(content: string): RuntimeMessageEntry {
  return { message: { role: "user", content } };
}

function systemMessages(entries: readonly RuntimeMessageEntry[]) {
  return entries
    .filter((entry) => entry.kind !== "attachment" && entry.message.role === "system")
    .map((entry) => (entry.kind === "attachment" ? undefined : entry.message));
}

function snapshotOf(store: TestStore): (PromptSnapshot & { cleared?: true }) | undefined {
  return [...store.entries.values()].find((entry) => entry.type === SESSION_ENTRY_PROMPT_SNAPSHOT)
    ?.data as (PromptSnapshot & { cleared?: true }) | undefined;
}

test("首次落库后冷恢复发送落库的 system 字节（升级改了 system 文案）", async () => {
  const store = createStore();
  const runtime = createRuntime({ store, currentSystem: () => "Rules v1" });
  await recordPromptSnapshot(runtime, {
    model: model(MODEL_A.providerId, MODEL_A.modelId),
    entries: runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
    traceContext: traceFor(),
  });

  const recorded = snapshotOf(store);
  assert.ok(recorded);
  assert.deepEqual(recorded.model, MODEL_A);
  assert.deepEqual(
    recorded.system.map((message) => message.content),
    ["Rules v1"],
  );
  // 只记录 system：工具定义与工具调用不进入快照。
  assert.equal(Object.hasOwn(recorded, "tools"), false);

  // 新版本改了 system 文案：冷恢复仍按记录发送，字节与落库完全一致。
  const cold = createRuntime({
    store: createStore([...store.entries.values()]),
    currentSystem: () => "Rules v2",
  });
  await loadPromptSnapshot(cold, traceFor());
  assert.deepEqual(cold.promptSnapshot, recorded);

  const rebuilt = rebuildContextPrefix(cold, { model: model(MODEL_A.providerId, MODEL_A.modelId) });
  assert.deepEqual(systemMessages(rebuilt), recorded.system);
  assert.deepEqual(
    systemMessages(rebuilt).map((message) => String(message?.content)),
    ["Rules v1"],
  );
  assert.ok(
    !systemMessages(rebuilt)
      .map((message) => String(message?.content))
      .join("")
      .includes("Rules v2"),
  );
  // 会话正文不变，只有前缀按记录发送。
  assert.deepEqual(
    rebuilt
      .filter((entry) => entry.kind !== "attachment" && entry.message.role === "user")
      .map((entry) => (entry.kind === "attachment" ? "" : String(entry.message.content))),
    ["first"],
  );

  // 记录之后请求不会再写一份；冷恢复的第一次请求也不会因为写快照而改变字节。
  await recordPromptSnapshot(cold, {
    model: model(MODEL_A.providerId, MODEL_A.modelId),
    entries: rebuilt,
    traceContext: traceFor(),
  });
  assert.deepEqual(snapshotOf(store), recorded);
});

test("compaction 清掉快照后按当前代码重建，再请求重新记录", async () => {
  let currentSystem = "Rules v1";
  const store = createStore();
  const runtime = createRuntime({ store, currentSystem: () => currentSystem });
  await recordPromptSnapshot(runtime, {
    model: model(MODEL_A.providerId, MODEL_A.modelId),
    entries: runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
    traceContext: traceFor(),
  });
  assert.ok(snapshotOf(store)?.system);

  currentSystem = "Rules v2";
  // 快照仍在：请求继续发送记录字节。
  assert.deepEqual(
    systemMessages(
      rebuildContextPrefix(runtime, { model: model(MODEL_A.providerId, MODEL_A.modelId) }),
    ).map((message) => String(message?.content)),
    ["Rules v1"],
  );

  const hadSnapshot = await clearPromptSnapshot(runtime, traceFor());
  assert.equal(hadSnapshot, true);
  assert.equal(runtime.promptSnapshot, null);
  assert.deepEqual(snapshotOf(store), { cleared: true });

  // compaction 后按当前代码重建，而不是复用压缩前的字节。
  assert.deepEqual(
    systemMessages(
      rebuildContextPrefix(runtime, { model: model(MODEL_A.providerId, MODEL_A.modelId) }),
    ).map((message) => String(message?.content)),
    ["Rules v2"],
  );

  // 冷恢复读到 cleared 标记：同样按当前代码重建。
  const coldStore = createStore([...store.entries.values()]);
  const cold = createRuntime({ store: coldStore, currentSystem: () => currentSystem });
  await loadPromptSnapshot(cold, traceFor());
  assert.equal(cold.promptSnapshot, null);
  assert.deepEqual(
    systemMessages(
      rebuildContextPrefix(cold, { model: model(MODEL_A.providerId, MODEL_A.modelId) }),
    ).map((message) => String(message?.content)),
    ["Rules v2"],
  );

  // 下一次请求重新记录当前字节。
  await recordPromptSnapshot(cold, {
    model: model(MODEL_A.providerId, MODEL_A.modelId),
    entries: cold.messageHistory.borrowReadOnlyRuntimeEntries(),
    traceContext: traceFor(),
  });
  assert.deepEqual(
    snapshotOf(coldStore)?.system.map((message) => message.content),
    ["Rules v2"],
  );
});

test("旧记录（没有快照行）走旧路径，请求字节逐字节不变", async () => {
  const store = createStore();
  const unrelated: SessionEntryInfo = {
    id: `${SESSION_ID}:runtime-model-selection`,
    sessionID: SESSION_ID,
    type: SESSION_ENTRY_MODEL_SELECTION,
    touchSession: false,
    time: { created: 1, updated: 1 },
    data: MODEL_A,
  };
  store.entries.set(unrelated.id, unrelated);

  const runtime = createRuntime({ store, currentSystem: () => "Rules v1" });
  const before = structuredClone(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  await loadPromptSnapshot(runtime, traceFor());
  assert.equal(runtime.promptSnapshot, undefined);

  const rebuilt = rebuildContextPrefix(runtime, {
    model: model(MODEL_A.providerId, MODEL_A.modelId),
  });
  // 旧会话的请求与没有快照机制时逐字节一致：system 按当前代码、正文原样。
  assert.deepEqual(runtime.messageHistory.borrowReadOnlyRuntimeEntries(), before);
  assert.deepEqual(systemMessages(rebuilt), systemMessages(before));
  // 旧记录不触发写入。
  assert.equal(snapshotOf(store), undefined);
  assert.deepEqual([...store.entries.keys()].sort(), [unrelated.id]);

  // 数据形状不对的旧行也按没有快照处理。
  store.entries.set(`${SESSION_ID}:runtime-prompt-snapshot`, {
    ...unrelated,
    id: `${SESSION_ID}:runtime-prompt-snapshot`,
    type: SESSION_ENTRY_PROMPT_SNAPSHOT,
    data: { model: "broken" },
  });
  const cold = createRuntime({
    store: createStore([...store.entries.values()]),
    currentSystem: () => "Rules v1",
  });
  await loadPromptSnapshot(cold, traceFor());
  assert.equal(cold.promptSnapshot, undefined);
  assert.deepEqual(
    systemMessages(
      rebuildContextPrefix(cold, { model: model(MODEL_A.providerId, MODEL_A.modelId) }),
    ).map((message) => String(message?.content)),
    ["Rules v1"],
  );
});

test("工具调用与工具定义不产生快照，只记录 system", async () => {
  const store = createStore();
  const runtime = createRuntime({ store, currentSystem: () => "Rules v1" });
  const toolCall: ModelToolCall = { id: "call-1", name: "Bash", input: { command: "ls" } };
  const entries: RuntimeMessageEntry[] = [
    systemEntry("Rules v1"),
    userEntry("run ls"),
    { message: { role: "assistant", content: "", toolCalls: [toolCall] } },
    { message: { role: "tool", content: "ok", toolCallId: "call-1", toolName: "Bash" } },
  ];

  await recordPromptSnapshot(runtime, {
    model: model(MODEL_A.providerId, MODEL_A.modelId),
    entries,
    traceContext: traceFor(),
  });

  const recorded = snapshotOf(store);
  assert.ok(recorded);
  assert.deepEqual(Object.keys(recorded).sort(), ["model", "system"]);
  assert.deepEqual(
    recorded.system.map((message) => message.content),
    ["Rules v1"],
  );
});

test("不是会话模型或固定执行模型时既不写也不覆盖快照", async () => {
  let currentSystem = "Rules v1";
  let selection: { providerId: string; modelId: string } | undefined = MODEL_A;
  const store = createStore();
  const runtime = createRuntime({
    store,
    sessionModel: () => selection,
    currentSystem: () => currentSystem,
  });
  const entries = [systemEntry("Rules v1")];

  // 固定执行模型（闲时执行）不写快照。
  await recordPromptSnapshot(runtime, {
    model: model("test", "temporary"),
    modelSelectionScope: "execution",
    entries,
    traceContext: traceFor(),
  });
  assert.equal(snapshotOf(store), undefined);

  // 降级模型不是固定执行作用域，但也不是会话模型：同样不写。
  await recordPromptSnapshot(runtime, {
    model: model("test", "fallback"),
    entries,
    traceContext: traceFor(),
  });
  assert.equal(snapshotOf(store), undefined);

  // 会话模型记录一次。
  await recordPromptSnapshot(runtime, {
    model: model(MODEL_A.providerId, MODEL_A.modelId),
    entries,
    traceContext: traceFor(),
  });
  const recorded = structuredClone(snapshotOf(store));
  assert.ok(recorded);

  currentSystem = "Rules v2";
  // 临时模型不覆盖已有快照。
  await recordPromptSnapshot(runtime, {
    model: model("test", "temporary"),
    entries: [systemEntry("Rules v2")],
    traceContext: traceFor(),
  });
  assert.deepEqual(snapshotOf(store), recorded);

  // 临时模型按当前代码组装，会话模型回到记录字节。
  assert.deepEqual(
    systemMessages(rebuildContextPrefix(runtime, { model: model("test", "temporary") })).map(
      (message) => String(message?.content),
    ),
    ["Rules v2"],
  );
  assert.deepEqual(
    systemMessages(
      rebuildContextPrefix(runtime, { model: model(MODEL_A.providerId, MODEL_A.modelId) }),
    ).map((message) => String(message?.content)),
    ["Rules v1"],
  );

  // 会话模型变了：旧快照不适用，按当前代码组装并为新模型重新记录。
  selection = { providerId: "test", modelId: "model-b" };
  await recordPromptSnapshot(runtime, {
    model: model("test", "model-b"),
    modelSelectionScope: undefined,
    entries: [systemEntry("Rules v2")],
    traceContext: traceFor(),
  });
  assert.deepEqual(snapshotOf(store)?.model, { providerId: "test", modelId: "model-b" });
  assert.deepEqual(
    snapshotOf(store)?.system.map((message) => message.content),
    ["Rules v2"],
  );
});

test("子会话不使用也不写快照", async () => {
  const store = createStore();
  const runtime = createRuntime({
    store,
    taskType: "subagent_child",
    currentSystem: () => "Rules v1",
  });
  await recordPromptSnapshot(runtime, {
    model: model(MODEL_A.providerId, MODEL_A.modelId),
    entries: [systemEntry("Rules v1")],
    traceContext: traceFor(),
  });
  assert.equal(snapshotOf(store), undefined);

  runtime.promptSnapshot = {
    model: { providerId: MODEL_A.providerId, modelId: MODEL_A.modelId },
    system: [{ role: "system", content: "Rules v0" }],
  };
  assert.equal(promptSnapshotFor(runtime, model(MODEL_A.providerId, MODEL_A.modelId)), undefined);
});

test("快照读写失败不阻断请求，只记 warning", async () => {
  const warnings: string[] = [];
  const store = createStore();
  const failingWrite: TestStore = {
    entries: store.entries,
    saveSessionEntry: async () => {
      throw new Error("disk full");
    },
    sessionEntries: store.sessionEntries,
  };
  const runtime = createRuntime({
    store: failingWrite,
    warnings,
    currentSystem: () => "Rules v1",
  });
  await recordPromptSnapshot(runtime, {
    model: model(MODEL_A.providerId, MODEL_A.modelId),
    entries: [systemEntry("Rules v1")],
    traceContext: traceFor(),
  });
  // 写入失败时内存快照仍生效，当前请求不受影响。
  assert.deepEqual(
    runtime.promptSnapshot?.system.map((message) => message.content),
    ["Rules v1"],
  );
  assert.equal(store.entries.size, 0);
  assert.ok(warnings.includes("Prompt snapshot write failed"));

  const failingRead = createStore();
  failingRead.sessionEntries = async () => {
    throw new Error("busy");
  };
  const cold = createRuntime({
    store: failingRead,
    warnings,
    currentSystem: () => "Rules v1",
  });
  await loadPromptSnapshot(cold, traceFor());
  assert.equal(cold.promptSnapshot, undefined);
  assert.ok(warnings.includes("Prompt snapshot read failed"));
});

test("fork 复制父会话的快照 entry", async () => {
  const store = createStore();
  const runtime = createRuntime({ store, currentSystem: () => "Rules v1" });
  await recordPromptSnapshot(runtime, {
    model: model(MODEL_A.providerId, MODEL_A.modelId),
    entries: runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
    traceContext: traceFor(),
  });

  const childId = createSessionId();
  const entry = buildForkedPromptSnapshotEntry(runtime, childId);
  assert.ok(entry);
  assert.equal(entry.id, `${childId}:runtime-prompt-snapshot`);
  assert.equal(entry.sessionID, childId);
  assert.equal(entry.type, SESSION_ENTRY_PROMPT_SNAPSHOT);
  assert.equal(entry.touchSession, false);
  assert.deepEqual(entry.data, runtime.promptSnapshot);

  await copyPromptSnapshotToFork(runtime, childId, traceFor());
  const childEntries = await store.sessionEntries({
    sessionID: childId,
    type: SESSION_ENTRY_PROMPT_SNAPSHOT,
  });
  assert.equal(childEntries.length, 1);
  assert.equal(childEntries[0]?.id, `${childId}:runtime-prompt-snapshot`);

  // 没有快照时不复制。
  const empty = createRuntime({ store: createStore(), currentSystem: () => "Rules v1" });
  assert.equal(buildForkedPromptSnapshotEntry(empty, childId), undefined);
});
