import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { OnboardingRecordFile } from "@zcode/shared";
import { createOnboardingRecordService } from "../src/onboarding/onboardingRecordService.js";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

/**
 * shouldOnboard 的判定面：entries 与 decisions 的并集，任意一条即视为「已处理过引导」。
 *
 * 为什么必须钉住：判据只认 decisions 里 status 为 dismissed 的那一半时，老用户短路
 * 写下的 existing_local_user 决策会在本机任务被删空后失效 —— 同一个人被再弹一次引导，
 * 而且没有任何报错。共享 schema 的注释把并集写成不变式
 * （packages/shared/src/onboardingRecord.ts 的 onboardingDecisionSchema），
 * 这组断言让实现不再与它矛盾。
 *
 * 反向验证：把判据改回只认 dismissed（去掉 entries/decisions 的并集分支），
 * 「existing_local_user 决策在场」这条核心断言必须变红。
 *
 * 运行：cd packages/services && node --import tsx --test test/onboardingShouldOnboard.test.ts
 */

const USER = "u1";
const DEVICE_MID = "test-device-mid";
const NOW = new Date().toISOString();

function makeRecord(overrides: Partial<OnboardingRecordFile> = {}): OnboardingRecordFile {
  return { version: 2, deviceMid: DEVICE_MID, entries: [], decisions: [], ...overrides };
}

function entryFor(userId: string) {
  return {
    userId,
    occupation: "engineer",
    interfaceMode: "coding" as const,
    memoryEnabled: null,
    proactiveSuggestionsEnabled: null,
    completedAt: NOW,
    uploadState: "pending" as const,
  };
}

function decisionFor(userId: string, status: "dismissed" | "existing_local_user") {
  return {
    userId,
    status,
    reason: status === "dismissed" ? ("user_closed" as const) : ("existing_local_task" as const),
    decidedAt: NOW,
  };
}

/**
 * 隔离的数据目录 + 预置的记录文件。
 *
 * 用 setDataBaseDir 而不是 ZCODE_DATA_BASE_DIR 环境变量：paths.ts 在首次调用 getDataBaseDir() 时
 * 求值并缓存数据根，而这里的第一处调用来自被测代码的静态 import 链 —— 赋值语句排在它后面，
 * 环境变量写法必然失效（缓存后改也无效）。
 */
