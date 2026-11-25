import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import yauzl from "yauzl";

import { exportLogs } from "../src/main/exportLogs.js";

/**
 * 日志导出脱敏：导出 zip 前必须按结构处理敏感内容，且脱敏对二次导出幂等。
 *
 * 样本覆盖四类曾经或可能漏出去的形态：JSONL 里的键名凭据与嵌套对象、格式化 JSON 配置里的嵌套
 * token、纯文本行里的私钥块与常见密钥形态、UTF-16 编码的赋值行。断言落在真实导出链路的 zip 条目上，
 * 不是直接调用脱敏函数，因为只有导出入口才会同时决定收集、编码识别与压缩。
 */

const REDACTION_NOTICE_HEADING = "日志脱敏说明";

const SECRETS = {
  jsonlAuthorization: "e2e-jsonl-authorization-bearer",
  jsonlCookie: "e2e-jsonl-cookie-session",
  jsonlNestedValue: "e2e-jsonl-token-nested-value",
  jsonlEscapedPassword: "e2e-jsonl-escaped-password",
  jsonlQuery: "e2e-jsonl-query-token",
  jsonlNumericPassword: "246813579",
  jsonlConnectionPassword: "e2e-jsonl-connection-password",
  plainJwt: "eyJhbGciOiJIUzI1NiJ9.e2eJwtPayloadSecret9a1b.c2lnbmF0dXJl",
  plainJwtPayload: "e2eJwtPayloadSecret9a1b",
  plainSkToken: "sk-proj-e2eSecretToken9a1b3c5d7e",
  plainAwsKey: "AKIAE2ESECRET7C2D9A1",
  smallPemBody: "e2eSmallPemBody9a1b",
  configToken: "e2e-config-token-value",
  utf16Password: "e2e-utf16-password",
  bigPemPayloadLine: "e2eBigPemPrivateKeySecretPayload",
} as const;

// 私钥块体经过 base64 写进文件，按前缀片段判断是否残留。
const bigPemBody = Buffer.from(`${SECRETS.bigPemPayloadLine}\n`.repeat(4000)).toString("base64");
const bigPemBodyMarker = bigPemBody.slice(0, 40);

const ROLLOUT_LINES = [
  `{"ts":"2026-11-25T19:20:00.000Z","event":"request","authorization":"Bearer ${SECRETS.jsonlAuthorization}","cookie":"sid=${SECRETS.jsonlCookie}"}`,
  `{"usage":{"cache_read_input_tokens":5,"prompt_tokens_details":{"cached_tokens":3}},"max_output_tokens":8192}`,
  `{"token":{"a":1,"value":"${SECRETS.jsonlNestedValue}"}}`,
  `{"body":"{\\"password\\":\\"${SECRETS.jsonlEscapedPassword}\\",\\"model\\":\\"glm\\"}"}`,
  `{"url":"https://api.example.com/v1/models?key=${SECRETS.jsonlQuery}&page=2","status":200}`,
  `{"password":${SECRETS.jsonlNumericPassword},"provider":"zhipu"}`,
  `{"message":"model loaded model=glm-4.6 requestId=abc123","dsnHint":"postgres://admin:${SECRETS.jsonlConnectionPassword}@db.example.com/app"}`,
].join("\n");

const PLAIN_LOG_LINES = [
  "2026-11-25T19:20:03.000Z [info] request completed provider=zhipu status=200",
  `X-Provider-Cred: ${SECRETS.plainJwt}`,
  `2026-11-25T19:20:04.000Z [info] retry token ${SECRETS.plainSkToken} rejected`,
  `2026-11-25T19:20:05.000Z [info] signing key ${SECRETS.plainAwsKey} rotated`,
  "-----BEGIN RSA PRIVATE KEY-----",
  `MIIEowIBAAKCAQEA${SECRETS.smallPemBody}`,
  "-----END RSA PRIVATE KEY-----",
  "2026-11-25T19:20:07.000Z [info] after small private key block",
].join("\n");

const BIG_KEY_BLOCK_FILE = [
  "2026-11-25T19:21:00.000Z [info] dumping provider key",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  bigPemBody.match(/.{1,64}/g)?.join("\n") ?? "",
  "-----END OPENSSH PRIVATE KEY-----",
  "2026-11-25T19:21:01.000Z [info] after big private key block",
].join("\n");

const CONFIG_JSON = [
  "{",
  `  "provider": "zhipu",`,
  `  "baseUrl": "https://api.example.com",`,
  `  "auth": {`,
  `    "token": {`,
  `      "value": "${SECRETS.configToken}",`,
  `      "expiresAt": 1764200000000`,
  "    }",
  "  }",
  "}",
  "",
].join("\n");

const DIAGNOSTIC_LINES = [
  "2026-11-25T19:22:00.000Z [info] app version 1.2.3 platform linux",
  "2026-11-25T19:22:01.000Z [info] model loaded model=glm-4.6 requestId=abc123 latencyMs=418",
  "2026-11-25T19:22:02.000Z [warn] retry scheduled attempt=2 delayMs=1500",
].join("\n");

