// Modified by ZCode: 自上游 zai-org/ZCode v4.0.0 (a4b44451, Apache-2.0) 并入本波安全/稳定性修复（详见 docs/development/upstream-sync.md）。
/**
 * 监听原语的系统边界：一次绑定只依赖「查锚点身份」与「开始监听目录」两件事。
 *
 * 为什么单独抽出来：这两个调用是原语唯一的进程外依赖，而它们在生产里最典型的故障
 * （网盘/网络共享上 stat 挂住、watcher 既不就绪也不报错）无法在真实磁盘上复现。
 * 测试用 `createWatchedEntry(options, deps)` 注入这两个行为来验证截止时间断路器；
 * 生产调用不传第二个参数，使用下面的真实实现。
 */
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { watch } from "chokidar";

/** 原语用到的监听器接口：只声明 all / raw / ready / error 四个事件与 close。 */
export interface WatchHandle {
  on(event: "all", listener: (event: string, path: string) => void): unknown;
  on(event: "raw", listener: (event: string, path: unknown, details?: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  once(event: "ready", listener: () => void): unknown;
  close(): unknown;
}

/** depth 0 的目录监听参数；ignored 由原语按该锚点相关的路径集合给出。 */
export interface WatchOptions {
  depth: number;
  ignoreInitial: boolean;
  usePolling: boolean;
  followSymlinks: boolean;
  ignored(path: string, stats?: Stats): boolean;
}

export interface WatchDependencies {
  stat(path: string): Promise<Stats>;
  watch(path: string, options: WatchOptions): WatchHandle;
}

/** 真实实现：node:fs/promises 的 stat 与 chokidar 的目录监听。 */
export const systemWatchDependencies: WatchDependencies = {
  stat: (path) => stat(path),
  // chokidar 的 FSWatcher 以事件名联合类型声明 on/once，这里按 WatchHandle 收窄；
  // 将来换监听库只需要改这一处。
  watch: (path, options) => watch(path, options) as unknown as WatchHandle,
};
