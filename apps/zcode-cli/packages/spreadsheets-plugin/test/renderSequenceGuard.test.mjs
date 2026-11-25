#!/usr/bin/env node
// 渲染链序列判定的自测（keyless，常跑）：用伪造的 calls.jsonl 序列钉住
// 「首次空白后多一次渲染 → 容忍且留诊断 / 连续两次 → 判失败且带完整序列」。
//
// 为什么用伪造序列：真实回路的抖动本就不可复现（2026-11-25 实测一次红、重跑绿），
// 只有合成序列能把两种判决钉进 CI。被钉住的核心性质是「容忍不等于静默」——
// 一次抖动不得判成 clean，否则容忍逻辑被改成静默全绿时没有任何信号。
//
// 文件独立于 officeE2eBlankRender.test.mjs 的原因：那条用例要 with-key 才跑，而本自测
// 不依赖模型与密钥，必须由 pnpm test 的 keyless 流常跑（登记见 scripts/run-tests.mjs
// 的 TEST_PACKAGES；测试文件后缀列表见该脚本的 TEST_FILE_SUFFIXES）。

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeRenderRetryViolation,
  describeToleratedRetry,
  evaluateRenderSequence,
  RENDER_RETRY_TOLERANCE,
} from "./lib/render-sequence.mjs";

// 夹具 calls.jsonl 的真实字段形态：tool / argv / status，探测调用另有 probe:true。
const PROBE_SOFFICE = { tool: "soffice", argv: ["--version"], status: 0, probe: true };
const PROBE_PDFTOPPM = { tool: "pdftoppm", argv: ["-v"], status: 0, probe: true };
const SOFFICE_RENDER = {
  tool: "soffice",
  argv: ["--headless", "--convert-to", "pdf", "--outdir", "out", "result.xlsx"],
  status: 0,
};
const PDFTOPPM_RENDER = {
  tool: "pdftoppm",
  argv: ["-png", "-r", "150", "out/result.pdf", "out/page"],
  status: 0,
  pages: 1,
};

test("render-sequence guard: 首次空白后多一次渲染容忍、连续两次判失败", () => {
  // 模型一次都没渲染（走「如实声明视觉检查不可用」分支）：干净。
  const noRender = evaluateRenderSequence([PROBE_SOFFICE, PROBE_PDFTOPPM]);
  assert.equal(noRender.verdict, "clean");
  assert.equal(noRender.firstBlankIndex, -1);

  // 首次空白后立即停止：干净，且首张空白定位在第一次非探测 pdftoppm 上。
  const clean = evaluateRenderSequence([PROBE_SOFFICE, SOFFICE_RENDER, PDFTOPPM_RENDER, PROBE_PDFTOPPM]);
  assert.equal(clean.verdict, "clean");
  assert.deepEqual(clean.retryIndexes, []);
  assert.equal(clean.firstBlankIndex, 2);
  assert.equal(clean.renderCount, 1);

  // 实测抖动形态（一次「期望空 / 实际一次 soffice」）：容忍，但不得判成 clean。
  const jitter = evaluateRenderSequence([PROBE_SOFFICE, SOFFICE_RENDER, PDFTOPPM_RENDER, SOFFICE_RENDER]);
  assert.equal(jitter.verdict, "tolerated");
  assert.notEqual(jitter.verdict, "clean", "抖动必须留痕，不能被当成干净序列");
  assert.equal(jitter.retryIndexes.length, RENDER_RETRY_TOLERANCE);
  const toleratedMessage = describeToleratedRetry(jitter);
  assert.match(toleratedMessage, /容忍上限 1/);
  assert.ok(toleratedMessage.includes("#3 soffice render"), toleratedMessage);
  assert.ok(toleratedMessage.includes("argv: --headless --convert-to pdf"), toleratedMessage);

  // 连续两次以上：判失败，且失败信息带完整调用序列（每条调用都能在日志里对上）。
  const violation = evaluateRenderSequence([
    PROBE_SOFFICE,
    SOFFICE_RENDER,
    PDFTOPPM_RENDER,
    SOFFICE_RENDER,
    PDFTOPPM_RENDER,
  ]);
  assert.equal(violation.verdict, "violation");
  assert.deepEqual(violation.retryIndexes, [3, 4]);
  const violationMessage = describeRenderRetryViolation(violation);
  assert.match(violationMessage, /又出现 2 次渲染调用/);
  for (const index of [0, 1, 2, 3, 4]) {
    assert.ok(
      violationMessage.includes(`#${index} `),
      `失败信息缺第 ${index} 条调用：\n${violationMessage}`,
    );
  }

  // 探测调用不参与计数，也不参与首张空白定位（首个渲染之前的转换同样不计入）。
  const probesOnly = evaluateRenderSequence([PROBE_SOFFICE, SOFFICE_RENDER, PROBE_PDFTOPPM]);
  assert.equal(probesOnly.verdict, "clean");
  assert.equal(probesOnly.renderCount, 0);
  assert.equal(probesOnly.firstBlankIndex, -1);
});
