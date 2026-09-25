#!/usr/bin/env node
/**
 * 把无头服务器发行载荷上传到 Cloudflare R2（配合 scripts/build-zcode.mjs 的产出）。
 *
 *   node scripts/upload-headless-release-r2.mjs --dist dist/zcode --bucket <bucket> \
 *     --public-base-url https://<域名>
 *
 * 为什么需要它：install.sh 的布局与远程工作区资产不是同一套寻址方式。
 *   install.sh（scripts/zcode-distribution/installer.mjs）读的是：
 *     <BASE>/latest.json                     版本索引（version + tarball + sha256）
 *     <BASE>/releases/<版本>/<tarball>       运行包
 *   而远程工作区资产是 <BASE>/<版本>/manifest-*.json + <BASE>/components/**。
 *   两者共用同一个桶与域名，但 key 的层级完全不同，所以是**两个脚本**，
 *   公共机制（put/delete/列举/重试/自检口径）在 scripts/r2-upload-lib.mjs。
 *
 * 上传哪些对象（相对 --dist，即 build-zcode.mjs 的 outDir）：
 *   latest.json
 *   releases/<版本>/<tarball>     （默认只传 --version 指定的那一个版本）
 *   releases/<版本>/sha256.txt
 * 刻意**不传** dist/zcode/install.sh：它是给用户复制/自取的脚本，由文档指向；
 * 把它也传上去会让"哪个 install.sh 是权威版本"变成两个来源。
 * （要传也行，加 --include-install-sh，但默认不传。）
 *
 * 同版本重传（覆盖语义）：releases/<版本>/** 与 latest.json 都是**按名字寻址**，
 * 重新构建后同 key 的内容会变，因此必须能覆盖。核实结论：wrangler 4.124 的
 * r2 object put 没有 --clobber 开关（它的 --force/-y 是数据目录校验提示，与覆盖无关），
 * 但 **put 本身就是覆盖语义** —— 实测同一 key 连传两次，第二次的内容生效。
 * 所以"覆盖"不需要额外参数；真正要守住的是**缓存头不能写成 immutable**
 * （见 r2-upload-lib.mjs 的 cacheControlFor：只有 components/** 走 immutable）。
 * 本脚本默认按"允许覆盖"工作，用 --no-clobber 可以改成"已存在就报错"（补传场景）。
 *
 * 保留最近 N 个版本：见 --keep-versions。清理**先列将删除的 key、再删**，
 * 且只动 releases/<版本>/** —— components/** 与版本目录下的其它内容绝不触碰
 * （红线见 docs/operations/remote-assets-cdn.md §10）。
 *
 * 凭据：只用本机 wrangler 的登录态（wrangler login）。本脚本**不读、不打印任何凭据**；
 * 列举时内部用 wrangler auth token，但那个值从不落到 stdout/stderr 或命令行参数里。
 *
 * 用法：
 *   node scripts/upload-headless-release-r2.mjs --dist dist/zcode --bucket <bucket> \
 *     --public-base-url https://<域名> --dry-run
 *   node scripts/upload-headless-release-r2.mjs --dist dist/zcode --bucket <bucket> \
 *     --public-base-url https://<域名> --keep-versions 10 --yes
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  cacheControlFor,
  contentTypeFor,
  deleteObject,
  fetchWithRetry,
  listObjects,
  planVersionRetention,
  putObject,
  sleep,
} from "./r2-upload-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const distDir = resolve(args.dist ?? "dist/zcode");
const bucket = (args.bucket ?? process.env.ZCODE_R2_BUCKET ?? "").trim();
const publicBaseUrl = (args.publicBaseUrl ?? process.env.ZCODE_DIST_CDN_BASE_URL ?? "")
  .trim()
  .replace(/\/+$/, "");
const dryRun = args.dryRun === true;
const keepVersions = Number(args.keepVersions ?? 10);
const clobber = args.clobber !== false;
const includeInstallSh = args.includeInstallSh === true;
const accountId = args.accountId;

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function collectUploads() {
  if (!existsSync(distDir)) {
    throw new Error(
      "发行目录不存在：" + distDir + "（先跑 pnpm build:zcode 或 node scripts/build-zcode.mjs）",
    );
  }
  const latestPath = join(distDir, "latest.json");
  if (!existsSync(latestPath)) {
    throw new Error("缺少版本索引：" + latestPath + "（build-zcode.mjs 的产出根下应当有它）");
  }
  const latest = JSON.parse(readFileSync(latestPath, "utf8"));
  const version = args.version ?? latest.version;
  if (!version) {
    throw new Error("latest.json 里没有 version，且未传 --version");
  }
  const releaseDir = join(distDir, "releases", version);
  if (!existsSync(releaseDir)) {
    throw new Error("版本目录不存在：" + releaseDir);
  }
  const tarballName = latest.tarball ?? "zcode-" + version + ".tar.gz";
  const tarballPath = join(releaseDir, tarballName);
  const sha256Path = join(releaseDir, "sha256.txt");
  for (const entry of [
    { path: tarballPath, label: "运行包" },
    { path: sha256Path, label: "校验摘要" },
  ]) {
    if (!existsSync(entry.path)) throw new Error("缺少" + entry.label + "：" + entry.path);
  }

  // 自检先做：latest.json 声明的 sha256 必须与磁盘上的 tarball 一致。
  // 不一致意味着这份产物在构建后被改过（或 latest.json 是旧的），传上去会让所有装的人校验失败。
  const actualSha256 = sha256File(tarballPath);
  if (String(latest.sha256 ?? "").toLowerCase() !== actualSha256) {
    throw new Error(
      "latest.json 的 sha256 与运行包不一致：latest=" +
        latest.sha256 +
        " actual=" +
        actualSha256 +
        "\n  这份产物已被改动或 latest.json 过期，先重新构建再上传。",
    );
  }
  // sha256.txt 也必须与同一个值一致（install.sh 之外的校验路径会读它）。
  const sha256Line = readFileSync(sha256Path, "utf8").trim().split(/\s+/u)[0];
  if (sha256Line.toLowerCase() !== actualSha256) {
    throw new Error(
      "releases/" +
        version +
        "/sha256.txt 与运行包不一致：file=" +
        sha256Line +
        " actual=" +
        actualSha256,
    );
  }

  const uploads = [
    { key: "releases/" + version + "/" + tarballName, file: tarballPath },
    { key: "releases/" + version + "/sha256.txt", file: sha256Path },
  ];
  if (includeInstallSh) {
    const installSh = join(distDir, "install.sh");
    if (!existsSync(installSh)) throw new Error("--include-install-sh 但文件不存在：" + installSh);
    uploads.push({ key: "install.sh", file: installSh });
  }
  // latest.json 放最后：它一旦更新，客户端就会去取新版本；新版本的对象必须已经在桶里。
  // 顺序反了会出现「latest.json 指向一个还取不到的 tar」的窗口期。
  uploads.push({ key: "latest.json", file: latestPath });
  return { version, uploads, sha256: actualSha256 };
}

function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

async function sha256Stream(stream) {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function uploadAll(uploads) {
  const failures = [];
  for (const item of uploads) {
    const size = mb(statSync(item.file).size);
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await putObject({ bucket, key: item.key, file: item.file });
      if (result.ok) {
        console.log(
          "  [ok] " +
            item.key +
            "  (" +
            size +
            " MB / " +
            contentTypeFor(item.key) +
            " / " +
            cacheControlFor(item.key) +
            ")",
        );
        break;
      }
      lastError = result.error ?? "unknown";
      console.warn("  [retry " + attempt + "] " + item.key + ": " + lastError);
      await sleep(2000 * attempt);
      if (attempt === 3) failures.push({ key: item.key, error: lastError });
    }
  }
  return failures;
}

/**
 * 上传后自检：HEAD 校验可取性，再按类型 GET 校验内容。
 *
 * 为什么不能只 HEAD：HEAD 只证明"这个 key 上有东西"，证明不了"内容是我们刚传的那份"。
 * CDN 缓存、覆盖写都可能让对象存在但内容不对 —— 而这条链路的最终消费者是 install.sh，
 * 它拿到的 tar 必须与 sha256.txt 逐字节匹配（所以这里对 tar 走流式 sha256，不整份落盘）。
 */
