import { spawn } from "node:child_process";

/**
 * 身份头与 usage 文案（从 runner.mjs 按职责拆出，见 task-49）。
 *
 * 为什么单独成模块：这份文案是**用户可见输出**，且会随分发包一起发出去；
 * 把它单独放一处，好处是「改文案」与「改逻辑」不再互相挤在同一个已经超长的文件里。
 *
 * 拆分时的硬约束（当时就是这么做的）：**整段原样搬**，逐字节一致。
 * 校验方式见 scripts/build-zcode.mjs 产出的分发包：`bin/zcode.mjs --web --help` 与
 * 拆分前的 golden 基准 `diff -u` 必须零差异（在**解包产物**上比，不是在仓库里比）。
 *
 * 依赖方向：本模块不 import runner.mjs（否则会形成循环依赖 —— runner 要 import 本模块的 usage()）。
 * 运行期需要的信息由 runner.mjs 在启动时通过 `setUsageContext` 注入：
 * 这正是拆出「配置注入」而不是「反向 import」的原因。
 */

let context = {
  packageVersion: "unknown",
  agentEntry: undefined,
  agentVersion: undefined,
};

/** 由 runner.mjs 在启动时注入：包版本、内置 agent 入口（用于取版本）。 */
export function setUsageContext(next) {
  context = { ...context, ...next };
}

/** 内置 agent CLI 的版本：问它自己一次（只在需要身份头/版本输出时发生），失败则 undefined。 */
export async function resolveAgentVersion() {
  if (context.agentVersion !== undefined) {
    return context.agentVersion;
  }
  if (!context.agentEntry) {
    return undefined;
  }
  context.agentVersion = await new Promise((resolveVersion) => {
    const child = spawn(process.execPath, [context.agentEntry, "--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    const timer = globalThis.setTimeout(() => {
      child.kill("SIGKILL");
      resolveVersion(undefined);
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", () => {
      globalThis.clearTimeout(timer);
      resolveVersion(undefined);
    });
    child.once("exit", () => {
      globalThis.clearTimeout(timer);
      resolveVersion(output.trim().split("\n")[0]?.trim() || undefined);
    });
  });
  return context.agentVersion;
}

/** 异步解析出的版本在**同步**位置（usage 文案）的标签；未就绪时退化为占位说明。 */
export function agentVersionLabel() {
  return typeof context.agentVersion === "string" && context.agentVersion
    ? context.agentVersion
    : "版本见下";
}

export function usage() {
  return `zcode-ce ${context.packageVersion}（内置 agent CLI: zcode-agent ${agentVersionLabel()}）

Usage:
  zcode --web [--host <host>] [--port <port>] [--workspace <path>] [--open|--no-open] [--token <token>|--no-token]
  zcode --version

Defaults:
  --host       127.0.0.1（只监听回环；要对外请传局域网 IP 或 0.0.0.0，那时必须带令牌）
  --port       3030（被占用时自动回退到空闲端口；启动日志始终打印实际地址）
  --workspace  当前目录
  --open       回环时开启，其它情况关闭
  令牌         回环默认关闭；非回环自动生成（--token=<值> 可指定）

环境变量（服务进程）：
  ZCODE_SERVER_AUTH_TOKEN        显式令牌，与令牌文件**并存、取并集**
  ZCODE_SERVER_AUTH_TOKENS_FILE  每行一条令牌的文件；SIGHUP 重载；文件空/坏 ⇒ 拒绝启动
  ZCODE_SERVER_TRUSTED_HOSTS     Host 白名单（挡 DNS rebinding），追加在回环+本机网卡+监听地址之后
  ZCODE_SERVER_TRUSTED_ORIGINS   跨源白名单（同源判定恒优先）
  ZCODE_SERVER_TRUSTED_PROXIES   可信代理（IP/CIDR），只有它们给的 X-Forwarded-For 被采信；默认谁都不信
  ZCODE_SERVER_CSP               缺省 report-only；可 off / enforce
  ZCODE_SERVER_HSTS              只在 https 且显式开启时下发
  数据目录                       ~/.zcode/v2（与桌面端共用）

Notes:
  --no-token 只允许与回环 host 组合（--no-token is only allowed with a loopback --host）：
  非回环绑定必须带令牌，否则服务端会拒绝启动。
  --web / --version 之外的参数会转发给内置 agent CLI（zcode-agent）。
`;
}
