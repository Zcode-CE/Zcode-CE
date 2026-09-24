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

/**
 * 许可材料证据档位表。
 *
 * **fail-closed**：只有在本表里显式登记为 `blocking: false`、**且**运行时判据核对全部通过的
 * 档位才不阻断发布门禁。未登记的 `evidenceKind`（含拼写错误）一律按阻断处理。
 *
 * 档位语义与判据见 `third-party/README.md`：
 * - `publisher-declared-standard-terms`：发布者**已发布**的 SPDX 声明 + 对应**标准未修改**条款文本
 *   + 已发布的发布者版权主体 + 已记录的出处与版本锁定。四条同时成立才非阻断。
 *   非阻断**不等于**"材料齐全"，只表示"我们不再把发布者已发布的声明当作缺失"。
 * - `pinned-upstream-license-file`：登记的是**上游仓库**里 pin 住的许可文件。材料性质与上面那档不同，
 *   本次实现**刻意**未重新分档（保持阻断），见 third-party/README.md 的说明。
 * - `incomplete-unverified`：声明缺失、含糊，或文本是自定义条款 ⇒ 阻断。
 */
export const EVIDENCE_TIERS = new Map([
  ["publisher-declared-standard-terms", { blocking: false, guard: "published-declaration" }],
  ["pinned-upstream-license-file", { blocking: true, guard: null }],
  ["incomplete-unverified", { blocking: true, guard: null }],
]);

/**
 * 每个 SPDX 标识对应的**标准条款片段**（逐行照抄，避免跨行断句）。
 *
 * 判据 (b) 只核对"我们随包分发的通知文本里确实包含该标识的标准条款"。
 * 它**不能**证明文本未被改动过——那是人工复核的职责；但它能拦住"换成自定义文案"
 * 这类会让门禁静默变绿的情况。**没有表项的标识一律判为无法核对 ⇒ 阻断**（fail-closed）。
 */
const STANDARD_CLAUSES = new Map([
  [
    "MIT",
    [
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    ],
  ],
  [
    "ISC",
    [
      "Permission to use, copy, modify, and/or distribute this software for any",
      "purpose with or without fee is hereby granted, provided that the above",
    ],
  ],
  [
    "BSD-3-Clause",
    [
      "Redistribution and use in source and binary forms, with or without",
      "3. Neither the name of the copyright holder nor the names of its contributors",
      'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
    ],
  ],
  [
    "BSD-2-Clause",
    [
      "Redistribution and use in source and binary forms, with or without",
      'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
    ],
  ],
  [
    "Apache-2.0",
    [
      'Licensed under the Apache License, Version 2.0 (the "License");',
      "http://www.apache.org/licenses/LICENSE-2.0",
    ],
  ],
]);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function declaredLicenseText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(declaredLicenseText).filter(Boolean).join(" OR ");
  return value?.type?.trim() ?? "";
}

function publisherSubjectText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(publisherSubjectText).filter(Boolean).join(", ");
  if (value && typeof value === "object") return String(value.name ?? "").trim();
  return "";
}

/** 某个标识是否以独立词出现（避免 MIT 命中 MIT/X11 之外的同名子串）。 */
function mentionsIdentifier(text, identifier) {
  if (!text) return false;
  return new RegExp(
    `(?:^|[^A-Za-z0-9.-])${escapeRegExp(identifier)}(?:[^A-Za-z0-9.-]|$)`,
    "u",
  ).test(text);
}

/**
 * 核对"发布者声明档"的四条判据。
 *
 * 输入刻意分成两类，避免**循环论证**：
 * - `publishedNotices`：来自**已发布包目录**的成员（README 许可段、包内 LICENSE），它才代表"发布者已发布"；
 * - `record.file`：我们自己登记的文本，只用来核对判据 (b)，**不**用来证明声明或版权主体存在。
 */
