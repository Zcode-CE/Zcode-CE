import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setDataBaseDir } from "../src/paths.js";
import {
  BotAttachmentPathRejectedError,
  botAttachmentAllowedRoot,
  resolveAllowedAttachmentLocalPath,
} from "../src/bots/attachmentPathGuard.js";
import {
  BotAttachmentUrlRejectedError,
  parseAllowedAttachmentHosts,
  resolveAllowedAttachmentAddresses,
  setBotAttachmentAllowedHosts,
} from "../src/bots/attachmentUrlGuard.js";

/**
 * Bot 入站附件的两处安全校验（task-95）。
 *
 * 为什么必须钉住：这两处缺口的入口是入站 payload（webhook 渠道的
 * `attachments[].localPath` / `.downloadUrl` 由请求方完全控制），所以它们不是
 * 「理论风险」而是「渠道一旦可用就立刻可达」。断言打在校验器的真实返回/抛错上，
 * 并覆盖「合法路径仍可用」——只测拒绝会让校验退化成「一律拒绝」而无人发现。
 *
 * 运行：cd packages/services && node --import tsx --test test/botAttachmentGuards.test.ts
 */

/**
 * 隔离数据根。
 *
 * 为什么不用改 HOME：`getDataBaseDir()` 把默认值在模块求值时固化了
 * （paths.ts:12 `defaultDataBaseDir = process.env.HOME?.trim() || homedir()`），
 * 之后再改 HOME 不会生效 —— 那样写测试会污染真实 ~/.zcode/v2（本文件初版踩过：
 * 在真实数据根里建了 bot-attachments/bot-1 与一个指向 /tmp 的软链）。
 * 因此改用模块自带的注入点 `setDataBaseDir()`，它优先于 HOME（paths.ts:34-39）。
 */
async function withIsolatedDataRoot(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-botguard-"));
  setDataBaseDir(home);
  try {
    await run(home);
  } finally {
    setDataBaseDir(null);
    await rm(home, { recursive: true, force: true });
  }
}

// ── localPath：越权读 ────────────────────────────────────────────────────────

test("localPath：附件缓存目录内的路径放行（合法路径仍可用）", async () => {
  await withIsolatedDataRoot(async () => {
    const root = botAttachmentAllowedRoot();
    const inside = join(root, "bot-1", "msg-1", "abc-photo.png");
    await mkdir(resolve(inside, ".."), { recursive: true });
    await writeFile(inside, "x");
    const allowed = await resolveAllowedAttachmentLocalPath(inside);
    assert.equal(allowed, resolve(inside));
  });
});

test("localPath：缓存目录之外的绝对路径被拒绝，且错误可操作", async () => {
  await withIsolatedDataRoot(async () => {
    const outside = join(tmpdir(), "zcode-outside-secret.txt");
    await writeFile(outside, "secret");
    await assert.rejects(
      () => resolveAllowedAttachmentLocalPath(outside),
      (error: unknown) => {
        assert.ok(error instanceof BotAttachmentPathRejectedError);
        // 可操作错误：必须同时给出「允许目录」与「收到的路径」，以及替代做法。
        assert.match(error.message, /outside the allowed directory/);
        assert.match(error.message, /dataBase64/);
        return true;
      },
    );
  });
});

test("localPath：同前缀的兄弟目录不被误判为目录内（防 startsWith 缺陷）", async () => {
  await withIsolatedDataRoot(async () => {
    const root = botAttachmentAllowedRoot();
    // 关键：\`${root}-evil\` 以 root 为字符串前缀，但不在 root 内。
    const sibling = `${root}-evil`;
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "x.txt"), "x");
    await assert.rejects(
      () => resolveAllowedAttachmentLocalPath(join(sibling, "x.txt")),
      BotAttachmentPathRejectedError,
    );
  });
});

test("localPath：\`..\` 穿越被拒绝", async () => {
  await withIsolatedDataRoot(async () => {
    const root = botAttachmentAllowedRoot();
    await mkdir(join(root, "bot-1"), { recursive: true });
    await assert.rejects(
      () =>
        resolveAllowedAttachmentLocalPath(join(root, "bot-1", "..", "..", "..", "etc", "passwd")),
      BotAttachmentPathRejectedError,
    );
  });
});

test("localPath：目录内的符号链接指向外部时被拒绝", async () => {
  await withIsolatedDataRoot(async () => {
    const root = botAttachmentAllowedRoot();
    const outsideDir = await mkdtemp(join(tmpdir(), "zcode-outside-"));
    await writeFile(join(outsideDir, "secret.txt"), "secret");
    await mkdir(root, { recursive: true });
    const link = join(root, "escape-link");
    await symlink(outsideDir, link);
    await assert.rejects(
      () => resolveAllowedAttachmentLocalPath(join(link, "secret.txt")),
      (error: unknown) => {
        assert.ok(error instanceof BotAttachmentPathRejectedError);
        assert.match(error.message, /symlink escapes/);
        return true;
      },
    );
  });
});

test("localPath：相对路径被拒绝（不依赖进程 cwd 解释）", async () => {
  await withIsolatedDataRoot(async () => {
    await assert.rejects(
      () => resolveAllowedAttachmentLocalPath("bot-attachments/x.txt"),
      (error: unknown) => {
        assert.ok(error instanceof BotAttachmentPathRejectedError);
        assert.match(error.message, /not absolute/);
        return true;
      },
    );
  });
});

