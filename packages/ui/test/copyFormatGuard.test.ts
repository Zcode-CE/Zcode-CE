import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * 文案格式护栏（task-94）。
 *
 * 为什么需要它：`settings.remoteAssets.cdnBaseUrlDescription` 的取值里写着
 * `指向发布根即可，不要带版本号`，而该行的渲染路径是纯文本 ——
 * `RemoteAssetsSetting.tsx:83` 把它交给 `SettingsRow`，`SettingsPageParts.tsx:142-144`
 * 直接 `<div>{description}</div>`，全链路没有 markdown 渲染器。
 * 实测（真浏览器 + 产品组件）：`hasLiteralStars=true`、`strongCount=0` ⇒ 用户看到的是星号原文。
 * 这是缺陷，不是风格问题，所以要用测试钉住，而不是靠人记得。
 *
 * 判据落在「用户实际看到的那一层」：本文件断言的是 i18n 字典的字符串取值（AST 提取），
 * 不是源码文本 —— 注释里合法地写着 `**`（那是给维护者看的），源码扫描会把它们一起算进去。
 * 真浏览器侧的对照证据见 `.reverse/92-copy-format/harness/`（vite build + node probe-render.mjs）。
 *
 * 规则与理由见 `docs/development/copy-and-format.md` §2。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const LOCALES = ["zh-CN", "en-US"] as const;

/**
 * 取一个 locale 文件里所有字符串取值（三种形态：普通字符串 / 无插值模板 / 带插值模板）。
 *
 * 为什么要走 AST 而不是 grep：`grep -c '\*\*'` 在 zh-CN.ts 上得 20 —— 其中 15 处是注释。
 * 口径错了会把「维护者注释里的强调」当成「用户看到的文案」。
 */
function extractStringValues(filePath: string): { key: string; value: string; line: number }[] {
  const source = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const out: { key: string; value: string; line: number }[] = [];

  function walk(node: ts.Node, path: string[]): void {
    if (ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      const nextPath = name ? [...path, name] : path;
      const init = node.initializer;
      let text: string | null = null;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        text = init.text;
      } else if (ts.isTemplateExpression(init)) {
        text = init.head.text + init.templateSpans.map((span) => span.literal.text).join("");
      }
      if (text !== null) {
        out.push({
          key: nextPath.join("."),
          value: text,
          line: sourceFile.getLineAndCharacterOfPosition(init.getStart(sourceFile)).line + 1,
        });
      }
      ts.forEachChild(node, (child) => walk(child, nextPath));
      return;
    }
    ts.forEachChild(node, (child) => walk(child, path));
  }

  walk(sourceFile, []);
  return out;
}

/** 成对的 markdown 强调。`**` 单出现不算（那是 Tailwind 后代变体 / glob 通配符 / 解析器分隔符）。 */
const BOLD_PAIR = /\*\*[^*\n]+\*\*/g;

/**
 * 已知例外：这些键的渲染路径支持 markdown（`ModelConfigHelp.tsx:102-113` 的 `emphasis()`），
 * 且取值与官方 v3.14.3 逐字节相同（`cmp` 通过）—— 用户口径是「官方文案已经很优秀」，
 * 因此不改。这不是「暂时放过」，是判定结论；例外必须逐条写明理由，不许静默豁免。
 */
const MARKDOWN_RENDERED_KEYS = new Set([
  // 渲染器：ModelConfigHelp.tsx emphasis()；与官方 zh-CN.ts:3134 / en-US.ts 对应键逐字节相同。
  "settings.modelProvider.help.inputModalities",
  "settings.modelProvider.help.capabilities",
  "settings.modelProvider.help.reasoningLevelsOrdered",
  "settings.modelProvider.help.advanced",
]);

