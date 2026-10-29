#!/usr/bin/env node
// 生成/收紧 DESIGN.md 设计令牌基线（.design-token-baseline.json）。
//
// 为什么需要基线：既有代码里仍有少量 raw 字号与 raw 颜色 alpha（audit 记录的欠账）。
// 一次性清零不现实，但可以钉住「不得新增」——测试只允许低于或等于基线，
// 清理后跑本脚本 --write 收紧。规则见 DESIGN.md「Typography / Color Usage Rules」。
//
// 用法：node scripts/design-token-baseline.mjs --write
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const uiSrc = join(root, "packages", "ui", "src");

// 与 packages/ui/test/designTokenRatchet.test.ts 保持同一组正则（改一处必须改两处）。
export const RAW_FONT_SIZE_PATTERN = /\btext-(xs|sm|base|lg|xl|[2-9]xl)\b/g;
export const RAW_COLOR_PATTERN = /(?:text|border|bg)-(?:white|black)\/\d+|\[#[0-9a-fA-F]{3,8}\]/g;

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full));
    else if (/\.(tsx|ts)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function count(source, pattern) {
  pattern.lastIndex = 0;
  let total = 0;
  while (pattern.exec(source)) total += 1;
  return total;
}

const files = {};
let total = 0;
for (const file of collectFiles(uiSrc)) {
  const source = readFileSync(file, "utf8");
  const size = count(source, RAW_FONT_SIZE_PATTERN);
  const color = count(source, RAW_COLOR_PATTERN);
  if (size + color === 0) continue;
  files[relative(root, file)] = { size, color };
  total += size + color;
}

const output = { total, files };
writeFileSync(join(root, ".design-token-baseline.json"), JSON.stringify(output, null, 2) + "\n");
console.log(`design-token baseline: ${total} violations across ${Object.keys(files).length} files`);
