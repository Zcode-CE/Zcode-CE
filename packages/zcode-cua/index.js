import { createCuaDriverRuntime } from "./cua-driver-runtime.js";

const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

/**
 * Computer Use 运行时装配点。
 *
 * 历史：本包曾是 API-compatible placeholder，`execute()` 恒返回不可用。现在改为由
 * MIT 许可的 `@trycua/cua-driver` 提供实现（Linux / macOS / Windows 六平台预编译）。
 *
 * 保留两种模式，按 `options.driver` 选择：
 * - `driver: "open-source"`（默认）：使用 cua-driver。
 * - `driver: "disabled"`：维持 placeholder 语义，所有面 fail closed。
 *
 * 为什么不看 `brokerSocketPath` 决定：那是**官方 Helper** 的连接材料，走的是
 * 未标注许可的私有二进制。本包不再使用它，因此有值时也不再据此启用 Helper 路径；
 * 只记录在诊断里，方便宿主排查「为什么走了开源实现」。
 */
export function createComputerUseRuntime(options = {}) {
  const mode = options.driver ?? "open-source";
  if (mode === "disabled") return createDisabledRuntime();

  // loadDriver 只由回归测试注入假驱动；生产装配点不传。
  const runtime = createCuaDriverRuntime(
    options.loadDriver ? { loadDriver: options.loadDriver } : {},
  );
  return {
    execute: (input) => runtime.execute(input),
    closeSession: (context) => runtime.closeSession(context),
    dispose: () => runtime.dispose(),
  };
}

/** placeholder 语义：所有面不可用，失败关闭。保留给显式关闭 Computer Use 的构建。 */
function createDisabledRuntime() {
  return {
    async execute() {
      return {
        content: [{ type: "text", text: UNAVAILABLE_TEXT }],
        isError: true,
      };
    },
    async closeSession() {},
    async dispose() {},
  };
}

export { CUA_DRIVER_SUPPORTED_PLATFORMS } from "./cua-driver-runtime.js";
