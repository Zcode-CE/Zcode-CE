import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMarketplace,
  ensureMarketplaceManifestAvailable,
  type MarketplaceSource,
} from "../src/plugins/marketplace.js";

/**
 * Marketplace source kind 的白名单：只接受 `MarketplaceSource` 联合里列出的 kind，其余必须在**使用点**
 * 得到可操作的显式错误。
 *
 * 为什么需要这层：`known_marketplaces.json` 是外部状态文件（可被旧版本、其它机器或导入的分享状态写入），
 * `isKnownMarketplaceRecord` 只校验 `source` 是对象，不校验 kind。旧实现在 switch 里落空直接返回
 * `undefined`，调用方随后在 `loaded.manifest` 上抛 "Cannot read properties of undefined"，用户看到的
 * 是内部崩溃而不是「这个来源不支持」。
 *
 * 运行：cd apps/zcode-cli/packages/adapters && mise exec node@24.14.0 -- node --import tsx --test test/pluginMarketplaceSourceKind.test.ts
 */

test("未知 source kind 给出显式错误，而不是在 manifest 上空指针崩溃", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-marketplace-kind-"));
  try {
    const source = { source: "from-shared-state" } as unknown as MarketplaceSource;
    await assert.rejects(addMarketplace({ source, storageRoot }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /Marketplace source kind is invalid or unsupported: from-shared-state/,
      );
      return true;
    });
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("known_marketplaces.json 里读出的未知 kind 记录在被使用时同样给出显式错误", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-marketplace-kind-state-"));
  try {
    await writeFile(
      join(storageRoot, "known_marketplaces.json"),
      JSON.stringify({
        marketplaces: [
          {
            addedAt: new Date().toISOString(),
            id: "shared-market",
            name: "shared-market",
            pluginCount: 1,
            source: { source: "from-shared-state" },
          },
        ],
      }),
      "utf8",
    );

    await assert.rejects(
      ensureMarketplaceManifestAvailable({ marketplace: "shared-market", storageRoot }),
      /Marketplace source kind is invalid or unsupported: from-shared-state/,
    );
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("已知但本运行时未实现的 kind 保持原有明确错误（npm）", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-marketplace-kind-npm-"));
  try {
    await assert.rejects(
      addMarketplace({ source: { package: "demo", source: "npm" }, storageRoot }),
      /Marketplace source is recognized but not supported in this runtime: npm/,
    );
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});