async function verifyUploads({ version, uploads, sha256 }) {
  let bad = 0;
  let unverified = 0;

  for (const item of uploads) {
    const url = publicBaseUrl + "/" + item.key;
    try {
      const head = await fetchWithRetry(url, { method: "HEAD" });
      if (head.status !== 200) {
        bad += 1;
        console.error("  BAD HEAD " + head.status + " " + item.key);
        continue;
      }
    } catch (error) {
      // 网络错误 != 对象不可取（2026-09-24 实测踩到）：记"未确认"，不当硬失败。
      unverified += 1;
      console.warn("  UNVERIFIED HEAD " + item.key + ": " + error.message);
      continue;
    }

    try {
      if (item.key.endsWith(".tar.gz")) {
        const response = await fetchWithRetry(url);
        if (response.status !== 200) {
          bad += 1;
          console.error("  BAD GET " + response.status + " " + item.key);
          continue;
        }
        const remoteSha = await sha256Stream(response.body);
        if (remoteSha !== sha256) {
          bad += 1;
          console.error("  BAD SHA " + item.key + ": remote=" + remoteSha + " expected=" + sha256);
        } else {
          console.log("  [verified] " + item.key + " sha256 匹配");
        }
      } else if (item.key.endsWith(".json")) {
        const response = await fetchWithRetry(url);
        if (response.status !== 200) {
          bad += 1;
          console.error("  BAD GET " + response.status + " " + item.key);
          continue;
        }
        const remote = await response.json();
        const local = JSON.parse(readFileSync(item.file, "utf8"));
        if (remote.version !== local.version || remote.tarball !== local.tarball) {
          bad += 1;
          console.error(
            "  BAD JSON " +
              item.key +
              ": remote version=" +
              remote.version +
              " tarball=" +
              remote.tarball +
              " expected version=" +
              local.version +
              " tarball=" +
              local.tarball,
          );
        } else if (String(remote.sha256 ?? "").toLowerCase() !== sha256) {
          bad += 1;
          console.error(
            "  BAD JSON " + item.key + ": sha256=" + remote.sha256 + " expected=" + sha256,
          );
        } else {
          console.log(
            "  [verified] " + item.key + " 内容与本地一致（version=" + remote.version + "）",
          );
        }
      } else {
        // sha256.txt：下载后与本地比对（它只有 100 字节左右）。
        const response = await fetchWithRetry(url);
        const remoteText = (await response.text()).trim();
        const localText = readFileSync(item.file, "utf8").trim();
        if (remoteText !== localText) {
          bad += 1;
          console.error("  BAD TXT " + item.key + ": 内容与本地不一致");
        } else {
          console.log("  [verified] " + item.key + " 内容与本地一致");
        }
      }
    } catch (error) {
      unverified += 1;
      console.warn("  UNVERIFIED GET " + item.key + ": " + error.message);
    }
  }

  if (unverified > 0) {
    console.error(
      "[headless] ⚠️ " +
        unverified +
        " 个对象因网络错误未能确认（不是 404，不代表对象缺失）—— 请重跑一次自检确认",
    );
  }
  if (bad > 0) {
    console.error(
      "[headless] 自检失败：" + bad + " 个对象在 " + publicBaseUrl + " 上不可取或内容不符",
    );
    return false;
  }
  console.log(
    "[headless] 自检通过：" + uploads.length + " 个对象全部可取且内容一致（版本 " + version + "）",
  );
  return true;
}

