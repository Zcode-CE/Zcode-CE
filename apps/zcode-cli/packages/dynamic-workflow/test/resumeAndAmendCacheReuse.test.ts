import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  inputHash,
  refToString,
  type ActorRef,
  type ActorSessionSeed,
  type AskSpec,
  type Caps,
  type ImportedRunCache,
  type InstanceRef,
  type JournalStorePort,
  type PersonaSpec,
  type RunEvent,
  type RunSettlement,
  type SessionRef,
  type WorkflowDriver,
} from "../src/index.js";

/**
 * resume / amend-resume 的缓存复用与在飞 ask 重派（回归测试；workflow-hang-fix 判别实验转正）。
 *
 * 这四个场景源自「所有智能体都完成了工作，但 run 永远停在 running」的根因排查：
 * 它们在引擎层全部通过（证伪「resume/amend-resume 路径悬空 ask」这一假设，
 * 真正的断点见 journalWriteFailureSettlement.test.ts）。保留为回归测试，
 * 防止以后重复猜疑同一条路径：崩溃于在飞 ask 的 resume、amend-resume 的导入缓存
 * 消费与在飞 ask 重跑、修订 run 崩溃后以重建缓存 resume。
 * 判定依据是 engine.settled 能否兑现与缓存命中形态，而不是机制推理。
 *
 * 运行：cd apps/zcode-cli/packages/dynamic-workflow && node --import tsx --test test/resumeAndAmendCacheReuse.test.ts
 */

const RUN_ID = "probe-run";
const CAPS: Caps = { maxConcurrency: 2 };
const ASK_SITE = "askA";
const ACTOR_SITE = "actorA";
const SPECS = new Map<string, AskSpec>([[ASK_SITE, { typed: false }]]);
const VALIDATE = () => [];

/** 记录在飞 ask、可被测试逐只结算的假 driver（世界读取与 typed submit 都不用）。 */
class FakeDriver implements WorkflowDriver {
  readonly journal: JournalStorePort;
  readonly events: RunEvent[] = [];
  readonly pending = new Map<string, InstanceRef>();
  engine!: WorkflowEngine;
  readonly seeds: Array<{ actor: ActorRef; seed?: ActorSessionSeed }> = [];
  readonly cancelled: string[] = [];

  constructor(journal: JournalStorePort) {
    this.journal = journal;
  }

  emit(event: RunEvent): void {
    this.events.push(event);
  }

  createActorSession(actor: ActorRef, _persona: PersonaSpec, seed?: ActorSessionSeed): Promise<SessionRef> {
    this.seeds.push({ actor, ...(seed === undefined ? {} : { seed }) });
    return Promise.resolve({ id: "session:" + refToString(actor) });
  }

  startAsk(_session: SessionRef, instance: InstanceRef): void {
    this.pending.set(refToString(instance), instance);
  }

  respondToSubmit(): void {}
  cancelAsk(instance: InstanceRef): void {
    this.cancelled.push(refToString(instance));
  }
  executeWorldRead(): Promise<unknown> {
    return Promise.reject(new Error("probe never world-reads"));
  }
  dispose(): void {}

  /** 测试扮演「子代理轮次结束」：untyped ask 就此结算。 */
  settle(instance: InstanceRef, text: string): void {
    this.pending.delete(refToString(instance));
    this.engine.askTurnEnded(instance, text);
  }
}

function makeEngine(journal: JournalStorePort, importedCache?: ImportedRunCache): FakeDriver {
  const driver = new FakeDriver(journal);
  const engine = new WorkflowEngine({
    runId: RUN_ID,
    driver,
    caps: CAPS,
    askSpecs: SPECS,
    validate: VALIDATE,
    ...(importedCache === undefined ? {} : { importedCache }),
  });
  driver.engine = engine;
  return driver;
}

/** 让已排队的微任务跑完（引擎内部多处是异步链）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 该 run 事件流里 node-settled 的实例次序（调试用）。 */
function settleOrder(events: readonly RunEvent[]): string[] {
  return events
    .filter((e): e is Extract<RunEvent, { type: "node-settled" }> => e.type === "node-settled")
    .map((e) => refToString(e.instance) + ":" + (e.cached === true ? "cached" : "live"));
}

