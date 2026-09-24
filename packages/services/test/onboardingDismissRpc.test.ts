import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelClient, ChannelServer, Event, ProxyChannel, createQueuePair } from "@zcode/rpc";
import { IOnboardingRecordService } from "../src/onboarding/onboardingRecord.js";
import { createOnboardingRecordService } from "../src/onboarding/onboardingRecordService.js";
import { setDataBaseDir } from "../src/paths.js";

/**
 * dismissOnboarding 的 RPC 往返（task-108）。
 *
 * 为什么需要这一层：UI 侧新增的调用点走的是通用 RPC 通道
 * （packages/client/src/remoteServiceAccess.ts 用 ProxyChannel.toService 投影
 * IOnboardingRecordService），而本仓库此前 dismissOnboarding 零调用点 ——
 * 也就是说这条通道从未被真实走过一次。服务侧单测直接调本地对象，证明不了
 * "经过 channel 注册 / 序列化后仍然落盘"。
 *
 * 这里用真实的 ChannelServer + ChannelClient（createQueuePair 内存传输，与
 * packages/rpc/examples/02-proxy-channel.ts 同形），断言：无参的 dismissOnboarding
 * 在通道上可调用（注册名与 ProxyChannel 约定一致），且调用后决策确实落盘、
 * 重启后 shouldOnboard 为 false。
 *
 * 运行：cd packages/services && node --import tsx --test test/onboardingDismissRpc.test.ts
 */

const USER = "u1";

test("dismissOnboarding 经 RPC 通道调用后，重启判定为不再引导", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-onboarding-rpc-"));
  setDataBaseDir(dir);
  let server: ChannelServer | null = null;
  let client: ChannelClient | null = null;
  try {
    const service = createOnboardingRecordService({
      loadUserId: async () => USER,
      hasExistingLocalTask: async () => false,
    });
    // createQueuePair 是仓库既有示例（packages/rpc/examples/02-proxy-channel.ts）用的内存传输。
    const [protocolA, protocolB] = createQueuePair();
    server = new ChannelServer(protocolB, "server");
    server.registerChannel(IOnboardingRecordService.channelName, ProxyChannel.fromService(service));
    client = new ChannelClient(protocolA);
    await Event.toPromise(client.onDidInitialize);

    // 客户端侧：与 remoteServiceAccess.ts 同一种投影方式。
    const remote = ProxyChannel.toService<typeof service>(
      client.getChannel(IOnboardingRecordService.channelName),
    );

    assert.equal(await remote.shouldOnboard(), true, "全新用户应当引导");
    // 无参调用：deviceMid 由 host 侧服务自己解析，UI 不传（本件选定的契约）。
    await remote.dismissOnboarding();

    // 打到最终消费点：通过同一条通道读回来，且重启后不再引导。
    const records = await remote.getRecords();
    assert.notEqual(records, null, "经 RPC 落盘的记录必须能读回来");
    assert.ok(
      records!.decisions.some((d) => d.userId === USER && d.status === "dismissed"),
      "通道上必须真的落下 dismissed 决策",
    );
    assert.ok(records!.deviceMid.trim().length > 0, "deviceMid 必须非空");

    const restarted = createOnboardingRecordService({
      loadUserId: async () => USER,
      hasExistingLocalTask: async () => false,
    });
    assert.equal(await restarted.shouldOnboard(), false, "经 RPC 关闭后重启不得再弹");
  } finally {
    client?.dispose();
    server?.dispose();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});
