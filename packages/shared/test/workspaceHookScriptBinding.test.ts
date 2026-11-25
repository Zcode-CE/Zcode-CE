import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import {
  buildWorkspaceHookBundleSnapshot,
  identifyWorkspaceHookScriptPath,
  readWorkspaceHookProjectSources,
  readWorkspaceHookScriptState,
  readWorkspaceHookScriptStates,
  resolveWorkspaceHookRuntimeRoot,
  workspaceHookReviewItemId,
  type WorkspaceHookDefinition,
  type WorkspaceHookSourceInput,
} from "@zcode/shared/workspace-hook-discovery";
import { writeWorkspaceHookConfiguredToggle } from "@zcode/shared/workspace-hook-mutation";

/**
 * 工作区 Hook 入口脚本内容绑定（D24 / ZP-20261110-06）的护栏。
 *
 * 为什么必须钉住：Trust 判定按 hookDeclarationDigest 匹配。digest 若不含入口脚本内容，
 * 「声明一字不改、只替换脚本」就能沿用旧 Trust 执行任意代码，且没有任何可见的信任状态变化。
 * 以下四组断言分别对应验收条件：内容变化必须换状态、替换脚本后旧记录不再匹配、
 * 缺失/不可读必须给出明确状态而不是静默信任、未变化时 digest 稳定不抖动，以及
 * 拿不到脚本状态的同步路径必须保持改动前的 digest（否则升级会让既有 Trust 一次性失效）。
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-hook-script-"));
  roots.push(root);
  await mkdir(join(root, ".git"), { recursive: true });
  return root;
}

async function writeHooks(workspace: string, hooks: WorkspaceHookDefinition[]): Promise<void> {
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeFile(
    join(workspace, ".zcode", "config.json"),
    JSON.stringify({ hooks: { enabled: true, events: { SessionStart: [{ hooks }] } } }),
    "utf8",
  );
}

async function workspaceSources(workspace: string): Promise<WorkspaceHookSourceInput[]> {
  const { sources } = await readWorkspaceHookProjectSources({ workingDirectory: workspace });
  return sources;
}

async function snapshotOf(workspace: string) {
  const sources = await workspaceSources(workspace);
  const scriptStates = await readWorkspaceHookScriptStates({ workspacePath: workspace, sources });
  const snapshot = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: workspace,
    workspacePath: workspace,
    sources,
    runtimeRoot: resolveWorkspaceHookRuntimeRoot(sources.map((source) => source.hooks)),
    scriptStates,
  });
  assert.ok(snapshot, "夹具应产出 snapshot");
  return snapshot;
}

const commandHook = (value: string, shell?: true | string): WorkspaceHookDefinition => ({
  type: "command",
  command: value,
  ...(shell === undefined ? {} : { shell }),
});

const processHook = (value: string, args?: string[]): WorkspaceHookDefinition => ({
  type: "process",
  command: value,
  ...(args === undefined ? {} : { args }),
});

const identifyCommand = (value: string, shell?: true | string) =>
  identifyWorkspaceHookScriptPath(commandHook(value, shell), "linux");

test("command 写法：解释器前缀、相对路径与引号内的项目目录变量都能识别", () => {
  const cases: Array<[string, string]> = [
    ["./scripts/x.sh", "scripts/x.sh"],
    ["scripts/x.sh --log=out.log", "scripts/x.sh"],
    ["bash .zcode/hook.sh", ".zcode/hook.sh"],
    ["node .zcode/audit.mjs --log=.zcode/audit.log", ".zcode/audit.mjs"],
    ["python3 tools/check.py arg", "tools/check.py"],
    ['"$CLAUDE_PROJECT_DIR"/hooks/x.sh', "hooks/x.sh"],
    ['bash "$ZCODE_PROJECT_DIR"/x.sh', "x.sh"],
    ["bash\tgood.sh\targ", "good.sh"],
  ];
  for (const [value, expected] of cases) {
    assert.equal(identifyCommand(value), expected, `${value} 应识别为 ${expected}`);
    assert.equal(
      identifyCommand(value, true),
      expected,
      `${value} 在 shell: true 下应识别为 ${expected}`,
    );
  }
});

test("command 写法：含 shell 元字符、绝对路径与 .. 段的一律不识别", () => {
  const cases = [
    "echo hello",
    "x.sh",
    "true",
    "cd scripts && ./x.sh",
    "./x.sh | tee out.log",
    "./x.sh > out.log",
    "bash -c ./x.sh",
    "node --experimental-strip-types x.ts",
    "python -m tool",
    "npx some-tool",
    "'./x.sh'",
    "./x.sh $(date)",
    "/abs/x.sh",
    "../x.sh",
    "bash ../x.sh",
    "./a/../x.sh",
    "${ZCODE_PROJECT_DIR}/../x.sh",
    "/bin/bash x.sh",
    "bash",
    "~/x.sh",
    ".\\x.ps1",
    "ENV=decoy/ok bash .zcode/h.sh",
    "PYTHONPATH=tools/lib python3 tools/check.py",
    "bash +x/h.sh",
    "bash a@b/h.sh",
  ];
  for (const value of cases) {
    assert.equal(identifyCommand(value), undefined, `${value} 不应识别出入口`);
  }
});

test("command 写法：换行与非 ASCII 空白不能被当作分隔符吞掉", () => {
  const cases = [
    "bash good.sh\nnode other.js",
    "bash good.sh\r\nnode other.js",
    "./good.sh\n",
    "bash .zcode/check.sh\u00a0run",
    "./.zcode/check.sh\u00a0",
    "bash\u3000good.sh",
    "bash good.sh\varg",
    "bash good.sh\farg",
  ];
  for (const value of cases) {
    assert.equal(identifyCommand(value), undefined, `${JSON.stringify(value)} 不应识别出入口`);
  }
});

test("command 写法：Windows 与自定义 shell 字符串不识别（回到声明级信任）", () => {
  for (const value of ["scripts/x.sh", "./x.sh", "node .zcode/h.js", "bash .zcode/hook.sh"]) {
    assert.equal(
      identifyWorkspaceHookScriptPath(commandHook(value), "win32"),
      undefined,
      `${value} 在 Windows 上不应识别出入口`,
    );
  }
  assert.equal(identifyCommand("./x.sh", "/bin/zsh"), undefined, "自定义 shell 字符串不应识别");
});

test("process 写法：解释器参数与直接执行位置都能识别，裸名字与 .. 不识别", () => {
  assert.equal(identifyWorkspaceHookScriptPath(processHook("bash", ["run.sh"]), "linux"), "run.sh");
  assert.equal(identifyWorkspaceHookScriptPath(processHook("./deploy.sh"), "linux"), "deploy.sh");
  // 裸名字走 PATH 查找，不是工作区文件，因此不识别。
  assert.equal(identifyWorkspaceHookScriptPath(processHook("x.sh"), "linux"), undefined);
  assert.equal(
    identifyWorkspaceHookScriptPath(processHook("${ZCODE_PROJECT_DIR}/scripts/x.sh"), "linux"),
    "scripts/x.sh",
  );
  assert.equal(
    identifyWorkspaceHookScriptPath(processHook("bash", ["${CLAUDE_PROJECT_DIR}/x.sh"]), "linux"),
    "x.sh",
  );
  // 解释器后的无路径名字可能是子命令（node inspect x.js 加载的是 x.js），必须带扩展名。
  assert.equal(identifyWorkspaceHookScriptPath(processHook("node", ["hook"]), "linux"), undefined);
  assert.equal(
    identifyWorkspaceHookScriptPath(processHook("node", ["inspect", "payload.js"]), "linux"),
    undefined,
  );
  assert.equal(identifyWorkspaceHookScriptPath(processHook("deploy"), "linux"), undefined);
  assert.equal(identifyWorkspaceHookScriptPath(processHook("git", ["status"]), "linux"), undefined);
  assert.equal(
    identifyWorkspaceHookScriptPath(processHook("node", ["../x.js"]), "linux"),
    undefined,
  );
  assert.equal(identifyWorkspaceHookScriptPath(processHook("/usr/bin/x"), "linux"), undefined);
  assert.equal(
    identifyWorkspaceHookScriptPath(processHook("node", ["C:hook.js"]), "linux"),
    undefined,
  );
});

test("process 写法：Windows 上补 PATHEXT 的无扩展名路径不识别", () => {
  assert.equal(
    identifyWorkspaceHookScriptPath(processHook("node", [".zcode/h.js"]), "win32"),
    ".zcode/h.js",
  );
  assert.equal(
    identifyWorkspaceHookScriptPath(processHook("./tools/check.exe"), "win32"),
    "tools/check.exe",
  );
  assert.equal(identifyWorkspaceHookScriptPath(processHook("./tools/check"), "win32"), undefined);
});

test("reviewItemId 的格式由单一函数维护", () => {
  assert.equal(
    workspaceHookReviewItemId(0, "SessionStart", 1, 2),
    "workspace-hook-0-SessionStart-1-2",
  );
});

test("readWorkspaceHookScriptState：普通文件记 sha256，缺失记 missing，目录/超限/取消记 unverifiable", async () => {
  const workspace = await makeWorkspace();
  const content = "echo one\n";
  await writeFile(join(workspace, "x.sh"), content, "utf8");
  await mkdir(join(workspace, "dir"));

  const state = await readWorkspaceHookScriptState(workspace, "x.sh");
  assert.deepEqual(state, {
    kind: "file",
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  assert.deepEqual(await readWorkspaceHookScriptState(workspace, "nope.sh"), { kind: "missing" });
  assert.deepEqual(await readWorkspaceHookScriptState(workspace, "x.sh/child"), {
    kind: "missing",
  });
  assert.deepEqual(await readWorkspaceHookScriptState(workspace, "dir"), { kind: "unverifiable" });

  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await readWorkspaceHookScriptState(workspace, "x.sh", aborted.signal), {
    kind: "unverifiable",
  });

  // 超过 MAX_SCRIPT_BYTES（16MiB）的文件不读取内容，直接 unverifiable：不能把半截内容当成完整脚本。
  const big = await open(join(workspace, "big.sh"), "w");
  await big.truncate(16 * 1024 * 1024 + 1);
  await big.close();
  assert.deepEqual(await readWorkspaceHookScriptState(workspace, "big.sh"), {
    kind: "unverifiable",
  });
});

test("readWorkspaceHookScriptState：无读权限记为 unverifiable 而不是信任", async () => {
  if (typeof process.getuid !== "function" || process.getuid() === 0) return;
  const workspace = await makeWorkspace();
  await writeFile(join(workspace, "x.sh"), "echo one\n", "utf8");
  await chmod(join(workspace, "x.sh"), 0o000);
  assert.deepEqual(await readWorkspaceHookScriptState(workspace, "x.sh"), {
    kind: "unverifiable",
  });
});

test("readWorkspaceHookScriptStates：按 reviewItemId 索引，只覆盖能识别入口的声明", async () => {
  const workspace = await makeWorkspace();
  await writeFile(join(workspace, "x.sh"), "echo one\n", "utf8");
  await writeFile(join(workspace, ".zcode-placeholder"), "", "utf8");
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeFile(
    join(workspace, ".zcode", "config.json"),
    JSON.stringify({
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [processHook("bash", ["x.sh"]), commandHook("echo hi")] }],
          Stop: [{ hooks: [processHook("bash", ["x.sh"])] }],
        },
      },
    }),
    "utf8",
  );

  const sources = await workspaceSources(workspace);
  const states = await readWorkspaceHookScriptStates({ workspacePath: workspace, sources });
  assert.deepEqual([...states.keys()].sort(), [
    "workspace-hook-0-SessionStart-0-0",
    "workspace-hook-0-Stop-0-0",
  ]);
  for (const state of states.values()) {
    assert.equal(state.kind, "file");
  }
});

test("① 只改入口脚本内容时 declaration digest 变化；只改非入口文件时不变", async () => {
  const workspace = await makeWorkspace();
  await writeHooks(workspace, [processHook("bash", [".zcode/hook.sh", "--log=.zcode/hook.log"])]);
  await writeFile(join(workspace, ".zcode", "hook.sh"), "echo one\n", "utf8");
  await writeFile(join(workspace, ".zcode", "hook.log"), "a\n", "utf8");

  const before = await snapshotOf(workspace);
  assert.equal(before.hooks[0]?.scriptEntry?.path, ".zcode/hook.sh");
  assert.equal(before.hooks[0]?.scriptEntry?.state.kind, "file");

  await writeFile(join(workspace, ".zcode", "hook.log"), "a\nb\n", "utf8");
  const dataChanged = await snapshotOf(workspace);
  assert.equal(
    dataChanged.hooks[0]?.hookDeclarationDigest,
    before.hooks[0]?.hookDeclarationDigest,
    "非入口数据文件变化不应影响 declaration digest",
  );

  await writeFile(join(workspace, ".zcode", "hook.sh"), "echo two\n", "utf8");
  const scriptChanged = await snapshotOf(workspace);
  assert.notEqual(
    scriptChanged.hooks[0]?.hookDeclarationDigest,
    before.hooks[0]?.hookDeclarationDigest,
    "入口脚本内容变化必须改变 declaration digest",
  );
  assert.notEqual(scriptChanged.bundleDigest, before.bundleDigest);
});

test("② 声明逐字节不变、只替换脚本时，旧 Trust 记录的 digest 不再匹配", async () => {
  const workspace = await makeWorkspace();
  const declaration = processHook("sh", ["scripts/deploy.sh"]);
  await writeHooks(workspace, [declaration]);
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await writeFile(join(workspace, "scripts", "deploy.sh"), "echo trusted\n", "utf8");

  const reviewed = await snapshotOf(workspace);
  const reviewedEntry = reviewed.hooks[0];
  assert.ok(reviewedEntry);
  // 模拟 Trust store：授予时记下的就是这一个 digest。
  const trustedDigests = new Set([reviewedEntry.hookDeclarationDigest]);

  // 声明 JSON 一字不改（连 enabled 都不动），只把脚本内容换成另一段等长文本。
  const configBefore = await readFile(join(workspace, ".zcode", "config.json"), "utf8");
  await writeFile(join(workspace, "scripts", "deploy.sh"), "echo evil!!!\n", "utf8");
  assert.equal(await readFile(join(workspace, ".zcode", "config.json"), "utf8"), configBefore);

  const afterSwap = await snapshotOf(workspace);
  const afterEntry = afterSwap.hooks[0];
  assert.ok(afterEntry);
  assert.notEqual(
    afterEntry.hookDeclarationDigest,
    reviewedEntry.hookDeclarationDigest,
    "脚本被替换后 digest 必须变化",
  );
  assert.equal(
    trustedDigests.has(afterEntry.hookDeclarationDigest),
    false,
    "旧 Trust 记录不得继续匹配被替换脚本的声明",
  );
  assert.notEqual(
    afterEntry.scriptEntry?.state.kind === "file" ? afterEntry.scriptEntry.state.sha256 : "",
    reviewedEntry.scriptEntry?.state.kind === "file" ? reviewedEntry.scriptEntry.state.sha256 : "",
  );
});

test("③ 脚本缺失或不可读给明确状态，且与任何可授权状态得到不同 digest", async () => {
  const workspace = await makeWorkspace();
  await writeHooks(workspace, [processHook("sh", ["scripts/x.sh"])]);

  const missing = await snapshotOf(workspace);
  assert.deepEqual(missing.hooks[0]?.scriptEntry, {
    path: "scripts/x.sh",
    state: { kind: "missing" },
  });

  await mkdir(join(workspace, "scripts"), { recursive: true });
  await writeFile(join(workspace, "scripts", "x.sh"), "echo hi\n", "utf8");
  const present = await snapshotOf(workspace);
  assert.equal(present.hooks[0]?.scriptEntry?.state.kind, "file");
  assert.notEqual(
    present.hooks[0]?.hookDeclarationDigest,
    missing.hooks[0]?.hookDeclarationDigest,
    "脚本出现后必须要求重新信任",
  );

  // 同名路径换成目录：不可读的入口按 unverifiable 处理，且不与 missing、file 共用 digest。
  await rm(join(workspace, "scripts", "x.sh"), { force: true });
  await mkdir(join(workspace, "scripts", "x.sh"));
  const unreadable = await snapshotOf(workspace);
  assert.deepEqual(unreadable.hooks[0]?.scriptEntry, {
    path: "scripts/x.sh",
    state: { kind: "unverifiable" },
  });
  assert.notEqual(
    unreadable.hooks[0]?.hookDeclarationDigest,
    missing.hooks[0]?.hookDeclarationDigest,
  );
  assert.notEqual(
    unreadable.hooks[0]?.hookDeclarationDigest,
    present.hooks[0]?.hookDeclarationDigest,
  );
});

/**
 * 金样取自引入内容绑定之前的实现（用 git show HEAD:<旧 workspace-hook-digest.ts> 的等价实现生成）：
 * 同步路径（拿到不到 scriptStates）不得改变 declaration digest，否则升级会把既有工作区钩子的
 * Trust 一次性全部失效，而那时内容绑定还没接线，等于白付代价。
 * 每条：[说明, 声明, 旧 declaration digest, 旧 bundle digest]。
 */
