import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";
import {
  MAX_WORKSPACE_ADDITIONAL_DIRECTORIES,
  buildAdditionalDirectoriesPayload,
  normalizeAdditionalDirectoryList,
  normalizeWorkspaceAdditionalDirectories,
  resolveWorkspaceAdditionalDirectories,
  setWorkspaceAdditionalDirectories,
} from "../src/workspaceAdditionalDirectories.js";

/**
 * 工作区附加目录（X16）在 AppSettings 层的存放、归一与下发片段。
 *
 * 为什么在这一层测：`settingService.update` 用 `appSettingsPatchSchema` 校验 patch、读盘用
 * `appSettingsSchema`（`packages/services/src/setting/settingService.ts:301` 与 `:147`），
 * 这是设置的唯一持久化入口；而 `buildAdditionalDirectoriesPayload` 是「新建会话下发什么」
 * 的唯一构造点 —— 三处（读盘 / 设置页保存 / createSession payload）共用同一份归一化。
 *
 * 三条必须钉住的语义：
 * ① 老配置没有该字段 ⇒ 不伪造空表（否则每次读盘都产生一次无意义写放大）；
 * ② 空表 / 空列表 / 空键都等价于「该工作区没有附加目录」；
 * ③ 无目录时 payload 里不写 additionalDirectories（协议里缺席即无，写空数组是无意义的 wire 差异）。
 *
 * 运行：cd packages/shared && node --import tsx --test test/workspaceAdditionalDirectories.test.ts
 */

const WORKSPACE_KEY = "/work/app";
const BACKEND = "/work/backend";

test("老配置没有该字段 ⇒ 解析后也不出现该键（不伪造空表）", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal("workspaceAdditionalDirectories" in parsed, false);
  assert.equal(JSON.stringify(parsed).includes("workspaceAdditionalDirectories"), false);
});

test("保存往返：patch 与读盘两条路径都归一（空白/重复/空串不落盘）", () => {
  const patched = appSettingsPatchSchema.parse({
    workspaceAdditionalDirectories: {
      [WORKSPACE_KEY]: [`  ${BACKEND}  `, BACKEND, "", "   "],
    },
  });
  assert.deepEqual(patched.workspaceAdditionalDirectories, {
    [WORKSPACE_KEY]: [BACKEND],
  });

  const readBack = appSettingsSchema.parse({
    workspaceAdditionalDirectories: { [WORKSPACE_KEY]: [BACKEND] },
  });
  assert.deepEqual(readBack.workspaceAdditionalDirectories, { [WORKSPACE_KEY]: [BACKEND] });
});

test("整表无有效项 ≡ 字段缺席（空对象、空列表、空键都归一成 undefined）", () => {
  for (const value of [
    {},
    { [WORKSPACE_KEY]: [] },
    { [WORKSPACE_KEY]: ["", "  "] },
    { "   ": [BACKEND] },
  ]) {
    const parsed = appSettingsSchema.parse({ workspaceAdditionalDirectories: value });
    assert.equal(
      parsed.workspaceAdditionalDirectories,
      undefined,
      `${JSON.stringify(value)} 应当归一成「没有附加目录」`,
    );
  }
});

test("设置页清除最后一条：patch 传空表 ⇒ 合并后该字段变成 undefined（旧目录不会残留）", () => {
  const current = appSettingsSchema.parse({
    workspaceAdditionalDirectories: { [WORKSPACE_KEY]: [BACKEND] },
  });
  const patch = appSettingsPatchSchema.parse({ workspaceAdditionalDirectories: {} });
  const merged = appSettingsSchema.parse({ ...current, ...patch });
  assert.equal(merged.workspaceAdditionalDirectories, undefined);
});

test("单工作区去重保序 + 截断到上限", () => {
  const many = Array.from(
    { length: MAX_WORKSPACE_ADDITIONAL_DIRECTORIES + 10 },
    (_, index) => `/work/dir-${index}`,
  );
  const deduped = normalizeAdditionalDirectoryList(["/a", "/b", "/a", "/c", "/b"]);
  assert.deepEqual(deduped, ["/a", "/b", "/c"]);

  const capped = normalizeAdditionalDirectoryList(many);
  assert.equal(capped.length, MAX_WORKSPACE_ADDITIONAL_DIRECTORIES);
  assert.equal(capped[0], "/work/dir-0");
});

test("超上限的输入被 schema 拒绝（wire 上限与运行时上限同值）", () => {
  const tooMany = Array.from(
    { length: MAX_WORKSPACE_ADDITIONAL_DIRECTORIES + 1 },
    (_, index) => `/work/dir-${index}`,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({
      workspaceAdditionalDirectories: { [WORKSPACE_KEY]: tooMany },
    }).success,
    false,
  );
});

test("整表归一：丢弃空键与空列表，保留其余工作区", () => {
  assert.deepEqual(
    normalizeWorkspaceAdditionalDirectories({
      [WORKSPACE_KEY]: [BACKEND],
      "/work/other": [],
      "  ": ["/work/ignored"],
    }),
    { [WORKSPACE_KEY]: [BACKEND] },
  );
  assert.equal(normalizeWorkspaceAdditionalDirectories({}), undefined);
});

test("按 workspaceKey 取目录；未配置 = 空数组（不区分缺席与空表）", () => {
  const map = { [WORKSPACE_KEY]: [BACKEND] };
  assert.deepEqual(resolveWorkspaceAdditionalDirectories(map, WORKSPACE_KEY), [BACKEND]);
  assert.deepEqual(resolveWorkspaceAdditionalDirectories(map, "/work/other"), []);
  assert.deepEqual(resolveWorkspaceAdditionalDirectories(undefined, WORKSPACE_KEY), []);
});

test("★注入片段：有目录才写 additionalDirectories，空目录不写字段", () => {
  assert.deepEqual(buildAdditionalDirectoriesPayload([BACKEND]), {
    additionalDirectories: [BACKEND],
  });
  const empty = buildAdditionalDirectoriesPayload([]);
  assert.equal(Object.hasOwn(empty, "additionalDirectories"), false);
});

test("设置页整表替换：新增/覆盖/移除最后一个工作区都返回可直接下发的整表", () => {
  const added = setWorkspaceAdditionalDirectories(undefined, WORKSPACE_KEY, [BACKEND]);
  assert.deepEqual(added, { [WORKSPACE_KEY]: [BACKEND] });

  const replaced = setWorkspaceAdditionalDirectories(added, WORKSPACE_KEY, ["/work/web", BACKEND]);
  assert.deepEqual(replaced, { [WORKSPACE_KEY]: ["/work/web", BACKEND] });

  const removedOne = setWorkspaceAdditionalDirectories(
    { ...replaced, "/work/other": ["/work/other-dir"] },
    WORKSPACE_KEY,
    [],
  );
  assert.deepEqual(removedOne, { "/work/other": ["/work/other-dir"] });

  // 最后一个工作区被清空 ⇒ 空表（RPC 会丢弃 undefined，不能靠它表达「清除」）。
  assert.deepEqual(setWorkspaceAdditionalDirectories(removedOne, "/work/other", []), {});
});
