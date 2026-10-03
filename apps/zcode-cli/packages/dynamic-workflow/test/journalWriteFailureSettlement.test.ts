import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  refToString,
  type ActorRef,
  type AskSpec,
  type Caps,
  type InstanceRef,
  type JournalStorePort,
  type NodeRecord,
  type PersonaSpec,
  type RunEvent,
  type SessionRef,
  type WorkflowDriver,
} from "../src/index.js";

/**
 * 结算写入失败不得悬空 ask（workflow-hang-fix 的回归测试）。
 *
 * 症状对照：用户反馈「所有智能体明明都已经完成工作，但界面显示没有完成，并且一直卡住」。
 *
 * 断链（修复前，由判别实验复现：ask1=hung run=hung swallowed=1）：
 *   actor 轮次解析完成 → driver.onTurnResolved → void settleExchange（无 catch）
 *   → sink.askTurnEnded → engine.askTurnEnded → handleTurnEnded → settleOk
 *   → journal.putNode（SQLite 写）无 try/catch
 *
 * putNode 一旦抛错（磁盘满 / 锁竞争 / IO 错误），node.settled 已置位而 deferred 永不
 * 兑现、finishLiveNode 不跑、activeAsks 不减；子进程在 await ask(...) 上永久等待
 * response，run 永不结算；生产 launch 不设墙钟超时，唯一出口是用户手动取消。
 * 兄弟 ask 若先结算（时间线全部亮起），正是「都完成了却卡住」。
 *
 * 修复后（本测试钉住的行为）：
 *   - engine settleOk/settleFailed 的 journal 写入收容进 try/catch：写不进就判 ask 失败
 *     （含 failed 行也写不进时的最后兜底——不落 journal 但兑现 deferred）；
 *   - driver settleExchange 加 catch：sink 链任何抛错都转 askFailed，引擎侧已结算时
 *     failed() 是安全 no-op。
 *
 * 运行：cd apps/zcode-cli/packages/dynamic-workflow && node --import tsx --test test/journalWriteFailureSettlement.test.ts
 */

const RUN_ID = "fail-write-run";
const CAPS: Caps = { maxConcurrency: 4 };
const ASK_SITE = "askA";
const ACTOR_SITE = "actorA";
const SPECS = new Map<string, AskSpec>([[ASK_SITE, { typed: false }]]);
const VALIDATE = () => [];

/** 一段有限时间的「卡住」判据：超时胜出 = 该 promise 在窗口内未兑现。 */
const HANG_WINDOW_MS = 300;

async function hangProbe(promise: Promise<unknown>): Promise<"settled" | "hung"> {
  return Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), HANG_WINDOW_MS)),
  ]);
}

/**
 * 包一层 journal：putNode 在谓词下抛错，模拟 SQLite 写失败（磁盘满 / 锁 / IO 错误）。
 * 其余方法原样转发（InMemoryJournalStore 是纯内存实现，生产侧是 better-sqlite3）。
 */
class FailingJournal implements JournalStorePort {
  private readonly inner = new InMemoryJournalStore();
  constructor(private readonly shouldFailPutNode: (record: NodeRecord) => boolean) {}

  putNode(record: NodeRecord): void {
    if (this.shouldFailPutNode(record)) throw new Error("boom: journal putNode write failed");
    this.inner.putNode(record);
  }
  createRun(record: Parameters<JournalStorePort["createRun"]>[0]): void {
    this.inner.createRun(record);
  }
  getRun(runId: string) {
    return this.inner.getRun(runId);
  }
  updateRunStatus(
    runId: string,
    status: Parameters<JournalStorePort["updateRunStatus"]>[1],
    settlement?: Parameters<JournalStorePort["updateRunStatus"]>[2],
  ): void {
    this.inner.updateRunStatus(runId, status, settlement);
  }
  updateRunUsage(runId: string, spentTokens: number): void {
    this.inner.updateRunUsage(runId, spentTokens);
  }
  putActor(record: Parameters<JournalStorePort["putActor"]>[0]): void {
    this.inner.putActor(record);
  }
  getActor(runId: string, siteId: string, ordinal: number) {
    return this.inner.getActor(runId, siteId, ordinal);
  }
  listActors(runId: string) {
    return this.inner.listActors(runId);
  }
  getNode(runId: string, siteId: string, ordinal: number) {
    return this.inner.getNode(runId, siteId, ordinal);
  }
  listNodes(runId: string) {
    return this.inner.listNodes(runId);
  }
  appendEvent(runId: string, event: RunEvent): { sequence: number } {
    return this.inner.appendEvent(runId, event);
  }
  listEvents(runId: string, opts?: Parameters<JournalStorePort["listEvents"]>[1]) {
    return this.inner.listEvents(runId, opts);
  }
}

/**
 * 与真实 AgentRuntimeWorkflowDriver 同构的假 driver：onTurnResolved → void
 * settleExchange 异步链，抛错由「全局 unhandledRejection 处理器」收住（swallowed 记录），
 * 而不是冒回调用方——生产形态。settle/failAsk 分别扮演轮次结束与失败上报。
 */
class FakeDriver implements WorkflowDriver {
  readonly journal: JournalStorePort;
  readonly events: RunEvent[] = [];
  readonly pending = new Map<string, InstanceRef>();
  readonly swallowed: unknown[] = [];
  engine!: WorkflowEngine;

  constructor(journal: JournalStorePort) {
    this.journal = journal;
  }

