/**
 * adb 边界：只允许工作区外的可执行文件，放行后固定到 canonical 绝对路径。
 *
 * 根因（上游 4.0.0 `bash.ts:602` / `execution.port.ts:307`）：禁用 adb 曾按命令名匹配，
 * 工作区里放一个 adb 就能被执行；而完全禁名又会误伤合法 SDK。现在的规则按位置判定：
 * 词法候选与 realpath 都必须在工作区之外，命中后替换成 canonical 路径，Shell 不再做
 * 第二次查找。三条断言：工作区 adb 被拒且原因可诊断、系统 adb 放行并固定路径、
 * 非 adb 命令逐字节不变。
 *
 * 运行：cd apps/zcode-cli/packages/core && \
 *   mise exec node@24.14.0 -- node --import tsx --test test/bashAdbAdmission.test.ts
 */

import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  CoreErrorType,
  createSessionId,
  createToolCallId,
  createTraceId,
  type AdbExecutableRequest,
  type AdbExecutableResolution,
  type ExecutionPort,
  type ExecutionRequest,
  type ExecutionShellSelection,
} from "@zcode/contracts";
import { NodeExecutionAdapter } from "../../adapters/src/exec/node-execution-adapter.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

const bashHandler = bashToolEntry.handler;

function selection(dialect: ExecutionShellSelection["dialect"]): ExecutionShellSelection {
  return { dialect, source: "user-config", display: { name: dialect } };
}

function context(
  executionPort: ExecutionPort,
  cwd: string,
  shell: ExecutionShellSelection,
): ToolExecutionContext {
  return {
    toolCallId: createToolCallId("adb-admission"),
    traceId: createTraceId(),
    abortSignal: new AbortController().signal,
    executionPort,
    workingDirectory: cwd,
    workspaceRoot: cwd,
    sessionId: createSessionId("adb-admission"),
    bashShellSelection: shell,
  };
}

/** 记录 resolve 入参并让执行阶段立刻抛出哨兵错误：用来区分「被拦下」与「真的跑起来了」。 */
function fakePort(result: AdbExecutableResolution) {
  const reached = new Error("execution reached");
  const requests: ExecutionRequest[] = [];
  const resolutions: AdbExecutableRequest[] = [];
  const port: ExecutionPort = {
    resolveAdbExecutable: async (request) => {
      resolutions.push(request);
      return result;
    },
    run: async (request) => {
      requests.push(request);
      throw reached;
    },
  };
  return { port, requests, resolutions, reached };
}

function capturedCommand(request: ExecutionRequest | undefined): string | undefined {
  const command = request?.command;
  return command?.mode === "shell" ? command.command : undefined;
}

/** 工作区内的 adb 必须在启动 shell 之前被拒，且原因可诊断（不是笼统的权限失败）。 */
const WORKSPACE_INVOCATIONS: ReadonlyArray<[ExecutionShellSelection["dialect"], string]> = [
  ["posix", "adb devices"],
  ["posix", "./adb devices"],
  ["posix", "tools/adb devices"],
  ["posix", "echo before && ./adb devices"],
  ["posix", "./adb devices | cat"],
  ["posix", "ADB_TRACE=all adb devices"],
  ["posix", "env -u HOME adb devices"],
  ["posix", "sudo -u developer /opt/sdk/adb devices"],
  ["posix", "time -p adb devices"],
  ["posix", "command -- adb devices"],
  ["posix", "exec ./adb.exe devices"],
  ["git-bash", "./ADB.EXE devices"],
  ["legacy-shell", "./adb devices"],
];

