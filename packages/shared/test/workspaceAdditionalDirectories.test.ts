import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";
import {
  MAX_WORKSPACE_ADDITIONAL_DIRECTORIES,
  buildAdditionalDirectoriesPayload,
  normalizeAdditionalDirectoryList,
  normalizeWorkspaceAdditionalDirectories,
  resolveWorkspaceAdditionalDirectories,
  buildWorkspaceAdditionalDirectoriesPatch,
  mergeWorkspaceAdditionalDirectories,
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

test("保存往返：patch 保留原样、合并时归一（空白/重复/空串不落盘）", () => {
  const patched = appSettingsPatchSchema.parse({
    workspaceAdditionalDirectories: {
      [WORKSPACE_KEY]: [`  ${BACKEND}  `, BACKEND, "", "   "],
    },
  });
  assert.deepEqual(
    mergeWorkspaceAdditionalDirectories(undefined, patched.workspaceAdditionalDirectories),
    { [WORKSPACE_KEY]: [BACKEND] },
  );

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

test("设置页清除最后一条：补丁里的空列表 = 删除该键，合并后字段缺席", () => {
  const current = appSettingsSchema.parse({
    workspaceAdditionalDirectories: { [WORKSPACE_KEY]: [BACKEND] },
  });
  const patch = appSettingsPatchSchema.parse({
    workspaceAdditionalDirectories: { [WORKSPACE_KEY]: [] },
  });
  const merged = appSettingsSchema.parse({
    ...current,
    workspaceAdditionalDirectories: mergeWorkspaceAdditionalDirectories(
      current.workspaceAdditionalDirectories,
      patch.workspaceAdditionalDirectories,
    ),
  });
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

test("★单键补丁 + 服务端合并：不同工作区的并发编辑互不覆盖", () => {
  const other = "/work/other";
  const current = { [WORKSPACE_KEY]: [BACKEND], [other]: ["/work/other-dir"] };
  // 客户端 A 只提交自己的 key；B 用读到的旧表提交另一个 key。合并后两者都在。
  const patchA = buildWorkspaceAdditionalDirectoriesPatch(WORKSPACE_KEY, ["/work/web"]);
  const afterA = mergeWorkspaceAdditionalDirectories(current, patchA);
  assert.deepEqual(afterA, { [WORKSPACE_KEY]: ["/work/web"], [other]: ["/work/other-dir"] });
  const patchB = buildWorkspaceAdditionalDirectoriesPatch(other, ["/work/other-v2"]);
  assert.deepEqual(mergeWorkspaceAdditionalDirectories(afterA, patchB), {
    [WORKSPACE_KEY]: ["/work/web"],
    [other]: ["/work/other-v2"],
  });

  // 删除也走单键：空列表保留在补丁里，合并时才真正移除。
  const removePatch = buildWorkspaceAdditionalDirectoriesPatch(WORKSPACE_KEY, []);
  assert.deepEqual(removePatch, { [WORKSPACE_KEY]: [] });
  assert.deepEqual(mergeWorkspaceAdditionalDirectories(afterA, removePatch), {
    [other]: ["/work/other-dir"],
  });
  assert.equal(
    mergeWorkspaceAdditionalDirectories({ [WORKSPACE_KEY]: [BACKEND] }, removePatch),
    undefined,
  );
});
