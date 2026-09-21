import assert from "node:assert/strict";
import test from "node:test";
import {
  parseModelCatalogResponse,
  resolveModelCatalogHeaders,
  resolveModelCatalogUrl,
} from "@zcode/shared";

/**
 * 模型拉取的端点推导与响应解析回归测试。
 *
 * 这两件事是纯函数，放在 @zcode/shared；真正发请求在 Host 侧。
 * 端点规则必须与执行链（apps/zcode-cli 的 normalizeAnthropicBaseURL 等）保持一致，
 * 否则会出现"模型能调用但列表拉不到"的不一致。
 *
 * 运行：cd packages/services && node --import tsx --test test/modelCatalog.test.ts
 */

test("openai-chat-completions：baseUrl + /models", () => {
  const cases: Array<[string, string]> = [
    // 内置模板里的真实地址。
    ["https://api.z.ai/api/paas/v4", "https://api.z.ai/api/paas/v4/models"],
    ["https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4/models"],
    [
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    ],
    ["https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/go/v1/models"],
    ["https://api.openai.com/v1", "https://api.openai.com/v1/models"],
    // 本地推理服务（Ollama / vLLM）常不带 /v1。
    ["http://127.0.0.1:11434", "http://127.0.0.1:11434/models"],
    ["http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1/models"],
    // 尾部斜杠不能产生双斜杠。
    ["https://host/v1/", "https://host/v1/models"],
  ];
  for (const [baseUrl, expected] of cases) {
    assert.equal(
      resolveModelCatalogUrl({ baseUrl, apiFormat: "openai-chat-completions" }),
      expected,
      baseUrl,
    );
  }
});

test("openai-responses：保留 /v1，追加 /models", () => {
  const cases: Array<[string, string]> = [
    ["https://api.openai.com/v1", "https://api.openai.com/v1/models"],
    ["https://api.x.ai/v1", "https://api.x.ai/v1/models"],
    ["https://opencode.ai/zen/v1", "https://opencode.ai/zen/v1/models"],
    ["https://opencode.ai/zen/go/v1", "https://opencode.ai/zen/go/v1/models"],
  ];
  for (const [baseUrl, expected] of cases) {
    assert.equal(
      resolveModelCatalogUrl({ baseUrl, apiFormat: "openai-responses" }),
      expected,
      baseUrl,
    );
  }
});

test("anthropic-messages：/v1 结尾直接用，否则补 /v1", () => {
  const cases: Array<[string, string]> = [
    // 官方 Anthropic：baseUrl 已带 /v1。
    ["https://api.anthropic.com/v1", "https://api.anthropic.com/v1/models"],
    // 兼容网关：baseUrl 不带 /v1（SDK 自行追加 /messages），拉取时补 /v1。
    ["https://api.z.ai/api/anthropic", "https://api.z.ai/api/anthropic/v1/models"],
    ["https://open.bigmodel.cn/api/anthropic", "https://open.bigmodel.cn/api/anthropic/v1/models"],
    ["https://api.moonshot.cn/anthropic", "https://api.moonshot.cn/anthropic/v1/models"],
    ["https://api.deepseek.com/anthropic", "https://api.deepseek.com/anthropic/v1/models"],
    ["https://api.minimaxi.com/anthropic", "https://api.minimaxi.com/anthropic/v1/models"],
    [
      "https://dashscope.aliyuncs.com/apps/anthropic",
      "https://dashscope.aliyuncs.com/apps/anthropic/v1/models",
    ],
    ["https://api.xiaomimimo.com/anthropic", "https://api.xiaomimimo.com/anthropic/v1/models"],
    ["https://openrouter.ai/api", "https://openrouter.ai/api/v1/models"],
    ["https://opencode.ai/zen/v1", "https://opencode.ai/zen/v1/models"],
    // 根路径也要补 /v1。
    ["https://api.anthropic.com", "https://api.anthropic.com/v1/models"],
  ];
  for (const [baseUrl, expected] of cases) {
    assert.equal(
      resolveModelCatalogUrl({ baseUrl, apiFormat: "anthropic-messages" }),
      expected,
      baseUrl,
    );
  }
});

test("用户粘贴完整请求地址时先剥离已知后缀", () => {
  const cases: Array<
    [string, "anthropic-messages" | "openai-chat-completions" | "openai-responses", string]
  > = [
    [
      "https://api.anthropic.com/v1/messages",
      "anthropic-messages",
      "https://api.anthropic.com/v1/models",
    ],
    [
      "https://api.anthropic.com/messages",
      "anthropic-messages",
      "https://api.anthropic.com/v1/models",
    ],
    ["https://host/v1/chat/completions", "openai-chat-completions", "https://host/v1/models"],
    ["https://api.openai.com/v1/responses", "openai-responses", "https://api.openai.com/v1/models"],
  ];
  for (const [baseUrl, apiFormat, expected] of cases) {
    assert.equal(resolveModelCatalogUrl({ baseUrl, apiFormat }), expected, baseUrl);
  }
});

