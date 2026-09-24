/**
 * 审计日志（task-46 / SURVEY.md 的 B1）。
 *
 * ## 为什么需要它
 *
 * 批次 A 落地后，「被拒」这件事**看得见**（403/401 + `warn`），但**没有任何审计面**：
 * 出事后无法回答「谁在何时连过、谁被拒了几次、谁被撤销、令牌什么时候重载过」。
 * 于是处置只能是「全量轮换 + 重启」——最贵的那一档。
 *
 * ## 形态与纪律
 *
 * - **一行一条**结构化 JSON（字段稳定、便于 grep / journald / 采集器解析），前缀沿用仓库的
 *   `formatLogPrefix`，source 为 `zcode-server:audit`，事件名带 `audit:` 便于单独过滤。
 * - **等级**：正常生命周期（连接建立/断开、令牌重载）= `info`；安全拒绝（Host/来源/鉴权失败、
 *   封禁、超限）= `warn`。仓库约定「不可恢复错误用 error」——审计本身不制造 error。
 * - **绝不写入**：凭据、令牌（明文或前缀）、cookie、完整查询串（`?token=...` 会进浏览器历史与代理日志，
 *   写进审计等于让它再多一处落盘）、请求体、工作区文件内容、原始 `X-Forwarded-For`。
 *   只写**解析后的对端地址**（A-2 的可信代理口径）与**令牌的标签**（label，如「手机」）。
 * - 只写 `pathname`（URL 的路径部分），不写 `search`。
 *
 * ## 高频事件的代价与我们的取舍（**不静默丢弃**）
 *
 * 被扫描时失败事件是**突发**的：单个扫描器可以轻易打出每秒几十条。三条可选策略里我们选第三条：
 *
 * 1. 不限速 —— 日志会被打爆（几 MB/分钟），把真正的事件淹掉；
 * 2. 丢重复（drop）—— 最省，但**静默丢事件**正是审计最不该有的行为（事后无法区分"没发生"与"被丢了"）；
 * 3. **合并 + 计数（本实现）**：同键事件在窗口内只写第一条，窗口末写一条**汇总**（含窗口内总数与首末时间），
 *    于是**没有任何事件丢失**，只是从"逐条明细"降级为"明细 + 计数"。
 *    阈值依据（可配，见 AuditLogOptions）：窗口 60s、窗口内上限 200 条 —— 稳态下最多
 *    ≈ 1 条/秒 + 1 条汇总/分钟/键，任何正常使用都远达不到；而 200 条足够保留一次真实攻击的完整明细。
 *    键 = `event + peer + detail`（同一个扫描器的同一种拒绝会被合并；**不同对端不合并**，
 *    否则会掩盖"多源扫描"这一点）。
 *
 * 汇总条的字段与明细条一致，额外带 `coalesced.count` / `coalesced.windowMs` /
 * `coalesced.firstAt` / `coalesced.lastAt`，且 `coalesced` 存在即表示"这条是计数而非单次事件"。
 */

import { formatLogPrefix } from "@zcode/shared";

export const AUDIT_LOG_SCOPE = "zcode-server:audit";

/** 事件名。加前缀便于从混杂日志里单独过滤（`grep 'audit:'`）。 */
export type AuditEventKind =
  | "audit:ws-open"
  | "audit:ws-close"
  | "audit:auth-failure"
  | "audit:auth-ban"
  | "audit:host-rejected"
  | "audit:origin-rejected"
  | "audit:token-reload"
  | "audit:token-reload-failed"
  | "audit:connection-limit-rejected"
  // ── IM 机器人入站面（/bot/**，独立于令牌面；见 botIngress.ts 与
  //    .reverse/93-bot-ingress/BOT-INGRESS-SPEC.md §6）。
  //    事件名带 bot 前缀是刻意的：审计里必须能区分「令牌面被拒」与「bot 面被拒」，
  //    否则两个独立凭据空间的失败会混成一类，无法回答「是哪一层在承压」。
  | "audit:bot-callback"
  | "audit:bot-auth-failure"
  | "audit:bot-ban"
  | "audit:bot-rejected";

export interface AuditEvent {
  kind: AuditEventKind;
  /** 解析后的对端地址（可信代理口径）；缺失时写 `unknown`。 */
  peer: string;
  /** WebSocket 角色（仅 `/ws*` 事件有）。 */
  role?: string;
  /** 连接标识（仅连接级事件有，用于把 open/close 配对）。 */
  connectionId?: string;
  /** 连接已持续的毫秒数（仅 close 事件有）。 */
  durationMs?: number;
  /** 是否已鉴权（连接级事件）。 */
  authenticated?: boolean;
  /** 令牌标签（**标签，不是令牌**）。 */
  tokenLabel?: string;
  method?: string;
  /** 只写路径，**不写查询串**。 */
  path?: string;
  /** 拒绝/失败原因（简短、可操作，不含地址与凭据）。 */
  reason?: string;
  /** 令牌重载：当前条数与标签列表（**不含令牌**）。 */
  tokenCount?: number;
  tokenLabels?: string[];
  /** 并发上限：当前连接数与上限。 */
  connections?: number;
  maxConnections?: number;
}

