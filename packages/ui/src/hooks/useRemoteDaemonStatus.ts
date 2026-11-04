import { useEffect } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useRemoteDaemonStatusStore } from "@/store/remoteDaemonStatusStore.js";

/**
 * 订阅宿主推送的 daemon 连接状态。
 *
 * 链路：window Host（状态机）→ parentPort → main → ipc → preload → desktopPlatform → 这里。
 * 平台不支持时（Web）什么都不做：横幅自然不出现，而不是猜一个假状态。
 */
export function useRemoteDaemonStatus(): void {
  const platform = usePlatform();
  const setState = useRemoteDaemonStatusStore((store) => store.setState);
  useEffect(() => {
    if (!platform.onRemoteDaemonStatusChanged) return;
    return platform.onRemoteDaemonStatusChanged((event) => {
      setState(event.state);
    });
  }, [platform, setState]);
}
