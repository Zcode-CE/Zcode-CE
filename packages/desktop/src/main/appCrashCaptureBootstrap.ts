import { logger } from "./logger.js";
import {
  initializeCrashCapture,
  registerCrashEventMonitor,
  type CrashCapturePaths,
} from "./desktopCrashCapture.js";

// 须在 desktopEarlyDataBaseDirBootstrap 注入 dataBaseDir 之后完成，再配置 crashDumps。
//
// 参数含义：remoteCrashReporterEnabled 表示「是否有远端 SDK 接管 crash 上报」。
// 遥测移除（P1）前这里是 true —— 因为 ARMS SDK 的 crash collector 会扫描 app.getPath("crashDumps")
// 上报并 unlink 原始 dump，本地再起一个 crashReporter 会重复。
// 现在 ARMS 已整体删除，远端上报方不存在，必须改为 **false**：
// 否则 desktopCrashCapture.ts 的 `if (!remoteCrashReporterEnabled && ...)` 永远为假，
// 本地 crashReporter 永不启动，反而削弱本地崩溃留档能力（这是我们要保留的本地能力）。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, false);

// 崩溃事件监听必须注册，否则 `render-process-gone` / `child-process-gone` 触发的事件驱动
// 归档（desktopCrashCapture.scheduleCrashArchive）不会发生，只剩启动时的一次性归档。
//
// 遥测移除（P1）前这个注册在 desktopStabilityTelemetry.ts 里，与 ARMS 上报混在一起：
// 它用同一个 registerCrashEventMonitor 回调既做本地归档、又上报 perf_crash / perf_process_exit。
// ARMS 删除后，本地归档这一半必须保留 —— 所以直接在这里注册裸监听（不带上报 hooks）。
registerCrashEventMonitor(logger, crashCapturePaths);