const SYNCHRONOUS_GOLD: Array<[string, WorkspaceHookDefinition, string, string]> = [
  [
    "process 解释器 + 脚本参数",
    { type: "process", command: "bash", args: ["hook.sh"] },
    "62de1139cc89a54eab91f3f1662d2cd734594d5ab9414240c91b4ad416e3b701",
    "7d0951f5ffd0b8c936ea1f5c3c04b1aa769f2374c8bf2157f6fb39610b19ca5b",
  ],
  [
    "command 解释器前缀",
    { type: "command", command: "bash .zcode/hook.sh" },
    "ae2d2f6a4dd63fafb9a30035505d29f1915051275e600f42f2ed5b039c056805",
    "68808a2da550a3427177e53b1d6acef1e123fe2ce6d6a0968726fc459e27f4ea",
  ],
  [
    "command 普通命令",
    { type: "command", command: "echo hi" },
    "f4b3c2997685fe1927249332c3a196ea09463828a2baae63881e8615d7cb1175",
    "27d461a06551bae1a3222e69778d1d84a3d51c9a5092550b7fc478d6bd181d26",
  ],
  [
    "command 识别不到入口的复合命令",
    { type: "command", command: "cd .zcode && ./hook.sh" },
    "d0ce9374df01b5638e035ef85aae0064cfc0dff9c9376f227ec87f042ca66e13",
    "8b1ed725e1f53ac79a0ace52a9bbbbe1460c53cf1321d523353e0a987a64fd72",
  ],
];

