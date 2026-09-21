import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ModelConfig, ProviderApiConfig, ProviderConfig } from "@zcode/provider";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { setDataBaseDir } from "../src/paths.js";

/**
 * 「删除内置模型 = 隐藏」的持久化语义回归测试。
 *
 * 内置模型来自 config/provider/zcode-builtin.json 模板，真删会在下一次模板加载时被重新注入，
 * 因此删除必须记入个人层的 hiddenModelIds，并由 Resolver 过滤。这里锁死：
 *   1. 删除内置模型只写个人层，不改写内置模板；
 *   2. 个人配置重新加载（等价重启 / 模板 revision 变化）后隐藏集仍在；
 *   3. 恢复后隐藏记录消失，重复恢复报错；
 *   4. 个人模型删除仍是真实移除，不留下隐藏记录；
 *   5. 普通 Provider 草稿保存不会清掉隐藏集（否则改个 API Key 就把隐藏的模型全放回来）。
 *
 * 运行：cd packages/services && node --import tsx --test test/providerModelHidden.test.ts
 */

const BUILTIN_PATH = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);
/** 模板里的真实内置 Provider（账号 Provider 由内置 providerRules 直接声明）。 */
const BUILTIN_PROVIDER_ID = "account:zai-individual-coding-plan";
const HIDDEN_MODEL_ID = "GLM-5.3";
/** 带 builtinModelIds 的模板，用来覆盖"模板实例"这条路径。 */
const TEMPLATE_ID = "zai-api";

