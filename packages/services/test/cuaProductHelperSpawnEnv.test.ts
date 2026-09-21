import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BROKER_SOCKET_ENV, BROKER_UNAVAILABLE_ENV, CuaHelperError } from "@zcode/zcode-cua/broker";
import { ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY } from "@zcode/shared";
import { buildCuaProductHelperAgentEnv } from "../src/node.js";
import {
  canRunOpenSourceCuaDriver,
  mintCuaProductHelperEnv,
  resolveCuaProductHelperSpawnEnv,
} from "../src/cua-permission-broker/cuaProductHelperSpawnEnv.js";

/**
 * F3-2：官方 Helper 只是 Computer Use 的凭据来源，不是门控。
 *
 * 背景：CE 构建不随包携带 cua-helper（macOS 的 resources/cua-helper/*.app 与 Windows 的
 * resources/tools/cua-helper 都不在 electron-builder 的 extraResources 里），因此
 * buildCuaProductHelperAgentEnv 在 win32 必然回落到 BROKER_UNAVAILABLE；而 bootstrap 的注入
 * 门控（apps/zcode-cli/packages/bootstrap/src/mcp-config.ts:124-131）要求 socket 非空，
 * 于是 ZCODE_CUA_NODE_REPL_HOST 永远注入不进去，trycua 路径起不来。
 * 本文件锁住回落契约，并锁住几个**不能**被回落吃掉的 fail-closed 分支。
 *
 * 运行：cd packages/services && node --import tsx --test test/cuaProductHelperSpawnEnv.test.ts
 */

const NODE_TS_PATH = fileURLToPath(new URL("../src/node.ts", import.meta.url));
/** 只用到 warn；buildCuaProductHelperAgentEnv 的其它日志方法不参与断言。 */
const silentLogger = { warn() {}, info() {}, error() {}, debug() {} };

function hex32(value: string): boolean {
  return /^[0-9a-f]{32}$/u.test(value);
}