/** 从 driver 的 pending 表里取出某个 ordinal 的在飞实例。 */
function instanceOf(driver: FakeDriver, ordinal: number): InstanceRef {
  const found = [...driver.pending.values()].find((i) => i.ordinal === ordinal);
  assert.ok(found !== undefined, `ask #${ordinal} 应已派发（startAsk 到达）`);
  return found;
}

// ————————————————————————————————————————————————————————————————
// S1 基线
// ————————————————————————————————————————————————————————————————

test("S1 基线：所有 ask 结算 ⇒ run 结算 completed", async () => {
  const journal = new InMemoryJournalStore();
  const driver = makeEngine(journal);
  const actor = driver.engine.createActor(ACTOR_SITE, "alice");
  const ask1 = driver.engine.ask(ASK_SITE, actor, "q1");
  const ask2 = driver.engine.ask(ASK_SITE, actor, "q2");
  await tick();
  driver.settle(instanceOf(driver, 1), "a1");
  await tick();
  driver.settle(instanceOf(driver, 2), "a2");
  const [r1, r2] = await Promise.all([ask1, ask2]);
  assert.equal(r1, "a1");
  assert.equal(r2, "a2");
  driver.engine.complete("done");
  assert.equal((await driver.engine.settled).status, "completed");
  assert.deepEqual(settleOrder(driver.events), [ASK_SITE + "@1:live", ASK_SITE + "@2:live"]);
});

// ————————————————————————————————————————————————————————————————
// S2 崩溃于在飞 ask 的纯 resume（journal 行 running）
// ————————————————————————————————————————————————————————————————

test("S2 崩溃于在飞 ask 后 resume：已完成的 ask 走缓存、在飞的 ask 重新 live 派发并完成", async () => {
  const journal = new InMemoryJournalStore();
  // 第一世：ask1 完成并落边界，ask2 派发后进程死亡（engine 被丢弃，ask2 永不结算）。
  const driver1 = makeEngine(journal);
  const actor1 = driver1.engine.createActor(ACTOR_SITE, "alice");
  const ask1Promise = driver1.engine.ask(ASK_SITE, actor1, "q1");
  const ask2Promise = driver1.engine.ask(ASK_SITE, actor1, "q2");
  void ask2Promise.catch(() => undefined);
  await tick();
  driver1.settle(instanceOf(driver1, 1), "a1");
  assert.equal(await ask1Promise, "a1");
  await tick();
  assert.ok(driver1.pending.has(ASK_SITE + "@2"), "ask2 应已被派发（startAsk 到达）");

  // 第二世：同一份 journal，byte-identical 脚本重跑。
  const driver2 = makeEngine(journal);
  const actor2 = driver2.engine.createActor(ACTOR_SITE, "alice");
  const r1 = driver2.engine.ask(ASK_SITE, actor2, "q1");
  const r2 = driver2.engine.ask(ASK_SITE, actor2, "q2");
  assert.equal(await r1, "a1", "已完成的 ask 应按缓存短路结算");
  await tick();
  await tick();
  driver2.settle(instanceOf(driver2, 2), "a2");
  assert.equal(await r2, "a2");
  driver2.engine.complete("done");
  const settlement: RunSettlement = await driver2.engine.settled;
  assert.equal(settlement.status, "completed");
  assert.deepEqual(settleOrder(driver2.events), [ASK_SITE + "@1:cached", ASK_SITE + "@2:live"]);
});

// ————————————————————————————————————————————————————————————————
// S3 amend-resume：前驱在飞 ask 被修订打断，导入缓存只含已完成前缀
// ————————————————————————————————————————————————————————————————

async function predecessorWithInFlightAsk(): Promise<{
  journal: InMemoryJournalStore;
}> {
  const journal = new InMemoryJournalStore();
  const driver1 = makeEngine(journal);
  const actor1 = driver1.engine.createActor(ACTOR_SITE, "alice");
  const ask1Promise = driver1.engine.ask(ASK_SITE, actor1, "q1");
  const ask2Promise = driver1.engine.ask(ASK_SITE, actor1, "q2");
  void ask2Promise.catch(() => undefined);
  await tick();
  driver1.settle(instanceOf(driver1, 1), "a1");
  void ask1Promise;
  const nodeRow = journal.getNode(RUN_ID, ASK_SITE, 1);
  assert.ok(nodeRow !== undefined);
  journal.putNode({ ...nodeRow!, messageBoundary: 7 });
  driver1.engine.stop("superseded", undefined, "probe-run-amended");
  return { journal };
}

