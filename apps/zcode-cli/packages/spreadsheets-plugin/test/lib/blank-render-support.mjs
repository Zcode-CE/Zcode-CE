// LLM-in-the-loop e2e 的支持模块（office-xlsx 空白渲染场景）。
//
// 为什么单独成模块：officeE2eBlankRender.test.mjs 同时含「keyless 常跑的夹具自检」与
//「with-key 才跑的真实回路」两类测试；夹具构造、provider 配置、stream-json 解析与
// 断言辅助是纯函数，抽出来后两种测试都能复用，也满足单文件不超过 400 行的约束。
// 模式与来源记录见 docs/development/137-dsh-e2e-pattern.md。

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const repoRoot = resolve(packageRoot, "..", "..", "..", "..");
export const agentEntryPath = resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
export const builtinProviderConfigPath = resolve(repoRoot, "config/provider/zcode-builtin.json");

/**
 * 构造 e2e 专用 personal provider 配置文件内容（schemaVersion 1）。
 *
 * 为什么不沿用宿主机的 ~/.zcode：e2e 必须在受控 provider 上跑（模型、base URL、
 * 输入模态都由测试指定），且不能污染开发机账号配置。schema 来自
 * packages/provider/src/config/{rule-data,provider-data}-schema.ts 与
 * packages/provider-node/src/provider-config-file-codec.ts。
 */
export function buildProviderConfigContent(input) {
  const config = {
    schemaVersion: 1,
    config: {
      providerOrder: [input.providerId],
      providerConfigRules: {
        providerRules: [
          {
            providerId: input.providerId,
            providerName: input.providerName,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: input.apiKey },
              api: { type: input.apiType, baseUrl: input.baseUrl },
              personalModelIds: [input.modelId],
              modelOrder: [input.modelId],
            },
          },
        ],
      },
      modelConfigRules: {
        // personalModelConfigRulesSchema 要求两个数组键都存在（缺 manualProviderModelRules
        // 会让整个 Personal 文件被判无效，默认选择随之丢失——实测过的失败链）。
        providerModelRules: [
          {
            providerId: input.providerId,
            modelId: input.modelId,
            config: {
              enabled: true,
              properties: {
                requiresMfjsToolSchema: false,
                contextWindow: input.contextWindow,
                inputFormat: {
                  supportsText: true,
                  supportsImage: input.supportsImage,
                  supportsVideo: false,
                  supportsAudio: false,
                  supportsPdf: input.supportsImage,
                },
                outputFormat: { supportsText: true },
                supportsToolCall: true,
                supportsJsonSchemaOutput: false,
                supportsNativeWebSearch: false,
                supportsMidConversationSystem: true,
              },
            },
          },
        ],
        manualProviderModelRules: [],
      },
      defaultModelSelection: { providerId: input.providerId, modelId: input.modelId },
    },
  };
  return JSON.stringify(config, null, 2);
}

/** --output-format stream-json：每条会话事件一行 NDJSON（失败行容错跳过）。 */
export function parseStreamJsonLines(text) {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    })
    .filter((value) => value !== null);
}

/** 已解析的工具调用（取 scheduled 事件：它携带 toolName 与完整 input）。 */
export function collectScheduledToolCalls(events) {
  return events
    .filter((event) => event.type === "tool.updated" && event.payload?.kind === "scheduled")
    .map((event) => ({ toolName: event.payload.toolName, input: event.payload.input }));
}

export function collectBashCommands(toolCalls) {
  return toolCalls
    .filter((call) => call.toolName === "Bash")
    .map((call) => call.input?.command)
    .filter((command) => typeof command === "string");
}

/**
 * 最终回答。
 *
 * 两个来源，按可靠性排序：
 *  1. message.upserted 的最后一条非空助手消息（system message 带 type 字段，排除）；
 *  2. headless 回合的实际权威来源：turn.completed.payload.response——
 *     prompt-command 的 observer（headless-workflow.ts）与 TUI 的
 *     applyTurnCompleteFallbackResponse 都把它当作回合回答文本。实测（CI 首次真跑 +
 *     本地假 key 回合）：headless stream-json 里可以一条 message.upserted 都没有
 *     （连用户消息也不发），只靠 message.upserted 过滤会把正常完成的回合判成「没有回答」。
 */
export function collectFinalAnswerText(events) {
  const messages = events.filter(
    (event) =>
      event.type === "message.upserted" &&
      typeof event.payload?.content === "string" &&
      event.payload.content.trim().length > 0 &&
      event.payload.type === undefined,
  );
  const lastMessage = messages[messages.length - 1];
  if (lastMessage) return lastMessage.payload.content;
  const completed = events.filter(
    (event) =>
      event.type === "turn.completed" && typeof event.payload?.response === "string",
  );
  for (let index = completed.length - 1; index >= 0; index -= 1) {
    const response = completed[index].payload.response;
    if (response.trim().length > 0) return response;
  }
  return undefined;
}

/**
 * 失败诊断：事件类型计数 + 最后若干条事件的载荷摘要。断言失败时挂进消息里，
 * 让 CI 日志能直接看见回合里发生了什么（否则 stream-json 的内容完全不可观测）。
 */
