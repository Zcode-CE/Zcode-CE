// 用相对路径而不是 `@/` 别名：本模块要保持"任何包都能引"的性质
// （desktop 的真实通道集成测试要直接引它跑映射），而 `@/` 只在 ui 包自己的 tsconfig paths
// 里成立 —— 跨包引用会 ERR_MODULE_NOT_FOUND。类型导入是 `import type`，运行时被擦除，
// 因此不会把 React / 组件链带进只跑 Node 的测试里。
import type { RemoteControlEntryStatus } from "./RemoteControlEntryButton.js";
import {
  canRenderRemoteControlPanel,
  hasUsableRemoteControlLink,
  parseRemoteControlConnections,
  type RemoteControlConnectionInfo,
  type RemoteControlConnectionsSnapshotOrUnknown,
  type RemoteControlPanelStatus,
  type RemoteControlStartScope,
} from "./remoteControlPanelModel.js";

/**
 * 远程控制的接线层（ce.3 · 切片 4）：把契约 §5 的通道数据映射成入口与面板的 props。
 *
 * 为什么单独一层（而不是在组件里直接读 IPC）：
 * - 切片 1/3 的组件是纯 props 的，正是这一点让它们在真浏览器里可验收。接线层保持
 *   同样的性质 —— 它只做纯函数映射，订阅动作由调用方（切片 4 的 hook / 平台层）负责，
 *   因此映射本身可以用普通单测钉住，不必起 Electron。
 * - "能力缺失 ⇒ 不渲染"的判据只有一处（{@link canRenderRemoteControlPanel}），
 *   入口与面板共用，避免两处各判一次而分家。
 */

/** 契约 §5 的 `webService:connectionInfo` 返回形状（运行时校验的入口）。 */
export interface RemoteControlConnectionInfoPayload {
  url: string;
  linkWithToken: string;
}

/**
 * 入口状态映射。入口状态的可达值只由这里决定。
 *
 * 判据（每条都对应真实状态）：
 * - `running`（含 adopted）⇒ `"running"`：我们的服务在跑。
 * - 其它一切（stopped / 带 staleReason 的陈旧条目 / running-untrusted / failed）⇒ `"off"`：
 *   我们的服务没在跑。`running-untrusted` 是"端口上别人的服务"，对用户而言
 *   本机的远控就是没开起来，显示"运行中"会误导。
 *
 * - `waiting`（等待连接）⇒ 服务在跑 且 已连设备数为 0。这条在 ce.4 第一次可达：
 *   连接面契约 §6.4 的 `GET /api/remote-control/connections` 返回空数组就是它的产出路径。
 *   读不到连接数（`null`）时不产出 `waiting` —— 见下面第二条判据。
 *
 * 为什么「读不到」不能算成「0 台」：`waiting` 是一个关于「有没有人连着」的断言。
 * 把读不到当 0 台，入口会在一个连不上的服务上宣称「等待连接」；而把 0 台当读不到，
 * `waiting` 就永远不可达（死分支，CE3-CHECKLIST §16 规矩 A 禁止）。
 * 两个事实必须分开表达 —— 连接面载荷的 `null` 与空数组就是这个区分（见 model 的
 * {@link RemoteControlConnectionsSnapshotOrUnknown}）。
 */
export function resolveRemoteControlEntryStatus(
  status: RemoteControlPanelStatus,
  connections?: RemoteControlConnectionsSnapshotOrUnknown,
): RemoteControlEntryStatus {
  // 服务没在跑 ⇒ 一切连接数都无意义（连接面只在 running 时有产出路径）。
  if (status.state !== "running") return "off";
  // 服务在跑，但读不到连接数 ⇒ 不宣称「没人连着」。宁可显示运行中（= 服务已就绪），
  // 也不显示等待连接 —— 后者是一个关于「有没有人连着」的断言，而我们并不知道。
  if (connections == null) return "running";
  // ce.4 的产出路径：服务在跑 且 确定 0 台已连设备 ⇒ 等待连接。
  return connections.connections.length === 0 ? "waiting" : "running";
}