for (const locale of LOCALES) {
  const filePath = resolve(repoRoot, `packages/ui/src/i18n/locales/${locale}.ts`);

  test(`[${locale}] UI 文案取值里不得出现 markdown 强调（**…**）`, () => {
    const offenders = extractStringValues(filePath)
      .filter((entry) => !MARKDOWN_RENDERED_KEYS.has(entry.key))
      .filter((entry) => BOLD_PAIR.test(entry.value))
      .map((entry) => `${locale}.ts:${entry.line} ${entry.key}`);

    assert.deepEqual(
      offenders,
      [],
      "以下键的取值含 **…**，但它们的渲染路径是纯文本 —— 用户会看到字面星号。\n" +
        "规则见 docs/development/copy-and-format.md §2：UI 强调用「」或界面元素，不用 markdown。\n" +
        offenders.join("\n"),
    );
  });

  test(`[${locale}] 例外清单里的键必须真的存在（防止例外静默失效）`, () => {
    const keys = new Set(extractStringValues(filePath).map((entry) => entry.key));
    for (const key of MARKDOWN_RENDERED_KEYS) {
      assert.ok(keys.has(key), `例外清单里的 ${key} 在 ${locale}.ts 里不存在，请清理例外`);
    }
  });
}

/**
 * 正反例自检：判据本身必须能区分「真强调」与「不是强调的 `**`」。
 * 没有这一段，规则会退化成「不许出现 `**`」——那是过钝的形态规则（会误杀 glob 与 Tailwind 变体）。
 */
test("判据自检：能认出真强调，且不误杀非强调形态", () => {
  const positives = [
    "必须是 http/https 地址，**指向发布根即可**（例如 https://x）",
    "points at the **publish root**",
    "**不下载、不打包**",
  ];
  for (const sample of positives) {
    assert.ok(BOLD_PAIR.test(sample), `应判为强调但没认出：${sample}`);
    BOLD_PAIR.lastIndex = 0;
  }

  const negatives = [
    // Tailwind v4 后代变体（packages/ui/src/components/ui/command.tsx:121）
    "overflow-hidden p-1 **:[[cmdk-group-heading]]:px-2.5",
    // 单个 ** 不构成成对强调
    "通配符 ** 跨层匹配",
    // 解析器分隔符（ModelConfigHelp.tsx:104 的 split 模式）：** 两侧是别的符号，不构成成对强调
    "text.split(/[**]/g)",
  ];
  for (const sample of negatives) {
    assert.equal(BOLD_PAIR.test(sample), false, `误杀非强调形态：${sample}`);
    BOLD_PAIR.lastIndex = 0;
  }
});

/** 提取器自检：必须取到取值、且不把注释算进来。 */
test("提取器自检：只取字符串取值，注释里的 ** 不算", () => {
  const values = extractStringValues(resolve(repoRoot, "packages/ui/src/i18n/locales/zh-CN.ts"));
  assert.ok(values.length > 5000, `提取到的取值太少（${values.length}），提取器可能坏了`);

  // 已知注释（zh-CN.ts:1292-1293 的措辞红线）里含 **，但它不是取值，不得出现在结果里。
  const fromComment = values.find((entry) => entry.value.includes("自托管"));
  assert.equal(fromComment, undefined, "把注释内容当成了取值 —— 提取器口径错了");
});

