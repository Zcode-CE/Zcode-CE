import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/**
 * 图片预览「复制图片」的接线护栏（F9 第一片）。
 *
 * 复制必须在用户手势内同步提交 ClipboardItem(Promise)，且加载完成前禁用；
 * 这两点任一被改坏都会变成静默失败（按钮可点、剪贴板没图）。真实剪贴板读取需人工验证，
 * 这里只钉住实现形状与双语键在位。
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../src/previewPaneImageContent.tsx"), "utf8");

test("复制在用户手势内同步创建 ClipboardItem promise", () => {
  assert.match(source, /imageToPngBlob\(image\)/u);
  assert.match(source, /new ClipboardItem\(\{ "image\/png": pngBlobPromise \}\)/u);
  assert.match(source, /navigator\.clipboard\?\.write/u);
});

test("加载完成前与复制中都禁用入口，失败走失败提示", () => {
  assert.match(source, /disabled=\{!imageLoaded \|\| copying\}/u);
  assert.match(source, /preview\.image\.copyFailed/u);
  assert.ok("preview.image.copy" in zhCN);
  assert.ok("preview.image.copy" in enUS);
  assert.ok("preview.image.copySuccess" in zhCN);
  assert.ok("preview.image.copySuccess" in enUS);
});

test("下载保存原始字节：按 MIME 对齐扩展名，成功提示不带路径", () => {
  assert.match(source, /dataUrlBytes\(imageSource\)/u);
  assert.match(source, /IMAGE_EXTENSION_BY_MEDIA_TYPE/u);
  assert.match(source, /platform\.saveFile\(\{ data, suggestedName \}\)/u);
  assert.match(source, /preview\.image\.downloadSuccess/u);
  assert.ok("preview.image.download" in zhCN);
  assert.ok("preview.image.download" in enUS);
});

test("添加到聊天走文件 mention 事件：工作区内相对、工作区外绝对，失败有提示", () => {
  assert.match(source, /dispatchWorkspaceFileAddToChat\(/u);
  assert.match(source, /normalizedPath\.startsWith\(`\$\{normalizedWorkspace\}\/`\)/u);
  assert.match(source, /relativePath,\n      name,/u);
  assert.match(source, /preview\.image\.addToChatFailed/u);
  assert.ok("preview.image.addToChatFailed" in zhCN);
  assert.ok("preview.image.addToChatFailed" in enUS);
});

test("桌面右键菜单与窄屏操作菜单复用同一组动作", () => {
  assert.match(source, /<ContextMenu>/u);
  assert.match(source, /<ContextMenuTrigger asChild>/u);
  assert.match(source, /DropdownMenuTrigger/u);
  assert.match(source, /preview\.image\.actionsMenu/u);
  assert.match(source, /md:hidden/u);
  assert.ok("preview.image.actionsMenu" in zhCN);
  assert.ok("preview.image.actionsMenu" in enUS);
});
