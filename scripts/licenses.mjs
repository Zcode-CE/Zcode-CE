#!/usr/bin/env node
/* eslint-disable max-lines -- 三方 license 盘点/声明/门禁一体脚本，数据表与校验逻辑集中维护。 */
// 三方 license 盘点/声明/门禁 一体脚本
//
// 用法：
//   node scripts/licenses.mjs notices   生成 THIRD-PARTY-NOTICES.md（精确版本、原始版权和许可文本）
//   node scripts/licenses.mjs check     手动门禁：出现 allowlist 之外或许可未知的包即退出码 1
//
// 数据口径：
// - 实装清单 = 全 workspace node_modules 的递归集合，含嵌套版本与符号链接。
// - 声明生成：third-party-npm.mjs 按生产依赖的精确版本收集真实许可文件。
// - prod 判定按锁文件生产图中的精确版本。
// - 商用/半开放检查作用于全量实装包（prod+dev）
import { generateThirdPartyNotices } from "./generate-third-party-notices.mjs";
import { readVerifiedNotices } from "./third-party-notices.mjs";
import { readFile } from "node:fs/promises";
import {
  readWorkspaceProductionGraph,
  scanInstalledPackages,
  missingProductionPackages,
} from "./third-party-npm.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "notices";
if (command === "notices") {
  await generateThirdPartyNotices(ROOT);
  process.exit(0);
}

// 标识门禁与声明生成共用 workspace 图和递归扫描，不按包名猜测生产范围。
const { required, projects } = await readWorkspaceProductionGraph(ROOT);
const ownNames = new Set(projects.map((project) => project.name));
const installed = new Map();
const MANUAL_LICENSE = {
  "exif-parser": "MIT", // 包内 LICENSE.md
  khroma: "MIT", // 包内 license 文件
  semaphore: "MIT", // 包内 README License 段
  "css-value": "MIT", // 包内 Readme License 段
  "@fig/autocomplete-helpers": "MIT", // 包内 LICENSE
};
function normLicense(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(normLicense).join(" OR ");
  return value?.type?.trim() || "(missing)";
}
const scanned = await scanInstalledPackages(ROOT, projects);
missingProductionPackages(required, scanned);
for (const [key, { pkg }] of scanned) {
  if (ownNames.has(pkg.name)) continue;
  installed.set(key, {
    name: pkg.name,
    version: pkg.version,
    license: normLicense(pkg.license ?? pkg.licenses ?? MANUAL_LICENSE[pkg.name]),
    isProd: required.has(key),
  });
}
// ---------- 分类 ----------
const GREEN =
  /^(MIT|MIT-0|ISC|BSD-2-Clause|BSD-3-Clause|BSD-4-Clause|0BSD|Unlicense|Apache-2\.0|Zlib|WTFPL|Artistic-2\.0|BlueOak-1\.0\.0|CC0-1\.0|CC-BY-4\.0|CC-BY-3\.0|BSD|Python-2\.0)$/i;
