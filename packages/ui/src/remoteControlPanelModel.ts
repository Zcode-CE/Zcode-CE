/**
 * 远程控制面板的**纯模型**（ce.3 · 切片 3）。
 *
 * 这里只做两件事，都不碰 React、不碰服务、不碰令牌：
 * 1. **props 形状**：镜像后端契约（`.reverse/44-remote-ui/WEB-SERVICE-CONTRACT.md` §5）的
 *    `WebServiceStatus`。UI 侧**自己声明**这份形状而不是从 `packages/desktop` 导入 ——
 *    契约 §5 明确「`packages/ui` 只依赖这五条通道」，导入 desktop 主进程模块会把 Electron 拖进 UI 包。
 * 2. **分支解析**：把状态折叠成「面板该显示哪一档 + 用户此刻能做什么」。
 *    契约 §4 的五条失败分支在这里各有一条**可操作**出口（不是只显示错误码）。
 */

/**
 * 契约 §5 的 `WebServiceState`（镜像主进程 `packages/desktop/src/main/web-service/service.ts`）。
 *
 * **只有真正会被产出的四个取值**（task-83 穷尽核对 `statusFromProbe` 与 `start/stop` 的
 * 所有 return 点）：`start`/`stop` 是同步等到最终态才返回的，IPC 也只在动作之后广播一次，
 * 所以 `starting`/`stopping` **没有任何出口** —— 声明它们就会在每个 `switch` 里留下死分支。
 * 那 15 秒的在途反馈由 {@link RemoteControlPanelInFlight} 在渲染进程本地承载。
 */
export type RemoteControlServiceState = "stopped" | "running" | "running-untrusted" | "failed";

/**
 * 契约 §4 的 `stale` 细分原因。
 *
 * **已由后端如实上抛**（task-83 落定）：`service.ts` 的 `statusFromProbe` 把探活判出的
 * `stale` 折叠成 `state:"stopped" + staleReason`，不再是"丢掉 reason"。
 * 折叠的依据：`stopped` 是"服务没在跑"的唯一取值，`staleReason` 只回答"为什么没在跑"。
 *
 * 两种 `stopped` 因此可区分：`staleReason === undefined` = 从未开启；
 * 有值 = 上一次的服务已不在（状态文件还留着，重新开启会覆盖它）。
 * 区分能力由 `packages/desktop/test/webServiceAdoption.test.ts` 的真实子进程用例钉住。
 */
export type RemoteControlStaleReason = "pid-dead" | "port-closed" | "probe-timeout";

/** 契约 §5 的 `error.code`。 */
export type RemoteControlErrorCode =
  | "spawn-failed"
  | "port-taken"
  | "probe-timeout"
  | "token-unreadable"
  | "non-loopback-without-token";

/** 契约 §5 `WebServiceStatus`（**不含令牌**）。 */
export interface RemoteControlPanelStatus {
  state: RemoteControlServiceState;
  /** true = 接管了已在跑的服务（不是我们起的）。 */
  adopted: boolean;
  /** false ⇒ 面板必须显示「同网段可尝试连接」的安全提示。 */
  loopback: boolean;
  host?: string;
  port?: number;
  url?: string;
  startedAt?: number;
  error?: { code: RemoteControlErrorCode; message: string };
  /**
   * 见 {@link RemoteControlStaleReason}：**仅在 `state === "stopped"` 且是陈旧条目时出现**。
   * 缺省（undefined）= 从未开启过 —— 面板据此区分"未开启"与"上一次的服务已不在"。
   */
  staleReason?: RemoteControlStaleReason;
}

/**
 * 契约 §5 `webService:connectionInfo` 的返回。
 * **带令牌的链接只从 props 来** —— 面板不拼令牌、不读服务、不碰令牌文件。
 */
export interface RemoteControlConnectionInfo {
  url: string;
  linkWithToken: string;
}

/**
 * 能力面（规则②「能力缺失 ⇒ **不渲染**，不是渲染成禁用」）。
 *
 * `servicePlane` = 宿主是否提供 `webService:start|stop` 这条服务面通道。
 * 桌面端主进程提供（切片 4 接线）；**web 客户端不提供** ⇒ 入口与面板都不渲染
 * （spec §3.8 已撤回 web 变体：web 端本身就是网页，不需要面板把远控派发给自己）。
 */
export interface RemoteControlPanelCapability {
  servicePlane: boolean;
}

/** 契约 §5 `webService:start` 的 `scope` 参数。 */
export type RemoteControlStartScope = "loopback" | "lan";

/**
 * 决策①：默认对**本机所在的局域网**开放（并在首次启动前显式确认）。
 *
 * 面板不自己选监听地址/端口 —— 契约 §7 明确「端口与监听范围选择 UI」不在本切片，
 * 这里只把「点开启 = 请求哪种 scope」这件事固定成可断言的常量。
 */
export const DEFAULT_REMOTE_CONTROL_START_SCOPE: RemoteControlStartScope = "lan";

