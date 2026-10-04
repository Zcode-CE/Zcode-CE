#!/usr/bin/env node
/**
 * 文档叠层标记新鲜度检查（keep-latest 棘轮）。
 *
 * ## 为什么需要这条护栏
 *
 * 根 `AGENTS.md` 的 keep-latest 规则要求 README、backlog、spec、AGENTS.md 与 `docs/` 下的
 * 工作文件只表述**当前事实**：修正一条内容时**原地改写**为当前陈述，不留「订正 / 原表述 /
 * 此前」式的叠层注解。规则靠人盯会漂移 —— 本脚本把它变成一条可执行的命令：**叠层标记只降不增**。
 * 判别合规的唯一标准：读者不需要知道「过去怎么写」就能完全理解当前状态。
 *
 * ## 棘轮语义（与 `.copy-format-baseline.json` / 许可清单新鲜度同型）
 *
 * - 命中数 **大于** 基线（同一文件计数增加，或基线外的新文件出现命中）⇒ **退出 1**：新增了叠层注解。
 * - 命中数 **等于** 基线 ⇒ 通过。
 * - 命中数 **小于** 基线 ⇒ 通过，并提示运行 `--update` 把基线刷成当前值（清理是好事，基线跟着降）。
 *
 * ## 范围与豁免
 *
 * - 扫描 `README.md`、`AGENTS.md`、`docs/` 下全部 md；跳过 `.reverse/`、`node_modules/`，
 *   排除 `release-notes.md`（每版一份的版本快照，不适用 keep-latest）。
 * - `official-diff.md` 的对照表同样是版本快照（清理时豁免），但仍纳入扫描：其存量命中在基线里，
 *   新增同样变红。
 * - 基线里的合法元引用（`AGENTS.md` 规则自身列举被禁措辞）以**基线值**承载：规则必须命名被禁的
 *   模式，这些命中是规则的一部分而非叠层注解，但同样不能再增加。
 *
 * 用法：
 *   node scripts/check-doc-freshness.mjs          # 检查，红则 exit 1
 *   node scripts/check-doc-freshness.mjs --quiet  # 只输出结论行
 *   node scripts/check-doc-freshness.mjs --update # 清理后把基线刷成当前命中
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, relative, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 叠层修正标记（keep-latest 规则禁止的措辞模式）。新增标记词先确认规则文本是否同步。 */
const MARKER = /订正|原表述|此前这里|此前写|原本以为|旧表述|已回退但|历史口径/g;

/**
 * 棘轮基线：命中数写死在脚本常量（2026-10-04 keep-latest 首批清理后）。
 * 清理后用 `--update` 刷新；基线只降不升。
 */
const BASELINE = {
  total: 6,
  files: {
    "AGENTS.md": 4,
    "docs/development/official-diff.md": 2,
  },
};

/** 版本快照类文件（保持快照语义，不适用 keep-latest）。按 basename 匹配。 */
const SNAPSHOT_FILES = new Set(["release-notes.md"]);
/** 不追踪 / 不扫描的目录名。 */
const SKIPPED_DIRS = new Set([".reverse", "node_modules"]);

/** 收集检查目标：README.md、AGENTS.md、docs/ 下全部 md。 */
function collectTargets() {
  const targets = [resolve(root, "README.md"), resolve(root, "AGENTS.md")];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(p);
        continue;
      }
      if (entry.name.endsWith(".md") && !SNAPSHOT_FILES.has(basename(p))) targets.push(p);
    }
  };
  walk(resolve(root, "docs"));
  return targets;
}

/** 逐行统计命中，保留行号与片段便于报告。 */
function scanFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { hits: [] }; // 文件被删（如 README 整体移除）不算回归
  }
  const hits = [];
  text.split("\n").forEach((line, index) => {
    const found = line.match(MARKER);
    if (found) hits.push({ line: index + 1, count: found.length, snippet: line.trim() });
  });
  return { hits };
}