async function withRecordFile(
  file: OnboardingRecordFile | null,
  run: (ctx: {
    shouldOnboard: () => Promise<boolean>;
    hasTask: (value: boolean) => void;
    recordPath: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-onboarding-"));
  setDataBaseDir(dir);
  const recordPath = join(dir, ".zcode", "v2", "onboarding-record.json");
  try {
    if (file !== null) {
      await mkdir(dirname(recordPath), { recursive: true });
      await writeFile(recordPath, JSON.stringify(file, null, 2));
    }
    let hasTask = false;
    const service = createOnboardingRecordService({
      loadUserId: async () => USER,
      hasExistingLocalTask: async () => hasTask,
    });
    await run({
      shouldOnboard: () => service.shouldOnboard(),
      hasTask: (value) => {
        hasTask = value;
      },
      recordPath,
    });
  } finally {
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
}

test("existing_local_user 决策在场时不再引导（核心判据）", async () => {
  // 场景：老用户被短路引导时落下了 existing_local_user 决策，之后本机任务被清空。
  // 判据若只认 dismissed，这里会返回 true —— 同一个人被再弹一次。
  await withRecordFile(
    makeRecord({ decisions: [decisionFor(USER, "existing_local_user")] }),
    async (ctx) => {
      ctx.hasTask(false);
      assert.equal(await ctx.shouldOnboard(), false);
    },
  );
});

test("dismissed 决策在场时不再引导", async () => {
  // 边界：用户主动关闭过引导，重启不得再弹。
  await withRecordFile(makeRecord({ decisions: [decisionFor(USER, "dismissed")] }), async (ctx) => {
    ctx.hasTask(false);
    assert.equal(await ctx.shouldOnboard(), false);
  });
});

test("entries 记录在场时不再引导", async () => {
  // 边界：答完向导的人不会被重弹（并集里的另一半）。
  await withRecordFile(makeRecord({ entries: [entryFor(USER)] }), async (ctx) => {
    ctx.hasTask(false);
    assert.equal(await ctx.shouldOnboard(), false);
  });
});

test("本机已有任务时不引导", async () => {
  // 边界：存量用户短路（判定顺序的第 2 步）。
  await withRecordFile(null, async (ctx) => {
    ctx.hasTask(true);
    assert.equal(await ctx.shouldOnboard(), false);
  });
});

test("全新用户仍然引导（判据不得宽成永不引导）", async () => {
  // 边界：没有记录文件、没有任务 —— 这是唯一应当弹引导的格子。
  // 少了这条断言，把判据改宽成「永远返回 false」也会全绿。
  await withRecordFile(null, async (ctx) => {
    ctx.hasTask(false);
    assert.equal(await ctx.shouldOnboard(), true);
  });
});

test("记录里只有别的 userId 时，当前用户仍然引导", async () => {
  // 边界：并集必须按 userId 匹配，不能只看「文件里有东西」。
  await withRecordFile(
    makeRecord({ decisions: [decisionFor("someone-else", "dismissed")] }),
    async (ctx) => {
      ctx.hasTask(false);
      assert.equal(await ctx.shouldOnboard(), true);
    },
  );
});

test("真实链路：任务存在时短路落决策，任务被删空后仍不引导", async () => {
  // 这是本轮构造出来的真实链路（不再只是推断）：
  // 真实的 TaskIndexRepo 提供 hasExistingLocalTask（与 node.ts 装配同义），
  // 任务先被写入、再被标记 deleted，中间由 shouldOnboard 自己落下 existing_local_user 决策。
  const dir = await mkdtemp(join(tmpdir(), "zcode-onboarding-chain-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks-index.sqlite"));
  try {
    // 两个身份：A 答过引导（顺带用真实 deviceMid 建立记录文件），B 是登录后撞上短路的存量用户。
    let currentUserId = "A";
    const service = createOnboardingRecordService({
      loadUserId: async () => currentUserId,
      hasExistingLocalTask: async () => (await repo.listTaskMetas({})).length > 0,
    });
    const now = Date.now();
    const meta = {
      taskId: "t1",
      traceId: "tr1",
      title: "hello",
      workspacePath: "/tmp/ws",
      createdAt: now,
      updatedAt: now,
      mode: "build" as const,
    };

    // 1) 先有一次真实作答，建立带真实 deviceMid 的记录文件（与 appendRecord 的落盘形态一致）。
    await repo.syncTaskMeta({ meta });
    await service.appendRecord(DEVICE_MID, {
      occupation: "engineer",
      interfaceMode: "coding",
      memoryEnabled: null,
      proactiveSuggestionsEnabled: null,
      completedAt: NOW,
    });

    // 2) 换成存量用户 B：本机有任务 ⇒ 短路，并由服务自己写下 existing_local_user 决策。
    currentUserId = "B";
    assert.equal(await service.shouldOnboard(), false);
    const recordPath = join(dir, ".zcode", "v2", "onboarding-record.json");
    const written = JSON.parse(await readFile(recordPath, "utf8")) as OnboardingRecordFile;
    assert.ok(
      written.decisions.some((d) => d.userId === "B" && d.status === "existing_local_user"),
      "短路时必须落下 existing_local_user 决策",
    );

    // 3) 本机任务被删空（用户删光任务 / 换数据目录都可能走到这里）。
    await repo.updateTaskState({
      workspacePath: "/tmp/ws",
      taskId: "t1",
      patch: { deleted: true },
    });
    assert.equal((await repo.listTaskMetas({})).length, 0);

    // 4) 修复前这里返回 true（同一个人被再弹一次）；修复后必须仍是 false。
    assert.equal(await service.shouldOnboard(), false);
  } finally {
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
