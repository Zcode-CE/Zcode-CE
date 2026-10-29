import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSettingService } from "../src/setting/settingService.js";

/**
 * X16 附加目录的设置层合并语义（不是 UI 层）。
 *
 * 回归形态：两个客户端同时编辑不同工作区的附加目录，后写方拿自己读到的旧表整块覆盖，
 * 对方刚改的键静默丢失。设置更新必须按 workspaceKey 合并，且「空列表」是删除信号。
 *
 * 用真实 settingService + 临时 HOME（ZCODE_DESKTOP_HOME_DIR），跑真实落盘/读回，
 * 不停在 schema 层。
 */

test("附加目录按工作区合并：不同 key 互不覆盖，空列表删除该 key", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "zcode-settings-merge-"));
  const previous = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.ZCODE_DESKTOP_HOME_DIR;
    else process.env.ZCODE_DESKTOP_HOME_DIR = previous;
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  const service = createSettingService();
  await service.update({ workspaceAdditionalDirectories: { "/work/a": ["/work/a-lib"] } });
  await service.update({ workspaceAdditionalDirectories: { "/work/b": ["/work/b-lib"] } });
  let settings = await service.get();
  assert.deepEqual(settings.workspaceAdditionalDirectories, {
    "/work/a": ["/work/a-lib"],
    "/work/b": ["/work/b-lib"],
  });

  await service.update({ workspaceAdditionalDirectories: { "/work/a": [] } });
  settings = await service.get();
  assert.deepEqual(settings.workspaceAdditionalDirectories, { "/work/b": ["/work/b-lib"] });

  // 删除最后一个 key ⇒ 字段缺席（不是空对象）。
  await service.update({ workspaceAdditionalDirectories: { "/work/b": [] } });
  settings = await service.get();
  assert.equal("workspaceAdditionalDirectories" in settings, false);
});

test("展示名按工作区合并：空串删除、不同 key 互不覆盖", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "zcode-settings-names-"));
  const previous = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.ZCODE_DESKTOP_HOME_DIR;
    else process.env.ZCODE_DESKTOP_HOME_DIR = previous;
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  const service = createSettingService();
  await service.update({ workspaceDisplayNames: { "/work/a": "Backend" } });
  await service.update({ workspaceDisplayNames: { "/work/b": "Tools" } });
  let settings = await service.get();
  assert.deepEqual(settings.workspaceDisplayNames, {
    "/work/a": "Backend",
    "/work/b": "Tools",
  });

  await service.update({ workspaceDisplayNames: { "/work/a": "" } });
  settings = await service.get();
  assert.deepEqual(settings.workspaceDisplayNames, { "/work/b": "Tools" });
});
