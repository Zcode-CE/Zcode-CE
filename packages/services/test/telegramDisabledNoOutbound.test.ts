import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotConfig, BotsConfigFile } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { createTelegramChannelRuntime } from "../src/bots/telegramChannelRuntime.js";
import type { BotRuntimeInfo } from "@zcode/shared";

/**
 * R1：已禁用的 Telegram bot 不得出网（task-95）。
 *
 * 上游缺陷：telegramChannelRuntime 的 reconcile 在 `bot.provider === "telegram" && !bot.enabled`
 * 分支里无条件调 syncCommands → telegramProvider.syncCommands → POST
 * https://api.telegram.org/bot<token>/deleteMyCommands。而同一文件 :76-78 的注释写的是
 * 「删除或禁用 bot 时也不能为了清命令访问第三方 API」—— 那个 return 只在
 * runBackgroundTasks === false 时生效，本地 host 上禁用的 bot 每次 reconcile 都出网一次。
 *
 * 这里用真实运行时与真实 reconcile 路径验证，断言打在「出网次数」上：
 * 通过注入的 provider 适配器计数（它是 syncCommands 的唯一出口，也就是最终消费点）。
 *
 * 运行：cd packages/services && node --import tsx --test test/telegramDisabledNoOutbound.test.ts
 */

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: "bot-1",
    provider: "telegram",
    enabled: false,
    credentialRef: "bot-token-1",
    allowedWorkspaces: [],
    ...overrides,
  } as BotConfig;
}

interface Harness {
  outboundCalls: number;
  statuses: BotRuntimeInfo[];
  refresh(config: BotsConfigFile): Promise<void>;
  dispose(): Promise<void>;
}

async function withRuntime(
  config: BotsConfigFile,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-r1-"));
  setDataBaseDir(home);
  let outboundCalls = 0;
  const statuses: BotRuntimeInfo[] = [];
  const runtime = createTelegramChannelRuntime({
    // runBackgroundTasks 不设 false：这正是本地 host 的形态（缺陷只在本地 host 上出现）。
    credentialService: {
      load: async () => "123456:fake-token",
      save: async () => undefined,
      delete: async () => undefined,
    },
    telegramProvider: {
      test: async () => ({ ok: true, message: "" }),
      // syncCommands 是 deleteMyCommands 的唯一出口 —— 计这里就是计真实出网。
      syncCommands: async () => {
        outboundCalls += 1;
      },
      send: async () => undefined,
      parseCallback: () => [],
    },
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    statusSink: {
      getRuntimeStatus: () => undefined,
      setRuntimeStatus: (status) => {
        statuses.push(status);
      },
    },
    ensureBotStorageMigrated: async () => undefined,
    readConfig: async () => config,
    readTelegramOffset: async () => undefined,
    writeTelegramOffset: async () => undefined,
    processProviderCallback: async () => ({ ok: true, replies: [] }),
  });
  try {
    await run({
      get outboundCalls() {
        return outboundCalls;
      },
      statuses,
      refresh: (next) => runtime.refresh(next),
      dispose: async () => {
        runtime.dispose();
      },
    });
  } finally {
    setDataBaseDir(null);
    await rm(home, { recursive: true, force: true });
  }
}

test("R1：一直是禁用态的 telegram bot —— 多次 reconcile 后零出网", async () => {
  const config: BotsConfigFile = { version: 3, bots: [makeBot({ enabled: false })] };
  await withRuntime(config, async (harness) => {
    await harness.refresh(config);
    await harness.refresh(config);
    await harness.refresh(config);
    assert.equal(
      harness.outboundCalls,
      0,
      "禁用的 bot 不应向 api.telegram.org 发 deleteMyCommands（上游每次 reconcile 都发）",
    );
    // 状态仍要如实置为 disabled —— 修复不能把可观测性一起删掉。
    assert.ok(
      harness.statuses.some((status) => status.status === "disabled"),
      "禁用态仍应写入 runtime status",
    );
    await harness.dispose();
  });
});

test("R1：无 bot 配置时零出网（默认关闭的可用性前提）", async () => {
  const config: BotsConfigFile = { version: 3, bots: [] };
  await withRuntime(config, async (harness) => {
    await harness.refresh(config);
    await harness.refresh(config);
    assert.equal(harness.outboundCalls, 0);
    await harness.dispose();
  });
});

test("R1：启用态的 bot 仍会 syncCommands（修复没有误伤正常路径）", async () => {
  const config: BotsConfigFile = { version: 3, bots: [makeBot({ enabled: true })] };
  await withRuntime(config, async (harness) => {
    await harness.refresh(config);
    assert.equal(
      harness.outboundCalls,
      1,
      "启用态的 bot 必须照旧同步命令菜单（用户可感知的正确行为）",
    );
    await harness.dispose();
  });
});

test("R1：启用 → 禁用 的切换仍清一次命令菜单（保留用户可感知行为）", async () => {
  const enabled: BotsConfigFile = { version: 3, bots: [makeBot({ enabled: true })] };
  const disabled: BotsConfigFile = { version: 3, bots: [makeBot({ enabled: false })] };
  await withRuntime(enabled, async (harness) => {
    await harness.refresh(enabled);
    const afterEnable = harness.outboundCalls;
    assert.equal(afterEnable, 1);
    await harness.refresh(disabled);
    assert.equal(
      harness.outboundCalls,
      2,
      "从启用变为禁用时应清一次命令菜单（否则 Telegram 客户端残留旧菜单）",
    );
    // 之后继续禁用态刷新不得再出网。
    await harness.refresh(disabled);
    await harness.refresh(disabled);
    assert.equal(harness.outboundCalls, 2, "已清过之后不得再出网");
    await harness.dispose();
  });
});