/**
 * 注释面的护栏（棘轮口径）。
 *
 * 为什么用棘轮而不是「一律为零」：注释里的成对强调有 2619 处（571 个文件，`git ls-files` 口径），
 * 不可能一次清完。但不清理不等于允许新增：
 *   · 基线里没有的文件出现任何一对 ⇒ 失败（新写的注释不能带 `**`）；
 *   · 某文件的成对强调数超过基线 ⇒ 失败（已清理的文件不能退回去）；
 *   · 低于基线 ⇒ 通过（清理进度单向推进；基线由 `gen-copy-baseline.cjs --write` 收紧）。
 *
 * 口径（必须写明，否则下一个人对不上数字）：
 *   · 只统计 git 跟踪的文件 —— 扫全目录会把 `packages/desktop/mock-cdn|bundled-agents|out|dist-release`
 *     这些生成物算进来，实测得 82798，是真实值的 15 倍；
 *   · 只统计注释正文（用 TS scanner 取注释，剥掉块注释与行注释的定界符）；
 *   · 只统计成对强调（两个星号夹一段文字），并排除非强调形态：glob 通配符与 Tailwind 后代变体。
 *
 * 为什么注释要去 ``：本仓没有配置任何文档生成器**（typedoc/api-extractor/jsdoc 0 命中），
 * 注释不会被渲染成文档页；JSDoc 只在 IDE hover 里加粗，那是开发者工具、不是产品面。
 * 真正的问题是一致性 —— 同一份注释里有的加粗有的不加，读者读不出「哪里真的重要」。
 * 详见 `docs/development/copy-and-format.md` §3（含这条理由的修正记录）。
 */

const BASELINE_PATH = resolve(repoRoot, ".copy-format-baseline.json");
const COMMENT_BOLD_PAIR = /\*\*([^*\n]+)\*\*/g;

/** 非强调形态：按「紧邻字符」判（宽泛字符类会误杀真强调）。 */
function isNonEmphasis(body: string, index: number, whole: string): boolean {
  const before = body[index - 1];
  const after = body[index + whole.length];
  if (before === "/" || after === "/") return true; // glob：/ 或 /
  if (whole[2] === ":" || after === ":") return true; // Tailwind v4 后代变体
  // 脱敏占位符：`***REDACTED***` 里含 `REDACTED`，但两侧是星号 ⇒ 不是 markdown 强调。
  // 实测案例：packages/desktop/src/main/exportLogs.ts 的注释里写着
  // `// postgres://***REDACTED***:***REDACTED***@host`。
  if (before === "*" || after === "*") return true;
  return false;
}

/**
 * 把「非注释」的源码内容涂白（字符串、模板、正则、JSX 文本），只留下注释与代码骨架。
 *
 * 为什么需要涂白，而不是直接用 scanner 扫注释（这是一个实测过的坑）：
 * 裸 `scanner.scan()` 在遇到模板表达式（\`a\${x}b\`）之后会失去同步 ——
 * 之后的注释全部读不到。实测某文件里模板之后还有一行注释含成对强调，
 * 裸 scanner 报 0，而手写状态机与涂白法都报 1。
 * 全仓口径下裸 scanner 漏 705 对（约 21%） ⇒ 它会静默放过新写的强调（假阴性），
 * 而假阴性正是护栏最不能有的缺陷。
 *
 * 涂白法不受影响：字符串/模板整体被替换成空格后，注释边界由 `/*`、`//` 决定，没有解析歧义。
 * 正确性已用手写状态机独立复核（见 §6 的过程纪律）。
 */
function maskNonCommentText(filePath: string, source: string): string {
  const kind = filePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : filePath.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : filePath.endsWith(".ts")
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, true, kind);
  const chars = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i++) if (chars[i] !== "\n") chars[i] = " ";
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isJsxText(node)
    ) {
      blank(node.getStart(sourceFile), node.getEnd());
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return chars.join("");
}

/** 数一段注释正文里的成对强调数。 */
function countPairsIn(body: string): number {
  let count = 0;
  COMMENT_BOLD_PAIR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMMENT_BOLD_PAIR.exec(body)) !== null) {
    if (!isNonEmphasis(body, match.index, match[0])) count++;
  }
  return count;
}

/**
 * 数一个文件注释正文里的成对强调数。
 *
 * 判据是「注释正文」：字符串/模板里的 `` 是产品输出**，不算（见标准 §7.3 ——
 * 飞书卡片消息的 markdown 加粗就属于这一类，清了会把卡片弄坏）。
 */
