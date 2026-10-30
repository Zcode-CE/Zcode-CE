import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliTypecheckBuilds } from "./cli-workspace-builds.mjs";
import { runCommand } from "./spawn-command.mjs";

// CLI 各包的 exports 指向 dist，NodeNext 的 `tsc --noEmit` 必须先有依赖包的 dist。
// 这里复用 canonical 构建清单，逐包执行各包自己的 build（dynamic-workflow 的生成脚本
// 也因此由包脚本负责），最后只对 cli 做 --noEmit —— cli 的 tsconfig 没有 outDir。
//
// 前置：根 `pnpm typecheck` 已产出根 packages（@zcode/shared 等）的 dist；
// CI 与 verify:pre-push 都按这个顺序执行，不要在未跑根 typecheck 的裸检出上单独调用。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  // 与 build-desktop-agent-cli 同口径：子 workspace 的 run 不要触发 pnpm install。
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};

for (const { packageName } of cliTypecheckBuilds) {
  runCommand("pnpm", ["--filter", packageName, "build"], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
}

runCommand(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-b", "apps/zcode-cli/packages/cli", "--noEmit"],
  { cwd: repoRoot, env, stdio: "inherit" },
);
