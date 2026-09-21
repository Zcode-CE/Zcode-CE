import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createUuid } from "@zcode/shared";
import { getAppConfigDir } from "@zcode/services/node";

interface EnsureDesktopDeviceMidSyncOptions {
  /** state 文件所在目录，默认 getAppConfigDir()（即 ~/.zcode/v2）。仅测试注入 */
  configDir?: string;
  /** UUID 生成器，默认 createUuid。仅测试注入 */
  createId?: () => string;
}

/**
 * **客户端设备标识**模块：同步确保设备身份文件里有 deviceMid，并返回该值。
 *
 * 定位说明：deviceMid 是**设备身份**，不是遥测数据。它被 6 条功能路径依赖，其中
 * `X-Device-Mid` 是向 ZCode endpoint 领取官方权益（claim / billing）的**必需请求头**
 * （注入点 `packages/services/src/providers/sourceHeaders.ts`）。因此本模块**保留**，
 * 并作为 Desktop 侧 deviceMid 的**唯一生成点**（调用点 `index.ts`）。
 *
 * 磁盘文件名 **必须** 保持 `telemetry-state.json`：CLI / Desktop / 远端 server 三端共享
 * 同一路径与字段，改名等于重置所有老用户的设备身份 → `X-Device-Mid` 丢失 → 权益领取失败。
 * 该文件名是历史命名，删掉数仓上报后文件内已不含任何遥测数据。
 *
 * 竞态规避：
 * - 已存在合法 deviceMid 时直接返回、绝不写盘（老用户/二次启动零写入）。
 * - 缺失才写，且读出「完整 state」只补 deviceMid 再写回，避免冲掉同一文件里其它端写入的字段。
 * - 原子写（临时文件 + renameSync），避免被并发读方读到半截 JSON。
 *
 * 任何 fs / JSON 异常都不抛：写盘失败仍返回内存中生成的 UUID，下次启动再尝试落盘，
 * 保证窗口创建那一刻 deviceMid 一定有值。
 */
export function ensureDesktopDeviceMidSync(options?: EnsureDesktopDeviceMidSyncOptions): string {
  const createId = options?.createId ?? createUuid;
  try {
    const configDir = options?.configDir ?? getAppConfigDir();
    const stateFile = join(configDir, "telemetry-state.json");

    const state = readDeviceStateSync(stateFile);
    if (typeof state.deviceMid === "string" && state.deviceMid) {
      return state.deviceMid;
    }

    const deviceMid = createId();
    state.deviceMid = deviceMid;
    writeDeviceStateSync(stateFile, state);
    return deviceMid;
  } catch {
    // fs / JSON 异常兜底：保证一定有返回值，窗口创建不阻塞
    return createId();
  }
}

function readDeviceStateSync(stateFile: string): Record<string, unknown> {
  try {
    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeDeviceStateSync(stateFile: string, state: Record<string, unknown>): void {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tempFile, stateFile);
}
