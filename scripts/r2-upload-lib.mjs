/**
 * Cloudflare R2 上传的公共机制：本仓库有两个上传脚本共用它。
 *
 *   - scripts/upload-remote-assets-r2.mjs  远程工作区资产（<版本>/manifest-*.json + components/**）
 *   - scripts/upload-headless-release-r2.mjs  无头服务器载荷（latest.json + releases/<版本>/**）
 *
 * 为什么抽成共享模块而不是各写一份：这两个脚本的差异只在"传什么 key"，
 * 而 put 的参数、重试策略、自检口径、列举方式必须完全一致 —— 分成两套实现后，
 * 一处修好的假信号（见下 fetchWithRetry 的注释）不会自动出现在另一处。
 *
 * 凭据口径（两个脚本共同遵守）：只用本机 wrangler 的登录态，**不接受**任何凭据
 * 出现在命令行或环境变量里；本模块不读、不打印任何 token。
 */

import { spawn } from "node:child_process";

/**
 * 缓存头口径（docs/operations/remote-assets-cdn.md §6）：
 *   - 内容寻址（components/**，key 里带 sha12）⇒ 永不可变，可长缓存；
 *   - 按名字寻址（版本目录下的 json、latest.json、releases/<版本>/…）⇒ 短缓存，
 *     允许同 key 重传后在数分钟内全球生效。
 *
 * 注意 releases/<版本>/zcode-<版本>.tar.gz 是**按版本号寻址**：同版本重传时内容会变
 * （重新构建过），所以不能用 immutable —— 否则改过的包在 CDN 上永远取不到。
 * 它带版本号，但仍然必须走 max-age=300 这一档。
 */
export function cacheControlFor(key) {
  return isContentAddressed(key) ? "public, max-age=31536000, immutable" : "public, max-age=300";
}

/** 内容寻址 = key 里带制品 sha12 的那批（只可能是远程工作区资产）。 */
export function isContentAddressed(key) {
  return key.startsWith("components/");
}

/**
 * Content-Type 口径：只有 json 给 application/json，其余一律 application/octet-stream。
 *
 * 为什么不给 .tar.gz 用 application/gzip、不给 .txt 用 text/plain：docs/operations/remote-assets-cdn.md §6
 * 已把"新增别的文件类型时默认 application/octet-stream"写成契约，且远程工作区资产的上传
 * 已经按这个口径跑过多次。在这里"顺手改进"会让同一个桶里的对象出现两套口径，
 * 而收益是零 —— 客户端一律按字节流读取（curl -o / 解包），不看 Content-Type。
 */
