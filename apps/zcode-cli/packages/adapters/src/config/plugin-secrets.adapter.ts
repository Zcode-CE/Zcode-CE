// Modified by ZCode: 自上游 zai-org/ZCode v4.0.0 (a4b44451, Apache-2.0) 的
// apps/zcode-cli/packages/adapters/src/config/plugin-secrets.adapter.ts 搬运；CE 侧把读取路径改成同步
// （插件解析链全同步），备份也随之为同步实现，锁与原子写仍复用 @zcode/shared/node。
//
// Plugin Secrets Adapter - 敏感插件选项的私有文件（plugin-compat.md「Sensitive Option Storage」）。
//
// 文件与插件存储目录 `plugins/` 同级（plugin-secrets.json），按 workspace root 分桶：
// user 作用域的敏感键与 workspace 作用域的全部插件选项都存在这里，不进 config.json。
// 任何错误信息与返回的诊断原因都不带值，避免把密钥写进日志或 UI。
//
// 读取路径同步、无锁：CE 的插件解析链（createConfig / resolveZCodePlugins / app 启动）全是同步
// 函数，把读取改成 async 会把 CLI、协议与启动链一并拉成 async，收益不足以抵消改动面；
// 写入是原子 rename，读者只会看到旧文件或新文件，永远不会读到写了一半的内容，
// 所以读取不需要拿锁。写入路径（updatePluginSecretsFile）在同一个文件锁内读改写并原子写。

import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { z } from "zod";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import type { PluginOptionValues } from "@zcode/contracts";
import type { PluginOptionLayer } from "./config-factory.js";

export const PLUGIN_SECRETS_FILE_NAME = "plugin-secrets.json";
const PLUGIN_SECRETS_FILE_VERSION = 1;
const JSON_INDENT = 2;
const WINDOWS_PLATFORM = "win32";
const PRIVATE_FILE_MODE = 0o600;
const EXCLUSIVE_CREATE_FLAG = "wx";
const CORRUPT_BACKUP_MARKER = ".corrupt-";
const CORRUPT_BACKUP_SUFFIX = ".bak";
const CORRUPT_BACKUP_CONTENT_ID_LENGTH = 24;

const pluginOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const pluginSecretValuesSchema = z.record(
  z.string(),
  z.record(z.string(), pluginOptionValueSchema),
);
const pluginSecretsFileSchema = z
  .object({
    version: z.literal(PLUGIN_SECRETS_FILE_VERSION),
    user: pluginSecretValuesSchema,
    workspaces: z.record(z.string(), pluginSecretValuesSchema),
  })
  .strict();

export type PluginSecretValue = z.infer<typeof pluginOptionValueSchema>;
/** pluginId → option key → value。 */
export type PluginSecretValues = z.infer<typeof pluginSecretValuesSchema>;
export type PluginSecretsFile = z.infer<typeof pluginSecretsFileSchema>;
export type PluginSecretsScope = { kind: "user" } | { kind: "workspace"; root: string };

/** 读取结果：读不出时一律按空文件处理，原因只区分「损坏」与「I/O 失败」。 */
export type PluginSecretsReadResult =
  | { status: "ok"; file: PluginSecretsFile }
  | { status: "unreadable"; reason: "corrupt" | "io"; file: PluginSecretsFile };

/** 私有文件里一条生效值：按层叠加时决定 scope 与最终值。 */
export interface PluginSecretOverride {
  key: string;
  pluginId: string;
  scope: PluginOptionLayer["scope"];
  value: PluginSecretValue;
}

export function createEmptyPluginSecretsFile(): PluginSecretsFile {
  return { version: PLUGIN_SECRETS_FILE_VERSION, user: {}, workspaces: {} };
}

/**
 * 插件配置路径与 workspace root 的比较键：Windows 不区分大小写、分隔符统一为 `/`。
 * workspace 配置路径匹配与私有文件的 workspace 键共用这一条规则。
 */
export function normalizePluginConfigPathForComparison(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== WINDOWS_PLATFORM) return resolve(path);
  return win32.resolve(path).replaceAll("\\", "/").toLowerCase();
}

/**
 * 读取路径（无锁）：原子写入保证读者只会看到旧文件或新文件。
 * 损坏时先同步备份再按空处理；备份失败不影响读取（原文件仍在，下次写入前会再备份）。
 */
export function readPluginSecretsFileSync(path: string): PluginSecretsReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { status: "ok", file: createEmptyPluginSecretsFile() };
    }
    return { status: "unreadable", reason: "io", file: createEmptyPluginSecretsFile() };
  }
  const parsed = parsePluginSecretsFile(raw);
  if (parsed) return { status: "ok", file: parsed };
  backupCorruptPluginSecretsFileSync(path);
  return { status: "unreadable", reason: "corrupt", file: createEmptyPluginSecretsFile() };
}