async function syncSnapshotOf(workspace: string) {
  const sources = await workspaceSources(workspace);
  const snapshot = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: workspace,
    workspacePath: workspace,
    sources,
    runtimeRoot: resolveWorkspaceHookRuntimeRoot(sources.map((source) => source.hooks)),
  });
  assert.ok(snapshot, "夹具应产出 snapshot");
  return snapshot;
}

test("同步路径（未提供 scriptStates）的 digest 与改动前逐字节相同", async () => {
  for (const [label, declaration, expectedDeclaration, expectedBundle] of SYNCHRONOUS_GOLD) {
    const workspace = await makeWorkspace();
    await writeHooks(workspace, [declaration]);
    const snapshot = await syncSnapshotOf(workspace);
    assert.equal(
      snapshot.hooks[0]?.scriptEntry,
      undefined,
      `${label}：同步路径不应携带 scriptEntry`,
    );
    assert.equal(
      snapshot.hooks[0]?.hookDeclarationDigest,
      expectedDeclaration,
      `${label}：declaration digest 必须与改动前相同`,
    );
    assert.equal(snapshot.bundleDigest, expectedBundle, `${label}：bundle digest 必须与改动前相同`);
  }
});

test("同步路径的 digest 与入口脚本是否存在、内容是否变化无关", async () => {
  const workspace = await makeWorkspace();
  const declaration = { type: "process", command: "bash", args: ["hook.sh"] } as const;
  await writeHooks(workspace, [declaration]);
  const gold = SYNCHRONOUS_GOLD[0]![2];
  assert.equal((await syncSnapshotOf(workspace)).hooks[0]?.hookDeclarationDigest, gold);

  await writeFile(join(workspace, "hook.sh"), "echo one\n", "utf8");
  assert.equal((await syncSnapshotOf(workspace)).hooks[0]?.hookDeclarationDigest, gold);

  await writeFile(join(workspace, "hook.sh"), "echo two！\n", "utf8");
  assert.equal((await syncSnapshotOf(workspace)).hooks[0]?.hookDeclarationDigest, gold);
});

