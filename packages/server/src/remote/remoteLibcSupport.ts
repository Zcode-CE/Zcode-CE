import type { IRemoteBackend, RemoteEnvironment } from "@zcode/server/remote/backend.js";

/**
 * 远端 libc 能力边界（task-64）。
 *
 * 为什么必须**在部署资产之前**拦断：本版远端载荷是 glibc 构建。在 musl 目标（如 Alpine）上，
 * `pty.node` **能加载**（musl 的 libc soname 别名让它过），但建终端时原生 `fork()` 会**段错误**
 * （实测 exit 139 / core dumped）—— 这是**不可捕获**的失败，会把整个远端 zcode-server 进程带走。
 * 所以正确处置不是「检测 + 运行时显式声明降级」（`terminalService` 那处声明挂在 `import("node-pty")`
 * 的 catch 上、防的是加载失败，在 musl 上根本不触发），而是连接/部署前 fail-closed。
 *
 * 判定方式复用既有探测风格（`detect()` 读 `/proc/sys/kernel/ostype` 那一类）：只看文件系统标记，
 * 不依赖 `getconf`/`ldd` 是否安装，也不引入新命令。
 * **顺序上先判 glibc**：宁可放过，也绝不误伤 glibc 远端（误判会让正常用户连不上）。
 */

const GLIBC_LOADER_BY_ARCH: Record<string, string> = {
  x64: "/lib64/ld-linux-x86-64.so.2",
  arm64: "/lib/ld-linux-aarch64.so.1",
};

const MUSL_LOADER_BY_ARCH: Record<string, string> = {
  x64: "/lib/ld-musl-x86_64.so.1",
  arm64: "/lib/ld-musl-aarch64.so.1",
};

/** glibc 的稳定标记：dynamic loader 之外再兜一层 libc.so.6（musl 是 /lib/libc.musl-*.so.1）。 */
const GLIBC_LIBC_SO = "/lib64/libc.so.6";
/** Alpine 的发行版标记，作为 musl loader 之外的兜底证据（task-63 实测路径 /etc/alpine-release）。 */
const MUSL_DISTRO_MARKER = "/etc/alpine-release";

export type RemoteLibc = "glibc" | "musl" | "unknown";

export interface RemoteLibcProbe {
  libc: RemoteLibc;
  /** 命中的路径或探测失败原因：直接进错误文案，便于用户自己复核。 */
  evidence: string[];
}

function glibcCandidates(env: RemoteEnvironment): string[] {
  return [GLIBC_LOADER_BY_ARCH[env.arch], GLIBC_LIBC_SO].filter((item): item is string =>
    Boolean(item),
  );
}

function muslCandidates(env: RemoteEnvironment): string[] {
  return [MUSL_LOADER_BY_ARCH[env.arch], MUSL_DISTRO_MARKER].filter((item): item is string =>
    Boolean(item),
  );
}

interface ExistingProbeOptions {
  log?: (...args: unknown[]) => void;
  failures: string[];
}

async function firstExisting(
  backend: IRemoteBackend,
  paths: string[],
  options: ExistingProbeOptions,
): Promise<string | undefined> {
  for (const path of paths) {
    try {
      if (await backend.exists(path)) {
        return path;
      }
    } catch (error) {
      // 探测本身失败（连接抖动等）不等于「文件不存在」：记下来、继续下一候选，并且**必须留痕**。
      const message = error instanceof Error ? error.message : String(error);
      options.failures.push(`${path}（探测失败：${message}）`);
      options.log?.(`libc 探测：exists(${path}) 失败，继续下一候选：`, message);
    }
  }
  return undefined;
}

export async function probeRemoteLibc(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  log?: (...args: unknown[]) => void,
): Promise<RemoteLibcProbe> {
  if (env.platform !== "linux") {
    return { libc: "unknown", evidence: [`platform=${env.platform}（libc 只在 Linux 远端判定）`] };
  }

  const failures: string[] = [];
  const glibcHit = await firstExisting(backend, glibcCandidates(env), { log, failures });
  if (glibcHit) {
    return { libc: "glibc", evidence: [glibcHit] };
  }

  const muslHit = await firstExisting(backend, muslCandidates(env), { log, failures });
  if (muslHit) {
    return { libc: "musl", evidence: [muslHit, ...failures] };
  }

  return { libc: "unknown", evidence: ["未命中 glibc / musl 任一侧的文件标记", ...failures] };
}

export function formatMuslUnsupportedMessage(probe: RemoteLibcProbe): string {
  return [
    `远端使用 musl libc（证据：${probe.evidence.join("；")}），本版远端载荷是 glibc 构建，在其上不可用。`,
    "后果：建终端时原生 fork() 会段错误（exit 139 / core dumped），该崩溃不可捕获，会把整个远端 zcode-server 进程一起带走；",
    "因此在部署资产之前就拦断，避免「部署成功 → 建终端 → 服务端被杀」这条路径。",
    "改用 glibc 发行版的远端镜像（ubuntu / debian 的默认 tag 均可），或换一台 glibc 远端；",
    "确认与替代做法见 docs/development/remote-workspace.md §7「远端必须是 glibc（musl 不可用）」。",
  ].join("");
}

export async function assertSupportedRemoteLibc(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  log?: (...args: unknown[]) => void,
): Promise<void> {
  const probe = await probeRemoteLibc(backend, env, log);
  if (probe.libc === "glibc") {
    return;
  }
  if (probe.libc === "unknown") {
    // fail-open：证据不足时放行（判据不足不等于远端有问题），但必须留痕，便于排障。
    log?.("remote libc 无法判定，按放行处理：", probe.evidence.join("；"));
    return;
  }
  throw new Error(formatMuslUnsupportedMessage(probe));
}