// ── downloadUrl：SSRF ────────────────────────────────────────────────────────

test("downloadUrl：回环地址被拒绝", async () => {
  for (const url of [
    "http://127.0.0.1/x",
    "http://127.1.2.3/x",
    "http://localhost/x",
    "http://[::1]/x",
  ]) {
    await assert.rejects(
      () => resolveAllowedAttachmentAddresses(new URL(url)),
      BotAttachmentUrlRejectedError,
      `应拒绝 ${url}`,
    );
  }
});

test("downloadUrl：云元数据地址 169.254.169.254 被拒绝", async () => {
  await assert.rejects(
    () => resolveAllowedAttachmentAddresses(new URL("http://169.254.169.254/latest/meta-data/")),
    (error: unknown) => {
      assert.ok(error instanceof BotAttachmentUrlRejectedError);
      assert.equal(error.reason, "blocked_address");
      return true;
    },
  );
});

test("downloadUrl：私有网段被拒绝（10/172.16/192.168）", async () => {
  for (const url of ["http://10.0.0.1/x", "http://172.16.0.1/x", "http://192.168.1.1/x"]) {
    await assert.rejects(
      () => resolveAllowedAttachmentAddresses(new URL(url)),
      BotAttachmentUrlRejectedError,
      `应拒绝 ${url}`,
    );
  }
});

test("downloadUrl：非整数/十六进制等 IPv4 变体不能绕过判定", async () => {
  // URL 规范化后这些都会变回 127.0.0.1 —— 断言「规范化之后」仍被拒绝，
  // 这正是「不要只挡字符串前缀」的判据。
  for (const raw of ["http://2130706433/x", "http://0x7f000001/x", "http://0177.0.0.1/x"]) {
    const normalized = new URL(raw).hostname;
    await assert.rejects(
      () => resolveAllowedAttachmentAddresses(new URL(raw)),
      BotAttachmentUrlRejectedError,
      `应拒绝 ${raw}（规范化后 host=${normalized}）`,
    );
  }
});

test("downloadUrl：IPv4-mapped IPv6 回环不能绕过判定", async () => {
  await assert.rejects(
    () => resolveAllowedAttachmentAddresses(new URL("http://[::ffff:127.0.0.1]/x")),
    BotAttachmentUrlRejectedError,
  );
});

test("downloadUrl：合法公网字面量地址放行（合法地址仍可用）", async () => {
  const addresses = await resolveAllowedAttachmentAddresses(new URL("http://93.184.216.34/x"));
  assert.equal(addresses.length, 1);
  assert.equal(addresses[0]?.address, "93.184.216.34");
});

// ── 可配置放行项（默认安全 + 用户可放宽）────────────────────────────────────

test("放行项：解析口径正确（去空白、小写、丢空项）", () => {
  assert.deepEqual(parseAllowedAttachmentHosts(" NAS.Local , 10.0.0.5 ,, "), [
    "nas.local",
    "10.0.0.5",
  ]);
  assert.deepEqual(parseAllowedAttachmentHosts(undefined), []);
});

test("放行项：登记后内网地址被放行（用户可自行放宽）", async () => {
  setBotAttachmentAllowedHosts(["10.0.0.5"]);
  try {
    const addresses = await resolveAllowedAttachmentAddresses(new URL("http://10.0.0.5/file"));
    assert.equal(addresses[0]?.address, "10.0.0.5");
  } finally {
    setBotAttachmentAllowedHosts([]);
  }
});

test("放行项：未登记的内网地址仍被拒绝（默认安全不被放宽影响）", async () => {
  setBotAttachmentAllowedHosts(["10.0.0.5"]);
  try {
    await assert.rejects(
      () => resolveAllowedAttachmentAddresses(new URL("http://10.0.0.6/file")),
      BotAttachmentUrlRejectedError,
    );
  } finally {
    setBotAttachmentAllowedHosts([]);
  }
});

test("放行项：不做后缀匹配（登记 evil.com 不放行 notevil.com）", async () => {
  setBotAttachmentAllowedHosts(["localhost"]);
  try {
    // 精确匹配才放行；这是防「登记 com 就放行一切」的判据。
    await assert.rejects(
      () => resolveAllowedAttachmentAddresses(new URL("http://notlocalhost/x")),
      BotAttachmentUrlRejectedError,
    );
  } finally {
    setBotAttachmentAllowedHosts([]);
  }
});

test("放行项：清空后回到默认安全（可逆）", async () => {
  setBotAttachmentAllowedHosts(["127.0.0.1"]);
  try {
    await resolveAllowedAttachmentAddresses(new URL("http://127.0.0.1/x"));
  } finally {
    setBotAttachmentAllowedHosts([]);
  }
  await assert.rejects(
    () => resolveAllowedAttachmentAddresses(new URL("http://127.0.0.1/x")),
    BotAttachmentUrlRejectedError,
  );
});

test("downloadUrl：解析到私网的域名被拒绝（判据看解析后地址，不看字符串）", async () => {
  // 用一个真实存在、稳定解析到 127.0.0.1 的名字验证「解析后判定」这条口径。
  await assert.rejects(
    () => resolveAllowedAttachmentAddresses(new URL("http://localtest.me/x")),
    BotAttachmentUrlRejectedError,
  );
});