function countCommentPairs(filePath: string, source: string): number {
  const masked = maskNonCommentText(filePath, source);
  let count = 0;

  // ⚠️ 这里必须逐字符扫描定界符，不能用正则 /\/\*[\s\S]*?\*\// 找块注释。
  // 实测过的坑：行注释里出现 "postgres://***REDACTED***" 时，文本中含有 "/*"，
  // 块注释正则会把它当成块注释起点，一路吃到几百行之后的某个 "*/"，
  // 于是一整段（含其中的行注释）被静默跳过 ⇒ 假阴性。
  // 逐字符扫描没有这个歧义：注释定界符只在「代码态」才生效。
  let index = 0;
  const length = masked.length;
  while (index < length) {
    const two = masked.slice(index, index + 2);
    if (two === "//") {
      const end = masked.indexOf("\n", index);
      const stop = end < 0 ? length : end;
      count += countPairsIn(masked.slice(index + 2, stop));
      index = stop;
      continue;
    }
    if (two === "/*") {
      const end = masked.indexOf("*/", index + 2);
      const stop = end < 0 ? length : end;
      let body = masked.slice(index, stop);
      if (body.startsWith("/**")) body = body.slice(3);
      else body = body.slice(2);
      count += countPairsIn(body);
      index = stop + 2;
      continue;
    }
    index++;
  }
  return count;
}

/**
 * 取要检查的源码文件。
 *
 * 为什么用 git 而不是 readdir：扫全目录会把生成物算进来（`packages/desktop/mock-cdn|bundled-agents|out|dist-release`），
 * 实测让注释强调数从 2619 虚高到 82798（15 倍）。
 *
 * 为什么要连未跟踪文件一起（`--others --exclude-standard`）：只查 `ls-files` 会漏掉
 * 「刚写的新文件」—— 而那恰恰是最可能出现新注释的地方（变异验证实测：新文件里加 `` 时护栏不报**）。
 * 生成物目录都已在 `.gitignore` 里（实测 `git check-ignore` 命中 out/、dist/、mock-cdn/），
 * 所以 `--exclude-standard` 不会把它们带进来。
 */
function scannedSourceFiles(): string[] {
  const run = (args: string[]): string[] =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n")
      .filter((file: string) => /\.(ts|tsx|mjs|cjs|js|jsx)$/.test(file));
  return [
    ...run(["ls-files", "packages", "apps"]),
    ...run(["ls-files", "--others", "--exclude-standard", "packages", "apps"]),
  ];
}

/**
 * 棘轮检查。
 *
 * 失败信息必须让人一眼看懂为什么被拦（这是本测试的第二个用途）：
 * 另一位成员曾把一次确定性失败读成「随机交替红」，因为失败信息里
 * 同时出现「不得超过基线」与「基线被写松了？」两条，重点被盖住。
 * 现在：一个超基线的文件只产生一条失败，并直接给出「哪个文件、超了多少、怎么修」。
 */
test("注释面的棘轮：不得超过基线（新注释不得带 markdown 强调）", () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as {
    files: Record<string, number>;
  };
  const over: { file: string; allowed: number; actual: number; delta: number }[] = [];

  for (const file of scannedSourceFiles()) {
    const source = readFileSync(resolve(repoRoot, file), "utf8");
    if (!source.includes("**")) continue;
    const actual = countCommentPairs(file, source);
    const allowed = baseline.files[file] ?? 0;
    if (actual > allowed) over.push({ file, allowed, actual, delta: actual - allowed });
  }

  if (over.length === 0) return;

  // 超得最多的排最前 —— 那是首先该看的那一个。
  over.sort((a, b) => b.delta - a.delta);
  const detail = over
    .map(
      (o) =>
        `  ${o.file}\n` +
        `      基线 ${o.allowed} → 实际 ${o.actual}（超出 ${o.delta}）` +
        (o.allowed === 0 ? "  ← 基线里没有这个文件：新写的注释不得带 **" : ""),
    )
    .join("\n");

  assert.fail(
    `注释里的 markdown 强调超出基线：${over.length} 个文件\n\n` +
      detail +
      "\n\n怎么修（按顺序判断）：\n" +
      "  1. 正常修法：**删掉注释里的 ** 强调**（改回直接陈述）。规则见 docs/development/copy-and-format.md §3。\n" +
      "  2. 只有在**既有**注释被清理、数字下降时，才运行收紧基线：\n" +
      "     node .reverse/92-copy-format/tools/gen-copy-baseline.cjs --write\n" +
      "  3. **不要**为了让它变绿而手工把基线数字改大 —— 那正是这条棘轮要防的事。",
  );
});

