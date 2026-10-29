import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";

/**
 * X16 冷恢复：订阅参数必须带上该工作区的附加目录。
 *
 * 回归形态是静默的 —— 设置里配了目录、重启后打开历史会话，模型可见范围又缩回主工作区；
 * 只测纯函数（payload 形状）覆盖不到这里，因为问题在「services 有没有把 provider 的结论
 * 放进 subscribe 参数」。所以让 host 真 spawn 一个假 agent，断言它收到的
 * v4/conversation/subscribe params。
 *
 * 假 agent 的能力边界：只应答 v4 订阅（回最小合法 ACK）并记录参数，不模拟真实会话帧；
 * 因此本测试证明「host 侧接线正确」，不证明真实 CLI 的恢复内容。
 */

const FAKE_AGENT = fileURLToPath(
  new URL("./support/fakeProviderRuntimeHeadersAgent.mjs", import.meta.url),
);

type Record_ =
  | { kind: "v4-subscribe"; params: { additionalDirectories?: string[] } }
  | { kind: string };

async function readRecords(outPath: string): Promise<Record_[]> {
  const raw = await readFile(outPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record_);
}

async function withService(
  t: TestContext,
  resolveWorkspaceAdditionalDirectories: (
    workspaceKey: string,
  ) => Promise<readonly string[] | undefined>,
  run: (harness: {
    service: ReturnType<typeof createZCodeAgentService>;
    workspacePath: string;
    outPath: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-cold-resume-dirs-"));
  const workspacePath = join(dir, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const outPath = join(dir, "agent-records.jsonl");
  const service = createZCodeAgentService({
    commandResolver: () => ({
      command: process.execPath,
      args: [FAKE_AGENT],
      cwd: workspacePath,
      env: {
        FAKE_AGENT_OUT: outPath,
        FAKE_AGENT_WORKSPACE: workspacePath,
        FAKE_AGENT_SESSION_ID: "session-cold-resume",
      },
    }),
    modelSelectionReadinessSource: {
      getView: async () => ({
        revision: 1,
        providers: [
          {
            providerId: "zai-start-plan",
            providerName: "Z.ai Start Plan",
            templateId: "zai-start-plan",
            config: {},
            models: [{ modelId: "glm-5", config: {} }],
          },
        ],
      }),
    },
    accountRequestAuthService: {
      resolveAccessCurrent: async () => null,
      assertCurrent: async () => undefined,
      resolveCurrent: async () => ({ apiKey: "acct-jwt" }),
    },
    resolveWorkspaceAdditionalDirectories,
  });
  t.after(async () => {
    await service.disposeAllAndWait().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await run({ service, workspacePath, outPath });
}

test("订阅参数带上该工作区的附加目录", async (t) => {
  await withService(
    t,
    async (workspaceKey) =>
      workspaceKey.endsWith("/workspace") ? ["/work/extra", "/work/lib"] : undefined,
    async ({ service, workspacePath, outPath }) => {
      await service.subscribeConversationV4({
        workspacePath,
        sessionId: "session-cold-resume",
      });
      const records = await readRecords(outPath);
      const subscribe = records.find((entry) => entry.kind === "v4-subscribe") as
        | { params: { additionalDirectories?: string[] } }
        | undefined;
      assert.ok(subscribe, "假 agent 没有收到 v4/conversation/subscribe");
      assert.deepEqual(subscribe.params.additionalDirectories, ["/work/extra", "/work/lib"]);
    },
  );
});

test("provider 抛错时仍能恢复，且不写 additionalDirectories", async (t) => {
  await withService(
    t,
    async () => {
      throw new Error("settings unreadable");
    },
    async ({ service, workspacePath, outPath }) => {
      await service.subscribeConversationV4({
        workspacePath,
        sessionId: "session-cold-resume",
      });
      const records = await readRecords(outPath);
      const subscribe = records.find((entry) => entry.kind === "v4-subscribe") as
        | { params: { additionalDirectories?: string[] } }
        | undefined;
      assert.ok(subscribe, "恢复到订阅这一步失败");
      assert.equal(subscribe.params.additionalDirectories, undefined);
    },
  );
});
