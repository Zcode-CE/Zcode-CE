// Modified by ZCode: 自上游 zai-org/ZCode v4.0.0 (a4b44451, Apache-2.0) 并入本波安全/稳定性修复（详见 docs/development/upstream-sync.md）。
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { extname, join, posix } from "node:path";
import {
  WORKSPACE_HOOK_EVENT_NAMES,
  type WorkspaceHookDefinition,
  type WorkspaceHookSourceInput,
} from "./workspace-hook-config.js";

/**
 * Hook 直接入口脚本的内容绑定（D24，ZP-20261110-06）。
 *
 * 为什么需要：declaration digest 只覆盖声明字段，声明一字不改、只替换入口脚本时旧 Trust 会继续
 * 放行，而且没有任何可见的信任状态变化。这里只识别声明本身能确定的直接入口，不解析通用 Shell
 * 语法，也不读取参数指向的其他文件；识别结果只进入 digest 与派发前复核，不改写实际执行的命令。
 */

export type WorkspaceHookScriptState =
  | { kind: "file"; sha256: string }
  | { kind: "missing" }
  | { kind: "unverifiable" };

export interface WorkspaceHookScriptEntry {
  /** 相对执行 cwd 的 POSIX 路径。 */
  path: string;
  state: WorkspaceHookScriptState;
}

const SCRIPT_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
]);
const PROJECT_DIR_VARIABLES = ["ZCODE_PROJECT_DIR", "CLAUDE_PROJECT_DIR"] as const;
// process 不经过 shell，${VAR} 由 Runtime 按文本展开为 cwd，作为单个 argv 传递。
const PROCESS_PROJECT_DIR_PREFIXES = PROJECT_DIR_VARIABLES.map((name) => `\${${name}}/`);
// command 经 shell 执行：未加引号的 $VAR 会被 cwd 中的空格拆开，${VAR} 先被文本替换进命令后
// cwd 里的 " $ 反引号仍会被 shell 解释。只保留由 shell 在引号内展开的 "$VAR"/ 写法。
const COMMAND_PROJECT_DIR_PREFIXES = PROJECT_DIR_VARIABLES.map((name) => `"$${name}"/`);
// 只要出现该字符集以外的字符（引号、$、%、;、|、&、重定向、通配符、反斜杠、换行、非 ASCII
// 空白等），整条命令不识别。Windows 上 command 不进入识别（见 identifyWorkspaceHookScriptPath）。
const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9_./@+=:,-]*$/u;
const SCRIPT_PATH_TOKEN = /^[A-Za-z0-9_./-]+$/u;
const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;
// 读取预算：stat/open 不响应取消信号，脚本位于无响应的文件系统时必须靠这条截止时间收口，
// 否则会话初始化与 Settings 加载会无限等待。
const DISCOVERY_READ_BUDGET_MS = 5_000;
// 同时读取的入口脚本数上限：大量 Hook 时一次打开过多文件会触发 EMFILE、波及进程内其他 I/O；
// 无法取消的挂起读取（如 fstat 卡住）也最多占用这么多个句柄。
const MAX_CONCURRENT_SCRIPT_READS = 8;

export function workspaceHookReviewItemId(
  sourceFileIndex: number,
  event: string,
  matcherIndex: number,
  hookIndex: number,
): string {
  return `workspace-hook-${sourceFileIndex}-${event}-${matcherIndex}-${hookIndex}`;
}

/**
 * 识别声明的直接入口脚本；返回相对执行 cwd 的路径，识别不到时返回 undefined。
 *
 * 识别规则按平台与写法收窄，宁可少绑定也不绑错：绑定到的文件必须就是子进程实际打开的文件。
 */
