import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Release 流水线引用发行包路径的护栏（task-122）。
 *
 * 为什么需要它：release.yml 的 Smoke / Upload / Attach 三步曾写成
 * `dist/zcode/releases/*.tar.gz`，而 build-zcode.mjs 的产物是
 * `dist/zcode/releases/<版本>/zcode-<版本>.tar.gz` —— 中间多一层版本目录。
 * 该 glob 匹配不到任何文件时，bash 默认 nullglob 关闭，会把字面量 `*.tar.gz` 原样传给脚本，
 * tar 报「无法 open」并以 status 2 退出，直接阻断 npm 发布；文档里的同一条命令读者照跑也必失败。
 *
 * 这个护栏把「release.yml 引用的路径」与「build-zcode.mjs 声明的产物布局」对账。
 * 两侧都是现读的，不写第二份布局常量，所以任何一侧改了形状都会红。
 * 它守不住的东西写在文件末尾，别把它当成布局本身的证明。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowDir = resolve(repoRoot, ".github/workflows");
const releaseWorkflowPath = resolve(workflowDir, "release.yml");
const buildScriptPath = resolve(repoRoot, "scripts/build-zcode.mjs");
const headlessDocPath = resolve(repoRoot, "docs/operations/headless-server.md");

/**
 * 去掉整行注释后再扫。
 *
 * 为什么必须去掉：release.yml 与文档里都用 `releases/*.tar.gz` 当反例解释这个缺陷，
 * 扫描它们会逼后来者删掉解释材料，护栏就从「防复发」退化成「防写注释」。
 */
function executableLines(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
}

