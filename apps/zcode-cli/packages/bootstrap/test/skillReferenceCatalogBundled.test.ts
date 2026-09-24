import assert from "node:assert/strict";
import test from "node:test";
import { getSkillReferenceCatalog } from "../src/zcode-protocol/skill-reference-catalog.js";

/**
 * Composer 的 `$` 引用面板目录：内置技能包（bundled-skills）不得出现在里面（task-98）。
 *
 * 为什么必须锁这一层：bundled 技能由内置命令（/workflow）加载，不是用户管理或引用的对象；
 * 上游 v3.14.3 在 toResult 里加了 `.filter((skill) => skill.source !== "bundled")`，我方原本没有，
 * 而 create-app.ts 确实把 bundled root 注入了 AgentRuntime ⇒ 不滤掉就会在 `$` 面板里列出
 * dynamic-workflows（且因为本地化条目不可达，显示的是英文原文）。
 *
 * 断言打在最终消费点：不是「filter 写对了」，而是协议方法返回给 UI 的那个数组里没有它。
 *
 * 运行：cd apps/zcode-cli/packages/bootstrap && node --import tsx --import ../../../../packages/services/test/support/zcodeSourceResolver.mjs --test test/skillReferenceCatalogBundled.test.ts
 */

const WORKSPACE = { workspacePath: "/tmp", workspaceKey: "/tmp" };

function skill(overrides: Record<string, unknown>) {
  return {
    name: "x",
    description: "d",
    path: "/p/x/SKILL.md",
    directory: "/p/x",
    rootPath: "/p",
    scope: "user",
    source: "agents",
    safeToAutoLoad: true,
    frontmatterKeys: [],
    ...overrides,
  };
}

/** 一个最小可用的协议上下文：只提供 session 路径真正会读到的那两样。 */
function contextWithCatalog(skills: unknown[]) {
  const record = {
    app: {
      getSkillCatalog: async () => ({ skills, diagnostics: [], totalDiscovered: skills.length }),
    },
  };
  return {
    sessions: new Map([["sess_test", record]]),
    deps: {},
    logger: undefined,
  } as never;
}

test("bundled 技能不进引用面板（会话 authority 路径）", async () => {
  const context = contextWithCatalog([
    skill({ name: "dynamic-workflows", source: "bundled", scope: "system" }),
    skill({ name: "docx", source: "plugin", scope: "plugin", pluginName: "documents" }),
    skill({ name: "my-skill", source: "agents", scope: "project" }),
  ]);
  const result = await getSkillReferenceCatalog(context, {
    workspace: WORKSPACE,
    sessionId: "sess_test",
  });

  assert.equal(result.authority, "session");
  assert.deepEqual(
    result.skills.map((s) => s.name),
    ["docx", "my-skill"],
    "bundled 必须被滤掉，其余按原序保留",
  );
});

test("过滤是按 source 判的，不是按名字：同名但非 bundled 的技能要保留", async () => {
  const context = contextWithCatalog([
    skill({
      name: "dynamic-workflows",
      source: "plugin",
      scope: "plugin",
      pluginName: "zcode-guide",
    }),
  ]);
  const result = await getSkillReferenceCatalog(context, {
    workspace: WORKSPACE,
    sessionId: "sess_test",
  });
  assert.deepEqual(
    result.skills.map((s) => s.name),
    ["dynamic-workflows"],
    "名字不是判据——用户自己装的一份仍要可见",
  );
});

test("scope 映射与上游一致：plugin→plugin、project→workspace、其余→user", async () => {
  const context = contextWithCatalog([
    skill({ name: "a", source: "plugin", scope: "plugin" }),
    skill({ name: "b", source: "agents", scope: "project" }),
    skill({ name: "c", source: "agents", scope: "user" }),
  ]);
  const result = await getSkillReferenceCatalog(context, {
    workspace: WORKSPACE,
    sessionId: "sess_test",
  });
  assert.deepEqual(
    result.skills.map((s) => s.scope),
    ["plugin", "workspace", "user"],
  );
});