function aliceCache(): ImportedRunCache {
  return {
    actors: new Map([
      [
        "alice",
        {
          persona: { name: "alice" },
          entries: [{ inputHash: inputHash("q1"), result: "a1", messageBoundary: 7 }],
          transcriptSourceSessionId: "session-alice-src",
        },
      ],
    ]),
    world: new Map(),
  };
}

test("S3 amend-resume：前驱的在飞 ask 被 supersede 打断，新 run 消费导入前缀并把在飞 ask live 重跑", async () => {
  const { journal } = await predecessorWithInFlightAsk();

  // 新 run（amend 的第二世，新 journal）。
  const journal2 = new InMemoryJournalStore();
  const driverN = makeEngine(journal2, aliceCache());
  const actorN = driverN.engine.createActor(ACTOR_SITE, "alice");
  const r1 = driverN.engine.ask(ASK_SITE, actorN, "q1");
  const r2 = driverN.engine.ask(ASK_SITE, actorN, "q2");
  assert.equal(await r1, "a1", "导入缓存命中：ask1 短路结算");
  // ask2 未命中缓存必 diverge → live；种子在场即可，具体内容看后续断言
  await tick();
  await tick();
  driverN.settle(instanceOf(driverN, 2), "a2-new");
  assert.equal(await r2, "a2-new");
  driverN.engine.complete("done");
  const sN: RunSettlement = await driverN.engine.settled;
  assert.equal(sN.status, "completed");
  // 种子：分歧 actor 第一次 live 派发时带前驱转录前缀。
  assert.equal(driverN.seeds.length, 1);
  assert.deepEqual(driverN.seeds[0]!.seed, {
    sourceSessionId: "session-alice-src",
    messageCount: 7,
  });
  assert.deepEqual(settleOrder(driverN.events), [ASK_SITE + "@1:cached", ASK_SITE + "@2:live"]);
});

// ————————————————————————————————————————————————————————————————
// S4 修订 run 自身崩溃后 resume（reconcileRecorded 重建分歧点）
// ————————————————————————————————————————————————————————————————

test("S4 修订 run 崩溃后 resume：导入命中已落真行、在飞 ask 重新 live 派发并完成", async () => {
  const { journal } = await predecessorWithInFlightAsk();
  const cache = aliceCache();

  // 修订 run 的第一世：消费 ask1（导入命中 → 真行 completed），ask2 live 派发后崩溃。
  const journal2 = new InMemoryJournalStore();
  const driverN = makeEngine(journal2, cache);
  const actorN = driverN.engine.createActor(ACTOR_SITE, "alice");
  const r1Promise = driverN.engine.ask(ASK_SITE, actorN, "q1");
  const r2Promise = driverN.engine.ask(ASK_SITE, actorN, "q2");
  void r2Promise.catch(() => undefined);
  assert.equal(await r1Promise, "a1");
  await tick();
  await tick();
  assert.ok(driverN.pending.has(ASK_SITE + "@2"), "S4 前置：ask2 应已 live 派发");
  // 崩溃：丢弃 driverN，journal2 里 ask1=completed(导入真行)、ask2=running。

  // 第二世：重建同一张缓存（生产里 rebuildImportedCacheForResume 用同一个纯函数）。
  const driverR = makeEngine(journal2, cache);
  const actorR = driverR.engine.createActor(ACTOR_SITE, "alice");
  const r1b = driverR.engine.ask(ASK_SITE, actorR, "q1");
  const r2b = driverR.engine.ask(ASK_SITE, actorR, "q2");
  assert.equal(await r1b, "a1", "导入命中的真行应按 journal replay 短路");
  await tick();
  await tick();
  driverR.settle(instanceOf(driverR, 2), "a2-resumed");
  assert.equal(await r2b, "a2-resumed");
  driverR.engine.complete("done");
  const sR: RunSettlement = await driverR.engine.settled;
  assert.equal(sR.status, "completed");
});