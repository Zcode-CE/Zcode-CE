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

/**
 * 标注编辑（F5）与整卡点击（F14）的接线护栏。
 *
 * 两处都是「看着能用、其实没接」的高危形态：
 * 图片编辑器的「保存到对话」若没有接收方，用户点完只会看到一句提示；
 * 预览卡的整卡点击若没有铺满卡片的透明按钮，卡片主体就永远点不开。
 */

const dialogSource = readFileSync(
  resolve(here, "../src/components/ai-elements/image-preview-dialog.tsx"),
  "utf8",
);
const composerAttachmentsSource = readFileSync(
  resolve(here, "../src/v4/composer/useComposerAttachments.ts"),
  "utf8",
);
const openSplitButtonSource = readFileSync(resolve(here, "../src/OpenSplitButton.tsx"), "utf8");
const previewCardsSource = readFileSync(resolve(here, "../src/AssistantPreviewCards.tsx"), "utf8");

test("预览弹窗把图片视口交给标注编辑器，切图即重建", () => {
  assert.match(dialogSource, /<ImagePreviewSurface/u);
  assert.match(dialogSource, /key=\{`\$\{activeIndex\}:\$\{activeItem\.src\}`\}/u);
  assert.match(dialogSource, /onSaved=\{\(\) => onOpenChange\(false\)\}/u);
  // 标注器的文字框吃方向键：翻页快捷键必须先看输入态与是否已被消费。
  assert.match(dialogSource, /event\.defaultPrevented/u);
});

test("Composer 注册图片接收方，且以附件准入结果为唯一判据", () => {
  assert.match(composerAttachmentsSource, /registerImageComposerTarget\(/u);
  assert.match(
    composerAttachmentsSource,
    /append: \(file\) => addAttachmentFiles\(\[file\]\) === 1/u,
  );
  assert.match(composerAttachmentsSource, /if \(!listenAddToChatEvents \|\| disabled\) return;/u);
});

test("预览卡整卡可点：透明按钮铺满卡片，右侧控件置于其上层", () => {
  // renderCard 契约必须是「控件 + 主按钮动作」两件事，否则整卡点击没有可复用的动作。
  assert.match(openSplitButtonSource, /renderCard\?: \(/u);
  assert.match(openSplitButtonSource, /handlePreview: \(\) => void; canPreview: boolean/u);
  assert.match(
    previewCardsSource,
    /renderCard=\{\(button, \{ handlePreview, canPreview \}\) => \(/u,
  );
  assert.match(previewCardsSource, /className="absolute inset-0 cursor-pointer rounded-xl/u);
  assert.match(previewCardsSource, /<div className="relative z-10 shrink-0">\{button\}<\/div>/u);
  assert.match(previewCardsSource, /chat\.previewCards\.openCard/u);
  assert.ok("chat.previewCards.openCard" in zhCN);
  assert.ok("chat.previewCards.openCard" in enUS);
});

test("图片编辑器 17 条文案双语在位", () => {
  const keys = [
    "imageEditor.tools",
    "imageEditor.select",
    "imageEditor.pen",
    "imageEditor.text",
    "imageEditor.rectangle",
    "imageEditor.ellipse",
    "imageEditor.arrow",
    "imageEditor.eraser",
    "imageEditor.color",
    "imageEditor.undo",
    "imageEditor.redo",
    "imageEditor.save",
    "imageEditor.saving",
    "imageEditor.saveFailed",
    "imageEditor.noComposer",
    "imageEditor.textValue",
    "imageEditor.applyText",
  ];
  for (const key of keys) {
    assert.ok(key in zhCN, "zh-CN 缺少 " + key);
    assert.ok(key in enUS, "en-US 缺少 " + key);
  }
});
