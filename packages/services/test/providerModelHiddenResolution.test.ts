import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderTemplateMap,
} from "@zcode/provider";

/**
 * 隐藏模型在唯一投影点（Resolver）被过滤的回归测试。
 *
 * 这是「删除内置模型」的核心验收：过滤必须发生在设置视图与执行 Registry 的共同上游，
 * 否则会出现「设置里没了但模型选择器里还能选」。
 *
 * 运行：cd packages/services && node --import tsx --test test/providerModelHiddenResolution.test.ts
 */

const BUILTIN = ["GLM-5.3", "GLM-5.3-Flash", "GLM-5V-Turbo"];

function resolveWith(personal: ProviderConfig) {
  const resolver = new ProviderConfigResolver();
  return resolver.resolve({
    zcodeBuiltinProviders: new ProviderConfigMap([
      ["demo", new ProviderConfig({ group: "zai-family", builtinModelIds: BUILTIN })],
    ]),
    zcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
    personalProviders: new ProviderConfigMap([["demo", personal]]),
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: ModelConfigRules.empty(),
    accountProviders: ProviderConfigMap.empty(),
  });
}

function modelIdsOf(resolution: ReturnType<typeof resolveWith>): string[] {
  return (resolution.resolvedProviders[0]?.models ?? []).map((model) => model.modelId);
}

test("未隐藏时所有内置模型都出现在解析结果里", () => {
  const resolution = resolveWith(new ProviderConfig({ personalModelIds: [] }));
  assert.deepEqual(modelIdsOf(resolution), BUILTIN);
});

test("隐藏一个内置模型后它从解析结果消失，其余保持原顺序", () => {
  const resolution = resolveWith(
    new ProviderConfig({ personalModelIds: [], hiddenModelIds: ["GLM-5.3-Flash"] }),
  );
  assert.deepEqual(modelIdsOf(resolution), ["GLM-5.3", "GLM-5V-Turbo"]);
});

test("隐藏多个内置模型都生效", () => {
  const resolution = resolveWith(
    new ProviderConfig({ personalModelIds: [], hiddenModelIds: ["GLM-5.3", "GLM-5V-Turbo"] }),
  );
  assert.deepEqual(modelIdsOf(resolution), ["GLM-5.3-Flash"]);
});

test("隐藏集里的未知 ID 不影响其他模型", () => {
  const resolution = resolveWith(
    new ProviderConfig({ personalModelIds: [], hiddenModelIds: ["not-a-real-model"] }),
  );
  assert.deepEqual(modelIdsOf(resolution), BUILTIN);
});

test("隐藏集不影响个人模型成员", () => {
  const resolution = resolveWith(
    new ProviderConfig({ personalModelIds: ["my-model"], hiddenModelIds: ["GLM-5.3"] }),
  );
  assert.deepEqual(modelIdsOf(resolution), ["GLM-5.3-Flash", "GLM-5V-Turbo", "my-model"]);
});

test("隐藏模型同时从可执行 Registry 移除（模型选择器不再可选）", () => {
  const resolver = new ProviderConfigResolver();
  const resolution = resolver.resolve({
    zcodeBuiltinProviders: new ProviderConfigMap([
      [
        "demo",
        new ProviderConfig({
          group: "zai-family",
          builtinModelIds: BUILTIN,
          // 完整配置，使模型能进入 Registry；否则会被"配置不完整"提前挡住，
          // 这条断言就退化成了在验证另一件事。
          api: new ProviderApiConfig({
            type: "anthropic-messages",
            baseUrl: "https://example.test",
          }),
          access: new ApiKeyAccessConfig({ apiKey: "test-only-key" }),
        }),
      ],
    ]),
    zcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
    personalProviders: new ProviderConfigMap([
      ["demo", new ProviderConfig({ personalModelIds: [], hiddenModelIds: ["GLM-5.3"] })],
    ]),
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: ModelConfigRules.empty(),
    accountProviders: ProviderConfigMap.empty(),
  });
  const registryModelIds = (resolution.registryProviders[0]?.models ?? []).map(
    (model) => model.modelId,
  );
  assert.equal(registryModelIds.includes("GLM-5.3"), false, "隐藏模型不得进入 Registry");
});

test("空隐藏集与未声明隐藏集行为一致", () => {
  const declared = resolveWith(new ProviderConfig({ personalModelIds: [], hiddenModelIds: [] }));
  const undeclared = resolveWith(new ProviderConfig({ personalModelIds: [] }));
  assert.deepEqual(modelIdsOf(declared), modelIdsOf(undeclared));
});
