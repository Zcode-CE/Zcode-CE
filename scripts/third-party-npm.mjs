import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { resolveSpawnRuntimeOptions } from "./spawn-command.mjs";

const exec = promisify(execFile);
export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
// 原生二进制包按平台分发，每个平台一个包。pnpm 只会安装**当前平台**的那一个，
// 其余平台包虽然出现在 lockfile 的生产依赖图里，但永远不会被安装。
//
// 历史：这条豁免最初只硬编码 @napi-rs/canvas 的 3 个平台，在 linux-x64 上必然失败；
// 后来改成按 @napi-rs/canvas- 前缀动态判断，但判据仍然只认这一个包名前缀。
// 新增 @ubjs/* 这类同样按平台分发的依赖后，同一类"平台包缺失"再次被误报成缺依赖 ——
// 根因是判据绑定在包名上，而问题本质与包名无关。
//
// 现在改为**与包名无关的通用规则**：识别包名结尾的平台标签，与当前平台比对。
//
// 安全边界（必须保持）：**当前平台**的变体绝不免除。否则真正缺了当前平台的原生包
// 也会被静默放过，而这条检查的全部价值就在于拦住那种情况。
const PLATFORM_VARIANT_SUFFIX =
  /(?:^|-)(darwin|linux|win32|android|freebsd|openbsd|netbsd|sunos|aix)-(x64|ia32|arm64|arm|armv7l|armhf|riscv64|loong64|s390x|ppc64le|ppc64|mips64el|universal)(?:-(gnu|musl|msvc|gnueabihf|android|eabi|eabihf))?$/u;

/** 包名结尾的平台标签；不是平台变体包时返回 undefined。 */
export function platformVariantTagOf(name) {
  const match = PLATFORM_VARIANT_SUFFIX.exec(name);
  if (!match) return undefined;
  const [, os, arch, abi] = match;
  return abi === undefined ? `${os}-${arch}` : `${os}-${arch}-${abi}`;
}

/**
 * 当前平台的标签集合（可能不止一个写法）。
 *
 * 无 abi 后缀的 `linux-<arch>` 在 npm 生态里指 glibc（esbuild 等包如此命名），
 * 所以 glibc 环境下它也算当前平台；musl 环境不算 —— 否则会把 musl 包误当成当前平台。
 */
export function currentPlatformVariantTags() {
  const arch = process.arch;
  switch (process.platform) {
    case "darwin":
      return new Set([`darwin-${arch}`]);
    case "win32":
      return new Set([`win32-${arch}-msvc`, `win32-${arch}`]);
    case "linux": {
      const isGnu = process.report?.getReport()?.header?.glibcVersionRuntime !== undefined;
      const tags = new Set([`linux-${arch}-${isGnu ? "gnu" : "musl"}`]);
      if (isGnu) tags.add(`linux-${arch}`);
      return tags;
    }
    default:
      return new Set([`${process.platform}-${arch}`]);
  }
}

/**
 * 该包是否属于**其他平台**的变体（因此允许未安装）。
 *
 * 只在包**缺失**时被调用：当前平台的变体仍会走到报错分支。
 */
export function isForeignPlatformVariant(name, currentTags = currentPlatformVariantTags()) {
  const tag = platformVariantTagOf(name);
  if (tag === undefined) return false;
  return !currentTags.has(tag);
}

const noticeName =
  /(?:^|[._-])(?:licen[sc]es?|copying|notice|copyright|unlicense|third.party|ofl)(?:[._-]|$)/iu;

export async function readPackageNotices(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (["node_modules", ".git", "test", "tests", "fixtures"].includes(entry.name)) continue;
      // Chromium 聚合许可由打包流程经 resources/licenses/electron 单独分发，不进 npm 通知。
      if (entry.isFile() && entry.name === "LICENSES.chromium.html") continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && noticeName.test(entry.name)) {
        const bytes = await readFile(full);
        if (bytes.includes(0) || bytes.length === 0) continue;
        files.push({ member: relative(directory, full).replaceAll("\\", "/"), bytes });
      } else if (entry.isFile() && /^readme(?:\.[^/]*)?$/iu.test(entry.name)) {
        const text = await readFile(full, "utf8");
        const match = /^(?:#{1,6}\s+licen[sc]e[^\n]*\n|licen[sc]e\s*\n[=-]+\n)/imu.exec(text);
        if (match) {
          const section = text.slice(match.index).split(/\n(?=#{1,6}\s)/u)[0];
          files.push({
            member: `${relative(directory, full).replaceAll("\\", "/")} (license section)`,
            bytes: Buffer.from(section),
          });
        }
      }
    }
  }
  await visit(directory);
  return files.sort((a, b) => a.member.localeCompare(b.member, "en"));
}

