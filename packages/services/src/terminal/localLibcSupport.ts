import { readdirSync } from "node:fs";

/**
 * 本地（本进程所在主机）libc 能力边界（task-70）。
 *
 * 为什么必须在**第一次原生 dlopen / spawn 之前**拦：本版内置的 node-pty 是 glibc 构建。
 * 在 musl 主机（Alpine 自带 node、npm 形态 CLI）上实测：`process.dlopen` 装载这份 pty.node **成功**
 * ⇒ `terminalService` 里 `import("node-pty")` 的 `.catch` **永不触发**；紧接着 `spawn` 走原生 `fork()`
 * ⇒ **Segmentation fault（core dumped）、exit 139**，整个进程被杀，**不可捕获**。
 * 所以这里不是「打日志降级」，而是**前置拦住**。
 *
 * 判据（与远端守卫同一偏向：宁可放过也不误伤 glibc）：
 *   ① `process.report` 的 `glibcVersionRuntime` 存在 ⇒ glibc，放行；
 *   ② 它缺失**且**存在 `/lib/ld-musl-*.so.1` ⇒ musl，拦住；
 *   ③ 两者都判不出 ⇒ fail-open 放行，但**必须留日志**（判据不足不等于主机有问题）。
 * 非 Linux 平台直接跳过。
 */

export type LocalLibc = "glibc" | "musl" | "unknown";

export interface LocalLibcSnapshot {
  platform: string;
  /** glibc 主机上由 `process.report` 提供；musl 主机上缺失。 */
  glibcVersionRuntime?: string;
  /** 命中的 musl loader（`/lib/ld-musl-*.so.1`）。 */
  muslLoaderPath?: string;
  /** 读取判据时的失败原因：不能静默吞掉，判据不足时要能说清为什么。 */
  readFailures: string[];
}

export interface LocalLibcProbeResult {
  libc: LocalLibc;
  evidence: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readGlibcVersionRuntime(): { value?: string; failure?: string } {
  try {
    const report = process.report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: unknown } }
      | undefined;
    const value = report?.header?.glibcVersionRuntime;
    if (typeof value === "string" && value.trim()) {
      return { value: value.trim() };
    }
    return {};
  } catch (error) {
    return { failure: `读取 process.report 失败：${errorMessage(error)}` };
  }
}

export function readLocalLibcSnapshot(): LocalLibcSnapshot {
  const readFailures: string[] = [];
  const glibcReport = readGlibcVersionRuntime();
  if (glibcReport.failure) {
    readFailures.push(glibcReport.failure);
  }

  let muslLoaderPath: string | undefined;
  if (process.platform === "linux") {
    try {
      const loader = readdirSync("/lib").find(
        (name) => name.startsWith("ld-musl-") && name.endsWith(".so.1"),
      );
      if (loader) {
        muslLoaderPath = `/lib/${loader}`;
      }
    } catch (error) {
      readFailures.push(`读取 /lib 失败：${errorMessage(error)}`);
    }
  }

  return {
    platform: process.platform,
    ...(glibcReport.value ? { glibcVersionRuntime: glibcReport.value } : {}),
    ...(muslLoaderPath ? { muslLoaderPath } : {}),
    readFailures,
  };
}

export function classifyLocalLibc(snapshot: LocalLibcSnapshot): LocalLibcProbeResult {
  if (snapshot.platform !== "linux") {
    return {
      libc: "unknown",
      evidence: [`platform=${snapshot.platform}（libc 判定只在 Linux 上做）`],
    };
  }
  if (snapshot.glibcVersionRuntime) {
    return { libc: "glibc", evidence: [`glibcVersionRuntime=${snapshot.glibcVersionRuntime}`] };
  }
  if (snapshot.muslLoaderPath) {
    return {
      libc: "musl",
      evidence: ["process.report 无 glibcVersionRuntime", snapshot.muslLoaderPath],
    };
  }
  return {
    libc: "unknown",
    evidence: ["既无 glibcVersionRuntime，也没有 /lib/ld-musl-*.so.1", ...snapshot.readFailures],
  };
}

export function formatMuslHostMessage(probe: LocalLibcProbeResult): string {
  return [
    `当前主机是 musl libc（证据：${probe.evidence.join("；")}），本版内置的 node-pty 是 glibc 构建。`,
    "它能被成功装载（dlopen 通过），但创建终端时原生 fork() 会段错误（core dumped / exit 139）",
    "并**杀掉整个进程** —— 该崩溃不可捕获，不是「终端不可用」那种可恢复错误，所以在尝试原生创建之前就拦断。",
    "改用 glibc 发行版运行，并让 Node 满足本项目的 engines 下限（例如 node:24-slim，或在 debian / ubuntu 镜像里自行安装 Node ≥24）；",
    "确认与替代做法见 docs/operations/headless-server.md 的支持边界表与 docs/development/remote-workspace.md §7。",
  ].join("");
}

export interface LocalLibcGuardOptions {
  /** 测试缝：注入快照；不传则读真实运行环境。 */
  snapshot?: LocalLibcSnapshot;
  log?: (message: string, ...rest: unknown[]) => void;
}

export function assertLocalTerminalNativeSupported(options: LocalLibcGuardOptions = {}): void {
  const snapshot = options.snapshot ?? readLocalLibcSnapshot();
  const probe = classifyLocalLibc(snapshot);
  if (probe.libc === "glibc") {
    return;
  }
  if (probe.libc === "unknown") {
    // fail-open：判据不足时放行（判据不足不等于主机有问题），但必须留痕，便于排障。
    options.log?.("本地 libc 无法判定，按放行处理：", probe.evidence.join("；"));
    return;
  }
  throw new Error(formatMuslHostMessage(probe));
}
