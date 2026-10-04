import assert from "node:assert/strict";
import test from "node:test";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import type { IntranetProbeRequest } from "@zcode/shared";
import {
  buildIntranetProbeConsentDialogRequest,
  collectIntranetProbeTcpTargets,
  ensureIntranetProbeTcpConsent,
  selectUnconsentedIntranetProbeTcpTargets,
} from "../src/hooks/intranetProbeConsent.js";

/**
 * 内网探测 tcp 目标的探测前确认（S3）UI 侧回归。
 *
 * 服务端（packages/services/test/intranetProbeConsent.test.ts）钉住「未确认不建连」；
 * 本文件钉住客户端门控：发起探测前必须查询授权 → 弹窗显示真实 host:port → 记录授权，
 * 用户取消时不得记录、不得探测。弹窗本身复用 ConfirmDialogHost（app 级全局组件），
 * 真实桌面/浏览器交互未跑（见报告未验证项）。
 *
 * 运行：cd packages/ui && node --import tsx --test test/intranetProbeConsent.test.ts
 */

const INTRANET_PROBE_MESSAGE_IDS = [
  "intranetProbe.consent.title",
  "intranetProbe.consent.description",
  "intranetProbe.consent.confirm",
  "intranetProbe.error.consentDeclined",
  "intranetProbe.error.consentQueryFailed",
  "intranetProbe.error.consentRecordFailed",
];

function formatMessage(
  descriptor: { id: string },
  values?: Record<string, string | number>,
): string {
  const raw = zhCN[descriptor.id] ?? descriptor.id;
  if (!values) return raw;
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.split(`{${key}}`).join(String(value)),
    raw,
  );
}

function fakeDeps(
  options: {
    entries?: Array<{ host: string; port: number; consented: boolean }>;
    confirm?: boolean;
    failQuery?: boolean;
    failRecord?: boolean;
  } = {},
) {
  const calls = {
    query: 0,
    record: 0,
    recordedTargets: [] as Array<{ host: string; port?: number }>,
    dialogPayload: null as unknown,
  };
  const deps = {
    systemService: {
      async getIntranetProbeTcpTargetConsent(request: { targets: Array<{ host: string }> }) {
        calls.query += 1;
        if (options.failQuery) {
          throw new Error("query unavailable");
        }
        const entries = (options.entries ?? []).slice();
        // 按请求顺序补齐对齐条目（缺省按未确认处理）
        while (entries.length < request.targets.length) {
          entries.push({ host: "", port: 0, consented: false });
        }
        return { entries };
      },
      async recordIntranetProbeTcpTargetConsent(request: { targets: Array<{ host: string }> }) {
        calls.record += 1;
        calls.recordedTargets.push(...request.targets);
        if (options.failRecord) {
          throw new Error("record unavailable");
        }
        return {
          entries: request.targets.map((target) => ({
            host: target.host,
            port: 22,
            consented: true,
          })),
        };
      },
    },
    async requestConfirmation(payload: unknown) {
      calls.dialogPayload = payload;
      return options.confirm ?? false;
    },
    formatMessage,
  };
  return { deps, calls };
}

test("文案 id 两语言齐备（弹窗与错误提示不掉文案）", () => {
  for (const id of INTRANET_PROBE_MESSAGE_IDS) {
    assert.equal(typeof zhCN[id], "string", `zh-CN 缺少文案: ${id}`);
    assert.equal(typeof enUS[id], "string", `en-US 缺少文案: ${id}`);
  }
});

test("collectIntranetProbeTcpTargets：service target 不进确认流，tcp 与缺省 kind 进", () => {
  const request: IntranetProbeRequest = {
    targets: [
      { kind: "tcp", host: "10.0.0.5", port: 22 },
      { kind: "service", url: "https://probe.example.test/health" },
      { host: "10.0.0.6", port: 8080 },
    ],
  };
  const tcpTargets = collectIntranetProbeTcpTargets(request);
  assert.equal(tcpTargets.length, 2);
  assert.equal(tcpTargets[0]?.host, "10.0.0.5");
  assert.equal(tcpTargets[1]?.host, "10.0.0.6");
});

