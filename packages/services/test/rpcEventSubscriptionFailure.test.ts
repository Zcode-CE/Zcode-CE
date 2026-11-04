import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelClient,
  ChannelServer,
  Event,
  createQueuePair,
  type IChannel,
  type IServerChannel,
} from "@zcode/rpc";

/**
 * 事件订阅失败必须回一帧独立的 EventError，而不是把错误对象当成业务事件投递。
 *
 * 回归形态：远端终端已结束时拒绝迟到订阅，listen 的返回函数会抛。旧实现在 ChannelServer
 * 里直接调用 listen(...)(cb)，异常从 protocol.onMessage 的调用栈冒泡，没有上层 catch ——
 * 既没有任何帧回给客户端（监听器永远等不到结果），在真实 Host 里还会让进程退出。
 *
 * 断言口径：错误不进事件流、客户端记录失败、通道/Host 仍可用、正常事件不受影响。
 */

const CHANNEL = "rpc-event-error-test";

type TestChannel = IChannel & {
  call(command: string): Promise<unknown>;
  listen<T>(event: string): Event<T>;
};

function createHarness(): { client: ChannelClient; server: ChannelServer } {
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "server");
  const channel: IServerChannel<string> = {
    async call(_ctx, command) {
      if (command === "ping") return "pong";
      throw new Error(`unknown command: ${command}`);
    },
    listen<T>(_ctx: string, event: string): Event<T> {
      // 与 terminalService 的迟到订阅同形：订阅函数建立时抛，而不是 dispatch 时。
      if (event === "late")
        return () => {
          throw new Error("Terminal session already exited");
        };
      if (event === "tick")
        return (listener) => {
          listener(1 as never);
          listener(2 as never);
          return { dispose() {} };
        };
      return () => ({ dispose() {} });
    },
  };
  server.registerChannel(CHANNEL, channel);
  const client = new ChannelClient(clientProtocol);
  return { client, server };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

test("迟到订阅被拒绝：错误不进事件流，通道与后续事件仍可用", async () => {
  const { client } = createHarness();
  await Event.toPromise(client.onDidInitialize);

  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const channel = client.getChannel(CHANNEL) as TestChannel;
    const received: unknown[] = [];
    const subscription = channel.listen("late")((value) => received.push(value));
    await flush();
    subscription.dispose();

    assert.deepEqual(received, [], "订阅失败不得把错误对象当作业务事件投递");
    assert.equal(logged.length, 1, "客户端必须记录一次订阅失败");
    assert.match(String(logged[0]?.[0]), /RPC event subscription failed: .*late/);

    // Host 侧没有被异常打断：同一通道上的普通调用仍然可用。
    const reply = await channel.call("ping");
    assert.equal(reply, "pong");

    // 正常事件不受影响。
    const ticks: unknown[] = [];
    const okSubscription = channel.listen("tick")((value) => ticks.push(value));
    await flush();
    okSubscription.dispose();
    assert.deepEqual(ticks, [1, 2]);
  } finally {
    console.error = originalError;
    client.dispose();
  }
});
