import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * 鉴权令牌的**加载、匹配与热重载**（task-35 / A4）。
 *
 * 现状（修改前）：只有 `ZCODE_SERVER_AUTH_TOKEN` 一个静态共享密钥，`hasValidLiteToken` 做字面串
 * 相等比较。后果：① 令牌泄露后**无法按设备撤销** —— 换令牌会让所有已配对设备一起失效，运维于是
 * 「不敢撤销」；② 没有过期，一次泄露永久有效；③ 字面串比较对超长令牌存在时序侧信道。
 *
 * 本模块给最小可用方案：**令牌文件（多条）+ SIGHUP 重载**。
 * 不做设备表、不做 OIDC、不做配对流程 —— 那些需要状态所有者设计（设备表放哪、谁写、跨重启一致性），
 * 属另一个议题。这里的判据是：让「删掉某一台设备的令牌」变成一次 `kill -HUP`，而不是重启 + 全员重配。
 *
 * 文件格式：每行一条，`<token>` 或 `<token> <标签>`（标签用于日志，**日志里永不出现令牌本身**）。
 * `#` 开头的行与空行忽略。
 *
 * 错误行为（**fail-closed**，见 loadAuthTokensFromFile 与 http.ts 的启动前置检查）：
 * - 文件不存在 ⇒ 抛错（配置指向了一个不存在的文件，不能静默当成「没配令牌」）；
 * - 文件存在但读完**一条令牌都没有**（空文件 / 只有注释）⇒ 抛错；
 * - 行格式非法（只有标签、含空白导致无法切分）⇒ 抛错并指出行号；
 * - 重复令牌 ⇒ **不抛错**，保留首个标签并记一条告警（重复是无害的配置噪声，不该阻断启动）。
 *
 * 优先级（与 http.ts 的启动前置检查同口径）：
 * `options.authToken` / `ZCODE_SERVER_AUTH_TOKEN`（显式单令牌）
 *   > `ZCODE_SERVER_AUTH_TOKENS_FILE`（令牌文件）
 * 两者都没有 ⇒ 不启用鉴权（回环下的合法形态，非回环由 assertListenSecurity 拒绝）。
 * **两者同时配置不是错误**：显式令牌是「运维手上的那把钥匙」，文件是「可批量撤销的设备钥匙」，
 * 合并成一个集合即可（撤销某台设备 = 从文件里删掉它那一行，显式令牌不受影响）。
 */

export interface AuthTokenRecord {
  token: string;
  /** 仅用于日志与排查的标签（如设备名），**绝不写令牌本身**。 */
  label?: string;
}

export interface AuthTokenSnapshot {
  /** 归一化后的令牌集合（用于断言与日志计数，不含明文标签）。 */
  count: number;
  /** 每条令牌的标签（有序，便于运维核对），默认 `<unnamed>`。 */
  labels: string[];
}

/** 令牌参与的常量时间比较：先哈希到定长摘要，消除「长度 / 前缀匹配」侧信道。 */
function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function parseAuthTokenFile(content: string): AuthTokenRecord[] {
  const records: AuthTokenRecord[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.search(/\s/);
    const token = separator === -1 ? trimmed : trimmed.slice(0, separator);
    const label = separator === -1 ? undefined : trimmed.slice(separator + 1).trim() || undefined;
    if (!token) {
      throw new Error(
        "令牌文件第 " +
          (index + 1) +
          " 行非法：该行没有令牌（只有空白或标签）。" +
          "格式应为 `<token>` 或 `<token> <标签>`。",
      );
    }
    const key = digest(token);
    if (seen.has(key)) {
      // 重复令牌是无害的配置噪声（同一把钥匙写了两遍），不该阻断启动；由调用方按需告警。
      continue;
    }
    seen.add(key);
    records.push(label ? { token, label } : { token });
  }
  if (records.length === 0) {
    throw new Error(
      "令牌文件没有解析出任何令牌（空文件或只有注释）。" +
        "拒绝启动：一个被配成空集合的令牌源会让服务要么完全不可用、要么看起来「没启用鉴权」，" +
        "两种都不能静默发生。请写入至少一条令牌，或删除该配置。",
    );
  }
  return records;
}

export interface AuthTokenSource {
  /** 当前是否启用了鉴权（令牌集合非空）。 */
  readonly enabled: boolean;
  /** 校验一个候选令牌。命中即刷新「最近使用」顺序（便于排查哪把钥匙还在用）。 */
  verify(candidate: string | undefined): boolean;
  /** 当前令牌数量的快照（用于日志与断言，不含明文）。 */
  snapshot(): AuthTokenSnapshot;
  /**
   * 取某个候选令牌对应的**标签**（审计日志用），未命中返回 undefined。
   *
   * 与 `verify` 的区别：**不产生副作用**（不改「最近使用」顺序）—— 审计路径不应改变任何状态。
   * 同样**只返回标签，绝不返回令牌**。
   */
  labelFor(candidate: string | undefined): string | undefined;
}

