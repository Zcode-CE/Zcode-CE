import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_BOT_COMMANDS } from "@zcode/shared";
import { BOTS_CONFIG_FILE } from "../src/bots/config.js";
import { createBotsService } from "../src/bots/botsService.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";

/**
 * 打到最终消费点：用真实 botsService 走 webhook 入站回调，验证三件事。
 *
 * 为什么必须走真实服务而不是只调校验器：本批的缺陷（R8 日志泄露正文、localPath 越权读、
 * downloadUrl SSRF）都发生在 `processProviderCallback` 这条真实消费路径上，
 * 而不是校验器内部。只测校验器会漏掉「调用点忘了接校验器」这一类最可能的回归。
 *
 * 入口选 `handleProviderCallbackResponse`：它是 HTTP 路由
 * （packages/server/src/http.ts 的 `POST /api/bots/:provider`）唯一调用的方法，
 * 也就是第三方 IM 真正能打到的那一层。
 *
 * 运行：cd packages/services && node --import tsx --test test/botChannelCallbackPath.test.ts
 */

interface Harness {
  handle(payload: unknown): Promise<{
    ok: boolean;
    status?: number;
    replies?: { text?: string }[];
  }>;
  logLines: string[];
}

function webhookBot(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    provider: "webhook",
    enabled: true,
    // 已绑定用户：findAuthorizedBot 要求 enabled && provider 匹配 && providerUserId 匹配，
    // 否则回调会先返回「当前 bot 未启用」，走不到附件解析那条路径（测不到我们要测的东西）。
    providerUserId: "u-1",
    // 允许所有 workspace：否则回调会停在「没有可用 workspace」，走不到附件解析那条路径。
    allowedWorkspaces: ["*"],
    allowedCommands: { ...DEFAULT_BOT_COMMANDS },
    currentOptions: {},
    replyMode: "assistant_changes",
    ...overrides,
  };
}

/** 夹具里 webhook 凭据的 key 与值（与 webhookBot 的 webhookSecretRef 对应）。 */
const FIXTURE_SECRET = "fixture-webhook-secret";

async function withBotsService(
  bots: unknown[],
  run: (harness: Harness) => Promise<void>,
  /**
   * 凭据库返回什么。
   * - `"value"`（默认）：返回 FIXTURE_SECRET ⇒ 请求必须带匹配的 secret 才能通过校验。
   * - `"missing"`：返回 null ⇒ 用于验证「ref 配了但读不到」也必须 fail-closed。
   *
   * 为什么需要这个旋钮：fail-open 修复前，夹具靠 `load: async () => null` +
   * `webhookSecretRef` 已配，**恰好命中原实现的短路分支**（`expected && ...`），
   * 从而「不校验就放行」，让用例能走到附件解析那条深路径。修复后这条路不再存在，
   * 夹具必须显式提供凭据，否则测的就不是附件而是凭据拒绝了。
   */
  credentialMode: "value" | "missing" = "value",
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-botpath-"));
  setDataBaseDir(home);
  const logLines: string[] = [];
  const originalLog = console.log;
  // botsLogger 走 createServiceLogger("bots") → console；捕获它就是捕获真实落盘内容
  // （host 侧 console 钩子把 info 落到 ~/.zcode/v2/logs/*.log，见 host/index.ts:1553-1574）。
  console.log = (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  try {
    const configPath = join(getAppConfigDir(), BOTS_CONFIG_FILE);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ version: 3, bots }, null, 2));
    const service = createBotsService({
      credentialService: {
        load: async () => (credentialMode === "missing" ? null : FIXTURE_SECRET),
        save: async () => undefined,
        delete: async () => undefined,
      },
      zcodeTaskService: {
        listWorkspaceRefs: async () => [],
      } as never,
      modelSelectionService: { getView: async () => ({}) } as never,
      // 提供一个真实存在的本地 workspace：listWorkspaceRefs 从 settingService 的
      // lastWorkspaceSession 读取，缺它会让回调停在「没有可用 workspace」。
      settingService: {
        get: async () => ({
          lastWorkspaceSession: [{ kind: "local", workspacePath: home }],
        }),
        update: async () => undefined,
        updateDataBaseDir: async () => undefined,
        ensureDefaultProject: async () => ({ path: home, created: false }),
      } as never,
      runStartupBackgroundTasks: false,
    });
    await run({
      handle: (payload) => service.handleProviderCallbackResponse("webhook", payload),
      logLines,
    });
    service.disposeAll();
  } finally {
    console.log = originalLog;
    setDataBaseDir(null);
    await rm(home, { recursive: true, force: true });
  }
}

