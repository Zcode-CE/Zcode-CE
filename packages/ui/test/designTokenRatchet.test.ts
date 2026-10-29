import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * 设计令牌棘轮（DESIGN.md「Typography / Color Usage Rules」）。
 *
 * 规则：UI 界面字号只用 text-ui-*（内容渲染区除外），颜色只用语义令牌，不得用
 * text-white/60、border-white/10、[#hex] 这类一次性值。既有欠账一次性清零不现实，
 * 但可以钉住「不得新增」：每个文件的命中数只能 ≤ 基线。
 *
 * 收紧方式：清理后跑 node scripts/design-token-baseline.mjs（重新生成基线并提交）。
 * 不要手工改基线数字 —— 那正是这条棘轮要防的事。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const uiSrc = resolve(repoRoot, "packages/ui/src");
const baselinePath = resolve(repoRoot, ".design-token-baseline.json");

// 与 scripts/design-token-baseline.mjs 保持同一组正则（改一处必须改两处）。
const RAW_FONT_SIZE_PATTERN = /(?<!font-)\btext-(xs|sm|base|lg|xl|[2-9]xl)\b/g;
const RAW_COLOR_PATTERN = /(?:text|border|bg)-(?:white|black)\/\d+|\[#[0-9a-fA-F]{3,8}\]/g;

function collectFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full));
    else if (/\.(tsx|ts)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function count(source: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let total = 0;
  while (pattern.exec(source)) total += 1;
  return total;
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
  total: number;
  files: Record<string, { size: number; color: number }>;
};

test("设计令牌基线自洽：total 等于各文件之和", () => {
  const sum = Object.values(baseline.files).reduce(
    (acc, entry) => acc + entry.size + entry.color,
    0,
  );
  assert.equal(baseline.total, sum, "基线 total 与各文件之和不符 —— 不要手改基线");
  for (const file of Object.keys(baseline.files)) {
    assert.ok(existsSync(resolve(repoRoot, file)), `基线里的文件已不存在：${file}`);
  }
});

test("不得新增 raw 字号 / raw 颜色（超出基线即红）", () => {
  const violations: string[] = [];
  for (const file of collectFiles(uiSrc)) {
    const source = readFileSync(file, "utf8");
    const size = count(source, RAW_FONT_SIZE_PATTERN);
    const color = count(source, RAW_COLOR_PATTERN);
    const key = relative(repoRoot, file);
    const allowed = baseline.files[key] ?? { size: 0, color: 0 };
    if (size > allowed.size || color > allowed.color) {
      violations.push(`${key}: size ${allowed.size}→${size} / color ${allowed.color}→${color}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "设计令牌基线被突破。用 text-ui-* 与语义色替换新增的 raw 值；\n" +
      "若确属内容渲染区豁免，先在 DESIGN.md 记录例外再更新基线：\n" +
      "  node scripts/design-token-baseline.mjs\n" +
      "不要手工改基线数字。",
  );
});
