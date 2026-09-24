import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

export function restoreTargetNodePtyPrebuild({ desktopPackageRoot, targetPlatform }) {
  if (targetPlatform.os !== "linux") {
    console.log(`[beforePack] node-pty prebuild restore skipped for ${targetPlatform.key}`);
    return;
  }

  const platformKey = targetPlatform.key;
  const sourcePackageName = `@lydell/node-pty-${platformKey}`;
  let sourceBinaryPath;

  try {
    sourceBinaryPath = resolveSourceNodePtyPrebuildPath({ sourcePackageName, platformKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`缺少 ${sourcePackageName}，无法为 ${platformKey} 打包 node-pty: ${message}`);
  }

  const nodePtyPackageRoot = dirname(
    require.resolve("node-pty/package.json", { paths: [desktopPackageRoot] }),
  );
  const targetPrebuildDir = resolve(nodePtyPackageRoot, "prebuilds", platformKey);
  const targetBinaryPath = resolve(targetPrebuildDir, "pty.node");

  // Linux 包中 node-pty 本体只会查自己的 prebuilds/linux-*/pty.node，
  // 但 Linux 预编译文件实际来自 @lydell/node-pty-linux-* 平台包；若排除该平台包，
  // 而 node-pty 自身目录没有 linux prebuild，最终安装包里会缺 pty.node，终端启动失败。
  // 这里在 beforePack 阶段恢复依赖资产，让后续 asarUnpack 按标准链路处理 native addon。
  mkdirSync(targetPrebuildDir, { recursive: true });
  cpSync(sourceBinaryPath, targetBinaryPath);

  if (!existsSync(targetBinaryPath))
    throw new Error(`node-pty 预编译产物恢复失败: ${targetBinaryPath}`);

  console.log(`[beforePack] node-pty prebuild restored: ${targetBinaryPath}`);
}

export function resolveSourceNodePtyPrebuildPath({ sourcePackageName, platformKey }) {
  const sourcePackageEntry = require.resolve(sourcePackageName);
  let currentDir = dirname(sourcePackageEntry);

  while (currentDir !== dirname(currentDir)) {
    const candidatePath = resolve(currentDir, "prebuilds", platformKey, "pty.node");
    if (existsSync(candidatePath)) return candidatePath;

    currentDir = dirname(currentDir);
  }

  // @lydell/node-pty-linux-* 通过 package exports 只暴露 lib/index.js，
  // 不能再解析 package.json。这里从公开入口向上寻找 prebuilds，兼容 exports 限制。
  throw new Error(
    `缺少 node-pty 预编译产物: ${sourcePackageName}/prebuilds/${platformKey}/pty.node`,
  );
}

/** node-pty 自身的原生目录加载顺序（见下方断言注释的引用）。 */
const NODE_PTY_FORBIDDEN_BUILD_DIRS = ["build/Release", "build/Debug"];

/**
 * 分发产物内的 node-pty 原生载荷必须**只有我们验过的那一份**。
 *
 * 为什么必须（否则后人会顺手删掉这条校验）：node-pty 的加载顺序是
 * `["build/Release", "build/Debug", "prebuilds/" + platform + "-" + arch]`
 * （`node_modules/node-pty/lib/utils.js:19`）—— `build/Release` **优先于** `prebuilds/`。
 * 本仓同时存在两份来源不同的 `pty.node`：本地在 Node 24 下编出来的（`node-pty/build/Release`，
 * 1.1.0，75888 字节）与打包时从 `@lydell/node-pty-<platform>@1.2.0-beta.10` 恢复进来的
 * （`prebuilds/<platform>/pty.node`，75976 字节，见本文件 `restoreTargetNodePtyPrebuild`）。
 * 一旦打包白名单放宽、或 `node-gyp rebuild` 后没清 `build/` 就出包，运行时会**静默加载未经我们
 * 验证的那份原生模块**：版本与校验和都不同，终端却仍然"能开"，只在特定内核/交互下崩 —— 属于
 * 最难排查的一类静默失效。所以这里 fail-closed：出包阶段就失败，而不是等用户踩。
 */
export function assertPackagedNodePtyPayloadVerified({
  resourcesDir,
  platformKey,
  sourcePackageName,
}) {
  const packageRoot = resolve(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty");
  if (!existsSync(packageRoot)) {
    // 产物内根本没有 node-pty（例如不含桌面终端的形态）：不适用，交给调用方决定是否视为失败。
    return { checked: false, reason: `产物内没有 node-pty: ${packageRoot}` };
  }

  // ① 不得存在 build/Release 或 build/Debug 下的 pty.node —— 它们会抢先于 prebuilds 被加载。
  for (const dir of NODE_PTY_FORBIDDEN_BUILD_DIRS) {
    const forbiddenPath = resolve(packageRoot, dir, "pty.node");
    if (existsSync(forbiddenPath)) {
      throw new Error(
        `分发产物内不得包含 node-pty 的 ${dir}/pty.node：${forbiddenPath}\n` +
          "原因：node-pty 的加载顺序是 [build/Release, build/Debug, prebuilds/<platform>-<arch>]" +
          "（node-pty/lib/utils.js:19），build/Release 优先于 prebuilds ⇒ 运行时会静默加载这份" +
          "未经我们验证的原生模块（与打包恢复进来的那一份版本/校验和都不同）。",
      );
    }
  }

  // ② prebuilds/<platform>/pty.node 必须存在，且与平台包（我们验过的那份）逐字节一致。
  const packagedBinaryPath = resolve(packageRoot, "prebuilds", platformKey, "pty.node");
  if (!existsSync(packagedBinaryPath)) {
    throw new Error(`node-pty 预编译产物缺失: ${packagedBinaryPath}`);
  }
  const expectedPackageName = sourcePackageName ?? `@lydell/node-pty-${platformKey}`;
  const sourceBinaryPath = resolveSourceNodePtyPrebuildPath({
    sourcePackageName: expectedPackageName,
    platformKey,
  });
  const packagedDigest = digestOfFile(packagedBinaryPath);
  const sourceDigest = digestOfFile(sourceBinaryPath);
  if (packagedDigest !== sourceDigest) {
    throw new Error(
      `node-pty 预编译产物与平台包不一致: ${packagedBinaryPath}\n` +
        `  产物 md5=${packagedDigest}\n  平台包(${expectedPackageName}) md5=${sourceDigest}\n` +
        "原因：分发产物必须携带我们验证过的那一份原生模块（见本文件 restoreTargetNodePtyPrebuild）。",
    );
  }

  return { checked: true, platformKey, digest: packagedDigest };
}

/** 文件 md5（与文档线核验产物时用的口径一致）。 */
function digestOfFile(filePath) {
  return createHash("md5").update(readFileSync(filePath)).digest("hex");
}

export function resolvePackagedNodePtyPrebuildPath({ resourcesDir, platformKey }) {
  return resolve(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
    platformKey,
    "pty.node",
  );
}
