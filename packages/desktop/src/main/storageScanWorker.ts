/**
 * 存储扫描 Worker 入口（main 进程内的 worker_threads）。
 * 只负责把 services 的 runStorageScan 跑在独立线程里，并按节流把聚合快照发回主线程；
 * 遍历、分类、聚合逻辑全部来自 @zcode/services（单一扫描路径）。
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { StorageRootSpec } from "@zcode/shared";
import { runStorageScan } from "@zcode/services/node";
import {
  isStorageScanWorkerCommand,
  type StorageScanWorkerData,
  type StorageScanWorkerMessage,
} from "./storageScanWorkerProtocol.js";

const port = parentPort;
if (!isMainThread && port) {
  const data = workerData as StorageScanWorkerData;
  const controller = new AbortController();
  const post = (message: StorageScanWorkerMessage) => port.postMessage(message);
  port.on("message", (message: unknown) => {
    if (isStorageScanWorkerCommand(message) && message.type === "abort") {
      controller.abort();
    }
  });
  void runStorageScan({
    roots: data.roots as StorageRootSpec[],
    signal: controller.signal,
    progressIntervalMs: data.progressIntervalMs,
    onProgress: (progress) => post({ type: "progress", progress }),
  })
    .then((progress) => post({ type: "done", progress }))
    .catch((error: unknown) => {
      const isAbort = error instanceof Error && error.name === "AbortError";
      post({
        type: isAbort ? "aborted" : "error",
        message: error instanceof Error ? error.message : String(error),
        code:
          error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : undefined,
      });
    });
}
