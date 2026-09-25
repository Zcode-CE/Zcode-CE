#!/usr/bin/env node
/**
 * 把装配好的发布根上传到 Cloudflare R2（配合 `scripts/assemble-remote-assets.mjs` 的产出）。
 *
 *   node scripts/upload-remote-assets-r2.mjs --root .tmp/r2-publish --bucket <bucket> \
 *     --public-base-url https://<域名>
 *
 * 约定（2026-09-23 首次发布时确定，运维手册见 docs/operations/remote-assets-cdn.md）：
 *   - key = 发布根内相对路径（`<版本>/manifest-*.json`、`<版本>/publish.json`、
 *     `components/<平台>/<组件>/<版本>.tar.gz`）；
 *   - `components/**` 内容寻址（`v<语义版本>+<sha12>`）、同 key 永不改写
 *       → `Cache-Control: public, max-age=31536000, immutable`，且**已存在即跳过**（省 Class A 写操作）；
 *   - 版本目录下的 json 允许同版本热修复重传
 *       → `Cache-Control: public, max-age=300`，改写后最多 5 分钟全球生效；
 *   - 上传走本机 wrangler 的 OAuth（`wrangler whoami` 能通过即可），**不需要** S3 API token，
 *     也**不接受**任何凭据出现在命令行或环境变量里。
 *
 * 为什么桶名必须由参数/环境变量给：仓库是公开的，桶名属于**部署方私有标识**，
 * 写死进源码等于把它随仓库分发出去。缺失时直接失败并指路，而不是回落到某个默认值。
 *
 * 与无头服务器载荷的关系：`releases/<版本>/**`（zcode-<版本>.tar.gz + sha256.txt）与
 * `latest.json` 走同一个桶、同一个域名，但**寻址方式不同** —— 见
 * `scripts/upload-headless-release-r2.mjs`。两者的公共机制（wrangler put、重试、上传后自检、
 * 列举）抽在 `scripts/r2-upload-lib.mjs`，本文件与那个脚本共用，避免两套实现漂移。
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cacheControlFor,
  contentTypeFor,
  fetchWithRetry,
  isContentAddressed,
  putObject,
  remoteExists,
} from "./r2-upload-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root ?? join(repoRoot, ".tmp/r2-publish"));
const bucket = (args.bucket ?? process.env.ZCODE_R2_BUCKET ?? "").trim();
const publicBaseUrl = (args.publicBaseUrl ?? process.env.ZCODE_REMOTE_ASSET_CDN_BASE_URL ?? "")
  .trim()
  .replace(/\/+$/, "");
const concurrency = Number(args.concurrency ?? 4);
const dryRun = args.dryRun === true;
const skipExisting = args.skipExisting !== false;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (
      token === "--root" ||
      token === "--bucket" ||
      token === "--concurrency" ||
      token === "--public-base-url"
    ) {
      parsed[token.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = argv[index + 1];
      index += 1;
    } else if (token === "--dry-run") {
      parsed.dryRun = true;
    } else if (token === "--no-skip-existing") {
      parsed.skipExisting = false;
    } else {
      throw new Error(`未知参数：${token}`);
    }
  }
  return parsed;
}

function walkFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

const FETCH_RETRY_DELAYS_MS = [1000, 3000];

async function main() {
  if (!bucket) {
    throw new Error(
      "缺少对象桶名：用 --bucket <bucket> 或环境变量 ZCODE_R2_BUCKET 指定（具体值见 docs/operations/remote-assets-cdn.md §12 指向的本地私密笔记；不要写进仓库）",
    );
  }
  // 发布根格式**在上传前**校验：只写域名（漏协议）时，`fetch()` 会逐个失败，结果是「上传其实成功、
  // 自检全红、job 退出 1」这种最难排查的假失败（2026-09-23 维护者真的这么配过一次）。
  if (publicBaseUrl && !/^https?:\/\//iu.test(publicBaseUrl)) {
    throw new Error(
      `发布根必须带协议：收到 ${JSON.stringify(publicBaseUrl)}（应为 https://<域名>）—— 只写域名会让上传后的 HEAD 自检全部失败`,
    );
  }
  const files = walkFiles(root);
  if (files.length === 0) {
    throw new Error(`发布根是空目录：${root}（先跑 node scripts/assemble-remote-assets.mjs）`);
  }
  const keys = files.map((file) => relative(root, file).split(sep).join("/"));
  console.log(
    `[r2] bucket=${bucket} root=${root} files=${files.length} concurrency=${concurrency} skipExisting=${skipExisting}${dryRun ? "（dry-run）" : ""}`,
  );

  if (dryRun) {
    for (const key of keys) {
      console.log(`  [dry] ${key}  (${contentTypeFor(key)} / ${cacheControlFor(key)})`);
    }
    return;
  }

  const queue = files.map((file, index) => ({ file, key: keys[index] }));
  let done = 0;
  let skipped = 0;
  const failures = [];
  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      if (
        skipExisting &&
        isContentAddressed(item.key) &&
        (await remoteExists(publicBaseUrl, item.key))
      ) {
        skipped += 1;
        console.log(`  [skip ${skipped}] ${item.key}（内容寻址且远端已存在）`);
        continue;
      }
      let lastError = "";
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const result = await putObject({ bucket, key: item.key, file: item.file });
        if (result.ok) {
          done += 1;
          console.log(`  [ok ${done}/${keys.length - skipped}] ${item.key}`);
          break;
        }
        lastError = result.error ?? "unknown";
        console.warn(`  [retry ${attempt}] ${item.key}: ${lastError}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        if (attempt === 3) failures.push({ key: item.key, error: lastError });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  if (failures.length > 0) {
    console.error(`[r2] 失败 ${failures.length} 个对象：`);
    for (const failure of failures) console.error(`  FAIL ${failure.key}: ${failure.error}`);
    process.exit(1);
  }
  console.log(`[r2] done: 上传 ${done}、跳过 ${skipped}、失败 0`);

  // 上传后自检：给 --public-base-url 时逐个 HEAD，确保「上传成功」与「CDN 可取」一致。
  if (publicBaseUrl) {
    let bad = 0;
    let unverifiable = 0;
    for (const key of keys) {
      try {
        const response = await fetchWithRetry(`${publicBaseUrl}/${key}`, { method: "HEAD" });
        if (response.status !== 200) {
          bad += 1;
          console.error(`  BAD ${response.status} ${key}`);
        }
      } catch (error) {
        // **网络错误 ≠ 对象不可取**：重试后仍不可达只能记「未确认」，不能当硬失败 —— 否则一次网络抖动
        // 就会把「上传全部成功」报成失败（2026-09-24 实测踩到）。如实报出来，让人重跑一次确认。
        unverifiable += 1;
        console.warn(
          `  UNVERIFIED ${key}: ${error.message}（已重试 ${FETCH_RETRY_DELAYS_MS.length + 1} 次仍不可达）`,
        );
      }
    }
    if (unverifiable > 0) {
      console.error(
        `[r2] ⚠️ ${unverifiable}/${keys.length} 个对象因**网络错误未能确认**（不是 404，不代表对象缺失）—— 请重跑一次自检确认`,
      );
    }
    if (bad > 0) {
      console.error(
        `[r2] 自检失败：${bad}/${keys.length} 个对象在 ${publicBaseUrl} 上确实不可取（HTTP 非 200）`,
      );
      process.exit(1);
    }
    console.log(`[r2] 自检通过：${keys.length} 个对象在 ${publicBaseUrl} 上全部 200`);
  } else {
    console.log("[r2] 未提供 --public-base-url，跳过上传后自检（建议提供以便发现 CDN 侧问题）");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
