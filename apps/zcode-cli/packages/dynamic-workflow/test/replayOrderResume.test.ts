import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  inputHash,
  refToString,
  type ActorRef,
  type Caps,
  type JournalStorePort,
  type RunEvent,
  type SessionRef,
  type WorkflowDriver,
} from "../src/index.js";

/**
 * replay 结算次序闸（replay-order.ts）的**端到端**复现测试。
 *
 * 靶子是最终消费点：**resume 之后每个站点铸造出来的序号**。站点序号是调用到达时的计数器，
 * 而扇出分支在 await 之后做的每一次 journal 调用，编号依的是扇出**完成**的顺序——那是墙钟
 * 事实，节点行里没有任何东西能复现它。于是「按准入顺序释放缓存命中」会让重放的 Promise.all
 * 按数组顺序跑续体，join 之后的第一条 report 拿到另一条分支的序号，run 死在自己的防御性校验
 * 里（InputHashMismatch）——**即使脚本本身是确定性的**。
 *
 * 脚本形状（两条 world 读取扇出，join 之后各报一条）：
 *
 *   const [a, b] = await Promise.all([files.read("a"), files.read("b")]);
 *   report(a); report(b);
 *
 * 首生：B 先跑完 ⇒ report#1 = B 的内容、report#2 = A 的内容（事件次序记下了这一点）。
 * resume：两条读都命中缓存。
 *   · 无闸（= 本规则之前）按调用顺序释放 ⇒ report#1 = A ≠ journal 里 report#1 的 inputHash
 *     ⇒ InputHashMismatch；
 *   · 有闸按首生次序释放 ⇒ report#1 = B ⇒ 与 journal 一致。
 *
 * 最后一个 test 是**对照**，不是推理：它用的 journal 就是本规则之前写下的那种形状
 * （replay-order.ts 的注释：次序表为空 ⇒ 闸门退化成原行为），实测死在同一个校验上，并且
 * 失败载荷里 expected/got 两个哈希恰好指出「到达的是 A、记录的是 B」。
 *
 * 运行：cd apps/zcode-cli/packages/dynamic-workflow && node --import tsx --test test/replayOrderResume.test.ts
 */

const RUN_ID = "replay-order-fixture";
const CAPS: Caps = { maxConcurrency: 4 };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让已排队的微任务跑完（闸门用 queueMicrotask 投递释放）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 世界读取由测试逐条结算的 fake driver。
 *
 * executeWorldRead 每次回一个悬着的 promise，测试用 settleWorldRead 决定谁先跑完——这正是
 * 「扇出完成顺序」这个墙钟事实的受控替身。
 */
class ControlledWorldDriver implements WorkflowDriver {
  readonly journal: JournalStorePort;
  readonly events: RunEvent[] = [];
  private readonly worlds: Array<Deferred<unknown>> = [];

  constructor(journal: JournalStorePort) {
    this.journal = journal;
  }

  emit(event: RunEvent): void {
    this.events.push(event);
  }

  createActorSession(actor: ActorRef): Promise<SessionRef> {
    return Promise.resolve({ id: "session:" + refToString(actor) });
  }

  startAsk(): void {
    throw new Error("this fixture never dispatches an ask");
  }

  respondToSubmit(): void {}

  cancelAsk(): void {}

  executeWorldRead(_op: string, _args: unknown[]): Promise<unknown> {
    const deferred = defer<unknown>();
    this.worlds.push(deferred);
    return deferred.promise;
  }

  /**
   * 第 index 条世界读取（按调用顺序）跑完。该条不存在时**什么都不做**：resume 命中缓存的
   * 世界读取根本走不到 driver（这正是「重放的是调度、不是答案」的另一半），所以第二世里
   * 通常一条都没有——两世共用同一段驱动代码，靠的就是这里的空操作。
   */
  settleWorldRead(index: number, value: unknown): void {
    this.worlds[index]?.resolve(value);
  }
}

/** 造一个引擎；journal 由调用方给，于是第二次构造同一 runId 就是一次 resume。 */
function makeEngine(driver: ControlledWorldDriver): WorkflowEngine {
  return new WorkflowEngine({
    runId: RUN_ID,
    driver,
    caps: CAPS,
    askSpecs: new Map(),
    validate: () => [],
  });
}

/**
 * 跑一世「扇出两条世界读取、join 之后各报一条」。bFirst 决定这一世谁先跑完。
 *
 * 两世的**驱动代码逐字相同**：命中缓存的第二世里 settleWorldRead 是空操作，脚本侧的续体
 * 顺序完全由闸门（或它的缺席）决定。
 */
async function runLife(driver: ControlledWorldDriver, bFirst: boolean): Promise<WorkflowEngine> {
  const engine = makeEngine(driver);
  const pa = engine.worldRead("readA", "read", ["a"]);
  const pb = engine.worldRead("readB", "read", ["b"]);
  void pa.then(() => engine.report("out", { from: "A" }));
  void pb.then(() => engine.report("out", { from: "B" }));

  if (bFirst) {
    driver.settleWorldRead(1, "b-value");
    await tick();
    driver.settleWorldRead(0, "a-value");
  } else {
    driver.settleWorldRead(0, "a-value");
    await tick();
    driver.settleWorldRead(1, "b-value");
  }
  await tick();
  return engine;
}

