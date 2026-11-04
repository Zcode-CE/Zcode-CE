import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getSystemFileLocatorEditorId } from "../src/workspace-file-tree/helpers.js";

/**
 * 文件定位（F16 批次 1）：在 Finder / 资源管理器中打开并选中该文件。
 *
 * 回归形态有两个方向：① 没有定位能力的平台也画入口（点了没反应）；
 * ② 有能力的平台只打开目录、不选中文件（等于没实现「定位」）。
 * 这里钉住能力判定与「定位 → 失败回退打开目录」的接线。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(here, relative), "utf8");
const hookSource = read("../src/hooks/useFileContextActions.ts");
const previewSource = read("../src/PreviewPane.tsx");
const rowSource = read("../src/workspace-file-tree/WorkspaceFileTreeRowView.tsx");

function withUserAgent<T>(userAgent: string, run: () => T): T {
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent },
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}

test("定位器 id：macOS → finder，Windows → explorer，其余平台没有统一能力", () => {
  assert.equal(
    withUserAgent("Mozilla/5.0 (Macintosh)", () => getSystemFileLocatorEditorId()),
    "finder",
  );
  assert.equal(
    withUserAgent("Mozilla/5.0 (Windows NT 10.0)", () => getSystemFileLocatorEditorId()),
    "explorer",
  );
  assert.equal(
    withUserAgent("Mozilla/5.0 (X11; Linux x86_64)", () => getSystemFileLocatorEditorId()),
    null,
  );
});

test("hook 复用 openInEditor 的 finder/explorer 分支，失败回退打开目录", () => {
  // 直达：以文件路径调用 openInEditor（main 侧转成 shell.showItemInFolder / UNC + /select）。
  assert.match(
    hookSource,
    /platform\.openInEditor\(locatorId, target\.path, \{\s*pathKind: "file"/u,
  );
  // WSL 用 explorer（UNC），其他平台用系统定位器。
  assert.match(hookSource, /remoteTarget\?\.kind === "wsl" \? "explorer"/u);
  // 没有定位能力或目录目标：回退到既有「打开所在目录」。
  assert.match(hookSource, /if \(!locatorId \|\| target\.kind === "directory"\)/u);
  // 定位失败也回退，并且只在能力允许时动作。
  assert.match(hookSource, /await revealInFileManager\(target\)/u);
  assert.match(hookSource, /if \(!canRevealInFileManager\(target\)\)/u);
});

test("文件树与预览面板都接到直达定位", () => {
  assert.match(rowSource, /fileActions\.revealFileInFileManager\(/u);
  assert.match(previewSource, /fileActions\.revealFileInFileManager\(/u);
  // 预览面板必须传能力与远端信息：否则 canReveal 恒 false，入口永远不出现。
  assert.match(previewSource, /canOpenLocalFileManager: isDesktop/u);
  assert.match(previewSource, /canRevealInFileManager\(\{/u);
});