interface ExportHarness {
  rootDir: string;
  sourceDir: string;
  outputRootDir: string;
  stageRootDir: string;
  homeDir: string;
}

interface ExportedArchive {
  archivePath: string;
  entries: Map<string, Buffer>;
}

async function createHarness(): Promise<ExportHarness> {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-export-logs-redaction-"));
  const harness: ExportHarness = {
    rootDir,
    sourceDir: join(rootDir, "app-data"),
    outputRootDir: join(rootDir, "exports"),
    stageRootDir: join(rootDir, "stage"),
    homeDir: join(rootDir, "home"),
  };
  await mkdir(harness.sourceDir, { recursive: true });
  await mkdir(harness.homeDir, { recursive: true });
  return harness;
}

async function writeSampleLogs(harness: ExportHarness): Promise<void> {
  const logsDir = join(harness.sourceDir, "logs");
  await mkdir(logsDir, { recursive: true });
  await writeFile(join(logsDir, "model-io.jsonl"), `${ROLLOUT_LINES}\n`, "utf8");
  await writeFile(join(logsDir, "app.log"), `${PLAIN_LOG_LINES}\n`, "utf8");
  await writeFile(join(logsDir, "big-key.log"), `${BIG_KEY_BLOCK_FILE}\n`, "utf8");
  await writeFile(join(logsDir, "diagnostics.log"), `${DIAGNOSTIC_LINES}\n`, "utf8");
  await writeFile(
    join(logsDir, "utf16le.log"),
    Buffer.from(
      `\ufeff2026-11-25T19:23:00.000Z [info] OPENAI_API_KEY=${SECRETS.utf16Password}\n`,
      "utf16le",
    ),
  );
  await writeFile(
    join(logsDir, "crash-dump.bin"),
    Buffer.from([0x00, 0x01, 0x02, 0x00, 0x42, 0x49, 0x4e, 0x00]),
  );
  await writeFile(join(harness.sourceDir, "config.json"), CONFIG_JSON, "utf8");
}

function readZipEntries(archivePath: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error("无法打开日志归档"));
        return;
      }
      const entries = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
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

function entryBuffer(archive: ExportedArchive, archivePath: string): Buffer {
  const content = archive.entries.get(archivePath);
  assert.ok(content !== undefined, `归档缺少条目 ${archivePath}`);
  return content;
}

function entryText(archive: ExportedArchive, archivePath: string): string {
  return entryBuffer(archive, archivePath).toString("utf8");
}

async function runExport(harness: ExportHarness): Promise<ExportedArchive> {
  const previousHome = process.env.HOME;
  // 收集阶段会读 ~/.zcode/cli 下的日志，隔离 HOME 才能保证测试只看样本目录。
  process.env.HOME = harness.homeDir;
  try {
    const result = await exportLogs({
      getZCodeDataDir: () => harness.sourceDir,
      getExportLogDir: () => harness.outputRootDir,
      getExportLogStageDir: () => harness.stageRootDir,
      showItemInFolder: () => {},
    });
    assert.equal(result.success, true, result.error ?? "日志导出失败");
    assert.ok(result.path, "导出未返回归档路径");
    return { archivePath: result.path, entries: await readZipEntries(result.path) };
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

let cachedExport: Promise<{ harness: ExportHarness; archive: ExportedArchive }> | null = null;

function firstExport(): Promise<{ harness: ExportHarness; archive: ExportedArchive }> {
  cachedExport ??= (async () => {
    const harness = await createHarness();
    await writeSampleLogs(harness);
    return { harness, archive: await runExport(harness) };
  })();
  return cachedExport;
}

after(async () => {
  if (!cachedExport) {
    return;
  }
  const { harness } = await cachedExport;
  await rm(harness.rootDir, { recursive: true, force: true });
});

test("含密钥样本导出后不出现任何片段", async () => {
  const { archive } = await firstExport();
  const markers = [
    SECRETS.jsonlAuthorization,
    SECRETS.jsonlCookie,
    SECRETS.jsonlNestedValue,
    SECRETS.jsonlEscapedPassword,
    SECRETS.jsonlQuery,
    SECRETS.jsonlNumericPassword,
    SECRETS.jsonlConnectionPassword,
    SECRETS.plainJwtPayload,
    SECRETS.plainSkToken,
    SECRETS.plainAwsKey,
    SECRETS.smallPemBody,
    SECRETS.configToken,
    SECRETS.utf16Password,
    bigPemBodyMarker,
  ];
  assert.ok(archive.entries.size > 0, "归档为空");
  for (const [entryName, buffer] of archive.entries) {
    // UTF-16 日志按字节存的是宽字符，两个解码视图都要检查，否则断言会静默放过它。
    const decodedViews = [buffer.toString("utf8"), buffer.toString("utf16le")];
    for (const marker of markers) {
      for (const view of decodedViews) {
        assert.ok(!view.includes(marker), `条目 ${entryName} 仍含密钥片段 ${marker}`);
      }
    }
  }
});

test("既有诊断信息仍保留（版本、平台、时间戳、上下文行）", async () => {
  const { archive } = await firstExport();
  const aboutContent = entryText(archive, "about.txt");
  assert.match(aboutContent, /^Version: \S+/m);
  assert.match(aboutContent, /^OS Platform: \S+/m);
  assert.match(aboutContent, /^OS Arch: \S+/m);

  const diagnostics = entryText(archive, "logs/diagnostics.log");
  for (const line of DIAGNOSTIC_LINES.split("\n")) {
    assert.ok(diagnostics.includes(line), `诊断行未原样保留：${line}`);
  }

  // 时间戳与固定上下文是排障的主干，脱敏不能把它们吃掉。
  const appLog = entryText(archive, "logs/app.log");
  assert.ok(
    appLog.includes("2026-11-25T19:20:03.000Z [info] request completed provider=zhipu status=200"),
  );
  assert.ok(appLog.includes("2026-11-25T19:20:07.000Z [info] after small private key block"));
});

test("JSONL 导出后每行仍是合法 JSON", async () => {
  const { archive } = await firstExport();
  const lines = entryText(archive, "logs/model-io.jsonl")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  assert.equal(lines.length, ROLLOUT_LINES.split("\n").length);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `JSONL 行不是合法 JSON：${line}`);
  }
  const usageLine = lines.find((line) => line.includes("cache_read_input_tokens"));
  assert.ok(usageLine, "缺少 token 计数行");
  assert.ok(usageLine.includes("8192"), "token 预算值被误脱敏");
  const numericPasswordLine = lines.find((line) => line.includes("zhipu"));
  assert.ok(numericPasswordLine, "缺少数字口令行");
  assert.match(numericPasswordLine, /"password":"\*\*\*REDACTED\*\*\*"/);
});

