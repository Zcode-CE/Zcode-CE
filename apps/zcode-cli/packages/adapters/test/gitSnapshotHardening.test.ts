import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { resolveGitSnapshot } from "../src/context/git-snapshot.js";

/**
 * C-10（3.17.2 移植）：自动 git 的加固。
 *
 * 为什么必须钉住（两条都是真实攻击面，不是洁癖）：
 * 1. 仓库配置里的 `core.fsmonitor` 是一段由仓库提供的可执行文件；不加固时 `git status` 会直接跑它，
 *    等于打开一个克隆来的仓库就执行了它的代码。加固后自动 git 用固定的配置覆盖执行，不再运行它。
 * 2. 继承来的 `GIT_DIR` 会把快照指向另一个仓库：Agent 在 A 仓库里工作，公告与 diff 却来自 B。
 *
 * 用真实 git 验证（而不是 mock 参数）：这两条的价值就在于「实际没有执行」与「实际读的是本目录仓库」。
 * 无 git 或 Windows 上跳过——Windows 下 fsmonitor 的行为差异大，上游同样跳过。
 *
 * 运行：cd apps/zcode-cli/packages/adapters && node --import tsx --test test/gitSnapshotHardening.test.ts
 */

const execFile = promisify(execFileCallback);

async function gitAvailable(): Promise<boolean> {
  try {
    await execFile("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, env: env ?? process.env });
  return stdout.trim();
}

const runnable = process.platform !== "win32" && (await gitAvailable());

const describe = runnable ? test : test.skip;

describe("automatic git hardening with a real git", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zcode-git-hardening-")));
  const repo = join(root, "repo");
  const otherRepo = join(root, "other");
  const marker = join(root, "fsmonitor-ran");
  for (const [directory, branch] of [
    [repo, "alpha"],
    [otherRepo, "beta"],
  ] as const) {
    await mkdir(directory, { recursive: true });
    await git(directory, ["init", "-q"]);
    await git(directory, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  }
  const script = join(root, "fsmonitor.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  await chmod(script, 0o755);
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["config", "core.fsmonitor", script]);

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await t.test("不执行仓库配置的 fsmonitor 程序", async (context) => {
    await rm(marker, { force: true });
    // 对照：不加固的 git status 会执行仓库配置的 fsmonitor。不执行时这条测不了，跳过。
    await git(repo, ["status", "--short"]).catch(() => "");
    if (!existsSync(marker)) {
      context.skip("this git does not run core.fsmonitor");
      return;
    }
    await rm(marker, { force: true });

    const snapshot = await resolveGitSnapshot(repo);
    assert.equal(snapshot?.isGitRepository, true);
    assert.equal(snapshot?.gitBranch, "alpha");
    assert.deepEqual(snapshot?.gitStatusLines, ["A  a.txt"]);
    assert.equal(existsSync(marker), false);
  });

  await t.test("继承来的 GIT_DIR 不能把快照指向另一个仓库", async () => {
    const inherited = { ...process.env, GIT_DIR: join(otherRepo, ".git") };
    // 对照：带着继承的 GIT_DIR，裸 git 读的是另一个仓库。
    assert.equal(await git(repo, ["symbolic-ref", "--short", "-q", "HEAD"], inherited), "beta");
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = inherited.GIT_DIR;
    try {
      assert.equal((await resolveGitSnapshot(repo))?.gitBranch, "alpha");
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});
