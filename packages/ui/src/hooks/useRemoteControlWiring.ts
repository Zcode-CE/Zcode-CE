import { useCallback, useEffect, useMemo, useState } from "react";
import type { WebServiceStatusPayload } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { buildRemoteControlWiring, type RemoteControlWiringResult } from "@/remoteControlWiring.js";
import {
  resolveRemoteControlConnectionsSource,
  type RemoteControlConnectionsSource,
} from "@/remoteControlConnectionsSource.js";
import type { RemoteControlEntryStatus } from "@/RemoteControlEntryButton.js";
import type { RemoteControlPanelStatus } from "@/remoteControlPanelModel.js";
import { logger } from "@/logger.js";

/**
 * 远程控制的接线 hook（ce.3 · 切片 4）。
 *
 * 职责边界（刻意的）：
 * - 只做订阅与映射：状态来自 `webService:changed` 广播（契约 §5：入口据此回显，
 *   不轮询），带令牌链接来自 `webService:connectionInfo`（唯一携带令牌的通道）。
 * - 能力缺失 ⇒ 不渲染：平台没提供这套可选方法（Web 客户端）⇒ `renderable: false`，
 *   调用方据此整块不渲染入口与面板。
 * - 令牌不进日志：本文件只记录错误对象与状态字段，绝不打印 `linkWithToken`。
 *
 * 为什么在 mount 时读一次 status：广播只在结论变化时推（见 ipc.ts 的指纹判定），
 * 所以打开窗口时若服务已在跑，不主动读一次就会一直显示"未开启"。
 */

const FALLBACK_STATUS: RemoteControlPanelStatus = {
  state: "stopped",
  adopted: false,
  loopback: true,
};

export interface RemoteControlWiring {
  /** false ⇒ 入口与面板都必须整块不渲染。 */
  renderable: boolean;
  /** 入口状态由接线层解析（含 ce.4 的 waiting）；这里不重复声明取值集合。 */
  entryStatus: RemoteControlEntryStatus;
  panel: RemoteControlWiringResult["panel"];
  actions: {
    start: (options: { scope: "loopback" | "lan"; port?: number }) => Promise<void>;
    stop: () => Promise<void>;
  };
  /**
   * 连接面的三个动作（ce.4）。各自可能缺省 —— 缺省即"该能力不存在"，
   * 对应区块整块不渲染（不是渲染成禁用）。见 remoteControlConnectionsSource.ts。
   */
  connections: RemoteControlConnectionsSource;
  lanExposureConfirmed: boolean;
  confirmLanExposure: () => void;
}

