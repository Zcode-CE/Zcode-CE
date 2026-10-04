import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES,
  REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS,
} from "../src/remote/zcodeAgentOfficialPluginAssets.js";

/**
 * 远端官方插件合同的自洽性护栏（C34 收尾）。
 *
 * 背景：远端两侧曾自相矛盾——合同注释写「远端不承载 Browser Use / Computer Use」，
 * 而预构建侧每次都 stage browser-use 内容与 node_repl 宿主（注释甚至写「缺它
 * bua/cua 连不上」）。2026-10-04 校准后的准确口径：
 * - 远端随包带 browser-use 正文与宿主，但不承载 bua/cua 的能力（浏览器操作依赖
 *   桌面宿主的 browserControlPort；电脑控制需要 Helper/原生驱动/zcode-cua-plugin 资产，
 *   全部不进远端）；
 * - 合同是下限：只钉 browser-use 内容；宿主与其余内容由 staging 侧完整性清单兜底；
 * - PACKAGE_NAMES 同时驱动开发态远端 staging，加宿主属口径变更（见合同注释）。
 *
 * 本测试把这三条钉成机器判据：任何一侧漂移（合同要求了不在驱动名里的包、staging
 * 漏了合同要求的路径、或 cua 资产悄悄进远端两侧）都会红。
 *
 * 运行：cd packages/server && node --import tsx --test test/remoteOfficialPluginContract.test.ts
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const prebuildsPath = join(repoRoot, "scripts", "prepare-prebuilds.mjs");

test("合同自身自洽：每条必需路径都落在 PACKAGE_NAMES 驱动的包内", () => {
  for (const relativePath of REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
    const packageName = relativePath.split("/")[0];
    assert.ok(
      (REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES as readonly string[]).includes(packageName),
      "合同要求了不在 PACKAGE_NAMES 内的包：" +
        relativePath +
        "（PACKAGE_NAMES 同时是开发态远端 staging 的驱动，不在其中的包不会被拷贝/断言）",
    );
  }
});

test("远端口径不承载电脑控制：zcode-cua-plugin 不在合同里", () => {
  assert.ok(
    !(REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES as readonly string[]).includes("zcode-cua-plugin"),
    "远端插件合同不得包含 zcode-cua-plugin（远端不承载电脑控制：无 Helper、无原生驱动）",
  );
  for (const relativePath of REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
    assert.ok(
      !relativePath.startsWith("zcode-cua-plugin/"),
      "合同不得要求 zcode-cua-plugin 的资产：" + relativePath,
    );
  }
});

test("预构建侧覆盖合同声明的全部 browser-use 资产（下限语义的落地证据）", () => {
  const source = readFileSync(prebuildsPath, "utf8");
  // 合同的 browser-use 路径在预构建侧有两处同源表达：staging 期的运行时校验
  // （browserUseRequiredRuntimePaths，相对插件根的不带前缀路径）与可复用完整性清单
  // （remoteOfficialPluginRequiredPaths，带 packages/ 前缀）。每条合同路径至少出现在一处，
  // 否则合同要求在产物里并不存在（下限变成空谈）。
  for (const relativePath of REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
    const packageName = relativePath.split("/")[0];
    const unprefixed = relativePath.slice(packageName.length + 1);
    assert.ok(
      source.includes(relativePath) || source.includes(unprefixed),
      "预构建侧缺少合同要求的资产（既不在运行时校验也不在完整性清单）：" + relativePath,
    );
  }
  // 下限语义的直接证据：宿主随每次发布 stage（完整性清单含其 manifest），
  // 但合同不要求它（加它属口径变更 + dev 部署要先构建宿主 dist，见合同注释）。
  assert.ok(
    source.includes("packages/node-repl-host/.zcode-plugin/plugin.json"),
    "预构建侧应 stage 并钉住 node-repl 宿主 manifest",
  );
  assert.ok(
    source.includes('requiredRuntimePaths: ["dist/mcp/server.js"]'),
    "预构建侧应钉住宿主的 dist/mcp/server.js（staging 期校验）",
  );
  assert.ok(
    !(REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES as readonly string[]).includes("node-repl-host"),
    "合同（当前口径）不应要求 node-repl-host；口径变化时再按 F3-1 §9.2 第 2 条同改两处",
  );
});

test("远端口径不承载电脑控制（预构建侧）：remoteOfficialPluginPackages 不含 cua 插件", () => {
  const source = readFileSync(prebuildsPath, "utf8");
  const start = source.indexOf("const remoteOfficialPluginPackages = [");
  assert.ok(start >= 0, "prepare-prebuilds.mjs 应有 remoteOfficialPluginPackages 清单");
  const end = source.indexOf("];", start);
  assert.ok(end > start, "remoteOfficialPluginPackages 清单应有结束");
  const stagingList = source.slice(start, end);
  assert.ok(
    !stagingList.includes("zcode-cua-plugin"),
    "远端预构建清单不得包含 zcode-cua-plugin（远端不承载电脑控制）",
  );
  assert.ok(
    stagingList.includes("@zcode/browser-use-plugin"),
    "远端预构建清单应包含 browser-use 插件内容",
  );
  assert.ok(
    stagingList.includes("@zcode/node-repl-host"),
    "远端预构建清单应包含 node_repl 宿主（上游布局，即使能力本身不在远端）",
  );
});