test("格式化配置 JSON 与私钥块按结构脱敏，块外内容保留", async () => {
  const { archive } = await firstExport();
  const config = entryText(archive, "config.json");
  assert.doesNotThrow(() => JSON.parse(config), "配置 JSON 导出后无法解析");
  assert.ok(!config.includes(SECRETS.configToken), "配置里的 token 未脱敏");
  const parsed = JSON.parse(config) as {
    provider?: string;
    baseUrl?: string;
    auth?: unknown;
  };
  // 敏感键下的子树保留 JSON 结构（键和值都换成占位符），同级的非敏感诊断字段必须原样保留。
  assert.equal(parsed.provider, "zhipu");
  assert.equal(parsed.baseUrl, "https://api.example.com");
  assert.equal(typeof parsed.auth, "object");

  const bigKeyLog = entryText(archive, "logs/big-key.log");
  assert.ok(!bigKeyLog.includes("-----BEGIN"), "私钥块起始行未脱敏");
  assert.ok(bigKeyLog.includes("2026-11-25T19:21:01.000Z [info] after big private key block"));
  const smallKeyLog = entryText(archive, "logs/app.log");
  assert.ok(!smallKeyLog.includes("-----END"), "私钥块结束行未脱敏");
});

test("导出清单说明脱敏范围与未覆盖形态", async () => {
  const { archive } = await firstExport();
  const aboutContent = entryText(archive, "about.txt");
  assert.ok(aboutContent.includes(REDACTION_NOTICE_HEADING), "导出清单缺少脱敏说明");
  assert.ok(aboutContent.includes("二进制"), "导出清单未声明二进制文件不脱敏");
});

test("脱敏是幂等的", async () => {
  const { archive } = await firstExport();
  const secondHarness = await createHarness();
  // 把第一次导出里的文本日志当作输入再导出一次，归档内容必须逐字节不变。
  const textEntries = [...archive.entries].filter(
    ([entryName]) => entryName !== "about.txt" && !entryName.endsWith(".bin"),
  );
  assert.ok(textEntries.length > 0, "第一次导出没有可复用的文本日志");
  for (const [entryName, content] of textEntries) {
    const targetPath = join(secondHarness.sourceDir, ...entryName.split("/"));
    await mkdir(join(targetPath, ".."), { recursive: true });
    await writeFile(targetPath, content);
  }
  const secondArchive = await runExport(secondHarness);
  try {
    for (const [entryName, content] of textEntries) {
      const secondContent = entryBuffer(secondArchive, entryName);
      const firstLines = content.toString("utf8").split("\n");
      const secondLines = secondContent.toString("utf8").split("\n");
      const diffIndex = firstLines.findIndex((line, index) => line !== secondLines[index]);
      assert.deepEqual(
        secondContent,
        content,
        `二次导出改写了 ${entryName}，脱敏不幂等；首个差异行 ${diffIndex}：${firstLines[diffIndex]} => ${secondLines[diffIndex]}`,
      );
    }
  } finally {
    await rm(secondHarness.rootDir, { recursive: true, force: true });
  }
});
