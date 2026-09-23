import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectViaWebSocket } from "@zcode/client";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import type { IPlatformService } from "@zcode/shared";
import { ConnectionStatusOverlay } from "./ConnectionStatusOverlay.js";
import { createConnectionSupervisor, type ConnectionPhase } from "./connectionRecovery.js";
import { createAuthorizationProbeController } from "./authorizationProbeController.js";
import { classifyServerInfoProbe } from "./authProbe.js";

/**
 * 探测一次 /api/server-info，用来把「服务不回话」与「服务在拒绝我」分开。
 * 只在连接建立不起来时才调用（网络问题/授权问题都可能表现成连不上）。
 */
/**
 * 探测请求的超时上限。没有上限时，一个「黑洞」反代（连接建立但永不回包）会让探测
 * 永远 pending，既拿不到 definitive 答案、也留一个悬挂的 promise。
 */
const AUTHORIZATION_PROBE_TIMEOUT_MS = 5_000;

async function probeServerAuthorization(): Promise<"authorized" | "unauthorized" | "unreachable"> {
  try {
    const response = await fetch("/api/server-info", {
      cache: "no-store",
      signal: AbortSignal.timeout(AUTHORIZATION_PROBE_TIMEOUT_MS),
    });
    return classifyServerInfoProbe({ status: response.status });
  } catch {
    return "unreachable";
  }
}

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
  /** 授权问题（401/403）单独成一个状态：它既不是"断线"也不该被无限重试。 */
  const [unauthorized, setUnauthorized] = useState(false);
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

  /**
   * 连不上时判定是不是授权问题（401/403）。
   *
   * 是授权问题就**停止自动重连**并切到未授权态：401 不会自愈，继续退避重试只会让用户
   * 看到「正在重连（第 N 次）」这种把授权说成网络问题的误导提示（task-21 的缺陷 (a)）。
   * 真·网络问题仍然走重连覆盖层。
   *
   * 关键（task-22 阶段 2 修掉的缺陷）：**每个新的 attempt 都要重新探测**，不能「一个相位
   * 只探一次」—— 断线往往就是服务在重启，那一刻探测只能得到 unreachable；此后不再探测的话，
   * 即使服务已经起来并用 401 拒绝这个浏览器，页面也会永远停在「正在重连…无需刷新」，
   * 用户拿不到那条「怎么拿到带令牌链接」的可照做文案。判定逻辑见 authorizationProbeController。
   */
  const authorizationProbe = useMemo(
    () =>
      createAuthorizationProbeController({
        probe: probeServerAuthorization,
        onUnauthorized: () => {
          supervisor.stop();
          setUnauthorized(true);
        },
      }),
    [supervisor],
  );

  useEffect(() => {
    authorizationProbe.notifyConnectionState(connection.phase, connection.attempt);
  }, [authorizationProbe, connection.attempt, connection.phase]);

  /** 用户点「重试」：先探一次授权；仍未授权就保持未授权态（不再无限重连），否则恢复连接。 */
  const retry = useCallback(() => {
    void (async () => {
      const outcome = await probeServerAuthorization();
      if (outcome === "unauthorized") {
        setUnauthorized(true);
        return;
      }
      setUnauthorized(false);
      // 重新开始授权判定：否则控制器仍处于「已定案」状态，后续断线会跳过探测。
      authorizationProbe.reset();
      supervisor.retryNow();
    })();
  }, [authorizationProbe, supervisor]);

  return (
    <>
      <ConnectionStatusOverlay
        phase={unauthorized ? "unauthorized" : connection.phase}
        attempt={connection.attempt}
        onRetry={retry}
      />
      {/* 未授权时**不渲染任何应用内容**（此时 session 可能是失效 cookie 留下的陈旧连接）：
          授权问题必须显式、且不得继续展示会话内容。见 docs/development/web-remote-control.md。 */}
      {session && !unauthorized ? (
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
