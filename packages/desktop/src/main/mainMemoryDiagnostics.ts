import { createMemoryDiagnosticsRegistry, type MemoryDiagnosticsRegistry } from "@zcode/shared";

/**
 * main 进程内存诊断计数器注册表。
 * `index.ts` 在实例化 TaskRealtimeBus / BroadcastHub / BrowserGuestManager 后注册 provider；
 * `mainMemoryDiagnosticsLog.ts` 每 60 秒 collect 一次写主日志。
 */
export const mainMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();
