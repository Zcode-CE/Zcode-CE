import { z } from "zod";
import { modelConfigDataSchema } from "@zcode/shared/model-config";
import { providerConfigDataSchema, zhipuAccountAccessDataSchema } from "./provider-data-schema.js";
import { ModelConfig, ModelConfigRules } from "./model-config.js";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderTemplate,
  ProviderTemplateMap,
  ZhipuAccountAccessConfig,
} from "./provider-config.js";
import {
  builtinModelConfigRulesSchema,
  personalModelConfigRulesSchema,
  personalProviderConfigRulesSchema,
  providerConfigRuleSchema,
  providerTemplateConfigRuleSchema,
  builtinProviderConfigRuleSchema,
  type ProviderConfigRuleData,
  type ProviderTemplateConfigRuleData,
} from "./rule-data-schema.js";

const accountProviderConfigSchema = providerConfigDataSchema
  .pick({ builtinModelIds: true })
  .extend({
    access: zhipuAccountAccessDataSchema.pick({ type: true, entitled: true }).nullable().optional(),
  });

export function parseProviderConfigMap(input: unknown): ProviderConfigMap {
  return createProviderRules(z.array(providerConfigRuleSchema).parse(input));
}

export function parseZCodeBuiltinProviderConfigMap(input: unknown): ProviderConfigMap {
  return createProviderRules(z.array(builtinProviderConfigRuleSchema).parse(input));
}

export function parseProviderTemplateMap(input: unknown): ProviderTemplateMap {
  return createTemplateRules(z.array(providerTemplateConfigRuleSchema).parse(input));
}

export interface ZCodeBuiltinProviderConfigParseResult {
  providers: ProviderConfigMap;
  providerTemplates: ProviderTemplateMap;
  /**
   * 因单条校验失败被跳过的规则 id（含失败原因），用于诊断与 UI 提示。
   * 空数组表示整份配置都通过。
   */
  droppedRules: readonly {
    readonly kind: "provider" | "template";
    readonly id: string;
    readonly reason: string;
  }[];
}

/**
 * 解析 CDN 下发的 ZCode Built-in Provider 规则。
 *
 * 为什么逐条 safeParse 而不是整份 strict parse：服务端可以先行上线新能力（例如新增
 * access.mode = "highspeed" 的 provider），老客户端不该因此整份刷新失败——那样连已有
 * 的可用配置都拿不到（真机证据：revision 43 的 providerRules[8]/[9] 是 highspeed 卡，
 * 本地 enum 只认识四个 coding plan 模式）。这里保留严格校验（每条仍必须是合法规则），
 * 只把"不认识的那条"跳过并记录，其余规则照常生效。
 *
 * 与上游 conversation-share 的向前兼容口径一致：新增枚举值属于服务端能力扩展，
 * 客户端遇到未知值应降级而不是拒绝整份数据。
 */
export function parseZCodeBuiltinProviderConfigRules(
  input: unknown,
): ZCodeBuiltinProviderConfigParseResult {
  // 外层结构仍然严格：连 providerRules 都不是数组时没有"跳过一条"的语义，直接失败。
  const envelope = z
    .object({ templateRules: z.array(z.unknown()), providerRules: z.array(z.unknown()) })
    .strict()
    .parse(input);
  const droppedRules: { kind: "provider" | "template"; id: string; reason: string }[] = [];

  const providerRules = envelope.providerRules.flatMap((rule) => {
    const parsed = builtinProviderConfigRuleSchema.safeParse(rule);
    if (parsed.success) return [parsed.data];
    droppedRules.push({
      kind: "provider",
      id: readRuleId(rule, "providerId"),
      reason: describeIssues(parsed.error),
    });
    return [];
  });
  const templateRules = envelope.templateRules.flatMap((rule) => {
    const parsed = providerTemplateConfigRuleSchema.safeParse(rule);
    if (parsed.success) return [parsed.data];
    droppedRules.push({
      kind: "template",
      id: readRuleId(rule, "templateId"),
      reason: describeIssues(parsed.error),
    });
    return [];
  });

  // 唯一性只在保留下来的规则上校验：被跳过的规则不会进入运行时，重复它们没有意义。
  for (const [index, rule] of providerRules.entries()) {
    const first = providerRules.findIndex((other) => other.providerId === rule.providerId);
    if (first !== index) {
      throw new Error(`ZCode Built-in Config 重复 providerId: ${rule.providerId}`);
    }
  }
  for (const [index, rule] of templateRules.entries()) {
    const first = templateRules.findIndex((other) => other.templateId === rule.templateId);
    if (first !== index) {
      throw new Error(`ZCode Built-in Config 重复 templateId: ${rule.templateId}`);
    }
  }

  if (droppedRules.length > 0) {
    // 这些规则对应的能力本版本还不认识；保留它们只会让运行时拿到半截配置。
    console.warn(
      "[zcode-builtin] skipped incompatible provider rules:",
      droppedRules.map((rule) => rule.id + " (" + rule.reason + ")").join(", "),
    );
  }

  return {
    providers: createProviderRules(providerRules),
    providerTemplates: createTemplateRules(templateRules),
    droppedRules,
  };
}

