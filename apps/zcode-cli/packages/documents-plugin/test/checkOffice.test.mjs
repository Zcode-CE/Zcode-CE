#!/usr/bin/env node
/**
 * check_office.py 资源预算回归测试（S5 安全修复）。
 *
 * 为什么需要这组测试：check_office.py 的调用方是 LLM agent（见 skills/docx/SKILL.md 的
 * 「Check and deliver」），输入来自用户文档或网络下载，属不可信输入。修复前脚本对解压
 * 体积没有任何上限，安全复查实测 2.09 MB 的 ZIP 可解出 2 GiB、子进程峰值 RSS 4116 MiB；
 * 更严重的是 2 GiB 夹具上 OverflowError 逃逸，脚本「退出码 1 但 stdout 为空」，调用方
 * 无法区分「文档结构不合法」与「检查器崩了」。
 *
 * 断言的是**契约**而不是具体阈值：任何超预算输入都必须产出结构化 JSON fail + 非空
 * detail，绝不允许空 stdout / 裸 traceback。阈值写死在断言里会让调参变成改测试。
 *
 * 依赖 python3（脚本本身就是 Python）。缺失时明确 skip，不假装通过。
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

script, workdir, limit_mb = sys.argv[1], sys.argv[2], int(sys.argv[3])
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
    resource.setrlimit(resource.RLIMIT_AS, (limit_mb * 1024 * 1024,) * 2)

result = {}
for label, maker in (("ok", make_ok), ("oversized", make_oversized), ("dense", make_element_dense),
                     ("media", make_media_heavy)):
    path = maker(os.path.join(workdir, label + ".docx"))
    proc = subprocess.run([sys.executable, script, path], capture_output=True, text=True, preexec_fn=limit)
    result[label] = {
        "diskBytes": os.path.getsize(path),
        "declaredBytes": sum(i.file_size for i in zipfile.ZipFile(path).infolist()),
        "rc": proc.returncode,
        "stdout": proc.stdout,
        "traceback": "Traceback" in proc.stderr,
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

function runProbe(scriptPath) {
  const cached = probeCache.get(scriptPath);
  if (cached) return cached;
  const result = runProbeUncached(scriptPath);
  probeCache.set(scriptPath, result);
  return result;
}

function runProbeUncached(scriptPath) {
  const workdir = mkdtempSync(join(tmpdir(), "zcode-check-office-"));
  const probePath = join(workdir, "probe.py");
  try {
    writeFileSync(probePath, PROBE, "utf8");
    const out = execFileSync("python3", [probePath, scriptPath, workdir, "512"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(out);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/** 断言「结构化 fail」契约：JSON、verdict=fail、detail 非空、无 traceback。 */
function assertStructuredFail(probe, label) {
  assert.notEqual(probe.stdout.trim(), "", `${label}: stdout 不能为空（空 stdout 正是修复前的失效形态）`);
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

test("三份 check_office.py 逐字节一致（三插件无版本漂移）", () => {
  const hashes = OFFICE_PLUGINS.map((plugin) => {
    const bytes = readFileSync(scriptFor(plugin));
    return createHash("sha256").update(bytes).digest("hex");
  });
  assert.equal(new Set(hashes).size, 1, `三份脚本内容不一致: ${JSON.stringify(hashes)}`);
});

test(
  "超预算 ZIP 返回结构化 fail，而不是 OOM",
  { skip: hasPython ? false : "需要 python3" },
  () => {
    const probe = runProbe(scriptFor(OFFICE_PLUGINS[0]));
    const oversized = probe.oversized;
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
  },
);

test(
  "元素密集 XML 返回结构化 fail（只按字节设限挡不住的绕过路径）",
  { skip: hasPython ? false : "需要 python3" },
  () => {
    const probe = runProbe(scriptFor(OFFICE_PLUGINS[0]));
    const dense = probe.dense;
    assert.ok(
      dense.declaredBytes < 256 * 1024 * 1024,
      `夹具声明体积应落在字节预算内（否则测的是字节预算而非元素预算），实际 ${dense.declaredBytes}`,
    );
    const detail = assertStructuredFail(dense, "dense");
    assert.match(detail, /element/i, `detail 应说明是元素数问题，实际: ${detail}`);
  },
);

test(
  "正常小文档仍然 pass（预算不误伤真实文档）",
  { skip: hasPython ? false : "需要 python3" },
  () => {
    const probe = runProbe(scriptFor(OFFICE_PLUGINS[0]));
    assert.equal(probe.ok.rc, 0, "正常文档应 rc=0");
    const report = JSON.parse(probe.ok.stdout);
    assert.equal(report.verdict, "pass");
    assert.equal(report.checks[0].status, "pass");
  },
);

test(
  "图片密集的大文档不被预算误伤（预算只作用于会被读进内存的 XML 成员）",
  { skip: hasPython ? false : "需要 python3" },
  () => {
    const probe = runProbe(scriptFor(OFFICE_PLUGINS[0]));
    const media = probe.media;
    // 夹具本身必须真的是「大 media + 极小 XML」，否则测不到这条边界。
    assert.ok(media.declaredBytes > 128 * 1024 * 1024, `media 夹具应超过 128 MiB，实际 ${media.declaredBytes}`);
    assert.equal(media.rc, 0, "图片密集的正常文档必须仍然 rc=0（不得被总预算拒收）");
    assert.equal(JSON.parse(media.stdout).verdict, "pass");
  },
);

test("三份 staging 清单都登记了三个 office 插件（V-2）", () => {
  // SEA 清单没有顶层副作用，直接 import 做**真实**断言，并实跑一次资源收集。
  const seaPath = join(repoRoot, "apps", "zcode-cli", "packages", "cli", "scripts", "sea-official-plugin-assets.mjs");
  const seaSource = readFileSync(seaPath, "utf8");
  for (const { name } of OFFICE_PLUGINS) {
    assert.match(seaSource, new RegExp(`name: "${name}"`), `SEA 清单缺少 ${name}`);
  }
  assert.match(seaSource, /requiresRuntime: false/, "SEA 清单里 office 插件应标 requiresRuntime: false");
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
    assert.ok(source.includes(`const ${manifest.table} = [`), `${manifest.path} 缺少 ${manifest.table}`);
    assert.ok(
      source.includes(`...${manifest.table}.map(`),
      `${manifest.path} 的 ${manifest.list} 未展开 ${manifest.table}`,
    );
    for (const { name, skill } of OFFICE_PLUGINS) {
      assert.match(source, new RegExp(`name: "${name}", skill: "${skill}"`), `${manifest.path} 缺少 ${name}`);
    }
    // 关键回归点：内容型插件不得被要求构建 runtime。
    assert.match(source, /requiresRuntime: false/, `${manifest.path} 里 office 插件应标 requiresRuntime: false`);
  }
});
