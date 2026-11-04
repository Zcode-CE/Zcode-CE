import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSettingService } from "../src/setting/settingService.js";

/**
 * setting.json 不可读时的隔离语义（数据丢失级回归）。
 *
 * 回归形态：schema 校验失败时旧实现只降级返回默认值、不备份坏文件，紧接着的 update 以
 * 「默认值 + 本次补丁」原子覆盖原文件——用户改一个开关就丢掉 recentProjects、展示名、
 * 附加目录等全部偏好，且没有任何可恢复副本。
 *
 * 断言口径：读失败后不能有默认值写回原路径；原文件字节必须完整保留在 .corrupt-* 备份里；
 * 此后的 update 只能落到新文件。用真实 settingService + 临时 HOME 跑真实落盘，不停在 schema 层。
 */

const ORIGINAL_SETTINGS = {
  // 有效字段：这些是用户真正会丢的偏好。
  recentProjects: ["/work/alpha", "/work/beta"],
  workspaceDisplayNames: { "/work/alpha": "Alpha 项目" },
  workspaceAdditionalDirectories: { "/work/alpha": ["/work/alpha-lib"] },
  messageStreamShowTodos: true,
  // 无效字段：类型与 schema 不符，足以让整份文件校验失败。
  taskAutoArchiveOlderThanDays: "many",
};

async function withTempHome(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-settings-corrupt-"));
  const previous = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.ZCODE_DESKTOP_HOME_DIR;
    else process.env.ZCODE_DESKTOP_HOME_DIR = previous;
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });
  return home;
}

async function listBackups(settingsDir: string): Promise<string[]> {
  const entries = await readdir(settingsDir).catch(() => []);
  return entries.filter((entry) => entry.startsWith("setting.json.corrupt-"));
}

test("schema 校验失败：原文件被隔离备份，后续写入不覆盖用户数据", async (t) => {
  const home = await withTempHome(t);
  const settingsDir = join(home, ".zcode", "v2");
  const settingsFile = join(settingsDir, "setting.json");
  await mkdir(settingsDir, { recursive: true });
  const originalText = JSON.stringify(ORIGINAL_SETTINGS, null, 2);
  await writeFile(settingsFile, originalText, "utf-8");

  const service = createSettingService();
  // 读：schema 失败按默认值返回，但不能留在原路径上等下一次写入覆盖。
  await service.get();

  const backupsAfterRead = await listBackups(settingsDir);
  assert.equal(backupsAfterRead.length, 1, "schema 校验失败必须产生一份 .corrupt-* 备份");
  const backupPath = join(settingsDir, backupsAfterRead[0]!);
  assert.equal(
    await readFile(backupPath, "utf-8"),
    originalText,
    "备份必须与被隔离的原文件逐字节一致",
  );

  // 写：这次 update 只能落到新文件，原数据仍然只在备份里。
  await service.update({ messageStreamShowReasoning: false });
  const rewritten = JSON.parse(await readFile(settingsFile, "utf-8")) as Record<string, unknown>;
  assert.equal(rewritten.messageStreamShowReasoning, false);
  assert.equal(await readFile(backupPath, "utf-8"), originalText, "写入后备份不得被改动");

  // 可恢复性：备份里仍是完整的用户数据（这是本回归的核心防线）。
  const backup = JSON.parse(await readFile(backupPath, "utf-8")) as Record<string, unknown>;
  assert.deepEqual(backup.recentProjects, ORIGINAL_SETTINGS.recentProjects);
  assert.deepEqual(backup.workspaceDisplayNames, ORIGINAL_SETTINGS.workspaceDisplayNames);
  assert.deepEqual(
    backup.workspaceAdditionalDirectories,
    ORIGINAL_SETTINGS.workspaceAdditionalDirectories,
  );
});

test("合法配置不会被隔离：正常读取不产生备份", async (t) => {
  const home = await withTempHome(t);
  const settingsDir = join(home, ".zcode", "v2");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, "setting.json"),
    JSON.stringify({ recentProjects: ["/work/alpha"], messageStreamShowTodos: true }),
    "utf-8",
  );

  const service = createSettingService();
  const settings = await service.get();
  assert.deepEqual(settings.recentProjects, ["/work/alpha"]);
  assert.equal((await listBackups(settingsDir)).length, 0, "合法配置不得产生 .corrupt-* 备份");
});