export interface AuditLogOptions {
  /** 注入时钟（测试用）。 */
  now?: () => number;
  /** 注入输出（测试用；缺省按等级走 `console.info` / `console.warn`）。 */
  write?: (line: string, level: "info" | "warn") => void;
  /** 合并窗口（毫秒）。默认 60_000。 */
  coalesceWindowMs?: number;
  /** 单个键在一个窗口内允许逐条写出的上限。默认 200。 */
  coalesceMaxEventsPerWindow?: number;
}

export interface AuditLog {
  record(event: AuditEvent): void;
  /** 当前仍在窗口内的键数量（测试与自省用）。 */
  pendingKeyCount(): number;
  /** 立即写出所有窗口内的汇总（进程退出前调用，避免丢掉最后一个窗口的计数）。 */
  flush(): void;
}

interface CoalesceBucket {
  count: number;
  windowStartedAt: number;
  lastAt: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_EVENTS_PER_WINDOW = 200;

function bucketKey(event: AuditEvent): string {
  return [event.kind, event.peer, event.reason ?? "", event.path ?? "", event.role ?? ""].join("|");
}

/**
 * 创建审计日志。
 *
 * 设计要点：**绝不在写日志的路径上抛错**（一次审计写入失败不能影响正在处理的请求），
 * 但也不能静默吞掉——因此写入失败会退化成一条 `console.error`（这是"日志系统自己坏了"，
 * 属于仓库约定里的 error 级：不可恢复、需要人看到）。
 */
export function createAuditLog(options: AuditLogOptions = {}): AuditLog {
  const now = options.now ?? Date.now;
  const windowMs = options.coalesceWindowMs ?? DEFAULT_WINDOW_MS;
  const maxEventsPerWindow = options.coalesceMaxEventsPerWindow ?? DEFAULT_MAX_EVENTS_PER_WINDOW;
  const buckets = new Map<string, CoalesceBucket>();
  const prefix = formatLogPrefix(
    AUDIT_LOG_SCOPE,
    typeof process === "undefined" ? undefined : process.pid,
  );
  const write =
    options.write ??
    ((line: string, level: "info" | "warn") => {
      if (level === "warn") {
        console.warn(line);
      } else {
        console.info(line);
      }
    });

  const emit = (payload: Record<string, unknown>, level: "info" | "warn"): void => {
    try {
      write(prefix + " " + JSON.stringify(payload), level);
    } catch (error) {
      // 审计写入失败：不阻断请求，但必须可见（fail-loud，不 fail-silent）。
      console.error(
        prefix +
          " 审计写入失败（不影响请求处理）：" +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  };

  const levelOf = (kind: AuditEventKind): "info" | "warn" =>
    kind === "audit:ws-open" ||
    kind === "audit:ws-close" ||
    kind === "audit:token-reload" ||
    // bot 入站的成功路径是正常生命周期（凭据已通过）⇒ info；
    // 其余 bot 事件（失败/封禁/拒绝）走默认的 warn。
    kind === "audit:bot-callback"
      ? "info"
      : "warn";

  return {
    record(event) {
      const at = now();
      const key = bucketKey(event);
      const bucket = buckets.get(key);
      const payload: Record<string, unknown> = { ts: new Date(at).toISOString(), ...event };
      if (!bucket || at - bucket.windowStartedAt >= windowMs) {
        if (bucket) {
          // 上一个窗口还没写汇总就跨窗了：先把它的计数补上（不丢计数）。
          emit(
            {
              ts: new Date(bucket.windowStartedAt).toISOString(),
              kind: event.kind,
              peer: event.peer,
              ...(event.role ? { role: event.role } : {}),
              ...(event.reason ? { reason: event.reason } : {}),
              ...(event.path ? { path: event.path } : {}),
              coalesced: {
                count: bucket.count,
                windowMs,
                firstAt: new Date(bucket.windowStartedAt).toISOString(),
                lastAt: new Date(bucket.lastAt).toISOString(),
              },
            },
            levelOf(event.kind),
          );
        }
        buckets.set(key, { count: 1, windowStartedAt: at, lastAt: at });
        emit(payload, levelOf(event.kind));
        return;
      }
      bucket.count += 1;
      bucket.lastAt = at;
      if (bucket.count <= maxEventsPerWindow) {
        emit(payload, levelOf(event.kind));
        return;
      }
      // 超出逐条上限：**不丢**，只等窗口结束写汇总（见模块注释第 3 条）。
    },
    pendingKeyCount() {
      return buckets.size;
    },
    flush() {
      for (const [key, bucket] of buckets) {
        const [kind, peer, reason, path, role] = key.split("|");
        emit(
          {
            ts: new Date(bucket.lastAt).toISOString(),
            kind,
            peer,
            ...(role ? { role } : {}),
            ...(reason ? { reason } : {}),
            ...(path ? { path } : {}),
            coalesced: {
              count: bucket.count,
              windowMs,
              firstAt: new Date(bucket.windowStartedAt).toISOString(),
              lastAt: new Date(bucket.lastAt).toISOString(),
            },
          },
          levelOf(kind as AuditEventKind),
        );
      }
      buckets.clear();
    },
  };
}