test("最终消费点：用户消息正文不出现在 bots 日志里（R8）", async () => {
  // 必须带**匹配**的 secret：fail-closed 之后，错误/缺失的 secret 会在凭据处就停下，
  // 根本走不到写 `provider callback ... textLen=` 那行，本用例会退化成空转。
  const secret = FIXTURE_SECRET;
  const userText = "MY-SECRET-MESSAGE-BODY-12345";
  await withBotsService([webhookBot("bot-1", { webhookSecretRef: "wh-1" })], async (harness) => {
    await harness.handle({
      botId: "bot-1",
      userId: "u-1",
      text: userText,
      webhookSecret: secret,
    });
    const joined = harness.logLines.join("\n");
    assert.ok(joined.length > 0, "应当确实产生了日志（否则这条断言是空转）");
    assert.ok(!joined.includes(userText), `日志里出现了用户消息正文：\n${joined}`);
    // 正向：排障需要的长度信息仍在（证明不是把日志整条删掉）
    assert.match(joined, /textLen=\d+/);
  });
});

test("最终消费点：localPath 越权读在真实回调路径上被拒绝", async () => {
  const outside = join(tmpdir(), `zcode-e2e-secret-${Date.now()}.txt`);
  await writeFile(outside, "TOP-SECRET-FILE-CONTENT");
  try {
    // 必须配 webhookSecretRef 并带匹配 secret：否则 fail-closed 会在凭据处就拒绝，
    // 走不到附件路径解析，本用例会测错对象。
    await withBotsService([webhookBot("bot-1", { webhookSecretRef: "wh-1" })], async (harness) => {
      const result = await harness.handle({
        botId: "bot-1",
        userId: "u-1",
        text: "",
        webhookSecret: FIXTURE_SECRET,
        attachments: [
          {
            id: "a1",
            kind: "file",
            filename: "secret.txt",
            mimeType: "text/plain",
            localPath: outside,
          },
        ],
      });
      // 有牙齿的断言：越权必须让这次投递失败并给出可操作错误。
      // 修复前（无校验）会直接读成功 ⇒ 这里会看到附件被接受、没有任何拒绝文案 ⇒ 测试变红。
      // 实测反向验证：把校验摘掉 ⇒ 本断言失败（见 FEISHU-SDK-174-REVIEW.md 的登记）。
      const joined = harness.logLines.join("\n");
      assert.ok(!joined.includes("TOP-SECRET-FILE-CONTENT"), "越权文件内容不得进入任何日志/输出");
      const replies = (result.replies ?? []).map((reply) => reply.text ?? "").join("\n");
      assert.match(
        replies,
        /附件处理失败|Failed to process attachment/,
        `越权 localPath 必须被拒绝并回复用户可操作错误，实际回复：${replies || "(空)"}`,
      );
      assert.match(
        replies,
        /outside the allowed directory/,
        "拒绝文案必须说明是路径不在允许目录内",
      );
    });
  } finally {
    await rm(outside, { force: true });
  }
});

test("最终消费点：downloadUrl 指向回环时在真实回调路径上被拒绝", async () => {
  await withBotsService([webhookBot("bot-1", { webhookSecretRef: "wh-1" })], async (harness) => {
    const result = await harness.handle({
      botId: "bot-1",
      userId: "u-1",
      text: "",
      webhookSecret: FIXTURE_SECRET,
      attachments: [
        {
          id: "a1",
          kind: "file",
          filename: "meta.json",
          mimeType: "application/json",
          // 云元数据地址：修复前这里会真的发出去
          downloadUrl: "http://169.254.169.254/latest/meta-data/",
        },
      ],
    });
    // 有牙齿的断言：SSRF 目标必须被拒绝并回复用户。
    // 修复前会真的 fetch 169.254.169.254（在真实主机上可能挂起或取回内容）。
    const joined = harness.logLines.join("\n");
    assert.ok(!joined.includes("ami-id"), "不得取回元数据内容");
    const replies = (result.replies ?? []).map((reply) => reply.text ?? "").join("\n");
    assert.match(
      replies,
      /附件处理失败|Failed to process attachment/,
      `SSRF 目标必须被拒绝并回复用户可操作错误，实际回复：${replies || "(空)"}`,
    );
    // 关键：必须是被校验器拒绝，而不是"网络恰好连不上"。
    // 反向验证实测过：把校验摘掉后这里会走 10s 超时 → 回复变成通用的
    // attachmentDownloadUnavailable，本断言即失败。这是本测试有牙齿的判据。
    assert.match(
      replies,
      /Bot attachment URL rejected/,
      `必须由 SSRF 校验器拒绝（而不是网络失败兜底），实际回复：${replies}`,
    );
  });
});