async function createRuntime(personalFilePath: string) {
  const runtime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: BUILTIN_PATH,
    personalFilePath,
    personalPollingIntervalMs: false,
    watch: false,
    readLegacyProviders: async () => [],
  });
  await runtime.start();
  return runtime;
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-provider-hidden-"));
  setDataBaseDir(dir);
  const personalFilePath = join(dir, "provider-config.json");
  const runtime = await createRuntime(personalFilePath);
  return {
    runtime,
    personalFilePath,
    /** 重新建 runtime 读同一份文件，等价于"重启后读回"。 */
    reload: () => createRuntime(personalFilePath),
    async dispose() {
      runtime.dispose();
      setDataBaseDir(null);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function readPersistedHiddenModelIds(persisted: unknown, providerId: string): unknown {
  const rules = (
    persisted as {
      config: {
        providerConfigRules: {
          providerRules: Array<{ providerId: string; config: { hiddenModelIds?: unknown } }>;
        };
      };
    }
  ).config.providerConfigRules.providerRules;
  return rules.find((candidate) => candidate.providerId === providerId)?.config.hiddenModelIds;
}

test("删除内置模型只写个人层 hiddenModelIds，不改写内置模板", async () => {
  const fixture = await setup();
  try {
    const configService = fixture.runtime.configService;
    const before = await configService.read();
    const builtinModels =
      before.zcodeBuiltinProviders.get(BUILTIN_PROVIDER_ID)?.builtinModelIds ?? [];
    assert.ok(builtinModels.includes(HIDDEN_MODEL_ID), "前置条件：模板应包含待删除的内置模型");

    await configService.deletePersonalModel(BUILTIN_PROVIDER_ID, HIDDEN_MODEL_ID);
    const after = await configService.read();

    assert.deepEqual(
      after.zcodeBuiltinProviders.get(BUILTIN_PROVIDER_ID)?.builtinModelIds,
      before.zcodeBuiltinProviders.get(BUILTIN_PROVIDER_ID)?.builtinModelIds,
      "内置模板名单不得被删除操作改写",
    );
    assert.deepEqual(after.personalProviders.get(BUILTIN_PROVIDER_ID)?.hiddenModelIds, [
      HIDDEN_MODEL_ID,
    ]);
    assert.equal(
      after.personalProviders.get(BUILTIN_PROVIDER_ID)?.personalModelIds?.includes(HIDDEN_MODEL_ID),
      false,
      "内置模型不应被误写进个人成员名单",
    );
  } finally {
    await fixture.dispose();
  }
});

test("隐藏集落盘：重新加载个人配置后仍然保留", async () => {
  const fixture = await setup();
  try {
    await fixture.runtime.configService.deletePersonalModel(BUILTIN_PROVIDER_ID, HIDDEN_MODEL_ID);
    const persisted = JSON.parse(await readFile(fixture.personalFilePath, "utf8"));
    assert.deepEqual(readPersistedHiddenModelIds(persisted, BUILTIN_PROVIDER_ID), [
      HIDDEN_MODEL_ID,
    ]);

    const reloaded = await fixture.reload();
    try {
      const config = await reloaded.configService.read();
      assert.deepEqual(config.personalProviders.get(BUILTIN_PROVIDER_ID)?.hiddenModelIds, [
        HIDDEN_MODEL_ID,
      ]);
    } finally {
      reloaded.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("恢复被隐藏的模型：隐藏记录清空，重复恢复报错", async () => {
  const fixture = await setup();
  try {
    const configService = fixture.runtime.configService;
    await configService.deletePersonalModel(BUILTIN_PROVIDER_ID, HIDDEN_MODEL_ID);
    await configService.restoreHiddenModel(BUILTIN_PROVIDER_ID, HIDDEN_MODEL_ID);
    const after = await configService.read();
    assert.deepEqual(after.personalProviders.get(BUILTIN_PROVIDER_ID)?.hiddenModelIds, []);

    await assert.rejects(
      configService.restoreHiddenModel(BUILTIN_PROVIDER_ID, HIDDEN_MODEL_ID),
      /未被隐藏/u,
    );
  } finally {
    await fixture.dispose();
  }
});

test("个人模型删除是真实移除，不留下隐藏记录", async () => {
  const fixture = await setup();
  try {
    const configService = fixture.runtime.configService;
    const personalModelId = "custom-personal-model";
    await configService.addPersonalModel(
      BUILTIN_PROVIDER_ID,
      personalModelId,
      new ModelConfig({ enabled: true }),
    );
    await configService.deletePersonalModel(BUILTIN_PROVIDER_ID, personalModelId);
    const provider = (await configService.read()).personalProviders.get(BUILTIN_PROVIDER_ID);
    assert.equal(provider?.personalModelIds?.includes(personalModelId), false);
    // 个人模型删除是真实移除，因此不产生隐藏记录；字段整体缺省（undefined）也算通过。
    assert.notEqual(provider?.hiddenModelIds?.includes(personalModelId), true);
  } finally {
    await fixture.dispose();
  }
});

test("重新添加被隐藏的内置模型会被拒绝并提示恢复", async () => {
  const fixture = await setup();
  try {
    const configService = fixture.runtime.configService;
    await configService.deletePersonalModel(BUILTIN_PROVIDER_ID, HIDDEN_MODEL_ID);
    await assert.rejects(
      configService.addPersonalModel(
        BUILTIN_PROVIDER_ID,
        HIDDEN_MODEL_ID,
        new ModelConfig({ enabled: true }),
      ),
      /已被隐藏/u,
    );
  } finally {
    await fixture.dispose();
  }
});

test("普通 Provider 草稿保存不会清掉隐藏集", async () => {
  const fixture = await setup();
  try {
    const configService = fixture.runtime.configService;
    const created = await configService.createPersonalProvider({ templateId: TEMPLATE_ID });
    const providerId = created.providerId;
    await configService.deletePersonalModel(providerId, HIDDEN_MODEL_ID);

    // 模拟设置页保存 Provider 草稿（例如改了 API Key）。草稿对象里没有 hiddenModelIds，
    // 若保存路径采用 Renderer 回传值，用户的隐藏记录会被静默清空。
    await configService.savePersonalProviderOverlay(
      providerId,
      new ProviderConfig({
        api: new ProviderApiConfig({ type: "anthropic-messages", baseUrl: "https://example.test" }),
      }),
    );
    const provider = (await configService.read()).personalProviders.get(providerId);
    assert.deepEqual(provider?.hiddenModelIds, [HIDDEN_MODEL_ID]);
  } finally {
    await fixture.dispose();
  }
});

test("内置层不解析 hiddenModelIds，隐藏状态无法写进模板", async () => {
  const fixture = await setup();
  try {
    const config = await fixture.runtime.configService.read();
    assert.equal(config.zcodeBuiltinProviders.get(BUILTIN_PROVIDER_ID)?.hiddenModelIds, undefined);
  } finally {
    await fixture.dispose();
  }
});

test("隐藏全部内置模型后配置仍可读回", async () => {
  const fixture = await setup();
  try {
    const configService = fixture.runtime.configService;
    const allBuiltin =
      (await configService.read()).zcodeBuiltinProviders.get(BUILTIN_PROVIDER_ID)
        ?.builtinModelIds ?? [];
    assert.ok(allBuiltin.length > 0, "前置条件：内置 Provider 应有模型");
    for (const modelId of allBuiltin) {
      await configService.deletePersonalModel(BUILTIN_PROVIDER_ID, modelId);
    }
    const reloaded = await fixture.reload();
    try {
      const provider = (await reloaded.configService.read()).personalProviders.get(
        BUILTIN_PROVIDER_ID,
      );
      assert.deepEqual([...(provider?.hiddenModelIds ?? [])].sort(), [...allBuiltin].sort());
    } finally {
      reloaded.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("内置模板 revision 变化后隐藏集保留（应用升级场景）", async () => {
  const fixture = await setup();
  try {
    await fixture.runtime.configService.deletePersonalModel(BUILTIN_PROVIDER_ID, HIDDEN_MODEL_ID);
    // 模拟应用升级：内置模板换了一份（revision 递增），个人配置保持不变。
    // 隐藏集若被模板更新清掉，用户升级后删过的内置模型会全部"复活"。
    const upgradedBuiltinPath = join(dirname(fixture.personalFilePath), "upgraded-builtin.json");
    const builtin = JSON.parse(await readFile(BUILTIN_PATH, "utf8"));
    builtin.revision = (builtin.revision ?? 0) + 1;
    await writeFile(upgradedBuiltinPath, JSON.stringify(builtin));

    const upgraded = createProviderConfigRuntime({
      zcodeBuiltinFilePath: upgradedBuiltinPath,
      personalFilePath: fixture.personalFilePath,
      personalPollingIntervalMs: false,
      watch: false,
      readLegacyProviders: async () => [],
    });
    await upgraded.start();
    try {
      const config = await upgraded.configService.read();
      // revision 是内容摘要（形如 zcode-builtin:<模板 revision>:<hash>），
      // 断言它确实换成了新模板，而不是沿用旧的那份。
      assert.match(config.zcodeBuiltinRevision, new RegExp(`:${builtin.revision}:`));
      assert.deepEqual(config.personalProviders.get(BUILTIN_PROVIDER_ID)?.hiddenModelIds, [
        HIDDEN_MODEL_ID,
      ]);
    } finally {
      upgraded.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});
