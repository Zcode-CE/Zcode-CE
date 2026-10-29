import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNodeCustomCommandAdapter } from "../src/commands/index.js";
import { createNodeSkillAdapter } from "../src/skills/index.js";
import { resolveDefaultCustomCommandRoots } from "../src/commands/roots.js";
import { resolveDefaultSkillRoots } from "../src/skills/roots.js";

/**
 * 上游 3.16.2 X16：附加目录必须进入能力发现（自定义命令 / 技能），不只是进入环境 prompt。
 *
 * 断言打在最终消费点 `discoverCommands` / `discoverSkills` 的结果上，而不是 root 数组：
 * root 造对了但扫描顺序/去重错了，用户看到的仍然是"命令不在面板里"。
 * 产品规则与协议见 .local/reports/upstream/version-3.16.2/X16-CLI-SPEC.md。
 *
 * 运行：cd apps/zcode-cli/packages/adapters && node --import tsx --test test/additionalDirectoriesRoots.test.ts
 * 注意：本地直接跑要装源码解析钩子（CI 上由 pnpm test 统一装）：
 *   node --import tsx --import ../../../../packages/services/test/support/zcodeSourceResolver.mjs --test <file>
 */

async function withWorkspace<T>(
  run: (paths: { app: string; backend: string; home: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "x16-roots-"));
  const app = join(root, "app");
  const backend = join(root, "backend");
  const home = join(root, "home");
  try {
    await mkdir(app, { recursive: true });
    await mkdir(home, { recursive: true });
    // 附加目录下的原生 + 兼容两套命令/技能目录，证明两条 root 都被扫到。
    await mkdir(join(backend, ".zcode", "commands"), { recursive: true });
    await mkdir(join(backend, ".agents", "commands"), { recursive: true });
    await mkdir(join(backend, ".zcode", "skills", "extra-skill"), { recursive: true });
    await writeFile(join(backend, ".zcode", "commands", "deploy.md"), "Deploy the app.\n");
    await writeFile(join(backend, ".agents", "commands", "review.md"), "Review the diff.\n");
    await writeFile(join(backend, ".zcode", "skills", "extra-skill", "SKILL.md"), "# Extra\n");
    return await run({ app, backend, home });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("判据 1：附加目录的命令与技能被真正发现（含 .zcode 与 .agents 两套目录）", async () => {
  await withWorkspace(async ({ app, backend, home }) => {
    const commands = createNodeCustomCommandAdapter({
      additionalDirectories: [backend],
      homeDirectory: home,
    });
    const commandOutcome = await commands.discoverCommands({ workingDirectory: app });
    const names = commandOutcome.commands.map((command) => command.name).sort();
    assert.deepEqual(names, ["deploy", "review"]);
    for (const command of commandOutcome.commands) {
      assert.equal(command.scope, "project");
      assert.equal(command.rootPath.startsWith(resolve(backend)), true, command.rootPath);
    }

    const skills = createNodeSkillAdapter({
      additionalDirectories: [backend],
      homeDirectory: home,
    });
    const skillOutcome = await skills.discoverSkills({ workingDirectory: app });
    const extra = skillOutcome.skills.find((skill) => skill.name === "extra-skill");
    assert.ok(extra, "附加目录的技能必须进入发现结果");
    assert.equal(extra.scope, "project");
    assert.equal(extra.rootPath, resolve(backend, ".zcode", "skills"));
  });
});

test("判据 2：无附加目录时行为与改动前一致（回归）", async () => {
  await withWorkspace(async ({ app, home }) => {
    const commands = createNodeCustomCommandAdapter({ homeDirectory: home });
    const commandOutcome = await commands.discoverCommands({ workingDirectory: app });
    assert.deepEqual(commandOutcome.commands, []);

    const skills = createNodeSkillAdapter({ homeDirectory: home });
    const skillOutcome = await skills.discoverSkills({ workingDirectory: app });
    assert.deepEqual(skillOutcome.skills, []);
  });
});

test("判据 3：与主 workspace 相同的目录 / 重复目录不产生重复 root", async () => {
  await withWorkspace(async ({ app, backend, home }) => {
    const option = { extraRoots: [], homeDirectory: home, includeZcodeCommands: true };
    const baseline = await resolveDefaultCustomCommandRoots(app, option);
    const withDuplicate = await resolveDefaultCustomCommandRoots(app, {
      ...option,
      additionalDirectories: [backend, backend, app],
    });
    const added = withDuplicate.slice(baseline.length);
    // 每个附加目录贡献 .zcode + .agents 两个 root；重复项与主 workspace 自身都不追加。
    assert.deepEqual(
      added.map((root) => root.path),
      [resolve(backend, ".zcode", "commands"), resolve(backend, ".agents", "commands")],
    );

    const skillBaseline = await resolveDefaultSkillRoots(app, { homeDirectory: home });
    const skillWithDuplicate = await resolveDefaultSkillRoots(app, {
      additionalDirectories: [backend, backend, app],
      homeDirectory: home,
    });
    assert.deepEqual(
      skillWithDuplicate.slice(skillBaseline.length).map((root) => root.path),
      [resolve(backend, ".zcode", "skills"), resolve(backend, ".agents", "skills")],
    );
  });
});
