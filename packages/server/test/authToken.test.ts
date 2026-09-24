import assert from "node:assert/strict";
import test from "node:test";
import { createAuthTokenStore, parseAuthTokenFile } from "../src/authToken.js";

/**
 * 令牌文件与热重载的契约（task-35 / A4）。
 *
 * 为什么这些断言必须有牙：令牌是这条链路上唯一的凭据。文件解析与重载的两条不变式 ——
 * 「重载后旧令牌立即失效」「重载失败不改动现状」—— 一旦破了，症状分别是
 * 「撤销了设备但它还能连」与「一次手滑写坏文件就让所有人掉线」，两者都不会自己暴露。
 *
 * **反向验证（实测过）**：
 * - 把 `verify()` 改成在闭包外缓存一份摘要集合 ⇒ 「重载后旧令牌立即失效」变红；
 * - 把 `reload()` 的 catch 分支改成 `install([])` ⇒ 「重载失败保持上一份集合」变红。
 */

test("解析：支持标签、注释、空行、CRLF 与多余空白", () => {
  const records = parseAuthTokenFile(
    [
      "# 设备钥匙（注释行忽略）",
      "",
      "tok-phone-1 手机",
      "   tok-tablet-2  平板  ",
      "tok-bare",
      "\r",
    ].join("\n"),
  );
  assert.deepEqual(records, [
    { token: "tok-phone-1", label: "手机" },
    { token: "tok-tablet-2", label: "平板" },
    { token: "tok-bare" },
  ]);
});

test("解析：空文件 / 只有注释 / 只有空白 ⇒ 抛错（fail-closed，不静默成空集合）", () => {
  for (const content of ["", "\n\n", "# 只有注释\n", "   \n\t\n"]) {
    assert.throws(
      () => parseAuthTokenFile(content),
      /没有解析出任何令牌/,
      JSON.stringify(content) + " 必须抛错",
    );
  }
});

test("解析：重复令牌不抛错但只保留一条（配置噪声不该阻断启动）", () => {
  const records = parseAuthTokenFile("same-token 第一次\nsame-token 第二次\nother\n");
  assert.deepEqual(records, [{ token: "same-token", label: "第一次" }, { token: "other" }]);
});

test("校验：命中 / 未命中 / 空候选 / 只差一个字符都不得命中", () => {
  const store = createAuthTokenStore({
    records: [
      { token: "alpha-token", label: "a" },
      { token: "beta-token", label: "b" },
    ],
  });
  assert.equal(store.enabled, true);
  assert.equal(store.verify("alpha-token"), true);
  assert.equal(store.verify("beta-token"), true);
  assert.equal(store.verify("alpha-toke"), false, "截断的令牌不得命中");
  assert.equal(store.verify("alpha-token "), false, "带空格的令牌不得命中");
  assert.equal(store.verify(""), false);
  assert.equal(store.verify(undefined), false);
  assert.deepEqual(store.snapshot(), { count: 2, labels: ["a", "b"] });
});

test("热重载：文件删掉一条令牌 ⇒ 旧令牌**立即**失效，其余不受影响", () => {
  let fileContent = "tok-a 设备A\ntok-b 设备B\n";
  const store = createAuthTokenStore({
    records: [],
    fileRecords: parseAuthTokenFile(fileContent),
    filePath: "/tmp/whatever-tokens",
    readFile: () => fileContent,
  });
  assert.equal(store.verify("tok-a"), true);
  assert.equal(store.verify("tok-b"), true);

  // 撤销设备 A：只从文件里删掉那一行。
  fileContent = "tok-b 设备B\n";
  assert.deepEqual(store.reload(), { ok: true });

  assert.equal(store.verify("tok-a"), false, "重载后旧令牌必须立即失效");
  assert.equal(store.verify("tok-b"), true, "未撤销的令牌必须继续可用");
  assert.equal(store.snapshot().count, 1);
});

test("热重载：文件被写坏（空/只有注释）⇒ 保持上一份可用集合，并报出原因（不静默）", () => {
  let fileContent = "tok-a\n";
  const warnings: string[] = [];
  const store = createAuthTokenStore({
    records: [],
    fileRecords: parseAuthTokenFile(fileContent),
    filePath: "/tmp/whatever-tokens",
    readFile: () => fileContent,
    warn: (message) => warnings.push(String(message)),
  });

  fileContent = "";
  const result = store.reload();
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /没有解析出任何令牌/);
  assert.equal(warnings.length, 1, "必须留下一条告警（不静默）");
  assert.equal(store.verify("tok-a"), true, "重载失败不得改动现状：旧令牌仍可用");
});

test("显式令牌与文件令牌合并：文件里删掉一条不影响显式令牌，反之亦然", () => {
  // options.records 代表「启动时的集合」= 显式令牌 + 文件令牌；reload 只重读文件那一部分。
  const explicit = [{ token: "env-token", label: "<env>" }];
  let fileContent = "file-token 设备A\n";
  const store = createAuthTokenStore({
    // 显式令牌走 records（不随重载变化），文件令牌走 fileRecords（随重载整体替换）。
    records: explicit,
    fileRecords: parseAuthTokenFile(fileContent),
    filePath: "/tmp/whatever-tokens",
    readFile: () => fileContent,
  });
  assert.equal(store.verify("env-token"), true);
  assert.equal(store.verify("file-token"), true);

  fileContent = "file-token-2 设备B\n";
  assert.deepEqual(store.reload(), { ok: true });
  assert.equal(store.verify("env-token"), true, "显式令牌不受文件变更影响");
  assert.equal(store.verify("file-token"), false, "被替换的文件令牌失效");
  assert.equal(store.verify("file-token-2"), true);
});

test("未配置文件路径时 reload 明确失败（而不是假装成功）", () => {
  const store = createAuthTokenStore({ records: [{ token: "only" }] });
  const result = store.reload();
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /未配置令牌文件路径/);
  assert.equal(store.verify("only"), true);
});

test("空集合 ⇒ enabled=false（`--no-token` 形态；http.ts 据此不种 cookie）", () => {
  const store = createAuthTokenStore({ records: [] });
  assert.equal(store.enabled, false);
  assert.equal(store.verify("anything"), false);
});
