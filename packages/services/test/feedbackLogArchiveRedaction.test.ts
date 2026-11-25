import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

import { createFeedbackDiagnosticArchive } from "../src/feedback/feedbackLogArchive.js";

/**
 * 反馈诊断归档必须过与桌面「导出日志」同一份结构化脱敏（task-21）。
 *
 * 缺陷形态：这是第二条导出入口。用户在应用内点「提交反馈」时，归档会原样打包 logs/ 与
 * .zcode/cli/log/ 下的文本日志发给别人；原先这条链路只做能匹配到键名的文本替换，
 * JSONL 行带敏感键时整行被替换成 [REDACTED]（诊断信息与 JSON 合法性一起丢），
 * 而 JWT / sk- / AKIA 这类只有值形态特征的密钥直接漏出。
 *
 * 这里断言的不是脱敏函数本身，而是真实 zip 归档：只有归档入口才会同时决定
 * 收集范围、解码、脱敏与压缩，中间任一环漏掉都只能在最终产物上看见。
 *
 * 运行：cd packages/services && node --import tsx --test test/feedbackLogArchiveRedaction.test.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const REDACTION_NOTICE_HEADING = "日志脱敏说明";
const BINARY_NOT_REDACTED_DECLARATION = "未脱敏（二进制）";

// 每个标记都是「键名猜不到、只能按值形态或结构识别」的形态，并带随机后缀避免与真实数据相撞。
const SECRETS = {
  jsonlAuthorization: "fb-jsonl-authorization-bearer-7c1d",
  jsonlCookie: "fb-jsonl-cookie-session-7c1d",
  jsonlNestedToken: "fb-jsonl-nested-token-7c1d",
  jsonlEscapedPassword: "fb-jsonl-escaped-password-7c1d",
  jsonlQueryKey: "fb-jsonl-query-key-7c1d",
  jsonlNumericPassword: "135792468",
  jsonlConnectionPassword: "fb-jsonl-connection-password-7c1d",
  rolloutModelKey: "fb-rollout-model-key-7c1d",
  plainJwtPayload: "fbJwtPayloadSecret7788c1d",
  plainSkToken: "sk-proj-fbSecretToken7788c1d",
  plainAwsKey: "AKIAFB7SECRET3D1E8B2",
  pemBody: "fbPemBodySecret7788c1d",
  utf16ApiKey: "fb-utf16-api-key-secret-7c1d",
} as const;

const PLAIN_JWT = `eyJhbGciOiJIUzI1NiJ9.${SECRETS.plainJwtPayload}.c2lnbmF0dXJl`;

const MODEL_IO_LINES = [
  `{"ts":"2026-11-25T19:20:00.000Z","event":"request","authorization":"Bearer ${SECRETS.jsonlAuthorization}","cookie":"sid=${SECRETS.jsonlCookie}"}`,
  `{"usage":{"cache_read_input_tokens":5,"prompt_tokens_details":{"cached_tokens":3}},"max_output_tokens":8192}`,
  `{"token":{"a":1,"value":"${SECRETS.jsonlNestedToken}"}}`,
  `{"body":"{\\"password\\":\\"${SECRETS.jsonlEscapedPassword}\\",\\"model\\":\\"glm\\"}"}`,
  `{"url":"https://api.example.com/v1/models?key=${SECRETS.jsonlQueryKey}&page=2","status":200}`,
  `{"password":${SECRETS.jsonlNumericPassword},"provider":"zhipu"}`,
  `{"message":"model loaded model=glm-4.6 requestId=abc123","dsnHint":"postgres://admin:${SECRETS.jsonlConnectionPassword}@db.example.com/app"}`,
].join("\n");

const APP_LOG_LINES = [
  "2026-11-25T19:20:03.000Z [info] request completed provider=zhipu status=200",
  `X-Provider-Cred: ${PLAIN_JWT}`,
  `2026-11-25T19:20:04.000Z [info] retry token ${SECRETS.plainSkToken} rejected`,
  `2026-11-25T19:20:05.000Z [info] signing key ${SECRETS.plainAwsKey} rotated`,
  "-----BEGIN RSA PRIVATE KEY-----",
  `MIIEowIBAAKCAQEA${SECRETS.pemBody}`,
  "-----END RSA PRIVATE KEY-----",
  "2026-11-25T19:20:07.000Z [info] after small private key block",
].join("\n");

// 诊断为排障主干：时间戳、上下文与 token 计数（不是凭据）都必须原样保留。
const DIAGNOSTIC_LINES = [
  "2026-11-25T19:22:00.000Z [info] app version 1.2.3 platform linux",
  "2026-11-25T19:22:01.000Z [info] model loaded model=glm-4.6 requestId=abc123 latencyMs=418",
  "2026-11-25T19:22:02.000Z [warn] retry scheduled attempt=2 delayMs=1500",
  "2026-11-25T19:22:03.000Z [info] usage prompt_tokens=812 max_output_tokens=8192",
].join("\n");

const ROLLOUT_LINES = [
  `{"ts":"2026-11-25T19:24:00.000Z","apiKey":"${SECRETS.rolloutModelKey}","model":"glm-4.6"}`,
  `{"ts":"2026-11-25T19:24:01.000Z","status":200,"provider":"zhipu"}`,
].join("\n");

const UTF16_LE_LOG = `\ufeff2026-11-25T19:23:00.000Z [info] OPENAI_API_KEY=${SECRETS.utf16ApiKey}\n`;
// 无法解码成文本的 .log：既不能原样进包，也不能让整次归档失败。
const CORRUPT_LOG_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x42, 0x49, 0x4e, 0x00, 0xff, 0xfe]);

interface Harness {
  rootDir: string;
  logsDir: string;
  cliLogDir: string;
  outputRootDir: string;
}

async function createHarness(): Promise<Harness> {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-feedback-redaction-"));
  const harness: Harness = {
    rootDir,
    logsDir: join(rootDir, "logs"),
    cliLogDir: join(rootDir, "cli-log"),
    outputRootDir: join(rootDir, "archive-out"),
  };
  await mkdir(harness.logsDir, { recursive: true });
  await mkdir(harness.cliLogDir, { recursive: true });
  await writeFile(join(harness.logsDir, "model-io.jsonl"), `${MODEL_IO_LINES}\n`, "utf8");
  await writeFile(join(harness.logsDir, "app.log"), `${APP_LOG_LINES}\n`, "utf8");
  await writeFile(join(harness.logsDir, "diagnostics.log"), `${DIAGNOSTIC_LINES}\n`, "utf8");
  await writeFile(join(harness.logsDir, "utf16le.log"), Buffer.from(UTF16_LE_LOG, "utf16le"));
  await writeFile(join(harness.logsDir, "corrupt.log"), CORRUPT_LOG_BYTES);
  await writeFile(join(harness.cliLogDir, "rollout.jsonl"), `${ROLLOUT_LINES}\n`, "utf8");
  return harness;
}

function readZipEntries(archivePath: string): Promise<Map<string, Buffer>> {
  return new Promise((resolveEntries, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error("无法打开反馈归档"));
        return;
      }
      const entries = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolveEntries(entries));
      zip.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error("无法读取归档条目"));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

interface ArchivedFeedbackLogs {
  harness: Harness;
  entries: Map<string, Buffer>;
}

let cachedArchive: Promise<ArchivedFeedbackLogs> | null = null;

function archivedFeedbackLogs(): Promise<ArchivedFeedbackLogs> {
  cachedArchive ??= (async () => {
    const harness = await createHarness();
    const archive = await createFeedbackDiagnosticArchive({
      sources: [
        { directory: harness.logsDir, archivePrefix: "logs" },
        { directory: harness.cliLogDir, archivePrefix: ".zcode/cli/log" },
      ],
      outputRootDir: harness.outputRootDir,
    });
    return { harness, entries: await readZipEntries(archive.path) };
  })();
  return cachedArchive;
}

function entryText(entries: Map<string, Buffer>, entryName: string): string {
  const content = entries.get(entryName);
  assert.ok(
    content !== undefined,
    `归档缺少条目 ${entryName}；实有条目：${[...entries.keys()].join(", ")}`,
  );
  return content.toString("utf8");
}

after(async () => {
  if (!cachedArchive) return;
  const { harness } = await cachedArchive;
  await rm(harness.rootDir, { recursive: true, force: true });
});

test("含密钥样本的反馈归档里不出现任何密钥片段（utf8 + utf16le 双视图）", async () => {
  const { entries } = await archivedFeedbackLogs();
  const markers = Object.values(SECRETS);
  assert.ok(entries.size > 0, "归档为空");
  for (const [entryName, buffer] of entries) {
    // 源日志可能是 UTF-16：两个解码视图各自检查，单看 utf8 会静默放过宽字符里的密钥。
    const decodedViews = [buffer.toString("utf8"), buffer.toString("utf16le")];
    for (const marker of markers) {
      for (const view of decodedViews) {
        assert.ok(!view.includes(marker), `条目 ${entryName} 仍含密钥片段 ${marker}`);
      }
    }
  }
});

test("诊断信息仍保留（版本/平台/时间戳/上下文行/token 计数）", async () => {
  const { entries } = await archivedFeedbackLogs();
  const about = entryText(entries, "about.txt");
  assert.match(about, /^timestamp: \S+/m);
  assert.match(about, /^appVersion: \S+/m);
  assert.match(about, /^os: \S+/m);

  const diagnostics = entryText(entries, "logs/diagnostics.log");
  for (const line of DIAGNOSTIC_LINES.split("\n")) {
    assert.ok(diagnostics.includes(line), `诊断行未原样保留：${line}`);
  }
  // 私钥块之外的行必须活着：脱敏只能换掉凭据，不能吞掉时间戳与上下文。
  const appLog = entryText(entries, "logs/app.log");
  assert.ok(appLog.includes("2026-11-25T19:20:03.000Z [info] request completed provider=zhipu"));
  assert.ok(appLog.includes("2026-11-25T19:20:07.000Z [info] after small private key block"));
});

test("JSONL 每行仍是合法 JSON，且计数类字段不被误脱敏", async () => {
  const { entries } = await archivedFeedbackLogs();
  for (const [entryName, expectedLineCount] of [
    ["logs/model-io.jsonl", MODEL_IO_LINES.split("\n").length],
    [".zcode/cli/log/rollout.jsonl", ROLLOUT_LINES.split("\n").length],
  ] as const) {
    const lines = entryText(entries, entryName)
      .split("\n")
      .filter((line) => line.trim().length > 0);
    assert.equal(lines.length, expectedLineCount, `${entryName} 行数变化（脱敏不得丢行）`);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `${entryName} 行不是合法 JSON：${line}`);
    }
  }

  const modelIoLines = entryText(entries, "logs/model-io.jsonl")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const usageLine = modelIoLines.find((line) => line.includes("cache_read_input_tokens"));
  assert.ok(usageLine, "缺少 token 计数行");
  assert.ok(usageLine.includes("8192"), "token 预算值被误脱敏");
  const numericPasswordLine = modelIoLines.find((line) => line.includes("zhipu"));
  assert.ok(numericPasswordLine, "缺少数字口令行");
  assert.match(numericPasswordLine, /"password":"\*\*\*REDACTED\*\*\*"/);
});

test("归档清单声明脱敏范围，并声明二进制文件未脱敏", async () => {
  const { entries } = await archivedFeedbackLogs();
  const about = entryText(entries, "about.txt");
  assert.ok(about.includes(REDACTION_NOTICE_HEADING), "归档清单缺少脱敏说明");
  assert.ok(
    about.includes(BINARY_NOT_REDACTED_DECLARATION),
    `归档清单未声明二进制文件未脱敏；清单正文：${about}`,
  );
  // 声明必须与实际一致：不可解码的 .log 确实没有进包（裸二进制不许原文外发）。
  const unsupportedEntry = [...entries.keys()].find((name) => name.includes("corrupt.log"));
  assert.equal(unsupportedEntry, undefined, "不可解码的二进制日志被原样打包");
  assert.ok(
    /"unsupported-text":\s*\d+/.test(about),
    `清单未把二进制文件计入跳过原因；清单正文：${about}`,
  );
});

test("脱敏只有一份实现：两条导出入口都不自带规则", async () => {
  const owner = join(repoRoot, "packages", "shared", "src", "log-redaction.ts");
  const consumers = [
    join(repoRoot, "packages", "desktop", "src", "main", "exportLogs.ts"),
    join(repoRoot, "packages", "services", "src", "feedback", "feedbackLogArchive.ts"),
  ];
  // 这些正则片段只属于共享实现；出现在消费方就说明逻辑被复制成了第二份。
  const ownedMarkers = ["xox[baprs]", "github_pat_", "AIza[0-9A-Za-z_-]{35}"];
  const ownerSource = await readFile(owner, "utf8");
  for (const marker of ownedMarkers) {
    assert.ok(ownerSource.includes(marker), `共享实现缺少标记 ${marker}`);
    for (const consumerPath of consumers) {
      const consumerSource = await readFile(consumerPath, "utf8");
      assert.ok(
        !consumerSource.includes(marker),
        `${consumerPath} 自带脱敏规则（${marker}）：必须从 @zcode/shared 取同一份实现`,
      );
    }
  }
  for (const consumerPath of consumers) {
    assert.match(
      await readFile(consumerPath, "utf8"),
      /from "@zcode\/shared"/,
      `${consumerPath} 未从共享实现导入`,
    );
  }
  // 共享实现必须保持可进浏览器产物：shared 根入口会被 renderer 打包，不能出现 Node-only 依赖。
  assert.ok(!/(?:^|\n)\s*import\s/u.test(ownerSource), "共享实现引入了 import：会被拉进浏览器产物");
  for (const nodeOnlySymbol of ["Buffer.", "process.", "require("]) {
    assert.ok(
      !ownerSource.includes(nodeOnlySymbol),
      `共享实现触碰了 Node-only 全局 ${nodeOnlySymbol}`,
    );
  }
});