/**
 * ── fail-closed 护栏（task-97 / BOT-INGRESS-SPEC §3.7）─────────────────────────
 *
 * 背景（实测）：修复前 `botsService.ts` 的 webhook 凭据校验是**两处条件式叠加**：
 *   `if (bot?.provider === "webhook" && bot.webhookSecretRef) { const expected = await load(...);
 *     if (expected && expected !== inboundSecret) { 拒绝 } }`
 * ⇒ ① 未配 `webhookSecretRef` ⇒ 整段跳过；② ref 配了但 `load` 返回 null ⇒ `expected &&` 短路。
 * 两种情形都**不校验就放行**（实测：攻击者不带/乱带 secret 都能执行 /help）。
 *
 * 这两条用例把「必须 fail-closed」钉死。它们与路由层的用例（packages/server 的 botIngress.test.ts）
 * 是**两条独立的护栏**：路由层那条走 HTTP，只要路由层拦住就绿（**即使服务层仍 fail-open**）；
 * 这两条直接调 service，只要服务层拦住就绿（**即使路由层没做**）。
 * ⇒ 合起来才能证明「任一层单独失效时另一层仍在承重」。
 */

test("fail-closed①：ref 配了但凭据库读不到 ⇒ 必须拒绝（修复前会放行）", async () => {
  await withBotsService(
    [webhookBot("bot-1", { webhookSecretRef: "wh-1" })],
    async (harness) => {
      const result = await harness.handle({
        botId: "bot-1",
        userId: "u-1",
        text: "/help",
        webhookSecret: "ATTACKER-GUESS",
      });
      const replies = (result.replies ?? []).map((r) => r.text ?? "").join("\n");
      // 有牙齿的断言：必须被凭据拒绝，而不是执行了命令。
      // 反向验证：把 fail-closed 改回 `if (expectedSecret && ...)` ⇒ 本断言变红
      // （实测修复前此处会返回 /help 的命令列表）。
      assert.match(
        replies,
        /Webhook secret 校验失败|Webhook secret verification failed/,
        "读不到期望 secret 时必须拒绝，实际回复：" + (replies || "(空)"),
      );
      assert.ok(
        !replies.includes("/帮助") && !replies.includes("/help"),
        "拒绝路径不得执行任何命令，实际回复：" + replies,
      );
      // 且必须体现为「本次投递未成功」：否则 provider 会把失败当成功提交消费游标。
      assert.equal(result.ok, false, "凭据失败必须使 ok=false（否则 webhook 会以为消息已消费）");
    },
    "missing",
  );
});

test("fail-closed②：完全未配 webhookSecretRef ⇒ 必须拒绝（修复前完全不校验）", async () => {
  await withBotsService(
    [webhookBot("bot-1")], // 注意：**没有** webhookSecretRef
    async (harness) => {
      const result = await harness.handle({
        botId: "bot-1",
        userId: "u-1",
        text: "/help",
        webhookSecret: "ATTACKER-GUESS",
      });
      const replies = (result.replies ?? []).map((r) => r.text ?? "").join("\n");
      assert.match(
        replies,
        /Webhook secret 校验失败|Webhook secret verification failed/,
        "未配 secret 时必须拒绝（不许「没配就放行」），实际回复：" + (replies || "(空)"),
      );
      assert.ok(!replies.includes("/帮助"), "拒绝路径不得执行任何命令，实际回复：" + replies);
      assert.equal(result.ok, false, "凭据失败必须使 ok=false");
    },
  );
});

test("fail-closed③：常量时间比较（结构性断言）", async () => {
  // 诚实边界：真正的常量时间性**无法**在本仓库测试里被证明（时序测量不可靠）。
  // 这里只钉两件事：① 用了正确的原语；② 拒绝语义不因长度分叉。
  const source = await readFile(new URL("../src/bots/botsService.ts", import.meta.url), "utf8");
  assert.match(source, /timingSafeEqual/, "webhook 凭据比较必须用 timingSafeEqual");
  // 否定式：不得存在对 webhookSecret 的直接比较（那正是非常量时间的形态）。
  // 反向验证：改回 `expectedSecret !== inboundSecret` ⇒ 变红。
  assert.doesNotMatch(
    source,
    /expectedSecret\s*!==\s*inboundSecret/,
    "不得对 secret 做直接 !== 比较（非常量时间）",
  );
});
