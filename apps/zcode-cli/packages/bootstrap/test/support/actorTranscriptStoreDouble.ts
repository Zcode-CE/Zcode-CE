// ============================================================
// 会话存储的内存替身（仅供测试）
// ============================================================
//
// 为什么必须是「替身」而不是随便一个 Map：本文件的判据 2 断言的是
// **顺序不变式**（种子前缀占据前 messageCount 个下标），而顺序恰恰是
// adapters 的 SQL 语义决定的，不是 seedActorTranscript 决定的。
// 用一个按插入顺序返回的假 store，判据 2 就变成同义反复（恒真）。
//
// 所以这里逐条复刻 `packages/adapters/src/storage/session-store/repositories/messages.ts`：
//
//   insert  sequence = (select coalesce(max(sequence), -1) + 1
//                       from message where session_id = ?)          -- 目标会话的最大值 + 1
//   upsert  on conflict(id) do update set
//             session_id = excluded.session_id,
//             sequence   = case when message.session_id = excluded.session_id
//                               then message.sequence   -- 同会话：原地更新，序号不动
//                               else excluded.sequence  -- 换会话：取新序号（追加到末尾）
//                          end
//   select  order by sequence is null, sequence, time_created, rowid
//
// 那个 `else excluded.sequence` 分支正是本缺陷的机制：种子消息 id 是新铸的，
// 于是被赋 `max(sequence)+1`，排在目标会话自己那条历史**之后**。
//
// 只实现 seedActorTranscript 需要的那三个方法（messages / saveMessage / savePart），
// 并额外记调用次数供判据 1 使用。

import type {
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  SessionId,
} from "@zcode/contracts";

interface MessageRow {
  info: MessageInfo;
  sessionID: string;
  /** 落库时的 sequence，等价于 message 表的 sequence 列。 */
  sequence: number;
  /** 等价于 message 表的 rowid：插入即递增，仅用于同序号时的稳定排序。 */
  rowid: number;
}

interface PartRow {
  part: MessagePart;
  sessionID: string;
  messageID: string;
  rowid: number;
}

/** 复刻 messages.ts 的 `select coalesce(max(sequence), -1) + 1 from message where session_id = ?`。 */
function nextSequence(rows: Map<string, MessageRow>, sessionID: string): number {
  let max = -1;
  for (const row of rows.values()) {
    if (row.sessionID === sessionID && row.sequence > max) max = row.sequence;
  }
  return max + 1;
}

export interface ActorTranscriptStoreDouble {
  /** 判据 1 用：saveMessage 被调用的次数（缺陷场景下应为 3）。 */
  readonly saveMessageCalls: MessageInfo[];
  /** 判据 1 用：savePart 被调用的次数。 */
  readonly savePartCalls: MessagePart[];
  /** 供测试直接落一条「目标会话自己的」历史（不走 seed 路径）。 */
  seedOwnMessage(info: MessageInfo): void;
  /** 等价于 store.messages({ sessionID })。 */
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  saveMessage(input: MessageInfo): Promise<void>;
  savePart(input: MessagePart): Promise<void>;
}

/**
 * 建一个空的内存 store 替身。
 *
 * @param rows 预置的既有消息（模拟「目标会话已有自己的历史」）。它们按给定顺序落库，
 *             因此会拿到 sequence 0..n-1，与真实库中「先来先得序号」一致。
 */
export function createActorTranscriptStoreDouble(
  rows: readonly MessageInfo[] = [],
): ActorTranscriptStoreDouble {
  const messagesById = new Map<string, MessageRow>();
  const partsById = new Map<string, PartRow>();
  const saveMessageCalls: MessageInfo[] = [];
  const savePartCalls: MessagePart[] = [];
  let rowidCounter = 0;

  const insert = (info: MessageInfo): void => {
    const id = String(info.id);
    const sessionID = String(info.sessionID);
    const existing = messagesById.get(id);
    let sequence: number;
    if (existing === undefined) {
      // 新 id：取目标会话当前最大值 + 1（追加到末尾）。
      sequence = nextSequence(messagesById, sessionID);
    } else if (existing.sessionID === sessionID) {
      // 同会话 upsert：序号原地不动（幂等重抄依赖这一条）。
      sequence = existing.sequence;
    } else {
      // 换会话：序号重取 ⇒ 追加到新会话末尾。这就是缺陷的机制。
      sequence = nextSequence(messagesById, sessionID);
    }
    messagesById.set(id, {
      info,
      sessionID,
      sequence,
      rowid: existing?.rowid ?? rowidCounter++,
    });
  };

  return {
    saveMessageCalls,
    savePartCalls,
    seedOwnMessage(info: MessageInfo): void {
      insert(info);
    },
    async messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> {
      const sessionID = String(input.sessionID);
      const selected = [...messagesById.values()].filter((row) => row.sessionID === sessionID);
      selected.sort(
        (a, b) =>
          a.sequence - b.sequence ||
          a.info.time.created - b.info.time.created ||
          a.rowid - b.rowid,
      );
      return selected.map((row) => ({
        info: row.info,
        parts: [...partsById.values()]
          .filter((part) => part.sessionID === sessionID && part.messageID === String(row.info.id))
          .sort((a, b) => a.rowid - b.rowid)
          .map((part) => part.part),
      }));
    },
    async saveMessage(input: MessageInfo): Promise<void> {
      saveMessageCalls.push(input);
      insert(input);
    },
    async savePart(input: MessagePart): Promise<void> {
      savePartCalls.push(input);
      partsById.set(String(input.id), {
        part: input,
        sessionID: String(input.sessionID),
        messageID: String(input.messageID),
        rowid: partsById.has(String(input.id)) ? partsById.get(String(input.id))!.rowid : rowidCounter++,
      });
    },
  };
}

/** 一条 user 消息（种子源的前 N 条里最常见的形态）。 */
export function userMessage(input: {
  id: string;
  sessionID: SessionId;
  created: number;
}): MessageInfo {
  return {
    id: input.id as MessageId,
    sessionID: input.sessionID,
    role: "user",
    time: { created: input.created },
    agent: "build",
  };
}

/** 一条 assistant 消息；parentID 用于验证 fork 克隆器的 id 重映射。 */
export function assistantMessage(input: {
  id: string;
  sessionID: SessionId;
  created: number;
  parentID: string;
}): MessageInfo {
  return {
    id: input.id as MessageId,
    sessionID: input.sessionID,
    role: "assistant",
    time: { created: input.created, completed: input.created },
    parentID: input.parentID as MessageId,
    mode: "default",
    agent: "build",
    path: { cwd: "/w", root: "/w" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

/** 一条 text part。 */
export function textPart(input: {
  id: string;
  sessionID: SessionId;
  messageID: string;
  text: string;
}): MessagePart {
  return {
    id: input.id as MessagePart["id"],
    sessionID: input.sessionID,
    messageID: input.messageID as MessageId,
    type: "text",
    text: input.text,
  };
}

/** 断言用的假 logger：只记 warn，供判据 3 断言「跳过必须留一条 warn」。 */
export function createFakeLogger(): {
  warns: { message: string; context?: Record<string, unknown> }[];
  logger: import("@zcode/contracts").Logger;
} {
  const warns: { message: string; context?: Record<string, unknown> }[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string, context?: Record<string, unknown>) => {
      warns.push({ message, ...(context === undefined ? {} : { context }) });
    },
    error: () => {},
    child: () => logger,
  } as unknown as import("@zcode/contracts").Logger;
  return { warns, logger };
}
