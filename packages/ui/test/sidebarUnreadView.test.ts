import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  persistSidebarTaskPreferences,
  readSidebarTaskPreferences,
} from "../src/lib/sidebarTaskPreferences.js";

/**
 * 侧栏「未读」视图（F6，按 workspaceKey 语义）。
 *
 * 回归形态：未读只在蓝点/角标上体现，用户无法把「哪些任务还没看」收成一个列表；
 * 或者反过来——另建一套未读集合，与角标读到的数据不一致。
 * 这里钉住：偏好可持久化、视图走同一份 task meta.unreadAt、空态与菜单项文案在位。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(here, relative), "utf8");
const sidebarSource = read("../src/WorkspaceSidebar.tsx");
const timelineSource = read("../src/WorkspaceTimelineTasksSection.tsx");

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

test("未读视图偏好可持久化并读回（不新建 store）", () => {
  const storage = memoryStorage();
  persistSidebarTaskPreferences({ organizeBy: "unread", sortBy: "updated" }, storage);
  assert.equal(readSidebarTaskPreferences(storage).organizeBy, "unread");
});

test("未知视图值回退到默认（老数据不会被误读成未读）", () => {
  const storage = memoryStorage(
    JSON.stringify({ organizeBy: "some-future-mode", sortBy: "updated" }),
  );
  assert.equal(readSidebarTaskPreferences(storage).organizeBy, "project");
});

test("侧栏把未读当作视图渲染，且列表只保留 unreadAt 的行", () => {
  // 视图由 organizeBy 派生，未读不额外占一级 tab。
  assert.match(sidebarSource, /if \(params\.taskOrganizeBy === "unread"\) \{\s*return "unread";/u);
  assert.match(sidebarSource, /taskViewMode === "unread" \? \(/u);
  assert.match(sidebarSource, /onlyUnread/u);
  // 空态走 taskList.noUnreadTasks，菜单项走 taskList.viewUnread。
  assert.match(sidebarSource, /taskList\.noUnreadTasks/u);
  assert.match(sidebarSource, /taskList\.viewUnread/u);
  // 过滤读的是与蓝点/角标同一个字段。
  assert.match(
    timelineSource,
    /onlyUnread \? merged\.filter\(\(item\) => Boolean\(item\.unreadAt\)\)/u,
  );
  // 未读集合不分页截断，避免「有未读但看不到」。
  assert.match(timelineSource, /onlyUnread \? sortedItems : sortedItems\.slice/u);
});

test("未读视图文案双语在位", () => {
  for (const key of ["taskList.viewUnread", "taskList.noUnreadTasks"]) {
    assert.ok(key in zhCN, "zh-CN 缺少 " + key);
    assert.ok(key in enUS, "en-US 缺少 " + key);
  }
});