/** 该 run 事件流里 node-settled 的 (实例, 是否缓存命中) 次序。 */
function settleOrder(events: readonly RunEvent[]): string[] {
  return events
    .filter((e): e is Extract<RunEvent, { type: "node-settled" }> => e.type === "node-settled")
    .map((e) => refToString(e.instance) + ":" + (e.cached === true ? "cached" : "live"));
}

/** 该 run journal 里 report 行的内容（按 ordinal）。 */
function reports(journal: JournalStorePort): unknown[] {
  return journal
    .listNodes(RUN_ID)
    .filter((n) => n.kind === "report")
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((n) => n.result);
}

/**
 * 造一份「本规则之前写下」的 journal：节点行照抄，**事件里抹掉全部结算事件**
 * （node-settled / artifact-published / artifact-failed）。
 *
 * 这正是 replay-order.ts 注释里说的旧 journal 形状——recoverSettleOrder 据此恢复出空次序表，
 * 而空表的闸门对每一次释放都立即放行，逐字等于本规则之前的代码路径。所以这不是模拟：
 * 它就是「无闸」这一半。
 */
function legacyJournalFrom(source: JournalStorePort): InMemoryJournalStore {
  const legacy = new InMemoryJournalStore();
  const run = source.getRun(RUN_ID);
  assert.ok(run !== undefined);
  legacy.createRun(run);
  for (const node of source.listNodes(RUN_ID)) legacy.putNode(node);
  for (const stored of source.listEvents(RUN_ID)) {
    const settled =
      stored.event.type === "node-settled" ||
      stored.event.type === "artifact-published" ||
      stored.event.type === "artifact-failed";
    if (settled) continue;
    legacy.appendEvent(RUN_ID, stored.event);
  }
  return legacy;
}

/** 跑一世首生（B 先跑完）并结算，返回它的 journal 与 driver。 */
async function firstLife(): Promise<{
  journal: InMemoryJournalStore;
  driver: ControlledWorldDriver;
}> {
  const journal = new InMemoryJournalStore();
  const driver = new ControlledWorldDriver(journal);
  const engine = await runLife(driver, true);
  engine.complete("done");
  assert.equal((await engine.settled).status, "completed");
  return { journal, driver };
}

test("首生：B 先跑完 ⇒ report#1 = B 的内容，事件次序记下这次序", async () => {
  const { driver } = await firstLife();
  assert.deepEqual(reports(driver.journal), [{ from: "B" }, { from: "A" }]);
  assert.deepEqual(settleOrder(driver.events), ["readB@1:live", "readA@1:live"]);
});

test("修复后：resume 按首生结算次序释放，run 完成且 report 序号与首生一致", async () => {
  const { journal } = await firstLife();

  // 第二世：同一份 journal ⇒ 两条世界读取都是缓存命中，driver 一次都不会被调用。
  const driver2 = new ControlledWorldDriver(journal);
  const engine2 = await runLife(driver2, true);
  engine2.complete("done");

  // 最终消费点一：第二世先兑现的是 readB（首生先跑完的那条），不是先被调用的 readA。
  // 少了这一步，「恰好没出错」与「闸门生效」分不开。
  assert.deepEqual(settleOrder(driver2.events), ["readB@1:cached", "readA@1:cached"]);
  assert.equal(
    driver2.events.some((e) => e.type === "node-dispatched"),
    false,
  );

  // 最终消费点二：整条 run 正常完成——两条 report 的到达次序与 journal 的 inputHash 逐条相符
  // （不符时 publishReport 的第一道防御性校验就会 failRun，见下一个 test）。
  assert.equal((await engine2.settled).status, "completed");
  assert.deepEqual(reports(driver2.journal), [{ from: "B" }, { from: "A" }]);
});

test("对照（旧 journal 无结算事件 ⇒ 闸门退化成原行为）：同一场景死在 InputHashMismatch", async () => {
  const { journal } = await firstLife();

  // 与首生相同的调用顺序、相同的节点行，只把结算事件抹掉——本规则之前写下的 journal 就是这个形状。
  const driver2 = new ControlledWorldDriver(legacyJournalFrom(journal));
  const engine2 = await runLife(driver2, true);

  // 释放按调用顺序发生（readA 先），join 之后的第一条 report 因此拿到 A 的内容。
  assert.deepEqual(settleOrder(driver2.events), ["readA@1:cached", "readB@1:cached"]);

  const settlement = await engine2.settled;
  assert.equal(settlement.status, "errored");
  if (settlement.status !== "errored") return;
  assert.equal(settlement.error.code, "InputHashMismatch");
  // 失败载荷自证结论：记录的是 B 的内容，到达的是 A 的内容。脚本是确定性的，两世调用顺序
  // 逐字相同——差异只可能来自「重放完成顺序」。
  assert.deepEqual(settlement.error.mismatch, {
    expected: inputHash({ from: "B" }),
    got: inputHash({ from: "A" }),
  });
});