/** 取出 markdown 里的 bash 代码块（只有代码块里的命令是可执行的，正文与表格是描述）。 */
function bashFences(markdown) {
  const blocks = [];
  let inFence = false;
  let keep = false;
  let buffer = [];
  for (const line of markdown.split("\n")) {
    const fence = /^\s*```(\S*)\s*$/u.exec(line);
    if (fence) {
      if (inFence && keep) blocks.push(buffer.join("\n"));
      inFence = !inFence;
      keep = inFence && (fence[1] === "bash" || fence[1] === "sh");
      buffer = [];
      continue;
    }
    if (inFence && keep) buffer.push(line);
  }
  return blocks;
}

/** 找出所有 `dist/zcode/releases/<段>` 引用，返回 releases/ 之后的第一段。 */
function releasesReferences(text) {
  const found = [];
  for (const match of text.matchAll(/dist\/zcode\/releases\/([^\s"'\\)]*)/gu)) {
    found.push({
      reference: match[0],
      segment: match[1].split("/")[0],
    });
  }
  return found;
}

/**
 * 不变式：`dist/zcode/releases/` 之后必须是版本目录。
 *
 * 判据是「该段以 $ 开头」（shell 变量或 ${{ }} 表达式）。为什么不用「含通配符即可」：
 * releases 下补一层通配符在结构上对得上，但会连历史版本一起匹配 —— smoke 只读 argv[2]，
 * 且 glob 按字典序 ⇒ 可能「测旧版、发新版」，是静默漏测，比报错更危险。
 */
function assertVersionQualified(label, text) {
  for (const { reference, segment } of releasesReferences(executableLines(text))) {
    assert.ok(
      segment.startsWith("$"),
      label +
        "：" +
        reference +
        " 里 releases/ 之后必须是版本目录（如 $VERSION 或 ${{ ... }}），实际是 " +
        JSON.stringify(segment) +
        "。产物布局是 releases/<版本>/<文件>（见 scripts/build-zcode.mjs 的 releaseDir）：" +
        "少一层会匹配不到（tar status 2），用 * 通配会连历史版本一起取到。",
    );
  }
}

/**
 * 从布局的所有者（build-zcode.mjs）现读产物形状，不在这里写第二份。
 * 读不到就失败而不是跳过 —— 源码改了形状时，护栏必须把人叫过来，不能静默放行。
 */
function declaredLayout() {
  const source = readFileSync(buildScriptPath, "utf8");
  const read = (pattern, what) => {
    const match = pattern.exec(source);
    assert.ok(
      match,
      "scripts/build-zcode.mjs 里读不到" +
        what +
        " —— 发行包布局的所有者变了，请同步本护栏与 release.yml",
    );
    return match[1];
  };
  const packageDirName = read(/const packageDirName = "([^"]+)";/u, "packageDirName");
  read(/const releaseDir = resolve\(outDir, "releases", version\);/u, "releaseDir 的声明");
  const tarballTemplate = read(/const tarballName = `([^`]+)`;/u, "tarballName 的声明");
  const checksum = read(/writeFile\(resolve\(releaseDir, "([^"]+)"\)/u, "sha256 的写入");
  assert.equal(
    tarballTemplate.replaceAll("${packageDirName}", packageDirName).replaceAll("${version}", "<v>"),
    packageDirName + "-<v>.tar.gz",
    "build-zcode.mjs 的 tarballName 形状变了，release.yml 的声明路径需要同步",
  );
  return { checksum, packageDirName };
}

/** 取 build 步骤写进 GITHUB_OUTPUT 的两个路径声明。 */
function declaredOutputs(workflow) {
  const body = executableLines(workflow);
  const read = (name) => {
    const match = new RegExp('echo "' + name + '=([^"]*)" >> "\\$GITHUB_OUTPUT"', "u").exec(body);
    return match ? match[1] : undefined;
  };
  return { sha256: read("sha256"), tarball: read("tarball") };
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

test("release.yml 里可执行的 releases 引用必须带版本目录", () => {
  assertVersionQualified(
    ".github/workflows/release.yml",
    readFileSync(releaseWorkflowPath, "utf8"),
  );
});

test("其余 workflow 与无头文档的可复现命令同样不得少一层", () => {
  for (const name of readdirSync(workflowDir)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    assertVersionQualified(
      ".github/workflows/" + name,
      readFileSync(resolve(workflowDir, name), "utf8"),
    );
  }
  const fences = bashFences(readFileSync(headlessDocPath, "utf8"));
  assert.ok(
    fences.length > 0,
    "docs/operations/headless-server.md 里没有 bash 代码块，扫描范围失效",
  );
  for (const block of fences) {
    assertVersionQualified("docs/operations/headless-server.md 的 bash 代码块", block);
  }
});

test("release.yml 声明的产物路径与 build-zcode.mjs 的布局一致", () => {
  const layout = declaredLayout();
  const { version } = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const outputs = declaredOutputs(readFileSync(releaseWorkflowPath, "utf8"));
  assert.ok(outputs.tarball, "build 步骤没有把 tarball 路径写进 GITHUB_OUTPUT");
  assert.ok(outputs.sha256, "build 步骤没有把 sha256 路径写进 GITHUB_OUTPUT");
  const resolveVersion = (value) =>
    value.replaceAll("${VERSION}", version).replaceAll("$VERSION", version);
  assert.equal(
    resolveVersion(outputs.tarball),
    "dist/zcode/releases/" + version + "/" + layout.packageDirName + "-" + version + ".tar.gz",
    "release.yml 的 tarball 路径与 build-zcode.mjs 的布局不一致",
  );
  assert.equal(
    resolveVersion(outputs.sha256),
    "dist/zcode/releases/" + version + "/" + layout.checksum,
    "release.yml 的 sha256 路径与 build-zcode.mjs 的布局不一致（它同样在版本目录里）",
  );
});

test("smoke / upload / attach 三步消费声明的输出，不自己拼路径", () => {
  const body = executableLines(readFileSync(releaseWorkflowPath, "utf8"));
  const tarball = countOccurrences(body, "${{ steps.build_package.outputs.tarball }}");
  const sha256 = countOccurrences(body, "${{ steps.build_package.outputs.sha256 }}");
  assert.ok(
    tarball >= 3,
    "只有 " +
      tarball +
      " 处引用 tarball 输出：smoke / upload / attach 三步都该用它（自己拼路径会绕过上面的对账）",
  );
  assert.ok(
    sha256 >= 2,
    "只有 " + sha256 + " 处引用 sha256 输出：upload / attach 两步都该带上它（漏传是静默失败）",
  );
});

/**
 * 本护栏守不住的东西（如实登记，别把它当布局本身的证明）：
 * 1. 它断言的是「release.yml 与 build-zcode.mjs 对布局的声明一致」，不是「真实产物落在那里」。
 *    CI 的 verify job 不构建发行包，所以这条只能靠下面的本机核对兜。
 * 2. 真实产物的核对在本机跑（分发包存在时），CI 上会显式 skip，不静默通过。
 */
test("真实产物落在声明的路径上（分发包未构建时显式 skip）", async (t) => {
  const { version } = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const layout = declaredLayout();
  const tarball = resolve(
    repoRoot,
    "dist/zcode/releases",
    version,
    layout.packageDirName + "-" + version + ".tar.gz",
  );
  const { existsSync } = await import("node:fs");
  if (!existsSync(tarball)) {
    t.skip("分发包未构建：先跑 pnpm build:zcode 再跑本用例");
    return;
  }
  assert.ok(
    existsSync(resolve(repoRoot, "dist/zcode/releases", version, layout.checksum)),
    "版本目录里没有 " + layout.checksum + "，release.yml 的 upload/attach 会静默少传它",
  );
});
