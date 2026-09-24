export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RunContext = {
  argv: string[];
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
};

export type GlobalLocale = "auto" | "en-US" | "zh-CN";
export type GlobalDetectedLocale = Exclude<GlobalLocale, "auto">;

/**
 * How a headless run reports itself.
 *
 * `text` prints the answer only. `json` prints one summary document after the
 * turn. `stream-json` additionally writes each session event as its own line
 * (NDJSON) while the turn runs, for callers that drive the CLI as a subprocess
 * and need progress — a bridge rendering a chat UI, for instance — rather than
 * only the finished answer.
 */
export type GlobalOutputFormat = "text" | "json" | "stream-json";

export type GlobalOptions = {
  browserExecutable?: string;
  browserUse?: "headless";
  detectedLocale?: GlobalDetectedLocale;
  /**
   * headless 的动态工作流开关，命令行显式取值（缺席即未指定）。
   *
   * 与官方默认值相反：官方 headless `-p` 默认关闭、传 `--enable-workflow` 才打开；
   * 本仓库默认开启、`--no-enable-workflow` 才关闭。缺席时取本仓库默认（开启）。
   * 见 apps/zcode-cli/packages/cli/src/workflow-flag.ts。
   */
  enableWorkflow?: boolean;
  force: boolean;
  json: boolean;
  locale?: GlobalLocale;
  memoryBench?: boolean;
  noColor: boolean;
  outputFormat?: GlobalOutputFormat;
  verbose: boolean;
};

export type RuntimeInfo = {
  arch: NodeJS.Architecture;
  cwd: string;
  execPath: string;
  node: string;
  platform: NodeJS.Platform;
  sea: boolean;
  versions: NodeJS.ProcessVersions;
};