function readRuleId(rule: unknown, key: "providerId" | "templateId"): string {
  if (rule && typeof rule === "object" && key in rule) {
    const value = (rule as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "<unknown>";
}

function describeIssues(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid rule";
  const path = issue.path.join(".");
  return path ? path + " (" + issue.code + ")" : issue.code;
}

export function parsePersonalProviderConfigMap(input: unknown): ProviderConfigMap {
  return createProviderRules(personalProviderConfigRulesSchema.parse(input).providerRules);
}

/** Account 运行时事实仍只有成员及权益；不是磁盘配置规则的第二种格式。 */
export function parseAccountProviderConfigMap(input: unknown): ProviderConfigMap {
  const parsed = z.record(z.string().min(1), accountProviderConfigSchema).parse(input);
  return new ProviderConfigMap(
    Object.entries(parsed).map(([providerId, config]) => [
      providerId,
      createProviderConfig(config),
    ]),
  );
}

export function parseProviderConfig(input: unknown): ProviderConfig {
  return createProviderConfig(providerConfigDataSchema.parse(input));
}

export function parseModelConfig(input: unknown): ModelConfig {
  return createModelConfig(modelConfigDataSchema.parse(input));
}

export function parseZCodeBuiltinModelConfigRules(input: unknown): ModelConfigRules {
  const parsed = builtinModelConfigRulesSchema.parse(input);
  return new ModelConfigRules([
    ...parsed.modelRules.map((rule) => ({
      ...rule,
      type: "model" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.modelApiRules.map((rule) => ({
      ...rule,
      type: "model-api" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.providerSiteRules.map((rule) => ({
      ...rule,
      type: "provider-site" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.templateModelRules.map((rule) => ({
      ...rule,
      type: "template-model" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.builtinProviderModelRules.map((rule) => ({
      ...rule,
      type: "provider-model" as const,
      config: createModelConfig(rule.config),
    })),
  ]);
}

export function parsePersonalModelConfigRules(input: unknown): ModelConfigRules {
  const parsed = personalModelConfigRulesSchema.parse(input);
  return new ModelConfigRules([
    ...parsed.providerModelRules.map((rule) => ({
      ...rule,
      type: "provider-model" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.manualProviderModelRules.map((rule) => ({
      ...rule,
      type: "manual-provider-model" as const,
      config: createModelConfig(rule.config),
    })),
  ]);
}

function createProviderRules(rules: readonly ProviderConfigRuleData[]): ProviderConfigMap {
  return new ProviderConfigMap(
    rules.map(({ config, ...rule }) => ({
      ...rule,
      config: createProviderConfig(config),
    })),
  );
}

function createTemplateRules(
  rules: readonly ProviderTemplateConfigRuleData[],
): ProviderTemplateMap {
  return new ProviderTemplateMap(
    rules.map((rule) => [
      rule.templateId,
      new ProviderTemplate({ ...rule, config: createProviderConfig(rule.config) }),
    ]),
  );
}

function createProviderConfig(config: z.infer<typeof providerConfigDataSchema>): ProviderConfig {
  return new ProviderConfig({
    ...config,
    access:
      config.access == null
        ? config.access
        : config.access.type !== "zhipu-account"
          ? new ApiKeyAccessConfig(config.access)
          : new ZhipuAccountAccessConfig(config.access),
    api: config.api == null ? config.api : new ProviderApiConfig(config.api),
  });
}

function createModelConfig(config: z.infer<typeof modelConfigDataSchema>): ModelConfig {
  return ModelConfig.fromData(config);
}
