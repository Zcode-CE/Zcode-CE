import assert from "node:assert/strict";
import { test } from "node:test";

import { compareVersions, planVersionRetention } from "../r2-upload-lib.mjs";

/**
 * 保留最近 N 个版本的**红线**测试。
 *
 * 为什么这个测试必须存在：清理是本仓库唯一不可逆的操作，而它最容易犯的错不是"删多了版本"，
 * 而是**误删 components/** —— 那批对象是内容寻址、跨版本共享的远程工作区资产，
 * 删掉之后旧客户端直接连不上远程工作区，且**无法恢复**（除非重新构建旧版本）。
 * 代码里"看起来"只按 releases/ 前缀列举，但前缀是调用方传的；这里用合成数据把不变式钉死，
 * 不依赖任何网络与凭据。
 */

function obj(key, size = 100) {
  return { key, size, lastModified: "2026-01-01T00:00:00.000Z" };
}

function releaseObjects(version, tarballSize = 80_000_000) {
  return [
    obj(`releases/${version}/zcode-${version}.tar.gz`, tarballSize),
    obj(`releases/${version}/sha256.txt`, 91),
  ];
}

test("components/** 永不进入删除候选", () => {
  const objects = [
    obj("components/linux-x64/node-runtime/v22.16.0+40f5b23a4a68.tar.gz", 40_000_000),
    obj("components/darwin-arm64/glm/v0.13.3+3b12894a7634.tar.gz", 6_000_000),
    // 内容寻址的 components 与版本目录同名前缀，确保不会被"前缀匹配"误伤。
    obj("releases/1.0.0/components-backup.tar.gz", 10),
    ...releaseObjects("1.0.0"),
    ...releaseObjects("2.0.0"),
    ...releaseObjects("3.0.0"),
  ];
  const plan = planVersionRetention({ objects, keepVersions: 2, currentVersion: "3.0.0" });
  // 只有 1.0.0 落到窗口外：它的 3 个对象（含同前缀的 components-backup.tar.gz，
  // 那是 releases/ 下的正常对象，应当被删）全部入选，且仅此 3 个。
  assert.deepEqual(plan.doomed.map((item) => item.key).sort(), [
    "releases/1.0.0/components-backup.tar.gz",
    "releases/1.0.0/sha256.txt",
    "releases/1.0.0/zcode-1.0.0.tar.gz",
  ]);
  for (const item of plan.doomed) {
    assert.ok(item.key.startsWith("releases/1.0.0/"), "意外入选：" + item.key);
    assert.ok(!item.key.startsWith("components/"), "components 被误选：" + item.key);
  }
});

test("只认 releases/<版本>/<文件名> 三段式，其它形态一律忽略", () => {
  const objects = [
    obj("latest.json"),
    obj("install.sh"),
    obj("releases/1.0.0"),
    obj("releases/1.0.0/nested/deep.tar.gz"),
    obj("components/linux-x64/x.tar.gz"),
    obj("1.0.0/manifest-linux-x64.json"),
    ...releaseObjects("1.0.0"),
    ...releaseObjects("2.0.0"),
  ];
  const plan = planVersionRetention({ objects, keepVersions: 1, currentVersion: "2.0.0" });
  assert.deepEqual(plan.versions, ["2.0.0", "1.0.0"]);
  assert.deepEqual(plan.doomed.map((item) => item.key).sort(), [
    "releases/1.0.0/sha256.txt",
    "releases/1.0.0/zcode-1.0.0.tar.gz",
  ]);
});

test("版本号按数字分段排序：ce.10 比 ce.2 新", () => {
  // 字符串排序会把 ce.10 排在 ce.2 之前 —— 那会让"保留最近 10 个"变成"保留字典序前 10 个"，
  // 结果是最新的几个版本被删掉。
  assert.ok(compareVersions("3.14.3-ce.10", "3.14.3-ce.2") > 0);
  assert.ok(compareVersions("3.14.3-ce.2", "3.14.3-ce.10") < 0);
  assert.ok(compareVersions("3.14.3-ce.1", "3.14.1-ce.1") > 0);
  assert.ok(compareVersions("3.14.1-ce.1.fix.1", "3.14.1-ce.1") > 0);
  assert.equal(compareVersions("3.14.3-ce.3", "3.14.3-ce.3"), 0);

  const objects = [
    ...releaseObjects("3.14.3-ce.2"),
    ...releaseObjects("3.14.3-ce.10"),
    ...releaseObjects("3.14.3-ce.9"),
  ];
  const plan = planVersionRetention({ objects, keepVersions: 1, currentVersion: "3.14.3-ce.10" });
  assert.deepEqual(plan.keep, ["3.14.3-ce.10"]);
  assert.deepEqual(plan.doomed.map((item) => item.key.split("/")[1]).sort(), [
    "3.14.3-ce.2",
    "3.14.3-ce.2",
    "3.14.3-ce.9",
    "3.14.3-ce.9",
  ]);
});

test("当前版本无条件保留（补传老版本时不会把自己删掉）", () => {
  const objects = [
    ...releaseObjects("1.0.0"),
    ...releaseObjects("2.0.0"),
    ...releaseObjects("3.0.0"),
  ];
  const plan = planVersionRetention({ objects, keepVersions: 1, currentVersion: "1.0.0" });
  assert.ok(plan.keep.includes("1.0.0"));
  assert.ok(plan.keep.includes("3.0.0"));
  for (const item of plan.doomed) {
    assert.ok(!item.key.startsWith("releases/1.0.0/"), "当前版本被选中删除：" + item.key);
  }
});

test("远端版本数不超过窗口时没有任何删除候选", () => {
  const objects = [...releaseObjects("1.0.0"), ...releaseObjects("2.0.0")];
  const plan = planVersionRetention({ objects, keepVersions: 10, currentVersion: "2.0.0" });
  assert.deepEqual(plan.doomed, []);
});

test("keepVersions 为 0 时夹到 1，不会退化成一个都不保留", () => {
  const objects = [...releaseObjects("1.0.0"), ...releaseObjects("2.0.0")];
  const plan = planVersionRetention({ objects, keepVersions: 0, currentVersion: "2.0.0" });
  assert.ok(plan.keep.includes("2.0.0"));
  assert.equal(plan.doomed.length, 2);
});
