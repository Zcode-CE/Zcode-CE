import assert from "node:assert/strict";
import test from "node:test";
import { resolveTaskAdditionalDirectories } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

/**
 * X16 消费方补全：调度/机器人/闲时任务经 task service 创建会话时，附加目录必须来自宿主设置。
 *
 * 这里测的是 adapter 的解析规则（键、远端跳过、空列表等价无附加目录）；
 * createSession 的协议载荷由 zcodeAgentService 的 create builder 负责（compat 省略见同处类型）。
 */

function settingServiceWith(additional: Record<string, string[]>) {
  return {
    get: async () => ({
      workspaceAdditionalDirectories: additional,
    }),
  } as unknown as Parameters<typeof resolveTaskAdditionalDirectories>[0];
}

test("按 workspaceIdentity 优先解析附加目录", async () => {
  const directories = await resolveTaskAdditionalDirectories(
    settingServiceWith({ "/work/app": ["/work/lib"] }),
    { workspacePath: "/work/app", workspaceIdentity: "/work/app" },
  );
  assert.deepEqual(directories, ["/work/lib"]);
});

test("无 identity 时按路径解析；空列表等价没有附加目录", async () => {
  const withDirs = await resolveTaskAdditionalDirectories(
    settingServiceWith({ "/work/app": ["/work/lib", "/work/tools"] }),
    { workspacePath: "/work/app" },
  );
  assert.deepEqual(withDirs, ["/work/lib", "/work/tools"]);

  const empty = await resolveTaskAdditionalDirectories(settingServiceWith({ "/work/app": [] }), {
    workspacePath: "/work/app",
  });
  assert.equal(empty, undefined);
});

test("远端会话与缺失 settingService 都不注入", async () => {
  const remote = await resolveTaskAdditionalDirectories(
    settingServiceWith({ "/work/app": ["/work/lib"] }),
    { workspacePath: "/work/app", remoteSessionId: "remote-1" },
  );
  assert.equal(remote, undefined);
  assert.equal(
    await resolveTaskAdditionalDirectories(undefined, { workspacePath: "/work/app" }),
    undefined,
  );
});
