import assert from "node:assert/strict";
import test from "node:test";
import type { EnvInfo } from "@zcode/contracts";
import { buildEnvInfoSection } from "@zcode/core";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import {
  ADDITIONAL_DIRECTORIES_MAX,
  normalizeAdditionalDirectories,
} from "../src/app/additional-directories.js";
import { ColdSessionResumeCoordinator } from "../src/zcode-protocol-v4/cold-session-resume.js";
import { NATIVE_HANDLERS } from "../src/zcode-protocol-v4/commands/handlers/index.js";
import type { V4CommandCoreHost } from "../src/zcode-protocol-v4/commands/types.js";

/**
 * 上游 3.16.2 X16 / Y19：附加目录在 CLI 运行时的三条消费链。
 *
 * 这里钉三件事，都是"接线对了才成立、否则静默失效"的：
 * 1. 归一：Host 下发的可能是相对路径/重复项/超限（wire 只保证非空字符串数组），
 *    环境 prompt 必须看到可直接使用的绝对路径，且不能把 256 上限只留在协议层。
 * 2. 环境 prompt：模型能不能"看到"附加目录——X16 的原始缺陷就是这条缺失。
 * 3. 冷恢复：重启后重新 materialize runtime 时，附加目录必须原样传给宿主钩子（Y19），
 *    同时保留旧宿主的 2/3 参调用形态（不能因为多一个可选参就改变旧行为）。
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && node --import tsx --test test/additionalDirectories.test.ts
 * 注意：本地直接跑要装源码解析钩子（CI 上由 pnpm test 统一装）：
 *   node --import tsx --import ../../../../packages/services/test/support/zcodeSourceResolver.mjs --test <file>
 */

const ENV_INFO: EnvInfo = {
  cwd: "/work/app",
  nodeVersion: process.version,
  osVersion: "linux 6.0",
  platform: "linux",
  shell: "/bin/bash",
};

test("归一：相对路径按 workingDirectory 绝对化、去重、过滤空项", () => {
  assert.deepEqual(
    normalizeAdditionalDirectories(
      ["../backend", "/work/shared", "../backend", "  ", " /work/shared "],
      "/work/app",
    ),
    ["/work/backend", "/work/shared"],
  );
  assert.deepEqual(normalizeAdditionalDirectories(undefined, "/work/app"), []);
  assert.deepEqual(normalizeAdditionalDirectories([], "/work/app"), []);
});

test("归一：超过上限的输入被截断到同一个不变量（协议外的程序内调用也安全）", () => {
  const many = Array.from(
    { length: ADDITIONAL_DIRECTORIES_MAX + 5 },
    (_, index) => `/dir/${index}`,
  );
  const normalized = normalizeAdditionalDirectories(many, "/work/app");
  assert.equal(normalized.length, ADDITIONAL_DIRECTORIES_MAX);
  assert.equal(normalized.at(-1), `/dir/${ADDITIONAL_DIRECTORIES_MAX - 1}`);
});

test("环境 prompt：有附加目录时逐行列出，缺席时完全不出现该段（回归）", () => {
  const withDirs = buildEnvInfoSection(ENV_INFO, undefined, ["/work/backend", "/work/shared"]);
  assert.match(withDirs.content, /^- Additional directories:$/mu);
  assert.match(withDirs.content, /^ {2}- \/work\/backend$/mu);
  assert.match(withDirs.content, /^ {2}- \/work\/shared$/mu);
  // 主工作目录仍是唯一 cwd 行：附加目录不得冒充工作区。
  assert.match(withDirs.content, /^- Primary working directory: \/work\/app$/mu);
  assert.equal(withDirs.content.match(/Primary working directory/gu)?.length, 1);

  const withoutDirs = buildEnvInfoSection(ENV_INFO);
  assert.doesNotMatch(withoutDirs.content, /Additional directories/u);
});

test("v4 createSession：附加目录随 record 创建进入宿主（不是只进协议）", async () => {
  const seen: Array<Record<string, unknown>> = [];
  // 只实现本 handler 真正会调用的钩子；其余能力由 as 断言收窄（handler 不读取它们）。
  const host = {
    createSessionRecord: async (params: Record<string, unknown>) => {
      seen.push(params);
      return { sessionId: "s-new" };
    },
  } as unknown as V4CommandCoreHost;
  const envelope = (additionalDirectories?: string[]): CommandEnvelope => ({
    clientId: "c1",
    commandId: "cmd-1",
    issuedAt: Date.now(),
    payload: { ...(additionalDirectories ? { additionalDirectories } : {}), workspaceId: "/w" },
    sessionId: null,
    type: "createSession",
  });

  await NATIVE_HANDLERS.createSession(host, envelope(["/work/backend"]));
  await NATIVE_HANDLERS.createSession(host, envelope());

  assert.deepEqual(seen[0]?.additionalDirectories, ["/work/backend"]);
  // 缺席保持 undefined：由 record 创建处回落 runtime preferences，而不是在这里伪造 []。
  assert.equal(seen[1]?.additionalDirectories, undefined);
});

test("冷恢复：附加目录原样传给宿主钩子（4 参），旧宿主形态保持 2/3 参调用", async () => {
  const workspace: ZCodeWorkspaceRef = { workspaceKey: "/work/app", workspacePath: "/work/app" };
  const calls: unknown[][] = [];
  const host = {
    resumePersistedSession: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "resumed" as const };
    },
  };
  const coordinator = new ColdSessionResumeCoordinator(host);

  await coordinator.ensureResumed("s1", "high", workspace, ["/work/backend"]);
  await coordinator.ensureResumed("s2", undefined, undefined, undefined);
  await coordinator.ensureResumed("s3", "high", workspace, undefined);

  assert.deepEqual(calls[0], ["s1", "high", workspace, ["/work/backend"]]);
  // 无 workspace 且无附加目录：仍是旧的两参调用，不给旧宿主多塞位置参数。
  assert.deepEqual(calls[1], ["s2", undefined]);
  // 只有 workspace（旧三参形态）：附加目录缺席时该位是 undefined——位置参数按序传递，
  // 与旧宿主的三参调用等价（可选参数缺席即 undefined）。
  assert.deepEqual(calls[2], ["s3", "high", workspace, undefined]);
});