test("基线文件自身一致：total 等于各文件之和，且不含已消失的文件", () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as {
    total: number;
    files: Record<string, number>;
  };
  const entries = Object.entries(baseline.files);
  const sum = entries.reduce((acc, [, n]) => acc + n, 0);
  assert.equal(
    sum,
    baseline.total,
    `基线 total (${baseline.total}) 与各文件之和 (${sum}) 不符 —— 基线被手工改过？\n` +
      "用 gen-copy-baseline.cjs --write 重新生成，不要手改。",
  );

  const missing = entries
    .filter(([file]) => !existsSync(resolve(repoRoot, file)))
    .map(([file]) => file);
  assert.deepEqual(
    missing,
    [],
    "基线里有已经不存在的文件（文件被删/改名后基线没重新生成）：\n" + missing.join("\n"),
  );
});

test("注释判据自检：排除 glob 与 Tailwind 变体，但认出真强调", () => {
  const source = [
    "// 真强调：**这一段很重要**，漏看会出事。",
    "// Tailwind 变体：**:[[cmdk-group-heading]]:px-2 不是强调。",
    "// glob 通配符：**/*.ts 不是强调。",
    "// 裸 ** 单出现也不构成成对。",
  ].join("\n");
  // 4 行注释，只有第 1 行是真强调。
  assert.equal(countCommentPairs("sample.ts", source), 1);
});

/**
 * 提取器的假阴性回归（本轮实测发现并修掉的缺陷）。
 *
 * 缺陷本体：早期实现用裸 `ts.createScanner(...).scan()` 取注释，它在遇到
 * 模板表达式（`\`hello \${name}\``）之后会失去同步 —— 之后的注释全部读不到。
 * 全仓口径下漏 705 对（约 21%）；更糟的是它是假阴性：新写的强调会被静默放过，
 * 而这正是护栏唯一不能有的失效方式（"绿着但没在守"）。
 *
 * 还有一个同族缺陷：用正则 `/\/\*[\s\S]*?\*\//` 找块注释时，行注释里出现
 * `// postgres://***REDACTED***@host` 这种含 `/*` 的文本会被当成块注释起点，
 * 一路吃掉几百行 ⇒ 同样静默漏掉。
 *
 * 这两条都必须钉住：它们不会让任何断言变红，只会让护栏悄悄变弱。
 */
test("提取器回归：模板表达式之后的注释必须仍被读到（防假阴性）", () => {
  const source = [
    "const greeting = `hello ${name} world`;",
    "",
    "// 模板之后的注释：**这一段必须被抓到**",
    "export const probe = 1;",
  ].join("\n");
  assert.equal(
    countCommentPairs("probe.ts", source),
    1,
    "模板表达式之后的注释被漏掉了 —— 提取器又退回了裸 scanner 的写法？",
  );
});

test("提取器回归：行注释里的 /* 不得被当成块注释起点", () => {
  const source = [
    "// postgres://admin:secret@host → postgres://***REDACTED***:***REDACTED***@host",
    "",
    "// 后面这行注释里的 **真强调** 必须仍被读到",
  ].join("\n");
  assert.equal(
    countCommentPairs("probe.ts", source),
    1,
    "含 /* 的行注释把后续内容吃掉了（块注释正则的老问题），或脱敏占位符被误判成强调",
  );
});
