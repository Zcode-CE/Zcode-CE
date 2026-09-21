import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAUDE_PLUGINS_OFFICIAL_MARKETPLACE_ID,
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  DEFAULT_PLUGIN_MARKETPLACES,
  PUBLIC_STORE_MARKETPLACE_IDS,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  isPublicStoreMarketplaceId,
} from "@zcode/shared";

/**
 * 社区插件入口：上游开源代码只保留了官方市场，导致 Superpowers、context7 等
 * 社区插件没有安装入口。这里锁住「默认市场包含社区目录」这条约定，
 * 防止后来者以「精简」为由删掉它而重新引入用户可见的能力缺失。
 */
test("默认市场包含官方市场与社区目录两个条目", () => {
  const ids = DEFAULT_PLUGIN_MARKETPLACES.map((marketplace) => marketplace.id);
  assert.deepEqual(ids, [
    ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    CLAUDE_PLUGINS_OFFICIAL_MARKETPLACE_ID,
  ]);
});

test("社区目录指向 anthropics/claude-plugins-official", () => {
  const community = DEFAULT_PLUGIN_MARKETPLACES.find(
    (marketplace) => marketplace.id === CLAUDE_PLUGINS_OFFICIAL_MARKETPLACE_ID,
  );
  assert.ok(community, "社区目录必须存在");
  // source 用 owner/repo 简写形式，与官方发行版一致。
  assert.equal(community.source, "anthropics/claude-plugins-official");
  // name 必须等于 canonical id，否则市场 manifest 校验会失配。
  assert.equal(community.name, CLAUDE_PLUGINS_OFFICIAL_MARKETPLACE_ID);
});

test("公开商店分段只含官方市场，社区目录不进该分段", () => {
  // 与官方发行版一致：claude-plugins-official 是默认市场但不属于「公开」分段，
  // 因此它不会被当成 ZCode 自己的市场展示。
  assert.deepEqual([...PUBLIC_STORE_MARKETPLACE_IDS], [ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID]);
  assert.equal(isPublicStoreMarketplaceId(ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID), true);
  assert.equal(isPublicStoreMarketplaceId(CLAUDE_PLUGINS_OFFICIAL_MARKETPLACE_ID), false);
});

test("默认启用集合与官方发行版逐项一致", () => {
  // 这 10 项必须与官方发行版的集合完全相同；其中 5 项在本仓库没有实体
  // （官方授权限制或仅分发编译产物），属于无效条目而非错误 —— 判定链在
  // 没有 candidate 时不会执行。删除它们会让后续同步上游时产生冲突。
  assert.deepEqual(
    [...DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS].sort(),
    [
      "browser-use@zcode-plugins-official",
      "documents@zcode-plugins-official",
      "image-search@zcode-plugins-official",
      "node-repl-host@zcode-plugins-official",
      "pdf@zcode-plugins-official",
      "plugin-creator@zcode-plugins-official",
      "presentations@zcode-plugins-official",
      "skill-creator@zcode-plugins-official",
      "spreadsheets@zcode-plugins-official",
      "zcode-guide@zcode-plugins-official",
    ].sort(),
  );
});