test("提供 scriptStates 且脚本内容变化 ⇒ digest 变化，且都不同于同步路径金样", async () => {
  const workspace = await makeWorkspace();
  const declaration = { type: "process", command: "bash", args: ["hook.sh"] } as const;
  await writeHooks(workspace, [declaration]);
  const gold = SYNCHRONOUS_GOLD[0]![2];

  await writeFile(join(workspace, "hook.sh"), "echo one\n", "utf8");
  const first = await snapshotOf(workspace);
  await writeFile(join(workspace, "hook.sh"), "echo two！\n", "utf8");
  const second = await snapshotOf(workspace);

  assert.notEqual(
    first.hooks[0]?.hookDeclarationDigest,
    second.hooks[0]?.hookDeclarationDigest,
    "内容变化必须改变 digest",
  );
  assert.notEqual(first.hooks[0]?.hookDeclarationDigest, gold);
  assert.notEqual(second.hooks[0]?.hookDeclarationDigest, gold);
});

test("已声明绑定内容却查不到该 reviewItemId 时记 unverifiable，不退回声明级摘要", async () => {
  const workspace = await makeWorkspace();
  const declaration = { type: "process", command: "bash", args: ["hook.sh"] } as const;
  await writeHooks(workspace, [declaration]);
  await writeFile(join(workspace, "hook.sh"), "echo one\n", "utf8");
  const sources = await workspaceSources(workspace);
  const snapshot = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: workspace,
    workspacePath: workspace,
    sources,
    runtimeRoot: resolveWorkspaceHookRuntimeRoot(sources.map((source) => source.hooks)),
    scriptStates: new Map(),
  });
  assert.ok(snapshot);
  assert.deepEqual(snapshot.hooks[0]?.scriptEntry, {
    path: "hook.sh",
    state: { kind: "unverifiable" },
  });
  assert.notEqual(snapshot.hooks[0]?.hookDeclarationDigest, SYNCHRONOUS_GOLD[0]![2]);
});

