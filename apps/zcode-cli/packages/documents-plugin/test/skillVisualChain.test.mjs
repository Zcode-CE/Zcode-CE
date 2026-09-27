#!/usr/bin/env node
/**
 * 办公技能「视觉检查链」的回归测试（task-13）。
 *
 * 为什么需要它：CE 从 DSH 官方基线搬运 pptx 技能时**丢了视觉链** —— 官方
 * `presentations-plugin/skills/pptx/SKILL.md` 本有 `soffice --headless --convert-to pdf`
 * → `pdftoppm -png -r 150` → dispatch `visual-judge` 三步，CE 的三份办公技能却都写成
 * 「本 build 没有渲染工具」，只把 PDF 交给用户看。**这个缺陷没有任何测试能抓到**：
 * 技能是 Markdown，删掉一段不报错、不失败，只是模型从此不再做视觉检查。
 *
 * 断言打在**最终消费点**：不是「技能文件里有某句话」，而是
 *   ① 三份技能都写出了可执行的两步链与 dispatch 目标；
 *   ② dispatch 用的名字是**运行时真正注册的**那个（不是想当然的 bare name）；
 *   ③ 技能命令调用的引擎在**随包源码里真的存在**（技能与载荷配套）。
 *
 * ② 的依据（实测，非推断）：四个办公插件（documents/presentations/spreadsheets/pdf）
 * 都是 `defaultEnabled: true` 且各带一份 `agents/visual-judge.md` ⇒ 默认安装下
 * `bootstrap/src/subagents.ts:168-173` 会对 bare name 报 `agent_ambiguous_name`，
 * 只注册命名空间形式 `<plugin>:visual-judge`。技能里写 bare `visual-judge` 会让
 * Agent 工具在 `core/src/subagent/runner.ts:742-754` 抛 `UNKNOWN_AGENT_TYPE`。
 *
 * ③ 的依据：链路的两个引擎都在随包代码里 —— `adapters/src/pdf/index.ts`（Poppler 适配器，
 * 由 `bootstrap/src/app/create-app.ts` 默认装配）与 `core/src/tool/handlers/read.ts` 的
 * PDF 分支。它们被删掉时技能会指挥模型做做不到的事，所以必须一并钉住。
 *
 * 本文件是静态断言：它**不能**替代端到端实跑（soffice→pdftoppm→非空白页图），
 * 那一步的证据在 `.reverse/98-ce4/IMPL-OFFICE-VISUAL.md` 的实跑记录里。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(testDir, "..");
const packagesRoot = resolve(pluginRoot, "..");

/** 三个办公插件：技能名、插件名（决定 dispatch 的命名空间前缀）。 */
const OFFICE_PLUGINS = [
  { name: "documents", skill: "docx", artifact: "report.docx" },
  { name: "presentations", skill: "pptx", artifact: "report.pptx" },
  { name: "spreadsheets", skill: "xlsx", artifact: "report.xlsx" },
];

function skillPath({ name, skill }) {
  return join(packagesRoot, `${name}-plugin`, "skills", skill, "SKILL.md");
}

function readSkill(plugin) {
  const path = skillPath(plugin);
  assert.ok(existsSync(path), `技能文件不存在：${path}`);
  return readFileSync(path, "utf8");
}

test("三份办公技能都写出「soffice → pdftoppm → visual-judge」两步链", () => {
  for (const plugin of OFFICE_PLUGINS) {
    const text = readSkill(plugin);
    const label = `${plugin.name}/${plugin.skill}`;

    // 官方基线的两步链：pdftoppm 读 PDF 不读 Office，所以必须先转换。
    assert.match(
      text,
      /soffice --headless --convert-to pdf/,
      `${label}: 缺少 Office→PDF 这一步（官方基线本有，CE 搬运时丢失过）`,
    );
    assert.match(text, /\bpdftoppm\b/, `${label}: 缺少 PDF→图片 这一步`);
    // 第二步必须与第一步的产物对得上，否则命令跑不通。
    assert.match(
      text,
      /pdftoppm -png -r \d+ <out_dir>\/report\.pdf/,
      `${label}: pdftoppm 的输入不是上一步产出的 PDF`,
    );

    // 不能退回「本 build 没有渲染工具」这句已被实测证伪的旧表述。
    assert.doesNotMatch(
      text,
      /no document-rendering tool/i,
      `${label}: 仍写着「没有渲染工具」——该表述与实测不符（Read 的 PDF pages 分支 + Poppler 适配器本就在随包代码里）`,
    );

    // 两步链必须接到视觉评审上，否则只是「转出 PDF 给用户看」的单向路径。
    assert.match(
      text,
      new RegExp(`\`${plugin.name}:visual-judge\``),
      `${label}: 未 dispatch 命名空间形式的 \`${plugin.name}:visual-judge\``,
    );
    // 该 agent 文件必须真的存在，否则 dispatch 必然失败。
    assert.ok(
      existsSync(join(packagesRoot, `${plugin.name}-plugin`, "agents", "visual-judge.md")),
      `${label}: dispatch 目标 agents/visual-judge.md 不存在`,
    );
  }
});

test("dispatch 用的是运行时真正注册的名字（bare name 在默认安装下是歧义的）", () => {
  // 四个办公插件都 defaultEnabled 且各带一份 visual-judge ⇒ 只有命名空间形式可用。
  const defaultEnabledOfficePlugins = ["documents", "pdf", "presentations", "spreadsheets"];
  const withAgent = defaultEnabledOfficePlugins.filter((name) =>
    existsSync(join(packagesRoot, `${name}-plugin`, "agents", "visual-judge.md")),
  );
  assert.equal(
    withAgent.length,
    4,
    "四个办公插件都应带 visual-judge.md（决定 bare name 是否歧义的前提）",
  );

  for (const plugin of OFFICE_PLUGINS) {
    const text = readSkill(plugin);
    // 反向断言：不能出现「裸名 + 空格/引号收尾」的调用写法。
    assert.ok(
      !text.includes("dispatch the `visual-judge`"),
      `${plugin.name}/${plugin.skill}: 用了 bare \`visual-judge\`，默认安装下 Agent 工具会报 UNKNOWN_AGENT_TYPE`,
    );
  }
});