/**
 * 在文件锁内读改写。损坏的文件先备份（失败则抛错，不覆盖读不出的证据）再按空处理；
 * 损坏以外的读取错误向上抛。内容不变且原文件有效时不写盘，避免为空操作创建文件。
 */
export async function updatePluginSecretsFile(
  path: string,
  mutate: (file: PluginSecretsFile) => PluginSecretsFile,
): Promise<void> {
  await withFileLock(path, async () => {
    const current = await readPluginSecretsFileForWrite(path);
    const next = prunePluginSecretsFile(mutate(current.file));
    if (!current.corrupt && JSON.stringify(next) === JSON.stringify(current.file)) return;
    await atomicWritePrivateTextFile(path, `${JSON.stringify(next, null, JSON_INDENT)}\n`);
  });
}

/** 某个 scope 下全部插件的私有值；workspace 按规范化后的 root 匹配。 */
export function getPluginSecretsForScope(
  file: PluginSecretsFile,
  scope: PluginSecretsScope,
): PluginSecretValues {
  if (scope.kind === "user") return file.user;
  const target = normalizePluginConfigPathForComparison(scope.root);
  const merged: PluginSecretValues = {};
  // 键按规范化比较，兼容手工编辑留下的大小写或分隔符差异。
  for (const [root, values] of Object.entries(file.workspaces)) {
    if (normalizePluginConfigPathForComparison(root) !== target) continue;
    for (const [pluginId, pluginValues] of Object.entries(values)) {
      merged[pluginId] = { ...merged[pluginId], ...pluginValues };
    }
  }
  return merged;
}

/** 写入一个插件在某个 scope 的私有值：先删 clearKeys，再写 values（与 config.json 的合并语义一致）。 */
export function setPluginSecrets(
  file: PluginSecretsFile,
  scope: PluginSecretsScope,
  pluginId: string,
  values: PluginOptionValues,
  clearKeys: readonly string[],
): PluginSecretsFile {
  const clear = new Set(clearKeys);
  const current = getPluginSecretsForScope(file, scope)[pluginId] ?? {};
  const nextPluginValues = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => !clear.has(key))),
    ...values,
  };
  if (scope.kind === "user") {
    return { ...file, user: { ...file.user, [pluginId]: nextPluginValues } };
  }
  const target = normalizePluginConfigPathForComparison(scope.root);
  const scopeValues = { ...getPluginSecretsForScope(file, scope), [pluginId]: nextPluginValues };
  return {
    ...file,
    workspaces: {
      ...withoutWorkspaceRoot(file.workspaces, target),
      [target]: scopeValues,
    },
  };
}

/** 删除一个插件的私有值：指定 scope，或 `"all"`（user 与全部 workspaces，用于卸载）。 */
export function removePluginSecrets(
  file: PluginSecretsFile,
  pluginId: string,
  scope: PluginSecretsScope | "all",
): PluginSecretsFile {
  const removeFrom = (values: PluginSecretValues): PluginSecretValues =>
    Object.fromEntries(Object.entries(values).filter(([id]) => id !== pluginId));
  if (scope === "all") {
    return {
      ...file,
      user: removeFrom(file.user),
      workspaces: Object.fromEntries(
        Object.entries(file.workspaces).map(([root, values]) => [root, removeFrom(values)]),
      ),
    };
  }
  if (scope.kind === "user") return { ...file, user: removeFrom(file.user) };
  const target = normalizePluginConfigPathForComparison(scope.root);
  return {
    ...file,
    workspaces: Object.fromEntries(
      Object.entries(file.workspaces).map(([root, values]) => [
        root,
        normalizePluginConfigPathForComparison(root) === target ? removeFrom(values) : values,
      ]),
    ),
  };
}

/**
 * 私有文件与插件存储目录 `plugins/` 同级。默认就是 `<cli storage root>/plugin-secrets.json`；
 * 调用方覆盖插件存储目录（测试、嵌入）时文件跟着走，不会写进真实的用户目录。
 */
export function resolvePluginSecretsPath(pluginStorageRoot: string): string {
  return join(dirname(pluginStorageRoot), PLUGIN_SECRETS_FILE_NAME);
}

/**
 * 按配置层解析出私有文件里真正生效的值（启动、动态重载与协议投影共用同一套优先级）。
 *
 * 项目（workspace）层只读私有值：项目配置文件里的 `plugins.options` 已从 merged config 剥离，
 * 也不作为私有值的来源 —— 仓库可控的文件不能成为插件启动参数（解释器路径、请求地址）的来源。
 */
