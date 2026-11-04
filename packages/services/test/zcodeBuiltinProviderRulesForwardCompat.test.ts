import assert from "node:assert/strict";
import test from "node:test";
import { parseZCodeBuiltinProviderConfigRules } from "@zcode/provider";
import { decodeZCodeBuiltinRelease } from "@zcode/provider-node";

/**
 * CDN builtin 配置的前向兼容（真机事故回归）。
 *
 * 事故：官方 CDN 的 revision 43 里 `providerRules[8]`/`[9]` 是 highspeed 卡，
 * `config.access.mode = "highspeed"`；本地 enum 只认识四个 coding plan 模式，于是整份
 * Release 校验失败 ⇒ `provider-settings.refresh` 直接报错，连已知的 8 条规则也拿不到。
 *
 * 判据：新增枚举值属于服务端能力扩展，老客户端必须降级而不是拒绝整份配置。
 * 这里钉住三点：已知规则照常生效 / 未知规则被标记跳过 / 外层结构错误仍然直接失败。
 *
 * 测试放在 services 包：它是已登记进 CI 的包，而 provider 包本身没有测试入口。
 */

/** 形状取自 CDN revision 43 的真实规则（providerRules[0]）。 */
function knownRule(id: string, mode: string) {
  return {
    providerId: id,
    providerName: id,
    config: {
      group: "zai-family",
      builtinModelIds: ["GLM-5.3"],
      access: { type: "zhipu-account", mode, accountType: "zai" },
      api: { type: "anthropic-messages", baseUrl: "https://api.z.ai/api/anthropic" },
      logo: { type: "builtin", key: "zai" },
    },
  };
}

/** 服务端先行上线的新访问模式：mode = "highspeed"，本版本 enum 不认识。 */
function unknownModeRule(id: string) {
  return {
    providerId: id,
    providerName: id,
    config: {
      group: "zai-family",
      builtinModelIds: ["GLM-5.3"],
      visibility: "hidden",
      access: { type: "zhipu-account", mode: "highspeed", accountType: "zai" },
      api: { type: "anthropic-messages", baseUrl: "https://zcode.z.ai/api/v1/highspeed/anthropic" },
      logo: { type: "builtin", key: "zai" },
    },
  };
}

test("未知 access.mode 只跳过该条规则，已知规则照常生效", () => {
  const result = parseZCodeBuiltinProviderConfigRules({
    templateRules: [],
    providerRules: [
      knownRule("account:zai-individual-coding-plan", "individual-coding-plan"),
      knownRule("account:zai-offpeak-idle-plan", "off-peak"),
      unknownModeRule("account:zai-highspeed-card"),
      unknownModeRule("account:bigmodel-highspeed-card"),
    ],
  });
  assert.equal(result.providers.toJSON().length, 2, "两条已知规则必须保留");
  assert.ok(result.providers.has("account:zai-individual-coding-plan"));
  assert.ok(result.providers.has("account:zai-offpeak-idle-plan"));
  assert.equal(result.droppedRules.length, 2, "未知规则被标记而不是丢弃整份");
  assert.deepEqual(result.droppedRules.map((rule) => rule.id).sort(), [
    "account:bigmodel-highspeed-card",
    "account:zai-highspeed-card",
  ]);
  assert.match(result.droppedRules[0]?.reason ?? "", /access\.mode/u, "原因要能定位到字段");
});

test("整份 Release 解码不再因未知 mode 失败（事故原样复现）", () => {
  const release = decodeZCodeBuiltinRelease({
    schemaVersion: 1,
    revision: 43,
    config: {
      providerConfigRules: {
        templateRules: [],
        providerRules: [
          knownRule("account:zai-start-plan", "start-plan"),
          unknownModeRule("account:zai-highspeed-card"),
        ],
      },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });
  assert.equal(release.revision, 43);
  assert.equal(release.config.providers.toJSON().length, 1);
});

test("外层结构错误仍然直接失败（不把畸形配置当可用）", () => {
  assert.throws(
    () => parseZCodeBuiltinProviderConfigRules({ templateRules: [], providerRules: {} }),
    /providerRules/u,
  );
  assert.throws(
    () => parseZCodeBuiltinProviderConfigRules({ providerRules: [] }),
    /templateRules|Required/u,
  );
});

test("重复 providerId 仍然失败（保留规则的唯一性不能被降级绕过）", () => {
  assert.throws(
    () =>
      parseZCodeBuiltinProviderConfigRules({
        templateRules: [],
        providerRules: [
          knownRule("account:zai-offpeak-idle-plan", "off-peak"),
          knownRule("account:zai-offpeak-idle-plan", "off-peak"),
        ],
      }),
    /重复 providerId/u,
  );
});