/**
 * 清理旧版本：保留最近 keepVersions 个（按版本号降序），其余版本的 releases/<版本>/** 删除。
 *
 * 判定逻辑本身是**纯函数**（planVersionRetention，在 r2-upload-lib.mjs），这里只负责
 * 取远端清单。为什么这样切：删除是这条链路上唯一不可逆的操作，
 * 纯函数才能用合成数据把红线钉进测试（见 test/uploadHeadlessReleaseRetention.test.mjs）。
 *
 * 纪律：
 *   1. **先列将删除的 key、再删**：完整清单先打出来，dry-run 或需要 --yes 才真删。
 *   2. 只删 releases/<版本>/**，components/** 连候选都不进（红线 §10）。
 *   3. 只删**确实存在于远端**的 key（用列举结果，不是本地目录）。
 */
async function planCleanup({ currentVersion }) {
  const objects = await listObjects({ bucket, prefix: "releases/", accountId });
  return planVersionRetention({ objects, keepVersions, currentVersion });
}

function printCleanupPlan(plan, keepVersions) {
  console.log(
    "[headless] 远端 releases/ 版本（新→旧）：" +
      (plan.versions.join(", ") || "(无)") +
      "；保留 " +
      plan.keep.join(", "),
  );
  if (plan.doomed.length === 0) {
    console.log("[headless] 无需清理（远端版本数未超过 --keep-versions=" + keepVersions + "）");
    return;
  }
  console.log(
    "[headless] 以下 " +
      plan.doomed.length +
      " 个对象将被删除（保留最近 " +
      keepVersions +
      " 个版本）：",
  );
  for (const object of plan.doomed) {
    console.log(
      "  [del] " + object.key + "  (" + mb(object.size) + " MB, " + object.lastModified + ")",
    );
  }
}

