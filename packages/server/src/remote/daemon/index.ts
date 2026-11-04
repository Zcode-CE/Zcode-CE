export type {
  DaemonChannelFactory,
  DaemonCloseEvent,
  DaemonCloseReason,
  DaemonProbeOutcome,
  DaemonReadyStatus,
  DaemonStatusSnapshot,
} from "./types.js";
export {
  classifyDaemonStatus,
  describeDaemonProbeOutcome,
  parseDaemonStatusJson,
  probeDaemonServer,
  resolveDaemonServerCandidates,
  resolveDaemonServerRoot,
  toReadyStatus,
} from "./probe.js";
export type { DaemonStatusClass } from "./probe.js";
export { startRemoteDaemon } from "./start.js";
export {
  checkDaemonAdmission,
  evaluateDaemonAdmission,
  type DaemonAdmission,
  type DaemonServerInfo,
} from "./admission.js";
export {
  DAEMON_HOST_CAPABILITY_TTL_MS,
  requestDaemonHostCapabilityTicket,
  type DaemonHostCapabilityTicket,
} from "./hostCapability.js";
export { openDaemonHostWebSocket, wrapDaemonWebSocket } from "./websocket.js";
export { wrapDaemonChannelAsSocket, type DaemonChannelEndpoint } from "./socket.js";
export {
  connectDaemonRemote,
  DaemonAdmissionError,
  type DaemonConnectOptions,
  type DaemonConnectResult,
} from "./transport.js";
