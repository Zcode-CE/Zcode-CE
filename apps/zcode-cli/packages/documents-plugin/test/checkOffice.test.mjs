#!/usr/bin/env node
/**
 * check_office 资源预算回归测试（S5 安全修复，OFFICE-5 起主路径为 JS 实现）。
 *
 * 为什么需要这组测试：check_office 的调用方是 LLM agent（见 skills/docx/SKILL.md 的
 * 「Check and deliver」），输入来自用户文档或网络下载，属不可信输入。修复前脚本对解压
 * 体积没有任何上限，安全复查实测 2.09 MB 的 ZIP 可解出 2 GiB、子进程峰值 RSS 4116 MiB；
 * 更严重的是 2 GiB 夹具上 OverflowError 逃逸，脚本「退出码 1 但 stdout 为空」，调用方
 * 无法区分「文档结构不合法」与「检查器崩了」。
 *
 * 断言的是**契约**而不是具体阈值：任何超预算输入都必须产出结构化 JSON fail + 非空
 * detail，绝不允许空 stdout / 裸堆栈。阈值写死在断言里会让调参变成改测试。
 *
 * 两条路径都要过：
 * - `scripts/check_office.mjs`（技能正文调用的主路径，纯 Node，无第三方依赖）；
 * - `scripts/check_office.py`（保留的 Python 按需增强路径），有 python3 时一并跑，
 *   缺失时明确 skip，不假装通过。
 *
 * 内存口径：Node 在 RLIMIT_AS=512 MiB 下**连进程都起不来**（V8 预留虚拟地址空间，
 * 实测 rc=-5 "Fatal process out of memory: SegmentedTable::InitializeTable"），
 * 所以硬上限只对 Python 用 RLIMIT_AS；Node 侧改用 --max-old-space-size 限制堆，
 * 并额外断言进程确实活着且给出了结构化输出（真正的失效形态是空 stdout + 裸堆栈）。
 * 元素预算能否真正约束峰值内存，由下面的「元素密集」用例锁定（实测该用例曾出现
 * 1182 MiB 的回归，是 .py 的 5 倍）。
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(testDir, "..");
const packagesRoot = resolve(pluginRoot, "..");
const repoRoot = resolve(packagesRoot, "..", "..", "..");

const OFFICE_PLUGINS = [
  { name: "documents", skill: "docx" },
  { name: "presentations", skill: "pptx" },
  { name: "spreadsheets", skill: "xlsx" },
];

function pythonAvailable() {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasPython = pythonAvailable();

/**
 * 夹具生成 + 受限执行。
 *
 * RLIMIT_AS 是这组测试的关键：它在**内核层**给子进程设硬内存上限，所以「修复失效」
 * 会表现为子进程真的 OOM（空 stdout + Traceback），而不是仅仅断言一个数字。
 * 这也让测试在没有 cgroup 的机器上同样有判别力。
 */