async function main() {
  if (!bucket) {
    throw new Error(
      "缺少对象桶名：用 --bucket <bucket> 或环境变量 ZCODE_R2_BUCKET 指定" +
        "（值见 docs/operations/remote-assets-cdn.md §12 指向的本地私密笔记；不要写进仓库）",
    );
  }
  if (!publicBaseUrl && !dryRun) {
    throw new Error(
      "缺少发布根：用 --public-base-url https://<域名> 指定" +
        "（上传后自检需要它；没有它就无法确认 CDN 侧真的可取）",
    );
  }
  if (publicBaseUrl && !/^https?:\/\//iu.test(publicBaseUrl)) {
    throw new Error(
      "发布根必须带协议：收到 " +
        JSON.stringify(publicBaseUrl) +
        "（应为 https://<域名>）—— 只写域名会让上传后的自检全部失败",
    );
  }
  if (!Number.isInteger(keepVersions) || keepVersions < 1) {
    throw new Error("--keep-versions 必须是 >=1 的整数，收到 " + JSON.stringify(args.keepVersions));
  }

  const { version, uploads, sha256 } = collectUploads();
  console.log(
    "[headless] bucket=" +
      bucket +
      " dist=" +
      distDir +
      " version=" +
      version +
      " keepVersions=" +
      keepVersions +
      " clobber=" +
      clobber +
      (dryRun ? "（dry-run）" : ""),
  );
  console.log("[headless] sha256 自检通过：" + sha256);

  if (dryRun) {
    console.log("[headless] 将上传（顺序即下表；latest.json 最后）：");
    for (const item of uploads) {
      console.log(
        "  [dry] " +
          item.key +
          "  (" +
          contentTypeFor(item.key) +
          " / " +
          cacheControlFor(item.key) +
          ")",
      );
    }
    console.log("[headless] 清理计划（仅列，不删）：");
    printCleanupPlan(await planCleanup({ currentVersion: version }), keepVersions);
    return;
  }

  if (!clobber) {
    // --no-clobber：只想补传缺失对象时用。先列远端已有的 key，冲突就报错而不是覆盖。
    const existing = new Set(
      (await listObjects({ bucket, prefix: "releases/" + version + "/", accountId })).map(
        (o) => o.key,
      ),
    );
    const conflicts = uploads.filter((item) => existing.has(item.key)).map((item) => item.key);
    if (conflicts.length > 0) {
      throw new Error(
        "--no-clobber 且远端已存在：" +
          conflicts.join(", ") +
          "\n  要覆盖请去掉 --no-clobber（put 本身就是覆盖语义）。",
      );
    }
  }

  const failures = await uploadAll(uploads);
  if (failures.length > 0) {
    console.error("[headless] 失败 " + failures.length + " 个对象：");
    for (const failure of failures) console.error("  FAIL " + failure.key + ": " + failure.error);
    process.exit(1);
  }
  console.log("[headless] 上传完成：" + uploads.length + " 个对象");

  if (!(await verifyUploads({ version, uploads, sha256 }))) process.exit(1);

  const plan = await planCleanup({ currentVersion: version });
  printCleanupPlan(plan, keepVersions);
  if (plan.doomed.length === 0) return;
  if (!args.yes) {
    console.log(
      "[headless] 未删除：加 --yes 确认执行清理（先看一眼上面的清单是否符合预期；" +
        "components/** 永远不会出现在这份清单里）。",
    );
    return;
  }
  const deleteFailures = [];
  for (const object of plan.doomed) {
    const result = await deleteObject({ bucket, key: object.key });
    if (result.ok) {
      console.log("  [deleted] " + object.key);
    } else {
      deleteFailures.push({ key: object.key, error: result.error });
    }
  }
  if (deleteFailures.length > 0) {
    console.error("[headless] 删除失败 " + deleteFailures.length + " 个：");
    for (const failure of deleteFailures)
      console.error("  FAIL " + failure.key + ": " + failure.error);
    process.exit(1);
  }
  console.log("[headless] 清理完成：删除 " + plan.doomed.length + " 个对象");
}

function parseArgs(argv) {
  const parsed = {};
  const valued = new Set([
    "--dist",
    "--bucket",
    "--public-base-url",
    "--version",
    "--keep-versions",
    "--account-id",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (valued.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("参数 " + token + " 缺少取值");
      }
      parsed[token.slice(2).replace(/-([a-z])/gu, (_m, c) => c.toUpperCase())] = value;
      index += 1;
    } else if (token === "--dry-run") {
      parsed.dryRun = true;
    } else if (token === "--no-clobber") {
      parsed.clobber = false;
    } else if (token === "--include-install-sh") {
      parsed.includeInstallSh = true;
    } else if (token === "--yes" || token === "-y") {
      parsed.yes = true;
    } else {
      throw new Error("未知参数：" + token);
    }
  }
  return parsed;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