test("selectUnconsented：按服务端对齐条目筛出未确认目标", () => {
  const targets = [
    { host: "a.example", port: 22 },
    { host: "b.example", port: 22 },
  ];
  const unconsented = selectUnconsentedIntranetProbeTcpTargets(targets, [
    { host: "a.example", port: 22, consented: true },
    { host: "b.example", port: 22, consented: false },
  ]);
  assert.deepEqual(
    unconsented.map((t) => t.host),
    ["b.example"],
  );
});

test("弹窗请求：描述里逐行列出真实 host:port", () => {
  const payload = buildIntranetProbeConsentDialogRequest(
    [
      { host: "10.0.0.5", port: 22 },
      { host: "nas.local", port: 8080 },
    ],
    formatMessage,
  );
  assert.equal(payload.title, "确认内网探测目标");
  assert.equal(
    payload.description,
    "即将对以下目标发起内网探测（TCP 连接），请确认：\n10.0.0.5:22\nnas.local:8080",
  );
  assert.equal(payload.confirmLabel, "确认探测");
});

test("ensure：无 tcp target ⇒ 直接放行且不查询服务端", async () => {
  const { deps, calls } = fakeDeps();
  const outcome = await ensureIntranetProbeTcpConsent(
    { targets: [{ kind: "service", url: "https://probe.example.test/health" }] },
    deps,
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls.query, 0);
});

test("ensure：全部已确认 ⇒ 放行且不弹窗、不记录", async () => {
  const { deps, calls } = fakeDeps({
    entries: [{ host: "10.0.0.5", port: 22, consented: true }],
  });
  const outcome = await ensureIntranetProbeTcpConsent(
    { targets: [{ kind: "tcp", host: "10.0.0.5", port: 22 }] },
    deps,
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls.query, 1);
  assert.equal(calls.record, 0);
});

test("ensure：未确认 ⇒ 弹窗显示真实 host:port，确认后记录到服务端", async () => {
  const { deps, calls } = fakeDeps({ confirm: true });
  const outcome = await ensureIntranetProbeTcpConsent(
    { targets: [{ kind: "tcp", host: "10.0.0.5", port: 22 }] },
    deps,
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls.query, 1);
  assert.equal(calls.record, 1);
  assert.deepEqual(calls.recordedTargets, [{ kind: "tcp", host: "10.0.0.5", port: 22 }]);
  const payload = calls.dialogPayload as { description?: string };
  assert.match(payload.description ?? "", /10\.0\.0\.5:22/);
});

test("ensure：用户取消 ⇒ 不记录、不探测（不 ok，带明确错误）", async () => {
  const { deps, calls } = fakeDeps({ confirm: false });
  const outcome = await ensureIntranetProbeTcpConsent(
    { targets: [{ kind: "tcp", host: "10.0.0.5", port: 22 }] },
    deps,
  );
  assert.equal(outcome.ok, false);
  assert.match((outcome as { error: Error }).error.message, /内网探测已取消/);
  assert.equal(calls.record, 0);
});

test("ensure：查询失败 ⇒ 不弹窗、不记录，错误透出", async () => {
  const { deps, calls } = fakeDeps({ failQuery: true });
  const outcome = await ensureIntranetProbeTcpConsent(
    { targets: [{ kind: "tcp", host: "10.0.0.5", port: 22 }] },
    deps,
  );
  assert.equal(outcome.ok, false);
  assert.match((outcome as { error: Error }).error.message, /查询内网探测授权状态失败/);
  assert.equal(calls.record, 0);
});

test("ensure：记录失败 ⇒ 透出错误（探测不得由带病授权放行）", async () => {
  const { deps } = fakeDeps({ confirm: true, failRecord: true });
  const outcome = await ensureIntranetProbeTcpConsent(
    { targets: [{ kind: "tcp", host: "10.0.0.5", port: 22 }] },
    deps,
  );
  assert.equal(outcome.ok, false);
  assert.match((outcome as { error: Error }).error.message, /记录内网探测授权失败/);
});
