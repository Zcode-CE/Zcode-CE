import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * 全仓护栏：组件里字面量引用的 i18n 键必须同时存在于 zh-CN 与 en-US 字典。
 *
 * 为什么需要（2026-10-29 审计，P0）：F8 消费侧接线带进了 BoundGroupsCard / PrivateDeliveryRetry
 * 等组件，但它们引用的 13 个 `bots.*` 键从未加入字典 ⇒ 用户界面直接显示 `bots.boundGroups.count`。
 * 原有 botsDialogWiring 只扫 4 个文件、正则不认三元 id，所以一直绿着；其余 5 族共 54 条无人发现。
 *
 * 为什么是「字面量键」而不是全量：动态拼接的键无法静态判定，本护栏只保证能静态看到的引用不落空；
 * 这已经能抓住「搬组件忘搬键」这一实际失效形态。命名空间白名单取自现有字典的顶层前缀，
 * 避免把 `id: "model-1"` 这类非 i18n 字符串误判。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const localeDir = resolve(repoRoot, "packages/ui/src/i18n/locales");
const SCAN_DIRS = ["packages/ui/src", "packages/web/src", "packages/desktop/src"];

function loadDict(file: string): Map<string, string> {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const out = new Map<string, string>();
  function walk(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
      const init = node.initializer;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        out.set(node.name.text, init.text);
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  return out;
}

const zh = loadDict(join(localeDir, "zh-CN.ts"));
const en = loadDict(join(localeDir, "en-US.ts"));
const NAMESPACES = new Set([...zh.keys()].map((key) => key.split(".")[0]));

function filesUnder(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
}

function literalValues(node: ts.Expression): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    return [...literalValues(node.whenTrue), ...literalValues(node.whenFalse)];
  }
  if (ts.isParenthesizedExpression(node)) return literalValues(node.expression);
  return [];
}

const refs = new Map<string, Set<string>>();
function addRef(key: string, file: string): void {
  if (!key.includes(".") || !NAMESPACES.has(key.split(".")[0] ?? "")) return;
  const set = refs.get(key) ?? new Set<string>();
  set.add(file);
  refs.set(key, set);
}

const files: string[] = [];
for (const dir of SCAN_DIRS) filesUnder(resolve(repoRoot, dir), files);

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const rel = file.slice(repoRoot.length + 1);
  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : null;
      if ((name === "t" || name === "translate" || name === "useT") && node.arguments.length > 0) {
        for (const value of literalValues(node.arguments[0] as ts.Expression)) addRef(value, rel);
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      if (name === "id" || name === "messageId") {
        for (const value of literalValues(node.initializer)) addRef(value, rel);
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
}

test("判据：组件引用的字面量 i18n 键必须在 zh-CN 与 en-US 两份字典里都存在", () => {
  const missing = [...refs.entries()]
    .filter(([key]) => !zh.has(key) || !en.has(key))
    .map(([key, where]) => key + " ← " + [...where].slice(0, 2).join(", "));
  assert.deepEqual(
    missing,
    [],
    "缺失的键会以原文显示在界面上（示例：" + missing.slice(0, 5).join("；") + "）",
  );
});

test("判据：zh-CN 与 en-US 的键集合一致（新增文案必须双语）", () => {
  const onlyZh = [...zh.keys()].filter((key) => !en.has(key));
  const onlyEn = [...en.keys()].filter((key) => !zh.has(key));
  assert.deepEqual({ onlyZh, onlyEn }, { onlyZh: [], onlyEn: [] });
});