test("Helper transport 可用时原样透传，不铸造", () => {
  const transport = {
    [BROKER_SOCKET_ENV]: "/tmp/helper-broker.sock",
    [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "authority-from-helper",
  };
  assert.equal(resolveCuaProductHelperSpawnEnv(transport, { platform: "win32" }), transport);
  assert.equal(
    resolveCuaProductHelperSpawnEnv(transport, { platform: "darwin" }),
    transport,
    "身份相等即未被替换（避免每次 spawn 生成新对象掩盖差异）",
  );
});

for (const platform of ["win32", "darwin", "linux"] as const) {
  test(`${platform}：Helper 失败回落成开源驱动的凭据契约`, () => {
    const failure = { [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper start failed" };
    const env = resolveCuaProductHelperSpawnEnv(failure, { platform });
    assert.ok(env[BROKER_SOCKET_ENV]?.trim(), "必须下发非空 socket");
    assert.ok(hex32(env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY] ?? ""), "authority 是 16 字节随机数");
    assert.equal(env[BROKER_UNAVAILABLE_ENV], undefined, "铸造后不得再带 unavailable marker");
  });
}

test("开源驱动没有产物的平台保持 fail-closed：原样返回 envelope", () => {
  const failure = { [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper start failed" };
  assert.equal(resolveCuaProductHelperSpawnEnv(failure, { platform: "freebsd" }), failure);
  assert.equal(canRunOpenSourceCuaDriver("freebsd"), false);
  assert.equal(canRunOpenSourceCuaDriver("win32"), true);
});

test("mintCuaProductHelperEnv 的两个键与 node.ts 懒启动分支同形", () => {
  const env = mintCuaProductHelperEnv();
  assert.ok(env[BROKER_SOCKET_ENV]?.trim());
  assert.ok(hex32(env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY] ?? ""));
  assert.deepEqual(
    Object.keys(env).sort(),
    [BROKER_SOCKET_ENV, ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY].sort(),
  );
});

test("buildCuaProductHelperAgentEnv：Helper 启动失败 ⇒ win32 拿到凭据契约而不是 unavailable", async () => {
  let startCalls = 0;
  const host = {
    running: false,
    async start() {
      startCalls += 1;
      // 与 CE 上的真实失败同形：resources/tools/cua-helper 不存在。
      throw new Error("Windows CUA runtime is missing required entry: entry.");
    },
  };
  const first = await buildCuaProductHelperAgentEnv(host, silentLogger);
  assert.ok(first[BROKER_SOCKET_ENV]?.trim(), "win32 spawn env 必须含 socket");
  assert.ok(
    hex32(first[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY] ?? ""),
    "win32 spawn env 必须含 authority",
  );
  assert.equal(first[BROKER_UNAVAILABLE_ENV], undefined, "不得残留 unavailable marker");

  // 退避窗口必须被清掉：CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS = 30_000（node.ts:549）。
  // 失败时写进 cuaProductHelperAgentEnvRetryAt 后，窗口内的下一次 spawn 会在
  // buildCuaProductHelperAgentEnv:1173-1177 拿到 "broker_unavailable: helper startup retry is
  // deferred" envelope、又被判成「无凭据」——Windows 会退化成「每个 30s 窗口只有一次会话能用
  // 电脑控制」。这条断言锁住 ②′：第二次 spawn 仍必须重新拿到 socket + authority。
  const second = await buildCuaProductHelperAgentEnv(host, silentLogger);
  assert.equal(startCalls, 2, "第二次 spawn 仍应重新尝试并再次铸造");
  assert.ok(second[BROKER_SOCKET_ENV]?.trim());
  assert.equal(second[BROKER_UNAVAILABLE_ENV], undefined);
});

test("buildCuaProductHelperAgentEnv：共享冷启动 caller_timeout 仍 fail-closed，不铸造", async () => {
  const host = {
    running: false,
    async start() {
      throw new CuaHelperError("helper broker warming up", { code: "caller_timeout" });
    },
  };
  const env = await buildCuaProductHelperAgentEnv(host, silentLogger);
  assert.equal(env[BROKER_UNAVAILABLE_ENV], "broker_unavailable: helper broker warming up");
  assert.equal(env[BROKER_SOCKET_ENV], undefined, "冷启动在途时不得伪造凭据");
});

test("源码护栏：清 30s 退避只发生在铸造分支内，未铸造的分支仍写退避", () => {
  const source = readFileSync(NODE_TS_PATH, "utf8");
  // 真实存在的 Helper 反复启动失败时必须保留退避，所以删除只能落在铸造这一条路径上；
  // 结构：铸造分支 delete 退避并 return 契约 → 未铸造（开源驱动不支持该平台）的分支照旧 set。
  const mintIndex = source.indexOf("if (openSourceEnv !== helperFailureEnv) {");
  const deleteIndex = source.indexOf("cuaProductHelperAgentEnvRetryAt.delete(host);", mintIndex);
  const returnIndex = source.indexOf("return openSourceEnv;", deleteIndex);
  const setIndex = source.indexOf(
    "cuaProductHelperAgentEnvRetryAt.set(host, Date.now() + CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS)",
    returnIndex,
  );
  assert.ok(mintIndex > 0, "找不到铸造分支");
  assert.ok(deleteIndex > mintIndex, "清退避必须在铸造分支内");
  assert.ok(returnIndex > deleteIndex, "铸造分支必须在写退避之前 return");
  assert.ok(setIndex > returnIndex, "未铸造的路径必须仍写退避（真实 Helper 启动失败要退避）");
});

test("源码护栏：lifecycle-disposed 分支仍产 BROKER_UNAVAILABLE_ENV，且回落只有一个调用点", () => {
  const source = readFileSync(NODE_TS_PATH, "utf8");
  const disposedMarker = '"broker_unavailable: helper lifecycle is disposed"';
  assert.equal(
    source.split(disposedMarker).length - 1,
    2,
    "resolveSpawnEnv 的两条 disposed 分支必须原样保留（真实生命周期事实，不能合并进铸造回落）",
  );
  const callSites = source.split("resolveCuaProductHelperSpawnEnv(").length - 1;
  assert.equal(callSites, 1, "回落必须只接在 buildCuaProductHelperAgentEnv 的启动失败分支上");
  const catchIndex = source.indexOf("const isCallerTimeout = isCuaHelperError(error)");
  const callIndex = source.indexOf("resolveCuaProductHelperSpawnEnv(helperFailureEnv)");
  assert.ok(catchIndex > 0 && callIndex > catchIndex, "回落调用必须落在 catch 的失败回落里");
});