export const REMOTE_CONTROL_PANEL_TEST_ID = "remote-control-panel";
export const REMOTE_CONTROL_PANEL_BADGE_TEST_ID = "remote-control-badge";
export const REMOTE_CONTROL_PANEL_SERVICE_PLANE_TEST_ID = "remote-control-service-plane";
export const REMOTE_CONTROL_PANEL_CONNECTION_TEST_ID = "remote-control-connection";
export const REMOTE_CONTROL_PANEL_LINK_TEST_ID = "remote-control-link";
export const REMOTE_CONTROL_PANEL_QR_TEST_ID = "remote-control-qr";
export const REMOTE_CONTROL_PANEL_COPY_TEST_ID = "remote-control-copy-link";
export const REMOTE_CONTROL_PANEL_SAFETY_TEST_ID = "remote-control-safety";
export const REMOTE_CONTROL_PANEL_START_TEST_ID = "remote-control-start";
export const REMOTE_CONTROL_PANEL_STOP_TEST_ID = "remote-control-stop";
export const REMOTE_CONTROL_PANEL_FAILURE_TEST_ID = "remote-control-failure";
export const REMOTE_CONTROL_FIRST_RUN_CONFIRM_TEST_ID = "remote-control-first-run-confirm";

/**
 * 面板对外的一档显示形态（= 契约 §4 的失败分支）。
 *
 * **不含 `starting`/`stopping`**：这两个取值在实现里从未被产出（task-83 穷尽核对：
 * `service.ts` 的所有 return 点只产出 stopped/running/running-untrusted/failed），
 * 因此为它们写分支就是"永不触发的分支"。
 *
 * 那"点了开启之后那 15 秒"的用户反馈怎么办：由 {@link RemoteControlPanelView.inFlight}
 * 承载 —— 它是**渲染进程自己的**在途标记（点下去到 promise 结算之间），
 * 不是主进程伪造的状态。这样过渡反馈依然存在，而协议里不留死取值。
 */
export type RemoteControlPanelBranch = "stopped" | "stale" | "running" | "untrusted" | "failed";

export type RemoteControlPanelPrimaryAction = "start" | "stop" | "retry" | "none";

/** 在途动作（渲染进程本地状态，不是协议状态）。 */
export type RemoteControlPanelInFlight = "starting" | "stopping" | null;

export interface RemoteControlPanelView {
  branch: RemoteControlPanelBranch;
  /** 状态徽标文案（短语式）。 */
  badgeMessageId: string;
  /** 「用户此刻能做什么」的那一行 —— 每个分支都必须有，不允许只剩错误码。 */
  adviceMessageId: string;
  primaryAction: RemoteControlPanelPrimaryAction;
  primaryActionMessageId: string;
  /** 是否展示连接面（地址 / 链接 / 二维码）。 */
  showConnection: boolean;
  /** 非回环运行 ⇒ 安全提示里额外点明「同网段可尝试连接」。 */
  emphasizeLanExposure: boolean;
  /** 在途动作；由调用方（面板组件）用本地状态传入，缺省 = 空闲。 */
  inFlight: RemoteControlPanelInFlight;
}

const BADGE_BY_BRANCH: Record<RemoteControlPanelBranch, string> = {
  stopped: "remotePanel.badge.stopped",
  stale: "remotePanel.badge.stale",
  running: "remotePanel.badge.running",
  untrusted: "remotePanel.badge.untrusted",
  failed: "remotePanel.badge.failed",
};

/**
 * 在途时徽标改用哪个文案。
 *
 * 这是在**渲染进程**里把"点了开启、还没回来"表达出来（start 最长可等 15s），
 * 而不是让主进程伪造一个 `starting` 状态 —— 后者会成为永不触发的死取值。
 */
const IN_FLIGHT_BADGE: Record<Exclude<RemoteControlPanelInFlight, null>, string> = {
  starting: "remotePanel.badge.starting",
  stopping: "remotePanel.badge.stopping",
};

/** `failed` 分支按 `error.code` 给**可操作**的原因，而不是把错误码丢给用户。 */
const FAILED_ADVICE_BY_CODE: Record<RemoteControlErrorCode, string> = {
  "port-taken": "remotePanel.advice.failed.portTaken",
  "spawn-failed": "remotePanel.advice.failed.spawnFailed",
  "probe-timeout": "remotePanel.advice.failed.probeTimeout",
  "token-unreadable": "remotePanel.advice.failed.tokenUnreadable",
  "non-loopback-without-token": "remotePanel.advice.failed.nonLoopbackWithoutToken",
};

/** `stale` 分支按契约 §4 的 reason 给不同的下一步。 */
const STALE_ADVICE_BY_REASON: Record<RemoteControlStaleReason, string> = {
  "pid-dead": "remotePanel.advice.stale.pidDead",
  "port-closed": "remotePanel.advice.stale.portClosed",
  "probe-timeout": "remotePanel.advice.stale.probeTimeout",
};

/**
 * 在途动作叠加到已解析的视图上（**唯一的叠加点**）。
 *
 * 面板组件不再自己写"如果在途就换文案"的分支：那样文案与判据会分家。
 * `inFlight` 只影响徽标与主操作可用性，**不改分支**（连接面/二维码仍由真实状态决定）。
 */
