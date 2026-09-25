#!/usr/bin/env node
/**
 * 把分发包 tarball 变成一个可以直接 `npm publish` 的 staging 目录（`dist/npm-stage/`）。
 *
 * 为什么需要它（每一条都是实测踩出来的，见 docs/operations/headless-server.md §7.1）：
 *
 * 1. **包根不是 `dist/zcode/`** —— 那是发布站点根（`install.sh` + `latest.json` +
 *    `releases/*.tar.gz`），而且 `build-zcode.mjs` 打完 tar 就删掉 `.work/`
 *    ⇒ `dist/zcode/` 下**不存在可直接 publish 的目录**，必须先解包。
 * 2. **包内原生 `package.json` 是 `private: true`** ⇒ `npm publish` 直接拒绝，必须整体覆盖。
 * 3. **`node_modules` 必须靠 `bundleDependencies` 进包** —— npm **无条件排除**包根
 *    `node_modules`，写进 `files` 或加 `.npmignore` 都无效（实测三种写法都进不去）。
 *    少了它的后果很隐蔽：服务会**先打印启动横幅再崩** `ERR_MODULE_NOT_FOUND`，
 *    只看横幅会误判发布成功。
 * 4. **`.map` 要排除**：`web/assets/` 下 2 279 个 sourcemap 占 tarball 16 MB。
 *
 * 用法：node scripts/stage-npm-package.mjs <tarball> [--out <dir>]
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

/** 包名与发布形态的唯一口径（见 docs/operations/headless-server.md §6-§7）。 */
const PACKAGE_NAME = "zcode-ce";
// 必须随包分发的顶层目录；末项排除 sourcemap（见文件头第 4 条）。
const PACKAGE_FILES = ["bin", "server", "agent", "web", "!**/*.map"];

function fail(message) {
  console.error(`[stage-npm-package] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { tarball: null, out: join(repoRoot, "dist", "npm-stage") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      args.out = resolve(argv[i + 1] ?? "");
      i += 1;
    } else if (!args.tarball) {
      args.tarball = resolve(arg);
    }
  }
  if (!args.tarball) fail("用法：node scripts/stage-npm-package.mjs <tarball> [--out <dir>]");
  if (!existsSync(args.tarball)) fail(`找不到 tarball：${args.tarball}`);
  return args;
}

/**
 * 从包内 `node_modules` 读出运行时依赖清单。
 *
 * 为什么从磁盘读而不是写死：依赖集合会随上游与我们的改动漂移，
 * 写死的清单会在某次依赖变更后静默失配 —— 而失配的表现是「服务起不来」，
 * 属于最难定位的一类。这里以**包内实际存在的目录**为准。
 */
function collectBundledDependencies(packageRoot) {
  const nodeModules = join(packageRoot, "node_modules");
  if (!existsSync(nodeModules))
    fail(`包内没有 node_modules：${nodeModules}（bundleDependencies 无从生成）`);
  const names = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(join(nodeModules, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) names.push(`${entry.name}/${scoped.name}`);
      }
      continue;
    }
    names.push(entry.name);
  }
  return names.sort();
}

function readDependencyVersions(packageRoot, names) {
  const versions = {};
  for (const name of names) {
    const manifestPath = join(packageRoot, "node_modules", name, "package.json");
    if (!existsSync(manifestPath)) fail(`依赖 ${name} 没有 package.json：${manifestPath}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.version !== "string" || !manifest.version) {
      fail(`依赖 ${name} 的 package.json 没有 version`);
    }
    versions[name] = manifest.version;
  }
  return versions;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1) 解包到 staging：tar 内顶层就是 `zcode/`，把它整体搬成 staging 根。
  const unpackDir = join(repoRoot, "dist", ".npm-unpack");
  rmSync(unpackDir, { recursive: true, force: true });
  mkdirSync(unpackDir, { recursive: true });
  execFileSync("tar", ["-xzf", args.tarball, "-C", unpackDir], { stdio: "inherit" });

  const packageRoot = join(unpackDir, "zcode");
  if (!existsSync(packageRoot)) fail(`tarball 内没有 zcode/ 顶层目录：${packageRoot}`);

  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private === true) {
    // 不是错误：这正是"必须整体覆盖"的原因，记一行让日志可追溯。
    console.log("[stage-npm-package] 包内 package.json 是 private:true，按预期整体覆盖");
  }
  if (typeof manifest.version !== "string" || !manifest.version) {
    fail("包内 package.json 没有 version（无法与 tag 对齐）");
  }

  const bundled = collectBundledDependencies(packageRoot);
  if (bundled.length === 0) fail("包内 node_modules 为空 ⇒ 发出去的包起不来");

  // 2) 覆盖 package.json（整体覆盖，不是合并 —— private:true 与缺失的 bin 都必须被替换掉）。
  const publishManifest = {
    name: PACKAGE_NAME,
    version: manifest.version,
    type: "module",
    description: "社区版（非官方）无头服务器 + Web 面板",
    license: "Apache-2.0",
    repository: "Zcode-CE/Zcode-CE",
    bin: { zcode: "bin/zcode.mjs" },
    files: PACKAGE_FILES,
    dependencies: readDependencyVersions(packageRoot, bundled),
    bundleDependencies: bundled,
    engines: { node: ">=24" },
  };
  writeFileSync(manifestPath, `${JSON.stringify(publishManifest, null, 2)}\n`);

  // 3) bin 入口自检：shebang 与可执行位（缺了装完跑不起来，而 npm 不会替我们检查）。
  const binPath = join(packageRoot, "bin", "zcode.mjs");
  if (!existsSync(binPath)) fail(`bin 入口不存在：${binPath}`);
  const binHead = readFileSync(binPath, "utf8").slice(0, 64);
  if (!binHead.startsWith("#!/usr/bin/env node"))
    fail("bin/zcode.mjs 首行缺少 #!/usr/bin/env node shebang");
  const mode = statSync(binPath).mode & 0o777;
  if ((mode & 0o111) === 0) fail(`bin/zcode.mjs 没有可执行位（当前 ${mode.toString(8)}）`);

  // 4) 落盘到 staging 根（`npm publish` 的 cwd）。
  rmSync(args.out, { recursive: true, force: true });
  mkdirSync(args.out, { recursive: true });
  cpSync(packageRoot, args.out, { recursive: true });
  rmSync(unpackDir, { recursive: true, force: true });

  console.log(`[stage-npm-package] ${PACKAGE_NAME}@${publishManifest.version} → ${args.out}`);
  console.log(
    `[stage-npm-package] bundleDependencies ${bundled.length} 个；bin 可执行位 ${mode.toString(8)}`,
  );
  console.log(
    "[stage-npm-package] 下一步：cd dist/npm-stage && npm publish --access public --tag next",
  );
}

main();
