import { useCallback, useEffect, useMemo, useState } from "react";
import type { WebServiceStatusPayload } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { buildRemoteControlWiring, type RemoteControlWiringResult } from "@/remoteControlWiring.js";
import type { RemoteControlPanelStatus } from "@/remoteControlPanelModel.js";
import { logger } from "@/logger.js";

/**
 * 远程控制的接线 hook（ce.3 · 切片 4）。
 *
 * 职责边界（刻意的）：
 * - **只做订阅与映射**：状态来自 `webService:changed` **广播**（契约 §5：入口据此回显，
 *   **不轮询**），带令牌链接来自 `webService:connectionInfo`（**唯一**携带令牌的通道）。
 * - **能力缺失 ⇒ 不渲染**：平台没提供这套可选方法（Web 客户端）⇒ `renderable: false`，
 *   调用方据此**整块不渲染**入口与面板。
 * - **令牌不进日志**：本文件只记录错误对象与状态字段，绝不打印 `linkWithToken`。
 *
 * 为什么在 mount 时读一次 status：广播只在**结论变化**时推（见 ipc.ts 的指纹判定），
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
  entryStatus: "off" | "running";
  panel: RemoteControlWiringResult["panel"];
  actions: {
    start: (options: { scope: "loopback" | "lan" }) => Promise<void>;
    stop: () => Promise<void>;
  };
  lanExposureConfirmed: boolean;
  confirmLanExposure: () => void;
}

export function useRemoteControlWiring(): RemoteControlWiring {
  const platform = useOptionalPlatform();
  const servicePlane =
    typeof platform?.getWebServiceStatus === "function" &&
    typeof platform?.startWebService === "function" &&
    typeof platform?.stopWebService === "function";

  const [status, setStatus] = useState<RemoteControlPanelStatus>(FALLBACK_STATUS);
  const [connectionInfo, setConnectionInfo] = useState<unknown>(null);
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

    // ① 先读一次现状：广播只在结论**变化**时推，不读一次会一直显示"未开启"。
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

  // 状态进入 running 时拉一次带令牌链接；离开 running 时清掉（避免留下过期凭据）。
  useEffect(() => {
    if (!servicePlane) return;
    if (status.state === "running") {
      void refreshConnectionInfo();
    } else {
      setConnectionInfo(null);
    }
  }, [refreshConnectionInfo, servicePlane, status.state]);

  const start = useCallback(
    async (options: { scope: "loopback" | "lan" }) => {
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
        servicePlane,
        lanExposureConfirmed,
      }),
    [connectionInfo, lanExposureConfirmed, servicePlane, status],
  );

  return {
    renderable: wiring.renderable,
    entryStatus: wiring.entry?.status ?? "off",
    panel: wiring.panel,
    actions: { start, stop },
    lanExposureConfirmed,
    confirmLanExposure,
  };
}
