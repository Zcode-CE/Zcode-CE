import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
// 两个 locale 文件都是 default 导出（与 IntlProvider 的加载方式一致）。
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";

/**
 * 模型列表改造的 UI 接线回归。
 *
 * 这些是**渲染路径上的接线约束**，不是纯逻辑：漏掉任何一处都会表现为
 * 「按钮在但点了没反应」「对话框里的文案是 key 原文」这类只在运行时暴露的问题。
 * 用源码断言锁死，比拉一个完整 React 渲染树便宜得多，也比只看类型可靠。
 *
 * 运行：cd packages/ui && node --import tsx --test test/modelListDeletion.test.ts
 */

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("模型行的删除按钮对内置模型同样可见", () => {
  const source = readSource("src/settings/model-provider-section/ProviderCardSections.tsx");
  // 过去内置模型传 undefined，按钮不渲染 —— 这就是「预设模型列表无法删除」的 UI 侧根源。
  assert.equal(
    /onDelete=\{!model\.builtin \?/.test(source),
    false,
    "删除按钮不得再按 builtin 分支隐藏",
  );
  assert.match(
    source,
    /onDelete=\{[^}]*onDeleteModel\(model\.modelId\)/,
    "删除按钮必须对所有模型接线",
  );
});

test("删除处理器不再按来源分支（内置模型走同一个写入边界）", () => {
  const source = readSource("src/settings/model-provider-section/InlineEditableProviderCard.tsx");
  assert.equal(
    /if \(!model\.builtin\) \{/.test(source),
    false,
    "删除处理器不得再对内置模型静默 return",
  );
  assert.match(source, /await onDeletePersonalModel\(provider\.providerId, model\.modelId\)/);
});

test("内置模型的重命名保护仍然保留", () => {
  const source = readSource("src/settings/model-provider-section/ProviderFormControls.tsx");
  // 改名会让内置推荐配置的匹配规则失效，产品上明确保留该保护。
  assert.match(source, /modelIdReadOnly=\{model\.builtin\}/);
});

test("隐藏模型恢复入口接在卡片上，且只在有隐藏项时渲染", () => {
  const card = readSource("src/settings/model-provider-section/ProviderCardSections.tsx");
  assert.match(card, /<ProviderHiddenModelsSection/);
  assert.match(card, /hiddenModelIds=\{hiddenModelIds\}/);
  const section = readSource("src/settings/model-provider-section/ProviderHiddenModelsSection.tsx");
  assert.match(section, /if \(hiddenModelIds\.length === 0\) return null;/);
});

test("拉取对话框接在卡片上，并复用既有添加边界", () => {
  const card = readSource("src/settings/model-provider-section/ProviderCardSections.tsx");
  assert.match(card, /<ProviderModelCatalogDialog/);
  assert.match(card, /onAddModels=\{onAddModelsFromCatalog\}/);
  const dialog = readSource("src/settings/model-provider-section/ProviderModelCatalogDialog.tsx");
  // 拉取失败必须留在对话框里可重试，不能静默关闭。
  assert.match(dialog, /modelCatalog\.retry/);
  // 已存在的模型默认不勾选。
  assert.match(dialog, /disabled=\{isExisting\}/);
});

test("批量添加逐个走 addPersonalModel，单个失败不连累其余", () => {
  const card = readSource("src/settings/model-provider-section/InlineEditableProviderCard.tsx");
  const body = card.slice(card.indexOf("handleAddModelsFromCatalog"));
  assert.match(body, /for \(const modelId of modelIds\)/);
  assert.match(body, /failures\.push\(modelId\)/);
});

test("隐藏集从 Settings View 透传到表单 Provider，不依赖 Renderer 重算", () => {
  const projection = readSource("src/lib/providerSettingsFormProjection.ts");
  assert.match(projection, /hiddenModelIds: provider\.hiddenModelIds/);
  const types = readSource("src/lib/providerSettingsFormTypes.ts");
  assert.match(types, /hiddenModelIds: readonly string\[\]/);
});

test("恢复隐藏模型接进 hook 与设置页详情", () => {
  const hook = readSource("src/hooks/useModelProviders.ts");
  assert.match(hook, /restoreHiddenModel/);
  assert.match(hook, /providerSettingsService\.restoreHiddenModel/);
  const section = readSource("src/settings/ModelProviderSection.tsx");
  assert.match(section, /onRestoreHiddenModel=\{restoreHiddenModel\}/);
});

test("新增的界面文案在中英文里都存在（缺 key 会渲染成 key 原文）", () => {
  const keys = [
    "settings.modelProvider.modelCatalog.button",
    "settings.modelProvider.modelCatalog.title",
    "settings.modelProvider.modelCatalog.description",
    "settings.modelProvider.modelCatalog.loading",
    "settings.modelProvider.modelCatalog.retry",
    "settings.modelProvider.modelCatalog.empty",
    "settings.modelProvider.modelCatalog.allExisting",
    "settings.modelProvider.modelCatalog.selectAll",
    "settings.modelProvider.modelCatalog.clearAll",
    "settings.modelProvider.modelCatalog.alreadyExists",
    "settings.modelProvider.modelCatalog.addSelected",
    "settings.modelProvider.modelCatalog.partialFailure",
    "settings.modelProvider.hiddenModels.title",
    "settings.modelProvider.hiddenModels.description",
    "settings.modelProvider.hiddenModels.restore",
  ];
  for (const key of keys) {
    assert.ok(key in zhCN, `zh-CN 缺少文案: ${key}`);
    assert.ok(key in enUS, `en-US 缺少文案: ${key}`);
  }
});

test("占位符文案同时使用 count，避免参数名不匹配导致渲染出字面量", () => {
  assert.match(zhCN["settings.modelProvider.modelCatalog.addSelected"] ?? "", /\{count\}/);
  assert.match(enUS["settings.modelProvider.modelCatalog.addSelected"] ?? "", /\{count\}/);
  assert.match(zhCN["settings.modelProvider.hiddenModels.title"] ?? "", /\{count\}/);
  assert.match(enUS["settings.modelProvider.hiddenModels.title"] ?? "", /\{count\}/);
});