const PROBE = `
import json, os, resource, subprocess, sys, zipfile

runner, script, workdir, limit_mb = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
MAIN = ('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/'
        'wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p>'
        '</w:body></w:document>')
CT = ('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/'
      'content-types"><Override PartName="/word/document.xml" ContentType="application/'
      'vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')

def seed(z):
    z.writestr("[Content_Types].xml", CT)
    z.writestr("word/document.xml", MAIN)

def make_ok(path):
    """正常小文档：预算内，必须仍然 pass（防止把真实文档一起拒掉）。"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        seed(z)
    return path

def make_oversized(path):
    """声明 300 MiB 的成员：磁盘只有几百 KB，放大比约 1000:1，与复查报告同型。"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        seed(z)
        with z.open("bomb.xml", "w") as f:
            for _ in range(300 * 4):
                f.write(b"<x/>" * 65536)
    return path

def make_media_heavy(path, media_mb=160):
    """真实形状的大文档：小 document.xml + 大体积、压不动的 media。

    预算只应作用于会被读进内存的 XML 成员。若把图片也算进总预算，这种正常的
    扫描件/照片文档会被误判为超预算而拒收 —— 这是本测试锁死的回归点。
    """
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        seed(z)
        blob = os.urandom(1024 * 1024)
        with z.open("word/media/image1.png", "w") as f:
            for _ in range(media_mb):
                f.write(blob)
    return path

def make_element_dense(path, elements=3_000_000):
    """声明体积在字节预算内，但元素数远超元素预算。

    这条覆盖「只按字节设限仍会 OOM」的绕过路径：实测 67.1 MB 的成员能解析出
    1677 万个元素、峰值 RSS 1583 MiB，仅靠字节预算拦不住。
    """
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        seed(z)
        with z.open("bomb.xml", "w") as f:
            f.write(b"<r>")
            written = 0
            while written < elements:
                f.write(b"<x/>" * 65536)
                written += 65536
            f.write(b"</r>")
    return path

def limit():
    """Python 侧：内核层硬上限，修复失效会真的 OOM 而不是只断言一个数字。"""
    resource.setrlimit(resource.RLIMIT_AS, (limit_mb * 1024 * 1024,) * 2)

def no_limit():
    return None

def command(path):
    """
    Node 侧不能设 RLIMIT_AS：V8 启动就要预留大段虚拟地址空间，512 MiB 下连
    "node --version" 都跑不起来（rc=-5，Fatal process out of memory）。改用
    --max-old-space-size 限制 JS 堆，并把进程是否活着交给断言判断。
    """
    if runner == "node":
        return ["node", "--max-old-space-size=%d" % limit_mb, script, path], no_limit
    return [sys.executable, script, path], limit

result = {}
for label, maker in (("ok", make_ok), ("oversized", make_oversized), ("dense", make_element_dense),
                     ("media", make_media_heavy)):
    path = maker(os.path.join(workdir, label + ".docx"))
    argv, preexec = command(path)
    proc = subprocess.run(argv, capture_output=True, text=True, preexec_fn=preexec)
    result[label] = {
        "diskBytes": os.path.getsize(path),
        "declaredBytes": sum(i.file_size for i in zipfile.ZipFile(path).infolist()),
        "rc": proc.returncode,
        "stdout": proc.stdout,
        "traceback": "Traceback" in proc.stderr,
        "stack": "Error" in proc.stderr,
        "peakMiB": round(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024),
    }
print(json.dumps(result))
`;

/**
 * 在 RLIMIT_AS=512 MiB 下跑全部夹具，返回脚本自身的输出。
 * 结果按脚本路径记忆化：同一份脚本跑一次就够（夹具生成 + 4 次受限子进程约 5s），
 * 重复执行只会拖长测试时长。测试文件内 node:test 顺序执行，不存在并发竞态。
 */
const probeCache = new Map();

function runProbe(runner, scriptPath, limitMiB) {
  const key = runner + " " + scriptPath + " " + limitMiB;
  const cached = probeCache.get(key);
  if (cached) return cached;
  const result = runProbeUncached(runner, scriptPath, limitMiB);
  probeCache.set(key, result);
  return result;
}

