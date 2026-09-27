import { randomUUID } from "node:crypto";
import type { RemoteControlConnection, RemoteControlConnectionRole } from "@zcode/shared";

/**
 * 连接登记表 —— 「谁连着」的唯一真相源（spec §3.4 / §6.4）。
 *
 * 为什么需要它：修改前本服务没有任何连接面事实源。`/ws` 用 `@hono/node-ws` 的
 * `upgradeWebSocket` 注册，升级成功后不登记对端，于是「已连设备清单 / 断开某人」
 * 这两件事在服务端没有数据可依。当时 http.ts 里唯一的 Map 只服务于并发上限计数，
 * 而且它存的 role/peer/authenticated/startedAt 四个字段没有任何读取点（只读 `.size`）。
 *
 * 唯一所有者与三条写入路径（这是本模块存在的核心理由，不要在别处再建第二份状态）：
 * - 建立：`setupChannelServer` 在 WS 升级成功后调用 `register`，拿回 id；
 * - 断开：连接自身的 close 事件调用 `unregister`（幂等）；
 * - 撤销：`revoke` / `revokeAll` 先摘除条目、再关闭底层通道。
 * 三个入口都只改这一份 Map，因此清单、并发计数与撤销不会分家。
 *
 * id 的口径（spec §6.4）：服务端生成、含随机量、不可猜 —— 用 `randomUUID()`（122 bit 随机）。
 * 同一个 id 同时作为审计里的 `connectionId`，于是「谁被撤销」与「哪条连接断开」能对上，
 * 不需要第二份编号。
 *
 * 不外泄凭据：`snapshot()` 只投影 spec §6.4 列出的字段，不含令牌，
 * 也不含任何可反推令牌的信息 —— 本模块从头到尾不接触令牌。
 */

/**
 * 撤销连接时用的关闭码。
 *
 * 取 RFC 6455 的私有区间（4000-4999），让客户端能把「被操作者撤销」与
 * 「网络断开 / 服务重启」区分开：前者不该触发无限重连。
 */
export const REMOTE_CONTROL_REVOKED_CLOSE_CODE = 4001;

export interface RemoteControlConnectionInput {
  /** 解析后的对端地址（可信代理口径，与限流和审计同一口径）。 */
  address: string;
  role: RemoteControlConnectionRole;
  /** 升级请求的 User-Agent；缺失时写空串（契约要求它是 string）。 */
  userAgent: string;
  /**
   * 该连接绑定的工作区。可选，且今天的调用方一律不传 —— 见 http.ts 的说明：
   * 升级时刻服务端并不知道客户端会选哪个工作区，编一个值比留空更糟。
   */
  workspace?: string;
  /** 关闭这条连接的底层通道。由调用方提供，本模块不持有传输层。 */
  close: () => void;
}

interface Entry extends RemoteControlConnectionInput {
  id: string;
  connectedAt: number;
}

export interface RemoteControlConnectionSnapshot {
  connections: RemoteControlConnection[];
  /** 单调递增的版本号，供面板去重与轮询（每次集合变化都 +1）。 */
  revision: number;
}

export interface RemoteControlConnectionRegistry {
  /** 登记一条连接，返回服务端生成的 id（同时作为审计的 connectionId）。 */
  register(input: RemoteControlConnectionInput): string;
  /** 注销一条连接（连接 close 时调用）。已经不在表里时不改变 revision。 */
  unregister(id: string): void;
  /** 当前清单 + 版本号（只读投影，不含令牌）。 */
  snapshot(): RemoteControlConnectionSnapshot;
  /** 撤销一条连接；不存在或已断开时返回 0（幂等，不是错误）。 */
  revoke(id: string): number;
  /** 撤销全部；本来就没有连接时返回 0。 */
  revokeAll(): number;
  /** 当前连接数（并发上限判定用）。 */
  size(): number;
}

export function createRemoteControlConnectionRegistry(
  options: { now?: () => number } = {},
): RemoteControlConnectionRegistry {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let revision = 0;

  const project = (entry: Entry): RemoteControlConnection => ({
    id: entry.id,
    address: entry.address,
    role: entry.role,
    userAgent: entry.userAgent,
    connectedAt: entry.connectedAt,
    ...(entry.workspace === undefined ? {} : { workspace: entry.workspace }),
  });

  return {
    register(input) {
      const entry: Entry = { ...input, id: randomUUID(), connectedAt: now() };
      entries.set(entry.id, entry);
      revision += 1;
      return entry.id;
    },
    unregister(id) {
      // 只有真的删掉了才推进 revision：撤销路径会先摘除、再由 close 事件走到这里，
      // 无条件 +1 会让「一次撤销」看起来像两次变化。
      if (entries.delete(id)) {
        revision += 1;
      }
    },
    snapshot() {
      return { connections: [...entries.values()].map(project), revision };
    },
    revoke(id) {
      const entry = entries.get(id);
      if (!entry) {
        // 幂等：不存在 / 已断开 ⇒ 0。面板轮询与竞态下这是更稳的语义（不是 404）。
        return 0;
      }
      // 先摘除再关闭：这样同一 id 的第二次撤销必然返回 0，而不会在 close 事件
      // 落地之前重复计数。close 事件随后触发的 unregister 会成为一次 no-op。
      entries.delete(id);
      revision += 1;
      entry.close();
      return 1;
    },
    revokeAll() {
      const all = [...entries.values()];
      if (all.length === 0) {
        return 0;
      }
      entries.clear();
      revision += 1;
      // 逐个关闭，不是只从清单里删掉 —— spec §6.5 判据③ 明确要求原连接收到关闭。
      for (const entry of all) {
        entry.close();
      }
      return all.length;
    },
    size() {
      return entries.size;
    },
  };
}