function classify(raw) {
  const s = raw.replace(/[()]/g, " ").trim();
  if (s === "(missing)" || s === "missing" || s === "") return "missing";
  if (/^UNLICENSED|SEE LICEN[CS]E IN|UNKNOWN|N\/A$/i.test(s)) return "unresolved";
  const or = s
    .split(/\s+OR\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
  if (or.length > 1 && or.some((x) => GREEN.test(x))) return "green";
  const and = s
    .split(/\s+AND\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
  if (and.length > 1 && and.every((x) => GREEN.test(x))) return "green";
  // AND 是**合取**：必须同时满足每一项，所以按**最严格**的那一项定级，不能只看第一项。
  // 原实现取 or[0] || and[0]，于是 "MIT AND MPL-2.0" 因为首项是 MIT 而落进 review ——
  // 既不是 green（会被放过）也不是 yellow-weak（有登记路径），等于把一个真实的 MPL
  // 义务塞进"未知"桶。按最严格项定级后，它正确地落 yellow-weak，走人工复核登记。
  const AND_RANK = [
    "green",
    "review",
    "yellow-cc",
    "yellow-weak",
    "yellow-lgpl",
    "red-nc",
    "red-semiopen",
    "red-agpl",
    "red-gpl",
  ];
  if (and.length > 1) {
    const worst = and
      .map((part) => classify(part))
      .sort((a, b) => AND_RANK.indexOf(b) - AND_RANK.indexOf(a))[0];
    return worst;
  }
  const t = or[0] || s;
  if (/\bAGPL/i.test(t)) return "red-agpl";
  if (/\bLGPL/i.test(t)) return "yellow-lgpl";
  if (/\bGPL/i.test(t)) return "red-gpl";
  if (/^(MPL|EPL|CDDL)/i.test(t)) return "yellow-weak";
  if (/^(BUSL|BSL|Elastic|SSPL|PolyForm|FSL|CAL-1)/i.test(t)) return "red-semiopen";
  if (/^CC-BY-NC/i.test(t)) return "red-nc";
  if (/^CC-BY-(ND|SA)/i.test(t)) return "yellow-cc";
  return GREEN.test(t) ? "green" : "review";
}
for (const r of installed.values()) r.bucket = classify(r.license);

// ---------- 构建工具许可标识复核（不是二进制发行义务豁免） ----------
const WEAK_ALLOW = [[/^lightningcss/, "当前仅构建依赖；进入生产图时需重新核对 MPL 源码提供义务"]];
/**
 * 生产图内的弱 copyleft 依赖：已人工复核，登记结论。
 *
 * 与 WEAK_ALLOW 分开是刻意的：那张表只覆盖**构建期**依赖（不进入发行物），
 * 这里覆盖**会随包分发**的依赖，义务更实，必须逐条写明复核结论而不是靠正则放过。
 *
 * MPL-2.0 是文件级 copyleft：只要不改动被覆盖的文件，分发义务就是保留许可声明
 * 并提供对应源码。这些包原样分发（未修改），源码由 pinned 上游 tag 提供，
 * 许可材料已登记在 third-party/npm-overrides.json。
 */
const PROD_WEAK_ALLOW = [
  [
    /^@ubjs\/(?:core|node)(?:-|$)/,
    "@ubjs/* 是 MPL-2.0（uniffi N-API 运行时），原样分发未修改；源码见 pinned 上游 tag，许可材料已登记",
  ],
  [
    /^@trycua\/cua-driver(?:-|$)/,
    "平台包声明 MIT AND MPL-2.0，MPL 部分仅覆盖 node runtime 垫片（包内 node-runtime-NOTICE.md 有说明）；原样分发未修改，许可材料已登记",
  ],
];
function weakAllowReason(r) {
  if (r.isProd) {
    for (const [re, why] of PROD_WEAK_ALLOW) if (re.test(r.name)) return why;
    return null;
  }
  for (const [re, why] of WEAK_ALLOW) if (re.test(r.name)) return why;
  return null;
}

if (command === "check") {
  const bad = [];
  for (const r of installed.values()) {
    if (r.bucket === "green") continue;
    if (r.bucket.startsWith("yellow") && weakAllowReason(r)) continue;
    bad.push(r);
  }
  if (bad.length) {
    console.error(`✗ license 检查失败：${bad.length} 个包超出 allowlist：`);
    for (const r of bad.sort((a, b) => a.name.localeCompare(b.name)))
      console.error(`  [${r.bucket}] ${r.name}@${r.version} → ${r.license}`);
    console.error("\n处置：替换依赖，或在 scripts/licenses.mjs 的 WEAK_ALLOW 登记人工复核结论。");
    process.exit(1);
  }
  await readVerifiedNotices(ROOT, { requireComplete: process.argv.includes("--strict") });
  const reviewRequired =
    JSON.parse(await readFile(path.join(ROOT, "third-party/inventory.json"), "utf8"))
      .reviewRequired ?? [];
  if (reviewRequired.length)
    console.warn(
      `待补齐/核验材料 ${reviewRequired.length} 项；发布前运行 node scripts/licenses.mjs check --strict，不得将基础检查通过视为合规完成。`,
    );
  const n = installed.size;
  console.log(
    `✓ 许可标识与声明新鲜度检查通过：${n} 个实装包（构建依赖复核 ${[...installed.values()].filter((r) => r.bucket.startsWith("yellow")).length} 项）；材料限制见 third-party/README.md`,
  );
} else {
  console.error("用法: node scripts/licenses.mjs [notices|check]");
  process.exit(2);
}
