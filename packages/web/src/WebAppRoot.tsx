import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectViaWebSocket } from "@zcode/client";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import type { IPlatformService } from "@zcode/shared";
import { ConnectionStatusOverlay } from "./ConnectionStatusOverlay.js";
import { createConnectionSupervisor, type ConnectionPhase } from "./connectionRecovery.js";

/** 一次成功连接得到的服务集（由 client 包的连接函数决定，避免为取类型而多引一个包）。 */
type WebServices = Awaited<ReturnType<typeof connectViaWebSocket>>;

export interface WebAppRootBootstrap {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialTaskId?: string;
  restoreSession?: boolean;
  allowOpenWorkspace?: boolean;
}

/**
 * 网页端的运行期外壳：负责「连接 + 断线自愈 + 应用挂载」。
 *
 * 与 task-16 之前的差别：那时入口在 `connectViaWebSocket` 之后一次性挂载 `Root`，断线回调是空的，
 * 于是断线等于假死。现在由 supervisor 持有连接：断开 → 显示覆盖层 + 退避重连；重连成功 →
 * 用**新的 services** 重新挂载应用（`key={generation}`），应用自身按 `web-remote-replayable`
 * 语义重新拉快照（快照/etag 恢复在 packages/ui 里已存在）。
 *
 * 明确不承诺：恢复到断线前那个**任务**（应用的 store 由 `StoreProvider` 每次挂载时创建，
 * 见 packages/ui/src/store/StoreProvider.tsx，跨重新挂载读不回来）。见 docs/development/web-remote-control.md §4。
 */
export function WebAppRoot({
  bootstrap,
  platform,
}: {
  bootstrap: WebAppRootBootstrap;
  platform: IPlatformService;
}) {
  const [session, setSession] = useState<{ services: WebServices; generation: number } | null>(
    null,
  );
  const [connection, setConnection] = useState<{ phase: ConnectionPhase; attempt: number }>({
    phase: "connecting",
    attempt: 0,
  });
  const generationRef = useRef(0);
  /** supervisor 在 connect 回调里需要引用自身（断线事件从 socket 侧回来），用 ref 打破循环。 */
  const supervisorRef = useRef<ReturnType<typeof createConnectionSupervisor<WebServices>> | null>(
    null,
  );

  const supervisor = useMemo(() => {
    const created = createConnectionSupervisor<WebServices>({
      connect: () =>
        connectViaWebSocket(bootstrap.wsUrl, {
          onClose: () => supervisorRef.current?.notifyClosed(),
        }),
      onSession: (services) => {
        generationRef.current += 1;
        setSession({ services, generation: generationRef.current });
      },
      onPhase: (phase, info) => setConnection({ phase, attempt: info.attempt }),
    });
    supervisorRef.current = created;
    return created;
  }, [bootstrap.wsUrl]);

  useEffect(() => {
    supervisor.start();
    return () => supervisor.stop();
  }, [supervisor]);

  const retry = useCallback(() => supervisor.retryNow(), [supervisor]);

  return (
    <>
      <ConnectionStatusOverlay
        phase={connection.phase}
        attempt={connection.attempt}
        onRetry={retry}
      />
      {session ? (
        <AppErrorBoundary key={session.generation}>
          <ZCodeIntlProvider
            settingService={session.services.settingService}
            broadcastService={session.services.broadcastService}
          >
            <Root
              key={session.generation}
              services={session.services}
              platform={platform}
              initialWorkspaceAbsPath={bootstrap.initialWorkspaceAbsPath}
              initialWorkspaceIdentity={bootstrap.initialWorkspaceIdentity}
              initialTaskId={bootstrap.initialTaskId}
              restoreSession={bootstrap.restoreSession}
              allowOpenWorkspace={bootstrap.allowOpenWorkspace}
              preferDirectoryBrowser
              supportsEmbeddedBrowser={false}
              allowRemoteWorkspace={false}
            />
          </ZCodeIntlProvider>
        </AppErrorBoundary>
      ) : null}
    </>
  );
}
