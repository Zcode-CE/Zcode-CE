#!/usr/bin/env node
/* eslint-disable max-lines */
/**
 * 把 prepare:remote-assets 的产出装配成「可直接用静态服务器发布」的布局。
 *
 * 为什么不能恒等拷贝（task-10 实测的差异）：
 *   mock-cdn 的磁盘布局是
 *     mock-cdn/releases/<版本>/manifest-<平台>.json        ← manifest 在版本目录里
 *     mock-cdn/components/<平台>/<组件>/<组件版本>.tar.gz   ← components 是 releases 的兄弟目录
 *   而客户端（packages/server/src/remote/remoteAssetCache.ts:290-297 与 remoteAssetCdn.ts:68-82）
 *   请求的是
 *     <base>/<版本>/manifest-<平台>.json
 *     <base>/components/<平台>/<组件>/<组件版本>.tar.gz      ← 先探测父级 root，再回退到版本化路径
 *   所以发布前必须把两处「拍平」到同一个根：<out>/<版本>/ 与 <out>/components/。
 *
 * 装配后自检（任一失败即 exit 1，绝不允许半成品被发布）：
 *   1. 每个平台 manifest 都存在，且 manifest.appVersion === 当前 package.json 版本
 *      —— 客户端对 appVersion 做强校验（remoteAssetCache.ts:1264），不一致会在用户侧被拒；
 *   2. 每个 components[].artifactPath 都能在 <out> 下取到；
 *   3. 每个制品的 sha256 与 manifest 声明一致。
 *
 * 用法：
 *   node scripts/assemble-remote-assets.mjs                       # 装配当前版本到 .tmp/remote-assets-publish/<版本>
 *   node scripts/assemble-remote-assets.mjs --out /srv/zcode-assets
 *   node scripts/assemble-remote-assets.mjs --hard-link           # 同盘时省一次全量拷贝（CI 建议默认拷贝）
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const mockCdnDir = join(repoRoot, "packages/desktop/mock-cdn");
const version = readJson(join(repoRoot, "package.json")).version;

const args = parseArgs(process.argv.slice(2));
const outRoot = resolve(args.out ?? join(repoRoot, ".tmp/remote-assets-publish"));
// --version 必须同时决定输出目录：否则装配旧版本会把 manifest 写进「当前 package.json 版本」的目录，
// 多版本发布时互相覆盖，旧版本客户端在发布根下取不到自己的 manifest（2026-09-23 实测踩中）。
const outDir = join(outRoot, args.version ?? version);
const useHardLink = args.hardLink === true;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--out") {
      parsed.out = argv[index + 1];
      index += 1;
    } else if (token === "--version") {
      parsed.version = argv[index + 1];
      index += 1;
    } else if (token === "--hard-link") {
      parsed.hardLink = true;
    } else {
      throw new Error(`未知参数：${token}`);
    }
  }
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function linkOrCopy(sourcePath, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  if (existsSync(targetPath)) {
    rmSync(targetPath, { force: true });
  }
  if (useHardLink) {
    try {
      linkSync(sourcePath, targetPath);
      return;
    } catch {
      // 跨设备或权限不允许时回退到拷贝；硬链接只是优化，不是语义。
    }
  }
  copyFileSync(sourcePath, targetPath);
}

function discoverPlatforms() {
  const releaseDir = join(mockCdnDir, "releases", args.version ?? version);
  if (!existsSync(releaseDir)) {
    throw new Error(
      `未找到 mock-cdn 产出目录：${releaseDir}\n请先运行：pnpm prepare:remote-assets`,
    );
  }
  const platforms = readdirSync(releaseDir)
    .filter((name) => /^manifest-.+\.json$/.test(name))
    .map((name) => name.slice("manifest-".length, -".json".length))
    .sort();
  if (platforms.length === 0) {
    throw new Error(`${releaseDir} 下没有任何 manifest-*.json，装配无意义`);
  }
  return { releaseDir, platforms };
}

function assemble() {
  const { releaseDir, platforms } = discoverPlatforms();
  // --version 同时决定「读哪个产出目录」与「期望的 appVersion」，避免两者漂移。
  const expectedAppVersion = args.version ?? version;
  console.log(`[assemble] version=${expectedAppVersion} platforms=${platforms.join(",")}`);
  console.log(`[assemble] out=${outDir}（manifest）与 ${join(outRoot, "components")}（组件制品）`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const records = [];
  for (const platform of platforms) {
    const manifestPath = join(releaseDir, `manifest-${platform}.json`);
    const manifest = readJson(manifestPath);
    if (manifest.appVersion !== expectedAppVersion) {
      // 客户端 remoteAssetCache.ts:1264 会把 appVersion 不一致的 manifest 直接判为无效，
      // 装到发布根上只会让用户看到「manifest mismatch」。宁可在这里失败。
      throw new Error(
        `manifest appVersion 与当前版本不一致：${manifestPath} appVersion=${manifest.appVersion} expected=${expectedAppVersion}`,
      );
    }
    const publishedManifestPath = join(outDir, `manifest-${platform}.json`);
    linkOrCopy(manifestPath, publishedManifestPath);

    for (const component of manifest.components ?? []) {
      const artifactPath = String(component.artifactPath ?? "").trim();
      if (!artifactPath) {
        throw new Error(`${manifestPath} 的组件 ${component.id} 缺少 artifactPath`);
      }
      const sourcePath = join(mockCdnDir, ...artifactPath.split("/"));
      if (!existsSync(sourcePath)) {
        throw new Error(`组件制品缺失：${component.id}@${platform} -> ${sourcePath}`);
      }
      // 组件制品必须落在**发布根**（<out>/components/...），不能塞进版本目录：
      // 客户端的 URL 候选顺序是「父级 root → 版本化路径」（remoteAssetCdn.ts:68-82），
      // 放进版本目录会让每次连接都对第一条候选白打一轮 404（2026-09-23 实测：7 次）。
      // 组件版本本身是内容寻址的（v<语义版本>+<sha12>），多个 app 版本可安全共用一个 components 根。
      const targetPath = join(outRoot, ...artifactPath.split("/"));
      linkOrCopy(sourcePath, targetPath);

      const actualSha256 = sha256File(targetPath);
      if (
        typeof component.sha256 === "string" &&
        component.sha256.toLowerCase() !== actualSha256.toLowerCase()
      ) {
        throw new Error(
          `sha256 不匹配：${artifactPath} expected=${component.sha256} actual=${actualSha256}`,
        );
      }
      records.push({
        platform,
        componentId: component.id,
        componentVersion: component.version,
        artifactPath,
        sha256: actualSha256,
        bytes: statSync(targetPath).size,
      });
    }
    console.log(`  [ok] ${platform}: ${(manifest.components ?? []).length} 个组件`);
  }

  // 发布记录：不参与客户端协议（客户端只读 manifest 与组件制品），
  // 但让发布方与排障者能一眼看出「这份发布根是什么时候、由哪个版本装配的」。
  const publishRecord = {
    appVersion: expectedAppVersion,
    generatedAt: new Date().toISOString(),
    sourceReleaseDir: releaseDir,
    componentsDir: join(mockCdnDir, "components"),
    platforms,
    components: records,
    totalBytes: records.reduce((sum, item) => sum + item.bytes, 0),
  };
  writeFileSync(join(outDir, "publish.json"), `${JSON.stringify(publishRecord, null, 2)}\n`);

  const totalMB = (publishRecord.totalBytes / 1024 / 1024).toFixed(1);
  console.log(`[assemble] done: ${records.length} 个制品 / ${totalMB} MB -> ${outDir}`);
  console.log(
    `[assemble] 自检通过：manifest.appVersion 一致、artifactPath 全部可取、sha256 全部匹配`,
  );
}

assemble();