test("工作区 adb 被拒：前台与后台都给出 workspace-adb-blocked", async () => {
  for (const [dialect, command] of WORKSPACE_INVOCATIONS) {
    for (const run_in_background of [false, true]) {
      const fake = fakePort({ status: "workspace" });
      const error = await bashHandler(
        { command, run_in_background },
        context(fake.port, process.cwd(), selection(dialect)),
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      const core = error as { type?: string; message?: string; context?: { reason?: string } };
      assert.equal(core?.type, CoreErrorType.PermissionDenied, dialect + " 应被拒：" + command);
      assert.equal(core?.context?.reason, "workspace-adb-blocked", command);
      assert.match(core?.message ?? "", /Workspace-controlled adb/, command);
      assert.equal(fake.resolutions.length, 1, command);
      assert.equal(fake.requests.length, 0, "被执行了：" + command);
    }
  }
});

test("缺少工作区外 adb 时报 adb-not-found，不静默回退到工作区", async () => {
  const fake = fakePort({ status: "missing" });
  const error = await bashHandler(
    { command: "adb devices" },
    context(fake.port, process.cwd(), selection("posix")),
  ).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  const core = error as { type?: string; context?: { reason?: string } };
  assert.equal(core?.type, CoreErrorType.ConfigurationError);
  assert.equal(core?.context?.reason, "adb-not-found");
  assert.equal(fake.requests.length, 0);
});

/** 系统 adb 放行后必须固定成 canonical 绝对路径，Shell 不能再按名字查找。 */
const PINNED: ReadonlyArray<[ExecutionShellSelection["dialect"], string, string, string, string]> =
  [
    ["posix", "/opt/Android SDK/adb", "adb", "adb devices", "'/opt/Android SDK/adb' devices"],
    [
      "posix",
      "/opt/Android SDK/adb",
      "./adb",
      "echo ok && ./adb devices",
      "echo ok && '/opt/Android SDK/adb' devices",
    ],
    [
      "posix",
      "/opt/Android SDK/adb",
      "adb",
      "env ADB_TRACE=all adb devices",
      "env ADB_TRACE=all '/opt/Android SDK/adb' devices",
    ],
    ["posix", "/opt/Android SDK/adb", "adb", "command adb -v", "command '/opt/Android SDK/adb' -v"],
    [
      "legacy-shell",
      "/opt/Android SDK/adb",
      "adb",
      "adb devices",
      "'/opt/Android SDK/adb' devices",
    ],
    [
      "git-bash",
      "C:\\Android SDK\\adb.exe",
      "C:/SDK/adb.exe",
      '"C:/SDK/adb.exe" devices',
      "'C:/Android SDK/adb.exe' devices",
    ],
    ["posix", "/opt/it's/adb", "adb", "adb devices", "'/opt/it'\\''s/adb' devices"],
  ];

test("系统 adb 放行并替换为已校验路径", async () => {
  for (const [dialect, resolvedPath, file, command, expected] of PINNED) {
    const fake = fakePort({ status: "resolved", path: resolvedPath });
    const ctx = context(fake.port, process.cwd(), selection(dialect));
    await assert.rejects(bashHandler({ command }, ctx), fake.reached);
    assert.equal(capturedCommand(fake.requests[0]), expected, command);
    assert.deepEqual(fake.resolutions[0], {
      file,
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    });
  }
});

/** 非 adb 命令（含引号、注释、heredoc 里的 adb 文本）逐字节不变，也不触发解析。 */
const UNCHANGED: ReadonlyArray<[ExecutionShellSelection["dialect"], string]> = [
  ["posix", "echo adb ./adb.exe"],
  ["posix", "command -v adb"],
  ["posix", "# adb devices\nprintf ok"],
  ["posix", "./gradlew assembleDebug"],
  ["posix", "pnpm build"],
  ["posix", 'git commit -m "fix adb devices"'],
  ["posix", "cat <<'EOF' > note.txt\nadb devices\nEOF"],
  ["posix", "@adb.exe devices"],
  ["git-bash", "@adb.exe devices"],
  ["cmd", "@node scripts/build.js"],
  ["cmd", "@pnpm build"],
  ["cmd", "@call gradlew.bat assembleDebug"],
  ["cmd", "@echo @adb.exe"],
];

test("非 adb 命令逐字节不变", async () => {
  for (const [dialect, command] of UNCHANGED) {
    const fake = fakePort({ status: "resolved", path: "/opt/Android SDK/adb" });
    await assert.rejects(
      bashHandler({ command }, context(fake.port, process.cwd(), selection(dialect))),
      fake.reached,
      dialect + ": " + command,
    );
    assert.equal(capturedCommand(fake.requests[0]), command);
    assert.equal(fake.resolutions.length, 0, "不该解析 adb：" + command);
  }
});

const IS_WINDOWS = process.platform === "win32";
const ADB_NAME = IS_WINDOWS ? "adb.exe" : "adb";

/** 真实适配器：工作区里的伪 adb 被拒，SDK/PATH 里的外部 adb 放行并固定成 realpath。 */
test("真实适配器：只放行工作区外的 adb，且固定到 canonical 路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-adb-boundary-"));
  const workspace = join(root, "project with spaces");
  const sdk = join(root, "Android SDK");
  const platformTools = join(sdk, "platform-tools");
  const external = join(root, "bin");
  const marker = join(root, "fake-executed");
  await mkdir(workspace);
  await mkdir(platformTools, { recursive: true });
  await mkdir(external);
  const fake = join(workspace, ADB_NAME);
  const trusted = join(platformTools, ADB_NAME);
  // 伪 adb 一旦被执行就会留下标记文件；脚本不读环境变量，避免测试受 shell 差异影响。
  await writeFile(fake, IS_WINDOWS ? "fake" : "#!/bin/sh\nprintf executed > " + marker + "\n");
  await writeFile(trusted, IS_WINDOWS ? "trusted" : "#!/bin/sh\nprintf trusted-adb-ok\n");
  if (!IS_WINDOWS) {
    await chmod(fake, 0o755);
    await chmod(trusted, 0o755);
  }
  const adapter = new NodeExecutionAdapter({
    processEnv: {
      HOME: root,
      USERPROFILE: root,
      PATH: [workspace, ".", "relative", external].join(delimiter),
    },
  });
  try {
    const input = { cwd: workspace, workspaceRoot: workspace };
    // ① 工作区内的词法候选一律拒：相对、绝对、带 .. 的路径都先做位置判定。
    assert.deepEqual(
      await adapter.resolveAdbExecutable({ ...input, file: "./" + ADB_NAME }),
      { status: "workspace" },
      "相对路径 ./adb",
    );
    assert.deepEqual(
      await adapter.resolveAdbExecutable({ ...input, file: join(workspace, ADB_NAME) }),
      { status: "workspace" },
      "工作区绝对路径",
    );
    assert.deepEqual(
      await adapter.resolveAdbExecutable({ ...input, file: "sub/../" + ADB_NAME }),
      { status: "workspace" },
      "未规范化的相对路径",
    );
    // ② 裸 adb 不允许落到 cwd、"." 或相对 PATH 条目上。
    assert.deepEqual(
      await adapter.resolveAdbExecutable({ ...input, file: ADB_NAME }),
      { status: "workspace" },
      "PATH 只剩工作区",
    );
    const noPath = new NodeExecutionAdapter({
      processEnv: { HOME: root, USERPROFILE: root, PATH: "" },
    });
    try {
      assert.deepEqual(await noPath.resolveAdbExecutable({ ...input, file: ADB_NAME }), {
        status: "missing",
      });
    } finally {
      await noPath.close();
    }
    // ③ ANDROID_HOME/platform-tools 优先于 PATH，返回 canonical 路径。
    const withSdk = new NodeExecutionAdapter({
      processEnv: { HOME: root, USERPROFILE: root, ANDROID_HOME: sdk, PATH: workspace },
    });
    try {
      assert.deepEqual(await withSdk.resolveAdbExecutable({ ...input, file: ADB_NAME }), {
        status: "resolved",
        path: await realpath(trusted),
      });
    } finally {
      await withSdk.close();
    }
    if (!IS_WINDOWS) {
      // ④ 符号链接按 realpath 判定：指向工作区内的仍被拒，指向外部 SDK 的放行。
      await symlink(fake, join(external, ADB_NAME));
      assert.deepEqual(
        await adapter.resolveAdbExecutable({ ...input, file: join(external, ADB_NAME) }),
        { status: "workspace" },
        "符号链接指向工作区内",
      );
      await rm(join(external, ADB_NAME));
      await symlink(trusted, join(external, ADB_NAME));
      assert.deepEqual(
        await adapter.resolveAdbExecutable({ ...input, file: join(external, ADB_NAME) }),
        { status: "resolved", path: await realpath(trusted) },
        "符号链接指向外部 SDK",
      );
      // ⑤ 端到端：伪 adb 被拒且从未执行；外部 adb 真的跑起来并输出它自己的标记。
      const ctx = context(adapter, workspace, selection("posix"));
      const blocked = await bashHandler({ command: "./adb devices" }, ctx).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      assert.equal(
        (blocked as { context?: { reason?: string } })?.context?.reason,
        "workspace-adb-blocked",
      );
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      const output = await bashHandler({ command: "adb devices" }, ctx);
      assert.equal(output.exitCode, 0);
      assert.match(output.stdout, /trusted-adb-ok/);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    }
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});