export function withRemoteControlInFlight(
  view: RemoteControlPanelView,
  inFlight: RemoteControlPanelInFlight,
): RemoteControlPanelView {
  if (!inFlight) return view;
  return {
    ...view,
    inFlight,
    badgeMessageId: IN_FLIGHT_BADGE[inFlight],
    // 在途期间不给可点的主操作：避免连点造成第二次 start/stop（阶段一不做取消）。
    primaryAction: "none",
    primaryActionMessageId: "remotePanel.action.none",
  };
}

/**
 * 把后端状态折叠成面板的一档。**分支判定的唯一所有者**（面板组件不再自己 switch）。
 */
export function resolveRemoteControlPanelView(
  status: RemoteControlPanelStatus,
): RemoteControlPanelView {
  const base = (branch: RemoteControlPanelBranch): RemoteControlPanelView => ({
    branch,
    badgeMessageId: BADGE_BY_BRANCH[branch],
    adviceMessageId: "remotePanel.advice." + branch,
    primaryAction: "none",
    primaryActionMessageId: "remotePanel.action.none",
    showConnection: false,
    emphasizeLanExposure: false,
    inFlight: null,
  });

  switch (status.state) {
    case "stopped": {
      // 契约 §4：`stale`（pid 已死 / 端口已关 / 探活超时）由后端折叠成 stopped；
      // 拿到 reason 时按 stale 档显示，让用户知道「上一次的服务已不在」而不是「从未开过」。
      if (status.staleReason) {
        return {
          ...base("stale"),
          adviceMessageId: STALE_ADVICE_BY_REASON[status.staleReason],
          primaryAction: "start",
          primaryActionMessageId: "remotePanel.action.start",
        };
      }
      return {
        ...base("stopped"),
        primaryAction: "start",
        primaryActionMessageId: "remotePanel.action.start",
      };
    }
    case "running":
      return {
        ...base("running"),
        // 已接管（adopted）与"我们自己起的"都给出地址/链接/二维码；说明文案区分两者。
        adviceMessageId: status.adopted
          ? "remotePanel.advice.running.adopted"
          : "remotePanel.advice.running",
        primaryAction: "stop",
        primaryActionMessageId: "remotePanel.action.stop",
        showConnection: true,
        emphasizeLanExposure: status.loopback === false,
      };
    case "running-untrusted":
      // 契约 §4：端口上有别的服务 ⇒ **不自动换端口启动**，交给用户判断。
      return {
        ...base("untrusted"),
        primaryAction: "start",
        primaryActionMessageId: "remotePanel.action.retryOtherPort",
        emphasizeLanExposure: status.loopback === false,
      };
    case "failed": {
      const code = status.error?.code;
      return {
        ...base("failed"),
        adviceMessageId: code ? FAILED_ADVICE_BY_CODE[code] : "remotePanel.advice.failed",
        primaryAction: "retry",
        primaryActionMessageId: "remotePanel.action.retry",
        emphasizeLanExposure: status.loopback === false,
      };
    }
  }
}

/**
 * 能力门（规则②）：能力缺失 ⇒ **不渲染**。返回 false 时调用方必须整块不渲染
 * （不是渲染成禁用按钮 —— 禁用按钮会承诺一个不存在的动作）。
 */
export function canRenderRemoteControlPanel(capability: RemoteControlPanelCapability): boolean {
  return capability.servicePlane === true;
}

/**
 * 决策①：首次对局域网开放前必须显式确认。
 *
 * 判据只看**本次请求的 scope**（不是当前 status）：回环启动不弹窗；
 * 局域网启动在用户确认过之前必须弹窗，确认过之后不再重复打扰。
 */
export function shouldConfirmBeforeStart(
  scope: RemoteControlStartScope,
  lanExposureConfirmed: boolean,
): boolean {
  return scope === "lan" && !lanExposureConfirmed;
}

/**
 * 「当前有没有可派发的链接」的**唯一所有者**。
 *
 * 为什么必须集中成一个判定：链接行、复制按钮、二维码都依赖它。此前链接行用 `link ?`、
 * 二维码另用一个判定 ⇒ 两个所有者。后果实测过：只改二维码那一处时**一条断言都不变红**，
 * 因为链接行那道守卫仍然兜住，二维码根本走不到那个判断 —— 反向验证成了空转。
 * 空白链接（`"   "`）必须与「没有链接」同等对待：它不可用，且 `qrcode` 能把纯空白编码成
 * 一张**看起来正常**的二维码，那等于给用户一个假入口。
 */
export function hasUsableRemoteControlLink(
  connection: RemoteControlConnectionInfo | null | undefined,
): boolean {
  return Boolean(connection?.linkWithToken?.trim());
}

/** 有带令牌链接时才有二维码；**没有链接就绝不渲染二维码**（避免给出一个空/假入口）。 */
export function shouldRenderQrCode(
  view: RemoteControlPanelView,
  connection: RemoteControlConnectionInfo | null | undefined,
): boolean {
  return view.showConnection === true && hasUsableRemoteControlLink(connection);
}
