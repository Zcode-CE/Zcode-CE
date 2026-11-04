import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Core 的输出落在 run 目录，跟 status.json 同域，排障时一个目录就能看全。 */
export const CORE_LOG_FILE_NAME = "core.log";
/** 单文件上限；磁盘占用上界 = (rotations + 1) × maxBytes。 */
export const CORE_LOG_MAX_BYTES = 4 * 1024 * 1024;
export const CORE_LOG_ROTATIONS = 1;
/** 崩溃摘要只需日志尾部；有界读取避免把几 MiB 读进内存再截断。 */
const CORE_LOG_TAIL_BYTES = 8 * 1024;

/** `lastExitReason` 在协议 schema 里的上限（contracts.ts serverStatusSchema）。 */
export const CORE_LOG_REASON_MAX_CHARS = 500;

/**
 * 把 Core 日志路径拼进退出原因，并把总长压到 schema 上限内。
 * 路径放尾部：`core exited code=…` 这段前缀最需要保留，超长时截断的是原因中段而不是后缀。
 */
export function withCoreLogHint(reason: string, logPath: string | undefined): string {
  if (!logPath) return reason;
  const suffix = ` (core log: ${logPath})`;
  const budget = Math.max(CORE_LOG_REASON_MAX_CHARS - suffix.length, 0);
  const head = reason.length > budget ? `${reason.slice(0, Math.max(budget - 1, 0))}…` : reason;
  return `${head}${suffix}`.slice(0, CORE_LOG_REASON_MAX_CHARS);
}

export interface CoreLogSinkOptions {
  runDir: string;
  maxBytes?: number;
  rotations?: number;
  now?: () => number;
}

/**
 * Core 子进程输出落盘。
 *
 * 为什么要它：daemon 化之后 Core 在独立进程里跑，崩溃时 Supervisor 只剩
 * `core exited code=1 signal=none`，线上无法定位。
 *
 * 为什么走 pipe 而不是把文件 fd 直接交给 fork：fd 交给子进程后父进程无法再改写它的写位置，
 * 长跑的一代 Core 输出再多也只能在下一次启动时才轮转，等于没有上限。走 pipe 由 Supervisor
 * 记账，同一个 generation 内也能按字节轮转，磁盘占用恒定有界。
 */
export class CoreLogSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly rotations: number;
  private readonly now: () => number;
  private stream: WriteStream | undefined;
  private bytes = 0;
  /** 串行化写入；轮转期间到达的 chunk 排在后面，不丢也不交错。 */
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: CoreLogSinkOptions) {
    this.filePath = join(options.runDir, CORE_LOG_FILE_NAME);
    this.maxBytes = Math.max(options.maxBytes ?? CORE_LOG_MAX_BYTES, 1);
    this.rotations = Math.max(options.rotations ?? CORE_LOG_ROTATIONS, 0);
    this.now = options.now ?? Date.now;
  }

  public get path(): string {
    return this.filePath;
  }

  /** 开始一代 Core：必要时先轮转，写入分隔头，返回本次是否启用捕获。 */
  public async open(generation: number): Promise<boolean> {
    await mkdir(join(this.filePath, ".."), { recursive: true, mode: 0o700 });
    await this.rotateIfNeeded();
    this.bytes = await stat(this.filePath).then(
      (info) => info.size,
      () => 0,
    );
    this.openStream();
    this.write(
      Buffer.from(
        `\n--- core generation=${generation} started ${new Date(this.now()).toISOString()} ---\n`,
        "utf8",
      ),
    );
    return true;
  }

  /** 追加一个输出块（stdout/stderr 共用一条流，写入顺序即真实交错顺序）。 */
  public write(chunk: Buffer): void {
    this.queue = this.queue.then(() => this.writeChunk(chunk)).catch(() => undefined);
  }

  /** 追加一行 Supervisor 自己的判断（崩溃原因、停机原因），读日志时能看到上下文。 */
  public appendLine(line: string): void {
    this.write(Buffer.from(`${line}\n`, "utf8"));
  }

  /** 关闭一代 Core 的日志。入队执行：与写入串行，下一次 open 之前 await 它即可避免关掉新流。 */
  public async close(): Promise<void> {
    const done = this.queue.then(async () => {
      const stream = this.stream;
      this.stream = undefined;
      if (!stream) return;
      await new Promise<void>((resolve) => stream.end(() => resolve()));
    });
    this.queue = done.catch(() => undefined);
    await done;
  }

  /** 崩溃摘要：只读文件尾部固定窗口，返回非空行（最多 maxLines 条）。 */
  public async tail(maxLines = 12): Promise<string[]> {
    await this.queue;
    const info = await stat(this.filePath).catch(() => undefined);
    if (!info || info.size <= 0) return [];
    const { open } = await import("node:fs/promises");
    const handle = await open(this.filePath, "r").catch(() => undefined);
    if (!handle) return [];
    try {
      const length = Math.min(info.size, CORE_LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, info.size - length);
      return buffer
        .toString("utf8")
        .split(/\r?\n/u)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .slice(-maxLines);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async writeChunk(chunk: Buffer): Promise<void> {
    // 按上限切片再写：单条超大输出（一行几 MB 的 dump）不能在轮转后整块落地，
    // 否则「有界」就被这一条绕过。切片之间照常走轮转判定，帐面因此严格 ≤ maxBytes。
    for (let offset = 0; offset < chunk.byteLength; offset += this.maxBytes) {
      await this.writeSegment(chunk.subarray(offset, offset + this.maxBytes));
    }
  }

  private async writeSegment(segment: Buffer): Promise<void> {
    // 已写过内容且再加就超上限 ⇒ 先轮转。空文件不轮转，否则单条超大输出会把自己轮走。
    if (this.bytes > 0 && this.bytes + segment.byteLength > this.maxBytes) await this.rotate();
    this.bytes += segment.byteLength;
    // 迟到的 chunk（子进程退出后的 stderr 冲刷）不能丢：流已收口时重新打开并继续追加，
    // 下一次 open 会再关它。丢掉这段等于丢掉最需要的崩溃现场。
    const stream = this.stream ?? this.openStream();
    await new Promise<void>((resolve) => stream.write(segment, () => resolve()));
  }

  private openStream(): WriteStream {
    this.stream = createWriteStream(this.filePath, { flags: "a", mode: 0o600 });
    return this.stream;
  }

  private async rotate(): Promise<void> {
    const stream = this.stream;
    this.stream = undefined;
    if (stream) await new Promise<void>((resolve) => stream.end(() => resolve()));
    if (this.rotations === 0) {
      await rm(this.filePath, { force: true });
    } else {
      await rm(`${this.filePath}.${this.rotations}`, { force: true });
      for (let index = this.rotations - 1; index >= 1; index -= 1) {
        await rename(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`).catch(
          () => undefined,
        );
      }
      await rename(this.filePath, `${this.filePath}.1`).catch(() => undefined);
    }
    this.bytes = 0;
    this.openStream();
  }

  private async rotateIfNeeded(): Promise<void> {
    const size = await stat(this.filePath).then(
      (info) => info.size,
      () => 0,
    );
    if (size < this.maxBytes) return;
    await this.rotate();
  }
}