/** 把 `const BASELINE = {...};` 重写为当前命中（自写自身，仅 --update 用）。 */
function rewriteBaseline(next) {
  const self = fileURLToPath(import.meta.url);
  const src = readFileSync(self, "utf8");
  const marker = "const BASELINE = ";
  const start = src.indexOf(marker);
  if (start < 0) throw new Error("找不到 BASELINE 常量声明，无法 --update");
  let depth = 0;
  let lastBrace = -1;
  for (let i = start + marker.length; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        lastBrace = i;
        break;
      }
    }
  }
  if (lastBrace < 0) throw new Error("BASELINE 常量的对象括号不匹配，无法 --update");
  const lineEnd = src.indexOf("\n", lastBrace);
  const tail = lineEnd < 0 ? src.length : lineEnd;
  const serialized = `${marker}${JSON.stringify(next, null, 2)};`;
  return `${src.slice(0, start)}${serialized}${src.slice(tail)}`;
}

function main() {
  const args = process.argv.slice(2);
  const update = args.includes("--update");
  const quiet = args.includes("--quiet");
  const unknown = args.filter((a) => a !== "--update" && a !== "--quiet");
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(", ")}；仅支持 --update / --quiet`);
    process.exit(2);
  }

  const currentFiles = {};
  let currentTotal = 0;
  const samples = [];
  for (const file of collectTargets()) {
    const { hits } = scanFile(file);
    const count = hits.reduce((sum, h) => sum + h.count, 0);
    if (count > 0) {
      const rel = relative(root, file);
      currentFiles[rel] = count;
      currentTotal += count;
      for (const h of hits) samples.push({ file: rel, ...h });
    }
  }

  if (update) {
    const next = { total: currentTotal, files: currentFiles };
    writeFileSync(fileURLToPath(import.meta.url), rewriteBaseline(next));
    console.log(
      `✓ 文档叠层基线已刷新为 ${currentTotal} 处（${Object.keys(currentFiles).length} 个文件）`,
    );
    if (currentTotal > BASELINE.total) {
      console.warn(
        `⚠ 当前命中高于旧基线（${BASELINE.total}）：确认新增的确实是叠层注解而非合法元引用`,
      );
    }
    console.log("  重跑一次 node scripts/check-doc-freshness.mjs 确认通过");
    return;
  }

  const regressions = [];
  for (const [file, count] of Object.entries(currentFiles)) {
    const base = BASELINE.files[file] ?? 0;
    if (count > base) regressions.push({ file, base, count });
  }
  if (regressions.length > 0) {
    console.error(`✗ 文档叠层标记新增：基线 ${BASELINE.total} 处，当前 ${currentTotal} 处`);
    for (const r of regressions) {
      console.error(`    ${r.file}（基线 ${r.base} → 当前 ${r.count}）`);
      for (const s of samples.filter((x) => x.file === r.file)) {
        console.error(`      L${s.line}  ${s.snippet.slice(0, 180)}`);
      }
    }
    console.error(
      [
        "",
        "怎么修：",
        "  把命中的叠层注解原地改写为当前陈述（keep-latest）：不保留旧表述、不留",
        "  「订正 / 原表述 / 此前」式的注解；需要携带「查过了、不存在 / 不提供」的",
        "  否定式结论时写成当前陈述（例：`官方开源版无云 relay（全仓 0 命中）`）。",
        "  「为什么这么决定」是当前决策的一部分，保留；被推翻的旧理由不留。",
        "  规则与判据见根 AGENTS.md「文档与知识库」节的 keep-latest 三条边界。",
        "  版本快照类文件（release-notes.md 每版一份、official-diff.md 对照表）",
        "  保持快照语义不在清理范围，但其存量命中同样不能新增。",
      ].join("\n"),
    );
    process.exit(1);
  }

  if (currentTotal < BASELINE.total) {
    console.log(`✓ 文档叠层标记：${currentTotal} 处命中，低于基线 ${BASELINE.total}（清理生效）`);
    console.log("  基线已过时：跑 node scripts/check-doc-freshness.mjs --update 刷新基线");
    return;
  }
  console.log(`✓ 文档叠层标记：${currentTotal} 处命中，与基线一致`);
}

main();
