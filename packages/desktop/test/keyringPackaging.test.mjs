import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  createDesktopNativePackagePrunePatterns,
  findDesktopNativePackageViolations,
  isRuntimeModuleOutsideTargetPlatform,
} from "../scripts/desktop-native-package-policy.mjs";
import {
  keyringNativeFileName,
  keyringPlatformPackageName,
  resolveKeyringVariantSuffix,
  stageKeyringIntoBundledAgents,
  verifyStagedKeyring,
} from "../scripts/keyring-package-assets.mjs";
import { stageAgentBundle } from "../scripts/stage-agent-bundle.mjs";

/**
 * 系统凭据库原生模块（@napi-rs/keyring）的打包护栏。
 *
 * 为什么必须钉住：这个模块的回归形态不是报错，而是「装出来的包才失败」——
 * 主包或目标平台变体漏进产物时，运行时只会 import 失败并静默回退到私有文件密钥，
 * 构建全程绿灯；非目标平台变体进了产物则白占几 MiB，还可能被运行时解析到。
 * 所以策略、prune、agent 树暂存与出包校验各自都要有断言。
 *
 * 运行：cd packages/desktop && node --import tsx --test test/keyringPackaging.test.mjs
 */

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const TARGET = "linux-x64";
const TARGET_VARIANT = keyringPlatformPackageName(TARGET);
const OTHER_DESKTOP_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "win32-arm64",
  "win32-x64",
];

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 一份「应有尽有」的 app.asar 列表：主包 + 目标变体，且 .node 已 unpack。 */
function healthyAsarEntries() {
  return [
    { packState: "pack", path: "/out/main/index.js" },
    { packState: "pack", path: "/node_modules/@napi-rs/keyring/package.json" },
    { packState: "pack", path: "/node_modules/@napi-rs/keyring/index.js" },
    { packState: "pack", path: `/node_modules/${TARGET_VARIANT}/package.json` },
    {
      packState: "unpack",
      path: `/node_modules/${TARGET_VARIANT}/${keyringNativeFileName(TARGET)}`,
    },
  ];
}

function violationsFor(entries) {
  return findDesktopNativePackageViolations(entries, TARGET);
}

test("策略：主包与目标变体齐全、.node 已 unpack 时零违规", () => {
  assert.deepEqual(violationsFor(healthyAsarEntries()), []);
});

test("策略：asar 里出现非目标平台变体必须报告", () => {
  const entries = [
    ...healthyAsarEntries(),
    {
      packState: "unpack",
      path: "/node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node",
    },
  ];
  const violations = violationsFor(entries);
  assert.ok(
    violations.some(
      (line) => line.includes("非目标平台的 keyring 原生变体") && line.includes("darwin-arm64"),
    ),
    `必须点名越界变体，实际：${violations.join(" | ")}`,
  );
});

test("策略：主包在但缺目标平台变体必须报告", () => {
  const entries = healthyAsarEntries().filter(
    (entry) => !entry.path.startsWith(`/node_modules/${TARGET_VARIANT}`),
  );
  const violations = violationsFor(entries);
  assert.ok(
    violations.some((line) => line.includes("缺少 keyring 目标平台变体")),
    `实际：${violations.join(" | ")}`,
  );
});

test("策略：变体在但缺目标平台原生二进制必须报告", () => {
  const entries = healthyAsarEntries().filter((entry) => !entry.path.endsWith(".node"));
  const violations = violationsFor(entries);
  assert.ok(
    violations.some((line) => line.includes("缺少 keyring 目标平台原生二进制")),
    `实际：${violations.join(" | ")}`,
  );
});

test("策略：整个主包缺席也必须报告（静默回退文件密钥的入口就在这里）", () => {
  const entries = [{ packState: "pack", path: "/out/main/index.js" }];
  const violations = violationsFor(entries);
  assert.ok(
    violations.some((line) => line.includes("产物缺少系统凭据库原生模块")),
    `实际：${violations.join(" | ")}`,
  );
});

