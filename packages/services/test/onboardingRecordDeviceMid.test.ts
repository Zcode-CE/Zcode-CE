import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { onboardingRecordFileSchema, type OnboardingRecordFile } from "@zcode/shared";
import { createOnboardingRecordService } from "../src/onboarding/onboardingRecordService.js";
import { setDataBaseDir } from "../src/paths.js";

/**
 * 记录文件新建时的 deviceMid：必须非空、必须能被再次读回来。
 *
 * 缺陷形态（修复前实测）：recordDecisionSafely 在文件不存在时兜底造
 * { version: 2, deviceMid: "", ... } 并写盘，而 schema 要求 deviceMid min(1)
 * （packages/shared/src/onboardingRecord.ts 的 onboardingRecordFileV2Schema）
 * ⇒ 下次 readRecordFile 解析失败返回 null ⇒ 整份记录（含刚落的决策）被当成"从未记录"。
 *
 * 用户可见后果（两条都是静默的，所以必须有断言钉住）：
 * - 老用户首次短路写下的 existing_local_user 决策读不回来，本机任务被删空后又被弹一次；
 * - 全新用户关闭引导后重启，引导再次弹出 —— 正是 8225921 声称修过、实际未接通的那个症状。
 *
 * 反向验证：把 resolveNewFileDeviceMid 的返回值改回空串（即恢复兜底造值），
 * 本文件的核心断言必须变红。
 *
 * 运行：cd packages/services && node --import tsx --test test/onboardingRecordDeviceMid.test.ts
 */

const USER = "u1";
const NOW = new Date().toISOString();
const DEVICE_MID = "test-device-mid";

/**
 * 隔离的数据目录。记录文件与设备身份文件都跟随 dataBaseDir
 * （paths.ts 的 getAppConfigDir），因此不会读写真实的 ~/.zcode。
 *
 * 用 setDataBaseDir 而不是 ZCODE_DATA_BASE_DIR 环境变量：paths.ts 在首次调用 getDataBaseDir() 时
 * 求值并缓存数据根，而这里的第一处调用来自被测代码的静态 import 链 —— 赋值语句排在它后面，
 * 环境变量写法必然失效（缓存后改也无效）。
 */