export function identifyWorkspaceHookScriptPath(
  hook: WorkspaceHookDefinition,
  /** Hook 实际执行的平台；远程工作区的 Settings 也在远端计算，两侧必须一致。 */
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (hook.type === "process") {
    if (SCRIPT_INTERPRETERS.has(hook.command)) {
      const script = hook.args?.[0];
      if (script === undefined || script.startsWith("-")) return undefined;
      return normalizeScriptPath(script, PROCESS_PROJECT_DIR_PREFIXES, true);
    }
    // Windows 按 PATHEXT 为无扩展名的路径补 .cmd/.exe 等，执行的不是被绑定的文件。
    if (platform === "win32" && !extname(hook.command)) return undefined;
    return normalizeScriptPath(hook.command, PROCESS_PROJECT_DIR_PREFIXES, false);
  }
  // Windows 上 command 由 cmd.exe 解析：它把 / 当开关、先在 cwd 查找同名 .cmd/.bat、展开 %VAR%、
  // 把 , = 当分隔符。按字符规则逐条近似 cmd.exe 的做法反复被打穿，因此 Windows 上 command
  // 一律不识别入口，回到声明级信任；需要内容绑定时改用 process 写法。
  if (platform === "win32" || typeof hook.shell === "string") return undefined;
  // 只按 shell 默认分词的 ASCII 空格与 tab 切分：\s 会把换行、NBSP、全角空格、\v 当作分隔符
  // 吞掉，而 shell 并不按它们分词，绑定的文件与实际执行的文件会不同；它们留在 token 内后被
  // SAFE_COMMAND_TOKEN 拒绝。
  const tokens = hook.command.replace(/^[ \t]+|[ \t]+$/gu, "").split(/[ \t]+/u);
  if (
    tokens.some(
      (token) => !SAFE_COMMAND_TOKEN.test(stripPrefix(token, COMMAND_PROJECT_DIR_PREFIXES).rest),
    )
  ) {
    return undefined;
  }
  const [first, second] = tokens;
  if (first === undefined) return undefined;
  if (SCRIPT_INTERPRETERS.has(first)) {
    if (second === undefined || second.startsWith("-")) return undefined;
    return normalizeScriptPath(second, COMMAND_PROJECT_DIR_PREFIXES, true);
  }
  return normalizeScriptPath(first, COMMAND_PROJECT_DIR_PREFIXES, false);
}

/**
 * 读取入口脚本状态。路径直接拼接在 cwd 下，不做符号链接解析，与子进程打开文件的语义一致。
 * 只有普通文件且完整读完才是 file；取消、超时、超限和其他错误一律 unverifiable。
 */
export async function readWorkspaceHookScriptState(
  cwd: string,
  path: string,
  signal?: AbortSignal,
): Promise<WorkspaceHookScriptState> {
  if (signal?.aborted) return { kind: "unverifiable" };
  const absolutePath = join(cwd, path);
  try {
    // 先 stat 再打开：直接 open FIFO 会阻塞读取线程。
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) return { kind: "unverifiable" };
    const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      // 调用方已按截止时间放弃等待时，迟到的句柄直接关闭。
      if (signal?.aborted) return { kind: "unverifiable" };
      const opened = await handle.stat();
      if (!opened.isFile()) return { kind: "unverifiable" };
      const hash = createHash("sha256");
      let total = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
        total += (chunk as Buffer).length;
        if (total > MAX_SCRIPT_BYTES) return { kind: "unverifiable" };
        hash.update(chunk as Buffer);
      }
      if (signal?.aborted) return { kind: "unverifiable" };
      return { kind: "file", sha256: hash.digest("hex") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (!signal?.aborted && (code === "ENOENT" || code === "ENOTDIR")) return { kind: "missing" };
    return { kind: "unverifiable" };
  }
}

/**
 * 在 workspace 根目录下读取全部可识别入口的状态，按 reviewItemId 索引。
 * Settings、CLI Runtime、toggle 重建与 CLI trust 的异步入口都应经过本函数，才能得到同一份
 * digest；同步入口拿不到状态时不绑定内容（见 resolveWorkspaceHookEntries 的 scriptStates）。
 *
 * 未单测的部分与理由：5s 读取预算与 8 路并发上限没有用例。它们要靠注入挂起的 stat/open
 * 才能断言，而本包跑的是 node:test（没有 vitest 的模块 mock）；用 mock.module 需要给测试
 * 进程加 --experimental-test-module-mocks，那是仓库测试入口的统一开关，不该由单个用例私下
 * 打开。这两处逻辑逐字移植自上游（上游用 vitest 模块 mock 覆盖），这里不重复造测法。
 */
