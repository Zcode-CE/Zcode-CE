/**
 * 主窗口 renderer heap 读数的 main 侧落点。
 *
 * 遥测移除（P1）前这里是一个「资源样本来源」：renderer 每 60 秒读一次 `performance.memory`，
 * 经 preload 桥单向 send 到 main，再由 10 秒 tick 并进 `renderer_main` 角色的 ARMS 事件
 * （`heap_used_kb_mean` / `heap_used_kb_peak`）。ARMS 资源上报整体删除后，
 * **样本来源与角色归类已随之删除**，本文件只保留 IPC 通道本身。
 *
 * 保留理由：`PlatformChannels.ReportRendererHeapSample` 是 preload / renderer 的既有契约
 * （`packages/ui/src/lib/memoryDiagnostics.ts` 的本地 `[memory] role=renderer` 日志与它共用
 * 同一次读数），删掉通道会让三端契约无谓漂移；且 renderer → main 是不可信边界，
 * 严格 schema 校验必须留在这里。
 *
 * 注意：当前读数在 main 侧已无消费者，只做校验与暂存；本地 `[memory]` 日志由 renderer 侧
 * 直接经 logger 写主日志，不依赖本通道。
 */

import { ipcMain } from "electron";
import { PlatformChannels, rendererHeapSampleSchema } from "@zcode/shared";
import { isMainApplicationWindowWebContents } from "./resourceManagerWindow.js";

/** 发送方 webContents id → 最近一次 heap 读数（KB）。 */
const latestHeapUsedKbByWebContentsId = new Map<number, number>();

/**
 * main 侧的信任边界：payload 来自 renderer，按 `strict` schema 校验，
 * 非法消息（字段缺失、类型错误、夹带路径等多余字段）直接丢弃，不抛错。
 *
 * 归属只认发送方 webContents：主窗口 webContents 才是主 renderer，
 * 资源管理器 / about / DevTools / `<webview>` guest 的读数一律丢弃。
 */
function ingestRendererHeapSample(webContentsId: number, raw: unknown): void {
  if (!isMainApplicationWindowWebContents(webContentsId)) {
    return;
  }
  const parsed = rendererHeapSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  latestHeapUsedKbByWebContentsId.set(webContentsId, parsed.data.heapUsedKb);
}

/** preload 桥的 main 侧落点：只监听单向 send，不提供 invoke。 */
export function registerRendererHeapSampleIpc(): void {
  // 这条通道只允许一个监听器：重复注册不叠加，避免同一条样本被摄入多次。
  ipcMain.removeAllListeners(PlatformChannels.ReportRendererHeapSample);
  ipcMain.on(PlatformChannels.ReportRendererHeapSample, (event, payload: unknown) => {
    ingestRendererHeapSample(event.sender.id, payload);
  });
}