export function resolvePluginSecretOverrides(
  layers: readonly PluginOptionLayer[],
  file: PluginSecretsFile,
): PluginSecretOverride[] {
  const layerSecrets = layers.map((layer) => getPluginSecretsForScope(file, toSecretsScope(layer)));
  const overrides: PluginSecretOverride[] = [];
  for (const [pluginId, keys] of collectSecretKeys(layerSecrets)) {
    for (const key of keys) {
      const winner = resolveLayeredValue(layers, layerSecrets, pluginId, key);
      if (winner) overrides.push({ key, pluginId, ...winner });
    }
  }
  return overrides;
}

function toSecretsScope(layer: PluginOptionLayer): PluginSecretsScope {
  return layer.scope === "workspace" && layer.workspaceRoot
    ? { kind: "workspace", root: layer.workspaceRoot }
    : { kind: "user" };
}

function collectSecretKeys(layerSecrets: readonly PluginSecretValues[]): Map<string, Set<string>> {
  const touched = new Map<string, Set<string>>();
  for (const secrets of layerSecrets) {
    for (const [pluginId, values] of Object.entries(secrets)) {
      const keys = touched.get(pluginId) ?? new Set<string>();
      for (const key of Object.keys(values)) keys.add(key);
      touched.set(pluginId, keys);
    }
  }
  return touched;
}

function resolveLayeredValue(
  layers: readonly PluginOptionLayer[],
  layerSecrets: readonly PluginSecretValues[],
  pluginId: string,
  key: string,
): { scope: PluginOptionLayer["scope"]; value: PluginSecretValue } | undefined {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (!layer) continue;
    const secret = layerSecrets[index]?.[pluginId]?.[key];
    if (secret !== undefined) return { scope: layer.scope, value: secret };
    // 项目文件不提供任何运行时选项，即使调用方传入的是旧的配置快照，也不能覆盖用户私有值。
    const plain = layer.scope === "user" ? layer.options[pluginId]?.[key] : undefined;
    if (plain !== undefined) return { scope: layer.scope, value: plain };
  }
  return undefined;
}

function withoutWorkspaceRoot(
  workspaces: PluginSecretsFile["workspaces"],
  normalizedRoot: string,
): PluginSecretsFile["workspaces"] {
  return Object.fromEntries(
    Object.entries(workspaces).filter(
      ([root]) => normalizePluginConfigPathForComparison(root) !== normalizedRoot,
    ),
  );
}

/** 去掉空的插件条目与空的 workspace 条目，卸载或清除后不留空壳。 */
function prunePluginSecretsFile(file: PluginSecretsFile): PluginSecretsFile {
  const pruneValues = (values: PluginSecretValues): PluginSecretValues =>
    Object.fromEntries(
      Object.entries(values).filter(([, pluginValues]) => Object.keys(pluginValues).length > 0),
    );
  return {
    version: PLUGIN_SECRETS_FILE_VERSION,
    user: pruneValues(file.user),
    workspaces: Object.fromEntries(
      Object.entries(file.workspaces)
        .map(([root, values]) => [root, pruneValues(values)] as const)
        .filter(([, values]) => Object.keys(values).length > 0),
    ),
  };
}

async function readPluginSecretsFileForWrite(
  path: string,
): Promise<{ file: PluginSecretsFile; corrupt: boolean }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { file: createEmptyPluginSecretsFile(), corrupt: false };
    }
    throw error;
  }
  const parsed = parsePluginSecretsFile(raw);
  if (parsed) return { file: parsed, corrupt: false };
  backupCorruptPluginSecretsFileSync(path);
  return { file: createEmptyPluginSecretsFile(), corrupt: true };
}

/**
 * 同步备份损坏的私有文件：读取路径是同步的，备份也必须同步，否则「读不出」与「留证据」
 * 会分裂成两套实现。命名与 @zcode/shared/node 的 backupCorruptFile 一致（内容哈希 + 排他
 * 创建 + 0600），保证同一份损坏内容只落一份证据。
 */
function backupCorruptPluginSecretsFileSync(filePath: string): void {
  try {
    const content = readFileSync(filePath);
    const contentId = createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, CORRUPT_BACKUP_CONTENT_ID_LENGTH);
    const backupPath = `${filePath}${CORRUPT_BACKUP_MARKER}${contentId}${CORRUPT_BACKUP_SUFFIX}`;
    try {
      writeFileSync(backupPath, content, { flag: EXCLUSIVE_CREATE_FLAG, mode: PRIVATE_FILE_MODE });
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") throw error;
    }
    chmodSync(backupPath, PRIVATE_FILE_MODE);
  } catch {
    // 备份失败不改变读取语义：原文件仍在，下一次写入前会再备份一次。
  }
}

function parsePluginSecretsFile(raw: string): PluginSecretsFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = pluginSecretsFileSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