async function withDataDir(
  run: (ctx: { recordPath: string; deviceStatePath: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-onboarding-devicemid-"));
  setDataBaseDir(dir);
  try {
    await run({
      recordPath: join(dir, ".zcode", "v2", "onboarding-record.json"),
      deviceStatePath: join(dir, ".zcode", "v2", "telemetry-state.json"),
    });
  } finally {
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
}

async function readRecordOrNull(recordPath: string): Promise<OnboardingRecordFile | null> {
  try {
    return JSON.parse(await readFile(recordPath, "utf8")) as OnboardingRecordFile;
  } catch {
    return null;
  }
}

test("核心：文件不存在时写入的决策必须能被再次读取（getRecords 非 null）", async () => {
  await withDataDir(async ({ recordPath }) => {
    // 场景：无历史记录文件 + 本机有任务 ⇒ shouldOnboard 第 2 步自己落一条决策。
    const service = createOnboardingRecordService({
      loadUserId: async () => USER,
      hasExistingLocalTask: async () => true,
    });
    assert.equal(await service.shouldOnboard(), false);

    const records = await service.getRecords();
    assert.notEqual(records, null, "决策写了但读不回来：deviceMid 是空串导致整份文件解析失败");
    assert.ok(
      records!.decisions.some((d) => d.userId === USER && d.status === "existing_local_user"),
      "落盘内容必须含本次短路决策",
    );

    // 打到最终消费点：磁盘上的字节也要能被 schema 直接解析（不是只靠内存态）。
    const raw = JSON.parse(await readFile(recordPath, "utf8")) as unknown;
    const parsed = onboardingRecordFileSchema.safeParse(raw);
    assert.equal(parsed.success, true, "磁盘上的记录文件必须能被 schema 解析");
    assert.ok(
      typeof (raw as { deviceMid?: unknown }).deviceMid === "string" &&
        ((raw as { deviceMid: string }).deviceMid ?? "").trim().length > 0,
      "新建文件的 deviceMid 必须非空",
    );
  });
});

test("症状：dismissOnboarding 后重启不再引导（8225921 声称修过的那个）", async () => {
  await withDataDir(async () => {
    const first = createOnboardingRecordService({
      loadUserId: async () => USER,
      hasExistingLocalTask: async () => false,
    });
    assert.equal(await first.shouldOnboard(), true, "全新用户应当引导");
    await first.dismissOnboarding();
    assert.notEqual(await first.getRecords(), null, "关闭决策必须能读回来");

    // 重启：新建服务实例重新读盘（同一次进程内的实例缓存不参与判定）。
    const restarted = createOnboardingRecordService({
      loadUserId: async () => USER,
      hasExistingLocalTask: async () => false,
    });
    assert.equal(await restarted.shouldOnboard(), false, "关闭引导后重启不得再弹");
  });
});

test("边界：deviceMid 解析不到非空值时跳过写入，不写必然读不回来的文件", async () => {
  await withDataDir(async ({ recordPath }) => {
    const service = createOnboardingRecordService({
      loadUserId: async () => USER,
      hasExistingLocalTask: async () => true,
      // 显式模拟解析失败：返回空串（例如设备身份文件不可写）。
      resolveDeviceMid: async () => "   ",
    });
    // 判定本身不受影响：本机确实已有任务。
    assert.equal(await service.shouldOnboard(), false);
    assert.equal(await readRecordOrNull(recordPath), null, "解析不到 deviceMid 时不得写盘");
    assert.equal(await service.getRecords(), null);
  });
});

test("边界：deviceMid 解析抛异常时同样跳过写入", async () => {
  await withDataDir(async ({ recordPath }) => {
    const service = createOnboardingRecordService({
      loadUserId: async () => USER,
      hasExistingLocalTask: async () => true,
      resolveDeviceMid: async () => {
        throw new Error("device state file not writable");
      },
    });
    assert.equal(await service.shouldOnboard(), false);
    assert.equal(await readRecordOrNull(recordPath), null, "解析抛错时不得写盘");
  });
});

test("边界：已有文件时以文件内 deviceMid 为权威，不调用解析入口", async () => {
  await withDataDir(async ({ recordPath }) => {
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(
      recordPath,
      JSON.stringify(
        { version: 2, deviceMid: "existing-mid", entries: [], decisions: [] },
        null,
        2,
      ),
    );
    let resolveCalls = 0;
    const service = createOnboardingRecordService({
      loadUserId: async () => USER,
      hasExistingLocalTask: async () => true,
      resolveDeviceMid: async () => {
        resolveCalls += 1;
        return "should-not-be-used";
      },
    });
    assert.equal(await service.shouldOnboard(), false);
    assert.equal(resolveCalls, 0, "已有文件时不得重新解析设备身份");
    const written = await readRecordOrNull(recordPath);
    assert.equal(written?.deviceMid, "existing-mid", "沿用文件内已有 deviceMid");
  });
});

test("边界：真实设备身份入口在无文件时生成非空 deviceMid（不注入桩）", async () => {
  await withDataDir(async ({ recordPath, deviceStatePath }) => {
    // 不传 resolveDeviceMid ⇒ 走 ensureDeviceMid（telemetry-state.json，与 X-Device-Mid 同源）。
    const service = createOnboardingRecordService({
      loadUserId: async () => USER,
      hasExistingLocalTask: async () => true,
    });
    assert.equal(await service.shouldOnboard(), false);

    const records = await service.getRecords();
    assert.notEqual(records, null);
    assert.ok(records!.deviceMid.trim().length > 0, "deviceMid 必须非空");
    // 与设备身份文件同值：记录里的锚点不是另一个身份。
    const state = JSON.parse(await readFile(deviceStatePath, "utf8")) as { deviceMid?: string };
    assert.equal(records!.deviceMid, state.deviceMid, "记录锚点必须等于设备身份文件的 deviceMid");
    assert.ok((await readFile(recordPath, "utf8")).includes(records!.deviceMid));
  });
});

test("边界：dismissOnboarding 对已有 entries 的用户不覆盖作答（幂等边界）", async () => {
  await withDataDir(async ({ recordPath }) => {
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(
      recordPath,
      JSON.stringify(
        {
          version: 2,
          deviceMid: DEVICE_MID,
          entries: [
            {
              userId: USER,
              occupation: "engineer",
              interfaceMode: "coding",
              memoryEnabled: null,
              proactiveSuggestionsEnabled: null,
              completedAt: NOW,
              uploadState: "pending",
            },
          ],
          decisions: [],
        },
        null,
        2,
      ),
    );
    const service = createOnboardingRecordService({
      loadUserId: async () => USER,
      hasExistingLocalTask: async () => false,
    });
    await service.dismissOnboarding();
    const written = await readRecordOrNull(recordPath);
    assert.equal(written?.deviceMid, DEVICE_MID, "已有文件的 deviceMid 不得被改写");
    assert.equal(written?.entries.length, 1, "作答条目不得被关闭决策影响");
  });
});
