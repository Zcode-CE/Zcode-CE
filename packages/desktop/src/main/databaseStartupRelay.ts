import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow, type UtilityProcess } from "electron";
import {
  HostMessageTypes,
  InternalChannels,
  databaseStartupControlSchema,
  type DatabaseStartupState,
} from "@zcode/shared";

let localStorageReady = false;
let quit: (() => void) | undefined;
export function configureDatabaseStartupQuit(handler: () => void): void {
  quit = handler;
}
const readyListeners = new Set<() => void>();
/** Main 只按 Host ready 调度既有 scheduler，不拥有迁移状态或账本。 */
export function onLocalDatabaseStartupReady(listener: () => void): void {
  if (localStorageReady) listener();
  else readyListeners.add(listener);
}

const windowBindings = new WeakMap<BrowserWindow, () => void>();
const hostStartupIds = new WeakMap<UtilityProcess, string>();
export function getDatabaseStartupPortPayload(
  child: UtilityProcess,
): { databaseStartupId: string } | undefined {
  const databaseStartupId = hostStartupIds.get(child);
  return databaseStartupId ? { databaseStartupId } : undefined;
}

export function bindDatabaseStartupRelay(
  win: BrowserWindow,
  child: UtilityProcess,
  startupId = randomUUID(),
) {
  // 同窗口重建 Host 时，旧监听不能继续重放 ready 或接收用户控制命令。
  windowBindings.get(win)?.();
  hostStartupIds.set(child, startupId);
  let disposed = false;
  let latest: DatabaseStartupState | undefined;
  let exited = false;
  const forward = (state: DatabaseStartupState) => {
    if (!disposed && !win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send(InternalChannels.DatabaseStartupState, state);
  };
  const applyState = (state: DatabaseStartupState) => {
    if (latest && state.startupId === latest.startupId && state.sequence <= latest.sequence) return;
    latest = state;
    forward(state);
    // 遥测移除（P1）：这里原有 reportDatabaseStartupState(state)（数据库启动阶段 → ARMS
    // database_startup 自定义事件），随 databaseStartupTelemetry 删除。启动状态转发不受影响。
    if (state.phase === "ready" && !localStorageReady) {
      localStorageReady = true;
      for (const listener of readyListeners) listener();
      readyListeners.clear();
    }
  };
  const receive = (state: DatabaseStartupState) => {
    if (disposed || exited || state.startupId !== startupId) return;
    applyState(state);
  };
  const control = (event: Electron.IpcMainEvent, raw: unknown) => {
    if (disposed || event.sender !== win.webContents) return;
    const result = databaseStartupControlSchema.safeParse(raw);
    if (!result.success) return;
    if (result.data.action === "exit") {
      quit?.();
      return;
    }
    if (result.data.action === "snapshot" && latest) forward(latest);
    if (!exited)
      child.postMessage({ type: HostMessageTypes.DatabaseStartupControl, control: result.data });
  };
  const onExit = () => {
    exited = true;
    hostStartupIds.delete(child);
    if (!latest) {
      const now = Date.now();
      latest = {
        schemaVersion: 1,
        startupId,
        attemptId: randomUUID(),
        sequence: 0,
        startedAt: now,
        updatedAt: now,
        phase: "starting",
        disk: [],
      };
    }
    // 即使旧代曾 ready，退出后的 reload 也只能读到失败，不能用旧证明放行新端口。
    if (latest.phase !== "failed")
      applyState({
        ...latest,
        sequence: latest.sequence + 1,
        updatedAt: Date.now(),
        failedPhase: latest.phase,
        phase: "failed",
        errorCode: "transport_closed",
      });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeListener(InternalChannels.DatabaseStartupControl, control);
    win.removeListener("closed", dispose);
    child.removeListener("exit", onExit);
    hostStartupIds.delete(child);
    if (windowBindings.get(win) === dispose) windowBindings.delete(win);
  };
  windowBindings.set(win, dispose);
  ipcMain.on(InternalChannels.DatabaseStartupControl, control);
  win.once("closed", dispose);
  child.once("exit", onExit);
  return { receive, startupId };
}