function productionPackages(projects) {
  const own = new Set(projects.map((project) => project.name));
  const required = new Map();
  function dependencies(deps) {
    for (const [alias, info] of Object.entries(deps ?? {})) {
      const name = info.name ?? alias;
      if (!own.has(name) && !name.startsWith("@zcode/") && !info.version.startsWith("link:")) {
        required.set(`${name}@${info.version}`, { name, version: info.version });
      }
      dependencies(info.dependencies);
      dependencies(info.optionalDependencies);
    }
  }
  for (const project of projects) {
    dependencies(project.dependencies);
    dependencies(project.optionalDependencies);
  }
  return required;
}

export function assertProductionGraphs(lockedProjects, installedProjects) {
  const locked = productionPackages(lockedProjects);
  const installed = productionPackages(installedProjects);
  const missing = [...locked].filter(
    ([key, item]) => !installed.has(key) && !isForeignPlatformVariant(item.name),
  );
  const stale = [...installed.keys()].filter((key) => !locked.has(key));
  if (missing.length || stale.length) {
    throw new Error(
      `Installed production graph differs from pnpm-lock.yaml. Run pnpm install --frozen-lockfile.\nMissing: ${missing.map(([key]) => key).join(", ")}\nStale: ${stale.join(", ")}`,
    );
  }
  return locked;
}

export async function readWorkspaceProductionGraph(root) {
  root = await realpath(root);
  // 修复：pnpm ls 默认读取安装快照，不能把旧图与当前锁文件哈希拼成有效声明。
  const [locked, actual] = await Promise.all(
    [true, false].map(async (lockfileOnly) => {
      const { stdout } = await exec(
        "pnpm",
        [
          "-r",
          "ls",
          "--prod",
          "--json",
          "--depth",
          "Infinity",
          ...(lockfileOnly ? ["--lockfile-only"] : []),
        ],
        {
          cwd: root,
          maxBuffer: 256 * 1024 * 1024,
          ...resolveSpawnRuntimeOptions("pnpm"),
        },
      );
      return JSON.parse(stdout);
    }),
  );
  const required = assertProductionGraphs(locked, actual);
  return { required, projects: actual };
}

export async function scanInstalledPackages(root, projects) {
  // pnpm hoisted 布局的 ls.path 仍可能指向不存在的 .pnpm 路径；按真实安装目录和精确版本匹配。
  const installed = new Map();
  const visited = new Set();
  async function scanNodeModules(directory) {
    let actual;
    try {
      actual = await realpath(directory);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (visited.has(actual)) return;
    visited.add(actual);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(path)) await scanPackage(join(path, scoped));
      } else await scanPackage(path);
    }
  }
  async function scanPackage(directory) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
      throw error;
    }
    if (pkg.name && pkg.version) installed.set(`${pkg.name}@${pkg.version}`, { pkg, directory });
    await scanNodeModules(join(directory, "node_modules"));
  }
  for (const project of projects) await scanNodeModules(join(project.path, "node_modules"));
  await scanNodeModules(join(root, "node_modules"));
  await scanNodeModules(join(root, "apps/zcode-cli/node_modules"));
  return installed;
}

export function missingProductionPackages(required, installed) {
  const missing = [...required].filter(([key]) => !installed.has(key)).map(([, item]) => item);
  for (const item of missing) {
    if (!isForeignPlatformVariant(item.name))
      throw new Error(`Missing installed dependency: ${item.name}@${item.version}`);
  }
  return missing;
}

export async function collectNpmNotices(root, overrides) {
  root = await realpath(root);
  const { required, projects } = await readWorkspaceProductionGraph(root);
  // 修复：标识门禁和声明生成必须扫描同一安装集合，避免嵌套版本只进声明、不进门禁。
  const installed = await scanInstalledPackages(root, projects);
  const packages = [];
  const missing = [];
  const notInstalled = missingProductionPackages(required, installed);
  for (const [key, item] of [...required].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const installedPackage = installed.get(key);
    if (!installedPackage) {
      continue;
    }
    const { pkg, directory } = installedPackage;
    const notices = await readPackageNotices(directory);
    const override = overrides.find((record) => record.package === key);
    if (override?.file) {
      const bytes = await readFile(join(root, override.file));
      if (hashBytes(bytes) !== override.sha256) throw new Error(`Changed upstream notice: ${key}`);
      notices.push({ member: override.source, bytes });
    }
    // README 中仅有 MIT 等标签不能冒充完整许可文件；这种包仍需要版本固定的补充材料。
    if (
      !notices.some(({ member }) => !member.endsWith(" (license section)")) &&
      !override?.acceptedMissingNotice
    )
      missing.push(key);
    packages.push({
      ...item,
      license:
        pkg.license ??
        pkg.licenses?.map((item) => (typeof item === "string" ? item : item.type)).join(" OR ") ??
        override?.license ??
        "(not declared)",
      repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
      ...(override?.acceptedMissingNotice
        ? { acceptedMissingNotice: override.acceptedMissingNotice }
        : {}),
      notices,
    });
  }
  if (missing.length) throw new Error(`Missing complete upstream notices:\n${missing.join("\n")}`);
  return {
    packages,
    notInstalled,
    workspaceManifests: projects.map((project) =>
      relative(root, join(project.path, "package.json")).replaceAll("\\", "/"),
    ),
  };
}