export function contentTypeFor(key) {
  if (key.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * 带重试的 fetch：**网络异常**（DNS/TCP/TLS 抖动、代理瞬断）重试，HTTP 状态不重试。
 *
 * 为什么必须有：2026-09-24 实测一次完整上传里，72 个对象的自检有 2 个抛 `fetch failed`，
 * 而这两个对象用 curl 与 Node fetch 各复测都是 200 —— 是**瞬时网络抖动**。当时自检把它当硬失败，
 * 于是「上传全部成功」被报成 `exit 1`，正是最难排查的那类假信号。
 */
export const FETCH_RETRY_DELAYS_MS = [1000, 3000];

export async function fetchWithRetry(url, init) {
  let lastError;
  for (let attempt = 0; attempt <= FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_RETRY_DELAYS_MS.length) await sleep(FETCH_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

/**
 * 远端是否已有该 key（只读，Class B）。没有 publicBaseUrl 时无从判断，返回 false。
 *
 * 不可达时返回 false（当作「未确认」并继续上传）：内容寻址的同名对象内容一致，
 * 重传是幂等的，比因为网络抖动而跳过更安全。
 */
export async function remoteExists(publicBaseUrl, key) {
  if (!publicBaseUrl) return false;
  try {
    const response = await fetchWithRetry(`${publicBaseUrl}/${key}`, { method: "HEAD" });
    return response.status === 200;
  } catch {
    return false;
  }
}

/**
 * 上传一个对象。**覆盖语义**：R2 的 put 对同 key 是"创建/覆盖"，没有 `--clobber` 开关
 * （wrangler 4.124 的 `r2 object put` 只有 --force，那是数据目录校验提示，不是覆盖开关；
 * 实测同一 key 连传两次，第二次的内容生效）。所以"同版本重传"不需要额外参数，
 * 需要的是**缓存头别写成 immutable**（见 cacheControlFor）。
 *
 * 只回传 stderr 的最后 3 行：wrangler 失败时的可读原因在末尾，前面的进度噪音没有诊断价值。
 */
export function putObject({ bucket, key, file }) {
  return new Promise((resolvePut) => {
    const child = spawn(
      "wrangler",
      [
        "r2",
        "object",
        "put",
        `${bucket}/${key}`,
        "--file",
        file,
        "--remote",
        "--content-type",
        contentTypeFor(key),
        "--cache-control",
        cacheControlFor(key),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolvePut({ ok: false, error: error.message }));
    child.on("close", (code) =>
      resolvePut(
        code === 0
          ? { ok: true }
          : { ok: false, error: stderr.trim().split("\n").slice(-3).join("\n") },
      ),
    );
  });
}

/** 删除一个对象（wrangler 4.124 的 delete 需要 -y 跳过确认提示，否则无 TTY 时会挂住）。 */
export function deleteObject({ bucket, key }) {
  return new Promise((resolveDelete) => {
    const child = spawn(
      "wrangler",
      ["r2", "object", "delete", `${bucket}/${key}`, "--remote", "-y"],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolveDelete({ ok: false, error: error.message }));
    child.on("close", (code) =>
      resolveDelete(
        code === 0
          ? { ok: true }
          : { ok: false, error: stderr.trim().split("\n").slice(-3).join("\n") },
      ),
    );
  });
}

/**
 * 列举桶内对象。
 *
 * 为什么走 REST API 而不是 wrangler：wrangler 4.124 **没有** `r2 object list` 子命令
 * （实测 `wrangler r2 object --help` 只有 get/put/delete）。列举是"先列将删除的 key、再删"
 * 这条纪律的前提，没有它就只能盲删。
 *
 * 凭据从 `wrangler auth token` 取（**不回显、不落盘、不进 argv**：用 execFile 的 argv 传参，
 * 不经过 shell），账户 ID 从 `wrangler whoami --json` 取。两者都是本机登录态的读取，
 * 与 put/delete 用的是同一份凭据，没有引入新的凭据面。
 *
 * 分页：REST 返回 `result_info.cursor` + `is_truncated`，必须翻页；只取第一页会在
 * 对象数超过一页时漏掉旧版本，导致清理不干净（而"看起来成功了"）。
 */
export async function listObjects({ bucket, prefix, accountId, perPage = 1000 } = {}) {
  const token = await readWranglerToken();
  const account = accountId ?? (await readWranglerAccountId());
  const objects = [];
  let cursor;
  for (;;) {
    // perPage 可调只为让"翻页"这条路径能被实测到：默认 1000 在真实桶上一次就取完，
    // 翻页分支就永远不会被执行 —— 而它一旦坏了，清理会漏掉旧版本（且看起来成功）。
    const query = new URLSearchParams({ per_page: String(perPage) });
    if (prefix) query.set("prefix", prefix);
    if (cursor) query.set("cursor", cursor);
    const response = await fetchWithRetry(
      `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects?${query}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      // 只报状态码，不把响应体原样打出来 —— 鉴权失败时响应体里可能回显凭据相关字段。
      throw new Error(`列举对象失败：HTTP ${response.status}（检查 wrangler 登录态与桶名）`);
    }
    const body = await response.json();
    if (!body.success) {
      throw new Error(
        `列举对象失败：${(body.errors ?? []).map((item) => item.message).join("; ") || "未知错误"}`,
      );
    }
    for (const item of body.result ?? []) {
      objects.push({ key: item.key, size: item.size, lastModified: item.last_modified });
    }
    if (!body.result_info?.is_truncated) break;
    cursor = body.result_info.cursor;
  }
  return objects;
}

function runCapture(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (error) => resolveRun({ ok: false, error: error.message }));
    child.on("close", (code) =>
      resolveRun(code === 0 ? { ok: true, stdout } : { ok: false, error: `退出码 ${code}` }),
    );
  });
}

/**
 * 版本保留策略（纯函数，不碰网络）：给定远端已有对象，算出该保留哪些版本、该删哪些 key。
 *
 * 为什么把它从上传脚本里抽出来：这是整条链路上**唯一不可逆**的操作。
 * 抽成纯函数后可以用合成数据把红线钉死在测试里 —— 尤其是"components/** 永不入选"
 * 这一条：它一旦破了，删掉的是内容寻址、跨版本共享的资产，旧客户端会直接连不上远程工作区，
 * 而且删掉之后**没法从任何地方恢复**（除非重新构建旧版本）。
 *
 * 纪律（docs/operations/remote-assets-cdn.md §10）：
 *   1. 只认 releases/<版本>/<文件名> 三段式；其它形态（含 components/**）一律不入选。
 *   2. 当前版本无条件保留 —— 补传一个老版本时不会把自己删掉。
 *   3. 保留集按版本号降序取前 keepVersions 个。
 */
export function planVersionRetention({ objects, keepVersions, currentVersion }) {
  const byVersion = new Map();
  for (const object of objects) {
    const match = /^releases\/([^/]+)\/([^/]+)$/u.exec(object.key);
    if (!match) continue;
    const version = match[1];
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version).push(object);
  }
  const versions = [...byVersion.keys()].sort((left, right) => compareVersions(right, left));
  const keep = new Set(versions.slice(0, Math.max(keepVersions, 1)));
  keep.add(currentVersion);
  const doomed = [];
  for (const version of versions) {
    if (keep.has(version)) continue;
    for (const object of byVersion.get(version)) doomed.push(object);
  }
  return {
    versions,
    keep: [...keep].sort((left, right) => compareVersions(right, left)),
    doomed,
  };
}

/**
 * 版本号比较：数字分段（与 scripts/prepare-prebuilds.mjs 的 compareVersionSegments 同口径）。
 *
 * 为什么不用 semver 包：根 package.json 里没有它，为了一次排序新增运行时依赖不划算；
 * 而这里要排的版本号形态固定（本仓库自己产的 <上游版本>-ce.<N>[.fix.<M>]），
 * 数字分段比较已经给出正确序（实测 3.14.3-ce.2 < 3.14.3-ce.10，字符串比较会排反）。
 */
export function compareVersions(left, right) {
  const leftParts = String(left).split(/[.-]/u);
  const rightParts = String(right).split(/[.-]/u);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber;
      continue;
    }
    const compared = leftPart.localeCompare(rightPart, undefined, { numeric: true });
    if (compared !== 0) return compared;
  }
  return 0;
}

/** 读本机 wrangler 的登录 token。失败时只报"没登录"，绝不回显任何凭据内容。 */
export async function readWranglerToken() {
  const result = await runCapture("wrangler", ["auth", "token", "--json"]);
  if (!result.ok) {
    throw new Error(
      "无法读取 wrangler 登录态：请先在本机执行 wrangler login（或用 wrangler auth token --json 自查）",
    );
  }
  try {
    const { token } = JSON.parse(result.stdout);
    if (!token) throw new Error("empty");
    return token;
  } catch {
    throw new Error("wrangler auth token --json 的输出无法解析（版本不匹配？）");
  }
}

/** 读本机 wrangler 登录账户的 account id。多个账户时取第一个并提示用 --account-id 指定。 */
export async function readWranglerAccountId() {
  const result = await runCapture("wrangler", ["whoami", "--json"]);
  if (!result.ok) {
    throw new Error("无法读取 wrangler 账户信息：请先在本机执行 wrangler login");
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("wrangler whoami --json 的输出无法解析（版本不匹配？）");
  }
  const accounts = parsed.accounts ?? [];
  if (accounts.length === 0) {
    throw new Error("wrangler 当前未登录任何账户：先执行 wrangler login");
  }
  if (accounts.length > 1) {
    console.warn(
      `[r2] wrangler 登录了 ${accounts.length} 个账户，默认取第一个；` +
        "如需指定请传 --account-id（值见本机 wrangler whoami --json）",
    );
  }
  return accounts[0].id;
}