export function assessOverrideMaterials(key, record, { pkg, notices }) {
  const tier =
    record.evidenceKind ?? (record.acceptedMissingNotice ? "accepted-missing-notice" : "unknown");
  const policy = EVIDENCE_TIERS.get(tier) ?? { blocking: true, guard: null };
  const publishedNotices = notices.filter((notice) => !notice.injected);
  const publishedText = publishedNotices.map((notice) => notice.bytes.toString("utf8")).join("\n");
  const noticeText = record.file
    ? (notices.find((notice) => notice.injected)?.bytes.toString("utf8") ?? "")
    : "";
  const missing = [];
  const declared = declaredLicenseText(record.license);
  const artifactDeclaration = declaredLicenseText(pkg.license) || declaredLicenseText(pkg.licenses);

  if (policy.guard === "published-declaration") {
    // (a) 已发布物里声明了 SPDX 标识
    if (!declared) missing.push("(a) no licence identifier is recorded for this entry");
    else if (!STANDARD_CLAUSES.has(declared))
      missing.push(`(a) identifier ${declared} has no standard-clause table entry`);
    else if (
      !mentionsIdentifier(artifactDeclaration, declared) &&
      !mentionsIdentifier(publishedText, declared)
    )
      missing.push(
        `(a) the published artifact does not declare ${declared} (neither the package.json licence field nor a README/licence-section paragraph)`,
      );

    // (b) 该标识对应标准、未修改的条款文本
    const clauses = STANDARD_CLAUSES.get(declared);
    if (!record.file) missing.push("(b) no notice text file is recorded");
    else if (!clauses)
      missing.push(`(b) identifier ${declared} has no comparable standard clauses`);
    else
      for (const clause of clauses)
        if (!noticeText.includes(clause))
          missing.push(
            `(b) notice text is missing the ${declared} standard clause: ${clause.slice(0, 56)}`,
          );

    // (c) 发布者版权主体已发布（只用已发布物，不用我们自己写的文本）
    const subject =
      publisherSubjectText(pkg.author) ||
      publisherSubjectText(pkg.contributors) ||
      publisherSubjectText(pkg.maintainers) ||
      (/\bcopyright\b/iu.test(publishedText) ? "artifact copyright line" : "");
    if (!subject)
      missing.push(
        "(c) the published artifact carries no publisher copyright subject (package.json author/contributors/maintainers, or a Copyright line in a published licence text)",
      );

    // (d) 出处与版本锁定
    if (!record.source) missing.push("(d) no provenance source recorded");
    if (!record.file || !record.sha256) missing.push("(d) no content pin recorded (file + sha256)");
    if (
      !record.reviewEvidence?.npmArchiveSha256 &&
      !record.reviewEvidence?.sourceRevision &&
      !(record.refs?.length > 0)
    )
      missing.push(
        "(d) no version pin recorded (none of npmArchiveSha256 / sourceRevision / refs)",
      );
  }

  return {
    package: key,
    tier,
    blocking: policy.blocking || missing.length > 0,
    satisfied: missing.length === 0,
    missing,
    evidence: {
      source: record.source ?? null,
      noticeFile: record.file ?? null,
      noticeSha256: record.sha256 ?? null,
      archiveSha256: record.reviewEvidence?.npmArchiveSha256 ?? null,
      declaredLicense: declared || null,
      declarationLocation: [
        artifactDeclaration ? "package.json license field" : null,
        publishedNotices.length
          ? `published notice members: ${publishedNotices.map((n) => n.member).join(", ")}`
          : null,
      ].filter(Boolean),
    },
  };
}

export async function collectNpmNotices(root, overrides) {
  root = await realpath(root);
  const { required, projects } = await readWorkspaceProductionGraph(root);
  // 修复：标识门禁和声明生成必须扫描同一安装集合，避免嵌套版本只进声明、不进门禁。
  const installed = await scanInstalledPackages(root, projects);
  const packages = [];
  const overrideAssessments = [];
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
      // injected 标记：这条成员是我们自己登记的快照，不是发布者发布物。
      // 判据 (a)/(c) 必须只用发布物，否则等于拿自己的断言给自己作证。
      notices.push({ member: override.source, bytes, injected: true });
    }
    // README 中仅有 MIT 等标签不能冒充完整许可文件；这种包仍需要版本固定的补充材料。
    if (
      !notices.some(({ member }) => !member.endsWith(" (license section)")) &&
      !override?.acceptedMissingNotice
    )
      missing.push(key);
    // 分档判定：只对登记了 evidenceKind 的条目做，判据核对不通过会被升级为阻断。
    if (override?.evidenceKind)
      overrideAssessments.push(assessOverrideMaterials(key, override, { pkg, notices }));
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
    overrideAssessments,
    workspaceManifests: projects.map((project) =>
      relative(root, join(project.path, "package.json")).replaceAll("\\", "/"),
    ),
  };
}
