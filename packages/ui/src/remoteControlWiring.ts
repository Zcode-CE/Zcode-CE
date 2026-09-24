// 用**相对路径**而不是 `@/` 别名：本模块要保持"任何包都能引"的性质
// （desktop 的真实通道集成测试要直接引它跑映射），而 `@/` 只在 ui 包自己的 tsconfig paths
// 里成立 —— 跨包引用会 ERR_MODULE_NOT_FOUND。类型导入是 `import type`，运行时被擦除，
// 因此不会把 React / 组件链带进只跑 Node 的测试里。
import type { RemoteControlEntryStatus } from "./RemoteControlEntryButton.js";
import {
  canRenderRemoteControlPanel,
  hasUsableRemoteControlLink,
  type RemoteControlConnectionInfo,
  type RemoteControlPanelStatus,
  type RemoteControlStartScope,
} from "./remoteControlPanelModel.js";

/**
 * 远程控制的**接线层**（ce.3 · 切片 4）：把契约 §5 的通道数据映射成入口与面板的 props。
 *
 * 为什么单独一层（而不是在组件里直接读 IPC）：
 * - 切片 1/3 的组件是**纯 props** 的，正是这一点让它们在真浏览器里可验收。接线层保持
 *   同样的性质 —— 它只做**纯函数映射**，订阅动作由调用方（切片 4 的 hook / 平台层）负责，
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
 * 入口状态映射。**入口状态的可达值只由这里决定**。
 *
 * 判据（每条都对应真实状态）：
 * - `running`（含 adopted）⇒ `"running"`：我们的服务在跑。
 * - 其它一切（stopped / 带 staleReason 的陈旧条目 / running-untrusted / failed）⇒ `"off"`：
 *   **我们的**服务没在跑。`running-untrusted` 是"端口上别人的服务"，对用户而言
 *   本机的远控就是没开起来，显示"运行中"会误导。
 *
 * ⚠️ `"waiting"`（等待连接）**今天不产出**：它需要"有没有设备连进来"，而连接面
 * （已连设备清单）按契约 §7 延后到 ce.4 —— `packages/desktop/src/main/web-service/**`
 * 里 0 处 connections，服务端的 `activeConnections` 只是限流用的内部计数、未对外暴露。
 * 因此这里**不猜**：与其按"有链接就当有人连"编一个状态，不如如实只报 off/running。
 * ce.4 落地连接面后，本函数加一条分支即可（届时 `waiting` 才第一次可达）。
 */
export function resolveRemoteControlEntryStatus(
  status: RemoteControlPanelStatus,
): RemoteControlEntryStatus {
  return status.state === "running" ? "running" : "off";
}

/**
 * 运行时校验 `webService:connectionInfo` 的载荷。
 *
 * 为什么必须校验：渲染进程拿到的是**跨进程**数据，形状由主进程保证但不受本包类型约束。
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
  // 空白链接与"没有链接"同等对待（qrcode 会把纯空白编成一张**看起来正常**的码）。
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
    lanExposureConfirmed: boolean;
  } | null;
}

/**
 * 把"通道数据 + 能力事实"折叠成入口与面板的 props。**渲染与否的唯一判据点**。
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
  return {
    renderable: true,
    entry: { status: resolveRemoteControlEntryStatus(input.status) },
    panel: {
      status: input.status,
      connection,
      lanExposureConfirmed: input.lanExposureConfirmed === true,
    },
  };
}