test("策略：.node 仍作为 packed payload 留在 asar 时由通用 unpack 规则报告", () => {
  const entries = healthyAsarEntries().map((entry) =>
    entry.path.endsWith(".node") ? { ...entry, packState: "pack" } : entry,
  );
  const violations = violationsFor(entries);
  assert.ok(
    violations.some((line) => line.includes("native 文件仍作为 packed payload")),
    `实际：${violations.join(" | ")}`,
  );
});

test("prune：只裁掉非目标平台变体，主包与目标变体保留", () => {
  const patterns = createDesktopNativePackagePrunePatterns(TARGET);
  const keyringPatterns = patterns.filter((pattern) => pattern.includes("@napi-rs/keyring-"));
  const prunedSuffixes = keyringPatterns
    .map((pattern) => /@napi-rs\/keyring-(.+)\/\*\*$/.exec(pattern)?.[1])
    .sort();
  const expectedSuffixes = OTHER_DESKTOP_PLATFORMS.map(resolveKeyringVariantSuffix).sort();
  assert.deepEqual(prunedSuffixes, expectedSuffixes);
  assert.ok(
    !keyringPatterns.some((pattern) =>
      pattern.includes(`keyring-${resolveKeyringVariantSuffix(TARGET)}/`),
    ),
    "目标平台变体不得被 prune",
  );
  assert.ok(
    !keyringPatterns.some((pattern) => pattern.endsWith("@napi-rs/keyring/**")),
    "主包不得被 prune（惰性 import 的入口就在它里面）",
  );
});

test("变体后缀：6 个桌面平台与 npm 平台包名一一对应", () => {
  const expected = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-arm64": "linux-arm64-gnu",
    "linux-x64": "linux-x64-gnu",
    "win32-arm64": "win32-arm64-msvc",
    "win32-x64": "win32-x64-msvc",
  };
  for (const [platformKey, suffix] of Object.entries(expected)) {
    assert.equal(resolveKeyringVariantSuffix(platformKey), suffix, platformKey);
    assert.equal(keyringPlatformPackageName(platformKey), `@napi-rs/keyring-${suffix}`);
    assert.equal(keyringNativeFileName(platformKey), `keyring.${suffix}.node`);
  }
  assert.throws(() => resolveKeyringVariantSuffix("linux-ia32"), /不支持/);
});

test("闭包过滤：必需依赖闭包里只留目标平台变体", () => {
  const modules = [
    "@napi-rs/keyring",
    ...OTHER_DESKTOP_PLATFORMS.map((platformKey) => keyringPlatformPackageName(platformKey)),
    TARGET_VARIANT,
  ];
  const kept = modules.filter(
    (moduleName) => !isRuntimeModuleOutsideTargetPlatform(moduleName, TARGET),
  );
  assert.deepEqual(kept.sort(), ["@napi-rs/keyring", TARGET_VARIANT].sort());
});