/**
 * 运行时校验 `webService:connectionInfo` 的载荷。
 *
 * 为什么必须校验：渲染进程拿到的是跨进程数据，形状由主进程保证但不受本包类型约束。
 * 不校验而直接 `payload.linkWithToken` 会在载荷异常时把 `undefined` 当链接渲染成二维码
 * （或让 `hasUsableRemoteControlLink` 之外的路径绕过判定）。这里宁可返回 `null`
 * （= 没有可用链接 ⇒ 不渲染二维码），也不把可疑数据当凭据派发出去。
 */
export function parseRemoteControlConnectionInfo(
  payload: unknown,
): RemoteControlConnectionInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Partial<RemoteControlConnectionInfoPayload>;
  if (typeof candidate.url !== "string" || typeof candidate.linkWithToken !== "string") {
    return null;
  }
  // 空白链接与"没有链接"同等对待（qrcode 会把纯空白编成一张看起来正常的码）。
  if (!hasUsableRemoteControlLink({ url: candidate.url, linkWithToken: candidate.linkWithToken })) {
    return null;
  }
  return { url: candidate.url, linkWithToken: candidate.linkWithToken };
}

/** 面板需要的动作出口（由调用方接到平台层）。 */
export interface RemoteControlPanelActions {
  start: (options: { scope: RemoteControlStartScope }) => void | Promise<void>;
  stop: () => void | Promise<void>;
}

export interface RemoteControlWiringInput {
  status: RemoteControlPanelStatus;
  /** 原始载荷（未校验）；校验失败 ⇒ 视为没有可用链接。 */
  connectionInfo: unknown;
  /**
   * 已连设备的原始载荷（未校验，ce.4）。
   * 缺省（`undefined`）与显式 `null` 同义：读不到 ⇒ 不宣称"没人连着"。
   */
  connections?: unknown;
  /** 宿主是否提供服务面通道（桌面端 true；web 客户端 false ⇒ 入口与面板都不渲染）。 */
  servicePlane: boolean;
  lanExposureConfirmed?: boolean;
  onLanExposureConfirmed?: () => void;
  onClose?: () => void;
}

export interface RemoteControlWiringResult {
  /** false ⇒ 入口与面板都必须**整块不渲染**（能力缺失 ⇒ 不渲染，不是禁用）。 */
  renderable: boolean;
  entry: { status: RemoteControlEntryStatus } | null;
  panel: {
    status: RemoteControlPanelStatus;
    connection: RemoteControlConnectionInfo | null;
    /** 已连设备快照；`null` = 读不到（与"空数组 = 暂无设备"严格区分）。 */
    connections: RemoteControlConnectionsSnapshotOrUnknown;
    lanExposureConfirmed: boolean;
  } | null;
}

/**
 * 把"通道数据 + 能力事实"折叠成入口与面板的 props。渲染与否的唯一判据点。
 *
 * 入口与面板共用同一个 `renderable`：能力缺失时两者一起不渲染（spec §3.8 撤回后
 * web 客户端上两者都不该出现），不会出现"入口在、面板打不开"的半接线状态。
 */
export function buildRemoteControlWiring(
  input: RemoteControlWiringInput,
): RemoteControlWiringResult {
  const renderable = canRenderRemoteControlPanel({ servicePlane: input.servicePlane });
  if (!renderable) {
    return { renderable: false, entry: null, panel: null };
  }
  const connection = parseRemoteControlConnectionInfo(input.connectionInfo);
  // 校验在唯一这一处（与 connectionInfo 同纪律）：面板组件不再自己判一次载荷形状。
  // 校验失败 ⇒ null（不知道），不是空数组 —— 后者会凭空造出"确定没人连着"这个事实。
  const connections = parseRemoteControlConnections(input.connections);
  return {
    renderable: true,
    entry: { status: resolveRemoteControlEntryStatus(input.status, connections) },
    panel: {
      status: input.status,
      connection,
      connections,
      lanExposureConfirmed: input.lanExposureConfirmed === true,
    },
  };
}
