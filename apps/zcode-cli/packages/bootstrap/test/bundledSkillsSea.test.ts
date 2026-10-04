import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Logger, LogContext } from "@zcode/contracts";
import {
  BUNDLED_SKILL_REQUIRED_PATHS,
  resolveBundledSkillRoots,
} from "../src/app/bundled-skills.js";

/** 与 bundled-skills.ts 内部同构的最小 sea 模块形状（生产态的 node:sea 不可注入）。 */
type SeaModule = Pick<typeof import("node:sea"), "getAsset" | "getRawAsset" | "isSea">;

/**
 * 内置技能包解析器的回归测试：文件系统分支（桌面/远端/开发态）与 SEA 分支（单文件可执行）。
 *
 * 为什么必须打到解包后的树而不是「清单读对了」：bundled-skills 的最终消费点是
 * `resolveBundledSkillRoots` 返回的 `<packRoot>/skills` —— 技能发现从那里读 SKILL.md。
 * manifest 正确但解包写歪（路径分隔符、mode、哈希漏校验）时，中间产物全绿而技能消失。
 * 本仓库已四次踩过「验证停在中间产物」，所以这里用真实采集脚本生成的清单 +
 * 假 SEA 模块（production 态拿不到真 SEA 二进制）跑完整解包链。
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && node --import tsx --test test/bundledSkillsSea.test.ts
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// CLI workspace 根（= build-sea.mjs 里的 root：插件与 bundled-skills 都在它的 packages/ 下）。
const cliWorkspaceRoot = resolve(packageRoot, "..", "..");
const cliPackageRoot = resolve(packageRoot, "..", "cli");
const bundledSkillPackRoot = resolve(packageRoot, "..", "bundled-skills");

/** 从 staging 采集脚本生成的清单造一个假 node:sea：读字与读字节都走真实资产。 */
function fakeSeaFromAssets(assets: Record<string, string>): SeaModule {
  const readAsset = (key: string) => {
    const path = assets[key];
    if (!path) throw new Error(`fake sea: unknown asset ${key}`);
    return path;
  };
  // getAsset 是重载（无 encoding 返 ArrayBuffer / 有 encoding 返 string），实现按签名分发。
  const getAsset = (key: string, encoding?: BufferEncoding) =>
    encoding === undefined ? readFileSync(readAsset(key)) : readFileSync(readAsset(key), encoding);
  return {
    getAsset: getAsset as SeaModule["getAsset"],
    getRawAsset: (key: string) => {
      const buffer = readFileSync(readAsset(key));
      // 真实 getRawAsset 返回 ArrayBuffer；解包侧用 Buffer.from() 包它。
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    isSea: () => true,
  };
}

const collectWarnings = () => {
  const warns: Array<{ message: string; context?: LogContext }> = [];
  const logger: Logger = {
    child: () => logger,
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: (message, context) => warns.push({ context, message }),
  };
  return { logger, warns };
};

test("文件系统分支：仓库里的真实内置技能包解析成唯一 system root", async () => {
  const roots = await resolveBundledSkillRoots({
    baseDirs: [cliWorkspaceRoot],
  });
  assert.equal(roots.length, 1, "内置技能包必须解析出恰好一个 root");
  const [root] = roots;
  assert.equal(root.scope, "system");
  assert.equal(root.source, "bundled");
  assert.equal(root.priority, 1_000_000);
  assert.equal(root.path, resolve(bundledSkillPackRoot, "skills"));
  // 最终消费点：正文与两份 reference 文件都要真实存在于解析出的 root 下。
  for (const relativePath of BUNDLED_SKILL_REQUIRED_PATHS) {
    const path = join(root.path, ...relativePath.slice("skills/".length).split("/"));
    assert.ok(existsSync(path), relativePath);
  }
});

test("缺任一必需资产时整包拒收并 warn，不抛错", async () => {
  const brokenRoot = mkdtempSync(join(tmpdir(), "zcode-bundled-skills-broken-"));
  try {
    mkdirSync(resolve(brokenRoot, "skills", "dynamic-workflows"), { recursive: true });
    // 只放 SKILL.md，缺 patterns.md / examples.md。
    writeFileSync(
      resolve(brokenRoot, "skills", "dynamic-workflows", "SKILL.md"),
      "# incomplete pack\n",
    );
    const { logger, warns } = collectWarnings();
    const roots = await resolveBundledSkillRoots({ baseDirs: [brokenRoot], logger });
    assert.deepEqual(roots, [], "残缺包不得被接受");
    assert.equal(warns.length, 1);
    assert.match(warns[0]!.message, /Bundled skill pack unavailable/u);
  } finally {
    rmSync(brokenRoot, { recursive: true, force: true });
  }
});

test("SEA 分支：按真实清单解包到 <cliStorageRoot>/bundled-skills/<hash>/，正文逐字节落盘", async () => {
  const { collectSeaBundledSkillAssets } = await import(
    join(cliPackageRoot, "scripts", "sea-bundled-skill-assets.mjs")
  );
  const staging = mkdtempSync(join(tmpdir(), "zcode-sea-bs-staging-"));
  const cliStorageRoot = mkdtempSync(join(tmpdir(), "zcode-sea-bs-storage-"));
  try {
    // 真实采集：清单、sha256、资产键全部由仓库里的采集脚本生成。
    const { assets, manifest } = await collectSeaBundledSkillAssets({
      root: cliWorkspaceRoot,
      stagingDirectory: staging,
    });
    assert.ok(manifest.files.length >= BUNDLED_SKILL_REQUIRED_PATHS.length);

    const { logger, warns } = collectWarnings();
    const roots = await resolveBundledSkillRoots({
      cliStorageRoot,
      logger,
      seaModule: fakeSeaFromAssets(assets),
    });
    assert.deepEqual(warns, [], "SEA 解包成功不得有降级 warn");
    assert.equal(roots.length, 1);
    const [root] = roots;
    assert.equal(root.scope, "system");
    assert.equal(root.source, "bundled");
    assert.equal(root.path, join(cliStorageRoot, "bundled-skills", manifest.hash, "skills"));

    // 解包树必须逐文件存在且内容与源一致（哈希由清单声明、解包侧复核）。
    for (const file of manifest.files) {
      const extracted = join(
        cliStorageRoot,
        "bundled-skills",
        manifest.hash,
        ...file.path.split("/"),
      );
      assert.ok(existsSync(extracted), `解包树缺文件：${file.path}`);
    }
    // 最终消费点：三件必需资产在解析出的 skills root 下可读。
    for (const relativePath of BUNDLED_SKILL_REQUIRED_PATHS) {
      const path = join(root.path, ...relativePath.slice("skills/".length).split("/"));
      assert.ok(existsSync(path), `root 下缺必需资产：${relativePath}`);
    }
    // seed marker：幂等判据（再次解析应直接命中已完整目录）。
    assert.ok(
      existsSync(
        join(cliStorageRoot, "bundled-skills", manifest.hash, ".zcode-bundled-skills-seed.json"),
      ),
      "解包必须写入 seed marker",
    );
    // 不留临时目录。
    assert.deepEqual(
      readdirSync(join(cliStorageRoot, "bundled-skills")).filter((name) => name.includes(".tmp-")),
      [],
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(cliStorageRoot, { recursive: true, force: true });
  }
});

test("SEA 解包幂等：同一清单二次解析复用已完整目录", async () => {
  const { collectSeaBundledSkillAssets } = await import(
    join(cliPackageRoot, "scripts", "sea-bundled-skill-assets.mjs")
  );
  const staging = mkdtempSync(join(tmpdir(), "zcode-sea-bs-idem-"));
  const cliStorageRoot = mkdtempSync(join(tmpdir(), "zcode-sea-bs-idem-store-"));
  try {
    const { assets, manifest } = await collectSeaBundledSkillAssets({
      root: cliWorkspaceRoot,
      stagingDirectory: staging,
    });
    const sea = fakeSeaFromAssets(assets);
    const first = await resolveBundledSkillRoots({ cliStorageRoot, seaModule: sea });
    const second = await resolveBundledSkillRoots({ cliStorageRoot, seaModule: sea });
    assert.deepEqual(
      first.map((root) => root.path),
      second.map((root) => root.path),
      "同一内容 hash 必须解析到同一目录",
    );
    assert.equal(second[0]!.path, join(cliStorageRoot, "bundled-skills", manifest.hash, "skills"));
    // 幂等不得新产生 tmp 目录。
    assert.deepEqual(
      readdirSync(join(cliStorageRoot, "bundled-skills")).filter((name) => name.includes(".tmp-")),
      [],
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(cliStorageRoot, { recursive: true, force: true });
  }
});

test("SEA 资产哈希不符时降级到旧包；无旧包则 warn 并返回空（不抛错）", async () => {
  const { collectSeaBundledSkillAssets } = await import(
    join(cliPackageRoot, "scripts", "sea-bundled-skill-assets.mjs")
  );
  const staging = mkdtempSync(join(tmpdir(), "zcode-sea-bs-tamper-"));
  const cliStorageRoot = mkdtempSync(join(tmpdir(), "zcode-sea-bs-tamper-store-"));
  try {
    const { assets, manifest } = await collectSeaBundledSkillAssets({
      root: cliWorkspaceRoot,
      stagingDirectory: staging,
    });
    // 篡改一个资产字节：解包侧 sha256 复核必须失败。
    const tamperedAssets = { ...assets };
    const tamperKey = Object.keys(assets).find((key) => key.endsWith("SKILL.md"))!;
    const tamperPath = join(staging, "tampered.md");
    writeFileSync(tamperPath, "tampered content");
    tamperedAssets[tamperKey] = tamperPath;

    const { logger, warns } = collectWarnings();
    // 显式传空 baseDirs 隔离文件系统兜底：生产态下 SEA 解包失败后回退到入口旁候选是
    // 既有的最后兜底（解包失败 warn 已留下证据），此处只验证 SEA 分支自身的降级语义。
    const roots = await resolveBundledSkillRoots({
      baseDirs: [],
      cliStorageRoot,
      logger,
      seaModule: fakeSeaFromAssets(tamperedAssets),
    });
    // 本用例没有旧包可回退，文件系统分支也被隔离 ⇒ 返回空。
    assert.deepEqual(roots, []);
    const degraded = warns.find((warn) => /seed degraded/u.test(warn.message));
    assert.ok(degraded, "哈希不符必须 warn 降级原因，不能静默");
    assert.match(degraded!.context?.error as string, /hash mismatch/u);
    assert.equal(
      degraded!.context?.targetRoot,
      join(cliStorageRoot, "bundled-skills", manifest.hash),
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(cliStorageRoot, { recursive: true, force: true });
  }
});

test("SEA 态缺 cliStorageRoot 时显式 warn 降级，不走向未定义路径", async () => {
  const { collectSeaBundledSkillAssets } = await import(
    join(cliPackageRoot, "scripts", "sea-bundled-skill-assets.mjs")
  );
  const staging = mkdtempSync(join(tmpdir(), "zcode-sea-bs-nostorage-"));
  try {
    const { assets } = await collectSeaBundledSkillAssets({
      root: cliWorkspaceRoot,
      stagingDirectory: staging,
    });
    const { logger, warns } = collectWarnings();
    // 同上：隔离文件系统兜底，让"缺存储根"的降级是唯一出口。
    const roots = await resolveBundledSkillRoots({
      baseDirs: [],
      logger,
      seaModule: fakeSeaFromAssets(assets),
    });
    assert.deepEqual(roots, [], "无存储根时 SEA 解包必须放弃");
    assert.ok(
      warns.some((warn) => /without cli storage root/u.test(warn.message)),
      "缺存储根必须留下可诊断 warn",
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test("非 SEA 态不走解包分支（isSea=false 时等价于纯文件系统解析）", async () => {
  const roots = await resolveBundledSkillRoots({
    baseDirs: [cliWorkspaceRoot],
    // 显式注入一个「不是 SEA」的模块，防止测试进程本身的 isSea 状态影响判据；
    // 其余两个方法按 SeaModule 形状给抛错占位，isSea()=false 时它们永不被调用。
    seaModule: {
      getAsset: () => {
        throw new Error("not sea");
      },
      getRawAsset: () => {
        throw new Error("not sea");
      },
      isSea: () => false,
    },
  });
  assert.equal(roots.length, 1);
  assert.equal(roots[0]!.path, resolve(bundledSkillPackRoot, "skills"));
  assert.equal(roots[0]!.source, "bundled");
});