export function summarizeEventsForFailure(events, tailLimit = 25) {
  const counts = new Map();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  const tail = events
    .slice(-tailLimit)
    .map((event) => {
      const payload = event.payload;
      const details = [];
      if (event.type === "tool.updated") {
        details.push(`tool=${payload?.toolName ?? "?"} kind=${payload?.kind ?? "?"}`);
      } else if (event.type === "message.upserted") {
        details.push(`content=${String(payload?.content ?? "").slice(0, 80)}`);
      } else if (event.type === "turn.completed") {
        details.push(`response=${String(payload?.response ?? "").slice(0, 120)}`);
      } else if (event.type === "turn.failed") {
        details.push(`error=${String(payload?.error?.message ?? payload?.error ?? "").slice(0, 160)}`);
      }
      return `  ${event.type}${details.length ? " " + details.join(" ") : ""}`;
    })
    .join("\n");
  return `event counts: ${JSON.stringify(Object.fromEntries(counts))}
last ${Math.min(tailLimit, events.length)} events:
${tail}`;
}

/**
 * PNG 是否全透明（RGBA 全零）。只解析本套夹具生成的 filter 0 + RGBA8 形态——
 * 这是夹具自检，不是通用 PNG 解码器。
 */
export function isTransparentPng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || buffer.subarray(0, 8).equals(signature) === false) return false;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (buffer[24] !== 8 || buffer[25] !== 6) return false;
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("latin1");
    if (type === "IDAT") chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  if (chunks.length === 0) return false;
  const raw = inflateSync(Buffer.concat(chunks));
  return raw.length === height * (1 + width * 4) && raw.every((byte) => byte === 0);
}

export async function readFixtureCalls(binDir) {
  const text = await readFile(join(binDir, "calls.jsonl"), "utf8");
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    })
    .filter((value) => value !== null);
}

/** 渲染链调用：非探测（非 -v / 非 --version）的 soffice/pdftoppm 调用。 */
export function isRenderCall(entry) {
  return (entry.tool === "soffice" || entry.tool === "pdftoppm") && entry.probe !== true;
}

/**
 * 准备空白渲染场景的工作区：input.xlsx（DSH 同款夹具：A/B 列宽 5 = 拥挤）、
 * bin/soffice + bin/pdftoppm（PATH 注入的假渲染器）、provider-config.json。
 */
export async function prepareBlankRenderWorkspace(input) {
  const tempDir = input.tempDir ?? (await mkdtemp(join(tmpdir(), "zcode-e2e-blank-")));
  const binDir = join(tempDir, "bin");
  await mkdir(binDir, { recursive: true });
  const fixtures = [
    ["soffice-fake.cjs", "soffice"],
    ["pdftoppm-fake.cjs", "pdftoppm"],
  ];
  for (const [source, target] of fixtures) {
    const sourcePath = join(packageRoot, "test", "fixtures", source);
    const targetPath = join(binDir, target);
    await copyFile(sourcePath, targetPath);
    chmodSync(targetPath, 0o755);
  }
  // exceljs 4.4.0 是 CJS 包：ESM 命名空间里 Workbook 在 default 上（cjs-module-lexer
  // 不为它合成具名导出）。
  const exceljs = (await import("exceljs")).default;
  const workbook = new exceljs.Workbook();
  const sheet = workbook.addWorksheet("Revenue");
  sheet.getColumn("A").width = 5;
  sheet.getColumn("B").width = 5;
  sheet.getCell("A1").value = "Quarterly revenue";
  sheet.getCell("B1").value = "Amount";
  sheet.getCell("A2").value = "Q1";
  sheet.getCell("B2").value = 12;
  sheet.getCell("A3").value = "Q2";
  sheet.getCell("B3").value = 18;
  const notes = workbook.addWorksheet("Notes");
  notes.getCell("A1").value = "Preserve this note";
  const inputPath = join(tempDir, "input.xlsx");
  await workbook.xlsx.writeFile(inputPath);
  const providerConfigPath = join(tempDir, "provider-config.json");
  await writeFile(providerConfigPath, input.providerConfigContent, "utf8");
  return { tempDir, binDir, inputPath, providerConfigPath };
}

/**
 * 以「真实消费形态」启动 headless CLI（dist bundle），采集 stream-json stdout。
 * --mode yolo：headless 没有 permission broker，非 yolo 模式下任何需要授权的工具
 * 都会被 deny broker 拒绝（CreateWorkflow 除外）；e2e 需要模型自由跑 bash/write。
 */
export function runHeadlessAgent(input) {
  return new Promise((resolvePromise) => {
    const args = [
      input.entryPath,
      "--mode",
      "yolo",
      "--cwd",
      input.cwd,
      "--output-format",
      "stream-json",
      "--prompt",
      input.prompt,
    ];
    const child = spawn(process.execPath, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: "spawn error: " + (error?.message ?? String(error)),
        exitCode: null,
        timedOut: false,
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        timedOut,
      });
    });
  });
}

/** e2e 子进程的环境：隔离数据目录 + PATH 注入夹具 bin。 */
export function buildAgentEnv(input) {
  return {
    ...process.env,
    PATH: [input.binDir, process.env.PATH ?? ""].join(delimiter),
    HOME: input.homeDir,
    ZCODE_DATA_BASE_DIR: input.dataBaseDir,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: input.builtinProviderConfigPath,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: input.providerConfigPath,
  };
}

export async function removeWorkspace(tempDir) {
  await rm(tempDir, { recursive: true, force: true });
}

export function workspaceExists(tempDir) {
  return existsSync(tempDir);
}