test("跨目标暂存：三个非宿主平台的 keyring 都落进 agent 树", (t) => {
  for (const platformKey of ["win32-x64", "darwin-arm64", "linux-arm64"]) {
    const glmDir = join(createTempDir("keyring-stage-"), "glm");
    let staged;
    try {
      staged = stageKeyringIntoBundledAgents({
        lookupRoots: [repoRoot, desktopRoot],
        glmDir,
        targetPlatformKey: platformKey,
      });
    } catch (error) {
      // 安装机若没有装该平台变体（supportedArchitectures 被改窄），这里跳过而不是误判失败；
      // CI 的安装配置覆盖 darwin/linux/win32 三平台，所以正式流水线上会真的跑。
      t.diagnostic(
        `跳过 ${platformKey}：${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const scopeDir = join(glmDir, "node_modules", "@napi-rs");
    assert.ok(existsSync(join(scopeDir, "keyring", "index.js")), `${platformKey} 缺主包`);
    assert.ok(existsSync(staged.nativePath), `${platformKey} 缺原生二进制`);
    assert.ok(
      existsSync(
        join(
          scopeDir,
          keyringPlatformPackageName(platformKey).split("/")[1],
          "LICENSE.third-party.md",
        ),
      ),
      `${platformKey} 缺平台变体的许可正文（分发二进制就有随附义务）`,
    );
    assert.deepEqual(
      readdirSync(scopeDir).sort(),
      ["keyring", keyringPlatformPackageName(platformKey).split("/")[1]].sort(),
      `${platformKey} 只允许主包与目标变体`,
    );
    assert.equal(staged.platformVariant, keyringPlatformPackageName(platformKey));
  }
});

test("stageAgentBundle：keyring 随 agent 树落盘并写进 meta（dev 与打包同一份实现）", (t) => {
  const tempRepo = createTempDir("keyring-agent-bundle-");
  const cliDistDir = join(tempRepo, "apps/zcode-cli/packages/cli/dist");
  mkdirSync(cliDistDir, { recursive: true });
  writeFileSync(join(cliDistDir, "zcode.cjs"), "// 测试用假 bundle\n");
  try {
    // stageAgentBundle 只从 repoRoot 下的 node_modules 解析依赖；用目录链接把安装树接进来。
    symlinkSync(
      join(repoRoot, "node_modules"),
      join(tempRepo, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    t.skip(`无法创建 node_modules 链接：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  stageAgentBundle({ repoRoot: tempRepo, platformKey: TARGET, log: () => {} });
  const glmDir = join(tempRepo, "packages/desktop/bundled-agents", TARGET, "glm");
  const scopeDir = join(glmDir, "node_modules", "@napi-rs");
  assert.ok(existsSync(join(scopeDir, "keyring", "index.js")), "agent 树必须能解析到主包");
  assert.ok(
    existsSync(join(scopeDir, TARGET_VARIANT.split("/")[1], keyringNativeFileName(TARGET))),
    "agent 树必须有目标平台原生二进制",
  );
  const meta = JSON.parse(readFileSync(join(glmDir, ".node-bundle-meta.json"), "utf8"));
  assert.deepEqual(meta.nativeModules?.["@napi-rs/keyring"], {
    version: JSON.parse(readFileSync(join(scopeDir, "keyring", "package.json"), "utf8")).version,
    platformVariant: TARGET_VARIANT,
  });
});

test("出包校验：resources/glm 下缺 .node 或缺主包都要报告", () => {
  const resourcesDir = createTempDir("keyring-resources-");
  const glmDir = join(resourcesDir, "glm");
  stageKeyringIntoBundledAgents({
    lookupRoots: [repoRoot, desktopRoot],
    glmDir,
    targetPlatformKey: TARGET,
  });
  assert.deepEqual(verifyStagedKeyring({ resourcesDir, targetPlatformKey: TARGET }), []);

  const nativePath = join(
    glmDir,
    "node_modules/@napi-rs",
    TARGET_VARIANT.split("/")[1],
    keyringNativeFileName(TARGET),
  );
  rmSync(nativePath);
  const missingNative = verifyStagedKeyring({ resourcesDir, targetPlatformKey: TARGET });
  assert.equal(missingNative.length, 1);
  assert.ok(missingNative[0].includes(keyringNativeFileName(TARGET)));

  rmSync(join(glmDir, "node_modules/@napi-rs/keyring"), { recursive: true, force: true });
  const missingMain = verifyStagedKeyring({ resourcesDir, targetPlatformKey: TARGET });
  assert.ok(missingMain.some((line) => line.includes("@napi-rs/keyring/index.js")));
});

test("出包校验：三平台 resources 树都能通过（校验按目标变体取名）", (t) => {
  for (const platformKey of ["win32-x64", "darwin-arm64", "linux-arm64"]) {
    const resourcesDir = createTempDir("keyring-resources-matrix-");
    try {
      stageKeyringIntoBundledAgents({
        lookupRoots: [repoRoot, desktopRoot],
        glmDir: join(resourcesDir, "glm"),
        targetPlatformKey: platformKey,
      });
    } catch (error) {
      t.diagnostic(
        `跳过 ${platformKey}：${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    assert.deepEqual(
      verifyStagedKeyring({ resourcesDir, targetPlatformKey: platformKey }),
      [],
      platformKey,
    );
  }
});