export async function readWorkspaceHookScriptStates(input: {
  workspacePath: string;
  sources: readonly WorkspaceHookSourceInput[];
}): Promise<Map<string, WorkspaceHookScriptState>> {
  const pathsById = new Map<string, string>();
  for (const [sourceFileIndex, source] of input.sources.entries()) {
    for (const event of WORKSPACE_HOOK_EVENT_NAMES) {
      for (const [matcherIndex, matcher] of (source.hooks.events?.[event] ?? []).entries()) {
        for (const [hookIndex, hook] of matcher.hooks.entries()) {
          const path = identifyWorkspaceHookScriptPath(hook);
          if (path === undefined) continue;
          pathsById.set(
            workspaceHookReviewItemId(sourceFileIndex, event, matcherIndex, hookIndex),
            path,
          );
        }
      }
    }
  }
  // stat/open 不响应取消信号，文件系统无响应时只发信号仍会无限等待，阻塞会话初始化与 Settings
  // 加载。这里让每个读取与截止时间竞争，到期即记为 unverifiable；迟到结果被忽略，迟到打开的
  // 句柄由 readWorkspaceHookScriptState 的 finally 关闭。
  const deadline = new AbortController();
  const unverifiable: WorkspaceHookScriptState = { kind: "unverifiable" };
  const expired = new Promise<WorkspaceHookScriptState>((resolve) => {
    deadline.signal.addEventListener("abort", () => resolve(unverifiable), { once: true });
  });
  const timer = setTimeout(() => deadline.abort(), DISCOVERY_READ_BUDGET_MS);
  try {
    const pending = [...new Set(pathsById.values())];
    const stateByPath = new Map<string, WorkspaceHookScriptState>();
    const worker = async () => {
      for (let path = pending.shift(); path !== undefined; path = pending.shift()) {
        // 截止时间到后，尚未开始的读取立即得到 unverifiable（signal 已 abort）。
        stateByPath.set(
          path,
          await Promise.race([
            readWorkspaceHookScriptState(input.workspacePath, path, deadline.signal),
            expired,
          ]),
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_SCRIPT_READS, pending.length) }, worker),
    );
    const states = new Map<string, WorkspaceHookScriptState>();
    for (const [id, path] of pathsById) states.set(id, stateByPath.get(path) ?? unverifiable);
    return states;
  } finally {
    clearTimeout(timer);
    // 结束后仍在进行的读取一并取消。
    deadline.abort();
  }
}

function normalizeScriptPath(
  value: string,
  prefixes: readonly string[],
  allowBareName: boolean,
): string | undefined {
  const { rest, matched } = stripPrefix(value, prefixes);
  if (!matched && !rest.includes("/")) {
    // 直接执行位置的裸名字走 PATH 查找，不是工作区文件。
    if (!allowBareName) return undefined;
    // 解释器后的无路径名字可能是子命令（node inspect x.js 加载的是 x.js），须带扩展名。
    if (!extname(rest)) return undefined;
  }
  // 脚本路径只接受最窄的字符集，不逐条排除 shell 元字符（$、\、:、=、,、@ 等都在集合外）：
  // KEY=val cmd 赋值前缀、Windows 盘符相对路径 C:x、NTFS 备用数据流等写法因此都不会被当作脚本。
  if (!SCRIPT_PATH_TOKEN.test(rest) || rest.startsWith("/")) return undefined;
  // 父目录段与符号链接的解析顺序可能改变实际目标，不做词法折叠，直接不识别。
  if (rest.split("/").includes("..")) return undefined;
  const normalized = posix.normalize(rest);
  return normalized === "." ? undefined : normalized;
}

function stripPrefix(
  value: string,
  prefixes: readonly string[],
): { rest: string; matched: boolean } {
  const prefix = prefixes.find((candidate) => value.startsWith(candidate));
  return prefix
    ? { rest: value.slice(prefix.length), matched: true }
    : { rest: value, matched: false };
}