test("非法 baseUrl 返回 null，不构造半成品地址", () => {
  for (const baseUrl of ["", "   ", "not a url", "ftp://host/v1", "/relative/path"]) {
    assert.equal(
      resolveModelCatalogUrl({ baseUrl, apiFormat: "openai-chat-completions" }),
      null,
      baseUrl,
    );
  }
});

test("鉴权头：anthropic 用 x-api-key + anthropic-version，并兼容只认 Bearer 的网关", () => {
  assert.deepEqual(
    resolveModelCatalogHeaders({ apiFormat: "anthropic-messages", apiKey: "sk-test" }),
    {
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
      Authorization: "Bearer sk-test",
    },
  );
});

test("鉴权头：OpenAI 两种格式只用 Bearer", () => {
  for (const apiFormat of ["openai-chat-completions", "openai-responses"] as const) {
    assert.deepEqual(resolveModelCatalogHeaders({ apiFormat, apiKey: "sk-test" }), {
      Authorization: "Bearer sk-test",
    });
  }
});

test("鉴权头：用户自定义头最后合并，可以覆盖默认头", () => {
  assert.deepEqual(
    resolveModelCatalogHeaders({
      apiFormat: "openai-chat-completions",
      apiKey: "sk-test",
      headers: { Authorization: "Custom sk", "x-extra": "1" },
    }),
    { Authorization: "Custom sk", "x-extra": "1" },
  );
});

test("鉴权头：没有 Key 时不发空凭据头", () => {
  assert.deepEqual(resolveModelCatalogHeaders({ apiFormat: "openai-chat-completions" }), {});
  assert.deepEqual(
    resolveModelCatalogHeaders({ apiFormat: "anthropic-messages", apiKey: "   " }),
    {},
  );
});

test("响应解析：OpenAI 的 { data: [{ id }] }", () => {
  assert.deepEqual(
    parseModelCatalogResponse({ object: "list", data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
    [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
  );
});

test("响应解析：Anthropic 的 { data: [{ id, display_name }] }", () => {
  assert.deepEqual(
    parseModelCatalogResponse({
      data: [{ id: "claude-sonnet-4", display_name: "Claude Sonnet 4" }],
    }),
    [{ id: "claude-sonnet-4", displayName: "Claude Sonnet 4" }],
  );
});

test("响应解析：{ models: [{ name }] }（Ollama 等）", () => {
  assert.deepEqual(parseModelCatalogResponse({ models: [{ name: "llama3:8b" }] }), [
    { id: "llama3:8b" },
  ]);
});

test("响应解析：裸数组", () => {
  assert.deepEqual(parseModelCatalogResponse(["model-a", "model-b"]), [
    { id: "model-a" },
    { id: "model-b" },
  ]);
});

test("响应解析：去重、去空白、忽略空条目", () => {
  assert.deepEqual(
    parseModelCatalogResponse({
      data: [{ id: "dup" }, { id: "dup" }, { id: "  spaced  " }, { id: "   " }, {}, 42],
    }),
    [{ id: "dup" }, { id: "spaced" }],
  );
});

test("响应解析：异常输入返回空数组而不是抛错", () => {
  for (const input of [null, undefined, {}, { data: "nope" }, { data: [] }, 42, "text"]) {
    assert.deepEqual(parseModelCatalogResponse(input), [], JSON.stringify(input));
  }
});

test("响应解析：created / created_at 归一化为毫秒时间戳", () => {
  const [entry] = parseModelCatalogResponse({
    data: [
      { id: "m", created: 1_700_000_000 },
      { id: "n", created_at: "2025-01-02T00:00:00Z" },
    ],
  });
  assert.equal(entry?.createdAt, 1_700_000_000);
  const second = parseModelCatalogResponse({
    data: [{ id: "n", created_at: "2025-01-02T00:00:00Z" }],
  })[0];
  assert.equal(second?.createdAt, Date.parse("2025-01-02T00:00:00Z"));
});

test("响应解析：未知字段不进入结果，保持返回类型稳定", () => {
  const [entry] = parseModelCatalogResponse({
    data: [{ id: "m", owned_by: "org", object: "model" }],
  });
  assert.deepEqual(Object.keys(entry ?? {}), ["id"]);
});
