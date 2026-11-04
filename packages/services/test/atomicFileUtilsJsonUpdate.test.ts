import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  JsonObjectFileUnreadableError,
  readJsonObjectFileForUpdate,
  updateJsonObjectFile,
} from "../src/fs/atomicFileUtils.js";

/**
 * config.json 多写入方共用的「严格读取 + 写前重读 + 原子替换」契约。
 *
 * 回归形态：命令、技能、钩子、MCP 设置、迁移导入各自读改写同一份 config.json。
 * 旧写法在文件损坏或读失败时拿到空对象，再把整份文件写回成只剩自己的字段——
 * provider、MCP secret、plugin.dirs 会被静默清掉，且不可恢复。
 */

async function withTempDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-atomic-json-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  return dir;
}

test("损坏的 config.json：报错且字节不变，绝不被默认值覆盖", async (t) => {
  const dir = await withTempDir(t);
  const filePath = join(dir, "config.json");
  const corrupt = '{ "mcp": { "servers": ';
  await writeFile(filePath, corrupt, "utf-8");

  await assert.rejects(
    () => updateJsonObjectFile(filePath, (current) => ({ ...current, command: {} })),
    (error: unknown) => error instanceof JsonObjectFileUnreadableError,
    "损坏文件必须抛 JsonObjectFileUnreadableError，而不是当作空对象继续写",
  );
  assert.equal(await readFile(filePath, "utf-8"), corrupt, "失败路径不得改动原文件字节");
});

test("根节点不是对象：同样拒绝写入", async (t) => {
  const dir = await withTempDir(t);
  const filePath = join(dir, "config.json");
  await writeFile(filePath, "[1, 2, 3]", "utf-8");
  await assert.rejects(() => readJsonObjectFileForUpdate(filePath));
  assert.equal(await readFile(filePath, "utf-8"), "[1, 2, 3]");
});

test("写前重读：只改自己的字段，其他写入方的字段原样保留", async (t) => {
  const dir = await withTempDir(t);
  const filePath = join(dir, "config.json");
  await writeFile(
    filePath,
    JSON.stringify({ mcp: { servers: { keep: { command: "x" } } }, plugins: { dirs: ["/p"] } }),
    "utf-8",
  );

  await updateJsonObjectFile(filePath, (current) => ({
    ...current,
    command: { "/c.md": { enable: false } },
  }));
  const parsed = JSON.parse(await readFile(filePath, "utf-8")) as Record<string, unknown>;
  assert.deepEqual(parsed.plugins, { dirs: ["/p"] });
  assert.deepEqual(parsed.mcp, { servers: { keep: { command: "x" } } });
  assert.deepEqual(parsed.command, { "/c.md": { enable: false } });
});

test("文件不存在：按空对象处理并创建", async (t) => {
  const dir = await withTempDir(t);
  const filePath = join(dir, "config.json");
  assert.deepEqual(await readJsonObjectFileForUpdate(filePath), {});
  await updateJsonObjectFile(filePath, (current) => ({ ...current, hooks: {} }));
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf-8")), { hooks: {} });
});
