import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * 结构护栏：browser-safe 根入口 @zcode/services 的导出闭包不得含 Node-only 顶层求值（task-111）。
 *
 * ## 守的是什么
 * 根入口 index.ts 是 web 客户端会打进浏览器产物的那一面（packages/ui 以值导入本包，
 * 例如 src/lib/cuaComposerEntryState.ts）。它一旦把 Node-only 的模块拉进闭包，
 * 浏览器里就是加载期崩溃 —— 本批实测到两次，同一根因的两种形态：
 *   1) paths.ts 顶层 `process.env.HOME?.trim() || homedir()` ⇒ TypeError: (0, X.homedir) is not a function；
 *   2) undici 顶层 `process.versions.node.split(".")` ⇒ ReferenceError: process is not defined，
 *      经 index.ts 的 `export { BOT_MAX_* } from "./bots/botsService.js"` 被拉进来。
 * 两次都是真浏览器控制台 error，页面白屏。
 *
 * ## 为什么是结构断言，而不是再跑一遍端到端
 * packages/web/test/webLoadConsoleErrors.test.ts 是最终消费点，但它跑的是已构建的 dist ——
 * 本批正是因为 dist 陈旧而假绿了整批（旧产物里连 paths.ts 都没有）。
 * 这条断言打在源码的导入图上，不需要构建，改了导入图立刻红。
 *
 * ## 判据（三条）
 *  A. 闭包内不得出现 src/paths.ts；
 *  B. 闭包的外部依赖不得出现 undici；
 *  C. 闭包内任何模块都不得在函数体之外引用 process 或 node:os 的导入绑定。
 *     C 是通用规则，A/B 是它当前的两个实例。
 *
 * C 不能简化成"闭包不得 import node:os"：闭包里的 terminal/terminalProfile.ts 合法地
 * import 了 node:os 的 homedir，但只在函数体内调用。判据必须是"顶层是否求值"，
 * 不是"是否 import" —— 否则会误杀，而误杀的护栏会被人关掉。
 *
 * 覆盖范围的诚实声明：闭包只走包内相对导入与 #src 别名，@zcode/* 跨包依赖记为外部
 * 依赖名、不展开。因此本断言覆盖 services 包自身的导入图，不覆盖 packages/shared 内部。
 *
 * 运行：cd packages/services && node --import tsx --test test/browserSafeBarrelClosure.test.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const servicesSrc = resolve(here, "..", "src");
const barrelEntry = join(servicesSrc, "index.ts");

/** A 条判据的对象：顶层求值 homedir，非 Node 环境必崩。 */
const FORBIDDEN_MODULES = ["paths.ts"];

/** B 条判据的对象：顶层读 process.versions，浏览器里 process 未定义。 */
const FORBIDDEN_EXTERNAL_PACKAGES = ["undici"];

/** 去掉注释：注释里出现的 from "x" 会污染导入扫描。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
}

interface ImportRef {
  spec: string;
}

/** 抽取一个模块的全部 import/export ... from 语句。 */
function importsOf(text: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const statement of stripComments(text).split(";")) {
    const match = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s+"([^"]+)"/u.exec(
      statement,
    );
    if (match) refs.push({ spec: match[1] as string });
  }
  return refs;
}

/** 把相对 / #src 说明符解析成 services/src 下的真实文件；解析不到返回 null。 */
function resolveLocal(fromFile: string, spec: string): string | null {
  let candidate: string;
  if (spec.startsWith(".")) {
    candidate = resolve(dirname(fromFile), spec.replace(/\.js$/u, ".ts"));
  } else if (spec.startsWith("#src/")) {
    candidate = join(servicesSrc, spec.slice("#src/".length).replace(/\.js$/u, ".ts"));
  } else {
    return null;
  }
  return existsSync(candidate) ? candidate : null;
}

interface Closure {
  files: string[];
  externals: string[];
}

/** 从根入口出发做导入图闭包（只走包内导入；外部包名记为 externals）。 */
function collectClosure(entry: string): Closure {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const ref of importsOf(readFileSync(file, "utf8"))) {
      const local = resolveLocal(file, ref.spec);
      if (local) {
        queue.push(local);
      } else if (!ref.spec.startsWith("@zcode/")) {
        externals.add(ref.spec);
      }
    }
  }
  return { files: [...seen], externals: [...externals] };
}

/** 收集一个模块从 node:os 导入的绑定名。 */
function nodeOsBindingsOf(text: string): Set<string> {
  const bindings = new Set<string>();
  const re = /import\s*\{([^}]*)\}\s*from\s*"node:os"/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    for (const piece of (match[1] as string).split(",")) {
      const name = piece
        .trim()
        .split(/\s+as\s+/u)
        .pop()
        ?.trim();
      if (name) bindings.add(name);
    }
  }
  return bindings;
}

/**
 * 找出源码顶层（函数体 / 类体 / 命名空间之外）对给定名字的运行时引用。
 *
 * 排除四类假阳性 —— 不排除会误杀，误杀的护栏会被人关掉：
 *  - import / export 语句与类型节点（`import { homedir } from "node:os"` 本身不是求值）；
 *  - 属性名与类型成员名（`interface SystemInfo { homedir: string }` 不是引用）；
 *  - typeof 的运算对象（`typeof process` 不抛错）；
 *  - 由 typeof 守卫保护的引用（`typeof process !== "undefined" ? process.env.X : undefined`
 *    是既有正确写法，见 packages/shared/src/env.ts:43）。
 */