export function useRemoteControlWiring(): RemoteControlWiring {
  const platform = useOptionalPlatform();
  // 连接面能力探测只做一次：与 servicePlane 同一纪律（入口、面板、区块共用同一个结论，
  // 各处各判一次会分家）。探测本身是纯函数，见 remoteControlConnectionsSource.ts。
  const connectionsSource = useMemo(
    () => resolveRemoteControlConnectionsSource(platform),
    [platform],
  );
  const servicePlane =
    typeof platform?.getWebServiceStatus === "function" &&
    typeof platform?.startWebService === "function" &&
    typeof platform?.stopWebService === "function";

  const [status, setStatus] = useState<RemoteControlPanelStatus>(FALLBACK_STATUS);
  const [connectionInfo, setConnectionInfo] = useState<unknown>(null);
  // ce.4 连接面：`undefined` = 还没读到（不宣称"没人连着"）。
  // 初值刻意不是空数组 —— 那会在服务刚起来时先显示"暂无设备"，然后跳成"已连 1 台"。
  const [connections, setConnections] = useState<unknown>(undefined);
  const [lanExposureConfirmed, setLanExposureConfirmed] = useState(false);

  const refreshConnectionInfo = useCallback(async () => {
    if (!platform?.getWebServiceConnectionInfo) return;
    try {
      setConnectionInfo(await platform.getWebServiceConnectionInfo());
    } catch (error) {
      // 拿不到链接不是致命错误：面板会显示"链接准备中"，二维码不渲染（不编假入口）。
      logger.warn("[remoteControl] 读取连接信息失败", error);
      setConnectionInfo(null);
    }
  }, [platform]);

  /**
   * 拉一次已连设备（ce.4）。
   *
   * 失败时置 `undefined`（= 读不到）而不是空数组：空数组是一个断言（"确定没人连着"），
   * 会让入口显示「等待连接」—— 那是把一个读取失败说成了服务端事实。
   *
   * 这里不轮询（既有纪律：状态靠 `webService:changed` 广播回显）。取数时机只有三处：
   * 服务进入 running 时、打开面板时、以及每次 revoke 结算之后。
   */
  const refreshConnections = useCallback(async () => {
    const read = connectionsSource.read;
    if (!read) return;
    try {
      setConnections(await read());
    } catch (error) {
      logger.warn("[remoteControl] 读取已连设备失败", error);
      setConnections(undefined);
    }
  }, [connectionsSource]);

  /**
   * 断开设备（spec §6.4 的写动作）。不传动作 ⇒ UI 不渲染断开按钮。
   *
   * 结算后重拉一次清单：断开的真相源在服务端，本地乐观删除会在请求失败时
   * 显示一个已经不存在的设备（"看起来断了其实还在"）。
   */
  const revokeConnection = useCallback(
    async (input: { id: string } | { all: true }) => {
      const revoke = connectionsSource.revoke;
      if (!revoke) return;
      try {
        await revoke(input);
      } catch (error) {
        logger.warn("[remoteControl] 断开设备失败", error);
      } finally {
        await refreshConnections();
      }
    },
    [connectionsSource, refreshConnections],
  );

  /** 令牌轮换（桌面专属）。不传 ⇒ 面板不渲染该入口（spec §6.5 决策④）。 */
  const rotateToken = useCallback(async () => {
    const rotate = connectionsSource.rotateToken;
    if (!rotate) return;
    try {
      await rotate();
    } catch (error) {
      logger.warn("[remoteControl] 轮换令牌失败", error);
    } finally {
      // 轮换会让所有连接失效并换掉链接 ⇒ 两样都要重读，否则面板留着旧凭据。
      await Promise.all([refreshConnectionInfo(), refreshConnections()]);
    }
  }, [connectionsSource, refreshConnectionInfo, refreshConnections]);

  useEffect(() => {
    if (!servicePlane || !platform) return;
    let disposed = false;

    const applyStatus = (next: unknown) => {
      if (disposed || !next || typeof next !== "object") return;
      const candidate = next as RemoteControlPanelStatus;
      setStatus({
        state: candidate.state,
        adopted: candidate.adopted === true,
        loopback: candidate.loopback !== false,
        ...(candidate.host ? { host: candidate.host } : {}),
        ...(candidate.port ? { port: candidate.port } : {}),
        ...(candidate.url ? { url: candidate.url } : {}),
        ...(candidate.startedAt ? { startedAt: candidate.startedAt } : {}),
        ...(candidate.error ? { error: candidate.error } : {}),
        ...(candidate.staleReason ? { staleReason: candidate.staleReason } : {}),
      });
    };

    // ① 先读一次现状：广播只在结论变化时推，不读一次会一直显示"未开启"。
    void platform.getWebServiceStatus?.().then(applyStatus, (error: unknown) => {
      logger.warn("[remoteControl] 读取服务状态失败", error);
    });

    // ② 订阅广播（不轮询）；订阅必须返回 disposer，与既有 preload 写法一致。
    const dispose = platform.onWebServiceChanged?.(applyStatus);

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [platform, servicePlane]);

  // 状态进入 running 时拉一次带令牌链接与已连设备；离开 running 时清掉（避免留下过期凭据）。
  // 连接数同样要清成 undefined（读不到）：服务停了之后"谁连着"没有答案，
  // 留着上一次的清单会让入口继续按旧数据报状态。
  useEffect(() => {
    if (!servicePlane) return;
    if (status.state === "running") {
      void refreshConnectionInfo();
      void refreshConnections();
    } else {
      setConnectionInfo(null);
      setConnections(undefined);
    }
  }, [refreshConnectionInfo, refreshConnections, servicePlane, status.state]);

  const start = useCallback(
    async (options: { scope: "loopback" | "lan"; port?: number }) => {
      if (!platform?.startWebService) return;
      try {
        setStatus(await platform.startWebService(options));
      } catch (error) {
        logger.warn("[remoteControl] 启动失败", error);
      }
    },
    [platform],
  );

  const stop = useCallback(async () => {
    if (!platform?.stopWebService) return;
    try {
      setStatus(await platform.stopWebService());
    } catch (error) {
      logger.warn("[remoteControl] 停止失败", error);
    }
  }, [platform]);

  const confirmLanExposure = useCallback(() => setLanExposureConfirmed(true), []);

  const wiring = useMemo(
    () =>
      buildRemoteControlWiring({
        status,
        connectionInfo,
        connections,
        servicePlane,
        lanExposureConfirmed,
      }),
    [connectionInfo, connections, lanExposureConfirmed, servicePlane, status],
  );

  return {
    renderable: wiring.renderable,
    entryStatus: wiring.entry?.status ?? "off",
    panel: wiring.panel,
    actions: { start, stop },
    connections: {
      // 三个动作各自透传；缺省即"该能力不存在"（对应区块不渲染）。
      // 用条件展开而不是直接赋值 undefined：后者会让 key 仍然存在，
      // 消费侧若按 key 是否存在判定就会误判成"有能力"。
      ...(connectionsSource.read ? { read: connectionsSource.read } : {}),
      ...(connectionsSource.revoke ? { revoke: revokeConnection } : {}),
      ...(connectionsSource.rotateToken ? { rotateToken } : {}),
    },
    lanExposureConfirmed,
    confirmLanExposure,
  };
}