test("④ 入口未变化时 digest 稳定不抖动；识别不到入口的声明不受影响", async () => {
  const workspaceA = await makeWorkspace();
  await writeHooks(workspaceA, [processHook("bash", ["run.sh"])]);
  await writeFile(join(workspaceA, "run.sh"), "echo stable\n", "utf8");

  const first = await snapshotOf(workspaceA);
  const second = await snapshotOf(workspaceA);
  assert.deepEqual(second.hooks[0]?.scriptEntry, first.hooks[0]?.scriptEntry);
  assert.equal(second.hooks[0]?.hookDeclarationDigest, first.hooks[0]?.hookDeclarationDigest);
  assert.equal(second.bundleDigest, first.bundleDigest, "未变化时 bundle digest 不应抖动");

  // 识别不到入口（cd 前缀）的声明没有 scriptEntry，digest 与不读脚本时逐字节相同。
  const workspaceB = await makeWorkspace();
  await writeHooks(workspaceB, [commandHook("cd .zcode && ./hook.sh")]);
  const sourcesB = await workspaceSources(workspaceB);
  const runtimeRootB = resolveWorkspaceHookRuntimeRoot(sourcesB.map((source) => source.hooks));
  const withStatesB = await snapshotOf(workspaceB);
  const withoutStatesB = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: workspaceB,
    workspacePath: workspaceB,
    sources: sourcesB,
    runtimeRoot: runtimeRootB,
  });
  assert.ok(withoutStatesB);
  assert.equal(withStatesB.hooks[0]?.scriptEntry, undefined);
  assert.equal(
    withStatesB.hooks[0]?.hookDeclarationDigest,
    withoutStatesB.hooks[0]?.hookDeclarationDigest,
  );
});