function topLevelRuntimeRefs(file: string, sourceText: string, names: Set<string>): string[] {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const hits: string[] = [];
  const ancestors: ts.Node[] = [];

  /** 该引用是否处于「typeof <同名> ...」守卫的短路分支里。 */
  const guardedByTypeof = (node: ts.Node): boolean => {
    for (const ancestor of ancestors) {
      if (!ts.isConditionalExpression(ancestor) && !ts.isBinaryExpression(ancestor)) continue;
      const condition = ts.isConditionalExpression(ancestor) ? ancestor.condition : ancestor;
      let guarded = false;
      const scan = (current: ts.Node): void => {
        if (ts.isTypeOfExpression(current)) {
          const operand = current.expression;
          if (ts.isIdentifier(operand) && operand.text === node.text) guarded = true;
        }
        ts.forEachChild(current, scan);
      };
      scan(condition);
      if (guarded) return true;
    }
    return false;
  };

  const isNonReferencePosition = (node: ts.Node): boolean => {
    const parent = node.parent as ts.Node | undefined;
    if (!parent) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
    if (ts.isPropertySignature(parent) && parent.name === node) return true;
    if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
    if (ts.isMethodSignature(parent) && parent.name === node) return true;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
    if (ts.isBindingElement(parent) && parent.name === node) return true;
    return false;
  };

  const visit = (node: ts.Node, depth: number): void => {
    const importish =
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isImportTypeNode(node) ||
      ts.isTypeNode(node);

    if (
      !importish &&
      depth === 0 &&
      ts.isIdentifier(node) &&
      names.has(node.text) &&
      !isNonReferencePosition(node) &&
      !guardedByTypeof(node)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      hits.push(`${relative(servicesSrc, file)}:${line + 1} ${node.text}`);
    }

    const opensScope =
      ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isModuleDeclaration(node);
    ancestors.push(node);
    ts.forEachChild(node, (child) => visit(child, depth + (opensScope ? 1 : 0)));
    ancestors.pop();
  };

  visit(source, 0);
  return hits;
}

test("browser-safe 根入口的闭包不含 Node-only 模块，也不在顶层求值 Node 全局", () => {
  const closure = collectClosure(barrelEntry);
  const relativeFiles = closure.files.map((file) => relative(servicesSrc, file));

  // 判据 A：paths.ts 不得进闭包。
  assert.deepEqual(
    relativeFiles.filter((file) => FORBIDDEN_MODULES.includes(file)),
    [],
    "根入口闭包含 paths.ts：它顶层求值 homedir()，浏览器里是 TypeError: homedir is not a function",
  );

  // 判据 B：undici 不得进闭包。
  assert.deepEqual(
    closure.externals.filter((spec) => FORBIDDEN_EXTERNAL_PACKAGES.includes(spec)),
    [],
    "根入口闭包含 undici：它顶层读 process.versions.node，浏览器里是 ReferenceError: process is not defined",
  );

  // 判据 C：通用规则 —— 闭包内不得有顶层求值。
  const offenders: string[] = [];
  for (const file of closure.files) {
    const text = readFileSync(file, "utf8");
    const names = new Set<string>(["process", ...nodeOsBindingsOf(text)]);
    offenders.push(...topLevelRuntimeRefs(file, text, names));
  }
  assert.deepEqual(
    offenders,
    [],
    "根入口闭包在模块顶层求值了 Node 全局（process / node:os）：浏览器产物加载即崩",
  );
});

test("判据工具本身可信：闭包覆盖到本次修复落点，且扫描器对已知坏样本会报错", () => {
  const closure = collectClosure(barrelEntry);
  const relativeFiles = closure.files.map((file) => relative(servicesSrc, file));

  // 自检 1：闭包不是空的 —— 空闭包会让上面三条断言永远绿。
  assert.ok(
    closure.files.length > 30,
    `闭包只覆盖 ${closure.files.length} 个模块，扫描器可能已失效`,
  );

  // 自检 2：本次修复的落点必须在闭包里，否则护栏没有观测到修复本身。
  assert.ok(
    relativeFiles.includes(join("bots", "botAttachmentLimits.ts")),
    "闭包未覆盖 bots/botAttachmentLimits.ts：护栏没有观测到本次修复的落点",
  );

  // 自检 3（变异验证）：拿已知坏样本喂扫描器，必须命中；
  // 再拿既有正确写法喂它，必须不命中 —— 两个方向都验，才证明判据不是恒真或恒假。
  const bad =
    'import { homedir } from "node:os";\nconst dir = process.env.HOME?.trim() || homedir();\n';
  const badHits = topLevelRuntimeRefs(
    join(servicesSrc, "synthetic-bad.ts"),
    bad,
    new Set(["process", "homedir"]),
  );
  assert.ok(
    badHits.some((hit) => hit.includes("process")) &&
      badHits.some((hit) => hit.includes("homedir")),
    `扫描器没有报出已知的顶层求值样本，判据工具已失效：${JSON.stringify(badHits)}`,
  );

  const good =
    'const debug = typeof process !== "undefined" ? process.env.ZCODE_DEBUG : undefined;\n';
  assert.deepEqual(
    topLevelRuntimeRefs(join(servicesSrc, "synthetic-good.ts"), good, new Set(["process"])),
    [],
    "扫描器把 typeof 守卫保护的既有正确写法判成了顶层求值（误杀）",
  );
});