function runProbeUncached(runner, scriptPath, limitMiB) {
  const workdir = mkdtempSync(join(tmpdir(), "zcode-check-office-"));
  const probePath = join(workdir, "probe.py");
  try {
    writeFileSync(probePath, PROBE, "utf8");
    const out = execFileSync(
      "python3",
      [probePath, runner, scriptPath, workdir, String(limitMiB)],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return JSON.parse(out);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/** 断言「结构化 fail」契约：JSON、verdict=fail、detail 非空、无 traceback。 */
function assertStructuredFail(probe, label) {
  assert.notEqual(
    probe.stdout.trim(),
    "",
    `${label}: stdout 不能为空（空 stdout 正是修复前的失效形态）`,
  );
  assert.equal(probe.traceback, false, `${label}: 不允许裸 traceback`);
  const report = JSON.parse(probe.stdout);
  assert.equal(report.verdict, "fail", `${label}: 超预算输入必须判 fail`);
  const failed = report.checks.find((check) => check.status === "fail");
  assert.ok(failed, `${label}: 必须有 status=fail 的 check`);
  assert.ok(
    typeof failed.detail === "string" && failed.detail.trim().length > 0,
    `${label}: detail 必须非空且可读（MemoryError 的 str() 是空串，所以脚本有兜底）`,
  );
  return failed.detail;
}

const scriptFor = ({ name }) => join(packagesRoot, `${name}-plugin`, "scripts", "check_office.py");
const jsScriptFor = ({ name }) =>
  join(packagesRoot, `${name}-plugin`, "scripts", "check_office.mjs");
/** JS 校验器的全部文件（入口 + lib/ 下按职责拆分的模块）。 */
const JS_CHECKER_FILES = [
  "check_office.mjs",
  "lib/office-spec.mjs",
  "lib/office-zip.mjs",
  "lib/office-xml-lex.mjs",
  "lib/office-xml-decl.mjs",
  "lib/office-xml-tree.mjs",
  "lib/office-xml-scan.mjs",
  "lib/office-parts.mjs",
  "lib/office-cli.mjs",
  "lib/office-main.mjs",
];

test("三份 check_office.py / check_office.mjs（含 lib/ 模块）逐字节一致（三插件无版本漂移）", () => {
  const files = [["check_office.py", scriptFor], ...JS_CHECKER_FILES.map((f) => [f, jsScriptFor])];
  for (const [label, pathFor] of files) {
    const hashes = OFFICE_PLUGINS.map((plugin) => {
      const base = pathFor(plugin);
      const file = label === "check_office.py" ? base : join(dirname(base), label);
      return createHash("sha256").update(readFileSync(file)).digest("hex");
    });
    assert.equal(new Set(hashes).size, 1, `三份 ${label} 内容不一致: ${JSON.stringify(hashes)}`);
  }
});

/**
 * 两条实现路径的同型断言集合。
 *
 * 为什么要跑两遍：技能正文调用的主路径是 `check_office.mjs`（纯 Node），
 * `check_office.py` 是保留的 Python 按需增强路径。安全契约（超预算必结构化 fail、
 * 媒体不计入预算、正常文档不被误伤）对两者都成立，所以断言逐条复用，
 * 而不是给 JS 另写一套更弱的断言。
 *
 * 阈值：Python 用 RLIMIT_AS=512 MiB（内核硬上限）；Node 用 --max-old-space-size=512
 * （RLIMIT_AS 下 V8 起不来，见文件头）。
 */
const IMPLEMENTATIONS = [
  { label: "check_office.mjs", runner: "node", pathFor: jsScriptFor, limitMiB: 512 },
  {
    label: "check_office.py",
    runner: "python3",
    pathFor: scriptFor,
    limitMiB: 512,
    skip: hasPython ? false : "需要 python3",
  },
];

for (const implementation of IMPLEMENTATIONS) {
  const skip = implementation.skip ?? false;
  const probe = () =>
    runProbe(
      implementation.runner,
      implementation.pathFor(OFFICE_PLUGINS[0]),
      implementation.limitMiB,
    );

  test(`[${implementation.label}] 超预算 ZIP 返回结构化 fail，而不是 OOM`, { skip }, () => {
    const oversized = probe().oversized;
    assert.equal(oversized.rc, 1, "超预算输入的退出码应为 1");
    // 夹具本身必须真是「小磁盘、大解压」，否则测试没在测东西。
    assert.ok(
      oversized.declaredBytes > 256 * 1024 * 1024,
      `夹具应声明超过 256 MiB，实际 ${oversized.declaredBytes}`,
    );
    assert.ok(
      oversized.diskBytes < 4 * 1024 * 1024,
      `夹具磁盘体积应远小于解压体积，实际 ${oversized.diskBytes}`,
    );
    const detail = assertStructuredFail(oversized, "oversized");
    assert.match(detail, /limit|budget/i, `detail 应说明是预算问题，实际: ${detail}`);
  });

  test(
    `[${implementation.label}] 元素密集 XML 返回结构化 fail（只按字节设限挡不住的绕过路径）`,
    { skip },
    () => {
      const dense = probe().dense;
      assert.ok(
        dense.declaredBytes < 256 * 1024 * 1024,
        `夹具声明体积应落在字节预算内（否则测的是字节预算而非元素预算），实际 ${dense.declaredBytes}`,
      );
      const detail = assertStructuredFail(dense, "dense");
      assert.match(detail, /element/i, `detail 应说明是元素数问题，实际: ${detail}`);
    },
  );

  test(`[${implementation.label}] 正常小文档仍然 pass（预算不误伤真实文档）`, { skip }, () => {
    const ok = probe().ok;
    assert.equal(ok.rc, 0, "正常文档应 rc=0");
    const report = JSON.parse(ok.stdout);
    assert.equal(report.verdict, "pass");
    assert.equal(report.checks[0].status, "pass");
  });

  test(
    `[${implementation.label}] 图片密集的大文档不被预算误伤（预算只作用于会被读进内存的 XML 成员）`,
    { skip },
    () => {
      const media = probe().media;
      // 夹具本身必须真的是「大 media + 极小 XML」，否则测不到这条边界。
      assert.ok(
        media.declaredBytes > 128 * 1024 * 1024,
        `media 夹具应超过 128 MiB，实际 ${media.declaredBytes}`,
      );
      assert.equal(media.rc, 0, "图片密集的正常文档必须仍然 rc=0（不得被总预算拒收）");
      assert.equal(JSON.parse(media.stdout).verdict, "pass");
    },
  );
}

/**
 * 元素预算必须真的约束峰值内存，而不只是报个错。
 *
 * 为什么单独锁这条：**「保留 MAX_* 常量」不等于「内存有界」**。实测同一元素密集夹具：
 * - 正确实现（作用域链式 + 属性扁平数组 + children 按需 + 按需读 fd）：**281~285 MiB**；
 * - 还原两个根因后（每元素一个 Map、整包 readFileSync）：**713~717 MiB**，且在
 *   --max-old-space-size=512 下直接崩（rc=-6、空 stdout、裸堆栈）。
 * 阈值取 **500 MiB**：对正确实现有 1.75x 余量，对上述回归有 1.43x 判别力。
 * （早先写成 900 MiB 时该回归能蒙混过关 —— 断言必须对着可复现的回归值标定。）
 *
 * 注意这条断言与「结构化 fail」用例是互补的：回归版本会**崩**（空 stdout）被那条抓住；
 * 这条负责抓住「不崩但内存失控」的变体。
 */
const MAX_DENSE_PEAK_MIB = 500;

test(
  "[check_office.mjs] 元素密集输入的峰值内存受元素预算约束",
  { skip: hasPython ? false : "需要 python3（探针本身用 python3 度量）" },
  () => {
    const dense = runProbe("node", jsScriptFor(OFFICE_PLUGINS[0]), 512).dense;
    assert.ok(
      dense.peakMiB < MAX_DENSE_PEAK_MIB,
      `元素密集夹具峰值 RSS 应受预算约束（实测回归值 713~717 MiB），实际 ${dense.peakMiB} MiB`,
    );
  },
);

test("三份 staging 清单都登记了三个 office 插件（V-2）", () => {
  // SEA 清单没有顶层副作用，直接 import 做**真实**断言，并实跑一次资源收集。
  const seaPath = join(
    repoRoot,
    "apps",
    "zcode-cli",
    "packages",
    "cli",
    "scripts",
    "sea-official-plugin-assets.mjs",
  );
  const seaSource = readFileSync(seaPath, "utf8");
  for (const { name } of OFFICE_PLUGINS) {
    assert.match(seaSource, new RegExp(`name: "${name}"`), `SEA 清单缺少 ${name}`);
  }
  assert.match(
    seaSource,
    /requiresRuntime: false/,
    "SEA 清单里 office 插件应标 requiresRuntime: false",
  );
  assert.doesNotMatch(
    seaSource,
    /runtimeBuildScript/,
    "内容型插件不应出现 runtimeBuildScript（SEA 清单本就没有该字段）",
  );

  // 另两份清单在 import 时会执行真实构建（buildCliBundle 等），所以做静态断言；
  // 真实 staging 由交付说明里的实跑证据覆盖。
  const manifests = [
    {
      path: join(repoRoot, "packages", "desktop", "scripts", "prepare-agent-node-bundle.mjs"),
      table: "officePluginPackages",
      list: "officialPluginPackages",
    },
    {
      path: join(repoRoot, "scripts", "prepare-prebuilds.mjs"),
      table: "remoteOfficePluginPackages",
      list: "remoteOfficialPluginPackages",
    },
  ];
  for (const manifest of manifests) {
    const source = readFileSync(manifest.path, "utf8");
    assert.ok(
      source.includes(`const ${manifest.table} = [`),
      `${manifest.path} 缺少 ${manifest.table}`,
    );
    assert.ok(
      source.includes(`...${manifest.table}.map(`),
      `${manifest.path} 的 ${manifest.list} 未展开 ${manifest.table}`,
    );
    for (const { name, skill } of OFFICE_PLUGINS) {
      assert.match(
        source,
        new RegExp(`name: "${name}", skill: "${skill}"`),
        `${manifest.path} 缺少 ${name}`,
      );
    }
    // 关键回归点：内容型插件不得被要求构建 runtime。
    assert.match(
      source,
      /requiresRuntime: false/,
      `${manifest.path} 里 office 插件应标 requiresRuntime: false`,
    );
  }
});