test("toggle 重建沿用在审的脚本状态：声明未变时写入成功，声明被改后拒绝", async () => {
  const workspace = await makeWorkspace();
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await writeFile(join(workspace, "scripts", "hook.sh"), "echo one\n", "utf8");
  await writeHooks(workspace, [processHook("bash", ["scripts/hook.sh"])]);

  const snapshot = await snapshotOf(workspace);
  const entry = snapshot.hooks[0];
  assert.ok(entry);
  assert.equal(entry.scriptEntry?.path, "scripts/hook.sh");

  const configPath = resolve(workspace, ".zcode", "config.json");
  await writeWorkspaceHookConfiguredToggle({
    configPath,
    snapshot,
    reviewItemId: entry.reviewItemId,
    enabled: false,
  });
  const written = JSON.parse(await readFile(configPath, "utf8")) as {
    hooks: { events: { SessionStart: Array<{ hooks: Array<{ enabled?: boolean }> }> } };
  };
  assert.equal(written.hooks.events.SessionStart[0]?.hooks[0]?.enabled, false);

  // 在审之后声明本体被第三方改动：仍必须按 snapshot mismatch 拒绝，而不是沿用旧记录。
  const tampered = JSON.parse(await readFile(configPath, "utf8")) as {
    hooks: { events: { SessionStart: Array<{ hooks: Array<Record<string, unknown>> }> } };
  };
  tampered.hooks.events.SessionStart[0]!.hooks[0]!.args = ["scripts/other.sh"];
  await writeFile(configPath, JSON.stringify(tampered), "utf8");
  await assert.rejects(
    writeWorkspaceHookConfiguredToggle({
      configPath,
      snapshot,
      reviewItemId: entry.reviewItemId,
      enabled: true,
    }),
    (error: unknown) => (error as { code?: string }).code === "workspace_hooks_snapshot_mismatch",
  );
});

test("同步路径快照（无 scriptEntry）仍可通过 toggle 的声明重算校验", async () => {
  const workspace = await makeWorkspace();
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await writeFile(join(workspace, "scripts", "hook.sh"), "echo one\n", "utf8");
  await writeHooks(workspace, [processHook("bash", ["scripts/hook.sh"])]);

  const snapshot = await syncSnapshotOf(workspace);
  const entry = snapshot.hooks[0];
  assert.ok(entry);
  assert.equal(entry.scriptEntry, undefined);

  const configPath = resolve(workspace, ".zcode", "config.json");
  await writeWorkspaceHookConfiguredToggle({
    configPath,
    snapshot,
    reviewItemId: entry.reviewItemId,
    enabled: false,
  });
  const written = JSON.parse(await readFile(configPath, "utf8")) as {
    hooks: { events: { SessionStart: Array<{ hooks: Array<{ enabled?: boolean }> }> } };
  };
  assert.equal(written.hooks.events.SessionStart[0]?.hooks[0]?.enabled, false);
});
