import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * CLI 配置文件（spec: .reverse/36-ssh/CONFIG-FILE-SPEC.md）——从 runner.mjs 按职责拆出（task-49）。
 *
 * 语义（**原样保留，不要在拆分中顺手改**）：
 * - 文件不存在（且非显式指定）⇒ 返回 `{}`；
 * - 非法 JSON / 顶层不是对象 / 值类型非法 ⇒ **抛错**（fail-closed）；
 * - 未知键 ⇒ 打一条 `console.warn` 后忽略（不拒绝启动）。
 *
 * 注意（拆分前 runner.mjs 里的注释已说明、这里继续遵守）：这份逻辑过去是内联在 runner 里的，
 * 因为 runner 会被逐字节拷进分发包的 bin/、而旁路模块不会被一起拷。拆分后由
 * `scripts/build-zcode.mjs` **显式把 runner-*.mjs 一起拷进 bin/**，这个前提才成立。
 */

export const CONFIG_KEY_SPECS = {
  host: { kind: "string" },
  port: { kind: "port" },
  workspace: { kind: "string" },
  token: { kind: "string" },
  noToken: { kind: "boolean" },
  open: { kind: "boolean" },
  authTokensFile: { kind: "string" },
  trustedHosts: { kind: "stringList" },
  trustedOrigins: { kind: "stringList" },
  trustedProxies: { kind: "stringList" },
  csp: { kind: "enum", values: ["off", "report-only", "enforce"] },
  hsts: { kind: "boolean" },
};

function resolveConfigPath() {
  const explicit = process.env.ZCODE_CLI_CONFIG?.trim();
  if (explicit) return { path: explicit, explicit: true };
  return { path: join(homedir(), ".zcode", "cli", "server.json"), explicit: false };
}

function validateConfigValue(path, key, spec, value) {
  const fail = (expected) => {
    throw new Error(
      `配置文件 ${path} 的键 ${JSON.stringify(key)} 取值非法：期望 ${expected}，实际 ${JSON.stringify(value)}`,
    );
  };
  switch (spec.kind) {
    case "string":
      if (typeof value !== "string" || value.trim() === "") fail("非空字符串");
      return value.trim();
    case "boolean":
      if (typeof value !== "boolean") fail("布尔值 true/false");
      return value;
    case "port":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
        fail("1–65535 的整数端口");
      }
      return value;
    case "stringList": {
      const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
      if (!list) fail("字符串或字符串数组");
      const items = list
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item);
      if (items.length !== list.length) fail("非空字符串（或非空字符串数组）");
      return items;
    }
    case "enum":
      if (typeof value !== "string" || !spec.values.includes(value.trim().toLowerCase())) {
        fail(spec.values.join(" / "));
      }
      return value.trim().toLowerCase();
    default:
      return fail("受支持的取值");
  }
}

// 文件不存在（且非显式指定）⇒ 返回 {}；非法 JSON/类型错/值非法 ⇒ 抛错（fail-closed）。
export function loadConfigFile() {
  const { path, explicit } = resolveConfigPath();
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && !explicit) return {};
    throw new Error(`无法读取配置文件 ${path}：${error?.message ?? String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置文件 ${path} 不是合法 JSON：${error?.message ?? String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`配置文件 ${path} 的顶层必须是对象`);
  }
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    const spec = CONFIG_KEY_SPECS[key];
    if (!spec) {
      console.warn(
        `配置文件 ${path} 含未知键 ${JSON.stringify(key)}：已忽略（不拒绝启动；已知键见 .reverse/36-ssh/CONFIG-FILE-SPEC.md）`,
      );
      continue;
    }
    out[key] = validateConfigValue(path, key, spec, value);
  }
  return out;
}

// 文件里的服务端旋钮：只在环境变量没给值时透传（env > 文件）。
export function configEnv(passthrough) {
  const env = {};
  // env > 文件：只在该环境变量**未设置**时才用文件里的值透传。
  const setIfUnset = (name, value) => {
    const current = process.env[name];
    if (current === undefined || current === "") env[name] = value;
  };
  if (passthrough.authTokensFile)
    setIfUnset("ZCODE_SERVER_AUTH_TOKENS_FILE", passthrough.authTokensFile);
  if (passthrough.trustedHosts)
    setIfUnset("ZCODE_SERVER_TRUSTED_HOSTS", passthrough.trustedHosts.join(","));
  if (passthrough.trustedOrigins)
    setIfUnset("ZCODE_SERVER_TRUSTED_ORIGINS", passthrough.trustedOrigins.join(","));
  if (passthrough.trustedProxies)
    setIfUnset("ZCODE_SERVER_TRUSTED_PROXIES", passthrough.trustedProxies.join(","));
  if (passthrough.csp) setIfUnset("ZCODE_SERVER_CSP", passthrough.csp);
  if (typeof passthrough.hsts === "boolean")
    setIfUnset("ZCODE_SERVER_HSTS", passthrough.hsts ? "1" : "");
  return env;
}
