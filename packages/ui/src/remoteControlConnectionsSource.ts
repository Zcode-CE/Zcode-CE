import type { IPlatformService } from "@zcode/shared";

/**
 * 连接面的能力探测与动作出口（ce.4）。
 *
 * 为什么单独一层（而不是在 hook 里直接读 platform）：
 *
 * 1. 能力探测只做一次，入口、面板、各区块共用同一个结论。本仓既有纪律要求
 *    "能力缺失 ⇒ 不渲染"，而那个判据一旦在多处各判一次就会分家
 *    （见 remoteControlPanelModel.ts 的 canRenderRemoteControlPanel）。
 * 2. 三个能力分别探测而不是合成一档：合成一档时缺任意一个都会让整个面板消失，
 *    而分别探测只会让对应区块不出现。前者正是 task-84 §2 记过的、最难查的
 *    "功能不见了却没有报错"形态。
 *
 * 这里用**直接读 IPlatformService 上的可选方法**（而不是结构化探测）：
 * 那三个方法已由 ce.4 的接线单元加进接口，因此方法名写错会**编译失败**而不是
 * 静默变成 undefined —— 后者会退化成"区块不渲染且没有报错"，正是要避免的形态。
 * 运行时仍保留 typeof 检查：接口上它们是可选的，Web 客户端不实现（能力缺失）。
 */

/** 探测结果的形状：三个动作各自可为空（各自门控自己的区块）。 */
export interface RemoteControlConnectionsSource {
  /** 读已连设备。缺省 ⇒ 不渲染设备清单，且入口不产出 waiting。 */
  read?: () => Promise<unknown>;
  /**
   * 断开单个 / 全部。缺省 ⇒ 不渲染断开按钮。
   *
   * 返回 void 而不是载荷：UI 从不使用断开/轮换的返回值（真相源在服务端，
   * 结算后一律重拉清单）。声明成具体载荷会逼每个调用方写一个没意义的类型断言。
   */
  revoke?: (input: { id: string } | { all: true }) => Promise<void>;
  /** 轮换令牌（同上，返回值不使用）。缺省 ⇒ 不渲染轮换入口（桌面专属，spec §6.5 决策④）。 */
  rotateToken?: () => Promise<void>;
}

/**
 * 从平台对象上探测连接面能力。纯函数，不抛错、不改动入参。
 */
export function resolveRemoteControlConnectionsSource(
  platform: IPlatformService | null | undefined,
): RemoteControlConnectionsSource {
  if (!platform) return {};
  const source: RemoteControlConnectionsSource = {};

  const read = platform.getWebServiceConnections;
  if (typeof read === "function") {
    source.read = () => read.call(platform) as Promise<unknown>;
  }
  const revoke = platform.revokeWebServiceConnection;
  if (typeof revoke === "function") {
    source.revoke = async (input) => {
      await revoke.call(platform, input);
    };
  }
  const rotateToken = platform.rotateWebServiceToken;
  if (typeof rotateToken === "function") {
    source.rotateToken = async () => {
      await rotateToken.call(platform);
    };
  }
  return source;
}