interface MutableTokenState {
  records: AuthTokenRecord[];
  digestByToken: Map<string, string>;
  lastUsedLabel?: string;
}

export interface AuthTokenStoreOptions {
  /**
   * **不随重载变化**的令牌（`ZCODE_SERVER_AUTH_TOKEN`，标签 `<env>`）。
   *
   * 与 `fileRecords` 分开的**唯一理由**：`reload()` 必须能真正**删掉**文件里的令牌。
   * 若把「文件内容」也混进这份列表，重载时它们会被当成本地固定令牌再次并入，
   * 于是「从文件删掉一行」永远不生效（这是实现期实测到的 bug，见本文件同名测试）。
   */
  records: AuthTokenRecord[];
  /** 令牌文件当前内容对应的令牌；`reload()` 会**整体替换**这一部分。 */
  fileRecords?: AuthTokenRecord[];
  /** 令牌文件路径；提供后 `reload()` 从该文件重读（SIGHUP 用）。 */
  filePath?: string;
  /** 文件读取注入点（测试与可观测性用）。 */
  readFile?: (path: string) => string;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/**
 * 令牌集合 + 热重载。
 *
 * 语义（热重载必须满足的两条不变式，测试逐条钉住）：
 * 1. **重载后旧令牌立即失效** —— 校验永远读当前这一份集合，不存在旧集合的缓存副本；
 * 2. **重载失败不改动现状** —— 文件被写坏时保持上一份可用集合（否则一次手滑就让所有人掉线），
 *    并把失败原因打出来（不静默）。
 */
export function createAuthTokenStore(options: AuthTokenStoreOptions): AuthTokenSource & {
  reload(): { ok: boolean; error?: string };
} {
  const log = options.log;
  const warn = options.warn;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const state: MutableTokenState = {
    records: [],
    digestByToken: new Map(),
  };
  /** 不随重载变化的那部分（显式令牌）。 */
  const fixedRecords = options.records;
  /** 随重载整体替换的那部分（文件令牌）。 */
  let fileRecords = options.fileRecords ?? [];

  const install = (records: AuthTokenRecord[]): void => {
    const digestByToken = new Map<string, string>();
    for (const record of records) {
      digestByToken.set(digest(record.token), record.label ?? "<unnamed>");
    }
    state.records = records;
    state.digestByToken = digestByToken;
    state.lastUsedLabel = undefined;
  };
  const applyCurrent = (): void => install([...fixedRecords, ...fileRecords]);
  applyCurrent();

  const source: AuthTokenSource & { reload(): { ok: boolean; error?: string } } = {
    get enabled() {
      return state.records.length > 0;
    },
    verify(candidate) {
      if (!candidate) {
        return false;
      }
      // 常量时间比较：先哈希，再逐条用摘要比对（摘要长度固定，比较不泄漏令牌长度与前缀）。
      const candidateDigest = digest(candidate);
      for (const [storedDigest, label] of state.digestByToken) {
        if (constantTimeEqualHex(storedDigest, candidateDigest)) {
          state.lastUsedLabel = label;
          return true;
        }
      }
      return false;
    },
    snapshot() {
      return {
        count: state.records.length,
        labels: state.records.map((record) => record.label ?? "<unnamed>"),
      };
    },
    labelFor(candidate) {
      if (!candidate) {
        return undefined;
      }
      const candidateDigest = digest(candidate);
      for (const [storedDigest, label] of state.digestByToken) {
        if (constantTimeEqualHex(storedDigest, candidateDigest)) {
          return label;
        }
      }
      return undefined;
    },
    reload() {
      if (!options.filePath) {
        return { ok: false, error: "未配置令牌文件路径，无法重载" };
      }
      try {
        // 整体替换「文件那一部分」：因此从文件里删掉一行 = 该令牌**立即失效**。
        // 显式令牌（fixedRecords）不受影响 —— 运维手上的钥匙与可撤销的设备钥匙互不牵连。
        fileRecords = parseAuthTokenFile(readFile(options.filePath));
        applyCurrent();
        const snapshot = source.snapshot();
        log?.(
          "令牌文件已重载：" +
            options.filePath +
            " ⇒ " +
            String(snapshot.count) +
            " 条（" +
            snapshot.labels.join(", ") +
            "）；旧令牌已立即失效",
        );
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 失败不改动现状：保持上一份可用集合，但必须让运维看见。
        warn?.("令牌文件重载失败，继续使用上一份令牌集合：" + message);
        return { ok: false, error: message };
      }
    },
  };
  return source;
}

/** 定长摘要的常量时间比较（长度不等直接返回；摘要长度固定，本身不泄漏明文长度）。 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/** 从文件读出令牌记录（启动期用；失败即抛错，由调用方 fail-closed 处理）。 */
export function loadAuthTokensFromFile(
  path: string,
  readFile: (path: string) => string = (target) => readFileSync(target, "utf8"),
): AuthTokenRecord[] {
  return parseAuthTokenFile(readFile(path));
}