test("技能命令调用的引擎在随包源码里真的存在（技能与载荷配套）", () => {
  const adapter = readFileSync(join(packagesRoot, "adapters", "src", "pdf", "index.ts"), "utf8");
  assert.match(
    adapter,
    /file: "pdftoppm"/,
    "Poppler 适配器不再调用 pdftoppm —— 技能里的第二步将无引擎可依",
  );
  assert.match(
    adapter,
    /export function createPopplerPdfDocumentAdapter/,
    "Poppler 适配器的工厂函数缺失",
  );

  const readHandler = readFileSync(
    join(packagesRoot, "core", "src", "tool", "handlers", "read.ts"),
    "utf8",
  );
  assert.match(
    readHandler,
    /isPdfPath\(filePath\) && supportsPdfForExecution\(context\)/,
    "Read 工具的 PDF 分支缺失 —— 技能里「直接 Read 该 PDF 拿页图」的捷径将不成立",
  );

  const createApp = readFileSync(
    join(packagesRoot, "bootstrap", "src", "app", "create-app.ts"),
    "utf8",
  );
  assert.match(
    createApp,
    /createPopplerPdfDocumentAdapter/,
    "Poppler 适配器不再被默认装配 —— 页图通路在运行时不会存在",
  );
});

test("空白预览语义与模型能力前置判定都已写入三份技能", () => {
  for (const plugin of OFFICE_PLUGINS) {
    const text = readSkill(plugin);
    const label = `${plugin.name}/${plugin.skill}`;

    // A2（DSH rc.2）：空白/全透明预览 = 渲染器失败，不是文档有问题。
    assert.match(
      text,
      /is a renderer failure, not/,
      `${label}: 缺少「空白预览 = 渲染器失败」规则 —— 模型会把渲染故障误判成文档缺陷去改一份本来正确的文档`,
    );
    assert.match(
      text,
      /stop all visual QA for (this|that)/i,
      `${label}: 缺少「立即停止该文档全部视觉 QA」`,
    );
    assert.match(
      text,
      /do not (retry|try)/,
      `${label}: 缺少「不得换范围/分辨率/格式重试」`,
    );

    // 模型能力硬门禁：read-pdf.ts 在 supportsImage === false 时直接拒绝 pages。
    assert.match(
      text,
      /Establish that the current model accepts images before rendering/,
      `${label}: 缺少模型图片能力前置判定`,
    );
    assert.match(
      text,
      /do not rasterize/,
      `${label}: 缺少「模型读不了图时不要生成读不了的预览」`,
    );

    // 引擎选择权属于用户（AGENTS.md）：不得照搬官方的「必须安装」口径。
    assert.match(
      text,
      /The engine choice is the user's/,
      `${label}: 缺少「引擎选择权属于用户」`,
    );
    assert.doesNotMatch(
      text,
      /You MUST install|This is not a choice|is not a reason to skip/i,
      `${label}: 出现了官方那种剥夺用户拒绝权的「必须安装」口径，与 AGENTS.md 冲突`,
    );

    // 无渲染器时必须如实说明，不得静默降级。
    // xlsx 措辞有意不同：数据/公式任务本就没有要跑的视觉检查，只有用户要求过才谈得上「跳过」。
    assert.match(
      text,
      /do not silently skip/,
      `${label}: 缺少「缺渲染器时如实说明未做、不静默降级」`,
    );
  }
});

test("xlsx 按任务分情况：数据/公式任务跳过视觉检查且不加未请求的免责声明", () => {
  const text = readSkill({ name: "spreadsheets", skill: "xlsx" });

  assert.match(
    text,
    /For data and formula tasks, stop here/,
    "xlsx: 缺少「数据/公式任务到此为止」的分支",
  );
  assert.match(
    text,
    /do \*\*not\*\* add an unrequested caveat that visual inspection was omitted/,
    "xlsx: 数据/公式任务仍会输出未请求的「未做视觉检查」免责声明（用户可见噪声）",
  );
  assert.match(
    text,
    /Inspect a rendered region only when the task concerns formatting, layout/,
    "xlsx: 缺少「只有排版/布局类任务才做视觉检查」的判据",
  );

  // 反向断言：docx/pptx 不该出现这条 xlsx 专属分支。
  for (const plugin of OFFICE_PLUGINS.filter((p) => p.skill !== "xlsx")) {
    assert.doesNotMatch(
      readSkill(plugin),
      /For data and formula tasks, stop here/,
      `${plugin.name}/${plugin.skill}: 误加了 xlsx 专属的数据/公式任务分支`,
    );
  }
});

test("frontmatter 的 metadata.modified 与本次改动同步（office-plugins.md §3.1 约定）", () => {
  for (const plugin of OFFICE_PLUGINS) {
    const text = readSkill(plugin);
    const frontmatter = text.split("---")[1] ?? "";
    assert.match(
      frontmatter,
      /modified: "/,
      `${plugin.name}/${plugin.skill}: frontmatter 缺少 metadata.modified`,
    );
    assert.match(
      frontmatter,
      /visual-judge/,
      `${plugin.name}/${plugin.skill}: metadata.modified 未记录本次视觉链改动`,
    );
  }
});
