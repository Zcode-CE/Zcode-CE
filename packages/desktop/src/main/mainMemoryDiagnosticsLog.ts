import {
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  MEMORY_SAMPLE_INTERVAL_MS,
  memoryUsageToSampleFields,
  type MemorySample,
} from "@zcode/shared";
import { mainMemoryDiagnosticsRegistry } from "./mainMemoryDiagnostics.js";

interface MainMemoryDiagnosticsLogger {
  info(...args: unknown[]): void;
}

interface MainMemoryDiagnosticsTimerHandle {
  unref?(): void;
}

export interface StartMainMemoryDiagnosticsLogOptions {
  logger: MainMemoryDiagnosticsLogger;
  readMemoryUsage?: () => NodeJS.MemoryUsage;
  now?: () => number;
  intervalMs?: number;
  timer?: {
    setInterval(callback: () => void, intervalMs: number): MainMemoryDiagnosticsTimerHandle;
    clearInterval(handle: MainMemoryDiagnosticsTimerHandle): void;
  };
}

interface MainMemoryDiagnosticsLog {
  /** 立即采样一次（供测试与手动触发），返回是否写盘。 */
  sampleNow(): boolean;
  stop(): void;
}

/**
 * main 进程自身的内存诊断日志。
 *
 * 遥测移除（P1）前这条链路寄生在 desktopResourceTelemetry.ts 的 10 秒资源采样节拍里
 * （每 6 个 tick ≈ 60 秒读一次 main 内存，同一次读数既写日志又当 ARMS 样本）。
 * ARMS 资源上报整体删除后，本地 `[memory]` 诊断是唯一要保留的能力，因此按 host
 * (hostMemoryDiagnosticsLog) / renderer (ui/lib/memoryDiagnostics) 已有的写法重建：
 * 一个 unref 定时器、一次 process.memoryUsage() 读数、门控通过后写一行主日志。
 * 计数器仍取自 mainMemoryDiagnosticsRegistry，不新增采样口径。
 */
export function startMainMemoryDiagnosticsLog(
  options: StartMainMemoryDiagnosticsLogOptions,
): MainMemoryDiagnosticsLog {
  const readMemoryUsage = options.readMemoryUsage ?? (() => process.memoryUsage());
  const now = options.now ?? (() => Date.now());
  const timer = options.timer ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: MainMemoryDiagnosticsTimerHandle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const gate = createMemorySampleWriteGate();

  const sampleNow = (): boolean => {
    let memoryUsage: NodeJS.MemoryUsage;
    try {
      memoryUsage = readMemoryUsage();
    } catch {
      // 读数失败时没有事实可用，只丢当前样本。
      return false;
    }

    try {
      const sample: MemorySample = {
        role: "main",
        ...memoryUsageToSampleFields(memoryUsage),
        counters: mainMemoryDiagnosticsRegistry.collect(),
      };
      const reason = gate.evaluate(sample, now());
      if (!reason) {
        return false;
      }
      options.logger.info(formatMemorySampleLine(sample, reason));
      return true;
    } catch {
      // 诊断采样失败只丢当前样本，不能影响主进程业务。
      return false;
    }
  };

  let handle: MainMemoryDiagnosticsTimerHandle | undefined = timer.setInterval(
    sampleNow,
    options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS,
  );
  try {
    handle.unref?.();
  } catch {
    // unref 不可用时仍保留 handle 供 stop 回收。
  }

  return {
    sampleNow,
    stop() {
      if (!handle) {
        return;
      }
      const current = handle;
      handle = undefined;
      timer.clearInterval(current);
    },
  };
}