  emit(event: RunEvent): void {
    this.events.push(event);
  }
  createActorSession(_actor: ActorRef, _persona: PersonaSpec): Promise<SessionRef> {
    return Promise.resolve({ id: "session:actorA" });
  }
  startAsk(_session: SessionRef, instance: InstanceRef): void {
    this.pending.set(refToString(instance), instance);
  }
  respondToSubmit(): void {}
  cancelAsk(_instance: InstanceRef): void {}
  executeWorldRead(): Promise<unknown> {
    return Promise.reject(new Error("never world-reads"));
  }
  dispose(): void {}

  settle(instance: InstanceRef, text: string): void {
    this.pending.delete(refToString(instance));
    void Promise.resolve()
      .then(() => this.engine.askTurnEnded(instance, text))
      .catch((error: unknown) => {
        this.swallowed.push(error);
      });
  }

  failAsk(instance: InstanceRef, error: unknown): void {
    this.pending.delete(refToString(instance));
    void Promise.resolve()
      .then(() =>
        this.engine.askFailed(
          instance,
          error instanceof Error
            ? { code: "DriverError", message: error.message, toJSON: () => ({ code: "DriverError", message: error.message }) } as never
            : (error as never),
        ),
      )
      .catch((error: unknown) => {
        this.swallowed.push(error);
      });
  }
}

function makeEngine(journal: JournalStorePort): FakeDriver {
  const driver = new FakeDriver(journal);
  const engine = new WorkflowEngine({
    runId: RUN_ID,
    driver,
    caps: CAPS,
    askSpecs: SPECS,
    validate: VALIDATE,
  });
  driver.engine = engine;
  return driver;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function instanceOf(driver: FakeDriver, ordinal: number): InstanceRef {
  const found = [...driver.pending.values()].find((i) => i.ordinal === ordinal);
  assert.ok(found !== undefined, `ask #${ordinal} 应已派发`);
  return found;
}

/** 结算守护：有限窗口内等 promise 兑现（无论 resolve/reject），否则视为卡住。 */
async function awaitOutcome(promise: Promise<unknown>): Promise<unknown> {
  const state = await hangProbe(promise);
  assert.notEqual(state, "hung", "promise 在窗口内未兑现 = 卡住（回归）");
  try {
    return await promise;
  } catch (error) {
    return { __rejected: error };
  }
}

// ————————————————————————————————————————————————————————————————

test("S1 结算写入失败：ask 被判失败、run 仍可终止（不卡住）", async () => {
  const journal = new FailingJournal(
    (record) => record.kind === "ask" && record.status !== "running",
  );
  const driver = makeEngine(journal);
  const engine = driver.engine;
  const actor = engine.createActor(ACTOR_SITE, "alice");

  const ask1 = engine.ask(ASK_SITE, actor, "q1");
  await tick();
  await tick();

  driver.settle(instanceOf(driver, 1), "a1");
  const outcome = await awaitOutcome(ask1);
  assert.ok(
    outcome !== null && typeof outcome === "object" && "__rejected" in outcome,
    "ask 应以失败终结（settleOk 写不进 ⇒ 判失败），而非悬空",
  );

  // 脚本 catch 之后继续：run 仍可 complete 终止——这就是「不卡住」的判据
  engine.complete("recovered");
  const settlement = await engine.settled;
  assert.equal(settlement.status, "completed");
  assert.equal(driver.swallowed.length, 0, "driver 侧不应再吞 unhandled rejection");
});

test("S2 只坑第一个 ask：兄弟 ask 照常完成（所有智能体已完成），失败者终结", async () => {
  // 坑 actorSeq=0 的那个 ask（actor 内序号，0 起），其余写入正常
  const journal = new FailingJournal(
    (record) => record.kind === "ask" && record.status === "completed" && record.actorSeq === 0,
  );
  const driver = makeEngine(journal);
  const engine = driver.engine;
  const actor = engine.createActor(ACTOR_SITE, "alice");

  const ask1 = engine.ask(ASK_SITE, actor, "q1");
  const ask2 = engine.ask(ASK_SITE, actor, "q2");
  await tick();
  await tick();

  driver.settle(instanceOf(driver, 1), "a1");
  const out1 = await awaitOutcome(ask1);
  assert.ok(out1 !== null && typeof out1 === "object" && "__rejected" in out1, "ask1 失败终结");

  driver.settle(instanceOf(driver, 2), "a2");
  const out2 = await awaitOutcome(ask2);
  assert.equal(out2, "a2", "ask2 正常完成（兄弟智能体已完成）");
  void actor;
});

test("S3 失败行也写不进：settleFailed 兜底仍兑现 deferred", async () => {
  const journal = new FailingJournal(
    (record) =>
      record.kind === "ask" && (record.status === "completed" || record.status === "failed"),
  );
  const driver = makeEngine(journal);
  const engine = driver.engine;
  const actor = engine.createActor(ACTOR_SITE, "alice");

  const ask1 = engine.ask(ASK_SITE, actor, "q1");
  await tick();
  await tick();

  // 直接走失败上报（真实链：sink.askFailed），failed 行写入同样失败
  driver.failAsk(instanceOf(driver, 1), new Error("model layer failure"));
  const out1 = await awaitOutcome(ask1);
  assert.ok(out1 !== null && typeof out1 === "object" && "__rejected" in out1, "失败兜底兑现");
  assert.equal(driver.swallowed.length, 0);
  void actor;
});