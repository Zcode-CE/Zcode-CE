import assert from "node:assert/strict";
import test from "node:test";
import { createWindowRemoteConnectionRegistry } from "../src/host/windowRemoteConnectionRegistry.js";

/**
 * daemon re-attach 的 host 侧一半：把 logical session 的底层连接换成新连接。
 *
 * 断言三件事：
 *   1. session 解析到的 services 变成新的（否则 renderer 仍然打旧连接）；
 *   2. 旧 handle 被 dispose（不泄漏那条已经死掉的连接）；
 *   3. session 不存在时返回 false 并释放新 handle（不能悄悄把新连接留下没人管）。
 */

interface Services {
  tag: string;
}

function createRegistry(connected: { services: Services; dispose: () => void }[]) {
  let seq = 0;
  const registry = createWindowRemoteConnectionRegistry<Services>({
    connect: async () => {
      const slot = connected[seq++];
      if (!slot) throw new Error("unexpected connect call");
      return {
        services: slot.services,
        dispose: slot.dispose,
      };
    },
    // createId 先于 connect 被调用，id 从 1 开始编号（与 seq 分开计数）。
    createId: (() => {
      let id = 0;
      return () => "session-" + ++id;
    })(),
  });
  return registry;
}

const remotedTarget = { kind: "ssh", host: "127.0.0.1", port: 22, username: "u" } as never;
const remoteAssets = {} as never;

test("replaceConnectionHandle：session 解析到新 services，旧 handle 被释放", async () => {
  let oldDisposed = 0;
  const registry = createRegistry([
    { services: { tag: "old" }, dispose: () => (oldDisposed += 1) },
  ]);
  const descriptor = await registry.connect({
    requestId: "req-1",
    target: remotedTarget,
    remoteAssets,
    workspacePath: "/w",
    workspaceIdentity: "/w",
  });
  assert.equal(descriptor.remoteSessionId, "session-1");
  const scope = {
    kind: "remote",
    remoteSessionId: descriptor.remoteSessionId,
    workspacePath: "/w",
    workspaceIdentity: "/w",
  } as never;
  assert.equal(registry.resolveScopedServices(scope).tag, "old");

  let newDisposed = 0;
  const replaced = registry.replaceConnectionHandle(descriptor.remoteSessionId, {
    services: { tag: "new" },
    dispose: () => (newDisposed += 1),
  });
  assert.equal(replaced, true);
  assert.equal(registry.resolveScopedServices(scope).tag, "new", "attachment 必须解析到新连接");
  assert.equal(oldDisposed, 1, "旧连接必须释放，不能换成另一种泄漏");
  assert.equal(newDisposed, 0);
  await registry.dispose();
});

test("replaceConnectionHandle：session 不存在 ⇒ 返回 false 且立刻释放新 handle", async () => {
  const registry = createRegistry([]);
  let newDisposed = 0;
  const replaced = registry.replaceConnectionHandle("missing-session", {
    services: { tag: "new" },
    dispose: () => (newDisposed += 1),
  });
  assert.equal(replaced, false);
  assert.equal(newDisposed, 1, "接不回去时新连接必须立刻释放");
  await registry.dispose();
});
