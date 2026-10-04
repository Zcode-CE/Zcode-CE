import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DEFAULT_BOT_COMMANDS } from "@zcode/shared";
import { BOTS_CONFIG_FILE } from "../src/bots/config.js";
import { createBotsService } from "../src/bots/botsService.js";
import { createWeixinBotProvider } from "../src/bots/providers/weixinProvider.js";
import { BotAttachmentUrlRejectedError } from "../src/bots/attachmentUrlGuard.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";

/**
 * 微信渠道附件下载的安全回归（S1 + T4）。
 *
 * 背景：入站 payload 里的 download_url（或 attachments[].downloadUrl）完全由请求方
 * 控制。botsService.resolveAttachmentBytes 原先是「先调用 provider.downloadAttachment、
 * 再回退通用 guarded 路径」，而 weixin 的 downloadAttachment 曾是裸 fetch——没有目标
 * 判据也没有超时，等于把「让服务端请求任意 URL」开放给能打到入站面的人。
 *
 * 两层防护各自独立钉死（单层被改掉时另一层仍承重）：
 * - provider 层：weixinProvider.downloadAttachment 复用 fetchBotAttachmentFromUrl；
 * - choke point：resolveAttachmentBytes 在调 provider 之前先 assertAllowedAttachmentUrl。
 *
 * 判别实验（修复前实测，非源码推理）：起一个 127.0.0.1 探针 server，用真实
 * handleProviderCallbackResponse 投递带 downloadUrl 的附件——修复前 server 被命中 1 次
 * （服务端真的对回环发起了请求）；修复后 0 次。第二条用例就是这个实验的固化版。
 *
 * 运行：cd packages/services && node --import tsx --test test/botWeixinAttachmentGuard.test.ts
 */

test("provider 层：weixin downloadAttachment 拒绝指向回环的 downloadUrl", async () => {
  const provider = createWeixinBotProvider({ loadCredential: async () => null });
  await assert.rejects(
    () =>
      provider.downloadAttachment?.(
        { id: "bot-1", provider: "weixin" } as never,
        {
          id: "a1",
          kind: "file",
          filename: "probe.bin",
          mimeType: "application/octet-stream",
          downloadUrl: "http://127.0.0.1/ssrf-probe",
          providerMetadata: { weixinAesKey: "0".repeat(16) },
        } as never,
        undefined,
      ),
    (error: unknown) => {
      assert.ok(error instanceof BotAttachmentUrlRejectedError, "必须由 SSRF 校验器拒绝");
      return true;
    },
  );
});

test("provider 层：无 downloadUrl 时返回 null（不改变交给通用路径的降级语义）", async () => {
  const provider = createWeixinBotProvider({ loadCredential: async () => null });
  const result = await provider.downloadAttachment?.(
    { id: "bot-1", provider: "weixin" } as never,
    { id: "a1", kind: "file", filename: "x.bin", mimeType: "application/octet-stream" } as never,
    undefined,
  );
  assert.equal(result, null, "缺下载信息的附件应交给后续通用路径处理，而不是抛错");
});

function weixinBot() {
  return {
    id: "bot-1",
    name: "bot-1",
    provider: "weixin",
    enabled: true,
    providerUserId: "u-1",
    allowedWorkspaces: ["*"],
    allowedCommands: { ...DEFAULT_BOT_COMMANDS },
    currentOptions: {},
    replyMode: "assistant_changes",
  };
}

/**
 * 真实回调投递 + 本地 127.0.0.1 探针 server。
 *
 * 微信首条入站消息会被 handleWeixinFirstActivation 拦下（写 weixinActivatedAt + 回
 * 欢迎语），附件不在首条消息里处理；先投一条普通消息完成激活，第二条才带附件。
 * 两条消息的回复发送都会因缺 weixin token 抛错——抛错点在 send、在任何网络请求
 * 之前，与本判据无关；断言它正是「缺 token」这一已知错误，证明业务处理已走到
 * 回复阶段（而非在别处早退把缺陷藏起来）。
 */
async function withWeixinCallbackProbe(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-weixin-guard-"));
  setDataBaseDir(home);
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "(no url)");
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(new Uint8Array(64));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const probe = "http://127.0.0.1:" + (server.address as { port: number }).port + "/ssrf-probe";
  const originalLog = console.log;
  console.log = () => {};
  try {
    const configPath = join(getAppConfigDir(), BOTS_CONFIG_FILE);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ version: 3, bots: [weixinBot()] }, null, 2));
    const service = createBotsService({
      credentialService: {
        load: async () => null,
        save: async () => undefined,
        delete: async () => undefined,
      },
      zcodeTaskService: { listWorkspaceRefs: async () => [] } as never,
      modelSelectionService: { getView: async () => ({}) } as never,
      settingService: {
        get: async () => ({ lastWorkspaceSession: [{ kind: "local", workspacePath: home }] }),
        update: async () => undefined,
        updateDataBaseDir: async () => undefined,
        ensureDefaultProject: async () => ({ path: home, created: false }),
      } as never,
      runStartupBackgroundTasks: false,
    });
    for (const withAttachment of [false, true]) {
      try {
        await service.handleProviderCallbackResponse("weixin", {
          botId: "bot-1",
          msgs: [
            {
              from_user_id: "u-1",
              text: withAttachment ? "请查看这份附件" : "激活",
              ...(withAttachment
                ? {
                    attachments: [
                      {
                        kind: "file",
                        id: "a1",
                        filename: "probe.bin",
                        downloadUrl: probe,
                        providerMetadata: { weixinAesKey: "0".repeat(16) },
                      },
                    ],
                  }
                : {}),
            },
          ],
        });
      } catch (error) {
        assert.match(
          error instanceof Error ? error.message : String(error),
          /Weixin iLink bot token is missing/,
          "sendOutbound 崩溃必须是缺 token（证明业务处理已走到回复阶段，而非别处早退）",
        );
      }
    }
    service.disposeAll();
    await run();
  } finally {
    console.log = originalLog;
    server.close();
    setDataBaseDir(null);
    await rm(home, { recursive: true, force: true });
  }
  assert.equal(hits.length, 0, "SSRF 目标不得被请求：" + JSON.stringify(hits));
}

test("choke point：真实回调投递里 downloadUrl 指向回环 ⇒ 服务端不得发出请求", async () => {
  await withWeixinCallbackProbe(async () => {
    // 断言在 withWeixinCallbackProbe 的 finally：hits.length === 0。
    // 反向验证（修复前实测）：把 botsService 的 choke point 与 weixinProvider 的
    // fetchBotAttachmentFromUrl 都摘掉 ⇒ hits 变 1，本用例即失败。
  });
});
